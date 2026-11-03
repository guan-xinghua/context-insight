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
  SCORER_VERSION, type ScorecardStore, type Scorecard, type DimensionResult, type SubItemResult,
} from '@/lib/scoring';
import { applyOverlays } from '@/lib/scoring/core/overlays';
import { detectMateAgentTools, DIM_NAMES, type MateAgentTool } from '@/lib/scoring/mate-agent/runner';
import { runMateAgentOrchestrated } from '@/lib/scoring/mate-agent/orchestrate';
import { mergeMateCard } from '@/lib/scoring/mate-agent/coerce';
import { formatHeader, formatDivider, theme } from '../utils/colors';
import { padEndVisual, truncateVisual } from '../utils/table';

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
    const card = deriveItemScores(await applyOverlays(ruleCard, registry.defs, registry.profile), registry.defs);
    const durationMs = Date.now() - t0;
    for (const line of renderScorecardCli(card, { tool, durationMs, aborted: true })) log(line);
    emit({ type: 'done', card, aborted: true, durationMs });
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
  const failureNote = failedDims.length ? failedDims.map(k => `${DIM_NAMES[k] ?? k}：${r.failures[k]}`).join('；') : null;
  const finalCard = deriveItemScores(await applyOverlays(card, registry.defs, registry.profile), registry.defs);
  for (const line of renderScorecardCli(finalCard, { tool, durationMs: Date.now() - t0, failureNote })) log(line);
  emit({
    type: 'done',
    card: finalCard,
    durationMs: Date.now() - t0,
    ...(failureNote ? { failureNote } : {}),
  });
  log(`完成：${failedDims.length ? `部分维度失败（${failedDims.join(',')}）` : '全部维度成功'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  flush(events, opts.out);
  return 0;
}

function flush(events: unknown[], out?: string): void {
  const ndjson = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  if (out) writeFileSync(out, ndjson, 'utf-8');
  else process.stdout.write(ndjson);
}

// ── 友好展示（stderr；jsonl 走 --out/stdout，两路互不干扰）─────────────────────

const scoreTheme = (score: number) =>
  score >= 0.8 ? theme.success : score >= 0.6 ? theme.warning : theme.danger;

function bar10(score: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(score * 10)));
  return scoreTheme(score)('█'.repeat(filled) + '░'.repeat(10 - filled));
}

function itemStatusIcon(it: SubItemResult): string {
  if (it.status === 'ok') return theme.success('✓');
  if (it.status === 'not-applicable') return theme.muted('○');
  return theme.danger('✗');
}

function itemValueText(it: SubItemResult): string {
  const parts: string[] = [];
  if (it.value !== undefined && it.value !== null) parts.push(String(it.value));
  if (typeof it.score === 'number') parts.push(`${(it.score * 10).toFixed(1)}分`);
  if (it.verdict) parts.push(it.verdict);
  if (it.note) parts.push(truncateVisual(it.note, 40));
  return parts.join(' · ') || '—';
}

function dimensionLine(dim: DimensionResult): string {
  const head = `${theme.bold(dim.dimensionId)} ${padEndVisual(truncateVisual(dim.name, 8), 8)}`;
  if (dim.status === 'not-applicable') return `${head}  ${theme.muted('不适用')}`;
  if (dim.status === 'error') return `${head}  ${theme.danger('评算失败')}`;
  if (typeof dim.score === 'number') {
    const verdictTag = dim.verdict ? `  ${dim.verdict}` : '';
    return `${head}  ${bar10(dim.score)}  ${scoreTheme(dim.score)((dim.score * 10).toFixed(1))}${verdictTag}`;
  }
  // 否决维三态（无分数）
  const v = dim.verdict ?? '—';
  const colored = v === 'clean' || v === '完成' ? theme.success(v) : v === 'violation' || v === '未完成' ? theme.danger(v) : theme.warning(v);
  return `${head}  ${colored}${dim.disclose ? `  ${theme.muted(truncateVisual(dim.disclose, 30))}` : ''}`;
}

export interface ScorecardDisplayMeta {
  tool: MateAgentTool;
  durationMs: number;
  failureNote?: string | null;
  aborted?: boolean;
}

/** 评分卡终端友好展示（色条 + 逐维分数 + 逐子项明细），与 jsonl 输出并存 */
export function renderScorecardCli(card: Scorecard, meta: ScorecardDisplayMeta): string[] {
  const lines: string[] = [];
  const fw = card.framework;
  lines.push(formatHeader(`评分结果 · ${card.sessionId}`));
  lines.push(`mate=${meta.tool} · ${(meta.durationMs / 1000).toFixed(1)}s · 覆盖率 ${(fw.coverage * 100).toFixed(0)}%${meta.aborted ? ' · 会话截断，仅规则层' : ''}`);
  lines.push(formatDivider());

  if (fw.veto?.triggered) {
    lines.push(`${theme.danger('否决触发')}：总分归 0`);
    for (const r of fw.veto.reasons) lines.push(`  ${theme.danger('•')} ${r}`);
  } else if (typeof fw.totalScore === 'number') {
    lines.push(`总分  ${bar10(fw.totalScore)}  ${theme.bold((fw.totalScore * 10).toFixed(1))} / 10`);
  } else {
    lines.push(`${theme.muted('总分不可算（维度覆盖不足 / 全部不适用）')}`);
  }
  lines.push('');

  for (const dim of card.dimensions) {
    lines.push(dimensionLine(dim));
    for (const it of dim.items) {
      lines.push(`  ${itemStatusIcon(it)} ${padEndVisual(truncateVisual(it.label, 24), 24)}  ${theme.muted(itemValueText(it))}`);
    }
  }

  if (fw.coverageGap?.length) {
    lines.push('');
    lines.push(theme.warning(`未覆盖 ${fw.coverageGap.length} 项：${fw.coverageGap.map(g => truncateVisual(g, 30)).join('、')}`));
  }
  if (meta.failureNote) {
    lines.push('');
    lines.push(theme.warning(`部分维度失败：${meta.failureNote}`));
  }
  return lines;
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
