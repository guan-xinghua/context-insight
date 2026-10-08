// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { readAvailableSkills } from '@/lib/ingest/adapters/claude-jsonl-full-context';
import { aggregateUsedSkills, buildCoverage } from '@/lib/skill-coverage';
import { isProxyVersion, isClaudeFormatSession } from '@/lib/shared/session-format';
import { withRouteLog } from '@/lib/api-route';

export const GET = withRouteLog('observe/session/skill-coverage', async (request: NextRequest) => {
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
    select: { id: true, taskId: true, framework: true, version: true, sourcePath: true },
  });

  if (!session) {
    return NextResponse.json(
      { error: `Session not found for taskId: "${taskId}"` },
      { status: 404 }
    );
  }

  const events = await prisma.skillEvent.findMany({
    where: { turn: { sessionId: session.id } },
    select: { skillName: true, eventType: true, success: true },
  });
  const used = aggregateUsedSkills(events);

  let available: Array<{ name: string; description: string; origin: string | null }> | null = null;
  let listFormat: 'claude-list' | 'opencode-xml' | null = null;
  let degradedReason: string | null = null;

  // 覆盖度门禁（按全集确定性）：
  // - proxy 捕获（claude/opencode/codex，version 带 -proxy）：wire verbatim
  //   系统提示落盘，全集确定性恢复
  // - native claude-code：jsonl 的 type:system 行落盘系统注入（含 skills
  //   全集列表），同样确定性可解析（实测 native 会话 system 行含完整列表）
  // - native opencode：系统提示只在运行时请求，db 不落盘 → 不可恢复
  const isProxy = isProxyVersion(session.version);
  const isClaudeSource = isClaudeFormatSession(session.framework, session.version);

  if (!isClaudeSource) {
    degradedReason = '仅 claude 格式来源（proxy 捕获 / native claude-code）展示 Skill 覆盖度；opencode 原生会话的系统提示不落盘，全集不可恢复';
  } else if (!session.sourcePath) {
    degradedReason = '源文件不可用（sourcePath 缺失或文件已移走）';
  } else {
    const parsed = readAvailableSkills(session.sourcePath);
    if (parsed) {
      available = parsed.skills;
      listFormat = parsed.format;
    } else {
      degradedReason = isProxy
        ? 'proxy 捕获中未找到可用 skills 全集（系统提示未含 skills 注入段）'
        : '未在会话中找到可用 skills 全集注入（native 会话未注入 skills 列表，如未配置 skills）';
    }
  }

  const coverage = buildCoverage(available, used);

  return NextResponse.json({
    taskId: session.taskId,
    framework: session.framework,
    hasAvailableList: available != null,
    listFormat,
    degradedReason,
    usedSkillCount: used.length,
    ...coverage,
  });
});
