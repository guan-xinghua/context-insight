// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { resolveScanRoot, scanAgentDirs, resolveAgentMd } from '@/lib/agent-md-scan';
import { recoverAgentMdFromSystem } from '@/lib/agent-md-session-recover';
import { prisma } from '@/lib/db';
import { withRouteLog } from '@/lib/api-route';

/**
 * Skills tab 的 subagent 行"全文"按钮（单一入口）：取 agent .md 内容。
 *
 * 两级优先——会话恢复为主数据、磁盘扫描兜底（UI 只有一个"全文"按钮，
 * 不再区分来源；内容行按响应 via 字段标识实际命中的路径）：
 *
 * 1. **会话恢复 · system 注入**（主路径）：proxy 捕获的子代理 jsonl 每条
 *    assistant 行带顶层 system 字段 = 运行时注入的 agent .md 正文（显式 agent
 *    派发形态，正常会话 88/88 覆盖）。这是**运行时真正生效的那份声明**——远端
 *    机器当时的版本（实测 designer 实际内容 8,606 字 vs 本机磁盘 demo 4,771 /
 *    glacier 6,793，均非同版本），多插件同名天然无歧义（注入的就是当时加载的
 *    那份）。不依赖子代理 Read 过该文件——声明已注入上下文，子代理不会再去
 *    磁盘读一遍（正常会话仅 3 个验收类子代理 Read 过【别人的】md）。
 * 2. **磁盘扫描**（兜底）：AGENTS_SCAN_ROOT（或自动探测 skills-dev 根）下
 *    agents/ 目录的当前文件——适用于会话内无该 agent 声明数据的形态
 *    （opencode 工作流派发的 general 子代理：system 是通用 prompt，守卫排除）。
 *
 * source 查询参数：'system' | 'disk' 显式单源（测试/调试用）；缺省（含旧 UI
 * 传入的 'session' 等其他值）= 两级优先。
 *
 * 与 skill-content 路由平行：skill-content 取 SKILL.md（从 session invoke 恢复），
 * agent-content 取 agent .md（从子代理 system 注入恢复）。
 */
export const GET = withRouteLog('observe/session/agent-content', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');
  const agentName = searchParams.get('agentName');
  const source = searchParams.get('source'); // 'system' | 'disk' | null

  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }
  if (!agentName) {
    return NextResponse.json({ error: 'Missing agentName' }, { status: 400 });
  }

  const session = await prisma.session.findFirst({
    where: framework ? { taskId, framework } : { taskId },
    select: { id: true, taskId: true, sourcePath: true },
  });

  // ① system 注入恢复（sourcePath 指向本地 jsonl——本机 cpx 捕获与 lake
  //    materialized 布局一致（<sid>/subagents/），listSubagentSessions 统一发现）
  const recoverFromSystem = () => {
    if (!session?.sourcePath) return null;
    return recoverAgentMdFromSystem(session.sourcePath, session.taskId, agentName);
  };

  const systemResponse = (r: NonNullable<ReturnType<typeof recoverFromSystem>>) =>
    NextResponse.json({
      agentName,
      content: r.content,
      source: r.source,
      length: r.content.length,
      via: 'system',
    });

  const scanFromDisk = async () => {
    const scanRoot = resolveScanRoot();
    if (!scanRoot) {
      return NextResponse.json({ agentName, content: null, source: null, length: 0, via: null });
    }

    // 收集本 session 被派发的 agent 名（用于多插件消歧）
    const sessionAgentNames = new Set<string>();
    if (session) {
      const dispatchEvents = await prisma.skillEvent.findMany({
        where: { turn: { sessionId: session.id }, eventType: 'dispatch' },
        select: { skillName: true },
        distinct: ['skillName'],
      });
      for (const se of dispatchEvents) sessionAgentNames.add(se.skillName);
    }

    const dirs = scanAgentDirs(scanRoot);
    const resolved = resolveAgentMd(agentName, dirs, sessionAgentNames);
    if (!resolved) {
      return NextResponse.json({ agentName, content: null, source: null, length: 0, via: null });
    }

    const content = fs.readFileSync(resolved.mdPath, 'utf8');
    return NextResponse.json({
      agentName,
      content,
      source: resolved.dir,
      length: content.length,
      via: 'disk',
    });
  };

  if (source === 'system') {
    const r = recoverFromSystem();
    if (!r) return NextResponse.json({ agentName, content: null, source: null, length: 0, via: null });
    return systemResponse(r);
  }
  if (source === 'disk') return scanFromDisk();
  {
    // 缺省：system 优先、磁盘兜底
    const r = recoverFromSystem();
    return r ? systemResponse(r) : scanFromDisk();
  }
});
