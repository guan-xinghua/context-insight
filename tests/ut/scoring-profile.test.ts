// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分配置 profile 单测：sanitize 硬/软校验、apply 覆盖变换（克隆安全/勾除/权重/自定义项注入）、
// 聚合回归锁（average-with-floor 加权、未设权重行为不变、count-deduction 未知子项不 NaN）、模板健全性。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sanitizeProfile } from '../../src/lib/scoring/core/profile/store';
import { applyProfile } from '../../src/lib/scoring/core/profile/apply';
import { PRESETS, isPresetId } from '../../src/lib/scoring/core/profile/presets';
import { D1_LOCKED_ITEMS } from '../../src/lib/scoring/core/profile/types';
import type { ScoringProfile } from '../../src/lib/scoring/core/profile/types';
import { BUILTIN_DIMENSIONS } from '../../src/lib/scoring/definitions';
import { aggregateDimension } from '../../src/lib/scoring/core/aggregator';
import type { DimensionDefinition } from '../../src/lib/scoring/core/schema';
import type { SubItemResult } from '../../src/lib/scoring/core/types';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-unit-'));
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');

const baseProfile = (over: Partial<ScoringProfile> = {}): ScoringProfile => ({
  schema: 'scoring-profile',
  version: 1,
  id: 'test-profile',
  name: '测试配置',
  ...over,
});

const okItem = (itemId: string, score: number, value?: number): SubItemResult => ({
  itemId, label: itemId, status: 'ok', score, evidence: [], ...(value != null ? { value } : {}),
});

describe('sanitizeProfile：硬错拒绝', () => {
  it('D1 规则四项不可勾除', () => {
    for (const id of D1_LOCKED_ITEMS) {
      expect(() => sanitizeProfile(baseProfile({ excludedItems: [id] }))).toThrow(/否决证据链/);
    }
  });

  it('维度权重非法值拒绝', () => {
    expect(() => sanitizeProfile(baseProfile({ dimensionWeights: { D2: -0.1 } }))).toThrow(/维度权重非法/);
    expect(() => sanitizeProfile(baseProfile({ dimensionWeights: { D3: Number.NaN } }))).toThrow(/维度权重非法/);
  });

  it('D4/D5 自定义项必填权重', () => {
    const custom = (target: string): unknown => ({
      id: `${target}.my-check`, targetDimension: target, name: '我的检查', kind: 'rule' as const,
      rule: { signal: 'command', compare: 'exists' as const },
    });
    expect(() => sanitizeProfile(baseProfile({ customItems: [custom('D4')] as never }))).toThrow(/需填权重/);
    expect(() => sanitizeProfile(baseProfile({ customItems: [custom('D5')] as never }))).toThrow(/需填权重/);
  });

  it('自定义项 id 与内置子项冲突拒绝；preset 前缀保留', () => {
    expect(() => sanitizeProfile(baseProfile({
      customItems: [{ id: 'D3.correctness', targetDimension: 'D3', name: '冒名', kind: 'llm', bands: [{ range: '0-2', label: '差', description: '很差很差' }, { range: '9-10', label: '好', description: '很好很好' }] }],
    }))).toThrow(/冲突/);
    expect(() => sanitizeProfile(baseProfile({ id: 'preset:fake' } as never))).toThrow(/preset/);
  });

  it('非法 schema/名称拒绝', () => {
    expect(() => sanitizeProfile(42)).toThrow(/对象/);
    expect(() => sanitizeProfile({ version: 1 })).toThrow(/格式不符/);
    expect(() => sanitizeProfile({ schema: 'other', version: 1 })).toThrow(/格式不符/);
    expect(() => sanitizeProfile(baseProfile({ name: '' }))).toThrow(/名称/);
  });
});

describe('sanitizeProfile：软伤剥离进 warnings', () => {
  it('未知子项 id 剥离；D1/D7 维度权重剥离；语义退化提示', () => {
    const { profile, warnings } = sanitizeProfile(baseProfile({
      excludedItems: ['D3.correctness', 'D9.nothing'],
      itemWeights: { 'D9.nothing': 2 },
      dimensionWeights: { D1: 0.5, D7: 0.3, D3: 0.45 } as never,
    }));
    expect(profile.excludedItems).toEqual(['D3.correctness']);
    expect(profile.itemWeights).toBeUndefined();
    expect(profile.dimensionWeights).toEqual({ D3: 0.45 });
    expect(warnings.some(w => w.includes('D9.nothing'))).toBe(true);
    expect(warnings.some(w => w.includes('D1'))).toBe(true);
    expect(warnings.some(w => w.includes('质量地板失效'))).toBe(true);
  });

  it('D1/D2/D6 自定义项的权重被忽略', () => {
    const { profile, warnings } = sanitizeProfile(baseProfile({
      customItems: [{ id: 'D6.focus-check', targetDimension: 'D6', name: '专注检查', kind: 'rule', weight: 0.2, rule: { signal: 'turns', compare: 'lte', threshold: 30 } }],
    }));
    expect(profile.customItems![0].weight).toBeUndefined();
    expect(warnings.some(w => w.includes('不按权重计'))).toBe(true);
  });
});

describe('applyProfile：覆盖变换', () => {
  it('不修改内置定义常量（克隆安全）', () => {
    applyProfile(BUILTIN_DIMENSIONS, baseProfile({ excludedItems: ['D2.redlines'], dimensionWeights: { D3: 0.5 } }));
    expect(BUILTIN_DIMENSIONS.find(d => d.id === 'D2')!.items).toHaveLength(5);
    expect(BUILTIN_DIMENSIONS.find(d => d.id === 'D3')!.weightInTotal).toBe(0.35);
  });

  it('勾除子项退出 def.items；未知 id 与 D1 锁定项运行时宽容剥离', () => {
    const { defs, warnings } = applyProfile(BUILTIN_DIMENSIONS, baseProfile({
      excludedItems: ['D2.redlines', 'D9.nothing', 'D1.verifiedRun'],
    }));
    const d2 = defs.find(d => d.id === 'D2')!;
    expect(d2.items.map(i => i.id)).not.toContain('D2.redlines');
    const d1 = defs.find(d => d.id === 'D1')!;
    expect(d1.items.map(i => i.id)).toContain('D1.verifiedRun');
    expect(warnings.some(w => w.includes('D9.nothing'))).toBe(true);
    expect(warnings.some(w => w.includes('D1.verifiedRun'))).toBe(true);
  });

  it('维度/子项权重覆盖生效', () => {
    const { defs } = applyProfile(BUILTIN_DIMENSIONS, baseProfile({
      dimensionWeights: { D3: 0.5 },
      itemWeights: { 'D3.benchScore': 3 },
    }));
    expect(defs.find(d => d.id === 'D3')!.weightInTotal).toBe(0.5);
    expect(defs.find(d => d.id === 'D3')!.items.find(i => i.id === 'D3.benchScore')!.weight).toBe(3);
  });

  it('自定义项注入：D2/D6 标 diagnostic、D1 进 completionScoreOf、评分器就位', () => {
    const { defs, scorers } = applyProfile(BUILTIN_DIMENSIONS, baseProfile({
      customItems: [
        { id: 'D2.extra-watch', targetDimension: 'D2', name: '额外监视', kind: 'rule', rule: { signal: 'keyword', compare: 'absent' } },
        { id: 'D1.thorough', targetDimension: 'D1', name: '彻底性', kind: 'llm', bands: [{ range: '0-2', label: '差', description: '很差很差' }, { range: '9-10', label: '好', description: '很好很好' }] },
        { id: 'D3.doc-sync', targetDimension: 'D3', name: '文档同步', kind: 'llm', weight: 0.5, bands: [{ range: '0-2', label: '差', description: '很差很差' }, { range: '9-10', label: '好', description: '很好很好' }] },
      ],
    }));
    expect(defs.find(d => d.id === 'D2')!.items.find(i => i.id === 'D2.extra-watch')!.diagnostic).toBe(true);
    expect(defs.find(d => d.id === 'D1')!.items.find(i => i.id === 'D1.thorough')!.diagnostic).toBeUndefined();
    const d1Policy = defs.find(d => d.id === 'D1')!.aggregation;
    expect(d1Policy.kind === 'three-state' && d1Policy.completionScoreOf).toContain('D1.thorough');
    expect(scorers.map(s => s.id).sort()).toEqual(['D1.thorough', 'D2.extra-watch', 'D3.doc-sync'].sort());
  });
});

describe('聚合回归锁', () => {
  const floorDef = (weights?: Record<string, number>): DimensionDefinition => ({
    id: 'DX', name: 'X', english: 'X', role: 'weighted', weightInTotal: 0.5,
    items: [
      { id: 'a', dimension: 'DX', name: 'a', scorerKind: 'rule', ...(weights?.a != null ? { weight: weights.a } : {}) },
      { id: 'b', dimension: 'DX', name: 'b', scorerKind: 'rule', ...(weights?.b != null ? { weight: weights.b } : {}) },
      { id: 'floor', dimension: 'DX', name: 'floor', scorerKind: 'llm' },
    ],
    aggregation: { kind: 'average-with-floor', floorItemId: 'floor', floorThreshold: 0.2, floorMaxScore: 0.4 },
  });

  it('未设权重 = 纯平均（行为不变）；地板触发封顶', () => {
    const items = [okItem('a', 0.9), okItem('b', 0.6), okItem('floor', 0.2)];
    expect(aggregateDimension(floorDef(), items).score).toBe(0.4);
    expect(aggregateDimension(floorDef(), [okItem('a', 0.9), okItem('b', 0.6), okItem('floor', 0.5)]).score).toBe(0.67);
  });

  it('设了权重按加权均值；地板仍以 floor 子项自身分数触发', () => {
    const items = [okItem('a', 0.8), okItem('b', 0.6), okItem('floor', 0.3)];
    expect(aggregateDimension(floorDef({ a: 3, b: 1 }), items).score).toBe(0.66);
    expect(aggregateDimension(floorDef({ a: 3, b: 1 }), [okItem('a', 0.8), okItem('b', 0.6), okItem('floor', 0.1)]).score).toBe(0.4);
  });

  it('count-deduction：未知子项（自定义 D6 项）不产生 NaN', () => {
    const def: DimensionDefinition = {
      id: 'D6', name: '自主性', english: 'A', role: 'weighted', weightInTotal: 0.2,
      items: [{ id: 'D6.interrupts', dimension: 'D6', name: '打断', scorerKind: 'rule' }],
      aggregation: { kind: 'count-deduction', perEvent: { 'D6.interrupts': 0.15 } },
    };
    const score = aggregateDimension(def, [okItem('D6.interrupts', 1, 2), okItem('D6.my-check', 1, 5)]).score;
    expect(score).toBe(0.7);
    expect(Number.isFinite(score)).toBe(true);
  });
});

describe('内置模板健全性', () => {
  const allIds = new Set(BUILTIN_DIMENSIONS.flatMap(d => d.items.map(i => i.id)));
  const llmIds = BUILTIN_DIMENSIONS.flatMap(d => d.items.filter(i => i.scorerKind === 'llm').map(i => i.id));

  it('三个模板，id 全部 preset: 前缀', () => {
    expect(PRESETS).toHaveLength(3);
    expect(PRESETS.every(p => isPresetId(p.id))).toBe(true);
  });

  it('快速免评审 = 恰好全部 LLM 项；极简核心是其超集 + D5.dup/D5.stale', () => {
    const quick = PRESETS.find(p => p.id === 'preset:quick')!;
    expect([...quick.excludedItems!].sort()).toEqual([...llmIds].sort());
    const minimal = PRESETS.find(p => p.id === 'preset:minimal')!;
    expect(minimal.excludedItems!).toEqual(expect.arrayContaining(quick.excludedItems!));
    expect(minimal.excludedItems).toContain('D5.dup');
    expect(minimal.excludedItems).toContain('D5.stale');
    for (const id of [...quick.excludedItems!, ...minimal.excludedItems!]) expect(allIds.has(id)).toBe(true);
  });

  it('算子开发只动维度权重（D3 45%），勾除为空', () => {
    const operator = PRESETS.find(p => p.id === 'preset:operator')!;
    expect(operator.excludedItems).toBeUndefined();
    expect(operator.dimensionWeights!.D3).toBe(0.45);
  });
});
