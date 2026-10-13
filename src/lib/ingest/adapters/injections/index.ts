// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details.
// You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 注入分类分发（agent-source-framework 原则 1 的接线层）。
// cpx 把所有框架的捕获归一成 claude 布局，claude-jsonl 适配器因此成为
// 通用格式入口——但注入指纹是框架语义（codex 的 <environment_context> 不
// 该被 claude 的 skill 指纹误伤，反之亦然）。本层按行级 source 标记推导
// agent 框架，分发到原框架的分类器；入口适配器零框架分支。
// 新框架接入 = injections/<framework>.ts + 下方分发表一行。
import { agentFrameworkOf } from '@/lib/shared/session-format';
import type { UserInjectionClassifier, UserInjectionContext, UserInjectionDecision } from '../contract';
import { classifyClaudeCodeUserInjection } from './claude-code';
import { classifyCodexUserInjection } from './codex';
import { classifyOpencodeFamilyUserInjection } from './opencode';

// 框架 → 分类器。claude 双键（'claude' / 'claude-code'）：行级标记用 legacy
// 短形 'claude-proxy'（agentFrameworkOf 剥后缀得 'claude'），Session.framework
// 值域用 'claude-code'。未列举框架（含 legacy 未知 *-proxy 标记）回落
// claude-code 默认族——保守兜底，行为与历史一致（早期捕获全是 claude）。
const FRAMEWORK_CLASSIFIERS: Record<string, UserInjectionClassifier> = {
  'claude': classifyClaudeCodeUserInjection,
  'claude-code': classifyClaudeCodeUserInjection,
  'codex': classifyCodexUserInjection,
  'opencode': classifyOpencodeFamilyUserInjection,
  'cannbot': classifyOpencodeFamilyUserInjection,
};

// source 值域：undefined（native 会话）| '<framework>-proxy'（cpx 捕获行级
// 标记，proxy-classify MARKER_FRAMEWORK_MAP 同源）| 'insight-export'（再导出）。
// 非 *-proxy 一律走 claude-code（native claude 会话无标记；insight-export 是
// claude 布局再导出）。
export function classifyUserInjection(
  source: string | undefined,
  raw: string,
  ctx: UserInjectionContext,
): UserInjectionDecision | null {
  if (typeof source !== 'string' || !source.endsWith('-proxy')) {
    return classifyClaudeCodeUserInjection(raw, ctx);
  }
  const framework = agentFrameworkOf(source) ?? 'claude-code';
  const classifier = FRAMEWORK_CLASSIFIERS[framework] ?? classifyClaudeCodeUserInjection;
  return classifier(raw, ctx);
}
