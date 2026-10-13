// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details.
// You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex 框架的 user 行注入指纹（agent-source-framework 原则 1：指纹规则
// 框架自持）。消费方：codex-jsonl 适配器（原生 rollout）与 injections/
// index.ts（codex-proxy 捕获，经 claude 布局入口分发）——两条路径用同一
// 分类器，时间线形状一致。
// 真机 0.161 指纹全集：user=<environment_context> / # AGENTS.md instructions /
// <user_instructions> / <codex_internal_context> / <subagent_notification> /
// <turn_aborted>。两类处置（D1 修订）：
//  - 静态注入（环境快照/指令回显/内部上下文）→ 丢弃，不进时间线——claude
//    剥离 system-reminder 同款语义；wire 原文永远在盘上
//  - 事件注入（子代理通知/轮中止）→ system turn（可观测的会话事件）
import type { UserInjectionClassifier, UserInjectionDecision } from '../contract';

export type CodexInjectionKind =
  | 'environment'
  | 'agents-md'
  | 'user-instructions'
  | 'codex-internal'
  | 'subagent-notification'
  | 'turn-aborted';

export function classifyCodexUserInjectionKind(raw: string): CodexInjectionKind | null {
  if (raw.startsWith('<environment_context>')) return 'environment';
  if (raw.startsWith('# AGENTS.md instructions')) return 'agents-md';
  if (raw.startsWith('<subagent_notification>')) return 'subagent-notification';
  if (raw.startsWith('<user_instructions>')) return 'user-instructions';
  if (raw.startsWith('<codex_internal_context')) return 'codex-internal';
  if (raw.startsWith('<turn_aborted>')) return 'turn-aborted';
  return null;
}

// 静态注入丢弃判定（false = 事件类，保留 system turn）
export function isDroppedCodexInjection(kind: CodexInjectionKind): boolean {
  return kind !== 'subagent-notification' && kind !== 'turn-aborted';
}

// 源文件核实（真机 0.161）：status.<state> 的值是纯字符串——子代理最终
// 消息全文，且与子代理时间线最终轮逐字节相同；不是 {completed: text} 嵌套
// 对象（初版误判，走了 JSON.stringify 兜底 → 引号 + \n 转义 + 截断三连）。
// 通知只做事件提示 + 预览：全文在子代理最终轮，不在此复制。
export function summarizeSubagentNotification(raw: string): string {
  const inner = raw.replace(/^<subagent_notification>\s*/, '').replace(/\s*<\/subagent_notification>\s*$/, '');
  try {
    const parsed = JSON.parse(inner) as { agent_path?: string; status?: Record<string, unknown> };
    const agent = parsed.agent_path ?? '未知';
    const firstStatus = parsed.status ? Object.entries(parsed.status)[0] : null;
    if (!firstStatus) return `✅ 子代理完成: ${agent}`;
    const [state, detail] = firstStatus;
    const text = typeof detail === 'string'
      ? detail
      : typeof (detail as { completed?: string } | undefined)?.completed === 'string'
        ? (detail as { completed: string }).completed
        : detail == null ? '' : JSON.stringify(detail);
    if (!text) return `✅ 子代理完成: ${agent} [${state}]`;
    const preview = text.length > 200
      ? `${text.slice(0, 200)}…（全文 ${text.length} 字，见该子代理的最终回复）`
      : text;
    return `✅ 子代理完成: ${agent} [${state}]\n${preview}`;
  } catch {
    return `✅ 子代理通知: ${raw.slice(0, 160)}`;
  }
}

// codex 契约分类器：静态注入 drop，事件注入 system turn（通知摘要化，
// claude task-notification 同款；轮中止保留原文）
export const classifyCodexUserInjection: UserInjectionClassifier = (raw): UserInjectionDecision | null => {
  const kind = classifyCodexUserInjectionKind(raw);
  if (!kind) return null;
  if (isDroppedCodexInjection(kind)) return { action: 'drop', kind };
  const content = kind === 'subagent-notification' ? summarizeSubagentNotification(raw) : raw;
  return { action: 'system-turn', kind, content };
};
