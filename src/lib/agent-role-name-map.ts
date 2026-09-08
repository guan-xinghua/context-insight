// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { PrismaClient } from '@prisma/client';

/**
 * 子代理会话 → **角色名**映射（DB-only，客户端安全——无 fs/node 内建 import）。
 *
 * 独立成文件的原因：sift-audit.ts（被 session page 客户端组件 import）要用本映射修
 * records.agent 的切片匹配，凡它 import 的模块都进 client bundle——本文件只准依赖
 * prisma 类型（镜像 workflow-extract-plugin 的隔离模式；fs 侧恢复逻辑在 server-only
 * 的 agent-md-session-recover.ts）。
 *
 * 背景：`Turn.agentName = meta.name || agentType || description` = 任务标题
 * （"Task29 修复Kernel崩溃"），sift `--kind agent` 按声明 frontmatter name 匹配
 * records.agent → 任务标题永远匹配不上（对账切片为空的根因）。角色名的两个 DB 来源：
 *
 * 1. cannbot-proxy（显式派发，正常形态）：`InteractionBridge.subagentType` =
 *    dispatch args 的 subagent_type（真名，实测 88/88 覆盖）；
 * 2. opencode-proxy（工作流派发）：subagentType 恒 'general' → join
 *    `bridge.dispatchTurnId → SkillEvent(eventType=dispatch).skillName`（turn-split
 *    的 extractDispatchSkillName 从角色句提取，实测 53/53 覆盖）。
 *
 * 同一子会话多条 bridge 取首个命中（同会话角色恒定）。unknown-dispatch 丢弃。
 */

/** dispatch args 里的泛型 subagent_type（角色名在 prompt 角色句，须走 SkillEvent join）。 */
const GENERIC_SUBAGENT_TYPES = new Set(['general', 'general-purpose']);

export async function buildAgentRoleNameMap(
  sessionId: string,
  prisma: PrismaClient
): Promise<Map<string, string>> {
  const bridges = await prisma.interactionBridge.findMany({
    where: { sessionId, subagentSessionId: { not: null } },
    select: { subagentSessionId: true, subagentType: true, dispatchTurnId: true },
    orderBy: { createdAt: 'asc' },
  });
  const map = new Map<string, string>();

  const generalTurnIds = bridges
    .filter(b => !b.subagentType || GENERIC_SUBAGENT_TYPES.has(b.subagentType))
    .map(b => b.dispatchTurnId)
    .filter((t): t is string => !!t);
  const events = generalTurnIds.length > 0
    ? await prisma.skillEvent.findMany({
        where: { turnId: { in: generalTurnIds }, eventType: 'dispatch' },
        select: { turnId: true, skillName: true },
      })
    : [];
  const roleByTurn = new Map(events.map(e => [e.turnId, e.skillName]));

  for (const b of bridges) {
    const sid = b.subagentSessionId!;
    if (map.has(sid)) continue;
    if (b.subagentType && !GENERIC_SUBAGENT_TYPES.has(b.subagentType)) {
      map.set(sid, b.subagentType);
      continue;
    }
    const viaEvent = b.dispatchTurnId ? roleByTurn.get(b.dispatchTurnId) : undefined;
    if (viaEvent && viaEvent !== 'unknown-dispatch') map.set(sid, viaEvent);
  }
  return map;
}
