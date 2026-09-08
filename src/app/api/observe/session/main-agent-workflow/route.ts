// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This file is licensed under the CANN Open Software License Agreement Version 2.0.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { recoverCombinedWorkflowDeclaration, resolveWorkflowSkillName, MAIN_AGENT_WORKFLOW_NAME } from '@/lib/sift-audit';
import { ensureWorkflowExtractPluginLoaded } from '@/lib/workflow-extract-config';

/**
 * 主 agent 编排 对账目标的可用性 + 真名：
 *
 * - available：session 有 workflow 组合声明（规程层：主 agent Skill invoke → SKILL.md body /
 *   skill resources 恢复；计划层：STATE.md 等计划文件的 Read 恢复；任一层在即可 root 对账）
 *   → 可 root 对账。两层皆无 → available=false。
 *
 * - name：workflow skill 真名（主 agent Skill invoke 的 skillName，如
 *   ops-registry-invoke-glacier）。无 invoke → 回退合成名 MAIN_AGENT_WORKFLOW_NAME。
 *
 * - source：声明来源标识。单层 = 该层 source（如 "task-prompts.md"）；双层 =
 *   "规程: X + 计划: Y"（如 "规程: task-prompts.md + 计划: STATE.md"）。
 *
 * 返回：{ available, name, source }。available=true 时 name 非 null、source 非 null；
 * available=false 时 name=null、source=null。
 */
export async function GET(request: Request) {
  try {
    // 激活部署根的 workflow-extract-plugins.json（server-only fs 加载；幂等）
    ensureWorkflowExtractPluginLoaded();
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    const framework = searchParams.get('framework');

    if (!taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    const session = await prisma.session.findFirst({
      where: framework ? { taskId, framework } : { taskId },
    });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // available + source：组合声明（规程层 + 计划层）能否恢复——root 对账送它
    const decl = await recoverCombinedWorkflowDeclaration(session.id, prisma);
    if (!decl) {
      return NextResponse.json({ available: false, name: null, source: null });
    }

    // name：主 agent Skill invoke 的 skillName（workflow skill 真名）
    const name = (await resolveWorkflowSkillName(session.id, prisma)) ?? MAIN_AGENT_WORKFLOW_NAME;
    return NextResponse.json({ available: true, name, source: decl.source });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
