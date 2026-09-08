// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基线对比评分器：单会话基线（样例会话）——本次/基线比值 → 分。
// 基线 = 一个标杆 session（同类任务各一，页面「设为基线」写入），不是语料分布。
// 未设基线/基线缺该指标 → 默认 80 分（持平档，明确标注）；度量本身测不到 → 无法评判。

import type { AssembledInput } from './assembler/types';
import { Scorer, okResult, notApplicable, type ScorerContext } from './scorer';
import type { ScoreItemSchema } from './schema';
import type { SubItemResult } from './types';
import { displayBaselineValue } from './baseline/service';
import { loadSessionBaseline, ratioGrade, ratioScore } from './baseline/session-baseline';

export interface BaselineCompareConfig {
  baselineKey: string;
  measure: (input: AssembledInput) => number | null;
  /** 测不到这个量时的原因（如非 proxy 无 wire） */
  notApplicableNote: string;
  unit?: string;
}

export class BaselineCompareScorer extends Scorer {
  readonly id: string;
  readonly needs = ['measures'] as const;

  constructor(private readonly def: ScoreItemSchema, private readonly cfg: BaselineCompareConfig) {
    super();
    this.id = def.id;
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const value = this.cfg.measure(ctx.input);
    if (value == null) return notApplicable(ctx.def, this.cfg.notApplicableNote);

    const base = await loadSessionBaseline(ctx.input.taskType);
    const ref = base?.metrics[this.cfg.baselineKey];
    // 缺基线 → 默认 80 分（与基线持平档：比值公式里持平即 0.8）。
    // 进平均、计入覆盖度，但公式/说明明确标注是默认分——设基线后重算生效。
    if (!base || !ref) {
      const reason = !base
        ? `${ctx.input.taskType} 类任务未设基线会话`
        : '基线会话缺该指标';
      return okResult(ctx.def, {
        value,
        unit: this.cfg.unit,
        baselineScore: 0.8,
        score: 0.8,
        formula: `${reason}，按默认 80 计（与基线相当档）`,
        note: '默认分：未与真实基线比较；在样例会话上「设为基线」后重算生效',
      });
    }
    const pos = ratioScore(value, ref.value);
    const grade = ratioGrade(value, ref.value);
    const ratio = ref.value > 0 ? value / ref.value : Infinity;
    // 概要参考：基线与本次模型不同 → 比值参考性降级，明说（对比信息进不了分）
    const currentModels = new Set(ctx.input.turns.map(t => t.model).filter((m): m is string => m != null));
    const baseModel = base.context?.models?.find(m => currentModels.has(m));
    const modelNote = base.context && base.context.models.length > 0 && !baseModel
      ? `；基线是 ${base.context.models.join('/')} 跑的，与本次模型不同，比值仅供参考`
      : '';
    return okResult(ctx.def, {
      value,
      unit: this.cfg.unit ?? ref.unit,
      baselineScore: pos,
      score: pos,
      formula: `基线会话「${base.label.slice(0, 16)}」${displayBaselineValue(ref.value, ref.unit)} · 本次 ${displayBaselineValue(value, ref.unit)} → 比值 ${ratio.toFixed(2)} → ${pos}`,
      evidence: [],
      note: `${grade}（基线 ${base.computedAt.slice(0, 10)} 设定${modelNote}）`,
    });
  }
}
