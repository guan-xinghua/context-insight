// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { SessionListItem, RawInteraction } from '../../shared/types';

// ── 多 Agent 源接入契约（agent-source-framework）──────────────────────
// 设计文档：docs/design/agent-source-framework/design.md
//
// 一个「源」除了解析（listSessions/readSession），还要声明身份（framework
// 落库值）、子代理发现、版本提取、文件识别——此前这些信息泄漏到
// data-service / API 路由 / UI 各调用方，接入新源要动 7 个散点。
// SourceDescriptor 把它们收拢为单点声明；注册表（registry.ts）消费契约，
// data-service 与路由只认注册表，不再感知具体框架。
//
// 框架级归一化原则（所有适配器必须遵守，serving 层依赖这些全局一致语义）：
// 1. 注入归一：框架注入的上下文（codex environment_context/developer、claude
//    system-reminder/task-notification 等）按两类处置——静态注入（环境快照/
//    指令回显）丢弃不进时间线，事件注入（子代理通知/轮中止）归一
//    role:'system' + 可读摘要；真实人类输入保持 role:'user'。指纹规则框架
//    自持（adapters/injections/<framework>.ts），产出语义全局一致
// 2. 子代理归一：发现机制框架自持，产出统一打标（subagent_session_id/name/
//    type）的 interactions，并入循环 data-service 只有一份
// 3. 原始保真：未知载荷安全跳过（版本前向兼容）；wire 原文永远在盘上，
//    适配器只做解释不做删改

// ── 注入分类契约（原则 1 的类型化，adapters/injections/ 实现）──────────
// cpx 把所有框架的捕获归一成 claude 布局，claude-jsonl 适配器因此成为通用
// 入口——但注入指纹是框架语义：入口只按行级 source 标记分发到原框架的
// 分类器（injections/index.ts），不内联异框架指纹。

/** 注入处置：drop = 静态注入丢弃不进时间线；system-turn = 事件注入归一
 * system turn（content 为可读摘要或原文） */
export type UserInjectionAction = 'drop' | 'system-turn';

export interface UserInjectionDecision {
  action: UserInjectionAction;
  /** 框架自持的诊断标识（如 'environment' / 'task-notification'） */
  kind: string;
  /** system-turn 的展示内容；drop 时无意义 */
  content?: string;
}

export interface UserInjectionContext {
  /** 本行之前无任何记录（会话首条）。skill 注入的首条例外依赖它：opencode
   * ≥1.17 把 skill 规程注入为首条消息，重分类会让 turn0 角色随版本漂移 */
  isFirstTurn: boolean;
}

export type UserInjectionClassifier = (
  raw: string,
  ctx: UserInjectionContext,
) => UserInjectionDecision | null;

// 子代理会话引用：发现机制的通用产出（发现算法框架自持——claude 走目录
// 布局 + meta.json，codex 走 spawn 输出 + parent_thread_id 交叉验证）
export interface SubagentRef {
  /** 规范子会话 id（= RawInteraction.subagent_session_id，与 Bridge/
   * Execution 的锚定键一致）。claude：文件名即真身会话 id；codex-proxy：
   * cpx 铸的文件名 id 早于 spawn 输出到达，真身 agentId 由 meta backfill，
   * 以 agentId 为规范 id（文件名 id 仅存于 filePath） */
  id: string;
  /** 子会话文件路径 */
  filePath: string;
  /** 子代理显示名（claude: meta.json；codex: agent_nickname） */
  name: string | null;
  /** 子代理类型（claude: agentType；codex 无） */
  type: string | null;
}

// 源描述符：身份 + 解析 + 可选能力。新框架接入 = 实现一个本接口 + registry
// 注册一行，API 路由 / data-service / normalize / refresh 零改动。
export interface SourceDescriptor {
  /** 文件格式标识（导入 sourceType）：'opencode-db' | 'claude-jsonl' | 'codex-jsonl' | … */
  sourceType: string;
  /** agent 归属（DB Session.framework 原生落库值）：'opencode' | 'claude-code' | 'codex' | …
   * 注意与 sourceType 不同名是常态（opencode-db → opencode、claude-jsonl →
   * claude-code）；-proxy 后缀装饰（捕获记录类）由 data-service 施加，不在此声明 */
  framework: string;

  // ── 解析（原有 Adapter 契约，语义不变）──
  listSessions(dbPath: string): SessionListItem[];
  readSession(dbPath: string, sessionId: string): RawInteraction[];

  // ── 可选能力（注册表驱动，data-service 不再写框架分支）──

  /** 发现并读取子代理会话，返回已打标（subagent_session_id/name/type）的
   * interactions，由 data-service 通用循环并入主会话。无子代理概念的源不实现。
   * dbPath 可能是文件或 sessions 根目录（UI「列表选择→导入」传目录）——
   * 适配器须自行按 sessionId 解析，两条路径结果必须同构。 */
  readSubagents?(dbPath: string, sessionId: string): RawInteraction[];
  /** 子代理工具调用归属映射（toolUseId → subagentSessionId），技能归因专用
   * （claude meta.json 契约）；无此数据结构的源不实现。 */
  collectSubagentToolUseMap?(dbPath: string, sessionId: string): Map<string, string>;
  /** 从源文件提取 agent CLI 版本号（Session.version 候选）。dbPath 为目录时
   * 用 sessionId 解析到具体文件（无 sessionId 则按文件直读）。 */
  extractVersion?(dbPath: string, sessionId?: string): string | null;
  /** 文件级识别（browse-directory 的 importableType 判定）。注册表声明序
   * 即优先级——前缀精确嗅探（rollout-/cannbot_session_）必须排在扩展名
   * 兜底（claude-jsonl）之前。 */
  sniffFile?(fileName: string): boolean;
  /** 内容级识别（registry.resolveSource 的探测依据）：读文件头判定本源
   * 是否认领。true = 认领；false = 明确不认领（触发族内兄弟纠偏）；
   * null = 无法判定（读不出/无有效行，信任声明值）。指纹规则框架自持
   * ——与 sniffFile（文件名级）、injections/（行级）同一哲学的高一层。 */
  detectContent?(filePath: string): boolean | null;
  /** 文件路径 → 会话 id 推导（导入时 sessionId 缺省的服务端兜底）。输入是
   * 完整路径——规则自持：多数源只看文件名（内部自行 basename），DSH 的 id
   * 是日志父目录名（文件名固定代际名，取不到 id）。规则与 listSessions
   * 内部推导同源导出，UI/调用方不再各自复制（漂移会让同一会话以双身份
   * 入库）。认不出命名约定时返回 null。 */
  deriveSessionId?(filePath: string): string | null;
}
