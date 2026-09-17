// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 执行器（角色⑥）：装配 → 逐项评分 → 聚合 → 写入存储。
// 1. finishReason=truncated → status:'aborted' 的卡直接返回，不写盘（也不进基线语料）
// 2. 逐项 try/catch：异常转 error 态（失败也是一条记录），流程不断
// 3. withSemantic=false 时 LLM 评分器整体 skip（不报 error，标 not-applicable）

import type { PrismaClient } from '@prisma/client';
import type { AIProviderConfig } from '@/lib/ai/analyzer';
import { assembleInput } from './assembler';
import { aggregateCard, aggregateDimension } from './aggregator';
import { TrackedLlmClient } from './llm';
import { JudgeJournal } from './judge-log';
import { scorecardStore, type ScorecardStore } from './store';
import { SCORECARD_SCHEMA, type DimensionResult, type Scorecard, type SubItemResult } from './types';

import type { Registry } from '../registry';

export const SCORER_VERSION = 'v2.0';

export interface RunScorecardOptions {
  withSemantic?: boolean;
  provider?: AIProviderConfig;
  /** 测试注入：直接给 LLM 客户端（优先于 provider） */
  llmClient?: import('./assembler/types').LlmClient;
  store?: ScorecardStore;
  registry?: Registry;
  /** 同 sid 双会话（方案一）消歧：限定记录类（framework 值），缺省取最新一行 */
  framework?: string;
  /** 并行评审路数（子项互不依赖），默认 3 */
  llmConcurrency?: number;
  /** 进度回调（语义层逐子项推送；总数只含 LLM 子项，不必精确到秒） */
  onProgress?: (info: { done: number; total: number; current: string }) => void;
}

export async function runScorecard(
  taskId: string,
  prisma: PrismaClient,
  options: RunScorecardOptions = {},
): Promise<Scorecard | null> {
  const { loadRegistry } = await import('../registry');
  const registry = options.registry ?? await loadRegistry();
  const store = options.store ?? scorecardStore();

  const assembled = await assembleInput(taskId, prisma, options.framework);
  if (!assembled) return null;
  const { input } = assembled;

  // 前置门：截断 → 整卡出局（中止的卡不写盘、不进基线语料）
  if (input.finishReason === 'truncated') {
    return {
      schemaVersion: SCORECARD_SCHEMA,
      sessionId: assembled.raw.session.sessionId,
      taskType: input.taskType,
      computedAt: new Date().toISOString(),
      status: 'aborted',
      abortReason: 'truncated',
      framework: { totalScore: null, veto: null, coverage: 0, weightsUsed: {} },
      dimensions: [],
      judgeCost: null,
    };
  }

  const withSemantic = options.withSemantic === true;
  // 过程日志（可维护性）：真实 provider 路径逐 attempt 落盘请求/响应（claude-jsonl
  // 格式，可导入分析）；注入 client 的测试路径不落盘。创建失败返回 null，绝不阻断评分
  const journal = withSemantic && options.provider && !options.llmClient
    ? JudgeJournal.create(assembled.raw.session.sessionId, {
        model: options.provider.model,
        concurrency: Math.max(1, options.llmConcurrency ?? 3),
        scorerVersion: SCORER_VERSION,
        withSemantic,
      })
    : null;
  // 成本记账统一在执行器侧：注入 client 与 provider 同口径（评别人的账自己也要记账）
  let judgeCalls = 0;
  let judgeTokens = 0;
  const rawLlm = withSemantic
    ? (options.llmClient ?? (options.provider ? new TrackedLlmClient(options.provider, journal ?? undefined, assembled.raw.session.sessionId) : undefined))
    : undefined;
  const llm = rawLlm
    ? {
      model: rawLlm.model,
      complete: async (system: string, user: string, meta?: import('./assembler/types').JudgeCallMeta) => {
        judgeCalls++;
        const r = await rawLlm.complete(system, user, meta);
        judgeTokens += r.promptTokens + r.completionTokens;
        return r;
      },
    }
    : undefined;

  // 子项互不依赖 → 并行评审（默认 3 路，网关限流内的 wall-time 提速）；
  // 结果按维度/子项原序回填，评分卡顺序与串行版完全一致
  const llmTotal = registry.defs.reduce((s, d) => s + d.items.filter(i => i.scorerKind === 'llm').length, 0);
  let llmDone = 0;
  const results = new Map<string, SubItemResult>();
  const tasks = registry.defs.flatMap(def =>
    def.items
      .filter(itemDef => registry.scorerOf.has(itemDef.id))
      .map(itemDef => ({ itemDef, scorer: registry.scorerOf.get(itemDef.id)! })),
  );
  const naResult = (itemId: string, label: string): SubItemResult => ({
    itemId, label, status: 'not-applicable',
    note: '未开启 LLM 评审，无法评判',
    evidence: [],
  });
  const errResult = (itemId: string, label: string, err: unknown): SubItemResult => ({
    itemId, label, status: 'error', evidence: [],
    error: { message: err instanceof Error ? err.message : '评分器异常' },
  });

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const { itemDef, scorer } = tasks[idx];
      const needsLlm = itemDef.scorerKind === 'llm';
      if (needsLlm && !llm) {
        results.set(itemDef.id, naResult(itemDef.id, itemDef.name));
        continue;
      }
      const itemMeta = { dimensionId: itemDef.dimension, itemId: itemDef.id, itemName: itemDef.name };
      if (needsLlm) {
        options.onProgress?.({ done: llmDone, total: llmTotal, current: `${itemDef.id} ${itemDef.name}` });
      }
      try {
        const r = await scorer.run({ input, def: itemDef, llm, samples: 1, sessionId: assembled.raw.session.sessionId });
        results.set(itemDef.id, r);
        if (needsLlm) journal?.result(itemMeta, r);
      } catch (err) {
        const r = errResult(itemDef.id, itemDef.name, err);
        results.set(itemDef.id, r);
        if (needsLlm) journal?.result(itemMeta, r);
      }
      if (needsLlm) {
        llmDone++;
        options.onProgress?.({ done: llmDone, total: llmTotal, current: `${itemDef.id} ${itemDef.name}` });
      }
    }
  };
  const concurrency = Math.max(1, options.llmConcurrency ?? 3);
  const runT0 = Date.now();
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  } finally {
    if (journal) {
      const statusCounts: Record<string, number> = {};
      for (const r of results.values()) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
      journal.footer({ durationMs: Date.now() - runT0, judgeCalls, judgeTokens, items: statusCounts });
    }
  }

  const dimensions: DimensionResult[] = [];
  for (const def of registry.defs) {
    const items = def.items
      .filter(itemDef => registry.scorerOf.has(itemDef.id))
      .map(itemDef => results.get(itemDef.id))
      .filter((r): r is SubItemResult => r != null);
    const agg = aggregateDimension(def, items);
    dimensions.push({
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
    });
  }

  const framework = aggregateCard(dimensions, registry.defs);
  const card: Scorecard = {
    schemaVersion: SCORECARD_SCHEMA,
    sessionId: assembled.raw.session.sessionId,
    taskType: input.taskType,
    computedAt: new Date().toISOString(),
    status: 'completed',
    framework: { ...framework, profile: registry.profile ?? null },
    dimensions,
    judgeCost: rawLlm ? { calls: judgeCalls, tokens: judgeTokens } : null,
    context: {
      models: [...new Set(assembled.raw.turns.map(t => t.model).filter((m): m is string => m != null))],
      tools: [...new Set(input.toolCalls.map(tc => tc.toolName))].sort(),
      frameworkVersion: assembled.raw.session.version ?? null,
      turns: input.turns.filter(t => !t.isSubagent).length,
      totalTokens: input.measures.totalTokens,
    },
    meta: { semanticUsed: withSemantic, scorerVersion: SCORER_VERSION, ...(journal ? { judgeLogFile: journal.file } : {}) },
  };
  await store.put(card);
  return card;
}
