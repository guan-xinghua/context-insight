// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import { truncateUtf16Safe } from '@/lib/shared/text-strip';
import path from 'node:path';
import { readCaptureBuffer, readCaptureHead } from '@/lib/compression';
import type { SessionListItem, RawInteraction, ToolCallInfo, TokenUsage } from '../../shared/types';
import { classifyCodexUserInjection } from './injections/codex';
import { isRolloutFileName, rolloutSessionIdOf } from './codex-naming';
import {
  codexStreamSessionIdOf,
  codexChunkExitCodeOf,
  writeStdinSessionIdOf,
  writeStdinCharsOf,
  stripExecOutputHeader,
} from '../../tool-conventions';

// ── codex 原生会话适配器（agent-source-framework 首个新框架客户）──────
// 数据源：~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl（codex CLI
// rollout 文件，明文追加式）。行信封为 {timestamp, ordinal, type, payload}，
// type ∈ session_meta / turn_context / response_item / event_msg /
// token_usage_record / world_state。
//
// 内容真身是 response_item（OpenAI Responses API 项）；event_msg 是 UI 线程
// 视图（item_completed/token_count 与 response_item 重复），只取 task_started
// 做轮次计数，内容不读（双读会双计 token/轮次，D10）。
//
// 行交错规律（状态机依据，真机实测 codex 0.161）：
//   message(assistant) → function_call* → token_usage_record → function_call_output*
// 即：一次 API 响应 = 一组 items，由其 token_usage_record 冲刷成一条 assistant
// turn；工具输出在 usage 之后到达，经全局 call_id 索引回填（时序天然解耦）。
//
// 多 agent：子代理是独立 rollout 文件，session_meta 自带 parent_thread_id /
// thread_source:"subagent" / agent_nickname；主文件的 spawn_agent 输出携带
// {"agent_id","nickname"}。发现只依赖 rollout 自身，不读 state_5.sqlite（D3，
// state 库是 codex 内部投影，rollout 是公开产物）。

interface CodexRolloutLine {
  timestamp?: string;
  ordinal?: number;
  type: string;
  payload?: Record<string, unknown>;
}

interface CodexContentPart {
  type?: string;
  text?: string;
}

interface CodexMessagePayload {
  role?: string;
  phase?: string;
  content?: CodexContentPart[];
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface SessionMetaInfo {
  id: string | null;
  parentThreadId: string | null;
  threadSource: string | null;
  agentNickname: string | null;
  cliVersion: string | null;
  timestamp: string | null;
}

const EMPTY_META: SessionMetaInfo = {
  id: null, parentThreadId: null, threadSource: null,
  agentNickname: null, cliVersion: null, timestamp: null,
};

// 内容级识别（SourceDescriptor.detectContent 能力）：rollout 恒明文（无压缩
// 形态），直读文件；首 N 条有效 JSON 行中任一命中 rollout 信封
// {timestamp, ordinal, type, payload} 即认领（首行恒为 ordinal=0 的
// session_meta，窗口扫描容忍前导坏行）。读不出/无有效行 → null。
const DETECT_SCAN_LINES = 10;

function isRolloutEnvelope(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as { timestamp?: unknown; ordinal?: unknown; type?: unknown; payload?: unknown };
  return typeof o.timestamp === 'string'
    && typeof o.ordinal === 'number'
    && typeof o.type === 'string'
    && o.payload != null && typeof o.payload === 'object';
}

export function detectContent(filePath: string): boolean | null {
  let buf: Buffer;
  try {
    buf = readCaptureHead(filePath);
  } catch {
    return null;
  }
  let valid = 0;
  let matched = false;
  let start = 0;
  const consider = (end: number): void => {
    const t = buf.toString('utf-8', start, end).trim();
    start = end + 1;
    if (!t) return;
    try {
      valid += 1;
      if (isRolloutEnvelope(JSON.parse(t))) matched = true;
    } catch {
      // 坏行/半写行（活文件尾行）跳过
    }
  };
  for (let i = 0; i < buf.length && !matched && valid < DETECT_SCAN_LINES; i++) {
    if (buf[i] === 0x0a) consider(i);
  }
  if (!matched && valid < DETECT_SCAN_LINES) consider(buf.length);
  if (matched) return true;
  return valid > 0 ? false : null;
}

// Buffer 逐行扫描（V8 单字符串上限防线，claude 侧 631MB wire 捕获先例）；
// 0x0a 不出现在 UTF-8 多字节序列内，按字节切片安全。单行 JSON 解析失败
// 跳过（内容级容错），读文件错误上抛。
function parseRolloutBuffer(buf: Buffer, filePathForWarn?: string): CodexRolloutLine[] {
  const result: CodexRolloutLine[] = [];
  let start = 0;
  let lineNo = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    const t = buf.toString('utf-8', start, end).trim();
    if (t) {
      try {
        result.push(JSON.parse(t) as CodexRolloutLine);
      } catch {
        // 半写行（活文件尾行）或损坏行：跳过不炸整个会话，但留痕（与
        // claude 侧同纪律）——否则排障只见「行数莫名变少」无迹可查
        console.warn(`codex-jsonl: skipping malformed JSON line in ${filePathForWarn ?? '<buffer>'}:${lineNo + 1}`);
      }
    }
    lineNo++;
    start = end + 1;
  };
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) flush(i);
  }
  flush(buf.length);
  return result;
}

export function parseRolloutLines(filePath: string): CodexRolloutLine[] {
  return parseRolloutBuffer(readCaptureBuffer(filePath), filePath);
}

function isCodexCandidateFileName(fileName: string): boolean {
  if (isRolloutFileName(fileName)) return true;
  const lower = fileName.toLowerCase();
  return lower.endsWith('.jsonl') || lower.endsWith('.jsonl.7z') || lower.endsWith('.jsonl.gz');
}

function sessionIdFromCodexFileName(fileName: string): string | null {
  const rolloutId = rolloutSessionIdOf(fileName);
  if (rolloutId) return rolloutId;
  const match = fileName.match(/^(.+?)\.native\.jsonl(?:\.7z|\.gz)?$/i);
  return match?.[1] ?? null;
}

function readSessionMeta(lines: CodexRolloutLine[]): SessionMetaInfo {
  for (const line of lines) {
    if (line.type === 'session_meta' && line.payload && typeof line.payload === 'object') {
      const p = line.payload as Record<string, unknown>;
      return {
        id: typeof p.id === 'string' ? p.id : null,
        parentThreadId: typeof p.parent_thread_id === 'string' ? p.parent_thread_id : null,
        threadSource: typeof p.thread_source === 'string' ? p.thread_source : null,
        agentNickname: typeof p.agent_nickname === 'string' ? p.agent_nickname : null,
        cliVersion: typeof p.cli_version === 'string' ? p.cli_version : null,
        timestamp: typeof p.timestamp === 'string' ? p.timestamp : null,
      };
    }
  }
  return EMPTY_META;
}

function extractMessageText(content: CodexContentPart[] | undefined): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c.text === 'string' && c.text) parts.push(c.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

// 注入分类指纹已抽到 injections/codex.ts（框架自持，agent-source-framework
// 原则 1）——原生 rollout 与 codex-proxy 捕获（claude 布局入口分发）共用
// 同一分类器，两条路径时间线一致。developer 消息的丢弃仍在本模块（role
// 级判定，非文本指纹）。

function mapUsage(u: CodexUsage | undefined): TokenUsage | null {
  if (!u) return null;
  // Responses usage 的 input_tokens 已包含 cached_input_tokens；
  // cache_write_input_tokens 是非缓存 input 的子集（上游 non_cached_input
  // 定义为 input-cached，cache write 不额外外挂）。output_tokens 则可能包含
  // reasoning_output_tokens。落库前拆成互不重叠的输入/输出桶，消费层才能
  // 继续用 input+cacheRead+cacheWrite、output+reasoning 求和而不重复计数。
  const inputMessagesTokens = u.input_tokens ?? 0;
  const cacheRead = Math.min(u.cached_input_tokens ?? 0, inputMessagesTokens);
  const cacheWrite = Math.min(u.cache_write_input_tokens ?? 0, inputMessagesTokens - cacheRead);
  const input = Math.max(0, inputMessagesTokens - cacheRead - cacheWrite);
  const rawOutput = u.output_tokens ?? 0;
  const reasoning = Math.min(u.reasoning_output_tokens ?? 0, rawOutput);
  const fromProviderTotal = u.total_tokens != null
    ? Math.max(0, u.total_tokens - inputMessagesTokens - reasoning)
    : null;
  const output = fromProviderTotal ?? Math.max(0, rawOutput - reasoning);
  const total = u.total_tokens ?? (inputMessagesTokens + output + reasoning);
  return {
    total,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    // 成本恒 0（D6）：codex 常配第三方 provider（volcano/deepseek/doubao/
    // qwen…），定价不可知，估算反而误导
    cost: 0,
    inputMessagesTokens,
  };
}

function toMillis(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ── readSession 状态机 ────────────────────────────────────────────────
// 一个未冲刷的响应组（message/reasoning/function_call/web_search_call）+
// 冲刷时机携带的 token_usage_record → 一条 assistant RawInteraction。
function readSessionFromLines(lines: CodexRolloutLine[]): RawInteraction[] {
  const result: RawInteraction[] = [];
  let currentModel: string | null = null;

  // 组内缓冲：usage 记录到达即冲刷
  let textParts: string[] = [];
  let thinkingParts: string[] = [];
  let toolCalls: ToolCallInfo[] = [];
  let groupFirstTs: number | null = null;
  let groupFirstTimestamp: string | null = null;

  // 全局 call_id → 工具调用索引：输出在组冲刷之后到达，跨组回填 resultJson
  const toolCallIndex = new Map<string, ToolCallInfo>();

  const resetGroup = (): void => {
    textParts = [];
    thinkingParts = [];
    toolCalls = [];
    groupFirstTs = null;
    groupFirstTimestamp = null;
  };

  const markGroupStart = (line: CodexRolloutLine): void => {
    const ms = toMillis(line.timestamp);
    if (groupFirstTs == null) {
      groupFirstTs = ms;
      groupFirstTimestamp = line.timestamp ?? null;
    }
  };

  const flushGroup = (usage: TokenUsage | null, usageTs: number | null): void => {
    const hasPayload = textParts.length > 0 || thinkingParts.length > 0 || toolCalls.length > 0;
    // 空组跳过；带 usage 信号的空组保留（截断可观测，claude 适配器同款先例）
    if (!hasPayload) {
      if (!(usage && ((usage.input ?? 0) > 0 || (usage.output ?? 0) > 0))) {
        resetGroup();
        return;
      }
    }

    const contentParts = [
      ...thinkingParts.map(t => `<thinking>${t}</thinking>`),
      ...textParts,
    ];
    const content = contentParts.length > 0 ? contentParts.join('\n') : null;

    const created = groupFirstTs ?? 0;
    const latency = usage != null && usageTs != null && groupFirstTs != null && usageTs >= groupFirstTs
      ? usageTs - groupFirstTs
      : null;

    // B 形技能加载检测（exec_command 读类命令 cat <skill>/SKILL.md）在
    // turn-split 单点进行——本适配器只产真实工具调用，不合成 skill/<name> 行
    const finalToolCalls = toolCalls.length > 0 ? toolCalls : null;

    result.push({
      role: 'assistant',
      content,
      timestamp: groupFirstTimestamp ?? new Date(created).toISOString(),
      timeInfo: { created, ...(usageTs != null ? { completed: usageTs } : {}) },
      agent: null,
      subagent_name: null,
      subagent_session_id: null,
      subagent_type: null,
      tool_calls: finalToolCalls,
      usage,
      model: currentModel,
      modelID: null,
      providerID: null, // D5：model_provider 是配置名非 wire 值，恒 null
      latency,
      finish_reason: null,
    });
    resetGroup();
  };

  const emitNonAssistantTurn = (
    role: 'user' | 'system',
    content: string,
    line: CodexRolloutLine,
  ): void => {
    const ms = toMillis(line.timestamp);
    result.push({
      role,
      content,
      timestamp: line.timestamp ?? new Date(ms ?? 0).toISOString(),
      timeInfo: { created: ms ?? 0 },
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
    });
  };

  for (const line of lines) {
    const payload = (line.payload ?? {}) as Record<string, unknown>;

    switch (line.type) {
      case 'turn_context': {
        // 轮边界：更新当前模型（assistant turns 的模型来源），冲刷残留组
        flushGroup(null, null);
        if (typeof payload.model === 'string' && payload.model) currentModel = payload.model;
        break;
      }
      case 'token_usage_record': {
        // 响应组冲刷信号：usage 挂到本组
        const usage = mapUsage(payload.usage as CodexUsage | undefined);
        flushGroup(usage, toMillis(line.timestamp));
        break;
      }
      case 'event_msg': {
        // task_started = 新用户轮（冲刷残留组）；其余 UI 事件不作为内容真身（D10）
        if (payload.type === 'task_started') flushGroup(null, null);
        break;
      }
      case 'world_state':
        break;
      case 'session_meta':
        break;
      case 'response_item': {
        const itemType = payload.type;
        if (itemType === 'message') {
          const msg = payload as unknown as CodexMessagePayload;
          const text = extractMessageText(msg.content);
          if (msg.role === 'assistant') {
            // 响应组内普通成员：reasoning 可在 message 之前（真机实测 9→11→12
            // 同组），组内成员顺序任意——组边界只有 usage 记录，不在此冲刷
            markGroupStart(line);
            if (text) textParts.push(text);
          } else if (msg.role === 'user') {
            const raw = text ?? '';
            // 契约分类器（injections/codex.ts）：drop（静态注入，D1 修订不进
            // 时间线）/ system-turn（事件注入，通知已摘要化——claude
            // task-notification 同款）/ null（真实输入）。两类注入都冲刷残留
            // 组（注入在轮边界）。
            const injection = classifyCodexUserInjection(raw, { isFirstTurn: result.length === 0 });
            if (injection) {
              flushGroup(null, null);
              if (injection.action === 'system-turn') {
                emitNonAssistantTurn('system', injection.content ?? raw, line);
              }
            } else if (raw) {
              flushGroup(null, null);
              emitNonAssistantTurn('user', raw, line);
            }
          } else if (msg.role === 'developer') {
            // developer = 框架注入指令（skills 指令/命令审批记录），模型读得到
            // 但不属于会话事件 → 丢弃（D1 修订，claude 剥离 system-reminder 同款）
            flushGroup(null, null);
          }
          // 未知角色：安全跳过
        } else if (itemType === 'reasoning') {
          markGroupStart(line);
          const reasoningText = extractMessageText(payload.content as CodexContentPart[] | undefined);
          if (reasoningText) thinkingParts.push(reasoningText);
        } else if (itemType === 'function_call') {
          markGroupStart(line);
          const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
          // 工具真实时长的左边界 = 本行时间戳（rollout 每条 item 独立打
          // 戳）；右边界在 function_call_output 到达时经全局索引回填——此前
          // 两字段恒缺，turn-split 回落轮时间且 durationMs 恒 0（真机实测
          // 原生 codex 会话工具时长全 0）
          const tc: ToolCallInfo = {
            toolCallId: callId,
            toolName: typeof payload.name === 'string' ? payload.name : '',
            argsJson: typeof payload.arguments === 'string' ? payload.arguments : null,
            resultJson: null,
            state: 'completed',
            startedAt: toMillis(line.timestamp),
          };
          toolCalls.push(tc);
          if (callId) toolCallIndex.set(callId, tc);
        } else if (itemType === 'custom_tool_call') {
          markGroupStart(line);
          const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
          const input = payload.input;
          const tc: ToolCallInfo = {
            toolCallId: callId,
            toolName: typeof payload.name === 'string' ? payload.name : 'custom_tool',
            argsJson: typeof input === 'string' ? input : (input == null ? null : JSON.stringify(input)),
            resultJson: null,
            state: typeof payload.status === 'string' ? payload.status : 'completed',
            startedAt: toMillis(line.timestamp),
          };
          toolCalls.push(tc);
          if (callId) toolCallIndex.set(callId, tc);
        } else if (itemType === 'function_call_output') {
          // 输出晚于组冲刷到达：经全局索引回填
          const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
          const tc = callId ? toolCallIndex.get(callId) : undefined;
          if (tc) {
            const out = payload.output;
            tc.resultJson = typeof out === 'string' ? out : (out != null ? JSON.stringify(out) : null);
            // 右边界：工具执行的完成时刻 ≈ 输出行落盘戳（结果就绪才会写
            // rollout；与捕获路径的 [上一轮响应末字节, 下一请求到达] 同语义）
            tc.completedAt = toMillis(line.timestamp) ?? tc.completedAt ?? null;
          }
          // 未知 call_id（前文调用缺失/被裁剪）：丢弃，原文在盘上
        } else if (itemType === 'custom_tool_call_output') {
          const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
          const tc = callId ? toolCallIndex.get(callId) : undefined;
          if (tc) {
            const out = payload.output;
            tc.resultJson = typeof out === 'string' ? out : (out != null ? JSON.stringify(out) : null);
            tc.completedAt = toMillis(line.timestamp) ?? tc.completedAt ?? null;
            tc.state = 'completed';
          }
        } else if (itemType === 'web_search_call') {
          markGroupStart(line);
          const action = (payload.action ?? {}) as { type?: string; query?: string };
          toolCalls.push({
            toolCallId: typeof payload.id === 'string' ? payload.id : '',
            toolName: 'web_search',
            argsJson: JSON.stringify({ query: action.query ?? null }),
            resultJson: typeof payload.status === 'string' ? JSON.stringify({ status: payload.status }) : null,
            state: typeof payload.status === 'string' ? payload.status : 'completed',
          });
        }
        // 未知 payload 类型：安全跳过（版本前向兼容）
        break;
      }
      default:
        break;
    }
  }

  // 文件尾部残留组（未收到 usage 的中断响应）
  flushGroup(null, null);

  rollUpStreamingExecs(result);

  return result;
}

// ── 流式 shell 卷回（exec_command + write_stdin → 单一逻辑工具调用）─────────
// codex 的 exec_command 是流式终端协议：一次逻辑命令被物理拆成 1 个
// exec_command（首块常只有「Process running with session ID N」块头）+ N 个
// write_stdin 轮询块（session_id 关联、块间为输出增量 delta）。1:1 映射 wire
// 形状会让所有下游（Turns 展示、Perf 时长、技能正文恢复、导出）各自再懂一遍
// 这套传输协议——按「框架行为解释归 adapter」红线，在此单点卷回逻辑形状：
//   - 属主 exec 吸收其全部轮询块：输出增量按到达序拼接、真实时长到最后一块、
//     终态取末块退出码
//   - 交互输入（write_stdin chars 非空）以 `[stdin] …` 行留痕，信息不丢
//   - 轮询块是传输管道，不再作为工具调用出现；孤儿轮询块（属主不在本文件，
//     如捕获裁剪起点之前发起）原样保留
//   - 全部 exec_command 输出剥传输壳（Chunk ID/Wall time/…/Output:）——下游
//     看到的即终端原文；旧库存量行仍带壳，读侧 stripExecOutputHeader 兼容
//   - 轮级卷回：纯传输轮（整轮工具全部被吸收的 write_stdin 模型往返）并入
//     属主 exec 的轮，成为同一「节拍」（agent 的一个完整行为单元 = 动作 +
//     等待期）——685 个计费往返不再 1:1 映射成 685 轮（其中 342 轮是传输
//     尸体：无正文无工具，胶片上只剩裸横线）。usage 字段分治：水位族
//     （input/cacheRead/cacheWrite/inputMessagesTokens）取末次轮询读数、
//     消耗族（output/reasoning/cost）求和、total 按「每轮 total = input +
//     output + reasoning」恒等式重建（轮内与会话级一致性都保持）；思考按
//     到达序并入属主轮正文；timeInfo.completed 延伸到末次轮询。latency
//     不动（模型生成跨度原值——等待期已由 exec durationMs 承载，turnMs =
//     latency + maxTool 的 turn-duration 单点不双计）。孤儿轮询轮（属主
//     不在本文件）与混合轮（吸收了轮询块但还保留其他工具）不参与合并

interface StreamingExecState {
  /** 轮询块的输出增量与交互输入留痕（到达序） */
  parts: string[];
  /** 会话最后一块到达时刻（真实完成时刻） */
  lastChunkTs: number | null;
  /** 末块携带的退出码（running 块 → 维持前值） */
  exitCode: number | null;
}

function rollUpStreamingExecs(result: RawInteraction[]): void {
  const execs: ToolCallInfo[] = [];
  const ownerBySession = new Map<number, ToolCallInfo>();
  const stateByOwner = new Map<ToolCallInfo, StreamingExecState>();
  // 轮级卷回索引：属主工具 → 属主交互；属主 → 纯传输轮（到达序）
  const riOfOwner = new Map<ToolCallInfo, RawInteraction>();
  const pollsByOwner = new Map<ToolCallInfo, RawInteraction[]>();

  for (const ri of result) {
    for (const tc of ri.tool_calls ?? []) {
      if (tc.toolName !== 'exec_command' || tc.resultJson == null) continue;
      execs.push(tc);
      riOfOwner.set(tc, ri);
      const sid = codexStreamSessionIdOf(tc.resultJson);
      if (sid !== null && !ownerBySession.has(sid)) {
        ownerBySession.set(sid, tc);
        stateByOwner.set(tc, {
          parts: [],
          lastChunkTs: tc.completedAt ?? null,
          exitCode: codexChunkExitCodeOf(tc.resultJson),
        });
      }
    }
  }
  if (execs.length === 0) return;

  let droppedAny = false;
  for (const ri of result) {
    const tcs = ri.tool_calls;
    if (!tcs || tcs.length === 0) continue;
    const kept: ToolCallInfo[] = [];
    let dropped = false;
    let pollOwner: ToolCallInfo | null = null;
    for (const tc of tcs) {
      const sid = tc.toolName === 'write_stdin' ? writeStdinSessionIdOf(tc.argsJson) : null;
      const owner = sid !== null ? ownerBySession.get(sid) : undefined;
      if (owner == null) {
        kept.push(tc);
        continue;
      }
      dropped = true;
      droppedAny = true;
      if (pollOwner == null) pollOwner = owner;
      const st = stateByOwner.get(owner)!;
      const chars = writeStdinCharsOf(tc.argsJson);
      if (chars) st.parts.push(`[stdin] ${chars}\n`);
      if (tc.resultJson != null) st.parts.push(stripExecOutputHeader(tc.resultJson));
      const exitCode = codexChunkExitCodeOf(tc.resultJson ?? '');
      if (exitCode !== null) st.exitCode = exitCode;
      if (tc.completedAt != null && (st.lastChunkTs == null || tc.completedAt > st.lastChunkTs)) {
        st.lastChunkTs = tc.completedAt;
      }
    }
    if (dropped) {
      ri.tool_calls = kept.length > 0 ? kept : null;
      // 纯传输轮（整轮工具全部被吸收、无保留工具）→ 记入属主等待期
      if (kept.length === 0 && pollOwner != null) {
        const list = pollsByOwner.get(pollOwner);
        if (list) list.push(ri);
        else pollsByOwner.set(pollOwner, [ri]);
      }
    }
  }

  for (const tc of execs) {
    const raw = tc.resultJson ?? '';
    const st = stateByOwner.get(tc);
    const exitCode = st != null ? st.exitCode : codexChunkExitCodeOf(raw);
    tc.resultJson = st != null
      ? [stripExecOutputHeader(raw), ...st.parts].join('')
      : stripExecOutputHeader(raw);
    if (st != null && st.lastChunkTs != null) tc.completedAt = st.lastChunkTs;
    if (exitCode !== null && exitCode !== 0) tc.state = 'error';
  }

  // ── 轮级卷回：纯传输轮并入属主轮（节拍 = 动作 + 等待期）────────────────
  if (pollsByOwner.size > 0) {
    const merged = new Set<RawInteraction>();
    for (const [owner, polls] of pollsByOwner) {
      const ownerRi = riOfOwner.get(owner);
      if (ownerRi == null) continue;
      let acc = ownerRi.usage;
      for (const poll of polls) {
        // 思考按到达序并入：轮询期间的思考本来就属于这个节拍
        if (poll.content) {
          ownerRi.content = ownerRi.content != null
            ? `${ownerRi.content}\n${poll.content}`
            : poll.content;
        }
        const pu = poll.usage;
        if (pu != null) {
          // 字段分治：水位族取末次轮询读数（上下文在等待期末的真实水位），
          // 消耗族求和（token 是真实产出）
          const o = acc ?? { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, inputMessagesTokens: 0 };
          acc = {
            ...o,
            output: o.output + pu.output,
            reasoning: o.reasoning + pu.reasoning,
            cost: o.cost + pu.cost,
            input: pu.input,
            cacheRead: pu.cacheRead,
            cacheWrite: pu.cacheWrite,
            inputMessagesTokens: pu.inputMessagesTokens,
          };
        }
        const pEnd = poll.timeInfo?.completed ?? null;
        if (pEnd != null && (ownerRi.timeInfo?.completed == null || pEnd > ownerRi.timeInfo.completed)) {
          ownerRi.timeInfo = { created: ownerRi.timeInfo?.created ?? 0, completed: pEnd };
        }
        merged.add(poll);
      }
      if (acc != null) {
        // total 恒等式重建（#39 拆桶口径）：每轮 total = inputMessagesTokens +
        // output + reasoning，其中 inputMessagesTokens = input + cacheRead +
        // cacheWrite（原始输入，含缓存）。节拍 total = 末次原始输入水位 + 节拍
        // 总产出——轮内与会话级一致性都保持
        acc.total = acc.inputMessagesTokens + acc.output + acc.reasoning;
        ownerRi.usage = acc;
      }
      // latency 不动：模型生成跨度 = 属主轮原值（等待期已由 exec durationMs
      // 承载，turnMs = latency + maxTool 的分解不双计）
    }
    for (let i = result.length - 1; i >= 0; i--) {
      if (merged.has(result[i])) result.splice(i, 1);
    }
  }

  // 纯传输空组（无正文/无工具/无 usage）不再作为会话事件；带 usage 的空组
  // 保留（token 消耗是真实模型轮次——claude 适配器截断观测同款先例；codex
  // 的轮询空组已在上方轮级卷回中并入属主轮，走不到这里）
  if (droppedAny) {
    for (let i = result.length - 1; i >= 0; i--) {
      const ri = result[i];
      const empty =
        (ri.content == null || ri.content === '') &&
        (ri.tool_calls == null || ri.tool_calls.length === 0) &&
        ri.usage == null;
      if (empty) result.splice(i, 1);
    }
  }
}

// ── 文件定位 ─────────────────────────────────────────────────────────

function collectRolloutFiles(dirPath: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectRolloutFiles(full));
      } else if (entry.isFile() && isCodexCandidateFileName(entry.name)) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

function findRolloutFile(dirPath: string, sessionId: string): string | null {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && sessionIdFromCodexFileName(entry.name) === sessionId) {
        return path.join(dirPath, entry.name);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = findRolloutFile(path.join(dirPath, entry.name), sessionId);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function resolveSessionFilePath(filePath: string, sessionId: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (stat.isFile()) return filePath;
  if (stat.isDirectory()) return findRolloutFile(filePath, sessionId);
  return null;
}

// ── Adapter 契约实现 ─────────────────────────────────────────────────

// 路径 → 会话 id（SourceDescriptor.deriveSessionId 能力）：rollout 文件名内
// 嵌会话 id；deriveSessionId 契约收完整路径（DSH 的 id 取日志父目录名），
// 先剥目录再按命名约定提取，认不出返回 null
export function deriveSessionIdFromPath(filePath: string): string | null {
  return sessionIdFromCodexFileName(path.basename(filePath));
}

export function readSession(filePath: string, sessionId: string): RawInteraction[] {
  const resolved = resolveSessionFilePath(filePath, sessionId);
  if (!resolved) return [];
  const lines = parseRolloutLines(resolved);
  if (lines.length === 0) return [];
  return readSessionFromLines(lines);
}

export function extractVersion(filePath: string, sessionId?: string): string | null {
  try {
    // dbPath 可能是 sessions 根目录（UI 列表导入流程传目录）——有 sessionId
    // 时先解析到具体 rollout 文件再读 meta；无 sessionId 时按文件直读
    const resolved = sessionId ? resolveSessionFilePath(filePath, sessionId) : filePath;
    if (!resolved) return null;
    const lines = parseRolloutLines(resolved);
    return readSessionMeta(lines).cliVersion;
  } catch {
    return null;
  }
}

export function listSessions(dirPath: string): SessionListItem[] {
  if (!dirPath || !fs.existsSync(dirPath)) return [];

  const stat = fs.statSync(dirPath);
  const files = stat.isFile()
    ? (isCodexCandidateFileName(path.basename(dirPath)) ? [dirPath] : [])
    : collectRolloutFiles(dirPath);

  const result: SessionListItem[] = [];
  for (const file of files) {
    // 逐件降级：半写坏/外来文件跳过，不炸整个列表
    let lines: CodexRolloutLine[];
    try {
      lines = parseRolloutLines(file);
    } catch (e) {
      console.warn(`codex-jsonl: skipping unreadable rollout in listSessions: ${file} (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const meta = readSessionMeta(lines);
    // 防 mis吞非 codex 文件：首行必须是有 id 的 session_meta
    if (!meta.id) continue;
    // 子代理线程不作为顶层会话（并入主会话；与 claude 跳过 subagents 目录同语义）
    if (meta.threadSource === 'subagent') continue;

    const sessionId = rolloutSessionIdOf(path.basename(file)) ?? meta.id;

    let firstQuery: string | null = null;
    let endedAt: string | null = null;
    let turnCount = 0;
    let totalTokens = 0;
    const modelCounts = new Map<string, number>();

    for (const line of lines) {
      if (line.timestamp) endedAt = line.timestamp;
      const payload = (line.payload ?? {}) as Record<string, unknown>;
      if (line.type === 'event_msg' && payload.type === 'task_started') turnCount += 1;
      if (line.type === 'turn_context' && typeof payload.model === 'string' && payload.model) {
        modelCounts.set(payload.model, (modelCounts.get(payload.model) ?? 0) + 1);
      }
      if (line.type === 'token_usage_record') {
        // 与 turn 级 usage.total 同口径（codex 权威 total_tokens，含 reasoning），
        // 列表预览与导入聚合一致
        totalTokens += mapUsage(payload.usage as CodexUsage | undefined)?.total ?? 0;
      }
      if (line.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        const text = extractMessageText(payload.content as CodexContentPart[] | undefined);
        if (text && !firstQuery && !classifyCodexUserInjection(text, { isFirstTurn: false })) {
          firstQuery = truncateUtf16Safe(text, 200);
        }
      }
    }

    let modelName: string | null = null;
    let modelMaxCount = 0;
    for (const [m, c] of modelCounts) {
      if (c > modelMaxCount) { modelMaxCount = c; modelName = m; }
    }

    const createdAt = meta.timestamp
      ?? (() => {
        try { return fs.statSync(file).mtime.toISOString(); } catch { return new Date(0).toISOString(); }
      })();

    result.push({
      id: sessionId,
      createdAt,
      endedAt,
      firstQuery,
      turnCount,
      modelName,
      totalTokens,
      version: meta.cliVersion,
      filePath: file,
    });
  }

  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── 子代理发现（SourceDescriptor.readSubagents 能力）──────────────────
// 主文件 spawn_agent 输出（权威：agent_id + nickname）→ 同目录/会话树定位
// 子 rollout → session_meta.parent_thread_id 交叉验证 → readSession 打标。
// 嵌套 spawn（孙代理）同一机制递归（深度上限防环）。

interface SpawnedAgent {
  id: string;
  nickname: string | null;
}

function extractSpawnedAgents(lines: CodexRolloutLine[]): SpawnedAgent[] {
  const callOutputByCallId = new Map<string, string>();
  const spawnCallIds: string[] = [];
  const waitTargets = new Set<string>();

  for (const line of lines) {
    if (line.type !== 'response_item') continue;
    const payload = (line.payload ?? {}) as Record<string, unknown>;
    if (payload.type === 'function_call') {
      if (payload.name === 'spawn_agent') {
        if (typeof payload.call_id === 'string') spawnCallIds.push(payload.call_id);
      } else if (payload.name === 'wait_agent') {
        // 兜底信号：spawn 输出缺失（异常截断）时按等待目标补发现（无昵称）
        try {
          const args = JSON.parse(typeof payload.arguments === 'string' ? payload.arguments : '{}') as { targets?: string[] };
          for (const t of args.targets ?? []) waitTargets.add(t);
        } catch { /* ignore */ }
      }
    } else if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
      const out = payload.output;
      callOutputByCallId.set(payload.call_id, typeof out === 'string' ? out : JSON.stringify(out));
    }
  }

  const agents: SpawnedAgent[] = [];
  const seen = new Set<string>();
  for (const callId of spawnCallIds) {
    const out = callOutputByCallId.get(callId);
    if (!out) continue;
    try {
      const parsed = JSON.parse(out) as { agent_id?: string; nickname?: string };
      if (typeof parsed.agent_id === 'string' && parsed.agent_id && !seen.has(parsed.agent_id)) {
        seen.add(parsed.agent_id);
        agents.push({ id: parsed.agent_id, nickname: typeof parsed.nickname === 'string' ? parsed.nickname : null });
      }
    } catch { /* ignore */ }
  }
  for (const target of waitTargets) {
    if (!seen.has(target)) {
      seen.add(target);
      agents.push({ id: target, nickname: null });
    }
  }
  return agents;
}

// 向上找 sessions 根（~/.codex/sessions/YYYY/MM/DD → 上溯至多 3 层），
// 子代理通常与主文件同日同目录，跨日 spawn 才需要树搜索
function findSessionsRoot(mainFile: string): string | null {
  let dir = path.dirname(mainFile);
  for (let i = 0; i < 4; i++) {
    if (path.basename(dir) === 'sessions') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function locateRolloutById(mainFile: string, sessionId: string): string | null {
  const sameDir = path.dirname(mainFile);
  const direct = findRolloutFile(sameDir, sessionId);
  if (direct) return direct;
  const root = findSessionsRoot(mainFile);
  if (root && root !== sameDir) {
    const found = findRolloutFile(root, sessionId);
    if (found) return found;
  }
  return null;
}

export function readSubagentInteractions(filePath: string, sessionId: string): RawInteraction[] {
  // dbPath 可能是 sessions 根目录（UI「列表选择→导入」流程传目录）——先按
  // sessionId 解析到主会话文件再发现子代理（与 readSession 同一解析规则）。
  // 此前直读目录会静默返回空：子代理轮次丢失、只剩通知 system turn。
  const resolved = resolveSessionFilePath(filePath, sessionId);
  if (!resolved) return [];
  const discovered: SubagentRollout[] = [];
  discoverSubagentRollouts(resolved, sessionId, 0, new Set(), discovered);
  const result: RawInteraction[] = [];
  for (const sub of discovered) {
    const interactions = readSessionFromLines(sub.lines);
    for (const interaction of interactions) {
      interaction.subagent_session_id = sub.agent.id;
      if (sub.agent.nickname) interaction.subagent_name = sub.agent.nickname;
    }
    result.push(...interactions);
  }
  return result;
}

export function listSubagentRolloutFiles(filePath: string, sessionId: string): string[] {
  const resolved = resolveSessionFilePath(filePath, sessionId);
  if (!resolved) return [];
  const discovered: SubagentRollout[] = [];
  discoverSubagentRollouts(resolved, sessionId, 0, new Set(), discovered);
  return discovered.map(s => s.filePath);
}

interface SubagentRollout {
  agent: SpawnedAgent;
  filePath: string;
  lines: CodexRolloutLine[];
}

function discoverSubagentRollouts(
  mainFile: string,
  parentSessionId: string,
  depth: number,
  seenFiles: Set<string>,
  out: SubagentRollout[],
): void {
  if (depth > 5) return;
  let lines: CodexRolloutLine[];
  try {
    lines = parseRolloutLines(mainFile);
  } catch {
    return;
  }

  for (const agent of extractSpawnedAgents(lines)) {
    const childFile = locateRolloutById(mainFile, agent.id);
    if (!childFile || seenFiles.has(childFile)) continue;
    seenFiles.add(childFile);
    let childLines: CodexRolloutLine[];
    try {
      childLines = parseRolloutLines(childFile);
    } catch {
      continue;
    }
    const childMeta = readSessionMeta(childLines);
    // 交叉验证：parent_thread_id 必须指回主会话（防同 uuid 误配）；无声明时
    // 以 spawn 输出为准（老版本文件）
    if (childMeta.parentThreadId && childMeta.parentThreadId !== parentSessionId) continue;
    out.push({
      agent: { id: agent.id, nickname: childMeta.agentNickname ?? agent.nickname },
      filePath: childFile,
      lines: childLines,
    });
    // 嵌套 spawn：孙代理并入（打各自的标）
    discoverSubagentRollouts(childFile, agent.id, depth + 1, seenFiles, out);
  }
}
