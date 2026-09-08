// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D5 评分器：三类比率（基线对比）+ 重复尝试（规则）+ 工具调用出错（规则）+ 项目说明相关性 / 熟练度（LLM）。
// 非 proxy 的 session 缺的信号标"不适用"——不瞎评，也不因此整维放弃。

import { Scorer, okResult, notApplicable, ev, round2, type ScorerContext } from '../core/scorer';
import type { SubItemResult } from '../core/types';
import { BaselineCompareScorer } from '../core/baseline-compare';
import { BandJudgeScorer } from '../core/judge';
import { BASELINE_MEASURES } from '../core/baseline/measures';
import { consecutiveRuns, parseDispatches, redispatchClusters, isEnvFailure, isFailed } from '../core/loop-detect';

const NO_WIRE = '缺少 wire 逐轮报文（非 proxy 捕获），无法评判';

export function d5Scorers(): Scorer[] {
  return [
    new UnusedToolsScorer(),
    new UnusedSkillsScorer(),
    new BaselineCompareScorer(
      { id: 'D5.dup', dimension: 'D5', name: '重复塞进来的内容', scorerKind: 'baseline-compare' },
      {
        baselineKey: 'D5.dup',
        measure: BASELINE_MEASURES['D5.dup'].measure,
        notApplicableNote: NO_WIRE,
        unit: 'ratio',
      },
    ),
    new BaselineCompareScorer(
      { id: 'D5.stale', dimension: 'D5', name: '过期的旧结果', scorerKind: 'baseline-compare' },
      {
        baselineKey: 'D5.stale',
        measure: BASELINE_MEASURES['D5.stale'].measure,
        notApplicableNote: NO_WIRE,
        unit: 'ratio',
      },
    ),
    new RedispatchScorer(),
    new RepeatScorer(),
    new ToolErrorsScorer(),
    new BandJudgeScorer(
      { id: 'D5.memory', dimension: 'D5', name: '没用上的项目说明', scorerKind: 'llm' },
      {
        focus: '塞进上下文的项目说明（CLAUDE.md / AGENTS.md）与本次任务的相关性：无关的部分是白背的',
        material: input => input.memoryDigest ? `\n\n## 项目说明全文（节选）\n${input.memoryDigest}` : '',
        notApplicableWhen: input => input.memoryDigest ? null : '缺少项目说明注入，无法评判',
      },
    ),
    new BandJudgeScorer(
      { id: 'D5.proficiency', dimension: 'D5', name: '工作过程熟练度', scorerKind: 'llm' },
      {
        focus: 'agent 干活的每一轮有没有实际进展：每步是否直接推进任务、有没有绕路和无效尝试；工具返回的结果后续有没有真正用上（结果为空或失败后的合理重试不算忽略）',
      },
    ),
  ];
}

// ── D5.redispatch subagent 重派（60% 大头）：同任务重派 = 非常大的冗余。
// 同类型 + 同任务（description 编号标识交集聚簇）派发 ≥2 记 簇长−1（首个免费，
// 不要求连续——重派天然隔着别的活，重派一次就是完整一轮"验收-修复"）。
// 一次重派背后是十几 turn、M 级 token 的完整子会话，记 50 次调用当量：
// rate = 重派×50 ÷ 总调用，×10 线性扣——一次就显著、五次见底；环境类重试豁免。

const SUBAGENT_EQUIVALENT = 50;

class RedispatchScorer extends Scorer {
  readonly id = 'D5.redispatch';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const calls = ctx.input.toolCalls;
    if (calls.length === 0) return notApplicable(ctx.def, '无工具调用，无法评判');
    const dispatches = parseDispatches(calls);
    if (dispatches.length === 0) return notApplicable(ctx.def, '没有 subagent 派发，无法评判');

    let repeats = 0;
    let exempted = 0;
    const evidence: SubItemResult['evidence'] = [];
    for (const cluster of redispatchClusters(dispatches)) {
      for (let i = 1; i < cluster.dispatches.length; i++) {
        if (isEnvFailure(cluster.dispatches[i - 1].call)) { exempted++; continue; }
        repeats++;
      }
      evidence.push(ev(cluster.dispatches[1].call.turnIndex,
        `${cluster.name} ×${cluster.dispatches.length}：${cluster.dispatches.map(d => d.desc.slice(0, 20)).join(' / ')}`.slice(0, 140)));
    }

    const rate = (repeats * SUBAGENT_EQUIVALENT) / calls.length;
    const score = round2(Math.max(0, 1 - rate * 10));
    return okResult(ctx.def, {
      value: repeats,
      unit: 'redispatches',
      score,
      formula: `重派 ${repeats} 次 ×${SUBAGENT_EQUIVALENT} 当量 ÷ 总调用 ${calls.length} = ${round2(rate)} ×10 线性扣 → ${score}${exempted > 0 ? `（环境类重试豁免 ${exempted} 次不计）` : ''}`,
      evidence: evidence.slice(0, 8),
      note: repeats > 0 ? `重派一次记 ${SUBAGENT_EQUIVALENT} 当量：一次重派背后是十几 turn、M 级 token 的完整子会话` : undefined,
    });
  }
}

// ── D5.repeat 原样重复（15%）：工具/调用层的低层重复，单价低轻罚。
// 同工具+同参数原文连续 ≥3 次连发记 段长−1（首个合法；隔开的重跑是好习惯）；
// rate = 重复数 ÷ 总调用，×10 线性扣（稀有事件放大）。

class RepeatScorer extends Scorer {
  readonly id = 'D5.repeat';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const calls = ctx.input.toolCalls;
    if (calls.length === 0) return notApplicable(ctx.def, '无工具调用，无法评判');

    let repeats = 0;
    let exempted = 0;
    const evidence: SubItemResult['evidence'] = [];
    for (const run of consecutiveRuns(calls)) {
      const failed = run.calls.filter(isFailed);
      if (failed.length > 0 && failed.every(isEnvFailure)) { exempted += run.length - 1; continue; }
      repeats += run.length - 1;
      if (evidence.length < 4) evidence.push(ev(run.calls[1].turnIndex, `${run.calls[0].toolName} 原样连发 ×${run.length}`));
    }

    const rate = repeats / calls.length;
    const score = round2(Math.max(0, 1 - rate * 10));
    return okResult(ctx.def, {
      value: repeats,
      unit: 'repeats',
      score,
      formula: `原样连发 ${repeats} 次 ÷ 总调用 ${calls.length} = ${round2(rate)} ×10 线性扣 → ${score}${exempted > 0 ? `（环境类重试豁免 ${exempted} 次不计）` : ''}`,
      evidence,
    });
  }
}

// ── D5.toolErrors 工具调用出错（10%，自 D3 迁入）：可避免错误的白干频率。
// 分工：错误的代价（多花的 token/耗时）在 D4 比值里罚，这里只罚频率——错一次白干一次。
// 环境类错误豁免（超时/网络/限流——不是 agent 的错），只罚可避免的：
// 路径错、参数错、语法错、文件不存在、权限不足。
// 与 D5.repeat 去重（首错切分）：原样连发段内的后续重发归 repeat 罚，这里只计段内首错——
// 同一个错误只罚一次，罚的维度随行为定性：错（糙）vs 不看结果原样重发（不消化）。

class ToolErrorsScorer extends Scorer {
  readonly id = 'D5.toolErrors';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const calls = ctx.input.toolCalls;
    if (calls.length === 0) return notApplicable(ctx.def, '无工具调用，无法评判');

    const excluded = new Set<string>();
    for (const run of consecutiveRuns(calls)) {
      for (const tc of run.calls.slice(1)) excluded.add(tc.id);
    }

    const failed = calls.filter(isFailed);
    const avoidable = failed.filter(tc => !isEnvFailure(tc) && !excluded.has(tc.id));
    const env = failed.filter(isEnvFailure).length;
    const refireExempt = failed.filter(tc => excluded.has(tc.id) && !isEnvFailure(tc)).length;
    const ratio = avoidable.length / calls.length;
    const score = round2(Math.max(0, 1 - ratio * 10));   // 稀有事件线性放大：2% 错 → 0.8，10% → 0
    return okResult(ctx.def, {
      value: `${avoidable.length}/${calls.length}`,
      unit: 'errors',
      score,
      formula: `可避免错误 ${avoidable.length} / 总调用 ${calls.length} = ${round2(ratio)} ×10 线性扣 → ${score}（环境类豁免 ${env}、原样重发归 D5.repeat 不重计 ${refireExempt}）`,
      evidence: avoidable.slice(0, 8).map(tc => ev(tc.turnIndex, `${tc.toolName}：${(tc.errorMessage ?? tc.errorType ?? '').slice(0, 60)}`)),
    });
  }
}

// ── 没用上的工具说明 / skill（统计不扣分）：两个列表每会话全量注入，单会话
// 没用不代表浪费（任务不需要而已）——证据不足不定罪；占上下文的量照实统计。
// 与 D4.waste 同款 diagnostic 形态：有 value 有账本，无 score 不进加权。

class UnusedInjectionScorer extends Scorer {
  readonly needs = ['toolCalls', 'wire'] as const;

  protected constructor(
    readonly id: string,
    private readonly label: string,
    private readonly declaredOf: (input: ScorerContext['input']) => Array<{ name: string; approxTokens: number }> | null | undefined,
    private readonly usedOf: (input: ScorerContext['input']) => Set<string>,
  ) {
    super();
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const declared = this.declaredOf(ctx.input);
    if (!declared || declared.length === 0) return notApplicable(ctx.def, NO_WIRE);
    const used = this.usedOf(ctx.input);
    const unusedItems = declared.filter(t => !used.has(t.name.toLowerCase()));
    const total = declared.reduce((s, t) => s + t.approxTokens, 0);
    if (total <= 0) return notApplicable(ctx.def, `缺少${this.label}的 token 记录，无法统计`);
    const unused = unusedItems.reduce((s, t) => s + t.approxTokens, 0);
    const ratio = round2(unused / total);
    return okResult(ctx.def, {
      value: ratio,
      unit: 'ratio',
      formula: `${this.label} ${declared.length} 个、未用 ${unusedItems.length} 个，未用部分占注入 ${Math.round(ratio * 100)}%——只统计不扣分`,
      evidence: unusedItems.slice(0, 5).map(t => ev(null, `未用：${t.name}`)),
      note: `${this.label}每会话全量注入，单会话没用不代表浪费（任务不需要而已）`,
    });
  }
}

class UnusedToolsScorer extends UnusedInjectionScorer {
  override readonly id = 'D5.tools';
  constructor() {
    super('D5.tools', '工具',
      input => input.wire?.declaredTools,
      input => new Set(input.toolCalls.map(tc => tc.toolName.toLowerCase())));
  }
}

class UnusedSkillsScorer extends UnusedInjectionScorer {
  override readonly id = 'D5.skills';
  constructor() {
    super('D5.skills', 'skill',
      input => input.wire?.availableSkills,
      input => {
        const used = new Set<string>();
        for (const tc of input.toolCalls) {
          const n = tc.toolName.toLowerCase();
          if (n === 'skill' || n === 'invoke_skill') {
            const m = (tc.argsJson ?? '').match(/"name"\s*:\s*"([^"]+)"/);
            if (m) used.add(m[1].toLowerCase());
          }
          const m2 = (tc.argsJson ?? '').match(/skill[\/\\:]?\s*([a-z0-9_-]{3,40})/i);
          if (m2) used.add(m2[1].toLowerCase());
        }
        return used;
      });
  }
}
