// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 会话评分融合（第六刀数据层）：joinSessionRefs 消歧定行 → collectRuleInputs
// 批量采集（turns+toolCalls，与评分卡同源映射）→ ruleScoresOf 规则层 →
// SessionRef.ruleScores。findings 裁剪口径也在此锁：满分项不浮出、D4.parallel
// 串行持平豁免、evidence 去原文引用。独立 sid（ses_score_*）避开共享 test.db
// 的并行竞态。

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { parseAndIndex } from '@/lib/run/reader';
import { joinSessionRefs } from '@/lib/run/session-link';
import { attachSessionScores } from '@/lib/run/session-score';

const prisma = new PrismaClient();

const manifest = {
  schema: 'context.workflow-bundle',
  version: 1,
  id: 'scoredemo01',
  kind: 'workflow',
  name: 'score-join-test',
  startedAt: null,
  finishedAt: null,
  data: {
    exportDataComplete: true,
    members: [
      {
        id: 'M_A_E',
        kind: 'session',
        name: 'build：第 0 代第 1 次执行',
        sessionId: 'ses_score_a',
        annotation: {
          note: '执行',
          graph: { role: 'execute', nodeId: 'build', generation: 0, attempt: 1, attemptResult: 'succeeded' },
        },
      },
      {
        id: 'M_C_E',
        kind: 'session',
        name: 'polish：第 0 代第 1 次执行',
        sessionId: 'ses_score_c',
        annotation: {
          note: '执行',
          graph: { role: 'execute', nodeId: 'polish', generation: 0, attempt: 1, attemptResult: 'succeeded' },
        },
      },
      {
        id: 'M_D_E',
        kind: 'session',
        name: 'init：第 0 代第 1 次执行',
        sessionId: 'ses_score_d',
        annotation: {
          note: '执行',
          graph: { role: 'execute', nodeId: 'init', generation: 0, attempt: 1, attemptResult: 'succeeded' },
        },
      },
    ],
    relations: [],
  },
};

async function seedSession(sid: string, calls: Array<{ args: string; state?: string; error?: string }>) {
  const s = await prisma.session.create({ data: { taskId: sid, framework: 'opencode' } });
  if (calls.length === 0) return s;
  const t = await prisma.turn.create({
    data: { sessionId: s.id, turnIndex: 0, role: 'assistant', totalTokens: 100 },
  });
  await prisma.toolCall.createMany({
    data: calls.map((c, i) => ({
      turnId: t.id,
      toolCallId: `${sid}-c${i}`,
      toolName: 'Bash',
      argsJson: c.args,
      state: c.state ?? 'ok',
      errorMessage: c.error ?? null,
    })),
  });
  return s;
}

describe('Run 会话评分融合：attachSessionScores（join → 批量采集 → 规则分）', () => {
  it('原样重复会话：冗余分 <1、findings 浮出重派/重复/白干错误信号；干净会话满分零浮出', async () => {
    const index = parseAndIndex(manifest);
    // ses_score_a：3 连发同参数（原样重复 ×1）+ 1 次可避免错误 + 2 个正常调用
    const a = await seedSession('ses_score_a', [
      { args: '{"cmd":"git status"}' },
      { args: '{"cmd":"git status"}' },
      { args: '{"cmd":"git status"}' },
      { args: '{"cmd":"cat x"}', state: 'error', error: 'No such file or directory: x' },
      { args: '{"cmd":"make"}' },
      { args: '{"cmd":"make test"}' },
    ]);
    // ses_score_c：全部互不相同的成功调用 → 规则层满分
    const c = await seedSession('ses_score_c', [
      { args: '{"cmd":"ls"}' },
      { args: '{"cmd":"pwd"}' },
      { args: '{"cmd":"date"}' },
    ]);
    // ses_score_d：有会话行但零 turns/零调用 → 规则层不可评（null）
    const d = await seedSession('ses_score_d', []);
    try {
      const lookup = await joinSessionRefs(index, prisma);
      await attachSessionScores(lookup, prisma);

      const ra = lookup.get('ses_score_a')!.ruleScores!;
      expect(ra.d5).not.toBe(1);
      expect(ra.d5).toBeGreaterThanOrEqual(0);
      const repeat = ra.findings.find(f => f.itemId === 'D5.repeat');
      expect(repeat).toBeTruthy();
      expect(repeat!.formula).toContain('原样连发');
      const toolErrors = ra.findings.find(f => f.itemId === 'D5.toolErrors');
      expect(toolErrors).toBeTruthy();
      expect(toolErrors!.evidence[0]?.label).toContain('No such file or directory');
      expect(toolErrors!.evidence[0]?.label).not.toContain('{'); // evidence 不带原文 JSON
      // 复算公式的白话归一：评分器行话尾注换成「非人为/环境问题不计入」
      expect(toolErrors!.formula).toContain('（非人为/环境问题不计入）');
      expect(toolErrors!.formula).not.toContain('D5.repeat');
      expect(toolErrors!.formula).not.toContain('环境类豁免');

      const rc = lookup.get('ses_score_c')!.ruleScores!;
      expect(rc.d5).toBe(1);
      expect(rc.findings).toHaveLength(0); // 满分零值不浮出

      expect(lookup.get('ses_score_d')!.ruleScores).toBeNull();
    } finally {
      for (const s of [a, c, d]) {
        await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
      }
    }
  });

  it('空 lookup / 全部行缺 turns：不触 DB 查询也不炸', async () => {
    const lookup = await joinSessionRefs(parseAndIndex(manifest), prisma);
    // manifest 三个 sid 均无落库行 → lookup 为空 Map
    expect(lookup.size).toBe(0);
    await attachSessionScores(lookup, prisma);
    expect(lookup.size).toBe(0);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
