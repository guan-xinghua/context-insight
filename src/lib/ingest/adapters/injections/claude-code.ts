// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details.
// You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-code 框架的 user 行注入指纹（agent-source-framework 原则 1：指纹
// 规则框架自持）。消费方：claude-jsonl 适配器（native 会话 + claude 布局
// proxy 捕获的默认族）经 injections/index.ts 分发，见各函数注释。
import type { UserInjectionClassifier, UserInjectionContext, UserInjectionDecision } from '../contract';
import { truncateUtf16Safe } from '../../../shared/text-strip';

// Parse a <task-notification> XML (Task-tool completion notification injected
// as a user line by claude-code) into a readable summary.
export function parseTaskNotificationSummary(content: string): string {
  const status = content.match(/<status>([^<]*)<\/status>/)?.[1]?.trim();
  const summary = content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
  const agent = summary?.match(/Agent "([^"]*)"/)?.[1];
  const label = agent ? `Task: ${agent}` : 'Task 完成';
  const statusLabel = status ? ` [${status}]` : '';
  const detail = summary ? `\n${truncateUtf16Safe(summary, 200)}` : '';
  return `✅ ${label}${statusLabel}${detail}`;
}

// ── Agent 注入分类（claude-code ≥2.1 新协议，非人类输入）──
// 逐条指纹识别，不按版本分支（协议灰度/混合会话天然兼容；版本号仅作展示
// 徽标）。新协议（claude-code ≥2.1 handback）：子代理完成 → <transcript>
// 全量回放给主代理做 block rules 安全审查 → 主代理 <block> 决策 →
// <system-reminder> 背景事件（内嵌旧版 task-notification XML，带
// "NOT USER INPUT" 自声明）。这些注入在 wire 上是 user 消息，但一不含
// 人类输入、二复制子代理已有内容（回放/背景事件内嵌 result 均为子代理
// 捕获的复制品）——重分类为 system turn 并摘要化，原文留在捕获文件
// （wire-rounds API 按需可查）。
// 指纹精确性护栏：背景事件必须同时满足"NOT USER INPUT 自声明"与"整条
// 消息剥掉 system-reminder 块后为空"——真实用户提示内嵌的 reminder
// （无自声明）不误判，user turn 原样保留。
export type AgentInjectionKind =
  | 'handback-replay'
  | 'background-event'
  | 'label-request'
  | 'state-query';

export interface AgentInjection {
  kind: AgentInjectionKind;
  summary: string;
}

export function classifyAgentInjection(raw: string): AgentInjection | null {
  if (raw.startsWith('<transcript>')) {
    const end = raw.indexOf('</transcript>');
    const inner = end > 0 ? raw.slice('<transcript>'.length, end) : raw.slice('<transcript>'.length);
    // 自声明护栏：协议注入在 </transcript> 之后必带 block rules 审查指令
    // （"Err on the side of blocking" / <block> 决策说明）。真实用户粘协议
    // 样本提问（以 <transcript> 开头但无指令尾）不判注入，user turn 原样
    // 保留；逐字含指令尾的完整粘贴仍会命中——该残留误判面极小且代价可
    // 接受（DB 只存计数摘要，原文在捕获文件 / wire-rounds 可查）
    const tail = end > 0 ? raw.slice(end) : '';
    if (!/Err on the side of blocking|<block>/.test(tail)) return null;
    const jsonLines = inner.split('\n').filter(l => l.trim().startsWith('{'));
    return {
      kind: 'handback-replay',
      summary: `[transcript 回放] ${jsonLines.length} 行子代理记录——安全审查用副本，原文见子代理捕获`,
    };
  }
  if (raw.includes('NOT USER INPUT') && raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() === '') {
    const notif = raw.match(/<task-notification>([\s\S]*?)<\/task-notification>/)?.[1];
    const parsed = notif ? parseTaskNotificationSummary(notif) : null;
    return {
      kind: 'background-event',
      summary: `[背景事件] ${parsed ?? truncateUtf16Safe(raw, 160)}`,
    };
  }
  if (raw.startsWith('2-4 word lowercase label')) {
    return {
      kind: 'label-request',
      summary: `[label 请求] ${truncateUtf16Safe(raw, 120)}`,
    };
  }
  if (raw.startsWith('Current state: ')) {
    return {
      kind: 'state-query',
      summary: `[状态查询] ${raw.split('\n')[0]}`,
    };
  }
  return null;
}

// skill 注入指纹（claude-code Skills 机制；opencode ≥1.17 同款格式，故
// opencode 家族分类器复用本谓词）。Markers: <skill-format> / 'Base directory
// for this skill' / 'Launching skill' distinguish skill injections from /compact.
// 谓词本体移至 @/lib/tool-conventions（读侧 turn-split 斜杠命令计数共用），
// 此处 re-export 保持原引用面（claude-jsonl / opencode 分类器不改）。
import { isSkillInjectionText } from '../../../tool-conventions';
export { isSkillInjectionText };

// skill 注入首条例外：此前无任何记录的会话首条不重分类、保持 user——
// opencode ≥1.17 把 skill 规程自动注入为首条消息（规程 + Base directory
// 尾部 + 用户请求同条），重分类成 system 会让同内容会话的 turn0 角色随
// opencode 版本漂移。user prompt 之后的注入（claude-code 展开形态）仍走
// system + 合并。
function skillInjectionDecision(raw: string, ctx: UserInjectionContext): UserInjectionDecision | null {
  if (ctx.isFirstTurn || !isSkillInjectionText(raw)) return null;
  // 原样保留：skill-merge 后处理会把它折进前一个 Skill tool_call 的
  // resultJson（内容必须 verbatim 才能当工具结果）
  return { action: 'system-turn', kind: 'skill', content: raw };
}

// claude-code 契约分类器：task-notification / ≥2.1 协议注入 / skill 注入
// （次序即优先级，指纹互斥）。全部为事件类 → system turn；claude-code 的
// 注入都携带可辨识事件语义，无静态丢弃类（system-reminder 是 user 消息
// 内嵌块，渲染层拆分，不走注入分类）。
export const classifyClaudeCodeUserInjection: UserInjectionClassifier = (raw, ctx) => {
  if (raw.startsWith('<task-notification>')) {
    return { action: 'system-turn', kind: 'task-notification', content: parseTaskNotificationSummary(raw) };
  }
  const agentInjection = classifyAgentInjection(raw);
  if (agentInjection) {
    return { action: 'system-turn', kind: agentInjection.kind, content: agentInjection.summary };
  }
  return skillInjectionDecision(raw, ctx);
};
