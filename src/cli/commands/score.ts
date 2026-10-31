// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS OR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 独立 mate 评分：不依赖 insight 服务进程，直接读本机库（DATABASE_URL / .env 的
// prisma/dev.db）跑「规则层直算 + 本地 agent CLI 判 LLM 子项」，结果按 NDJSON
// 事件流写文件或 stdout——与服务端 mate 路由同一套库调用，产出同一张卡。
// 事件行与路由流同词汇：meta / progress / done / error，可 tail -f 消费。

import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { prisma } from '@/lib/db';
import {
  runScorecard, loadRegistry, scorecardStore, deriveItemScores,
  SCORER_VERSION, type ScorecardStore,
} from '@/lib/scoring';
import { applyOverlays } from '@/lib/scoring/core/overlays';
import { detectMateAgentTools, DIM_NAMES, type MateAgentTool } from '@/lib/scoring/mate-agent/runner';
import { runMateAgentOrchestrated } from '@/lib/scoring/mate-agent/orchestrate';
import { mergeMateCard } from '@/lib/scoring/mate-agent/coerce';
import { formatHeader, formatDivider } from '../utils/colors';

const noopStore: ScorecardStore = {
  get: async () => null,
  put: async () => {},
  listForBaseline: async () => [],
};

function resolveTool(raw: string | undefined): MateAgentTool | null {
  if (raw === 'claude' || raw === 'opencode') return raw;
  if (raw && raw !== 'auto') return null;
  return detectMateAgentTools()[0] ?? null;
}

export interface ScoreCliOptions {
  session: string;
  framework?: string;
  tool?: string;
  out?: string;
  concurrency?: string;
  timeout?: string;
  workdir?: string;
  store?: boolean;
}

export async function runScoreCli(opts: ScoreCliOptions, log: (s: string) => void): Promise<number> {
  const tool = resolveTool(opts.tool);
  const events: unknown[] = [];
  const emit = (obj: unknown) => { events.push(obj) };
  const startedAt = new Date().toISOString();

  if (!tool) {
    emit({ type: 'error', message: '本机未探测到 mate agent CLI（claude/opencode），或 --tool 值非法' });
    flush(events, opts.out);
    return 1;
  }

  const session = await prisma.session.findFirst({
    where: { taskId: opts.session, ...(opts.framework ? { framework: opts.framework } : {}) },
    select: { id: true },
  });
  if (!session) {
    emit({ type: 'error', message: `Session not found: ${opts.session}${opts.framework ? ` (framework=${opts.framework})` : ''}` });
    flush(events, opts.out);
    return 1;
  }

  emit({ type: 'meta', taskId: opts.session, framework: opts.framework ?? null, tool, scorerVersion: SCORER_VERSION, startedAt });
  const t0 = Date.now();

  // 规则层直算（与「运行 LLM 评审」共用同一套确定性结果；noop store 不落盘）
  const registry = await loadRegistry();
  const ruleCard = await runScorecard(opts.session, prisma, { framework: opts.framework, store: noopStore, registry });
  if (!ruleCard) {
    emit({ type: 'error', message: 'Session not found' });
    flush(events, opts.out);
    return 1;
  }

  // 截断 → 整卡出局：与服务端路径同口径（不评、只出规则层卡）
  if (ruleCard.status === 'aborted') {
    log(`会话已截断，整卡出局：仅输出规则层结果`);
    const card = deriveItemScores(await applyOverlays(ruleCard, registry.defs, registry.profile), registry.defs);
    emit({ type: 'done', card, aborted: true, durationMs: Date.now() - t0 });
    flush(events, opts.out);
    return 0;
  }

  // mate 判 LLM 子项
  const r = await runMateAgentOrchestrated(
    opts.session,
    prisma,
    {
      tool, framework: opts.framework,
      concurrency: opts.concurrency ? Math.max(1, +opts.concurrency) : 3,
      timeoutMs: opts.timeout ? +opts.timeout : undefined,
      rootDir: opts.workdir,
      defs: registry.defs,
    },
    p => {
      emit({ type: 'progress', done: p.done, total: p.total, current: p.current });
      log(`[${p.done}/${p.total}] ${p.current}`);
    },
  );

  // 全失败（没有任何可用子项）：如实报错，不落一张语义层全空的卡假装成功
  const usable = r.parsed.dimensions?.some(d => (d.items ?? []).length > 0) ?? false;
  if (!usable) {
    const detail = Object.entries(r.failures).map(([k, v]) => `${DIM_NAMES[k] ?? k}：${v}`).join('；');
    emit({ type: 'error', message: `Mate Agent 未产出任何子项评审${detail ? `（${detail}）` : ''}` });
    flush(events, opts.out);
    return 1;
  }

  const card = mergeMateCard(ruleCard, r.parsed, registry.defs, { sessionId: ruleCard.sessionId },
    { reviewer: 'mate', tool, completedAt: new Date().toISOString(), durationMs: r.totalMs });
  if (opts.store !== false) {
    await scorecardStore().put(card);
    log(`scorecard 已落盘（--no-store 可跳过）`);
  }
  const failedDims = Object.keys(r.failures);
  emit({
    type: 'done',
    card: deriveItemScores(await applyOverlays(card, registry.defs, registry.profile), registry.defs),
    durationMs: Date.now() - t0,
    ...(failedDims.length ? { failureNote: failedDims.map(k => `${DIM_NAMES[k] ?? k}：${r.failures[k]}`).join('；') } : {}),
  });
  log(`完成：${Object.keys(r.failures).length ? `部分维度失败（${failedDims.join(',')}）` : '全部维度成功'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  flush(events, opts.out);
  return 0;
}

function flush(events: unknown[], out?: string): void {
  const ndjson = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  if (out) writeFileSync(out, ndjson, 'utf-8');
  else process.stdout.write(ndjson);
}

export function scoreCommand(): Command {
  const cmd = new Command('score');
  cmd
    .description('Standalone mate-agent scoring for one session (no server, no LLM API)')
    .requiredOption('--session <taskId>', 'Session task ID')
    .option('--framework <fw>', 'Framework filter (disambiguate same-sid dual records)')
    .option('--tool <name>', 'Mate agent CLI: claude | opencode | auto (default: auto-detect)')
    .option('--out <file>', 'Write NDJSON result to file (default: stdout)')
    .option('--concurrency <n>', 'Parallel dimensions (default: 3)', '3')
    .option('--timeout <ms>', 'Per-dimension agent timeout in ms (default: 900000)')
    .option('--workdir <dir>', 'Material export root dir (agent-readable slices)')
    .option('--no-store', 'Do not persist the scorecard to the scorecard store')
    .action(async (opts: ScoreCliOptions) => {
      const log = (s: string) => process.stderr.write(`${s}\n`);
      log(formatHeader('Mate Score (standalone)'));
      log(formatDivider());
      const code = await runScoreCli(opts, log);
      log(formatDivider());
      process.exitCode = code;
    });
  return cmd;
}
