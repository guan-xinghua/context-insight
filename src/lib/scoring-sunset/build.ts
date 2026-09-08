// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分卡装配入口：collect → metrics/efficiency → aggregate → WorkflowScorecard v1。

import type { PrismaClient } from '@prisma/client';
import { collectScoringData } from './collect';
import {
  computeRepeatedRead,
  computeDupInjectionCopies,
  computeCacheMissPrefixCost,
  computeStaleToolResults,
  computeRework,
  computeNakedWrite,
  computeLoop,
  computePlanDeviation,
  extractTodoSteps,
} from './metrics';
import {
  computeCostPerOutcome,
  computeTimeCost,
  computeNodeCosts,
  computeInputRedundancy,
  computeHiddenOverhead,
  computeCompactLoss,
} from './efficiency';
import { aggregateScore } from './aggregate';
import type { WorkflowScorecard } from './types';
import type { SemanticScore } from './semantic-types';
import { semanticScoreOf } from './semantic-judge';

export const SCORER_VERSION = 'p2-v3';

export async function buildScorecard(
  taskId: string,
  prisma: PrismaClient,
  semantic?: SemanticScore | null,
): Promise<WorkflowScorecard | null> {
  const data = await collectScoringData(taskId, prisma);
  if (!data) return null;

  const repeatedRead = computeRepeatedRead(data.toolCalls);
  const dupInjectionCopies = computeDupInjectionCopies(data.wire);
  const cacheMissPrefixCost = computeCacheMissPrefixCost(data.wire);
  const staleToolResults = computeStaleToolResults(data.wire);
  const { revertCycles, churnFiles } = computeRework(data.toolCalls);
  const nakedWrite = computeNakedWrite(data.toolCalls);
  const { metric: loop, band } = computeLoop(data.toolCalls);
  const { metric: planDeviation } = computePlanDeviation(data.toolCalls);

  const { costPerOutcome, tokenPerTask, outcomes } = computeCostPerOutcome(
    { totalCost: data.session.totalCost, totalTokens: data.session.totalTokens },
    extractTodoSteps(data.toolCalls),
  );
  const timeCost = computeTimeCost(data.session, outcomes);

  const inputRedundancy = computeInputRedundancy(dupInjectionCopies, staleToolResults);
  const hiddenOverhead = computeHiddenOverhead(data.wire);
  const compactLoss = computeCompactLoss(data.turns);

  const agg = aggregateScore({
    d1: repeatedRead,
    d2a: dupInjectionCopies,
    d2b: cacheMissPrefixCost,
    d2c: staleToolResults,
    revertCycles,
    nakedWrite,
    loopBand: band,
    loopMetric: loop,
    planDeviation,
    inputRedundancy,
    compactLoss,
    sessionTotalTokens: data.session.totalTokens,
    semanticScore: semantic ? semanticScoreOf(semantic) : null,
  });

  return {
    schema: 'workflow-scorecard',
    version: 1,
    session: {
      taskId: data.session.taskId,
      framework: data.session.framework,
      version: data.session.version,
      model: data.session.model,
      startTime: data.session.startTime ? data.session.startTime.toISOString() : null,
      endTime: data.session.endTime ? data.session.endTime.toISOString() : null,
      totalTokens: data.session.totalTokens,
      totalCost: data.session.totalCost,
      totalLatencyMs: data.session.totalLatencyMs,
      turnCount: data.turns.length,
      toolCallCount: data.toolCalls.length,
    },
    deterministic: {
      repeatedRead,
      dupInjectionCopies,
      cacheMissPrefixCost,
      staleToolResults,
      revertCycles,
      churnFiles,
      nakedWrite,
      loop,
      planDeviation,
    },
    efficiency: {
      costPerOutcome,
      tokenPerTask,
      timeCost,
      nodeCosts: computeNodeCosts(data.executions),
      inputRedundancy,
      hiddenOverhead,
      compactLoss,
    },
    semantic: semantic
      ? {
          status: 'evaluated' as const,
          score: semanticScoreOf(semantic),
          dimensions: semantic.dimensions,
          governance: semantic.governance,
        }
      : {
          status: 'not-evaluated' as const,
          note: '语义层（G/S 八维 LLM 评审）未生成；生成后计入权重与覆盖度',
        },
    aggregate: {
      healthScore: agg.healthScore,
      coverage: agg.coverage,
      weights: { deterministic: 0.4, semantic: 0.4, efficiency: 0.2 },
      dimensions: agg.dimensions,
      shortBoard: agg.shortBoard,
      hardGateTriggered: agg.hardGateTriggered,
      hardGateReasons: agg.hardGateReasons,
    },
    meta: { computedAt: new Date().toISOString(), scorerVersion: SCORER_VERSION },
  };
}
