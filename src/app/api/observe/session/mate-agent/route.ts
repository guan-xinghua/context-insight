// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Mate Agent 评审：POST 用本地 claude/opencode 判 LLM 子项，规则层子项代码直算，
// 合并后写入与 LLM 卡同一位置（scorecards/<id>.json）——两按钮产出同一张卡，无区分。
// GET 只探测本机可用的 agent 工具。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logError, logInfo } from '@/lib/logger';
import { runScorecard, loadRegistry, scorecardStore, deriveItemScores, type ScorecardStore } from '@/lib/scoring';
import { applyOverlays } from '@/lib/scoring/core/overlays';
import { detectMateAgentTools, DIM_NAMES, type MateAgentTool } from '@/lib/scoring/mate-agent/runner';
import { runMateAgentOrchestrated } from '@/lib/scoring/mate-agent/orchestrate';
import { mergeMateCard, type MateAgentParsed } from '@/lib/scoring/mate-agent/coerce';

export async function GET() {
  const tools = detectMateAgentTools();
  return NextResponse.json({ tools });
}

const noopStore: ScorecardStore = {
  get: async () => null,
  put: async () => {},
  listForBaseline: async () => [],
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { taskId?: string; framework?: string; tool?: string };
  const tool = body.tool as MateAgentTool;
  if (!body.taskId || (tool !== 'claude' && tool !== 'opencode')) {
    return NextResponse.json({ error: 'Missing taskId 或 tool（claude/opencode）' }, { status: 400 });
  }

  const session = await prisma.session.findFirst({ where: { taskId: body.taskId, ...(body.framework ? { framework: body.framework } : {}) }, select: { id: true } });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      const t0 = Date.now();
      logInfo('route:observe/session/mate-agent', 'mate 评审开始', { taskId: body.taskId, tool });
      try {
        // 规则层直算（与「运行 LLM 评审」共用同一套确定性结果；noop store 不落盘）
        const registry = await loadRegistry();
        const ruleCard = await runScorecard(body.taskId!, prisma, { framework: body.framework, store: noopStore, registry });
        if (!ruleCard) { send({ type: 'error', message: 'Session not found' }); return; }

        // 截断 → 整卡出局：与 LLM 路径同口径（不评、不落盘，前端按「评价中止」呈现）
        if (ruleCard.status === 'aborted') {
          logInfo('route:observe/session/mate-agent', 'mate 评审中止（会话截断，整卡出局）', { taskId: body.taskId, tool });
          send({ type: 'done', card: deriveItemScores(await applyOverlays(ruleCard, registry.defs, registry.profile), registry.defs) });
          return;
        }

        // mate 判 LLM 子项
        let parsed: MateAgentParsed | null = null;
        let durationMs = 0;
        const failures: Record<string, string> = {};
        const r = await runMateAgentOrchestrated(
          body.taskId!,
          prisma,
          { tool, framework: body.framework, concurrency: 3, defs: registry.defs },
          p => send({ type: 'progress', done: p.done, total: p.total, current: p.current }),
        );
        parsed = r.parsed;
        durationMs = r.totalMs;
        Object.assign(failures, r.failures);

        // 全失败（没有任何可用子项）：如实报错，不落一张语义层全空的卡假装成功
        const usable = parsed?.dimensions?.some(d => (d.items ?? []).length > 0) ?? false;
        if (!usable) {
          const detail = Object.entries(failures).map(([k, v]) => `${DIM_NAMES[k] ?? k}：${v}`).join('；');
          // 该出口走 send+return，不经 catch——此前无日志行，现场只留"评审开始"
          // 后静默（ENOENT 案例日志里查不到错就在这）
          logError('route:observe/session/mate-agent', 'mate 评审未产出任何子项', {
            taskId: body.taskId, tool, durationMs,
            failures: Object.entries(failures).map(([k, v]) => `${DIM_NAMES[k] ?? k}: ${v.slice(0, 200)}`).join(' | '),
          });
          send({ type: 'error', message: `Mate Agent 未产出任何子项评审${detail ? `（${detail}）` : ''}` });
          return;
        }

        // 合并：规则层（代码）+ LLM 项（mate）；sessionId 用评分会话的（同 sid 双记录下与 LLM 卡同位）
        const card = mergeMateCard(ruleCard, parsed!, registry.defs, { sessionId: ruleCard.sessionId },
          { reviewer: 'mate', tool, completedAt: new Date().toISOString(), durationMs });

        // 与 LLM 卡同一位置落盘
        await scorecardStore().put(card);
        const failedDims = Object.keys(failures);
        logInfo('route:observe/session/mate-agent', 'mate 评审完成', { taskId: body.taskId, tool, durationMs, failedDims: failedDims.join(',') });
        send({
          type: 'done',
          // 出卡与其他出口同口径：先套人工复核覆盖层（不然 done 事件丢确认态，刷新才找回）
          card: deriveItemScores(await applyOverlays(card, registry.defs, registry.profile), registry.defs),
          durationMs,
          ...(failedDims.length ? { failureNote: failedDims.map(k => `${DIM_NAMES[k] ?? k}：${failures[k]}`).join('；') } : {}),
        });
      } catch (err) {
        logError('route:observe/session/mate-agent', 'mate-agent 评审失败', { error: err instanceof Error ? err.message : String(err) });
        send({ type: 'error', message: err instanceof Error ? err.message : 'Unknown Error' });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}