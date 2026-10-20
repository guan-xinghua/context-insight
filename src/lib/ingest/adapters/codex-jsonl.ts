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
import { readCaptureHead } from '@/lib/compression';
import type { SessionListItem, RawInteraction, ToolCallInfo, TokenUsage } from '../../shared/types';
import { classifyCodexUserInjection } from './injections/codex';
import { isRolloutFileName, rolloutSessionIdOf } from './codex-naming';

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
  return parseRolloutBuffer(fs.readFileSync(filePath), filePath);
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
  const input = u.input_tokens ?? 0;
  const cacheRead = u.cached_input_tokens ?? 0;
  const cacheWrite = u.cache_write_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const reasoning = u.reasoning_output_tokens ?? 0;
  const inputMessagesTokens = input + cacheRead + cacheWrite;
  return {
    total: u.total_tokens ?? (inputMessagesTokens + output + reasoning),
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

    result.push({
      role: 'assistant',
      content,
      timestamp: groupFirstTimestamp ?? new Date(created).toISOString(),
      timeInfo: { created, ...(usageTs != null ? { completed: usageTs } : {}) },
      agent: null,
      subagent_name: null,
      subagent_session_id: null,
      subagent_type: null,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
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
          const tc: ToolCallInfo = {
            toolCallId: callId,
            toolName: typeof payload.name === 'string' ? payload.name : '',
            argsJson: typeof payload.arguments === 'string' ? payload.arguments : null,
            resultJson: null,
            state: 'completed',
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
          }
          // 未知 call_id（前文调用缺失/被裁剪）：丢弃，原文在盘上
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

  return result;
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
      } else if (entry.isFile() && isRolloutFileName(entry.name)) {
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
      if (entry.isFile() && rolloutSessionIdOf(entry.name) === sessionId) {
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
  return rolloutSessionIdOf(path.basename(filePath));
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
    ? (isRolloutFileName(path.basename(dirPath)) ? [dirPath] : [])
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
  return readSubagentsInner(resolved, sessionId, 0);
}

function readSubagentsInner(mainFile: string, sessionId: string, depth: number): RawInteraction[] {
  if (depth > 5) return []; // 嵌套深度上限（防异常环）
  let lines: CodexRolloutLine[];
  try {
    lines = parseRolloutLines(mainFile);
  } catch {
    return [];
  }

  const agents = extractSpawnedAgents(lines);
  const result: RawInteraction[] = [];
  for (const agent of agents) {
    const childFile = locateRolloutById(mainFile, agent.id);
    if (!childFile) continue; // 子文件丢失（被清理）：跳过不阻塞，spawn/wait 工具结果仍在主时间线
    let childLines: CodexRolloutLine[];
    try {
      childLines = parseRolloutLines(childFile);
    } catch {
      continue;
    }
    const childMeta = readSessionMeta(childLines);
    // 交叉验证：parent_thread_id 必须指回主会话（防同 uuid 误配）；无声明时
    // 以 spawn 输出为准（老版本文件）
    if (childMeta.parentThreadId && childMeta.parentThreadId !== sessionId) continue;

    const interactions = readSessionFromLines(childLines);
    const nickname = childMeta.agentNickname ?? agent.nickname;
    for (const it of interactions) {
      it.subagent_session_id = agent.id;
      if (nickname) it.subagent_name = nickname;
    }
    result.push(...interactions);
    // 嵌套 spawn：孙代理并入（打各自的标）
    result.push(...readSubagentsInner(childFile, agent.id, depth + 1));
  }
  return result;
}
