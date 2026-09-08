// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分数据装配（只读）：session + turns + toolCalls + executions + wire 轮次。
// wire 重建与 /api/observe/session/wire-rounds 同构（append-only 累积），此处
// 只保留评分需要的字符量口径，不复制全文。
// D2 口径修订（设计方案 §10）：跨轮前缀重发在 append-only 协议下恒 ≈99%，无
// 质量信息量——采集层改为输出 D2a 轮内重复副本 / D2b 缓存命中 token / D2c 陈旧
// 工具结果字符 三个原始量。

import type { PrismaClient } from '@prisma/client';
import { isClaudeFormatSession } from '@/lib/shared/session-format';
import { parseJsonlLines } from '@/lib/ingest/adapters/claude-jsonl';
import { extractFilePath } from '@/lib/file-restore';

export interface ScoreTurn {
  id: string;
  turnIndex: number;
  role: string;
  agentName: string | null;
  isSubagent: boolean;
  subagentSessionId: string | null;
  contentSummary: string | null;
  content: string | null;
  totalTokens: number;
  inputTokens: number;
  inputMessagesTokens: number;
  createdAtISO: string | null;
  createdAtTsISO: string | null;
  model: string | null;
}

export interface ScoreToolCall {
  id: string;
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  state: string;
  errorType: string | null;
  durationMs: number;
  turnIndex: number;
  isSubagent: boolean;
  agentName: string | null;
  seq: number;
}

export interface ScoreExecution {
  agentName: string;
  isSubagent: boolean;
  tokens: number;
  cost: number;
  latencyMs: number;
  toolCallCount: number;
  toolCallErrorCount: number;
}

export interface WireRoundChars {
  index: number;
  newFrom: number;
  messageCount: number;
  requestChars: number;
  systemChars: number;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** D2a：本轮请求内逐字节相同消息的多余副本字符量（k 份计 k−1 份） */
  dupCopyChars: number;
  /** D2c：本轮请求中已被更晚同文件读写取代的工具结果字符量 */
  staleToolResultChars: number;
}

export interface WireCharsSummary {
  rounds: number;
  requestChars: number;
  systemChars: number;
  dupCopyChars: number;
  staleToolResultChars: number;
  staleFiles: Array<{ file: string; chars: number }>;
  /** D2b：usage 带 cache 字段的轮数与 token 累计（0 轮 = 该指标不适用） */
  roundsWithCacheUsage: number;
  uncachedTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  perRound: WireRoundChars[];
}

export interface ScoringData {
  session: {
    taskId: string;
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
  wire: WireCharsSummary | null;
}

// 内容指纹（长度 + 双 32 位哈希）：D2a 按「角色 + 指纹」分组数同请求内的
// 逐字节相同副本，不驻留全文
function fingerprint(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + c) >>> 0;
  }
  return `${s.length}.${h1.toString(36)}.${h2.toString(36)}`;
}

interface WireUsageShape {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  prompt_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
}

function numOr(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
}

function buildWireChars(sourcePath: string): WireCharsSummary | null {
  const lines = parseJsonlLines(sourcePath);
  if (lines.length === 0) return null;

  const history: Array<{ role: string; chars: number; fp: string }> = [];
  const perRound: WireRoundChars[] = [];
  const toolUseFile = new Map<string, string>();
  const fileResults = new Map<string, Array<{ msgIdx: number; chars: number; stale: boolean }>>();
  const fileCursor = new Map<string, number>();
  const touchQueue: Array<{ file: string; msgIdx: number }> = [];
  const staleByFile = new Map<string, number>();
  let staleRun = 0;
  let pending: {
    msgsSnapshot: Array<{ role: string; chars: number; fp: string }>;
    inputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
  } | null = null;

  const snapshot = () => history.map(h => ({ role: h.role, chars: h.chars, fp: h.fp }));

  // D2c 取代关系：touch（同文件读写）一旦进入某轮请求（msgIdx < 该轮快照长），
  // 其更早的同文件工具结果即视为陈旧。touchQueue 按 msgIdx 有序，逐轮增量标记
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
    // 与 wire-rounds 路由同构：newFrom = 上一轮请求消息数（append-only 前缀）
    const newFrom = perRound.length === 0 ? 0 : perRound[perRound.length - 1].messageCount;
    let requestChars = 0;
    let systemChars = 0;
    let dupCopyChars = 0;
    const groups = new Map<string, { chars: number; k: number }>();
    for (const m of msgs) {
      requestChars += m.chars;
      if (m.role === 'system') systemChars += m.chars;
      const key = `${m.role}|${m.fp}`;
      const g = groups.get(key) ?? { chars: m.chars, k: 0 };
      g.k++;
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      if (g.k > 1) dupCopyChars += (g.k - 1) * g.chars;
    }
    perRound.push({
      index: perRound.length + 1,
      newFrom,
      messageCount: msgs.length,
      requestChars,
      systemChars,
      inputTokens: pending.inputTokens,
      cacheReadTokens: pending.cacheReadTokens,
      cacheCreationTokens: pending.cacheCreationTokens,
      dupCopyChars,
      staleToolResultChars: staleRun,
    });
    history.push({ role: 'assistant', chars: 0, fp: fingerprint('') });
    pending = null;
  };

  for (const line of lines) {
    if (line.type === 'assistant' && line.message) {
      const usage = (line.message.usage ?? null) as WireUsageShape | null;
      if (!pending) {
        const cachedRead = numOr(usage?.cache_read_input_tokens) ?? numOr(usage?.prompt_tokens_details?.cached_tokens);
        let inputTokens = numOr(usage?.input_tokens);
        if (inputTokens == null) {
          const prompt = numOr(usage?.prompt_tokens);
          inputTokens = prompt == null ? null : Math.max(0, prompt - (cachedRead ?? 0));
        }
        pending = {
          msgsSnapshot: snapshot(),
          inputTokens,
          cacheReadTokens: cachedRead,
          cacheCreationTokens: numOr(usage?.cache_creation_input_tokens),
        };
      }
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

  const roundsWithCacheUsage = perRound.filter(r => r.cacheReadTokens != null);
  return {
    rounds: perRound.length,
    requestChars: perRound.reduce((s, r) => s + r.requestChars, 0),
    systemChars: perRound.reduce((s, r) => s + r.systemChars, 0),
    dupCopyChars: perRound.reduce((s, r) => s + r.dupCopyChars, 0),
    staleToolResultChars: perRound.reduce((s, r) => s + r.staleToolResultChars, 0),
    staleFiles: [...staleByFile.entries()]
      .map(([file, chars]) => ({ file, chars }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 5),
    roundsWithCacheUsage: roundsWithCacheUsage.length,
    uncachedTokens: roundsWithCacheUsage.reduce((s, r) => s + (r.inputTokens ?? 0) + (r.cacheCreationTokens ?? 0), 0),
    cachedReadTokens: roundsWithCacheUsage.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
    cacheCreationTokens: roundsWithCacheUsage.reduce((s, r) => s + (r.cacheCreationTokens ?? 0), 0),
    perRound,
  };
}

export async function collectScoringData(taskId: string, prisma: PrismaClient): Promise<ScoringData | null> {
  const session = await prisma.session.findFirst({
    where: { taskId },
    select: {
      id: true,
      taskId: true,
      framework: true,
      version: true,
      model: true,
      startTime: true,
      endTime: true,
      totalTokens: true,
      totalCost: true,
      totalLatencyMs: true,
      sourcePath: true,
    },
    orderBy: { startTime: 'desc' },
  });
  if (!session) return null;

  const turnRows = await prisma.turn.findMany({
    where: { sessionId: session.id },
    select: {
      id: true,
      turnIndex: true,
      role: true,
      agentName: true,
      isSubagent: true,
      subagentSessionId: true,
      contentSummary: true,
      content: true,
      totalTokens: true,
      inputTokens: true,
      inputMessagesTokens: true,
      createdAt: true,
      createdAt_ts: true,
      model: true,
    },
  });

  const toolCallRows = await prisma.toolCall.findMany({
    where: { turn: { sessionId: session.id } },
    select: {
      id: true,
      toolName: true,
      argsJson: true,
      resultJson: true,
      state: true,
      errorType: true,
      durationMs: true,
      startedAt: true,
      turn: { select: { turnIndex: true, isSubagent: true, agentName: true } },
    },
  });

  const executionRows = await prisma.execution.findMany({
    where: { sessionId: session.id },
    select: {
      agentName: true,
      isSubagent: true,
      tokens: true,
      cost: true,
      latencyMs: true,
      toolCallCount: true,
      toolCallErrorCount: true,
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
      durationMs: tc.durationMs,
      turnIndex: tc.turn.turnIndex,
      isSubagent: tc.turn.isSubagent,
      agentName: tc.turn.agentName,
      seq: 0,
    }))
    .sort((a, b) =>
      a.turnIndex - b.turnIndex
      || a.id.localeCompare(b.id)
    );
  toolCalls.forEach((tc, i) => { tc.seq = i; });

  const wire = session.sourcePath && isClaudeFormatSession(session.framework, session.version)
    ? buildWireChars(session.sourcePath)
    : null;

  return {
    session: {
      taskId: session.taskId,
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
    wire,
  };
}
