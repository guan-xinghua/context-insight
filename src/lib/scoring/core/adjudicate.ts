// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 疑似人工复核（adjudication）：规则层「疑似」是静态解析不了的线索，不定罪——
// 默认先不扣分，用户逐点确认（有问题 → 恢复扣分；没问题 → 出疑似池）。
// 确认状态独立落盘（~/.cannbot-insight/adjudications/<sessionId>.json）；
// 评分卡是缓存可重算，GET/重算后由 applyAdjudications 重新覆盖应用。

import fs from 'node:fs';
import path from 'node:path';
import { profileMatches, aggregateCard, aggregateDimension } from './aggregator';
import { CANNBOT_HOME } from './store';
import type { DimensionDefinition } from './schema';
import type { Evidence, Scorecard, SubItemResult } from './types';

export type AdjudicationVerdict = 'problem' | 'fine';

export function adjudicationDir(): string {
  return process.env.SCORING_ADJUDICATION_DIR ?? path.join(CANNBOT_HOME, 'adjudications');
}

/** 疑似点标识：子项 × 轮次 × 标签（评分可重算，轮次与标签稳定即可对上） */
export function pointKeyOf(itemId: string, e: Evidence): string {
  return `${itemId}|${e.turnIndex ?? '-'}|${e.label}`;
}

function fileOf(sessionId: string): string {
  if (!/^[A-Za-z0-9_.\-]+$/.test(sessionId)) throw new Error(`非法 sessionId：${sessionId.slice(0, 40)}`);
  return path.join(adjudicationDir(), `${sessionId}.json`);
}

export function loadAdjudications(sessionId: string): Record<string, { verdict: AdjudicationVerdict; at: string }> {
  try {
    return JSON.parse(fs.readFileSync(fileOf(sessionId), 'utf-8'));
  } catch {
    return {};
  }
}

export function recordAdjudication(sessionId: string, key: string, verdict: AdjudicationVerdict): void {
  const dir = adjudicationDir();
  fs.mkdirSync(dir, { recursive: true });
  const rec = loadAdjudications(sessionId);
  rec[key] = { verdict, at: new Date().toISOString() };
  fs.writeFileSync(fileOf(sessionId), JSON.stringify(rec, null, 2), 'utf-8');
}

/** 维度披露跟复核态走——复核完成后再挂「建议人工复核」就是过期提示 */
function dimDisclose(items: SubItemResult[]): string | undefined {
  const problems = items.filter(i => i.adjState === 'problem').length;
  const pending = items.filter(i => i.adjState === 'pending').length;
  if (problems > 0) return `人工复核：${problems} 个子项确认有问题（已扣分）`;
  if (pending > 0) return `疑似待人工确认（先不扣分）：${pending} 个子项待确认`;
  return undefined;   // 全部排除：清白状态不需要警示文案
}

/**
 * 覆盖层：把确认状态应用到卡上并重新聚合（维度分 + 整卡）。
 * - 疑似子项默认先不扣分（verdict 暂转 clean，adjState=pending）
 * - 任一疑似点确认有问题 → 恢复 suspected（按子项扣 0.2，与原口径一致）
 * - 全部疑似点确认没问题 → clean 出池（note 留痕）
 * liveProfile 传入当前生效 profile（registry.profile）：与卡的 profile 不一致（卡算完
 * 用户换了模板）时不重聚合分数——旧子项 × 新权重 = 两头不是的混合总分；子项级
 * 确认态照常展示，分数等重算后再动。
 */
export function applyAdjudications(
  card: Scorecard,
  defs: DimensionDefinition[],
  liveProfile?: { id: string; name: string } | null,
): Scorecard {
  const rec = loadAdjudications(card.sessionId);
  const recordOf = (itemId: string, e: Evidence): AdjudicationVerdict | null =>
    rec[pointKeyOf(itemId, e)]?.verdict ?? null;
  const reaggregate = profileMatches(card, liveProfile);
  let changed = false;
  const dimensions = card.dimensions.map(dim => {
    const def = defs.find(d => d.id === dim.dimensionId);
    if (!def || !dim.items.some(i => i.verdict === 'suspected')) return dim;
    changed = true;
    const items: SubItemResult[] = dim.items.map(item => {
      if (item.verdict !== 'suspected') return item;
      const evidence = item.evidence.map(e => {
        const r = recordOf(item.itemId, e);
        return r ? { ...e, adj: r } : e;
      });
      const problems = evidence.filter(e => e.adj === 'problem').length;
      const pending = evidence.filter(e => !e.adj).length;
      if (problems > 0) {
        return { ...item, evidence, adjState: 'problem' as const, verdict: 'suspected', note: `人工复核：${problems} 个疑似点确认有问题` };
      }
      if (pending === 0) {
        return { ...item, evidence, adjState: 'fine' as const, verdict: 'clean', note: '人工复核：疑似点全部确认没问题' };
      }
      const fine = evidence.length - problems - pending;
      return {
        ...item, evidence, adjState: 'pending' as const, verdict: 'clean',
        note: `疑似待人工确认（先不扣分）：已排除 ${fine}，待确认 ${pending}——逐点确认有问题才扣分`,
      };
    });
    const disclose = dimDisclose(items);
    return reaggregate
      ? { ...dim, items, ...aggregateDimension(def, items), disclose }
      : { ...dim, items, disclose };
  });
  if (!changed) return card;
  return reaggregate
    ? { ...card, dimensions, framework: { ...card.framework, ...aggregateCard(dimensions, defs) } }
    : { ...card, dimensions };
}
