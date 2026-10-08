// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseReadArgs, isDirectoryRead, computeRange, analyzeReads, extractExecFileReads } from '@/lib/file-reads';
import type { ReadRange } from '@/lib/file-reads';
import type { ReadEntry } from '@/lib/file-reads';
import { withRouteLog } from '@/lib/api-route';

interface FileAnalysis {
  path: string;
  displayPath: string;
  reads: ReadEntry[];
  totalReads: number;
  overlappingReads: number;
  totalLinesRead: number;
  uniqueLinesRead: number;
  redundancyRate: number;
}

interface Summary {
  totalFiles: number;
  totalReads: number;
  filesWithOverlap: number;
  redundancyRate: number;
}

export const GET = withRouteLog('observe/session/file-reads', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');

  if (!taskId) {
    return NextResponse.json(
      { error: 'Missing required query param: taskId' },
      { status: 400 }
    );
  }

  const session = await prisma.session.findFirst({
    where: framework ? { taskId, framework } : { taskId },
  });

  if (!session) {
    return NextResponse.json(
      { error: `Session not found for taskId: "${taskId}"` },
      { status: 404 }
    );
  }

  // 双查询：Read 需要 resultJson（目录判定）；exec 只消费 argsJson——
  // 合并查询会把 exec 的 resultJson 一并拉出（实测单会话 16MB 纯浪费）
  const turnSelect = {
    id: true,
    turnIndex: true,
    agentName: true,
    isSubagent: true,
    subagentName: true,
    subagentSessionId: true,
    contentSummary: true,
  } as const;
  const [readCalls, execCalls] = await Promise.all([
    prisma.toolCall.findMany({
      where: { toolName: { in: ['read', 'Read'] }, turn: { sessionId: session.id } },
      select: { toolName: true, argsJson: true, resultJson: true, turn: { select: turnSelect } },
    }),
    prisma.toolCall.findMany({
      where: { toolName: 'exec', turn: { sessionId: session.id } },
      select: { toolName: true, argsJson: true, turn: { select: turnSelect } },
    }),
  ]);
  const toolCalls: Array<{
    toolName: string;
    argsJson: string | null;
    resultJson?: string | null;
    turn: (typeof readCalls)[number]['turn'];
  }> = [...readCalls, ...execCalls];

  const subSessionIds = [...new Set(
    toolCalls
      .filter(tc => tc.turn.isSubagent && tc.turn.subagentSessionId)
      .map(tc => tc.turn.subagentSessionId!)
  )];

  const promptMap = new Map<string, string | null>();
  if (subSessionIds.length > 0) {
    const bridges = await prisma.interactionBridge.findMany({
      where: { sessionId: session.id, subagentSessionId: { in: subSessionIds } },
      select: { subagentSessionId: true, dispatchContent: true },
    });
    for (const b of bridges) {
      if (b.subagentSessionId) promptMap.set(b.subagentSessionId, b.dispatchContent);
    }
  }

  const fileMap = new Map<string, { displayPath: string; reads: ReadEntry[] }>();

  for (const tc of toolCalls) {
    // exec（codex 形态）：一次 exec 可命中多个文件（内嵌多条命令），
    // 逐文件生成读取条目；Read 走原参数解析
    const perFile: Array<{ filePath: string; displayPath: string; range: ReadRange }> = [];
    if (tc.toolName === 'exec') {
      for (const r of extractExecFileReads(tc.argsJson)) {
        perFile.push({ filePath: r.filePath, displayPath: r.filePath, range: r.range });
      }
    } else {
      const args = parseReadArgs(tc.argsJson);
      if (!args || !args.filePath) continue;
      if (isDirectoryRead(args.filePath, tc.resultJson ?? null)) continue;
      perFile.push({ filePath: args.filePath, displayPath: args.summary || args.filePath, range: computeRange(args) });
    }

    const agent = tc.turn.isSubagent
      ? (tc.turn.agentName || tc.turn.subagentName || 'subagent')
      : (tc.turn.agentName || 'root');

    const prompt = tc.turn.isSubagent && tc.turn.subagentSessionId
      ? (promptMap.get(tc.turn.subagentSessionId) ?? null)
      : null;

    for (const pf of perFile) {
      if (!fileMap.has(pf.filePath)) {
        fileMap.set(pf.filePath, { displayPath: pf.displayPath, reads: [] });
      }
      fileMap.get(pf.filePath)!.reads.push({
        turnId: tc.turn.id,
        turnIndex: tc.turn.turnIndex,
        agent,
        prompt,
        subagentSessionId: tc.turn.subagentSessionId ?? null,
        llmOutput: tc.turn.contentSummary ?? null,
        range: pf.range,
      });
    }
  }

  const files: FileAnalysis[] = [];
  let globalTotalLines = 0;
  let globalUniqueLines = 0;

  for (const [path, data] of fileMap) {
    const metrics = analyzeReads(data.reads);
    globalTotalLines += metrics.totalLinesRead;
    globalUniqueLines += metrics.uniqueLinesRead;

    files.push({
      path,
      displayPath: data.displayPath,
      reads: data.reads,
      totalReads: data.reads.length,
      ...metrics,
    });
  }

  files.sort((a, b) => b.totalReads - a.totalReads);

  const summary: Summary = {
    totalFiles: files.length,
    totalReads: files.reduce((sum, f) => sum + f.totalReads, 0),
    filesWithOverlap: files.filter(f => f.overlappingReads > 0).length,
    redundancyRate: globalTotalLines > 0 ? 1 - globalUniqueLines / globalTotalLines : 0,
  };

  return NextResponse.json({ files, summary });
});
