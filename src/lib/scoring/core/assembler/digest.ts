// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 轨迹摘要（LLM 评审的唯一轨迹材料）：不截尾——实测轨迹结尾信息最关键
//（最终干成什么样全写在结尾），截尾最伤效果（设计 §9 输入侧纪律）。

import { extractFilePath, parseWriteLines } from '@/lib/file-restore';
import { isCompactionMarkerTurn } from '../compaction';
import type { BridgeRow } from './collect';
import type { ScoreToolCall, ScoreTurn } from './types';

const ROLE_TAG: Record<string, string> = { user: '👤', system: '⚙', assistant: '🤖' };

function turnLines(turns: ScoreTurn[]): string[] {
  const filtered = turns.filter(t => !t.isSubagent && (t.role === 'assistant' || t.role === 'user' || t.role === 'system'));
  const baseTime = filtered.find(t => t.createdAtTsISO ?? t.createdAtISO)?.createdAtTsISO
    ?? filtered.find(t => t.createdAtTsISO ?? t.createdAtISO)?.createdAtISO
    ?? null;
  const baseMs = baseTime ? new Date(baseTime).getTime() : 0;

  return filtered.map(t => {
    const ts = t.createdAtTsISO ?? t.createdAtISO;
    const relMin = baseMs > 0 && ts ? `${((new Date(ts).getTime() - baseMs) / 60000).toFixed(1)}min` : '-';
    const content = (t.contentSummary ?? t.content ?? '').substring(0, 200).replace(/\s+/g, ' ');
    const tok = t.totalTokens > 0 ? `tok:${t.totalTokens}` : '';
    const lat = t.latencyMs > 100 ? `lat:${(t.latencyMs / 1000).toFixed(1)}s` : '';
    // 压缩标记轮标注：让 LLM 评审知道这是压缩摘要/边界，不是 agent 正常发言
    const compact = isCompactionMarkerTurn(t) ? '[compact] ' : '';
    return `#${t.turnIndex} ${ROLE_TAG[t.role] ?? t.role} +${relMin} ${tok} ${lat} ${compact}"${content}"`;
  });
}

function bridgeLines(bridges: BridgeRow[]): string[] {
  return bridges.map((b, i) => {
    const dispatch = (b.dispatchContent ?? '').substring(0, 100);
    const time = b.dispatchTimestamp ? new Date(b.dispatchTimestamp).toISOString().slice(11, 16) : '-';
    return `dispatch#${i} [${time}] [${b.subagentType ?? '-'}] [${b.subagentName ?? '-'}] "${dispatch}" → ${b.status} tok:${b.subagentTokens}`;
  });
}

/** 产出材料：写过的文件 + 最终内容摘要（D3 正确性评审的 diff 材料） */
function changeLines(toolCalls: ScoreToolCall[]): string[] {
  const lastWriteByFile = new Map<string, string>();
  const writeFamilies = new Set(['write', 'edit', 'edit1', 'multiedit']);
  for (const tc of toolCalls) {
    const n = tc.toolName.toLowerCase();
    if (!writeFamilies.has(n)) continue;
    const file = extractFilePath(tc.argsJson);
    if (!file) continue;
    lastWriteByFile.set(file, n === 'write' ? (tc.argsJson ?? '') : (lastWriteByFile.get(file) ?? tc.argsJson ?? ''));
  }
  const lines: string[] = [];
  for (const [file, argsJson] of lastWriteByFile) {
    const parsed = parseWriteLines(argsJson);
    if (!parsed) { lines.push(`${file}（增量写，全文不可见）`); continue; }
    const content = [...parsed.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const head = content.slice(0, 15).join('\n');
    lines.push(`${file}（${content.length} 行，首 15 行节选）\n${head}`);
  }
  return lines;
}

/** 提问工具交互（human-in-the-loop）：opencode `question` / claude-code `AskUserQuestion`。
 * 用户的答复由运行时以 tool_result 回填（不产生 user 轮）——这是真实用户输入、
 * 授权证据；单列一节让评审看见「问过什么、用户选了什么」，Turn 列表 200 字截断
 * 会把选择切掉（答复正文里用户的选择排在长问题引文之后）。 */
const ASK_TOOLS = new Set(['question', 'askuserquestion']);

function askLines(toolCalls: ScoreToolCall[]): string[] {
  const out: string[] = [];
  for (const tc of toolCalls) {
    if (tc.isSubagent || !ASK_TOOLS.has(tc.toolName.toLowerCase())) continue;
    const asks: string[] = [];
    const answers: string[] = [];
    try {
      const args = tc.argsJson ? JSON.parse(tc.argsJson) as { questions?: Array<{ question?: string; options?: Array<{ label?: string }> }> } : null;
      for (const q of args?.questions ?? []) {
        if (q.question) asks.push(q.question.replace(/\s+/g, ' ').slice(0, 120));
        const labels = (q.options ?? []).map(o => o.label).filter(Boolean);
        if (labels.length > 0) asks.push(`选项: ${labels.join(' / ').slice(0, 160)}`);
      }
    } catch { /* args 非法就只看答复 */ }
    const r = (tc.resultJson ?? '').replace(/\s+/g, ' ');
    // 配对提取 "问题"="选择"：整对消费避免把问题文本里的 ="…" 片段误当用户选择。
    // 两侧不设长度上限——上限会让超长问题/答复整对失配（D2 授权证据变成
    // 「无答复」静默丢失），展示截断由 m[2].slice 负责
    for (const m of r.matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)) answers.push(m[2].slice(0, 120));
    out.push(`§${tc.turnIndex} 问: ${asks.join(' | ') || '(参数不可解析)'} → 用户选: ${answers.join('；') || '(无答复)'}`);
  }
  return out;
}

export interface DigestParts {
  trajectoryDigest: string;
  userMessages: Array<{ turnIndex: number; text: string; at: string | null }>;
}

export function buildDigest(turns: ScoreTurn[], toolCalls: ScoreToolCall[], bridges: BridgeRow[]): DigestParts {
  const sections: string[] = [
    `## Turn 列表\n每条格式: #序号 role标记 +相对时间 tokens latency "摘要"\n${turnLines(turns).join('\n')}`,
  ];
  const al = askLines(toolCalls);
  if (al.length > 0) {
    sections.push(`## 用户交互（agent 提问工具 → 用户选择；运行时回填，等同用户消息）\n${al.join('\n')}`);
  }
  const bl = bridgeLines(bridges);
  if (bl.length > 0) sections.push(`## Subagent Dispatch 记录\n${bl.join('\n')}`);
  const cl = changeLines(toolCalls);
  if (cl.length > 0) sections.push(`## 产出文件（最终内容节选）\n${cl.join('\n---\n')}`);

  const userMessages = turns
    .filter(t => t.role === 'user' && !t.isSubagent)
    .map(t => ({ turnIndex: t.turnIndex, text: (t.content ?? t.contentSummary ?? '').slice(0, 2000), at: t.createdAtTsISO ?? t.createdAtISO }));

  return { trajectoryDigest: sections.join('\n\n'), userMessages };
}
