// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分项 Schema（角色④）：内置六维与 D7 用户自定义共用同一结构。
// 定义是数据——聚合引擎解释执行，不因维度不同写代码分支。

export type ScorerKind = 'rule' | 'llm' | 'baseline-compare' | 'user-input';
export type DimensionRole = 'veto' | 'weighted' | 'optional';

/** 0-10 分五档锚定（LLM 评分项）。一源多用：prompt / 校验 / 页面文案都从它生成 */
export interface Band {
  range: string;          // '9-10'
  label: string;          // '优秀'
  description: string;    // 什么样算这一档（大白话）
}

export interface ScoreItemSchema {
  id: string;             // 'D1.verifiedRun' / 'D3.correctness' / D7 用 'D7.<name>'
  dimension: string;      // 'D1' ~ 'D6'，D7 为 'D7'
  name: string;           // 展示名
  scorerKind: ScorerKind;
  /** 诊断项：出现在评分卡上但不参与维度聚合（如 D4 浪费归因只解释不扣分） */
  diagnostic?: boolean;
  /** LLM 评分项的档位（一源多用） */
  bands?: Band[];
  /** 维度内权重（weighted-average 用；缺省 1） */
  weight?: number;
  note?: string;
}

export type AggregationPolicy =
  | { kind: 'three-state'; rules: ThreeStateRule[]; fallback: string; completionScoreOf?: string[]; verdictScore?: { violation: number; suspectedPenalty: number } }
  | { kind: 'average-with-floor'; floorItemId: string; floorMaxScore: number; floorThreshold: number }
  | { kind: 'weighted-average' }
  | { kind: 'count-deduction'; perEvent: Record<string, number> }
  | { kind: 'direct' };

/** 三态组合规则：when 全部命中才触发（AND）。'*' 键 = 任一子项命中该判定 */
export interface ThreeStateRule {
  when: Record<string, string>;
  then: string;
  disclose?: string;      // 命中时的披露文案（如「无验证证据」）
}

export interface DimensionDefinition {
  id: string;             // 'D1' ~ 'D6'，D7 为 'D7'
  name: string;           // '完成度'
  english: string;        // 'Completion'
  role: DimensionRole;
  /** optional 维（D7）默认只展示不进总分；定义时可选进总分 */
  includeInTotal?: boolean;
  /** 加权维在总分里的权重（四维权重待校准，记进评分卡 weightsUsed） */
  weightInTotal?: number;
  /** 维度级聚合策略（子项聚合之上；three-state 用于否决维出判定） */
  aggregation: AggregationPolicy;
  items: ScoreItemSchema[];
}

/** 三态判定值：否决维的结论 */
export type Verdict = string;   // '完成'|'未完成'|'无法判定' / 'violation'|'suspected'|'clean'
