// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-code 系统提示结构提取（system-structure 层，设计见
// agent-source-framework §2.5c）。findMemorySection / findSkillsSection 迁自
// claude-jsonl.ts，parseClaudeAvailableSkills 迁自 skill-coverage.ts——框架
// 结构知识归位框架模块（原则 1；与 injections/ 同构的读侧对偶）。
// 纯函数、无 fs：结构段以原文形态返回（消费侧 verbatim 呈现），
// 结构化解析产出共享域类型 AvailableSkill（skill-coverage 的覆盖度域词汇）。

import type { AvailableSkill } from '@/lib/skill-coverage';

const CLAUDE_MEMORY_MARKER = '# claudeMd';
const CLAUDE_SKILLS_MARKER = 'The following skills are available';

/** memory 段：`# claudeMd` 起至下一节标记（`# currentDate` /
 * `</system-reminder>` / 文末）。native claude jsonl 的系统文本在 message
 * 行里，段边界由这些 claude 原生标记决定。 */
export function findMemorySection(text: string): string {
  const mIdx = text.indexOf(CLAUDE_MEMORY_MARKER);
  if (mIdx < 0) return '';
  const after = mIdx + CLAUDE_MEMORY_MARKER.length;
  let end = text.indexOf('# currentDate', after);
  if (end < 0) end = text.indexOf('</system-reminder>', after);
  if (end < 0) end = text.length;
  return text.substring(after, end).trim();
}

/** skills 段：claude 的可用技能列表注入，自 `The following skills are
 * available` 起至文末（列表是系统提示的尾段，实测无后继标记）。 */
export function findSkillsSection(text: string): string {
  const sIdx = text.indexOf(CLAUDE_SKILLS_MARKER);
  if (sIdx < 0) return '';
  return text.substring(sIdx).trim();
}

/** skills 段结构化：`- name: description (from origin)` 列表条目。
 * 首个非列表行终止（列表后无延续内容）。 */
export function parseClaudeAvailableSkills(text: string): AvailableSkill[] {
  const markerIdx = text.indexOf(CLAUDE_SKILLS_MARKER);
  if (markerIdx < 0) return [];
  const after = text.slice(markerIdx);
  const lines = after.split('\n');
  const out: AvailableSkill[] = [];
  const seen = new Set<string>();
  for (const raw of lines.slice(1)) {
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
    const fromMatch = description.match(/\s\(from (.+?)\)\.?$/);
    if (fromMatch) {
      origin = fromMatch[1];
      description = description.slice(0, fromMatch.index ?? 0).trim();
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description, origin });
  }
  return out;
}
