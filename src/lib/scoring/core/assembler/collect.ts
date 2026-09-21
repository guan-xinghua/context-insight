// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 装配器原料采集（只读 Prisma + 捕获 jsonl）：
// session + turns + toolCalls + executions + bridges + wire 上下文构成 +
// 结束原因（D1.stopReason）+ 打断信号（D6）+ 全量 context（工作流声明来源）。

import type { PrismaClient } from '@prisma/client';
import { isClaudeFormatSession } from '@/lib/shared/session-format';
import { parseJsonlLines } from '@/lib/ingest/adapters/claude-jsonl';
import { readFullContext, readAvailableSkills, type FullContext } from '@/lib/ingest/adapters/claude-jsonl-full-context';
import { extractFilePath } from '@/lib/file-restore';
import type { RedactionEvent, ScoreExecution, ScoreToolCall, ScoreTurn, WireSummary } from './types';

export interface BridgeRow {
  dispatchContent: string | null;
  dispatchTimestamp: string | null;
  subagentType: string | null;
  subagentName: string | null;
  status: string;
  subagentTokens: number;
}

export interface CollectedData {
  session: {
    taskId: string;
    sessionId: string;
    framework: string;
    version: string | null;
    model: string | null;
    startTime: Date | null;
    endTime: Date | null;
    totalTokens: number;
    totalCost: number;
    totalLatencyMs: number;
  };
  turns: ScoreTurn[];
  toolCalls: ScoreToolCall[];
  executions: ScoreExecution[];
  bridges: BridgeRow[];
  wire: WireSummary | null;
  finishReason: 'normal' | 'truncated' | 'error' | 'unknown';
  interrupts: Array<{ turnIndex: number }>;
  redactionEvents: RedactionEvent[];
  fullContext: FullContext | null;
}

const INTERRUPT_RE = /\[Request interrupted|interrupted by user|用户中断|用户打断了|手动中断/i;

// ── wire 上下文构成（与 wire-rounds 路由同构的轮重建，只留 token 口径）──
// 内容指纹（长度 + 双 32 位哈希）：按「角色 + 指纹」分组数同请求内的逐字节相同副本
function fingerprint(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2, 33) + c >>> 0;
  }
  return `${s.length}.${h1.toString(36)}.${h2.toString(36)}`;
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
}

const approxTokens = (chars: number): number => Math.ceil(chars / 4);

function buildWireChars(sourcePath: string): WireSummary | null {
  // 评分取数：源文件缺失/损坏降级为 null（parseJsonlLines 已不吞读取错误）
  let lines: ReturnType<typeof parseJsonlLines>;
  try {
    lines = parseJsonlLines(sourcePath);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;

  const history: Array<{ role: string; chars: number; fp: string }> = [];
  const perRound: Array<{ index: number; dupCopyChars: number }> = [];
  const toolUseFile = new Map<string, string>();
  const fileResults = new Map<string, Array<{ msgIdx: number; chars: number; stale: boolean }>>();
  const fileCursor = new Map<string, number>();
  const touchQueue: Array<{ file: string; msgIdx: number }> = [];
  const staleByFile = new Map<string, number>();
  let staleRun = 0;
  let requestChars = 0;
  let dupCopyChars = 0;
  let pending: { msgsSnapshot: Array<{ role: string; chars: number; fp: string }> } | null = null;

  const snapshot = () => history.map(h => ({ role: h.role, chars: h.chars, fp: h.fp }));

  // 取代关系：touch（同文件读写）进入某轮请求后，更早的同文件工具结果即陈旧
  const drainTouches = (snapshotLen: number) => {
    while (touchQueue.length > 0 && touchQueue[0].msgIdx < snapshotLen) {
      const t = touchQueue.shift()!;
      const results = fileResults.get(t.file) ?? [];
      let cursor = fileCursor.get(t.file) ?? 0;
      let marked = 0;
      while (cursor < results.length && results[cursor].msgIdx < t.msgIdx) {
        const r = results[cursor];
        if (!r.stale) {
          r.stale = true;
          staleRun += r.chars;
          marked += r.chars;
        }
        cursor++;
      }
      fileCursor.set(t.file, cursor);
      if (marked > 0) staleByFile.set(t.file, (staleByFile.get(t.file) ?? 0) + marked);
    }
  };

  const closeRound = () => {
    if (!pending) return;
    const msgs = pending.msgsSnapshot;
    drainTouches(msgs.length);
    const groups = new Map<string, { chars: number; k: number }>();
    for (const m of msgs) {
      requestChars += m.chars;
      const key = `${m.role}|${m.fp}`;
      const g = groups.get(key) ?? { chars: m.chars, k: 0 };
      g.k++;
      groups.set(key, g);
    }
    let roundDup = 0;
    for (const g of groups.values()) {
      if (g.k > 1) { roundDup += (g.k - 1) * g.chars; dupCopyChars += (g.k - 1) * g.chars; }
    }
    perRound.push({ index: perRound.length + 1, dupCopyChars: roundDup });
    history.push({ role: 'assistant', chars: 0, fp: fingerprint('') });
    pending = null;
  };

  for (const line of lines) {
    if (line.type === 'assistant' && line.message) {
      if (!pending) pending = { msgsSnapshot: snapshot() };
      for (const b of contentBlocks(line.message.content)) {
        if (b['type'] === 'tool_use' && typeof b['id'] === 'string') {
          const file = extractFilePath(JSON.stringify(b['input'] ?? {}));
          if (file) {
            toolUseFile.set(b['id'], file);
            touchQueue.push({ file, msgIdx: history.length });
          }
        }
      }
      continue;
    }
    closeRound();
    if ((line.type === 'user' || line.type === 'system') && line.message) {
      const msgIdx = history.length;
      const contentStr = JSON.stringify(line.message.content ?? '');
      history.push({ role: line.message.role, chars: contentStr.length, fp: fingerprint(contentStr) });
      if (line.type === 'user') {
        for (const b of contentBlocks(line.message.content)) {
          if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
            const file = toolUseFile.get(b['tool_use_id']);
            if (file) {
              const arr = fileResults.get(file) ?? [];
              arr.push({ msgIdx, chars: JSON.stringify(b).length, stale: false });
              fileResults.set(file, arr);
            }
          }
        }
      }
    }
  }
  closeRound();

  if (perRound.length === 0 || requestChars === 0) return null;

  return {
    dupCopyTokens: approxTokens(dupCopyChars),
    staleResultTokens: approxTokens(staleRun),
    requestTokens: approxTokens(requestChars),
    staleFiles: [...staleByFile.entries()]
      .map(([file, chars]) => ({ file, chars }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 5),
    perRound,
  };
}

// ── 结束原因（D1.stopReason 前置门的原料）───────────────────────────
function detectFinishReason(sourcePath: string | null, turns: ScoreTurn[]): CollectedData['finishReason'] {
  if (sourcePath) {
    let lines: ReturnType<typeof parseJsonlLines> = [];
    try {
      lines = parseJsonlLines(sourcePath);
    } catch { /* 源不可读 → 走下方 turns 兜底（与旧行为一致） */ }
    let lastStop: string | null = null;
    for (const line of lines) {
      if (line.type === 'assistant' && line.message) {
        const sr = (line.message as { stop_reason?: unknown }).stop_reason;
        if (typeof sr === 'string') lastStop = sr;
      }
    }
    if (lastStop === 'max_tokens') return 'truncated';
    if (lastStop === 'error' || lastStop === 'refusal') return 'error';
    if (lastStop) return 'normal';
  }
  // 无 wire：末尾打断标记 → truncated；末轮报错 → error；否则 unknown（放行，宁可放过）
  const lastAssistant = [...turns].reverse().find(t => t.role === 'assistant');
  const tail = lastAssistant ? turns.filter(t => t.turnIndex > lastAssistant.turnIndex) : [];
  if (tail.some(t => INTERRUPT_RE.test(`${t.content ?? ''}${t.contentSummary ?? ''}`))) return 'truncated';
  const errorTail = turns.filter(t => t.role === 'assistant').slice(-3);
  if (errorTail.length > 0 && errorTail.every(t => (t.contentSummary ?? '').length === 0 && t.totalTokens === 0)) return 'unknown';
  return 'unknown';
}

function detectInterrupts(turns: ScoreTurn[]): Array<{ turnIndex: number }> {
  const out: Array<{ turnIndex: number }> = [];
  for (const t of turns) {
    if (t.role !== 'user') continue;
    if (INTERRUPT_RE.test(`${t.content ?? ''}${t.contentSummary ?? ''}`)) out.push({ turnIndex: t.turnIndex });
  }
  return out;
}

// ── 脱敏命中事件（D2.secrets proxy 路；proxy 侧尚未导出时为空数组）──
function detectRedactionEvents(sourcePath: string | null): RedactionEvent[] {
  if (!sourcePath) return [];
  const events: RedactionEvent[] = [];
  try {
    const lines = parseJsonlLines(sourcePath);
    lines.forEach((line, i) => {
      const xb = (line as { x_cannbay?: { data?: { redactions?: unknown } } }).x_cannbay;
      const arr = xb?.data?.redactions;
      if (!Array.isArray(arr)) return;
      for (const r of arr) {
        if (!r || typeof r !== 'object') continue;
        const rr = r as { turnIndex?: unknown; pattern?: unknown; location?: unknown };
        if (typeof rr.pattern !== 'string') continue;
        events.push({
          turnIndex: typeof rr.turnIndex === 'number' ? rr.turnIndex : i,
          pattern: rr.pattern,
          location: rr.location === 'tool-args' ? 'tool-args' : rr.location === 'file-write' ? 'file-write' : 'request',
        });
      }
    });
  } catch { /* 捕获文件不可读时按无命中处理 */ }
  return events;
}

export async function collectForScoring(taskId: string, prisma: PrismaClient, framework?: string): Promise<CollectedData | null> {
  const session = await prisma.session.findFirst({
    where: { taskId, ...(framework ? { framework } : {}) },
    select: {
      id: true, taskId: true, framework: true, version: true, model: true,
      startTime: true, endTime: true, totalTokens: true, totalCost: true, totalLatencyMs: true, sourcePath: true,
    },
    orderBy: { startTime: 'desc' },
  });
  if (!session) return null;

  const turnRows = await prisma.turn.findMany({
    where: { sessionId: session.id },
    select: {
      id: true, turnIndex: true, role: true, agentName: true, isSubagent: true, subagentSessionId: true,
      contentSummary: true, content: true, totalTokens: true, inputTokens: true, inputMessagesTokens: true,
      latencyMs: true, createdAt: true, createdAt_ts: true, model: true,
    },
  });

  const toolCallRows = await prisma.toolCall.findMany({
    where: { turn: { sessionId: session.id } },
    select: {
      id: true, toolName: true, argsJson: true, resultJson: true, state: true, errorType: true,
      durationMs: true, startedAt: true, completedAt: true, errorMessage: true, turn: { select: { turnIndex: true, isSubagent: true, agentName: true } },
    },
  });

  const executionRows = await prisma.execution.findMany({
    where: { sessionId: session.id },
    select: { agentName: true, isSubagent: true, tokens: true, cost: true, latencyMs: true, toolCallCount: true, toolCallErrorCount: true },
  });

  const bridgeRows = await prisma.interactionBridge.findMany({
    where: { sessionId: session.id },
    select: {
      dispatchContent: true, dispatchTimestamp: true, subagentType: true, subagentName: true,
      status: true, subagentTokens: true,
    },
  });

  const turns: ScoreTurn[] = turnRows
    .map(t => ({
      id: t.id,
      turnIndex: t.turnIndex,
      role: t.role,
      agentName: t.agentName,
      isSubagent: t.isSubagent,
      subagentSessionId: t.subagentSessionId,
      contentSummary: t.contentSummary,
      content: t.content,
      totalTokens: t.totalTokens,
      inputTokens: t.inputTokens,
      inputMessagesTokens: t.inputMessagesTokens,
      latencyMs: t.latencyMs,
      createdAtISO: t.createdAt ? t.createdAt.toISOString() : null,
      createdAtTsISO: t.createdAt_ts ? t.createdAt_ts.toISOString() : null,
      model: t.model,
    }))
    .sort((a, b) => a.turnIndex - b.turnIndex);

  const toolCalls: ScoreToolCall[] = toolCallRows
    .map(tc => ({
      id: tc.id,
      toolName: tc.toolName,
      argsJson: tc.argsJson,
      resultJson: tc.resultJson,
      state: tc.state,
      errorType: tc.errorType,
      errorMessage: tc.errorMessage,
      // durationMs 采集侧未回填（全库 0），从起止时间戳推导；时间戳供并行度算区间并集
      durationMs: tc.durationMs > 0
        ? tc.durationMs
        : tc.startedAt && tc.completedAt ? Math.max(0, tc.completedAt.getTime() - tc.startedAt.getTime()) : 0,
      startedAtMs: tc.startedAt?.getTime() ?? null,
      completedAtMs: tc.completedAt?.getTime() ?? null,
      turnIndex: tc.turn.turnIndex,
      isSubagent: tc.turn.isSubagent,
      agentName: tc.turn.agentName,
      seq: 0,
    }))
    .sort((a, b) => a.turnIndex - b.turnIndex || a.id.localeCompare(b.id));
  toolCalls.forEach((tc, i) => { tc.seq = i; });

  const claudeFormat = session.sourcePath != null && isClaudeFormatSession(session.framework, session.version);
  const sourcePath = claudeFormat ? session.sourcePath : null;

  const baseWire = sourcePath ? buildWireChars(sourcePath) : null;
  const fullContext = sourcePath ? readFullContext(sourcePath) : null;
  const wire: WireSummary | null = baseWire && sourcePath
    ? {
      ...baseWire,
      declaredTools: fullContext?.tools.map(t => ({ name: t.name, approxTokens: approxTokens(t.description.length) })),
      availableSkills: readAvailableSkills(sourcePath)?.skills.map(s => ({
        name: s.name,
        description: s.description,
        approxTokens: approxTokens(s.description.length + s.name.length + 8),
      })),
      memoryTokens: fullContext?.memoryFiles ? approxTokens(fullContext.memoryFiles.length) : undefined,
    }
    : null;

  return {
    session: {
      taskId: session.taskId,
      sessionId: session.id,
      framework: session.framework,
      version: session.version,
      model: session.model,
      startTime: session.startTime,
      endTime: session.endTime,
      totalTokens: session.totalTokens,
      totalCost: session.totalCost,
      totalLatencyMs: session.totalLatencyMs,
    },
    turns,
    toolCalls,
    executions: executionRows.map(e => ({
      agentName: e.agentName ?? '',
      isSubagent: e.isSubagent,
      tokens: e.tokens,
      cost: e.cost,
      latencyMs: e.latencyMs,
      toolCallCount: e.toolCallCount,
      toolCallErrorCount: e.toolCallErrorCount,
    })),
    bridges: bridgeRows.map(b => ({
      dispatchContent: b.dispatchContent,
      dispatchTimestamp: b.dispatchTimestamp ? b.dispatchTimestamp.toISOString() : null,
      subagentType: b.subagentType,
      subagentName: b.subagentName,
      status: b.status,
      subagentTokens: b.subagentTokens,
    })),
    wire,
    finishReason: detectFinishReason(sourcePath, turns),
    interrupts: detectInterrupts(turns),
    redactionEvents: detectRedactionEvents(sourcePath),
    fullContext,
  };
}
