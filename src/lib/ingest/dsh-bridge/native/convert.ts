// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { RawInteraction, TokenUsage, ToolCallInfo } from '@/lib/shared/types';
import type { DshEvent, DshSessionHeader } from '../core/types';

// ── DSH 事件 → RawInteraction 转换（原生导入 P0-2）────────────────────
// 输入：core 的 decodeDshLog 解出来的事件数组（本文件不读文件）。
// 输出：与 claude-jsonl / codex-jsonl 适配器一样的 RawInteraction 列表，
//       下游 normalize → turn-split → bridge 不用区分来源。
//
// 逐条处理规则（来自真机 169 个会话的实测）：
//   1. user/message(source.kind='user') 和 agent-message（父代理转发给子会话
//      的消息，也就是子会话的提问）→ role 'user'
//   2. user/message(source.kind='subagent-settled')：后台子代理结束的通知 →
//      用 source.summary 作为 role 'system' 的一条记录
//   3. 其余 kind 的 user/message（runtime-context / skill-catalog /
//      agent-instructions / tool-jobs）和 system/message（系统提示词）是框架
//      固定写进上下文的内容，丢弃
//   4. agent/inbox/spliced：消息先进内存队列，随后同一条会以 user/message
//      再出现一次，丢弃以免重复计数
//   5. tool/call 和 assistant/message 里的 tool-call 是同一件事记了两遍，
//      丢弃 tool/call；tool/result 比 assistant/message 晚到，按 callId 填回
//   6. 派发工具的原生名 'subagent' 改成 'Agent'，供 bridge-builder /
//      turn-split 识别
//   7. 一个 turn 里有多个 step（每个 step = 一次模型调用）：assistant 记录的
//      耗时 = step/start → assistant/message（只算模型，不含工具执行）；
//      turn/end 的 reason.kind 转成 finish_reason，写到该 turn 最后一条
//      assistant 记录上

export interface ConvertDshSessionResult {
  interactions: RawInteraction[];
  /** 记录内容上的小问题，不影响导入继续。 */
  warnings: string[];
}

// 算作「会话输入」的 user/message source.kind：真人输入 + 父代理转发。
// 导出给 source.ts 的列举层复用（两处判断必须一致）。
export const USER_KINDS = new Set(['user', 'agent-message']);
// 后台子代理结束的通知，转成一条 system 记录。
const SETTLE_KIND = 'subagent-settled';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/** 把内容块数组里的 text 拼成一段文字（user / system / 工具结果都是这种结构）。
 *  导出给 source.ts 的列举层复用（firstQuery 与时间线必须用同一套取文逻辑）。 */
export function blocksToText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function baseInteraction(role: string, content: string | null, created: number): RawInteraction {
  return {
    role,
    content,
    timestamp: toTimestamp(created),
    timeInfo: { created },
    agent: null,
    subagent_name: null,
    subagent_session_id: null,
    subagent_type: null,
    tool_calls: null,
    usage: null,
    model: null,
    modelID: null,
    providerID: null,
    latency: null,
    finish_reason: null,
  };
}

function mapUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const input = asNumber(value.inputTokens);
  const output = asNumber(value.outputTokens);
  const cacheRead = asNumber(value.cacheReadTokens);
  const cacheWrite = asNumber(value.cacheWriteTokens);
  const total = asNumber(value.totalTokens);
  if (input == null && output == null && total == null) return null;
  return {
    total: total ?? (input ?? 0) + (output ?? 0),
    input: input ?? 0,
    output: output ?? 0,
    // DSH 不单独给 reasoning token（已经算进 output/total），这里固定写 0，不猜
    reasoning: 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    cost: 0,
    inputMessagesTokens: total ?? ((input ?? 0) + (output ?? 0)),
  };
}

/** 把 turn/end 的 reason.kind 换成 claude 体系里的写法；只认已知值，
 *  认不出的一律返回 null，不猜（评审 fix 0108af2）。 */
function mapStopReason(kind: string | null): string | null {
  if (!kind) return null;
  switch (kind) {
    case 'completed':
    case 'complete':
      return 'end_turn';
    case 'tool_calls':
    case 'tool_call':
    case 'tool_use':
      return 'tool_use';
    case 'length':
    case 'max_tokens':
      return 'max_tokens';
    case 'cancelled':
    case 'canceled':
    case 'aborted':
    case 'interrupted':
      return 'stop_sequence';
    default:
      return null;
  }
}

interface MappedAssistantContent {
  content: string | null;
  toolCalls: ToolCallInfo[];
}

/** 把 assistant/message.message.content 拆成正文 + 工具调用。
 *  reasoning 块包成 <thinking>…</thinking>（和 claude/codex 适配器一样）；
 *  tool-call 的参数原样保留，不解析、不改写。 */
function mapAssistantContent(value: unknown): MappedAssistantContent {
  if (!Array.isArray(value)) return { content: null, toolCalls: [] };
  const parts: string[] = [];
  const toolCalls: ToolCallInfo[] = [];
  for (const block of value) {
    if (!isRecord(block)) continue;
    if (block.type === 'reasoning') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text) parts.push(`<thinking>${text}</thinking>`);
      continue;
    }
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text) parts.push(text);
      continue;
    }
    if (block.type === 'tool-call') {
      const rawName = typeof block.name === 'string' ? block.name : '';
      toolCalls.push({
        toolCallId: typeof block.id === 'string' ? block.id : '',
        // 派发工具改名：DSH 原生的 'subagent' → 'Agent'（bridge-builder /
        // turn-split 靠这个名字认出子代理派发）
        toolName: rawName === 'subagent' ? 'Agent' : rawName,
        argsJson: typeof block.arguments === 'string' ? block.arguments : null,
        resultJson: null,
        state: 'completed',
      });
      continue;
    }
    // 没见过的块类型直接跳过（向前兼容新版本）
  }
  return { content: parts.length > 0 ? parts.join('\n') : null, toolCalls };
}

function stepKey(turn: number | null, step: number | null): string | null {
  return turn != null && step != null ? `${turn}:${step}` : null;
}

/** DSH 事件数组 → 记录数组（只处理主会话；子代理的标记由 source 层加上）。 */
export function convertDshSession(
  _header: DshSessionHeader,
  events: DshEvent[],
): ConvertDshSessionResult {
  const interactions: RawInteraction[] = [];
  const warnings: string[] = [];

  // (turn:step) → step/start 的时间，assistant 记录用它算耗时
  const stepStart = new Map<string, number>();
  // callId → 对应的工具调用；tool/result 晚到，按它填回结果
  const callsById = new Map<string, ToolCallInfo>();
  // turn → 该轮最后一条 assistant 记录，turn/end 的结束原因写在它上面
  const lastAssistantByTurn = new Map<number, RawInteraction>();

  const provider: { value: string | null } = { value: null };
  const model: { value: string | null } = { value: null };

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    const eventTime = asNumber(event.time);

    // 按「对输出做什么」把事件分三类，顺序如下；不在这三类里的一律丢弃。
    // switch 的分支先后不影响结果（每个事件只命中一个分支），这样排只是让
    // 从上往下读更顺：先看产生记录的，再看补记录的，最后看只记状态的。
    switch (event.type) {
      // ── 一、产生一条记录 ──────────────────────────────────────────
      // 真人输入，以及父代理转发给子会话的消息（等于子会话的提问）→ user 记录
      case 'user/message': {
        const source = isRecord(data.source) ? data.source : {};
        const kind = typeof source.kind === 'string' ? source.kind : null;
        const text = blocksToText(data.content);
        if (kind != null && USER_KINDS.has(kind)) {
          // 内容里可能没有文本（例如只有图片）：这仍是一条用户输入，保留下来
          // （内容留空），否则整轮消失、后面的轮次跟着错位；同时记一条警告。
          // event.time 由 core 解码保证存在（缺 time 的行在解码期已丢弃），这里兜底取 0。
          if (text == null) warnings.push('user/message 没有文本内容（可能为非文本输入），已保留空轮次');
          interactions.push(baseInteraction('user', text, eventTime ?? 0));
        } else if (kind === SETTLE_KIND) {
          // 后台子代理结束的通知 → 用 summary 作为一条 system 记录
          const summary = typeof source.summary === 'string' ? source.summary : null;
          const content = summary ?? text;
          if (content == null) warnings.push('subagent-settled 通知没有摘要，已跳过');
          else interactions.push(baseInteraction('system', content, eventTime ?? 0));
        }
        // 其余 kind（runtime-context / skill-catalog / agent-instructions /
        // tool-jobs 等）是框架固定写进上下文的内容，不进时间线
        break;
      }
      // 模型回复 → assistant 记录；thinking 正文、工具调用、token 用量都在这
      case 'assistant/message': {
        const turn = asNumber(data.turn);
        const step = asNumber(data.step);
        const message = isRecord(data.message) ? data.message : {};
        const mapped = mapAssistantContent(message.content);
        const key = stepKey(turn, step);
        const created = (key != null ? stepStart.get(key) : undefined) ?? eventTime ?? 0;
        const completed = eventTime ?? created;
        const interaction: RawInteraction = {
          role: 'assistant',
          content: mapped.content,
          timestamp: toTimestamp(created),
          timeInfo: { created, completed },
          agent: null,
          subagent_name: null,
          subagent_session_id: null,
          subagent_type: null,
          tool_calls: mapped.toolCalls.length > 0 ? mapped.toolCalls : null,
          usage: mapUsage(data.usage),
          model: model.value,
          modelID: null,
          providerID: provider.value,
          latency: completed > created ? completed - created : null,
          finish_reason: null,
        };
        interactions.push(interaction);
        for (const tc of mapped.toolCalls) {
          if (tc.toolCallId) callsById.set(tc.toolCallId, tc);
        }
        if (turn != null) lastAssistantByTurn.set(turn, interaction);
        break;
      }
      // ── 二、补充已有记录，不新增 ──────────────────────────────────
      // 工具结果比模型回复晚到，按 callId 填回那条 assistant 记录里的工具调用
      case 'tool/result': {
        const message = isRecord(data.message) ? data.message : {};
        const source = isRecord(message.source) ? message.source : {};
        const callId = typeof message.toolCallId === 'string'
          ? message.toolCallId
          : typeof source.callId === 'string'
            ? source.callId
            : null;
        if (!callId) break;
        const tc = callsById.get(callId);
        if (!tc) {
          // 没有对应的工具调用（被裁剪或前文缺失）：原文还在盘上，跳过不编造
          warnings.push(`tool/result 无对应调用：${callId}`);
          break;
        }
        const text = blocksToText(message.content) ?? '';
        const isError = message.isError === true;
        // 错误结果加 <tool_use_error> 前缀：insight 的 extractErrorMessage 据此
        // 认出这是错误并写进 errorMessage（与 claude 适配器一致）
        tc.resultJson = isError ? `<tool_use_error>${text}` : text;
        tc.state = isError ? 'error' : 'completed';
        break;
      }
      // 一轮结束，把结束原因写到这一轮最后一条 assistant 记录上
      case 'turn/end': {
        const turn = asNumber(data.turn);
        const reason = isRecord(data.reason) ? data.reason : {};
        const kind = typeof reason.kind === 'string' ? reason.kind : null;
        const finishReason = mapStopReason(kind);
        if (turn != null && finishReason != null) {
          const target = lastAssistantByTurn.get(turn);
          if (target) target.finish_reason = finishReason;
        }
        break;
      }
      // ── 三、只记状态，供上面的事件使用，本身不产生记录 ────────────
      // 记下一次模型调用的开始时间，assistant 记录用它算耗时
      case 'step/start': {
        const key = stepKey(asNumber(data.turn), asNumber(data.step));
        if (key && eventTime != null) stepStart.set(key, eventTime);
        break;
      }
      // 从请求头里记下 model / provider（先给一个初值）
      case 'request/header': {
        const header = isRecord(data.header) ? data.header : data;
        const config = isRecord(header.config) ? header.config : {};
        if (model.value == null && typeof config.model === 'string') model.value = config.model;
        if (provider.value == null && typeof config.provider === 'string') provider.value = config.provider;
        break;
      }
      // 稍后到达，用会话上下文里的 model / provider 覆盖上面的初值
      case 'request/context': {
        if (typeof data.provider === 'string') provider.value = data.provider;
        if (typeof data.model === 'string') model.value = data.model;
        break;
      }
      // ── 四、其余事件一律丢弃 ─────────────────────────────────────
      default:
        // step/end、tool/call（与 assistant/message 重复）、subagent/*、
        // session/title、session/end-seed、workspace/changes、todo/write、
        // approval/*、permission/*、sandbox/mode、command/*、
        // session-log-*/delivery-accepted、assistant/attempt、web/*、
        // developer/message、system/message、turn/start 等都不进时间线
        break;
    }
  }

  return { interactions, warnings };
}
