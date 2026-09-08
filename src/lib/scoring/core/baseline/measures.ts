// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基线度量提取（一源两用）：D4/D5 评分器与「设为基线会话」写基线用同一组函数——
// 评分时怎么量，设基线时就怎么量，永不漂移。key 与基线文件的 metrics 一一对应。

import type { AssembledInput } from '../assembler/types';

export interface BaselineMeasure {
  unit: string;
  measure: (input: AssembledInput) => number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const BASELINE_MEASURES: Record<string, BaselineMeasure> = {
  'D4.tokens': { unit: 'tokens', measure: input => input.measures.totalTokens > 0 ? input.measures.totalTokens : null },
  'D4.llmTime': { unit: 'ms', measure: input => input.measures.llmTimeMs > 0 ? input.measures.llmTimeMs : null },
  'D4.toolTime': { unit: 'ms', measure: input => input.measures.toolTimeMs > 0 ? input.measures.toolTimeMs : null },
  'D4.turns': { unit: '轮', measure: input => { const n = input.turns.filter(t => !t.isSubagent).length; return n > 0 ? n : null; } },
  'D5.dup': {
    unit: 'ratio',
    measure: input => input.wire && input.wire.requestTokens > 0
      ? round2(input.wire.dupCopyTokens / input.wire.requestTokens)
      : null,
  },
  'D5.stale': {
    unit: 'ratio',
    measure: input => input.wire && input.wire.requestTokens > 0
      ? round2(input.wire.staleResultTokens / input.wire.requestTokens)
      : null,
  },
};
