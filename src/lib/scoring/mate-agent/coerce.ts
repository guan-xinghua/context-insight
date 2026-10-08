// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Mate Agent 产出 → 评分卡：mate 只判 LLM 子项（scorerKind==='llm'），规则层子项
// 直接用代码卡（runScorecard 规则层）的结果——两按钮共用同一份规则层，只有 LLM 项
// 由不同工具判。维度/整卡聚合复用 aggregateDimension / aggregateCard，渲染零差异。

import type { DimensionDefinition, ScoreItemSchema } from '../core/schema';
import { aggregateCard, aggregateDimension } from '../core/aggregator';
import { SCORECARD_SCHEMA, type DimensionResult, type Scorecard, type SubItemResult } from '../core/types';

interface MateAgentEvidence {
  turn?: number;
  note?: string;
  impact?: string;
}
export interface MateAgentItem {
  itemId?: string;
  verdict?: string | null;
  score?: number | null;
  value?: number | string | null;
  note?: string;
  evidence?: MateAgentEvidence[];
}
export interface MateAgentDimension {
  dimensionId?: string;
  items?: MateAgentItem[];
}
export interface MateAgentParsed {
  summary?: string;
  dimensions?: MateAgentDimension[];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** mate verdict 词表对齐（聚合三态只认 violation/suspected）：旧口径 unauthorized → violation */
const VERDICT_ALIASES: Record<string, string> = { unauthorized: 'violation' };

/** score 归一：约定 0-1；mate 违约给 0-10（如 8）折算 /10，>10 视为非法标度弃用（宁漏勿错） */
function coerceScore(raw: unknown): { score?: number; invalid?: boolean } {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return {};
  if (raw > 10) return { invalid: true };
  return { score: clamp01(raw > 1 ? raw / 10 : raw) };
}

const NA_MARKERS = new Set(['na', 'n/a', 'unknown', 'not-applicable', '无法判定', '无法评判', '缺材料']);

/** 证据倾向词表（mate 违约别名归一）：好/加 → good，坏/扣/问题 → bad */
const IMPACT_OF: Record<string, 'good' | 'bad'> = {
  good: 'good', 加: 'good', 加分: 'good', 好: 'good', 优点: 'good', pro: 'good', plus: 'good',
  bad: 'bad', 减: 'bad', 扣: 'bad', 扣分: 'bad', 问题: 'bad', 缺点: 'bad', con: 'bad', minus: 'bad',
};

function dataPresent(a: MateAgentItem | undefined): boolean {
  if (!a) return false;
  if (typeof a.score === 'number') return true;
  if (typeof a.value === 'number' || (typeof a.value === 'string' && a.value.length > 0)) return true;
  if (typeof a.verdict === 'string' && a.verdict.length > 0 && !NA_MARKERS.has(a.verdict.toLowerCase())) return true;
  return false;
}

/** 把单个 mate 判卷 item 转成 SubItemResult（判不了返回 not-applicable，naKind 源头盖章） */
function coerceLlmItem(def: ScoreItemSchema, a: MateAgentItem | undefined): SubItemResult {
  const explicitNa = a?.verdict != null && typeof a.verdict === 'string' && NA_MARKERS.has(a.verdict.toLowerCase());
  if (!a || !dataPresent(a)) {
    // 三态：mate 没输出 = gap（评审缺口，折覆盖度）；明确判 na（verdict 命中
    // 词表，无 note 也是）或带不适用说明 = absent（评过的不适用结论，不折）
    const absent = explicitNa || (a?.note != null && a.note.length > 0);
    return { itemId: def.id, label: def.name, status: 'not-applicable', evidence: [], naKind: absent ? 'absent' : 'gap', note: a?.note ?? '未覆盖' };
  }
  const { score, invalid } = coerceScore(a.score);
  if (invalid) {
    // 非法分值弃用 = 没给出有效评审 → gap（不是评过的 na，防止覆盖度虚高）
    return { itemId: def.id, label: def.name, status: 'not-applicable', evidence: [], naKind: 'gap', note: `score ${a.score} 超出常规标度（>10），弃用` };
  }
  const rawVerdict = typeof a.verdict === 'string' && a.verdict ? a.verdict : undefined;
  return {
    itemId: def.id,
    label: def.name,
    status: explicitNa ? 'not-applicable' : 'ok',
    naKind: explicitNa ? 'absent' : undefined,
    verdict: rawVerdict ? (VERDICT_ALIASES[rawVerdict] ?? rawVerdict) : undefined,
    score,
    value: a.value ?? undefined,
    note: a.note || undefined,
    evidence: (a.evidence ?? [])
      .map(e => ({ turnIndex: typeof e.turn === 'number' ? e.turn : null, label: e.note ?? '', impact: IMPACT_OF[e.impact ?? ''] }))
      .filter(e => e.label.length > 0),
  };
}

/**
 * 合并成整卡：规则层子项取代码卡（ruleCard）结果，LLM 子项取 mate 判卷。
 * ruleCard = runScorecard(withSemantic=false) 出的卡（LLM 项为 not-applicable）。
 */
export function mergeMateCard(
  ruleCard: Scorecard,
  mateParsed: MateAgentParsed,
  defs: DimensionDefinition[],
  sessionMeta: { sessionId?: string; taskType?: Scorecard['taskType']; context?: Scorecard['context'] },
  review?: Scorecard['review'],
): Scorecard {
  // 截断 → 整卡出局：原样返回不合并（aborted 不落盘由 store 保证，前端按「评价中止」呈现）
  if (ruleCard.status === 'aborted') return ruleCard;
  const ruleDims = new Map(ruleCard.dimensions.map(d => [d.dimensionId, d]));
  const mateItemsByDim = new Map((mateParsed.dimensions ?? []).map(d => [d.dimensionId, d.items ?? []]));

  const dimensions: DimensionResult[] = defs.map(def => {
    const ruleDim = ruleDims.get(def.id);
    const mateItems = new Map((mateItemsByDim.get(def.id) ?? []).map(i => [i.itemId, i]));

    const items: SubItemResult[] = def.items.map(it => {
      if (it.scorerKind === 'llm') {
        const coerced = coerceLlmItem(it, mateItems.get(it.id));
        // mate 未覆盖（没输出 / 判不了 na / 分数超界）→ 回退代码卡该 LLM 项，
        // 但 note 如实标注 mate 未给分的原因——不再冒用确定性层的「未开启 LLM 评审」。
        // naKind 三态由 coerceLlmItem 源头盖章（没输出/坏值 = gap 折覆盖度；
        // 明确判 na / 带不适用说明 = absent 不折），不靠 note 文案归类
        if (coerced.status === 'not-applicable') {
          const fallback = ruleDim?.items.find(i => i.itemId === it.id) ?? coerced;
          const why = coerced.note && coerced.note !== '未覆盖' ? `：${coerced.note}` : '';
          return { ...fallback, note: `Mate 评审未给出该子项${why}`, naKind: coerced.naKind ?? 'gap' };
        }
        return coerced;
      }
      return ruleDim?.items.find(i => i.itemId === it.id)
        ?? { itemId: it.id, label: it.name, status: 'not-applicable', evidence: [] };
    });

    const agg = aggregateDimension(def, items);
    return {
      dimensionId: def.id,
      name: def.name,
      english: def.english,
      custom: def.id.startsWith('D7'),
      role: def.role,
      status: agg.status,
      score: agg.score,
      verdict: agg.verdict,
      disclose: agg.disclose,
      items,
    };
  });

  const framework = aggregateCard(dimensions, defs);
  return {
    schemaVersion: SCORECARD_SCHEMA,
    sessionId: sessionMeta.sessionId ?? ruleCard.sessionId,
    taskType: sessionMeta.taskType ?? ruleCard.taskType,
    computedAt: new Date().toISOString(),
    status: 'completed',
    framework: { ...framework, profile: ruleCard.framework.profile ?? null },
    dimensions,
    judgeCost: null,
    review,
    context: sessionMeta.context ?? ruleCard.context,
    meta: { semanticUsed: true, scorerVersion: 'mate-agent' },
  };
}