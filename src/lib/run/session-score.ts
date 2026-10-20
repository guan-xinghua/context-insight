// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话评分融合（第六刀）：joinSessionRefs 负责消歧定行（taskId → rowId），
// 这里按 rowId 批量采集 turns+toolCalls、跑评分卡规则层（D4 效率/D5 冗余的
// 确定性子项），把规则分与异常信号写回 SessionRef——服务端组装（API 路由），
// view-model 与前端组件保持纯消费。裁剪原则（wire 形状决策在此单点）：
// ① findings 只留评分 <1 的异常项（满分零值不占版面），D4.parallel 除外——
// 串行记 0.8 即「持平」，是工作习惯不是缺陷；② evidence 去掉原文引用
// （quote 可能很长，轮次+标签已可定位回放）。

import type { PrismaClient } from '@prisma/client';
import { collectRuleInputs } from '@/lib/scoring/core/assembler/collect';
import { ruleScoresOf, type RuleScoreItem } from '@/lib/scoring/rules';
import type { RuleFinding, SessionRef, SessionRuleScores } from './model';

/** findings 白名单外的满分豁免：并行度串行 0.8 = 持平（只奖不罚的设计本身）。 */
const NEUTRAL_ITEMS = new Set(['D4.parallel']);

/** 复算公式的白话归一：评分器算式尾注（「环境类豁免 N、原样重发归 D5.repeat
 *  不重计 N」）是评分卡域内行话，Run 侧统一替换成「非人为/环境问题不计入」
 *  ——数字细节展开证据可核，行话不出工作台。 */
const PLAIN_EXEMPT_NOTE = '（非人为/环境问题不计入）';
const plainFormula = (formula: string | null): string | null =>
  formula === null ? null : formula.replace(/（环境类[^）]*）/g, PLAIN_EXEMPT_NOTE);

function toFindings(items: RuleScoreItem[]): RuleFinding[] {
  return items
    .filter(i => i.status === 'ok' && typeof i.score === 'number' && i.score < 1 && !NEUTRAL_ITEMS.has(i.itemId))
    .map(i => ({
      itemId: i.itemId,
      label: i.label,
      score: i.score as number,
      value: typeof i.value === 'boolean' ? null : i.value ?? null,
      formula: plainFormula(i.formula ?? null),
      note: i.note ?? null,
      evidence: i.evidence.map(e => ({ turnIndex: e.turnIndex, label: e.label })),
    }));
}

/** 就地填充 lookup 里全部 SessionRef 的 ruleScores（无 turns/toolCalls 的行
 *  记 null，消费方按「规则层不可评」处理）。 */
export async function attachSessionScores(
  lookup: Map<string, SessionRef>,
  prisma: PrismaClient,
): Promise<void> {
  const refs = [...lookup.values()];
  const rowIds = [...new Set(refs.map(r => r.rowId).filter(id => id.length > 0))];
  if (rowIds.length === 0) return;

  const inputs = await collectRuleInputs(prisma, rowIds);
  for (const ref of refs) {
    const data = inputs.get(ref.rowId);
    if (!data || (data.turns.length === 0 && data.toolCalls.length === 0)) {
      ref.ruleScores = null;
      continue;
    }
    const raw = await ruleScoresOf(data.turns, data.toolCalls);
    const scores: SessionRuleScores = {
      d4: raw.d4,
      d5: raw.d5,
      findings: toFindings(raw.items),
    };
    ref.ruleScores = scores;
  }
}
