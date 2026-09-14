// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { TurnRow, ToolCallRow, SkillEventRow } from './turn-split';

export interface DedupSessionResult {
  shouldImport: boolean;
  existingSessionId: string | null;
}

export function dedupSession(
  existingSessionId: string | null,
  newTaskId: string
): DedupSessionResult {
  if (existingSessionId) {
    return { shouldImport: false, existingSessionId };
  }
  return { shouldImport: true, existingSessionId: null };
}

// 稳定身份键：`${context}#${rank}`，context = subagentSessionId ?? 'main'，
// rank 是上下文内交互次序。全局 turnIndex 是拼接数组 [main..., sub...] 的下标，
// main 增长会平移所有 subagent 的下标导致 dedup 键漂移；上下文内 rank 不受影响。
// 输入须为完整解析序（新解析的 turns 数组本身就是）。
export function rankedKeyMap<T extends { subagentSessionId: string | null | undefined }>(
  rows: T[],
): Map<T, string> {
  const counters = new Map<string, number>();
  const keys = new Map<T, string>();
  for (const row of rows) {
    const ctx = row.subagentSessionId ?? 'main';
    const rank = counters.get(ctx) ?? 0;
    counters.set(ctx, rank + 1);
    keys.set(row, `${ctx}#${rank}`);
  }
  return keys;
}

// DB 侧行的键推导：全局 turnIndex 升序等价于导入时的拼接数组序（各 context 连续），
// 排序后按上下文计数即还原 rank。
export function keyByRankedTurn<T extends { subagentSessionId: string | null | undefined; turnIndex: number }>(
  rows: T[],
): Map<string, T> {
  const rowKeys = rankedKeyMap([...rows].sort((a, b) => a.turnIndex - b.turnIndex));
  return new Map([...rowKeys.entries()].map(([row, key]) => [key, row]));
}

// 漂移检测：增量位次匹配的合法性前提是"每个上下文（main/subagent）的既有
// 轮次 = 新读序列的前缀"（append-only）。逐上下文校验既有段：
//   - 源侧回缩（新读 < 既有）→ 漂移
//   - 身份字段（role / agentName / subagentSessionId）任一位不一致 → 漂移
//     （位次错位的直接表征：user 轮对上 assistant 行）
//   - 内容改写/回缩（新内容既不相等也不是既有内容的前缀延长）→ 漂移；
//     尾部增长合法（in-flight 轮补全/追写）
// 任一上下文命中即判定整体漂移，调用方降级全量替换。
export function detectRankedPrefixDrift<T extends {
  subagentSessionId: string | null | undefined;
  turnIndex: number;
  role: string;
  agentName: string | null | undefined;
  content: string | null;
}>(
  existing: T[],
  incoming: T[],
): boolean {
  // 既有侧来自 findMany（无序）——须按 turnIndex 升序还原导入序；新读侧
  // 本就是读序（turnIndex 按读序赋值），同款排序幂等
  const byCtx = (rows: T[], sorted: boolean): Map<string, T[]> => {
    const ordered = sorted ? [...rows].sort((a, b) => a.turnIndex - b.turnIndex) : rows;
    const m = new Map<string, T[]>();
    for (const r of ordered) {
      const ctx = r.subagentSessionId ?? 'main';
      const arr = m.get(ctx) ?? [];
      arr.push(r);
      m.set(ctx, arr);
    }
    return m;
  };
  const existingByCtx = byCtx(existing, true);
  const incomingByCtx = byCtx(incoming, false);
  for (const [ctx, e] of existingByCtx) {
    const n = incomingByCtx.get(ctx) ?? [];
    if (n.length < e.length) return true;
    for (let i = 0; i < e.length; i++) {
      if (e[i].role !== n[i].role) return true;
      if ((e[i].agentName ?? null) !== (n[i].agentName ?? null)) return true;
      if ((e[i].subagentSessionId ?? null) !== (n[i].subagentSessionId ?? null)) return true;
      const eC = e[i].content ?? '';
      const nC = n[i].content ?? '';
      if (nC !== eC && !nC.startsWith(eC)) return true;
    }
  }
  return false;
}

export function mergeTurns(existingTurns: TurnRow[], newTurns: TurnRow[]): TurnRow[] {
  const existingKeys = new Set(keyByRankedTurn(existingTurns).keys());
  const incomingKeys = rankedKeyMap(newTurns);

  const merged = [...existingTurns];
  for (const turn of newTurns) {
    if (!existingKeys.has(incomingKeys.get(turn)!)) {
      merged.push(turn);
    }
  }

  merged.sort((a, b) => a.turnIndex - b.turnIndex || a.role.localeCompare(b.role));
  return merged;
}

export function mergeToolCalls(existing: ToolCallRow[], incoming: ToolCallRow[]): ToolCallRow[] {
  const existingIds = new Set(existing.map(tc => tc.toolCallId));

  const merged = [...existing];
  for (const tc of incoming) {
    if (!existingIds.has(tc.toolCallId)) {
      merged.push(tc);
      existingIds.add(tc.toolCallId);
    }
  }

  return merged;
}

export function mergeSkillEvents(existing: SkillEventRow[], incoming: SkillEventRow[]): SkillEventRow[] {
  const existingKeys = new Set(
    existing.map(se => `${se.turnId}:${se.skillName}:${se.eventType}`)
  );

  const merged = [...existing];
  for (const se of incoming) {
    const key = `${se.turnId}:${se.skillName}:${se.eventType}`;
    if (!existingKeys.has(key)) {
      merged.push(se);
      existingKeys.add(key);
    }
  }

  return merged;
}

export interface TurnUpdate {
  dbId: string;
  data: Record<string, unknown>;
}

export interface ToolCallUpdate {
  dbId: string;
  data: Record<string, unknown>;
}

const TURN_UPDATE_FIELDS: (keyof TurnRow)[] = [
  'content', 'contentSummary',
  'totalTokens', 'inputTokens', 'outputTokens', 'reasoningTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'completedAt', 'latencyMs',
  'ttftMs', 'model', 'modelId', 'providerId', 'finishReason',
];

const TC_UPDATE_FIELDS: (keyof ToolCallRow)[] = [
  'resultJson', 'state', 'errorType', 'errorMessage',
  'completedAt', 'durationMs', 'dispatchBridgeId', 'isSkillRelated',
];

export function diffTurns(
  existingTurns: TurnRow[],
  incoming: TurnRow[],
): { toInsert: TurnRow[]; toUpdate: TurnUpdate[] } {
  const existingByKey = keyByRankedTurn(existingTurns);
  const incomingKeys = rankedKeyMap(incoming);

  const toInsert: TurnRow[] = [];
  const toUpdate: TurnUpdate[] = [];

  for (const turn of incoming) {
    const existing = existingByKey.get(incomingKeys.get(turn)!);
    if (!existing) {
      toInsert.push(turn);
      continue;
    }
    const changes: Record<string, unknown> = {};
    for (const field of TURN_UPDATE_FIELDS) {
      const oldVal = existing[field];
      const newVal = turn[field];
      if (oldVal !== newVal && (oldVal !== null || newVal !== null)) {
        changes[field] = newVal;
      }
    }
    if (Object.keys(changes).length > 0) {
      toUpdate.push({ dbId: existing.id, data: changes });
    }
  }

  return { toInsert, toUpdate };
}

export function diffToolCalls(
  existingById: Map<string, ToolCallRow>,
  incoming: ToolCallRow[],
): { toInsert: ToolCallRow[]; toUpdate: ToolCallUpdate[] } {
  const toInsert: ToolCallRow[] = [];
  const toUpdate: ToolCallUpdate[] = [];

  for (const tc of incoming) {
    const existing = existingById.get(tc.toolCallId);
    if (!existing) {
      toInsert.push(tc);
      continue;
    }
    const changes: Record<string, unknown> = {};
    for (const field of TC_UPDATE_FIELDS) {
      const oldVal = existing[field];
      const newVal = tc[field];
      if (oldVal !== newVal && (oldVal !== null || newVal !== null)) {
        changes[field] = newVal;
      }
    }
    if (Object.keys(changes).length > 0) {
      toUpdate.push({ dbId: existing.id, data: changes });
    }
  }

  return { toInsert, toUpdate };
}
