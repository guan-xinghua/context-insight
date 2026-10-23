// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 成员会话 join 的上下文峰值水位（第五刀 ⑤ 数据层）：turn 级
// contextWindowPct（导入时按 inputTokens÷窗口上限 计算并单调化）在 join 时
// 按 Session.id 聚合出最大值——SessionRef.contextPeakPct 是水位透镜、侧栏
// 胶囊、时间轴摘要与失败归因的唯一数据源。独立 sid（ses_water_*）避免与
// 并行测试文件共享 test.db 的唯一约束/删除竞态。

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { parseAndIndex } from '@/lib/run/reader';
import { joinSessionRefs } from '@/lib/run/session-link';

const prisma = new PrismaClient();

const manifest = {
  schema: 'context.workflow-bundle',
  version: 1,
  id: 'waterdemo01',
  kind: 'workflow',
  name: 'water-join-test',
  startedAt: null,
  finishedAt: null,
  data: {
    exportDataComplete: true,
    members: [
      {
        id: 'M_A_E',
        kind: 'session',
        name: 'build：第 0 代第 1 次执行',
        sessionId: 'ses_water_a',
        annotation: {
          note: '执行',
          graph: { role: 'execute', nodeId: 'build', generation: 0, attempt: 1, attemptResult: 'succeeded' },
        },
      },
      {
        id: 'M_B_E',
        kind: 'session',
        name: 'build：第 0 代第 1 次验收',
        sessionId: 'ses_water_b',
        annotation: {
          note: '验收',
          graph: {
            role: 'verify',
            nodeId: 'build',
            generation: 0,
            attempt: 1,
            verification: { type: 'script', status: 'passed', reason: 'exit 0' },
          },
        },
      },
    ],
    relations: [],
  },
};

describe('Run 成员会话 join：上下文峰值水位聚合', () => {
  it('SessionRef.contextPeakPct = 会话全部 turn 的最大 contextWindowPct；无水位 turn 为 null', async () => {
    const index = parseAndIndex(manifest);
    const a = await prisma.session.create({ data: { taskId: 'ses_water_a', framework: 'opencode' } });
    const b = await prisma.session.create({ data: { taskId: 'ses_water_b', framework: 'opencode' } });
    try {
      await prisma.turn.createMany({
        data: [
          { sessionId: a.id, turnIndex: 0, role: 'user', contextWindowPct: 12.5 },
          { sessionId: a.id, turnIndex: 1, role: 'assistant', contextWindowPct: 47.1 },
          { sessionId: a.id, turnIndex: 2, role: 'assistant', contextWindowPct: 86.3 },
          { sessionId: b.id, turnIndex: 0, role: 'user' },
        ],
      });
      const refs = await joinSessionRefs(index, prisma);
      expect(refs.get('ses_water_a')?.contextPeakPct).toBeCloseTo(86.3);
      expect(refs.get('ses_water_a')?.turns).toBe(3);
      expect(refs.get('ses_water_b')?.contextPeakPct).toBeNull();
      expect(refs.get('ses_water_b')?.turns).toBe(1);
    } finally {
      await prisma.session.delete({ where: { id: a.id } }).catch(() => {});
      await prisma.session.delete({ where: { id: b.id } }).catch(() => {});
    }
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
