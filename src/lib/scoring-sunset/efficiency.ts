// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 效率层 E1–E3：单位成果成本 / 逐节点成本归因 / 上下文经济。

import type { MetricResult, NodeCostsResult, NodeCost } from './types';
import type { ScoreExecution, ScoreTurn, WireCharsSummary } from './collect';
import { round2 } from './metrics';

const COMPACT_CMD_RE = /<command-name>\s*\/?\s*compact/i;

// ── E1 单位成果成本 ───────────────────────────────────────

export function computeCostPerOutcome(
  session: { totalCost: number; totalTokens: number },
  todoSteps: Array<{ content: string; status: string }> | null,
): { costPerOutcome: MetricResult; tokenPerTask: MetricResult; outcomes: number } {
  const completed = todoSteps ? todoSteps.filter(t => ['completed', 'done'].includes(t.status.toLowerCase())).length : 0;
  const outcomes = todoSteps ? completed : 1;

  const costPerOutcome: MetricResult = outcomes > 0
    ? {
        id: 'E1', label: '单位成果成本', status: 'ok', value: round2(session.totalCost / outcomes), unit: 'USD',
        formula: `cost_per_outcome = 总成本 / 完成目标数 = ${round2(session.totalCost)} / ${outcomes} = ${round2(session.totalCost / outcomes)}`,
        inputs: [
          { label: '总成本', value: round2(session.totalCost) },
          { label: todoSteps ? '完成 todo 数' : '目标数（无 todo 声明，按整 session 1 计）', value: outcomes },
        ],
        evidence: [],
      }
    : {
        id: 'E1', label: '单位成果成本', status: 'not-evaluated', value: null, unit: 'USD',
        formula: '完成目标数为 0，无法计算',
        inputs: [{ label: 'todo 步骤数', value: todoSteps?.length ?? 0 }],
        evidence: [],
        note: '有计划声明但无 completed 项',
      };

  const tokenPerTask: MetricResult = {
    id: 'E1b', label: '单任务 token 消耗', status: 'ok', value: session.totalTokens, unit: 'tokens',
    formula: `token_per_task = 会话总 token = ${session.totalTokens}`,
    inputs: [{ label: '会话总 token', value: session.totalTokens }],
    evidence: [],
  };

  return { costPerOutcome, tokenPerTask, outcomes };
}

// ── E1c 时间成本（与 token/费用并列的第三种成本口径，信息项）──

export function computeTimeCost(
  session: { startTime: Date | null; endTime: Date | null; totalLatencyMs: number },
  outcomes: number,
): MetricResult {
  const wallMs = session.startTime && session.endTime
    ? Math.max(0, session.endTime.getTime() - session.startTime.getTime())
    : null;
  const activeSec = Math.round(session.totalLatencyMs / 1000);
  if (wallMs == null && activeSec === 0) {
    return {
      id: 'E1c', label: '时间成本', status: 'not-evaluated', value: null,
      formula: '数据不可用，不进分母',
      inputs: [], evidence: [],
      note: '会话无起止时间且无耗时记录',
    };
  }
  const sec = wallMs != null ? Math.round(wallMs / 1000) : activeSec;
  const mins = Math.floor(sec / 60);
  const perOutcome = outcomes > 0 ? Math.round(sec / outcomes) : null;
  return {
    id: 'E1c', label: '时间成本', status: 'ok', value: sec, unit: 'seconds',
    formula: `时间成本 = 会话墙钟时长 = ${sec}s（${mins} 分）${wallMs == null ? '（墙钟不可得，按活跃耗时计）' : ''}${perOutcome != null ? `；时间单位成果 = ${sec}s / ${outcomes} = ${perOutcome}s/目标` : ''}`,
    inputs: [
      { label: '墙钟时长（秒）', value: wallMs != null ? sec : '不可得' },
      { label: '活跃耗时（秒，Σ turn 时长）', value: activeSec },
      ...(perOutcome != null ? [{ label: '时间单位成果（秒/目标）', value: perOutcome }] : []),
    ],
    evidence: [],
    note: '与 token/费用并列的第三种成本口径；墙钟含用户思考间隙，活跃耗时 = agent 实际工作时间。v1 信息项不进效率分母，权重化待基线校准（P3）',
  };
}

// ── E2 逐节点成本归因（节点 = Execution / agent）──────────

export function computeNodeCosts(executions: ScoreExecution[]): NodeCostsResult {
  if (executions.length === 0) {
    return {
      status: 'not-evaluated', nodes: [],
      formula: '无 Execution 行（会话未产出执行单元拆分）',
      note: 'v1 节点 = agent 执行单元；phase 级归因后续版本',
    };
  }
  const totalTokens = executions.reduce((s, e) => s + e.tokens, 0) || 1;
  const nodes: NodeCost[] = executions
    .map(e => ({
      name: e.agentName || (e.isSubagent ? 'subagent' : 'root'),
      isSubagent: e.isSubagent,
      tokens: e.tokens,
      cost: e.cost,
      latencyMs: e.latencyMs,
      toolCallCount: e.toolCallCount,
      toolCallErrorCount: e.toolCallErrorCount,
      tokenPct: round2(e.tokens / totalTokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  return {
    status: 'ok', nodes,
    formula: `节点 = Execution（agent 执行单元）；tokenPct = 节点 tokens / Σ tokens（Σ = ${totalTokens}）`,
  };
}

// ── E3 上下文经济 ─────────────────────────────────────────

export function computeInputRedundancy(d2a: MetricResult, d2c: MetricResult): MetricResult {
  if (d2a.status !== 'ok' && d2c.status !== 'ok') {
    return {
      id: 'E3a', label: '输入冗余占比', status: 'not-evaluated', value: null, unit: 'ratio',
      formula: '非 claude 格式会话无 wire 报文',
      inputs: [], evidence: [],
    };
  }
  const a = d2a.value ?? 0;
  const c = d2c.value ?? 0;
  const value = Math.min(1, a + c);
  return {
    id: 'E3a', label: '输入冗余占比', status: 'ok', value: round2(value), unit: 'ratio',
    formula: `输入冗余占比 = min(1, D2a 轮内重复副本 + D2c 陈旧工具结果) = min(1, ${a} + ${c}) = ${round2(value)}`,
    inputs: [
      { label: 'D2a 轮内重复注入副本', value: a },
      { label: 'D2c 陈旧工具结果占比', value: c },
    ],
    evidence: [],
    note: '可物理去除的输入冗余：cpx 去重（D2a）+ context editing 清理（D2c）能删掉的部分',
  };
}

export function computeHiddenOverhead(wire: WireCharsSummary | null): MetricResult {
  if (!wire || wire.requestChars === 0) {
    return {
      id: 'E3b', label: '隐藏system开销占比', status: 'not-evaluated', value: null, unit: 'ratio',
      formula: '非 claude 格式会话无 wire 报文',
      inputs: [], evidence: [],
    };
  }
  const value = wire.systemChars / wire.requestChars;
  return {
    id: 'E3b', label: '隐藏system开销占比', status: 'ok', value: round2(value), unit: 'ratio',
    formula: `隐藏 system 开销 = system 消息字符 / 请求字符总量 = ${wire.systemChars} / ${wire.requestChars} = ${round2(value)}`,
    inputs: [
      { label: '请求字符总量', value: wire.requestChars },
      { label: 'system 消息字符量', value: wire.systemChars },
    ],
    evidence: [],
    note: '信息项：system 注入不全是浪费，不进效率分',
  };
}

export function computeCompactLoss(turns: ScoreTurn[]): MetricResult {
  const rootDataTurns = turns.filter(t => !t.isSubagent && (t.inputMessagesTokens > 0 || t.inputTokens > 0 || t.totalTokens > 0));
  const compactEvents: Array<{ turnIndex: number; atISO: string | null }> = [];
  for (const t of turns) {
    if (t.isSubagent) continue;
    const text = `${t.content ?? ''}\n${t.contentSummary ?? ''}`;
    if (t.agentName === 'compaction-boundary' || COMPACT_CMD_RE.test(text)) {
      compactEvents.push({ turnIndex: t.turnIndex, atISO: t.createdAtTsISO ?? t.createdAtISO });
    }
  }

  if (compactEvents.length === 0) {
    return {
      id: 'E3c', label: '压缩损失token', status: 'ok', value: 0, unit: 'tokens',
      formula: '无 compact 事件，损失为 0',
      inputs: [], evidence: [],
    };
  }

  const inputOf = (t: ScoreTurn): number => t.inputMessagesTokens || t.inputTokens || t.totalTokens;
  let loss = 0;
  const evidence: Array<{ label: string; turnIndex: number | null }> = [];
  for (const ev of compactEvents) {
    const evMs = ev.atISO ? new Date(ev.atISO).getTime() : NaN;
    if (Number.isNaN(evMs)) continue;
    const pre = [...rootDataTurns].reverse().find(t => {
      const ts = t.createdAtTsISO ?? t.createdAtISO;
      return ts ? new Date(ts).getTime() <= evMs : false;
    });
    const post = rootDataTurns.find(t => {
      const ts = t.createdAtTsISO ?? t.createdAtISO;
      return ts ? new Date(ts).getTime() >= evMs : false;
    });
    if (pre && post) {
      const drop = Math.max(0, inputOf(pre) - inputOf(post));
      loss += drop;
      evidence.push({ label: `compact @§${ev.turnIndex}：${inputOf(pre)} → ${inputOf(post)}（-${drop}）`, turnIndex: ev.turnIndex });
    }
  }

  return {
    id: 'E3c', label: '压缩损失token', status: 'ok', value: loss, unit: 'tokens',
    formula: `压缩损失 = Σ 各 compact 事件 (pre 输入 token − post 输入 token) = ${loss}`,
    inputs: [
      { label: 'compact 事件数', value: compactEvents.length },
      { label: '累计损失 token', value: loss },
    ],
    evidence: evidence.slice(0, 5),
  };
}
