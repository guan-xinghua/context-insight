// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D4 完成效率（加权维）：token 25% + LLM 时长 15% + 工具时长 15% + 并行度 25% + 轮次 10% + 压缩 10%。
// token 代表"真正干了多少活"、并行度代表"活干得顺不顺"，各占大头；双时长分开评
//（哪个贵罚哪个，模型慢还是工具慢直接落在分上）；并行度只奖不罚（串行=持平 0.8，
// 任务天生串行不该挨罚）。轮次与压缩信息都与 token/时长重叠（碎开销 / 水位失控的
// 代价已计在 token 里），只补大项罚不到的信号，各 10% 轻罚。浪费只归因不扣分
//（防双重计账）。

import type { DimensionDefinition, ScoreItemSchema } from '../core/schema';

const items: ScoreItemSchema[] = [
  { id: 'D4.tokens', dimension: 'D4', name: 'token 排名', scorerKind: 'baseline-compare', weight: 0.25, note: '总 token 与基线会话比比值' },
  { id: 'D4.llmTime', dimension: 'D4', name: 'LLM 时长比值', scorerKind: 'baseline-compare', weight: 0.15, note: '模型推理耗时之和，与基线会话比比值' },
  { id: 'D4.toolTime', dimension: 'D4', name: '工具时长比值', scorerKind: 'baseline-compare', weight: 0.15, note: '工具调用耗时之和（起止时间戳推导），与基线会话比比值' },
  { id: 'D4.parallel', dimension: 'D4', name: '并行度', scorerKind: 'rule', weight: 0.25, note: 'Σ调用时长÷区间并集：串行=0.8（持平），1.75×并行=1.0，只奖不罚' },
  { id: 'D4.turns', dimension: 'D4', name: '轮次比值', scorerKind: 'baseline-compare', weight: 0.10, note: '非子代理轮数与基线会话比比值——轻罚决策碎（小权重，见设计 §5 补充说明）' },
  { id: 'D4.compaction', dimension: 'D4', name: '上下文水位', scorerKind: 'rule', weight: 0.10, note: '压缩每次 −0.2（5 次见底）：撑爆窗口 = 水位失控；手动 /compact 同样计扣（用户发起也是水位信号）' },
  { id: 'D4.waste', dimension: 'D4', name: '浪费归因', scorerKind: 'rule', diagnostic: true, note: '不扣分只解释贵在哪：浪费已在比值里罚过一次，再按次数扣就是罚两次' },
];

export const d4Efficiency: DimensionDefinition = {
  id: 'D4',
  name: '完成效率',
  english: 'Efficiency',
  role: 'weighted',
  weightInTotal: 0.15,   // 起步建议 10~15%（设计 §1），待基线语料攒多后校准
  items,
  aggregation: { kind: 'weighted-average' },
};
