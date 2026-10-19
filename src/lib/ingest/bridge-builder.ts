// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { subagentTiming } from '@/lib/subagent-timing';
import type { RawInteraction } from '../shared/types';
import type { ToolCallRow, TurnRow } from './turn-split';
import { resolveDispatchToolCall, type DispatchRecord } from './dispatch-tools';

export interface InteractionBridgeRow {
  id: string;
  sessionId: string;
  dispatchExecutionId: string;
  dispatchTurnId: string | null;
  dispatchToolCallId: string | null;
  dispatchContent: string | null;
  dispatchTimestamp: string | null;
  responseExecutionId: string | null;
  responseTurnId: string | null;
  responseContent: string | null;
  responseTimestamp: string | null;
  subagentSessionId: string | null;
  subagentType: string | null;
  subagentName: string | null;
  status: string;
  subagentTokens: number;
  subagentLatencyMs: number;
}

let idCounter = 0;

function generateId(): string {
  idCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  const cnt = idCounter.toString(36);
  return `c${ts}${rand}${cnt}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

const TIMEOUT_THRESHOLD_MS = 30 * 60 * 1000;

// 派发工具的识别与参数解析在 dispatch-tools.ts 的声明式注册表（spec 列表）：
// claude Task（jsonl 原生 task / proxy Agent）+ codex spawn_agent + 自定义派发
// 工具族（reuseDispatch 的 subagent 插件…）。本文件只保留「匹配 → 建桥」逻辑，
// 新增派发形态不再改这里。

function isSubagentError(turn: TurnRow): boolean {
  if (turn.finishReason === 'error' || turn.finishReason === 'failed') return true;
  return false;
}

export function buildBridges(
  interactions: RawInteraction[],
  toolCalls: ToolCallRow[],
  turns: TurnRow[],
  sessionId: string,
  rootExecutionId: string,
  toolUseIdToSubagentSessionId?: Map<string, string>,
): InteractionBridgeRow[] {
  const bridges: InteractionBridgeRow[] = [];

  // 派发工具识别走声明式注册表（dispatch-tools.ts）：claude Task（jsonl 原生
  // task / proxy Agent）+ codex spawn_agent + 自定义派发工具族（subagent 插件…）
  const dispatchEntries: Array<{ tc: ToolCallRow; rec: DispatchRecord }> = [];
  for (const tc of toolCalls) {
    const rec = resolveDispatchToolCall(tc);
    if (rec) dispatchEntries.push({ tc, rec });
  }

  const subagentInteractionMap = new Map<string, RawInteraction[]>();
  for (const interaction of interactions) {
    const sid = interaction.subagent_session_id;
    if (sid) {
      const list = subagentInteractionMap.get(sid) ?? [];
      list.push(interaction);
      subagentInteractionMap.set(sid, list);
    }
  }

  const subagentTurnMap = new Map<string, TurnRow[]>();
  for (const turn of turns) {
    const sid = turn.subagentSessionId;
    if (sid) {
      const list = subagentTurnMap.get(sid) ?? [];
      list.push(turn);
      subagentTurnMap.set(sid, list);
    }
  }

  const usedSessionIds = new Set<string>();

  // 复用会话的派发时刻表：同 sid 相邻两次派发（dispatch_i → dispatch_{i+1}）
  // 构成本次派发的窗口，response/末条 turn/tokens 只在窗口内锚定。否则复用
  // 会话（首发+返工重入）的每条桥都锚到会话全局末条 turn，两窗互相包含
  //（现场 ses_ecb797cb P1/P2 各一对，读成「没执行完就返工」）
  const dispatchTimesBySession = new Map<string, number[]>();
  for (const { tc, rec } of dispatchEntries) {
    // 与主循环 matchedSessionId 同序三段解析（arg → meta 映射 → result）：
    // meta 直连形态（claude proxy Agent）下 meta 值可能与 resultSessionId
    // 不同，只认 arg/result 会查空时刻表 → 窗口退化为无界、复用配对失效
    const preSid = rec.argSessionId
      ?? (rec.spec.linkViaToolUseMeta && toolUseIdToSubagentSessionId
        ? toolUseIdToSubagentSessionId.get(tc.toolCallId) ?? null
        : null)
      ?? rec.resultSessionId;
    if (!preSid) continue;
    const preMs = tc.startedAt ? new Date(tc.startedAt).getTime() : NaN;
    if (!Number.isFinite(preMs)) continue;
    const arr = dispatchTimesBySession.get(preSid) ?? [];
    arr.push(preMs);
    dispatchTimesBySession.set(preSid, arr);
  }
  for (const arr of dispatchTimesBySession.values()) arr.sort((a, b) => a - b);

  for (const { tc: dispatchTc, rec } of dispatchEntries) {
    let matchedSessionId: string | null = rec.argSessionId;

    // For Agent tool calls, use the meta.json toolUseId mapping for precise matching
    if (!matchedSessionId && rec.spec.linkViaToolUseMeta && toolUseIdToSubagentSessionId) {
      matchedSessionId = toolUseIdToSubagentSessionId.get(dispatchTc.toolCallId) ?? null;
    }

    // 结果侧提取（spawn_agent JSON agent_id / task_id 文本协议）在 spec 的
    // 提取器列表里按序完成
    if (!matchedSessionId) {
      matchedSessionId = rec.resultSessionId;
    }

    if (!matchedSessionId) {
      // 派发已得到结果、却提取不出任何子会话 id（agent_id/task_id/
      // subagent_session_id 全无）——工具以错误文本作答，子代理从未被创建。
      // 失败的派发尝试不是子代理：跳过建桥（错误 tool call 在主时间线
      // verbatim 完整可见），更不能落入下方时间邻近回退——那会把失败
      // 尝试误锚到无关子代理。真机 0.162：模型 6 次失败 spawn（双参被拒
      // ×3、reasoning_effort 被拒×3），旧逻辑产出 4 条误锚桥 + 2 条
      // 0-turn 幽灵 lane（wire 上 codex 的 function_call_output 无
      // is_error 标志，错误只在内容里——state=completed 不能作判据）。
      // 结果为空/null 语义不同：结果尚未到达（导入进行中的会话），
      // 'dispatched' 桥保留。
      if (dispatchTc.resultJson && dispatchTc.resultJson.trim()) {
        continue;
      }
      const dispatchTime = dispatchTc.startedAt ? new Date(dispatchTc.startedAt).getTime() : 0;
      let closestSessionId: string | null = null;
      let closestDiff = Infinity;
      for (const [sid, subInteractions] of subagentInteractionMap) {
        if (usedSessionIds.has(sid)) continue;
        const firstTime = subInteractions[0]?.timeInfo?.created ?? 0;
        const diff = Math.abs(firstTime - dispatchTime);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestSessionId = sid;
        }
      }
      if (closestSessionId && closestDiff < TIMEOUT_THRESHOLD_MS) {
        matchedSessionId = closestSessionId;
      }
    }

    const dispatchContent = rec.content;
    const dispatchTimestamp = dispatchTc.startedAt ?? null;

    const subagentName = rec.displayName ?? rec.resultNickname ?? null;
    const subagentType = rec.agentType;

    if (matchedSessionId) {
      usedSessionIds.add(matchedSessionId);

      const subTurnsAll = [...(subagentTurnMap.get(matchedSessionId) ?? [])].sort((a, b) => {
        const ta = a.createdAt_ts ? new Date(a.createdAt_ts).getTime() : 0;
        const tb = b.createdAt_ts ? new Date(b.createdAt_ts).getTime() : 0;
        return ta - tb;
      });
      // 窗口 = [本次派发, 同 sid 下次派发)；窗口内无 turn 时退化为「本次派发
      // 之后的尾巴」，仍为空再退化为整会话（单派发/异步兜底，行为不变）
      const dispatchMs = dispatchTimestamp ? new Date(dispatchTimestamp).getTime() : NaN;
      const sidTimes = dispatchTimesBySession.get(matchedSessionId) ?? [];
      const nextDispatchMs = Number.isFinite(dispatchMs)
        ? sidTimes.find(t => t > dispatchMs) ?? null
        : null;
      let subTurns = subTurnsAll;
      if (Number.isFinite(dispatchMs) && subTurnsAll.length > 0) {
        const afterDispatch = subTurnsAll.filter(t => {
          const ts = t.createdAt_ts ? new Date(t.createdAt_ts).getTime() : NaN;
          return Number.isFinite(ts) && ts >= dispatchMs;
        });
        const inWindow = nextDispatchMs !== null
          ? afterDispatch.filter(t => new Date(t.createdAt_ts!).getTime() < nextDispatchMs)
          : afterDispatch;
        if (inWindow.length > 0) subTurns = inWindow;
        else if (nextDispatchMs !== null) {
          // 空窗回退只放开下界、仍卡上界（时钟偏移下 turn 早于派发时刻的形态）；
          // 再空则宁空（桥走 pending 口径）也不吞下窗 turn——后台派发
          // 「先派发、turn 后到」时旧回退会把下一窗的 turn 记到本次头上
          const boundedAbove = subTurnsAll.filter(t => {
            const ts = t.createdAt_ts ? new Date(t.createdAt_ts).getTime() : NaN;
            return Number.isFinite(ts) && ts < nextDispatchMs;
          });
          subTurns = boundedAbove; // 空则置空（pending 口径），不回落整会话
        } else if (afterDispatch.length > 0) subTurns = afterDispatch;
      }

      if (subTurns.length > 0) {
        const lastTurn = subTurns[subTurns.length - 1];
        const responseContent = lastTurn.content ?? null;
        const timing = subagentTiming(subTurns, dispatchTimestamp);
        const responseTimestamp = timing?.responseTimestamp ?? lastTurn.completedAt ?? null;
        const responseTurnId = lastTurn.id ?? null;

        const subagentTokens = subTurns.reduce((sum, t) => sum + t.totalTokens, 0);
        const subagentLatencyMs = timing?.latencyMs ?? 0;

        const hasError = subTurns.some(t => isSubagentError(t));

        let status: string;
        if (!hasError) {
          status = 'completed';
        } else {
          status = 'failed';
        }

        bridges.push({
          id: generateId(),
          sessionId,
          dispatchExecutionId: rootExecutionId,
          dispatchTurnId: dispatchTc.turnId,
          dispatchToolCallId: dispatchTc.id,
          dispatchContent,
          dispatchTimestamp,
          responseExecutionId: null,
          responseTurnId,
          responseContent,
          responseTimestamp,
          subagentSessionId: matchedSessionId,
          subagentType,
          subagentName: subagentName ?? (lastTurn.subagentName ?? null),
          status,
          subagentTokens,
          subagentLatencyMs,
        });
      } else {
        const dispatchTimeMs = dispatchTimestamp
          ? new Date(dispatchTimestamp).getTime()
          : 0;
        const nowMs = Date.now();
        const elapsed = nowMs - dispatchTimeMs;

        let status: string;
        if (elapsed > TIMEOUT_THRESHOLD_MS) {
          status = 'timeout';
        } else {
          status = 'dispatched';
        }

        bridges.push({
          id: generateId(),
          sessionId,
          dispatchExecutionId: rootExecutionId,
          dispatchTurnId: dispatchTc.turnId,
          dispatchToolCallId: dispatchTc.id,
          dispatchContent,
          dispatchTimestamp,
          responseExecutionId: null,
          responseTurnId: null,
          responseContent: null,
          responseTimestamp: null,
          subagentSessionId: matchedSessionId,
          subagentType,
          subagentName,
          status,
          subagentTokens: 0,
          subagentLatencyMs: 0,
        });
      }
    } else {
      const dispatchTimeMs = dispatchTimestamp
        ? new Date(dispatchTimestamp).getTime()
        : 0;
      const nowMs = Date.now();
      const elapsed = nowMs - dispatchTimeMs;

      let status: string;
      if (elapsed > TIMEOUT_THRESHOLD_MS) {
        status = 'timeout';
      } else {
        status = 'dispatched';
      }

      bridges.push({
        id: generateId(),
        sessionId,
        dispatchExecutionId: rootExecutionId,
        dispatchTurnId: dispatchTc.turnId,
        dispatchToolCallId: dispatchTc.id,
        dispatchContent,
        dispatchTimestamp,
        responseExecutionId: null,
        responseTurnId: null,
        responseContent: null,
        responseTimestamp: null,
        subagentSessionId: null,
        subagentType,
        subagentName,
        status,
        subagentTokens: 0,
        subagentLatencyMs: 0,
      });
    }
  }

  return bridges;
}
