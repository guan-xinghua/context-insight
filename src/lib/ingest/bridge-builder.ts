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

interface TaskArgs {
  subagent_session_id?: string;
  subagent_name?: string;
  subagent_type?: string;
  summary?: string;
  description?: string;
  prompt?: string;
}

// spawn_agent items 参数内首个任务文本（0.162 形态）：items 是纯文本项
// 数组 [{type:'text', text}]（真机 dumpC 四个子代理一致）；防御性兼容
// message 项形态 {type:'message', content:[…]}。与 cpx codex-emitter 的
// spawnTaskOf 同源结论（两包不互相 import，双形态语义对齐）。
function firstTextOfSpawnItems(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const item of items as Array<Record<string, unknown>>) {
    let text = '';
    if (typeof item.text === 'string') {
      text = item.text;
    } else if (Array.isArray(item.content)) {
      text = (item.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
    }
    if (text) return text;
  }
  return null;
}

function parseTaskArgs(argsJson: string | null, toolName?: string): TaskArgs {
  if (!argsJson) return {};
  try {
    const args = JSON.parse(argsJson);
    if (toolName === 'Agent') {
      return {
        subagent_session_id: args.subagent_session_id ?? null,
        subagent_name: args.name ?? args.subagent_name ?? null,
        subagent_type: args.subagent_type ?? args.mode ?? null,
        summary: args.description ?? null,
        description: args.description ?? null,
        prompt: args.prompt ?? null,
      };
    }
    if (toolName === 'spawn_agent') {
      // codex 任务文本 wire 双形态（真机 0.161/0.162 核实）：0.161 message
      // 直传；0.162 模型从工具错误中学习后只传 fork_context+items（items 内
      // 纯文本项）。只认 message 会让 0.162 成功派发的桥 dispatchContent
      // 恒空——内容锚定失效，退化为时间邻近匹配（真机曾把失败重试误锚到
      // 无关子代理）。
      return {
        prompt: args.message ?? firstTextOfSpawnItems(args.items) ?? args.prompt ?? args.task ?? null,
      };
    }
    return args;
  } catch {
    return {};
  }
}

function extractSubagentSessionIdFromResult(resultJson: string | null): string | null {
  if (!resultJson) return null;
  const match = resultJson.match(/task_id:\s*(\S+)/);
  return match ? match[1] : null;
}

// codex spawn_agent 的输出是干净 JSON：{"agent_id":"<子会话 id>","nickname":"..."}
// （与 claude Task 的 task_id: 文本协议不同，JSON 直解比 regex 精确）
function extractSpawnAgentResult(resultJson: string | null): { sessionId: string | null; nickname: string | null } {
  if (!resultJson) return { sessionId: null, nickname: null };
  try {
    const parsed = JSON.parse(resultJson) as { agent_id?: string; nickname?: string };
    return { sessionId: parsed.agent_id ?? null, nickname: parsed.nickname ?? null };
  } catch {
    return { sessionId: null, nickname: null };
  }
}

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

  // 派发工具：claude Task（jsonl 原生 task / proxy Agent）+ codex spawn_agent
  const dispatchToolCalls = toolCalls.filter(tc => tc.toolName === 'task' || tc.toolName === 'Agent' || tc.toolName === 'spawn_agent');

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

  for (const dispatchTc of dispatchToolCalls) {
    const args = parseTaskArgs(dispatchTc.argsJson, dispatchTc.toolName);
    let matchedSessionId: string | null = args.subagent_session_id ?? null;

    // For Agent tool calls, use the meta.json toolUseId mapping for precise matching
    if (!matchedSessionId && dispatchTc.toolName === 'Agent' && toolUseIdToSubagentSessionId) {
      matchedSessionId = toolUseIdToSubagentSessionId.get(dispatchTc.toolCallId) ?? null;
    }

    // codex spawn_agent：从输出 JSON 精确取 agent_id，nickname 一并带出
    let resultNickname: string | null = null;
    if (!matchedSessionId && dispatchTc.toolName === 'spawn_agent') {
      const spawned = extractSpawnAgentResult(dispatchTc.resultJson);
      matchedSessionId = spawned.sessionId;
      resultNickname = spawned.nickname;
    }

    if (!matchedSessionId) {
      matchedSessionId = extractSubagentSessionIdFromResult(dispatchTc.resultJson);
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

    const dispatchContent = args.summary ?? args.description ?? args.prompt ?? null;
    const dispatchTimestamp = dispatchTc.startedAt ?? null;

    const subagentName = args.subagent_name ?? resultNickname ?? null;
    const subagentType = args.subagent_type ?? null;

    if (matchedSessionId) {
      usedSessionIds.add(matchedSessionId);

      const subTurns = subagentTurnMap.get(matchedSessionId) ?? [];

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
