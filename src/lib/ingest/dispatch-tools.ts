// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ── 派发工具注册表（dispatch tool registry）────────────────────────────
// 「派发」= 主会话里把一段任务交给子会话执行的工具调用（claude Task / opencode
// task / codex spawn_agent / 自定义 subagent 插件…）。识别逻辑曾散落三处且各
// 自硬编码白名单——insight bridge-builder 的工具名 filter、参数键 per-tool
// switch、cpx opencode-emitter 的 name.includes('task')——自定义派发工具（首
// 发现场：reuseDispatch 实验的 subagent 插件，args {agent, description, prompt,
// sessionID}）落在所有白名单外：bridge 全零、名字链断、UI 泳道问号。本模块把
// 「派发工具长什么样」收敛为声明式 spec：新增一个派发形态 = 加一条 spec，不改
// 匹配/回填/建桥逻辑。
//
// 语义约定（与 cpx 捕获侧 meta 写入约定对齐——两包不互相 import，spec 语义
// 手工对齐，见 opencode-emitter 的 taskDispatch 收集处）：
//   displayName = description（展示名：任务一句话，UI badge / 泳道标签）
//   agentType   = agent 身份键（如 'ascendc-ops-architect'；Execution/
//                 bridge 的 type，Turn.agentName 同源）
//   sessionId   = 派发参数直连的目标子会话 id（复用/预知形态；同一子会话可
//                 多次派发——复用续跑，此时名字取首个派发）

import type { ToolCallRow, TurnRow } from './turn-split';

export interface DispatchToolSpec {
  /** 工具名精确匹配（小写归一后比较；claude proxy 的 'Agent' → 'agent'）。 */
  names: string[];
  /** 包含式匹配片段（小写）：命中自定义派发工具族（subagent / run_subagent / …）。 */
  nameIncludes?: string[];
  /** 派发参数键序（首个非空 string 生效，键查找大小写归一）→ 子会话 id 直连。 */
  sessionIdArgKeys: string[];
  /** → agent 身份（'ascendc-ops-architect'）。 */
  agentTypeArgKeys: string[];
  /** → 展示名（cpx 约定：description 优先）。 */
  displayNameArgKeys: string[];
  /** → 派发内容锚 content（summary 优先，其后 description；prompt 兜底）。 */
  contentArgKeys: string[];
  /** → prompt（content 的最后顺位）。 */
  promptArgKeys: string[];
  /** 特殊 prompt 形态提取（codex spawn_agent 的 message/items 数组双形态）。 */
  extractPromptFromArgs?: (args: Record<string, unknown>) => string | null;
  /** 结果侧子会话 id 提取器，按序尝试。 */
  resultSessionIdExtractors?: ResultSessionIdExtractor[];
  /** 结果 JSON 形如 {"agent_id","nickname"}：nickname 可作展示名 fallback。 */
  resultNickname?: boolean;
  /** 经 meta toolUseId → 子会话 id 映射直连（cpx 捕获约定，claude proxy 形态）。 */
  linkViaToolUseMeta?: boolean;
}

export type ResultSessionIdExtractor = 'json-agent-id' | 'task-id-text' | 'task-id-xml' | 'subagent-result';

export const DISPATCH_TOOLS: readonly DispatchToolSpec[] = [
  {
    // opencode 内置 task（真机参数：description / subagent_type / prompt /
    // subagent_session_id / subagent_model / summary；结果 <task id="…" state=…>）
    names: ['task'],
    sessionIdArgKeys: ['subagent_session_id'],
    agentTypeArgKeys: ['subagent_type'],
    displayNameArgKeys: ['description', 'subagent_name'],
    contentArgKeys: ['summary', 'description'],
    promptArgKeys: ['prompt'],
    resultSessionIdExtractors: ['task-id-text', 'task-id-xml'],
  },
  {
    // claude Task 的 proxy 形态（原硬编码 toolName === 'Agent'）
    names: ['agent'],
    sessionIdArgKeys: ['subagent_session_id'],
    agentTypeArgKeys: ['subagent_type', 'mode'],
    displayNameArgKeys: ['name', 'subagent_name', 'description'],
    contentArgKeys: ['description'],
    promptArgKeys: ['prompt'],
    linkViaToolUseMeta: true,
    resultSessionIdExtractors: ['task-id-text'],
  },
  {
    // codex spawn_agent：任务文本 wire 双形态（0.161 message 直传；0.162 只传
    // fork_context+items，items 内纯文本项）；输出是干净 JSON {agent_id, nickname}
    names: ['spawn_agent'],
    sessionIdArgKeys: [],
    agentTypeArgKeys: [],
    displayNameArgKeys: [],
    contentArgKeys: [],
    promptArgKeys: ['prompt', 'task'],
    extractPromptFromArgs: (args) =>
      firstTextOfSpawnItems(args.items) ?? strOf(args.message) ?? strOf(args.prompt) ?? strOf(args.task),
    resultSessionIdExtractors: ['json-agent-id', 'task-id-text'],
    resultNickname: true,
  },
  {
    // 自定义派发工具族（首发现场：reuseDispatch 实验的 subagent 插件）。两种
    // 派发形态（真机 ses_ecb797cb 的 102 个派发核实）：
    //   复用型：args 带 sessionID 直连目标子会话（可多次派发续跑）
    //   创建型：args 无 sessionID（83/102 为 background），新会话 id 只在结果
    //           协议文本里——'subagent-result' 提取器双格式解析
    names: ['subagent'],
    nameIncludes: ['subagent'],
    sessionIdArgKeys: ['sessionID', 'session_id', 'subagent_session_id'],
    agentTypeArgKeys: ['agent', 'subagent_type'],
    displayNameArgKeys: ['description', 'subagent_name', 'name'],
    contentArgKeys: ['description'],
    promptArgKeys: ['prompt'],
    resultSessionIdExtractors: ['subagent-result'],
  },
];

/** 工具名 → spec（精确名优先于包含式；全小写比较）。非派发工具返回 null。 */
export function dispatchSpecOf(toolName: string): DispatchToolSpec | null {
  const lower = toolName.toLowerCase();
  for (const spec of DISPATCH_TOOLS) {
    if (spec.names.includes(lower)) return spec;
  }
  for (const spec of DISPATCH_TOOLS) {
    if (spec.nameIncludes?.some(frag => lower.includes(frag))) return spec;
  }
  return null;
}

/** 派发 tool call 的规范化解析产物（bridge 建桥 / Turn 回填共用的唯一形态）。 */
export interface DispatchRecord {
  toolCallId: string;
  toolName: string;
  spec: DispatchToolSpec;
  /** 派发参数直连的子会话 id（复用/预知形态；无则 null）。 */
  argSessionId: string | null;
  /** agent 身份（'ascendc-ops-architect'）。 */
  agentType: string | null;
  /** 展示名（cpx 约定 description 优先）。 */
  displayName: string | null;
  /** 派发内容锚（content 键序 ?? prompt）。 */
  content: string | null;
  /** 结果侧提取的子会话 id。 */
  resultSessionId: string | null;
  /** 结果侧展示名 fallback（spawn_agent JSON nickname）。 */
  resultNickname: string | null;
}

/**
 * 解析一条 tool call 是否派发、派发参数的规范化字段。非派发工具 → null；
 * 派发工具但 args 坏/缺 → 字段全 null 的 record（仍是派发，参与时间邻近等
 * 后续匹配）。
 */
export function resolveDispatchToolCall(
  tc: Pick<ToolCallRow, 'toolCallId' | 'toolName' | 'argsJson' | 'resultJson'>,
): DispatchRecord | null {
  const spec = dispatchSpecOf(tc.toolName);
  if (!spec) return null;

  let args: Record<string, unknown> = {};
  if (tc.argsJson) {
    try {
      const parsed: unknown = JSON.parse(tc.argsJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // 坏 args：仍是派发工具，字段全 null
    }
  }

  const prompt = spec.extractPromptFromArgs
    ? spec.extractPromptFromArgs(args)
    : firstStr(spec.promptArgKeys, args);

  const { sessionId: resultSessionId, nickname } = extractResultSessionId(
    tc.resultJson, spec.resultSessionIdExtractors,
  );

  return {
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    spec,
    argSessionId: firstStr(spec.sessionIdArgKeys, args),
    agentType: firstStr(spec.agentTypeArgKeys, args),
    displayName: firstStr(spec.displayNameArgKeys, args),
    content: firstStr(spec.contentArgKeys, args) ?? prompt,
    resultSessionId,
    resultNickname: spec.resultNickname ? nickname : null,
  };
}

// ── Turn 名字回填 ────────────────────────────────────────────────────
// 派发参数是子代理名字的权威源：meta/标题路径全断时（自定义派发工具 + 历史
// 湖数据 + cpx 捕获白名单外），从派发 args 直取。只信显式链接（参数直连键 +
// 结果协议 id），不做时间邻近兜底——名字错配比缺名更伤（时间窗口里多个子
// 会话时可能错认）。??= 语义：来源侧（meta / msgData.agent / 标题）已有名字
// 不覆盖。
export function backfillTurnNamesFromDispatches(turns: TurnRow[], toolCalls: ToolCallRow[]): void {
  const records: DispatchRecord[] = [];
  for (const tc of toolCalls) {
    const rec = resolveDispatchToolCall(tc);
    if (rec) records.push(rec);
  }
  if (records.length === 0) return;

  const nameBySubagentSession = new Map<string, { subagentName: string | null; agentName: string | null }>();
  for (const rec of records) {
    const sid = rec.argSessionId ?? rec.resultSessionId;
    if (!sid || nameBySubagentSession.has(sid)) continue; // 复用续跑：首个派发优先
    const subagentName = rec.displayName ?? rec.resultNickname ?? null;
    const agentName = rec.agentType ?? null;
    if (subagentName || agentName) {
      nameBySubagentSession.set(sid, { subagentName, agentName });
    }
  }
  if (nameBySubagentSession.size === 0) return;

  for (const turn of turns) {
    const sid = turn.subagentSessionId;
    if (!sid) continue;
    const names = nameBySubagentSession.get(sid);
    if (!names) continue;
    if (!turn.subagentName && names.subagentName) turn.subagentName = names.subagentName;
    if (!turn.agentName && names.agentName) turn.agentName = names.agentName;
  }
}

// ── 内部工具 ─────────────────────────────────────────────────────────

/** 参数键查找：先精确命中，再小写归一扫描（'sessionID' ↔ 'sessionid'）。 */
function lookupArg(args: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(args, key)) return args[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(args)) {
    if (k.toLowerCase() === lower) return args[k];
  }
  return undefined;
}

/** 键序取首个非空 string（null/undefined/非字符串一律跳过）。 */
function firstStr(keys: readonly string[], args: Record<string, unknown>): string | null {
  for (const key of keys) {
    const v = strOf(lookupArg(args, key));
    if (v !== null) return v;
  }
  return null;
}

function strOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// spawn_agent items 参数内首个任务文本（0.162 形态）：items 是纯文本项数组
// [{type:'text', text}]（真机 dumpC 四个子代理一致）；防御性兼容 message 项
// 形态 {type:'message', content:[…]}。与 cpx codex-emitter 的 spawnTaskOf 同源
// 结论（两包不互相 import，双形态语义对齐）。
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

function extractResultSessionId(
  resultJson: string | null,
  extractors?: readonly ResultSessionIdExtractor[],
): { sessionId: string | null; nickname: string | null } {
  if (!resultJson || !extractors || extractors.length === 0) return { sessionId: null, nickname: null };
  for (const extractor of extractors) {
    if (extractor === 'json-agent-id') {
      // codex spawn_agent 的输出是干净 JSON：{"agent_id":"<子会话 id>","nickname":"…"}
      try {
        const parsed: unknown = JSON.parse(resultJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const obj = parsed as { agent_id?: unknown; nickname?: unknown };
          if (typeof obj.agent_id === 'string' && obj.agent_id) {
            return { sessionId: obj.agent_id, nickname: strOf(obj.nickname) };
          }
        }
      } catch {
        // 非整 JSON，继续下一提取器
      }
    } else if (extractor === 'task-id-text') {
      // claude 文本协议：task_id: ses_xxx
      const claudeTask = resultJson.match(/task_id:\s*(\S+)/);
      if (claudeTask) return { sessionId: claudeTask[1]!, nickname: null };
      // dsh（DeepSeek Harness）：派发成功的工具结果是 `started subagent <uuid>`
      // （原生适配器把派发工具名统一为 Agent，命中本 spec 的结果提取器）。
      // 缺了这条，DSH 派发取不到子会话 id——既不是 claude 的 task_id、也不是
      // codex 的 JSON agent_id——会撞「结果非空即不建桥」的失败派发守卫，
      // 子代理连不上、退化成普通 tool call
      const dshSub = resultJson.match(/started subagent\s+([0-9a-fA-F-]{36})/);
      if (dshSub) return { sessionId: dshSub[1]!, nickname: null };
    } else if (extractor === 'task-id-xml') {
      // opencode task 真机结果形态：<task id="ses_…" state="completed">。结果
      // 可能是 JSON 内容块数组（text 内层引号转义成 \"），直引号与转义引号都要容
      const match = resultJson.match(/<task\s+id=\\?"([^"\\]+)\\?"/);
      if (match) return { sessionId: match[1]!, nickname: null };
    } else if (extractor === 'subagent-result') {
      // reuseDispatch 插件结果双形态（真机核实）。结果常是嵌套 JSON 字符串
      // （content = JSON 数组的文本形态，内层引号带转义），先解一层拼出干净
      // 文本再匹配：
      //   后台型：The subagent is working in the background (sessionID: ses_…)
      //   阻塞型：<subagent sessionID="ses_…" state="completed">
      let probe = resultJson;
      try {
        const parsed: unknown = JSON.parse(resultJson);
        if (typeof parsed === 'string') {
          probe = parsed;
        } else if (Array.isArray(parsed)) {
          probe = parsed
            .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
            .join('');
        }
      } catch {
        // 非 JSON：原样探测
      }
      const xml = probe.match(/<subagent\s+sessionID="([^"]+)"/);
      if (xml) return { sessionId: xml[1]!, nickname: null };
      const paren = probe.match(/\(sessionID:\s*(\S+?)\)/);
      if (paren) return { sessionId: paren[1]!, nickname: null };
    }
  }
  return { sessionId: null, nickname: null };
}
