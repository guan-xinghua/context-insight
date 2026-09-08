// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D1 评分器：D1.stopReason~verifiedRun 代码直算（v1 资产迁移）+ D1.acceptance/goalCoverage LLM（judge 基建实例化）。

import { Scorer, okResult, notApplicable, ev, round2, type ScorerContext } from '../core/scorer';
import type { ScoreItemSchema } from '../core/schema';
import type { SubItemResult } from '../core/types';
import { ChecklistJudgeScorer, CoverageJudgeScorer } from '../core/judge';
import { findLastVerifiedRun, lastWriteSeq } from '../core/test-parser';
import { extractFilePath } from '@/lib/file-restore';
import type { ScoreToolCall } from '../core/assembler/types';

const item = (id: string): ScoreItemSchema => ({
  id,
  dimension: 'D1',
  name: { 'D1.stopReason': '结束原因', 'D1.selfReport': '自报完成态', 'D1.planReconcile': '计划对账', 'D1.verifiedRun': '验证证据', 'D1.acceptance': '验收清单对账', 'D1.goalCoverage': '目标覆盖对账' }[id] ?? id,
  scorerKind: 'rule',
});

// ── D1.stopReason 结束原因（前置门的原料；truncated 由执行器整卡中止）──

class FinishReasonScorer extends Scorer {
  readonly id = 'D1.stopReason';
  readonly needs = ['finishReason'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const fr = ctx.input.finishReason;
    const map: Record<string, { verdict: string; label: string }> = {
      normal: { verdict: 'normal', label: '正常结束' },
      error: { verdict: 'error', label: '错误崩溃' },
      truncated: { verdict: 'truncated', label: '上下文截断' },
      unknown: { verdict: 'unknown', label: '无法确定（无 wire 报文）' },
    };
    const m = map[fr] ?? map.unknown;
    return okResult(ctx.def, {
      verdict: m.verdict,
      value: m.label,
      ...(fr === 'normal' ? { score: 1 } : fr === 'error' ? { score: 0 } : {}),   // 完成度分：unknown 不掺
      formula: `wire stop_reason / 末轮状态 → ${m.label}`,
    });
  }
}

// ── D1.selfReport 自报完成态（末次 TodoWrite）───────────────────────

export function extractTodoSteps(toolCalls: ScoreToolCall[]): Array<{ content: string; status: string }> | null {
  const todoCalls = toolCalls.filter(tc => {
    const n = tc.toolName.toLowerCase();
    return n === 'todowrite' || n === 'todo_write' || n === 'todo';
  });
  if (todoCalls.length === 0) return null;
  const last = todoCalls[todoCalls.length - 1];
  if (!last.argsJson) return null;
  try {
    const parsed = JSON.parse(last.argsJson) as { todos?: Array<{ content?: unknown; status?: unknown }> };
    if (!Array.isArray(parsed.todos) || parsed.todos.length === 0) return null;
    const steps = parsed.todos
      .map(t => ({ content: typeof t.content === 'string' ? t.content : '', status: typeof t.status === 'string' ? t.status : '' }))
      .filter(t => t.content.length > 0);
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

class SelfReportScorer extends Scorer {
  readonly id = 'D1.selfReport';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const steps = extractTodoSteps(ctx.input.toolCalls);
    if (!steps) return notApplicable(ctx.def, '缺少 TodoWrite 计划声明，无法评判');
    const open = steps.filter(s => !['completed', 'done'].includes(s.status.toLowerCase()));
    const verdict = open.length === 0 ? 'completed' : 'incomplete';
    return okResult(ctx.def, {
      verdict,
      value: `${steps.length - open.length}/${steps.length}`,
      score: round2((steps.length - open.length) / steps.length),   // 完成度分 = 已勾 / 总数
      formula: `末次 TodoWrite：${steps.length} 项中 ${open.length} 项未勾 → 自报${verdict === 'completed' ? '完成' : '未完成'}`,
      evidence: open.slice(0, 5).map(s => ev(null, `未勾：${s.content.slice(0, 60)}`)),
      note: '自报不是证据，只参与组合（自报完成 + 无验证 = 「未验证的成功」嫌疑）',
    });
  }
}

// ── D1.planReconcile 计划对账（v1 computePlanDeviation 迁移，只取两端）──

function tokenizeStep(step: string): string[] {
  const out = new Set<string>();
  const lower = step.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_\-./]{2,}/g)) out.add(m[0]);
  for (const m of lower.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    if (run.length <= 2) out.add(run);
    else for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

const HIGH_PLAN = 0.8;
const LOW_PLAN = 0.5;

class PlanDeviationScorer extends Scorer {
  readonly id = 'D1.planReconcile';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const steps = extractTodoSteps(ctx.input.toolCalls);
    if (!steps) return notApplicable(ctx.def, '缺少 TodoWrite 计划声明，无法评判');

    const searchSpace = ctx.input.toolCalls
      .filter(tc => {
        const n = tc.toolName.toLowerCase();
        return n !== 'todowrite' && n !== 'todo_write' && n !== 'todo';
      })
      .map(tc => ({
        tc,
        text: `${tc.argsJson ?? ''}\n${(tc.resultJson ?? '').slice(0, 20000)}`.toLowerCase(),
      }));

    const matches = steps.map(step => {
      const tokens = tokenizeStep(step.content);
      let hit: { turnIndex: number; tool: string } | null = null;
      for (const s of searchSpace) {
        const found = tokens.filter(t => s.text.includes(t));
        const ok = found.length >= 2 || (found.length >= 1 && found[0].length >= 4);
        if (ok) { hit = { turnIndex: s.tc.turnIndex, tool: s.tc.toolName }; break; }
      }
      return { step: step.content, matched: hit !== null, hit };
    });

    const total = steps.length;
    const matched = matches.filter(m => m.matched).length;
    const ratio = total === 0 ? 0 : matched / total;
    const verdict = ratio >= HIGH_PLAN ? 'high' : ratio < LOW_PLAN ? 'low' : 'mid';

    return okResult(ctx.def, {
      verdict,
      value: round2(ratio),
      score: round2(ratio),   // 完成度分 = 计划对账率
      unit: 'ratio',
      formula: `对账率 = 有工具痕迹步骤 / 总步骤 = ${matched} / ${total} = ${round2(ratio)}（≥${HIGH_PLAN} 正面 / <${LOW_PLAN} 负面）`,
      evidence: matches.filter(m => !m.matched).slice(0, 5).map(m => ev(null, `无痕迹：${m.step.slice(0, 60)}`))
        .concat(matches.filter(m => m.matched).slice(0, 3).map(m => ev(m.hit!.turnIndex, `「${m.step.slice(0, 40)}」→ ${m.hit!.tool}`))),
      note: '找到字样 ≠ 做成，只取两端参与判定',
    });
  }
}

// ── D1.verifiedRun 验证证据（白名单 + 时序：最后一次改代码之后）───────

const WRITE_FAMILIES = new Set(['write', 'edit', 'edit1', 'multiedit']);
const isWriteCall = (tc: ScoreToolCall) => WRITE_FAMILIES.has(tc.toolName.toLowerCase()) && extractFilePath(tc.argsJson) != null;

class VerificationScorer extends Scorer {
  readonly id = 'D1.verifiedRun';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const since = lastWriteSeq(ctx.input.toolCalls, isWriteCall);
    const last = findLastVerifiedRun(ctx.input.toolCalls, { sinceSeq: since });
    if (!last) {
      return okResult(ctx.def, {
        verdict: 'none',
        value: since >= 0 ? '改代码后无验证运行' : '无验证运行',
        formula: '白名单验证命令（npm test / pytest / make / ctest…；grep "test"、cat 不算）在最后一次改代码之后无运行',
        note: '宁漏勿错：只认白名单命令',
      });
    }
    const { call, summary } = last;
    if (summary && summary.failed === 0 && summary.passed > 0) {
      return okResult(ctx.def, {
        verdict: 'passed',
        value: `${summary.passed} passed`,
        score: 1,
        formula: `最后一次改代码后 §${call.turnIndex} 跑 ${summary.framework}：${summary.passed} 通过 / ${summary.skipped} 跳过`,
        evidence: [ev(call.turnIndex, `验证命令（${summary.framework}）`)],
      });
    }
    if (summary && summary.failed > 0) {
      return okResult(ctx.def, {
        verdict: 'failed',
        value: `${summary.passed} passed / ${summary.failed} failed`,
        score: 0,
        formula: `§${call.turnIndex} ${summary.framework}：${summary.passed} 通过 / ${summary.failed} 失败`,
        evidence: [ev(call.turnIndex, `验证失败（${summary.framework}）`)],
      });
    }
    return okResult(ctx.def, {
      verdict: 'none',
      value: '跑了验证但输出不可解析',
      formula: `§${call.turnIndex} 有白名单验证命令，但输出无测试统计（解析不出计数按无验证计）`,
      evidence: [ev(call.turnIndex, '验证命令输出不可解析')],
    });
  }
}

// ── 汇总导出 ────────────────────────────────────────────────

export function d1Scorers(): Scorer[] {
  return [
    new FinishReasonScorer(),
    new SelfReportScorer(),
    new PlanDeviationScorer(),
    new VerificationScorer(),
    new ChecklistJudgeScorer(item('D1.acceptance'), {
      declaration: input => input.workflowDecl?.acceptance ?? null,
      declarationLabel: '验收清单',
      completionScore: true,
      itemStatuses: ['met', 'unmet', 'not-run', 'unidentifiable'],
      failStatuses: ['unmet', 'not-run'],
      failVerdict: 'unmet',
      passVerdict: 'met',
      fallbackVerdict: 'na',
    }),
    new CoverageJudgeScorer(item('D1.goalCoverage'), { completionScore: true }),
  ];
}
