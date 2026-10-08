// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工作流声明（已定：从 context 读）。proxy 捕获的 system prompt 与 memory
//（CLAUDE.md）里已有声明内容，扩展层（claude-jsonl-full-context）已在提取；
// 这里只做"声明段落 → WorkflowDeclaration"的解析。无捕获数据 → null，
// 相关子项 not-applicable（设计 §7 已定项）。

import type { FullContext } from '@/lib/ingest/adapters/claude-jsonl-full-context';
import type { WorkflowDeclaration } from './types';

const MAX_SECTION_CHARS = 4000;

/** 取 markdown 里标题命中关键词的段落（标题 + 到下一个同级/更高级标题前的正文） */
function extractSections(text: string, keywordRe: RegExp): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const sections: string[] = [];
  let current: { level: number; buf: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      if (current) {
        if (m[1].length <= current.level) {
          sections.push(current.buf.join('\n'));
          current = null;
        }
      }
      if (!current && keywordRe.test(m[2])) {
        current = { level: m[1].length, buf: [line] };
      }
      continue;
    }
    if (current) current.buf.push(line);
  }
  if (current) sections.push(current.buf.join('\n'));
  return sections
    .map(s => s.slice(0, MAX_SECTION_CHARS))
    .filter(s => s.trim().length > 0);
}

const ACCEPT_RE = /验收|测试用例清单|交付标准|acceptance/i;
const REDLINE_RE = /红线|禁止|不得|严禁|不得违反|redline/i;
export const OPERATOR_TAG_RE = /算子|operator|op 开发|kernel/i;

export function parseWorkflowDeclaration(full: FullContext | null): WorkflowDeclaration | null {
  if (!full) return null;
  const memory = full.memoryFiles ?? '';
  const system = full.systemPrompt ?? '';
  const declText = memory.length >= system.length ? memory : `${memory}\n\n${system}`;

  const acceptance = extractSections(memory, ACCEPT_RE).join('\n\n') || undefined;
  const redlines = extractSections(declText, REDLINE_RE).join('\n\n') || undefined;
  const taskTypeTags = OPERATOR_TAG_RE.test(declText) ? ['operator'] : undefined;

  if (!acceptance && !redlines && !taskTypeTags) return null;
  return { acceptance, redlines, taskTypeTags, source: 'context' };
}
