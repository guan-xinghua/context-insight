// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基准测试填报读时覆盖：保存后 GET 刷新即生效——只重折算 D3.benchScore 一项
// 并重聚合，不重算整卡、不覆盖评审盖章；已有填报覆盖需确认（对话框行为）。

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyBenchReport } from '../../src/lib/scoring/core/bench-report/overlay';
import { BUILTIN_DIMENSIONS } from '../../src/lib/scoring/definitions';
import type { Scorecard, SubItemResult } from '../../src/lib/scoring/core/types';
import { SCORECARD_SCHEMA } from '../../src/lib/scoring/core/types';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opbench-ov-'));
process.env.SCORING_BENCH_REPORT_DIR = TMP;   // bench-report 文件落临时目录（调用时读 env）

const SID = 'opbench-ov-1';

function mkCard(opts: { benchScore?: Partial<SubItemResult>; profileId?: string; review?: Scorecard['review'] }): Scorecard {
  const item: SubItemResult = { itemId: 'D3.benchScore', label: '基准测试评分', status: 'ok', value: 8, unit: 'score/10', score: 0.8, formula: '未填报默认', evidence: [], ...opts.benchScore };
  const d3Def = BUILTIN_DIMENSIONS.find(d => d.id === 'D3')!;
  const items = d3Def.items.map(i => (i.id === 'D3.benchScore' ? item : { itemId: i.id, label: i.name, status: 'ok', score: 1, evidence: [] } as SubItemResult));
  return {
    schemaVersion: SCORECARD_SCHEMA,
    sessionId: SID,
    taskType: 'operator',
    computedAt: '2026-09-29T00:00:00.000Z',
    status: 'completed',
    framework: { totalScore: 0.9, veto: null, coverage: 1, weightsUsed: { D3: 0.35 }, profile: opts.profileId ? { id: opts.profileId, name: opts.profileId } : null },
    dimensions: [
      { dimensionId: 'D3', name: '完成质量', english: 'Quality', role: 'weighted', status: 'scored', score: 0.9, items },
    ],
    judgeCost: null,
    review: opts.review ?? null,
  } as unknown as Scorecard;
}

const benchFile = () => path.join(TMP, `${SID}.json`);

beforeEach(() => {
  fs.rmSync(benchFile(), { force: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.SCORING_BENCH_REPORT_DIR;   // env 不外泄（全量跑时同进程其他用例）
});

describe('applyBenchReport（读时覆盖）', () => {
  it('已填报：D3.benchScore 重折算、维度与总分重聚合，其他子项与评审盖章原样', async () => {
    fs.writeFileSync(benchFile(), JSON.stringify({ schema: 'workflow-session-bench-report', version: 1, sessionId: SID, score: 95, note: '排行榜第 3', filledAt: '2026-09-29T12:00:00.000Z' }));
    const review = { reviewer: 'mate' as const, tool: 'opencode', completedAt: '2026-09-29T12:30:00.000Z' };
    const card = mkCard({ review });
    const out = await applyBenchReport(card, BUILTIN_DIMENSIONS);
    const d3 = out.dimensions[0];
    const cb = d3.items.find(i => i.itemId === 'D3.benchScore')!;
    expect(cb.value).toBe(9.5);
    expect(cb.score).toBe(0.95);
    expect(cb.formula).toContain('95/100');
    expect(cb.note).toContain('排行榜第 3');
    expect(out.review).toEqual(review);                    // 评审盖章不被覆盖
    expect(d3.items.find(i => i.itemId === 'D3.correctness')!.score).toBe(1);   // 其他子项不动
  });

  it('未填报：回落默认 80 档（note 引导填报立即生效）；非算子任务 → 不适用', async () => {
    const out = await applyBenchReport(mkCard({}), BUILTIN_DIMENSIONS);
    const cb = out.dimensions[0].items.find(i => i.itemId === 'D3.benchScore')!;
    expect(cb.value).toBe(8);
    expect(cb.score).toBe(0.8);

    const general = { ...mkCard({}), taskType: 'general' } as Scorecard;
    const out2 = await applyBenchReport(general, BUILTIN_DIMENSIONS);
    expect(out2.dimensions[0].items.find(i => i.itemId === 'D3.benchScore')!.status).toBe('not-applicable');
  });

  it('跨模板守卫：卡的 profile 与当前生效不一致时只换子项不重聚合分数（与人工复核同规则）', async () => {
    fs.writeFileSync(benchFile(), JSON.stringify({ schema: 'workflow-session-bench-report', version: 1, sessionId: SID, score: 95, filledAt: '2026-09-29T12:00:00.000Z' }));
    const out = await applyBenchReport(mkCard({ profileId: 'p-old' }), BUILTIN_DIMENSIONS, { id: 'p-new', name: '新' });
    expect(out.dimensions[0].score).toBe(0.9);             // 维度分不动
    expect(out.framework.totalScore).toBe(0.9);            // 总分不动
    expect(out.dimensions[0].items.find(i => i.itemId === 'D3.benchScore')!.score).toBe(0.95);   // 子项照换
  });
});
