// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 读时覆盖层总入口（所有评分卡出口统一走这里）：CANN-Bench 填报 → 人工复核。
// 都是不需要重算的确定性覆盖——保存即生效，且不覆盖 LLM/Mate 评审盖章。

import type { DimensionDefinition } from './schema';
import type { Scorecard } from './types';
import { applyAdjudications } from './adjudicate';
import { applyOpBench } from './op-bench/overlay';
import { aggregateCard, profileMatches, reaggregateWith } from './aggregator';

export async function applyOverlays(
  card: Scorecard,
  defs: DimensionDefinition[],
  liveProfile?: { id: string; name: string } | null,
): Promise<Scorecard> {
  // 读时重聚合（先于两个覆盖层跑——adjudication 的复核披露后写胜出）：维度分/
  // 总分是 defs 的确定函数，语义与费率修正对所有存量卡立即生效，不依赖恰好有
  // 疑似项/填报触碰（现场 §04ad3515：D2 按次扣分只在有 adjudication 的卡上生效）
  let base = card;
  if (profileMatches(card, liveProfile)) {
    const reAgged = reaggregateWith(card, defs);
    const reAgg = reAgged.framework;
    // 合不出总分而原卡有分（合成夹具/异形卡：维度对不上 defs）→ 不动存量框架
    if (reAgg.totalScore != null || reAgg.veto?.triggered || card.framework.totalScore == null) {
      base = reAgged;
    }
  }
  return applyAdjudications(await applyOpBench(base, defs, liveProfile), defs, liveProfile);
}
