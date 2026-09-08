// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Workflow 轨迹评分 P1+P2 —— 评分卡类型（设计方案 §5 schema，v1）。
// 原则：分数是账本——每个指标带 formula/inputs/evidence，可展开复算。

import type { SemanticDimResult, SemanticGovernance } from './semantic-types';

export type MetricStatus = 'ok' | 'not-evaluated';

export interface ScorecardEvidence {
  label: string;
  turnIndex: number | null;
  detail?: string;
}

export interface MetricInput {
  label: string;
  value: string | number;
}

export interface MetricResult {
  id: string;
  label: string;
  status: MetricStatus;
  value: number | null;
  unit?: string;
  band?: string;
  formula: string;
  inputs: MetricInput[];
  evidence: ScorecardEvidence[];
  note?: string;
}

export interface NodeCost {
  name: string;
  isSubagent: boolean;
  tokens: number;
  cost: number;
  latencyMs: number;
  toolCallCount: number;
  toolCallErrorCount: number;
  tokenPct: number;
}

export interface NodeCostsResult {
  status: MetricStatus;
  nodes: NodeCost[];
  formula: string;
  note?: string;
}

export interface PlanStepMatch {
  step: string;
  matched: boolean;
  evidenceTurnIndex: number | null;
  evidenceTool?: string;
}

export interface PlanDeviationBreakdown {
  matchMode: 'ANY_ORDER' | 'IN_ORDER' | 'NONE';
  totalSteps: number;
  matchedSteps: number;
  inOrderRatio: number;
  missed: string[];
  steps: PlanStepMatch[];
}

export interface LoopPattern {
  kind: 'tool_repeat' | 'ping_pong';
  tool: string;
  length: number;
  turnIndexes: number[];
  detail?: string;
}

export type LoopBand = 'none' | 'minor' | 'moderate' | 'severe';

export interface WorkflowScorecardSession {
  taskId: string;
  framework: string;
  version: string | null;
  model: string | null;
  startTime: string | null;
  endTime: string | null;
  totalTokens: number;
  totalCost: number;
  totalLatencyMs: number;
  turnCount: number;
  toolCallCount: number;
}

export interface WorkflowScorecard {
  schema: 'workflow-scorecard';
  version: 1;
  session: WorkflowScorecardSession;
  deterministic: {
    repeatedRead: MetricResult;
    dupInjectionCopies: MetricResult;
    cacheMissPrefixCost: MetricResult;
    staleToolResults: MetricResult;
    revertCycles: MetricResult;
    churnFiles: MetricResult;
    nakedWrite: MetricResult;
    loop: MetricResult;
    planDeviation: MetricResult;
  };
  efficiency: {
    costPerOutcome: MetricResult;
    tokenPerTask: MetricResult;
    timeCost: MetricResult;
    nodeCosts: NodeCostsResult;
    inputRedundancy: MetricResult;
    hiddenOverhead: MetricResult;
    compactLoss: MetricResult;
  };
  semantic:
    | { status: 'not-evaluated'; note: string }
    | {
        status: 'evaluated';
        score: number | null;
        dimensions: SemanticDimResult[];
        governance: SemanticGovernance;
      };
  aggregate: {
    healthScore: number | null;
    coverage: number;
    weights: { deterministic: number; semantic: number; efficiency: number };
    dimensions: { deterministic: number | null; semantic: number | null; efficiency: number | null };
    shortBoard: string | null;
    hardGateTriggered: boolean;
    hardGateReasons: string[];
  };
  meta: { computedAt: string; scorerVersion: string };
}
