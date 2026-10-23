// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基准测试评分器（用户填报）：值来自用户在 Score 页填报的排行榜总分（百分制折 0-10）。
// 未填报 → 默认 80 持平档（明标，与「未设基线按默认 80 计」同哲学）；非算子任务 → 不适用。

import { Scorer, okResult, notApplicable, round2, type ScorerContext } from '../scorer';
import type { ScoreItemSchema } from '../schema';
import type { SubItemResult } from '../types';
import { benchToScore10, loadSessionBenchReport } from './session-bench-report';

export class BenchReportScorer extends Scorer {
  readonly id: string;
  readonly needs = ['taskType'] as const;

  constructor(private readonly def: ScoreItemSchema) {
    super();
    this.id = def.id;
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    if (ctx.input.taskType !== 'operator') {
      return notApplicable(ctx.def, '非算子类任务，无法评判');
    }
    const bench = ctx.sessionId ? await loadSessionBenchReport(ctx.sessionId) : null;
    if (!bench) {
      return okResult(ctx.def, {
        value: 8,
        unit: 'score/10',
        score: 0.8,
        formula: '未填报 基准测试结果，按默认 80 计（与基线相当档）',
        note: '默认分（未填报）：在 Score 页「基准测试填报」填入 排行榜总分后重算生效',
      });
    }
    const v = benchToScore10(bench.score);
    return okResult(ctx.def, {
      value: v,
      unit: 'score/10',
      score: round2(v / 10),
      formula: `基准测试总分 ${bench.score}/100 → ${v}/10`,
      note: bench.note?.trim() ? bench.note.trim() : `填报于 ${bench.filledAt.slice(0, 10)}`,
    });
  }
}
