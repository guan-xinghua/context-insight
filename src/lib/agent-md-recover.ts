// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS OF A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { Prisma, PrismaClient } from '@prisma/client';
import { restoreFile, renderRestoredText, type RestoreOp } from './file-restore';

export interface RecoveredAgentMd {
  content: string;
  /** 运行时实际读取的文件路径（read args 里的 filePath） */
  source: string;
  /** 是否拼出了完整文件（无 gap） */
  fullRead: boolean;
  maxLine: number;
}

export interface RecoverToolCallRow {
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  startedAt: Date | null;
}

const READ_TOOL = /^read$/i;

function readFilePath(argsJson: string | null): string | null {
  if (!argsJson) return null;
  try {
    const p = JSON.parse(argsJson) as { filePath?: unknown; file_path?: unknown };
    const fp = p.filePath ?? p.file_path;
    return typeof fp === 'string' && fp.length > 0 ? fp : null;
  } catch {
    return null;
  }
}

function agentMdPathMatches(filePath: string, agentName: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  const want = `agents/${agentName}.md`;
  const idx = norm.lastIndexOf('/' + want);
  return idx !== -1 && idx + want.length + 1 === norm.length;
}

/**
 * 从 session 的 read 工具调用里恢复 agent .md 原文（Skills tab subagent 行"全文"）。
 *
 * 依据：opencode 的 task 派发 prompt 只带角色名（"扮演 X agent"），agent .md
 * 不进 dispatch args；子代理（或主会话）运行时会自己 read 该 .md 文件 ——
 * read 结果（ToolCall.resultJson）就是运行时真正生效的定义原文。恢复它比
 * 磁盘扫描更准：文件事后可能已改/已删，且多插件同名时磁盘只能按覆盖率+
 * 字母序猜，而会话里读的是哪份就是哪份。
 *
 * - 匹配：toolName=read（不区分大小写）且 filePath 以 /agents/<agentName>.md 结尾
 * - 多份同名（demo/glacier 等多插件都被读过）→ 取最新一次读取所在的那份文件
 * - 同一文件多次分段读 → 按时间序合并行（restoreFile），gap 标记 --line N not found --
 * - 空结果（读失败的探测路径）跳过
 */
export function selectRecoveredAgentMd(
  toolCalls: RecoverToolCallRow[],
  agentName: string
): RecoveredAgentMd | null {
  const byFile = new Map<string, RestoreOp[]>();
  let latest: { file: string; ts: number } | null = null;

  for (const tc of toolCalls) {
    if (!READ_TOOL.test(tc.toolName)) continue;
    if (!tc.resultJson || tc.resultJson.length === 0) continue;
    const fp = readFilePath(tc.argsJson);
    if (!fp || !agentMdPathMatches(fp, agentName)) continue;

    if (!byFile.has(fp)) byFile.set(fp, []);
    byFile.get(fp)!.push({ kind: 'read', argsJson: tc.argsJson, resultJson: tc.resultJson, ts: tc.startedAt });

    const ts = tc.startedAt?.getTime() ?? -Infinity;
    if (!latest || ts > latest.ts) latest = { file: fp, ts };
  }

  if (byFile.size === 0 || !latest) return null;

  const ops = byFile.get(latest.file)!;
  const restored = restoreFile(ops);
  const fullRead = restored.lines.every(l => l.content !== null);
  return {
    content: renderRestoredText(restored.lines),
    source: latest.file,
    fullRead,
    maxLine: restored.maxLine,
  };
}

/** DB 版：取整个 session（含子代理 turns）的 read ToolCall 后走 selectRecoveredAgentMd。 */
export async function recoverAgentMdFromSession(
  prisma: PrismaClient | Prisma.TransactionClient,
  sessionId: string,
  agentName: string
): Promise<RecoveredAgentMd | null> {
  const toolCalls = await prisma.toolCall.findMany({
    where: {
      turn: { sessionId },
      toolName: { in: ['read', 'Read'] },
      argsJson: { contains: `agents/${agentName}.md`, not: null },
    },
    select: { toolName: true, argsJson: true, resultJson: true, startedAt: true },
    orderBy: { startedAt: 'asc' },
  }) as RecoverToolCallRow[];
  return selectRecoveredAgentMd(toolCalls, agentName);
}
