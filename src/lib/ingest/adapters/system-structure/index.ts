// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 系统提示结构分发层（agent-source-framework 原则 1 的读侧接线，设计见
// §2.5c）。与 injections/ 同构：cpx 把所有框架的捕获归一成 claude 布局，
// 系统提示的结构段（memory / skills）与结构化解析是框架语义——通用读侧
// （readFullContext / readAvailableSkills）若按格式试探序嗅探（先 xml 后
// claude-list），每接一个新框架就多一次嗅探分支且异框架标记可能误配。
// 本层按捕获的行级 source 标记推导框架，分发到原框架的结构提取器；
// 消费侧零框架分支。
// 新框架接入 = system-structure/<framework>.ts + 下方分发表一行。
//
// 两类消费（同一提取器，形状不同）：
//   - 原文段（findSkillsSection / findMemorySection）→ readFullContext 的
//     FullContext.skills / memoryFiles（verbatim 呈现）
//   - 结构化（parseAvailableSkills → AvailableSkill[]）→ readAvailableSkills
//     （Skill 覆盖度全集）
import { agentFrameworkOf } from '@/lib/shared/session-format';
import type { AvailableSkill } from '@/lib/skill-coverage';
import type { ClaudeJsonlLine } from '../claude-jsonl';
import * as claudeCode from './claude-code';
import * as codex from './codex';
import * as opencode from './opencode';

/** skills 全集的注入格式（覆盖度 API 的 listFormat 值域）。 */
export type SkillsListFormat = 'claude-list' | 'opencode-xml' | 'codex-list';

export interface SystemStructureExtractor {
  /** skills 段原文（框架原生标记圈定；无段返回 ''）。 */
  findSkillsSection(text: string): string;
  /** memory 段原文（框架无记忆段时恒返回 ''——语义结论，见各模块头）。 */
  findMemorySection(text: string): string;
  /** skills 段结构化（覆盖度全集；无段返回 []）。 */
  parseAvailableSkills(text: string): AvailableSkill[];
  /** 该框架 skills 注入的 listFormat 标识。 */
  listFormat: SkillsListFormat;
}

const claudeCodeExtractor: SystemStructureExtractor = {
  findSkillsSection: claudeCode.findSkillsSection,
  findMemorySection: claudeCode.findMemorySection,
  parseAvailableSkills: claudeCode.parseClaudeAvailableSkills,
  listFormat: 'claude-list',
};

const codexExtractor: SystemStructureExtractor = {
  findSkillsSection: codex.findSkillsSection,
  findMemorySection: codex.findMemorySection,
  parseAvailableSkills: codex.parseCodexAvailableSkills,
  listFormat: 'codex-list',
};

const opencodeFamilyExtractor: SystemStructureExtractor = {
  findSkillsSection: opencode.findSkillsSection,
  findMemorySection: opencode.findMemorySection,
  parseAvailableSkills: opencode.parseOpencodeAvailableSkills,
  listFormat: 'opencode-xml',
};

// 框架 → 提取器。claude 双键（'claude' / 'claude-code'）：行级标记用 legacy
// 短形 'claude-proxy'（agentFrameworkOf 剥后缀得 'claude'），Session.framework
// 值域用 'claude-code'。cannbot 是 opencode 家族（同 injections/ 口径）。
// 未列举框架回落 claude-code 默认族——保守兜底，与历史行为一致。
const FRAMEWORK_EXTRACTORS: Record<string, SystemStructureExtractor> = {
  'claude': claudeCodeExtractor,
  'claude-code': claudeCodeExtractor,
  'codex': codexExtractor,
  'opencode': opencodeFamilyExtractor,
  'cannbot': opencodeFamilyExtractor,
};

/** 框架 → 结构提取器（未列举回落 claude-code 默认族）。 */
export function systemStructureOf(framework: string | null | undefined): SystemStructureExtractor {
  return FRAMEWORK_EXTRACTORS[framework ?? ''] ?? claudeCodeExtractor;
}

/** 捕获行 → 框架：首个 `*-proxy` 行级 source 标记经 agentFrameworkOf 归一
 * （codex-proxy → codex）；native 会话无标记 → claude-code 默认族。与
 * injections/index.ts 的行级分发同信号同口径。 */
export function frameworkFromLines(lines: ClaudeJsonlLine[]): string {
  for (const line of lines) {
    const s = line.source;
    if (typeof s === 'string' && s.endsWith('-proxy')) {
      return agentFrameworkOf(s) ?? 'claude-code';
    }
  }
  return 'claude-code';
}
