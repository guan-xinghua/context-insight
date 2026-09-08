// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// P2 评审编排：N 样本独立评审 → 中位数投票 / 多数弃权 NOT_EVALUATED /
// 预算熔断提前收口 / 逐调用自观测 trace。复用 analyzer 的摘要构建与
// OpenAI-compatible 调用形态；成本用 cost-calculator 定价表估算。

import type { PrismaClient } from '@prisma/client';
import { buildChatUrl, stripJsonFence, type AIProviderConfig } from '@/lib/ai/analyzer';
import { buildTurnDigest, buildBridgeDigest } from '@/lib/ai/analyzer';
import { calculateCostNullSafe } from '@/lib/ingest/cost-calculator';
import type { TokenUsage } from '@/lib/shared/types';
import { SEMANTIC_DIMENSIONS } from './semantic-rubric';
import { buildSemanticSystemPrompt, buildSemanticUserPrompt } from './semantic-rubric';
import type { SemanticDimResult, SemanticSampleResult, SemanticScore, SemanticGovernance } from './semantic-types';

export const DEFAULT_NUM_SAMPLES = 5;
export const DEFAULT_BUDGET_USD = 0.5;

export interface JudgeOptions {
  numSamples?: number;
  budgetUsd?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── 纯函数：投票 / 弃权 / 方差（可单测）─────────────────────

export function aggregateSamples(samples: SemanticSampleResult[]): SemanticDimResult[] {
  const labelOf = new Map(SEMANTIC_DIMENSIONS.map(d => [d.id, d.label]));
  return SEMANTIC_DIMENSIONS.map(dim => {
    const per = samples
      .map(s => s.dimensions.find(d => d.id === dim.id) ?? null)
      .map(d => (d && typeof d.score === 'number' && d.score >= 0 && d.score <= 10 ? d : d ? { ...d, score: null } : null));
    const distribution = per.map(d => (d ? d.score : null));
    const abstainCount = distribution.filter(s => s === null).length;
    const sampleCount = samples.length;

    if (sampleCount === 0 || abstainCount > sampleCount / 2) {
      const firstAbstain = per.find(d => d !== null);
      return {
        id: dim.id, label: labelOf.get(dim.id) ?? dim.id, status: 'not-evaluated' as const,
        score: null, reason: firstAbstain?.reason ?? '无有效样本', evidence: [],
        distribution, stdDev: null, agreement: null, sampleCount, abstainCount,
      };
    }

    const scored = per.filter((d): d is NonNullable<typeof d> & { score: number } => d !== null && d.score !== null);
    const values = scored.map(d => d.score).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 === 1 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);
    const representative = scored.find(d => d.score === median) ?? scored[0];
    const agreement = values.filter(v => Math.abs(v - median) <= 1).length / sampleCount;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const stdDev = round2(Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length));

    return {
      id: dim.id, label: labelOf.get(dim.id) ?? dim.id, status: 'ok' as const,
      score: median, reason: representative?.reason ?? '', evidence: representative?.evidence ?? [],
      distribution, stdDev, agreement: round2(agreement), sampleCount, abstainCount,
    };
  });
}

export function semanticScoreOf(score: SemanticScore): number | null {
  const scored = score.dimensions.filter(d => d.status === 'ok' && d.score !== null);
  if (scored.length === 0) return null;
  return round2(scored.reduce((s, d) => s + d.score!, 0) / scored.length / 10);
}

// ── LLM 调用（analyzer 同款 URL 归一 / json_object）────────

interface ChatOutcome {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  latencyMs: number;
}

async function callChat(provider: AIProviderConfig, system: string, user: string): Promise<ChatOutcome> {
  const chatUrl = buildChatUrl(provider.baseUrl);
  const started = Date.now();
  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.7,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    // 带上实际请求的端点（去 query，防 baseUrl 内嵌密钥回显）与模型名，404/401 一眼可判
    const urlForError = chatUrl.replace(/\?.*$/, '');
    throw new Error(`LLM ${res.status}（${urlForError} · model=${provider.model}）: ${body || '无响应体'}`);
  }
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 响应缺少 choices[0].message.content');
  return {
    content,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
    },
    latencyMs: Date.now() - started,
  };
}

function parseSample(content: string): SemanticSampleResult | null {
  try {
    const parsed = JSON.parse(stripJsonFence(content)) as { dimensions?: unknown };
    if (!Array.isArray(parsed.dimensions)) return null;
    const dims = parsed.dimensions
      .filter((d): d is { id: string; score: number | null; reason?: string; evidence?: unknown } =>
        typeof d === 'object' && d !== null && typeof (d as { id?: unknown }).id === 'string')
      .map(d => ({
        id: d.id,
        score: typeof d.score === 'number' && d.score >= 0 && d.score <= 10 ? Math.round(d.score) : null,
        reason: typeof d.reason === 'string' ? d.reason : '',
        evidence: Array.isArray(d.evidence) ? d.evidence.filter((e): e is string => typeof e === 'string').slice(0, 6) : [],
      }));
    if (dims.length === 0) return null;
    return { dimensions: dims };
  } catch {
    return null;
  }
}

function usageToCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const usage: TokenUsage = {
    total: promptTokens + completionTokens,
    input: promptTokens,
    output: completionTokens,
    reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, inputMessagesTokens: 0,
  };
  return calculateCostNullSafe(model, usage);
}

// ── 编排入口 ───────────────────────────────────────────────

export async function runSemanticJudge(
  taskId: string,
  provider: AIProviderConfig,
  prisma: PrismaClient,
  options: JudgeOptions = {},
): Promise<SemanticScore> {
  const numSamples = Math.max(1, Math.min(9, Math.floor(options.numSamples ?? DEFAULT_NUM_SAMPLES)));
  const budgetUsd = Math.max(0.01, options.budgetUsd ?? DEFAULT_BUDGET_USD);

  const session = await prisma.session.findFirst({ where: { taskId }, select: { id: true } });
  if (!session) throw new Error(`Session not found: ${taskId}`);

  const turns = await prisma.turn.findMany({
    where: { sessionId: session.id },
    orderBy: [{ turnIndex: 'asc' }],
    select: {
      turnIndex: true, role: true, agentName: true, isSubagent: true, subagentName: true,
      contentSummary: true, createdAt_ts: true, totalTokens: true, inputTokens: true,
      outputTokens: true, latencyMs: true, model: true,
      toolCalls: { select: { toolName: true, state: true } },
    },
  });
  const bridges = await prisma.interactionBridge.findMany({
    where: { sessionId: session.id },
    select: {
      id: true, dispatchContent: true, dispatchTimestamp: true, subagentType: true,
      subagentName: true, status: true, subagentTokens: true, subagentLatencyMs: true, dispatchTurnId: true,
    },
  });

  const turnDigest = buildTurnDigest(turns.map(t => ({ ...t, createdAt_ts: t.createdAt_ts ? t.createdAt_ts.toISOString() : null })));
  const bridgeDigest = buildBridgeDigest(bridges.map(b => ({ ...b, dispatchTimestamp: b.dispatchTimestamp ? b.dispatchTimestamp.toISOString() : null })));
  const system = buildSemanticSystemPrompt();
  const user = buildSemanticUserPrompt(turnDigest, bridgeDigest);

  const startedAt = Date.now();
  const samples: SemanticSampleResult[] = [];
  const calls: SemanticGovernance['calls'] = [];
  let spentUsd = 0;
  let budgetExceeded = false;
  let samplesTaken = 0;

  for (let i = 0; i < numSamples; i++) {
    if (calls.length > 0 && spentUsd + calls[calls.length - 1].costUsd > budgetUsd) {
      budgetExceeded = true;
      break;
    }
    let outcome: ChatOutcome | null = null;
    let sample = null;
    for (let attempt = 0; attempt < 2 && sample === null; attempt++) {
      outcome = await callChat(provider, system, user);
      samplesTaken++;
      const costUsd = usageToCostUsd(provider.model, outcome.usage.prompt_tokens, outcome.usage.completion_tokens);
      spentUsd += costUsd;
      calls.push({ latencyMs: outcome.latencyMs, tokens: outcome.usage.prompt_tokens + outcome.usage.completion_tokens, costUsd });
      sample = parseSample(outcome.content);
    }
    if (sample) samples.push(sample);
  }

  if (samples.length === 0) {
    throw new Error('所有评审样本均解析失败（检查模型是否支持 response_format json_object）');
  }

  const dimensions = aggregateSamples(samples);
  const scoredDims = dimensions.filter(d => d.status === 'ok' && d.agreement !== null);
  const agreement = scoredDims.length > 0
    ? round2(scoredDims.reduce((s, d) => s + d.agreement!, 0) / scoredDims.length)
    : null;

  return {
    schema: 'semantic-score',
    version: 1,
    taskId,
    dimensions,
    governance: {
      numSamples,
      samplesTaken,
      agreement,
      abstained: dimensions.filter(d => d.status === 'not-evaluated').map(d => d.id),
      budgetUsd,
      spentUsd: round2(spentUsd),
      budgetExceeded,
      calls,
      elapsedSec: round2((Date.now() - startedAt) / 1000),
      model: provider.model,
      generatedAt: new Date().toISOString(),
    },
  };
}
