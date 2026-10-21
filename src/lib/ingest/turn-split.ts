// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { RawInteraction } from '../shared/types';
import { truncateUtf16Safe } from '../shared/text-strip';
import { getContextWindowLimit } from '@/lib/context-window-config';
import { isContinuationTurn, parseSlashCommandTurn } from '@/lib/shared/command-parser';

export interface TurnRow {
  id: string;
  sessionId: string;
  turnIndex: number;
  role: string;
  content: string | null;
  contentJson: string | null;
  contentSummary: string | null;
  inputMessagesJson: string | null;
  inputMessagesCount: number;
  inputMessagesTokens: number;
  contextWindowPct: number | null;
  agentName: string | null;
  subagentName: string | null;
  subagentSessionId: string | null;
  subagentType: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  createdAt_ts: string | null;
  completedAt: string | null;
  latencyMs: number;
  ttftMs: number | null;
  model: string | null;
  modelId: string | null;
  providerId: string | null;
  temperature: number | null;
  maxTokens: number | null;
  finishReason: string | null;
  isSubagent: boolean;
  parentExecutionId: string | null;
}

export interface ToolCallRow {
  id: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  state: string;
  errorType: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  dispatchBridgeId: string | null;
  isSkillRelated: boolean;
}

export interface SkillEventRow {
  id: string;
  turnId: string;
  skillName: string;
  skillVersion: number | null;
  eventType: string;
  success: boolean;
  errorMessage: string | null;
  argsJson: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
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

function truncateTo200(text: string | null): string | null {
  if (!text) return null;
  if (text.length <= 200) return text;
  return truncateUtf16Safe(text, 200);
}

import { stripThinkingAndReminder } from '../shared/text-strip';
import { isSkillToolCall, skillEventTypeOf, extractSkillName, extractSkillVersion, isSkillInjectionText } from '../tool-conventions';

/** 斜杠命令技能调用（claude-code `/skill` 展开形态）：用户轮内嵌
 * <command-name>/<skill> 标签、紧随 skill 注入 system 轮（"Base directory
 * for this skill: …"）——该通道无工具调用，SkillEvent 计数唯一入口在此。
 * 内置本地命令（/clear /skills 等）无注入跟随，不会误触发；Skill 工具通道
 * 的注入已被 adapter skill-merge 折进 tool_result（system 轮被移除），双通道不重复计数。 */
function slashSkillInvocation(
  interactions: RawInteraction[], i: number
): { name: string; args: string } | null {
  const cur = interactions[i];
  if (cur.role !== 'user' || cur.subagent_session_id) return null;
  const cmd = parseSlashCommandTurn(cur.content ?? '');
  if (!cmd) return null;
  for (let j = i + 1; j <= i + 2 && j < interactions.length; j++) {
    const nx = interactions[j];
    if (nx.role === 'assistant' || nx.role === 'user') break;
    const c = nx.content ?? '';
    if (nx.role === 'system' && isSkillInjectionText(c)) {
      const byDir = c.match(/\/skills\/([^/\s<]+)/);
      return { name: cmd.name || (byDir?.[1] ?? 'unknown'), args: cmd.args };
    }
  }
  return null;
}

function isAgentSkillDispatch(toolName: string, argsJson: string | null): boolean {
  const lower = toolName.toLowerCase();
  if (lower !== 'agent' && lower !== 'task' && lower !== 'subagent') return false;
  if (!argsJson) return false;
  try {
    const args = JSON.parse(argsJson);
    const strArg = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = args[k];
        if (typeof v === 'string' && v) return v;
      }
      return null;
    };
    const subagentType = strArg('subagent_type', 'subagent_name', 'agent');
    if (!subagentType) {
      // opencode 新版工作流派发：subagent_type 是 'general' 或缺失，角色写
      // 在 prompt 首句（"你在此任务中扮演 …中的 \"<role>\" agent"）——仍算
      // dispatch（角色可从 prompt 提取），不因 generic type 整个丢弃。
      return /扮演|agent/i.test(String(args.prompt ?? ''));
    }
    // Exclude generic agent types (not skill-driven) — but they fall through
    // to the prompt-role extraction below via extractDispatchSkillName.
    if (subagentType === 'general-purpose' || subagentType === 'general') {
      return /扮演|agent/i.test(String(args.prompt ?? ''));
    }
    return true;
  } catch { return false }
}

/** 从 task/agent 派发 args 提取角色名：subagent_type 优先；generic/缺失时从
 *  prompt 首句提取（"你在此任务中扮演 X 中的 \"<role>\" agent" / "You will
 *  act as the <role> agent" 形态）。 */
function extractDispatchSkillName(argsJson: string | null): string {
  if (!argsJson) return 'unknown-dispatch';
  try {
    const args = JSON.parse(argsJson);
    const subagentType = [args.subagent_type, args.subagent_name, args.agent]
      .find((v): v is string => typeof v === 'string' && Boolean(v)) ?? null;
    if (subagentType && subagentType !== 'general-purpose' && subagentType !== 'general') return subagentType;
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    // 中文形态：扮演 …工作流中的 "developer" agent / `developer` agent
    let m = prompt.match(/扮演[^。\n]*?["'`]([A-Za-z][\w.-]*)["'`]\s*(?:agent|子代理)/);
    if (m) return m[1];
    // 英文形态：act as the "developer" agent / act as the developer agent
    m = prompt.match(/act as (?:the )?["'`]?([A-Za-z][\w.-]*)["'`]?\s*(?:sub)?agent/i);
    if (m) return m[1];
    if (args.description) return truncateUtf16Safe(String(args.description), 40);
  } catch { /* ignore */ }
  return 'unknown-dispatch';
}

export function extractErrorMessage(resultJson: string | null): string | null {
  if (!resultJson) return null;
  if (resultJson.includes('<tool_use_error>')) return truncateTo200(resultJson);
  if (resultJson.includes('Exit code')) return truncateTo200('Command failed: ' + resultJson);
  return null;
}

function classifyError(state: string, errorMessage: string | null): string | null {
  if (state === 'ok' || state === 'completed') {
    return errorMessage ? 'tool_error' : null;
  }
  if (!errorMessage) return 'unknown';
  const msg = errorMessage.toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('permission') || msg.includes('denied') || msg.includes('forbidden')) return 'permission';
  if (msg.includes('format') || msg.includes('invalid') || msg.includes('parse')) return 'format';
  return 'server_error';
}

export function splitIntoTurns(
  interactions: RawInteraction[],
  sessionId: string,
  _parentSessionId?: string
): { turns: TurnRow[], toolCalls: ToolCallRow[], skillEvents: SkillEventRow[] } {
  void _parentSessionId;
  const turns: TurnRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const skillEvents: SkillEventRow[] = [];
  let prevInputMessagesTokens = 0;
  let prevContextKey = '';
  // Loop index of the most recent /compact continuation turn in the current
  // execution context. A continuation replaces the conversation history with a
  // summary, so the next assistant turn's prompt legitimately shrinks and its
  // input-message count must restart from the summary, not accumulate all
  // pre-compact turns.
  let prevCompactBoundaryIdx = -1;

  for (let i = 0; i < interactions.length; i++) {
    const interaction = interactions[i];
    const turnId = generateId();
    const turnIndex = i;

    const role = interaction.role === 'subagent' ? 'assistant' : interaction.role;

    const content = interaction.content;
    // 摘要剥掉 <thinking> 块与 user turn 里的 <system-reminder> 前缀块（全文
    // 保留在 content，wire 保真）—— thinking 会吃掉 200 字符摘要预算，时间线
    // 预览全是思考过程、正文不可见，被误读为 output 未展示
    const contentSummary = truncateTo200(stripThinkingAndReminder(content));

    const usage = interaction.usage;
    const totalTokens = usage?.total ?? 0;
    const inputTokens = usage?.input ?? 0;
    const outputTokens = usage?.output ?? 0;
    const reasoningTokens = usage?.reasoning ?? 0;
    const cacheReadTokens = usage?.cacheRead ?? 0;
    const cacheWriteTokens = usage?.cacheWrite ?? 0;
    const cost = usage?.cost ?? 0;

    const timeInfo = interaction.timeInfo;
    const createdAt_ts = timeInfo
      ? new Date(timeInfo.created).toISOString()
      : new Date(interaction.timestamp).toISOString();
    const completedAt = timeInfo?.completed
      ? new Date(timeInfo.completed).toISOString()
      : null;
    // 显式 latency 优先（adapter 的权威时长声明：proxy duration_ms / native
    // 请求边界推导），行跨度（completed−created）仅作无声明时的兜底
    const latencyMs = interaction.latency != null
      ? interaction.latency
      : (timeInfo?.completed && timeInfo?.created ? timeInfo.completed - timeInfo.created : 0);

    const agentName = interaction.agent ?? interaction.subagent_name ?? null;
    const subagentName = interaction.subagent_name ?? null;
    const subagentSessionId = interaction.subagent_session_id ?? null;
    const subagentType = interaction.subagent_type ?? null;
    const isSubagent = !!interaction.subagent_session_id;

    const model = interaction.model ?? null;
    const modelId = interaction.modelID ?? null;
    const providerId = interaction.providerID ?? null;
    const finishReason = interaction.finish_reason ?? null;

    let inputMessagesJson: string | null = null;
    let inputMessagesCount = 0;
    let inputMessagesTokens = 0;
    let contextWindowPct: number | null = null;

    if (role === 'assistant') {
      inputMessagesJson = null;
      let count = 0;
      const mySubagentSessionId = interaction.subagent_session_id ?? null;
      const isCompactionSummary = interaction.agent === 'compaction';
      const startJ = isCompactionSummary ? 0 : (prevCompactBoundaryIdx >= 0 ? prevCompactBoundaryIdx : 0);
      for (let j = startJ; j < i; j++) {
        const prev = interactions[j];
        const prevRole = prev.role === 'subagent' ? 'assistant' : prev.role;
        if (prev.agent === 'compaction-boundary') continue;
        // For subagent turns, only count prior turns in the same subagent session
        // For root turns, count all prior root turns (skip subagent turns)
        if (mySubagentSessionId) {
          if (prev.subagent_session_id === mySubagentSessionId &&
              (prevRole === 'user' || prevRole === 'assistant' || prevRole === 'system')) count++;
        } else {
          if (!prev.subagent_session_id &&
              (prevRole === 'user' || prevRole === 'assistant' || prevRole === 'system')) count++;
        }
      }
      inputMessagesCount = count;

      const adapterInputMessagesTokens = usage?.inputMessagesTokens ?? 0;
      if (isCompactionSummary && inputTokens > 0) {
        inputMessagesTokens = inputTokens;
      } else {
        inputMessagesTokens = totalTokens > 0 ? totalTokens : adapterInputMessagesTokens;
      }

      // Monotonic floor: within a compact segment the context should not
      // decrease (smooths cache-read noise / reporting dips). The floor resets
      // to 0 at each /compact boundary (set when a continuation turn is seen),
      // so the legitimate post-compact drop passes through. This handles a
      // session with multiple compactions: each continuation starts a fresh
      // growing segment.
      const contextKey = isSubagent ? (subagentSessionId ?? 'sub') : 'root';
      if (contextKey !== prevContextKey) {
        prevInputMessagesTokens = 0;
        prevCompactBoundaryIdx = -1;
        prevContextKey = contextKey;
      }
      if (inputMessagesTokens > 0 && inputMessagesTokens < prevInputMessagesTokens) {
        inputMessagesTokens = prevInputMessagesTokens;
      }
      prevInputMessagesTokens = Math.max(prevInputMessagesTokens, inputMessagesTokens);

      const contextWindowLimit = getContextWindowLimit(model);
      contextWindowPct = inputMessagesTokens > 0
        ? (inputMessagesTokens / contextWindowLimit) * 100
        : null;
    }

    // A continuation turn ("This session is being continued...") is the boundary
    // produced by /compact: the conversation history is replaced by the summary
    // that follows. Mark it so the next assistant turn in this context resets
    // its monotonic floor and input-message count.
    // Also detect opencode's compaction-boundary (agent field) — same effect.
    const isCompactBoundary = (interaction.agent === 'compaction-boundary') ||
      (role === 'user' && !isSubagent && content && isContinuationTurn(content));
    if (isCompactBoundary && !isSubagent) {
      prevInputMessagesTokens = 0;
      prevCompactBoundaryIdx = i;
    }

    const turn: TurnRow = {
      id: turnId,
      sessionId,
      turnIndex,
      role,
      content,
      contentJson: null,
      contentSummary,
      inputMessagesJson,
      inputMessagesCount,
      inputMessagesTokens,
      contextWindowPct,
      agentName,
      subagentName,
      subagentSessionId,
      subagentType,
      totalTokens,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      createdAt_ts,
      completedAt,
      latencyMs,
      ttftMs: null,
      model,
      modelId,
      providerId,
      temperature: null,
      maxTokens: null,
      finishReason,
      isSubagent,
      parentExecutionId: null,
    };

    turns.push(turn);

    const slashSkill = slashSkillInvocation(interactions, i);
    if (slashSkill) {
      skillEvents.push({
        id: generateId(),
        turnId,
        skillName: slashSkill.name,
        skillVersion: null,
        eventType: 'invoke',
        success: true,
        errorMessage: null,
        argsJson: slashSkill.args ? JSON.stringify({ args: slashSkill.args }) : null,
        startedAt: createdAt_ts,
        completedAt: createdAt_ts,
        durationMs: 0,
      });
    }

    if (interaction.tool_calls) {
      for (const tc of interaction.tool_calls) {
        const toolCallRowId = generateId();
        const isSkillRelated = isSkillToolCall(tc.toolName) || isAgentSkillDispatch(tc.toolName, tc.argsJson);
        const errMsg = extractErrorMessage(tc.resultJson);

        // 工具起止：源携带真实时间戳（ToolCallInfo.startedAt/completedAt，claude-jsonl
        // 与 opencode v1 填充）→ 落真实值 + durationMs；源没有（如 opencode v2 / 旧
        // 导出件）→ 降级为既有行为（复制所属轮时间、durationMs=0），路径不劣化
        const tcStartIso = tc.startedAt != null ? new Date(tc.startedAt).toISOString() : createdAt_ts;
        const tcEndIso = tc.completedAt != null ? new Date(tc.completedAt).toISOString() : (completedAt ?? createdAt_ts);
        const toolCallRow: ToolCallRow = {
          id: toolCallRowId,
          turnId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          argsJson: tc.argsJson,
          resultJson: tc.resultJson,
          state: tc.state,
          errorType: classifyError(tc.state, errMsg),
          errorMessage: errMsg,
          startedAt: tcStartIso,
          completedAt: tcEndIso,
          durationMs: tc.startedAt != null && tc.completedAt != null
            ? Math.max(0, tc.completedAt - tc.startedAt)
            : 0,
          dispatchBridgeId: null,
          isSkillRelated,
        };

        toolCalls.push(toolCallRow);

        if (isSkillRelated) {
          const skillEventRowId = generateId();
          const isDispatch = isAgentSkillDispatch(tc.toolName, tc.argsJson);
          const eventType = isDispatch ? 'dispatch' : skillEventTypeOf(tc.toolName);
          const skillName = isDispatch ? extractDispatchSkillName(tc.argsJson) : extractSkillName(tc.toolName, tc.argsJson);
          const skillVersion = isDispatch ? null : extractSkillVersion(tc.argsJson);
          const success = (tc.state === 'ok' || tc.state === 'completed') && !errMsg;

          const skillEventRow: SkillEventRow = {
            id: skillEventRowId,
            turnId,
            skillName,
            skillVersion,
            eventType,
            success,
            errorMessage: success ? null : (errMsg || tc.state),
            argsJson: tc.argsJson,
            startedAt: createdAt_ts,
            completedAt: completedAt ?? createdAt_ts,
            durationMs: 0,
          };

          skillEvents.push(skillEventRow);
        }
      }
    }
  }

  return { turns, toolCalls, skillEvents };
}
