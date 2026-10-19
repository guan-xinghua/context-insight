// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话行级联删除共享件（Sessions 域 delete-session 路由与 run 域删除级联
// 同一事实源）：SQLite 外键级联不可靠（PRAGMA 状态不定），子行按依赖序在
// 单事务内显式清理，否则 turns/toolCalls 等孤儿行跨删除周期累积。

import type { PrismaClient } from '@prisma/client';

export async function cascadeDeleteSessionRows(prisma: PrismaClient, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  await prisma.$transaction([
    prisma.executionSkill.deleteMany({ where: { execution: { sessionId: { in: ids } } } }),
    prisma.toolCall.deleteMany({ where: { turn: { sessionId: { in: ids } } } }),
    prisma.skillEvent.deleteMany({ where: { turn: { sessionId: { in: ids } } } }),
    prisma.execution.deleteMany({ where: { sessionId: { in: ids } } }),
    prisma.sessionSkill.deleteMany({ where: { sessionId: { in: ids } } }),
    prisma.interactionBridge.deleteMany({ where: { sessionId: { in: ids } } }),
    prisma.turn.deleteMany({ where: { sessionId: { in: ids } } }),
    prisma.session.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return ids.length;
}
