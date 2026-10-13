// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 家族（opencode / cannbot）系统提示结构提取（system-structure 层，
// 设计见 agent-source-framework §2.5c）。parseOpencodeAvailableSkills 迁自
// skill-coverage.ts；结构段提取的段语义对齐 cpx 的 opencode-context-parser
// （受控双实现的读侧对应物）：
//   memory   `Instructions from: <path>` 块（AGENTS.md 等，多个），内容至
//            下一 `Instructions from:` 或 `<available_skills>`
//   skills   `<available_skills><skill>…</skill></available_skills>` 闭合块

import type { AvailableSkill } from '@/lib/skill-coverage';

const OPENCODE_SKILLS_OPEN = '<available_skills>';
const OPENCODE_SKILLS_CLOSE = '</available_skills>';
const OPENCODE_MEMORY_MARKER = 'Instructions from:';

/** skills 段：`<available_skills>` 闭合块原文（未闭合降级取到文末）。 */
export function findSkillsSection(text: string): string {
  const open = text.indexOf(OPENCODE_SKILLS_OPEN);
  if (open < 0) return '';
  const close = text.indexOf(OPENCODE_SKILLS_CLOSE, open);
  const end = close >= 0 ? close + OPENCODE_SKILLS_CLOSE.length : text.length;
  return text.substring(open, end).trim();
}

/** memory 段：自首个 `Instructions from:` 至 `<available_skills>` 或文末
 * （多个记忆文件连排，原文形态——消费侧 verbatim 呈现）。 */
export function findMemorySection(text: string): string {
  const mIdx = text.indexOf(OPENCODE_MEMORY_MARKER);
  if (mIdx < 0) return '';
  const skillsIdx = text.indexOf(OPENCODE_SKILLS_OPEN, mIdx);
  const end = skillsIdx > mIdx ? skillsIdx : text.length;
  return text.substring(mIdx, end).trim();
}

/** skills 段结构化：`<skill><name>/<description>/<location>` XML 条目。 */
export function parseOpencodeAvailableSkills(text: string): AvailableSkill[] {
  const openIdx = text.indexOf(OPENCODE_SKILLS_OPEN);
  if (openIdx < 0) return [];
  const closeIdx = text.indexOf(OPENCODE_SKILLS_CLOSE, openIdx);
  const block = closeIdx >= 0 ? text.slice(openIdx, closeIdx) : text.slice(openIdx);
  const out: AvailableSkill[] = [];
  const seen = new Set<string>();
  const re = /<skill>([\s\S]*?)<\/skill>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const body = m[1];
    const name = body.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() ?? '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = body.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() ?? '';
    const origin = body.match(/<location>([\s\S]*?)<\/location>/)?.[1]?.trim() ?? null;
    out.push({ name, description, origin });
  }
  return out;
}
