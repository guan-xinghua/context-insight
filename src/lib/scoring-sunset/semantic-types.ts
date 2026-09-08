// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// P2 语义层类型：G/S 八维 LLM 评审结果 + 方差治理四件套元数据。
// 结果仅存 localStorage（先例 wf-analysis-<taskId>），不落 Prisma。

export interface SemanticDimSample {
  id: string;
  score: number | null;
  reason: string;
  evidence: string[];
}

export interface SemanticSampleResult {
  dimensions: SemanticDimSample[];
}

export interface SemanticDimResult {
  id: string;
  label: string;
  status: 'ok' | 'not-evaluated';
  score: number | null;
  reason: string;
  evidence: string[];
  distribution: Array<number | null>;
  stdDev: number | null;
  agreement: number | null;
  sampleCount: number;
  abstainCount: number;
}

export interface SemanticGovernanceCall {
  latencyMs: number;
  tokens: number;
  costUsd: number;
}

export interface SemanticGovernance {
  numSamples: number;
  samplesTaken: number;
  agreement: number | null;
  abstained: string[];
  budgetUsd: number;
  spentUsd: number;
  budgetExceeded: boolean;
  calls: SemanticGovernanceCall[];
  elapsedSec: number;
  model: string;
  generatedAt: string;
}

export interface SemanticScore {
  schema: 'semantic-score';
  version: 1;
  taskId: string;
  dimensions: SemanticDimResult[];
  governance: SemanticGovernance;
}

const DIM_ID_RE = /^[GS][1-5]$/;

export function isValidSemanticScore(v: unknown): v is SemanticScore {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<SemanticScore>;
  if (s.schema !== 'semantic-score' || s.version !== 1) return false;
  if (typeof s.taskId !== 'string') return false;
  if (!Array.isArray(s.dimensions) || s.dimensions.length === 0) return false;
  for (const d of s.dimensions) {
    if (typeof d !== 'object' || d === null) return false;
    const dim = d as Partial<SemanticDimResult>;
    if (typeof dim.id !== 'string' || !DIM_ID_RE.test(dim.id)) return false;
    if (dim.score !== null && typeof dim.score !== 'number') return false;
    if (dim.score !== null && (dim.score < 0 || dim.score > 10)) return false;
  }
  const g = s.governance;
  if (typeof g !== 'object' || g === null) return false;
  const gov = g as Partial<SemanticGovernance>;
  return typeof gov.numSamples === 'number'
    && typeof gov.samplesTaken === 'number'
    && typeof gov.budgetExceeded === 'boolean';
}
