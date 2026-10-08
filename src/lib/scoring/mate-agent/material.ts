// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Mate Agent（独立第二评审器）物料导出：把会话原始数据落到一个目录，供 claude/opencode
// 用 Read/Grep/Glob 自己取证。复用 collectForScoring 的口径——与代码评分读同一份数据。

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PrismaClient } from '@prisma/client';
import { collectForScoring } from '../core/assembler/collect';
import { parseJsonlLines, listSubagentSessions, extractSystemText } from '@/lib/ingest/adapters/claude-jsonl';
import { readAvailableSkills, type FullContext } from '@/lib/ingest/adapters/claude-jsonl-full-context';

const truncate = (s: string | null | undefined, max: number): string => {
  if (s == null) return '';
  return s.length > max ? s.slice(0, max) + `…（截断，原长 ${s.length}）` : s;
};

export interface MaterialFiles {
  dir: string;
}

export function safeId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}

const WRITE_FAMILY = new Set(['write', 'edit', 'edit1', 'multiedit']);
const TODO_FAMILY = new Set(['todowrite', 'todo_write', 'todo']);

/** 维度切片：按维度过滤工具白名单 / turn 范围 / 是否带 bridges / 是否带项目说明 */
interface DimensionSlice {
  tools: string[] | null;               // null = 不过滤（全量）；[] = 不含 toolcalls；[...] = 白名单
  turns: 'root' | 'user' | 'all';       // root=非子代理 / user=仅用户 / all=全部
  bridges: boolean;
  /** 项目说明（CLAUDE.md 等注入）：D1 验收清单 / D2 红线声明的对账材料 */
  memory: boolean;
}

const SLICES: Record<string, DimensionSlice> = {
  D1: { tools: [...TODO_FAMILY, 'bash', ...WRITE_FAMILY], turns: 'root', bridges: true, memory: true },
  // D2 白名单必须带提问工具：用户答复（tool_result 回填）是授权证据——漏了它，
  // 高危操作的授权链评审看不见，只能按"无用户消息"误判自作主张（现场 §f5fe259d）
  D2: { tools: ['bash', ...WRITE_FAMILY, 'question', 'askuserquestion'], turns: 'root', bridges: false, memory: true },
  D3: { tools: ['bash', ...WRITE_FAMILY], turns: 'root', bridges: false, memory: false },
  D5: { tools: [], turns: 'root', bridges: true, memory: false },
  D6: { tools: [], turns: 'user', bridges: false, memory: false },
};

export const sliceOf = (dimension?: string): DimensionSlice =>
  dimension ? (SLICES[dimension] ?? { tools: null, turns: 'all', bridges: true, memory: true }) : { tools: null, turns: 'all', bridges: true, memory: true };

/** turn 过滤谓词（root=非子代理 / user=仅用户 / all=全部） */
export function turnPredicate(dimension?: string): (t: { isSubagent: boolean; role: string }) => boolean {
  const slice = sliceOf(dimension);
  return t => (slice.turns === 'root' ? !t.isSubagent : slice.turns === 'user' ? (!t.isSubagent && t.role === 'user') : true);
}

/** 工具过滤谓词（null=全量 / []=空 / [...]=白名单） */
export function toolPredicate(dimension?: string): (tc: { toolName: string }) => boolean {
  const slice = sliceOf(dimension);
  const tools = slice.tools;
  return tools == null ? () => true : tc => tools.includes(tc.toolName.toLowerCase());
}

function turnLine(t: { turnIndex: number; role: string; isSubagent: boolean; agentName: string | null; model: string | null; totalTokens: number; latencyMs: number; contentSummary: string | null; content: string | null }): string {
  return JSON.stringify({
    turnIndex: t.turnIndex,
    role: t.role,
    isSubagent: t.isSubagent,
    agentName: t.agentName,
    model: t.model,
    tokens: t.totalTokens,
    latencyMs: t.latencyMs,
    summary: truncate(t.contentSummary, 2000),
    content: truncate(t.content, 4000),
  });
}

function toolLine(tc: { turnIndex: number; toolName: string; isSubagent: boolean; agentName: string | null; argsJson: string | null; resultJson: string | null }): string {
  // 提问工具的 resultJson 保尾：用户答复（"Q"="选择"）排在复述的问题之后，
  // 截头会把授权证据切掉——D2 授权对账靠它
  const askTool = /^(question|askuserquestion)$/i.test(tc.toolName);
  const keepTail = (s: string | null, max: number): string => {
    if (s == null || s.length <= max) return s ?? '';
    return `…（截头，原长 ${s.length}）${s.slice(-max)}`;
  };
  return JSON.stringify({
    turnIndex: tc.turnIndex,
    toolName: tc.toolName,
    isSubagent: tc.isSubagent,
    agentName: tc.agentName,
    argsJson: truncate(tc.argsJson, 2000),
    resultJson: askTool ? keepTail(tc.resultJson, 1500) : truncate(tc.resultJson, 1500),
  });
}

/**
 * system 上下文汇总（D1/D2 对账材料的兜底来源）：验收清单/红线不一定在项目说明或
 * 首条用户消息里——opencode 把 workspace 约束与 skills 指令塞 system prompt（memory
 * 扩展字段为空），subagent 还有自己的 AGENTS.md/提示词。三处都截选进来。
 */
function buildSystemContext(sourcePath: string | null, taskId: string, fullContext: FullContext | null): string | null {
  if (!sourcePath) return null;
  const sections: string[] = [];
  const sys = (fullContext?.systemPrompt ?? '').trim();
  if (sys) sections.push(`## 主链 system prompt（截选前 12000 / ${sys.length} 字符——workspace 约束与 skills 指令在此）\n${sys.slice(0, 12000)}`);
  const skills = readAvailableSkills(sourcePath)?.skills ?? [];
  if (skills.length > 0) {
    const lines = skills.map(s => `- ${s.name}：${s.description}`).join('\n');
    sections.push(`## 可用 skills（名 + 描述——验收/校验规则常在这里）\n${lines.slice(0, 8000)}`);
  }
  let budget = 12000;
  const subParts: string[] = [];
  try {
    for (const { id, filePath } of listSubagentSessions(sourcePath, taskId)) {
      if (budget <= 0) break;
      const subSys = parseJsonlLines(filePath)
        .map(l => extractSystemText(l.system as Parameters<typeof extractSystemText>[0]) ?? '')
        .find(Boolean);
      if (!subSys) continue;
      const piece = subSys.slice(0, Math.min(1500, budget));
      budget -= piece.length;
      subParts.push(`### ${id}\n${piece}`);
    }
  } catch {
    // 子会话捕获读不到就略过——主链材料不受影响
  }
  if (subParts.length > 0) sections.push(`## 子会话 system（subagent 各自的提示词/AGENTS.md 截选）\n${subParts.join('\n\n')}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

export interface ExportMaterialOptions {
  rootDir?: string;
  /** 维度切片（D1-D6）：过滤工具/turn 范围，写 <rootDir>/<taskId>/<dimension>-<runId>/ */
  dimension?: string;
}

export async function exportMaterial(
  taskId: string,
  prisma: PrismaClient,
  framework?: string,
  opts: ExportMaterialOptions = {},
): Promise<MaterialFiles> {
  const data = await collectForScoring(taskId, prisma, framework);
  if (!data) throw new Error(`会话不存在：${taskId}`);

  const slice = sliceOf(opts.dimension);
  const base = opts.rootDir ?? path.join(os.tmpdir(), 'cannbot-mate-agent');
  // 末级目录带 runId：同一 taskId+维度的两次运行（双客户端/同 sid 双框架）各写各的，
  // 不交错覆写；mode 0700——切片含代码与红线原文，不摊在共享 /tmp 里
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = opts.dimension
    ? path.join(base, safeId(taskId), `${opts.dimension}-${runId}`)
    : path.join(base, safeId(taskId), `all-${runId}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    return await writeMaterial(data, dir, slice, opts.dimension);
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function writeMaterial(
  data: NonNullable<Awaited<ReturnType<typeof collectForScoring>>>,
  dir: string,
  slice: DimensionSlice,
  dimension?: string,
): Promise<MaterialFiles> {

  await fs.writeFile(
    path.join(dir, 'session.json'),
    JSON.stringify(
      {
        taskId: data.session.taskId,
        framework: data.session.framework,
        model: data.session.model,
        version: data.session.version,
        startTime: data.session.startTime?.toISOString() ?? null,
        endTime: data.session.endTime?.toISOString() ?? null,
        totalTokens: data.session.totalTokens,
        totalLatencyMs: data.session.totalLatencyMs,
        subagentCount: data.executions.filter(e => e.isSubagent).length,
        finishReason: data.finishReason,
        interrupts: data.interrupts,
      },
      null,
      2,
    ),
    'utf-8',
  );

  const turns = data.turns.filter(turnPredicate(dimension));
  await fs.writeFile(path.join(dir, 'turns.jsonl'), turns.map(turnLine).join('\n'), 'utf-8');

  const toolcalls = data.toolCalls.filter(toolPredicate(dimension));
  await fs.writeFile(path.join(dir, 'toolcalls.jsonl'), toolcalls.map(toolLine).join('\n'), 'utf-8');

  if (slice.bridges) {
    const bridges = data.bridges.map(b =>
      JSON.stringify({
        dispatchContent: truncate(b.dispatchContent, 2000),
        dispatchTimestamp: b.dispatchTimestamp,
        subagentType: b.subagentType,
        subagentName: b.subagentName,
        status: b.status,
        subagentTokens: b.subagentTokens,
      }),
    );
    await fs.writeFile(path.join(dir, 'bridges.jsonl'), bridges.join('\n'), 'utf-8');
  }

  if (slice.memory && data.fullContext?.memoryFiles) {
    await fs.writeFile(path.join(dir, 'project-instructions.md'), truncate(data.fullContext.memoryFiles, 20000), 'utf-8');
  }
  if (slice.memory) {
    // memory 字段为空（opencode 形态）时的兜底材料：验收清单/红线在 system/skills/子会话提示词里
    const sysMd = buildSystemContext(data.session.sourcePath, data.session.taskId, data.fullContext);
    if (sysMd) await fs.writeFile(path.join(dir, 'system-context.md'), sysMd, 'utf-8');
  }

  return { dir };
}

export async function materialSize(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of ['session.json', 'turns.jsonl', 'toolcalls.jsonl', 'bridges.jsonl', 'project-instructions.md', 'system-context.md']) {
    try {
      const st = await fs.stat(path.join(dir, f));
      out[f] = st.size;
    } catch {
      out[f] = 0;
    }
  }
  return out;
}