// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { buildAgentRoleNameMap } from '@/lib/agent-role-name-map';

describe('buildAgentRoleNameMap（子代理会话 → 角色名映射）', () => {
  /** mock prisma：interactionBridge + skillEvent 两个 findMany。 */
  function makePrisma(bridges: Array<{ subagentSessionId: string | null; subagentType: string | null; dispatchTurnId: string | null }>,
                      events: Array<{ turnId: string; skillName: string }>) {
    return {
      interactionBridge: { findMany: vi.fn().mockResolvedValue(bridges) },
      skillEvent: { findMany: vi.fn().mockResolvedValue(events) },
    } as unknown as PrismaClient;
  }

  it('cannbot 正常形态：bridge.subagentType（真名）直用，不发 SkillEvent 查询', async () => {
    const prisma = makePrisma([
      { subagentSessionId: 'sub-1', subagentType: 'designer', dispatchTurnId: 't1' },
      { subagentSessionId: 'sub-2', subagentType: 'kernel-developer', dispatchTurnId: 't2' },
    ], []);
    const m = await buildAgentRoleNameMap('ses_1', prisma);
    expect(m.get('sub-1')).toBe('designer');
    expect(m.get('sub-2')).toBe('kernel-developer');
    expect(prisma.skillEvent.findMany).not.toHaveBeenCalled();
  });

  it('opencode 工作流形态：subagentType=general → join dispatchTurnId→SkillEvent.skillName（角色句提取的角色名）', async () => {
    const prisma = makePrisma([
      { subagentSessionId: 'sub-g1', subagentType: 'general', dispatchTurnId: 't10' },
      { subagentSessionId: 'sub-g2', subagentType: null, dispatchTurnId: 't11' },
    ], [
      { turnId: 't10', skillName: 'designer' },
      { turnId: 't11', skillName: 'verifier' },
    ]);
    const m = await buildAgentRoleNameMap('ses_1', prisma);
    expect(m.get('sub-g1')).toBe('designer');
    expect(m.get('sub-g2')).toBe('verifier');
  });

  it('混合形态：真名直用 + general 走 join + unknown-dispatch 丢弃', async () => {
    const prisma = makePrisma([
      { subagentSessionId: 'sub-a', subagentType: 'developer', dispatchTurnId: 't1' },
      { subagentSessionId: 'sub-b', subagentType: 'general', dispatchTurnId: 't2' },
      { subagentSessionId: 'sub-c', subagentType: 'general', dispatchTurnId: 't3' },
    ], [
      { turnId: 't2', skillName: 'st-verifier' },
      { turnId: 't3', skillName: 'unknown-dispatch' },
    ]);
    const m = await buildAgentRoleNameMap('ses_1', prisma);
    expect(m.get('sub-a')).toBe('developer');
    expect(m.get('sub-b')).toBe('st-verifier');
    expect(m.has('sub-c')).toBe(false);
  });

  it('general 但无 dispatchTurnId / 无匹配事件 → 不入映射（回退 agentName）', async () => {
    const prisma = makePrisma([
      { subagentSessionId: 'sub-x', subagentType: 'general', dispatchTurnId: null },
      { subagentSessionId: 'sub-y', subagentType: 'general', dispatchTurnId: 't-miss' },
    ], []);
    const m = await buildAgentRoleNameMap('ses_1', prisma);
    expect(m.size).toBe(0);
  });

  it('同一子会话多条 bridge → 取首个命中（角色恒定）', async () => {
    const prisma = makePrisma([
      { subagentSessionId: 'sub-dup', subagentType: 'designer', dispatchTurnId: 't1' },
      { subagentSessionId: 'sub-dup', subagentType: 'verifier', dispatchTurnId: 't2' },
    ], []);
    const m = await buildAgentRoleNameMap('ses_1', prisma);
    expect(m.get('sub-dup')).toBe('designer');
  });
});
