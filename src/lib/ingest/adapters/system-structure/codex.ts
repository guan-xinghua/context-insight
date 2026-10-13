// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex 系统提示结构提取（system-structure 层，设计见 agent-source-framework
// §2.5c）。真机依据（codex 0.161 → volcano 网关，146 请求全量 dump 核实）：
// 系统提示 = input 前部两条 developer 消息，第二条携带
// `<skills_instructions>…</skills_instructions>` 闭合块（其后紧随
// `<permissions instructions>`，同消息内）+ codex 基座提示词。skills 块结构：
//   ### Skill roots        `- \`rN\` = \`/abs/path\`` 根表（可多个）
//   ### Available skills   `- name: description (file: rN/name/SKILL.md)`
// memory 恒空：codex 的 AGENTS.md 走 user 消息注入（D1 静态注入，导入时
// 丢弃），系统提示无记忆段——返回空串是语义结论而非未实现。

import type { AvailableSkill } from '@/lib/skill-coverage';

const CODEX_SKILLS_OPEN = '<skills_instructions>';
const CODEX_SKILLS_CLOSE = '</skills_instructions>';
const CODEX_ROOTS_HEADER = '### Skill roots';
const CODEX_AVAILABLE_HEADER = '### Available skills';

/** skills 段：`<skills_instructions>` 闭合块原文（未闭合降级取到文末——
 * verbatim 呈现优先保完整）。 */
export function findSkillsSection(text: string): string {
  const open = text.indexOf(CODEX_SKILLS_OPEN);
  if (open < 0) return '';
  const close = text.indexOf(CODEX_SKILLS_CLOSE, open);
  const end = close >= 0 ? close + CODEX_SKILLS_CLOSE.length : text.length;
  return text.substring(open, end).trim();
}

/** memory 段：恒空（AGENTS.md 走 user 消息，见模块头）。 */
export function findMemorySection(_text: string): string {
  return '';
}

/** skills 段结构化：解析根表 + 条目，`(file: rN/…)` 相对路径经根表展开为
 * 绝对路径（根表与条目同块，确定性展开；未知根保留原值）。 */
export function parseCodexAvailableSkills(text: string): AvailableSkill[] {
  const block = findSkillsSection(text);
  if (!block) return [];

  // 根表：### Skill roots 之后的 `- `rN` = `/path`` 行（到下一个 ### 节）
  const roots = new Map<string, string>();
  const rootsIdx = block.indexOf(CODEX_ROOTS_HEADER);
  const availableIdx = block.indexOf(CODEX_AVAILABLE_HEADER);
  if (rootsIdx >= 0) {
    const rootsEnd = availableIdx > rootsIdx ? availableIdx : block.length;
    const rootRe = /^-\s+`([^`]+)`\s*=\s*`([^`]+)`/;
    for (const raw of block.substring(rootsIdx, rootsEnd).split('\n')) {
      const m = raw.trim().match(rootRe);
      if (m) roots.set(m[1], m[2]);
    }
  }

  const out: AvailableSkill[] = [];
  const seen = new Set<string>();
  if (availableIdx < 0) return out;
  for (const raw of block.substring(availableIdx).split('\n').slice(1)) {
    const line = raw.trim();
    if (line === '') {
      if (out.length > 0) break;
      continue;
    }
    if (!line.startsWith('- ')) {
      if (out.length > 0) break;
      continue;
    }
    const entry = line.slice(2);
    const colonIdx = entry.indexOf(': ');
    if (colonIdx <= 0) continue;
    const name = entry.slice(0, colonIdx).trim();
    let description = entry.slice(colonIdx + 2).trim();
    let origin: string | null = null;
    const fileMatch = description.match(/\s\(file: (.+?)\)\.?$/);
    if (fileMatch) {
      const rel = fileMatch[1];
      const rootKey = rel.split('/')[0];
      const root = roots.get(rootKey);
      origin = root ? rel.replace(`${rootKey}/`, `${root}/`) : rel;
      description = description.slice(0, fileMatch.index ?? 0).trim();
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description, origin });
  }
  return out;
}
