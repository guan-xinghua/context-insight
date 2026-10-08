// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D6 自主性（加权维）：满分起步，按次数扣（同类任务同框架比，不按密度折算）。
// 该定的敢定，不该定的问；该查的自己查，查不到再问——做反了才扣。
// 需求真有歧义的澄清不扣；用户主动补充不扣。具体扣分数值实现时校准。

import type { DimensionDefinition, ScoreItemSchema } from '../core/schema';

const items: ScoreItemSchema[] = [
  { id: 'D6.interrupts', dimension: 'D6', name: '用户打断', scorerKind: 'rule', note: '中途取消标记（中断信号）' },
  { id: 'D6.correctionKeywords', dimension: 'D6', name: '纠正关键词（疑似）', scorerKind: 'rule', diagnostic: true, note: '只作疑似防误伤：中文纠正词命中，LLM 层复核后才真扣' },
  { id: 'D6.similarMessages', dimension: 'D6', name: '相似消息反复发', scorerKind: 'rule', note: '同一诉求换着说法重发（用户没得到想要的东西的信号）' },
  { id: 'D6.classification', dimension: 'D6', name: '用户消息九分类', scorerKind: 'llm', note: '逐条分类：纠正/打断/推卸决策扣重，不该问的问扣轻；合理澄清/用户改主意/越界求确认/高危先问/补充信息不扣，证据两可不判' },
];

export const d6Autonomy: DimensionDefinition = {
  id: 'D6',
  name: '自主性',
  english: 'Autonomy',
  role: 'weighted',
  weightInTotal: 0.20,
  items,
  // 扣分数值待校准：打断 0.15/次、相似重发 0.08/次、LLM 分类加权重事件 0.12/当量
  aggregation: {
    kind: 'count-deduction',
    perEvent: { 'D6.interrupts': 0.15, 'D6.similarMessages': 0.08, 'D6.classification': 0.12 },
  },
};
