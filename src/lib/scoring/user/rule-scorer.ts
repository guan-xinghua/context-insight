// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D7 规则判定维度（零 LLM）：用户声明「信号 × 比较」——如"命令 npm test 存在"、
// "docs/ 下有写入"。声明式而非代码执行（安全、可校验、可解释），全部取数来自
// 装配产物（toolCalls/turns/measures），证据必须带 §N 轮次（与其他维度同纪律）。
// 信号测不到 → 无法评判（缺什么说什么），不虚判。

import type { AssembledInput, ScoreToolCall } from '../core/assembler/types';
import { Scorer, okResult, notApplicable, ev, type ScorerContext } from '../core/scorer';
import type { ScoreItemSchema } from '../core/schema';
import type { SubItemResult } from '../core/types';
import { commandOf, findLastVerifiedRun, lastWriteSeq } from '../core/test-parser';
import { extractFilePath } from '@/lib/file-restore';

export interface RuleSpec {
  signal: string;              // 信号 key（SIGNALS 注册表）
  filter?: string;             // 正则过滤（作用对象视信号而定）
  compare: 'gte' | 'lte' | 'eq' | 'exists' | 'absent';
  threshold?: number;          // gte/lte/eq 必填
}

interface SignalResult {
  /** null = 测不到（无法评判） */
  value: number | null;
  evidence: SubItemResult['evidence'];
  /** 人话描述命中物（进公式），如「命令命中 2 次」 */
  hitLabel: string;
}

export interface SignalDef {
  label: string;
  filterHint: string;
  measure: (input: AssembledInput, re: RegExp | null) => SignalResult;
}

const WRITE_FAMILIES = new Set(['write', 'edit', 'edit1', 'multiedit']);
const READ_FAMILIES = new Set(['read', 'readfile', 'cat', 'grep', 'glob']);

function hitEvidence(tcs: ScoreToolCall[], cap = 5): SubItemResult['evidence'] {
  return tcs.slice(0, cap).map(tc => ev(tc.turnIndex, `${tc.toolName}${tc.argsJson ? `：${tc.argsJson.slice(0, 60)}` : ''}`));
}

/** 信号注册表：加信号 = 加一行（维度零改引擎同思路） */
export const SIGNALS: Record<string, SignalDef> = {
  command: {
    label: '命令执行（Bash 命令文本）',
    filterHint: '命令文本正则，如 npm test|vitest',
    measure: (input, re) => {
      const hits = input.toolCalls.filter(tc => {
        const cmd = commandOf(tc.argsJson);
        return cmd != null && (!re || re.test(cmd));
      });
      return { value: hits.length, evidence: hitEvidence(hits), hitLabel: `命令命中 ${hits.length} 次` };
    },
  },
  tool_calls: {
    label: '工具调用次数',
    filterHint: '工具名正则，如 todowrite；留空 = 全部',
    measure: (input, re) => {
      const hits = input.toolCalls.filter(tc => !re || re.test(tc.toolName));
      return { value: hits.length, evidence: hitEvidence(hits), hitLabel: `调用命中 ${hits.length} 次` };
    },
  },
  file_write: {
    label: '文件写入（按路径）',
    filterHint: '路径正则，如 ^(docs|README)',
    measure: (input, re) => {
      const hits = input.toolCalls.filter(tc => {
        if (!WRITE_FAMILIES.has(tc.toolName.toLowerCase())) return false;
        const p = extractFilePath(tc.argsJson);
        return p != null && (!re || re.test(p));
      });
      return { value: hits.length, evidence: hitEvidence(hits), hitLabel: `写入命中 ${hits.length} 处` };
    },
  },
  file_read: {
    label: '文件读取（按路径）',
    filterHint: '路径正则；留空 = 全部读取',
    measure: (input, re) => {
      const hits = input.toolCalls.filter(tc => {
        if (!READ_FAMILIES.has(tc.toolName.toLowerCase())) return false;
        const p = extractFilePath(tc.argsJson);
        return p != null && (!re || re.test(p));
      });
      return { value: hits.length, evidence: hitEvidence(hits), hitLabel: `读取命中 ${hits.length} 处` };
    },
  },
  keyword: {
    label: '关键词出现（轮次文本）',
    filterHint: '关键词或正则，在消息与工具结果里找',
    measure: (input, re) => {
      if (!re) return { value: null, evidence: [], hitLabel: '关键词未填' };
      const hits = input.turns.filter(t => {
        const text = t.content ?? t.contentSummary ?? '';
        return text.length > 0 && re.test(text);
      });
      return {
        value: hits.length,
        evidence: hits.slice(0, 5).map(t => ev(t.turnIndex, (t.content ?? t.contentSummary ?? '').slice(0, 60))),
        hitLabel: `含关键词的轮次 ${hits.length} 个`,
      };
    },
  },
  test_pass: {
    label: '验证通过数（最后一次白名单验证运行）',
    filterHint: '不适用过滤（自动识别验证命令）',
    measure: (input) => {
      const since = lastWriteSeq(input.toolCalls, tc => WRITE_FAMILIES.has(tc.toolName.toLowerCase()) && extractFilePath(tc.argsJson) != null);
      const last = findLastVerifiedRun(input.toolCalls, { sinceSeq: since });
      if (!last?.summary) return { value: null, evidence: [], hitLabel: '无白名单验证运行' };
      return { value: last.summary.passed, evidence: [ev(last.call.turnIndex, `验证命令（${last.summary.framework}）`)], hitLabel: `最后一次验证通过 ${last.summary.passed} 条` };
    },
  },
  test_fail: {
    label: '验证失败数（最后一次白名单验证运行）',
    filterHint: '不适用过滤（自动识别验证命令）',
    measure: (input) => {
      const since = lastWriteSeq(input.toolCalls, tc => WRITE_FAMILIES.has(tc.toolName.toLowerCase()) && extractFilePath(tc.argsJson) != null);
      const last = findLastVerifiedRun(input.toolCalls, { sinceSeq: since });
      if (!last?.summary) return { value: null, evidence: [], hitLabel: '无白名单验证运行' };
      return { value: last.summary.failed, evidence: [ev(last.call.turnIndex, `验证命令（${last.summary.framework}）`)], hitLabel: `最后一次验证失败 ${last.summary.failed} 条` };
    },
  },
  turns: {
    label: '轮次数（可按角色过滤）',
    filterHint: '角色正则，如 assistant；留空 = 全部',
    measure: (input, re) => {
      const hits = re ? input.turns.filter(t => re.test(t.role)) : input.turns;
      return { value: hits.length, evidence: [], hitLabel: `轮次 ${hits.length} 个` };
    },
  },
  tokens: {
    label: '总 token',
    filterHint: '不适用过滤',
    measure: (input) => ({ value: input.measures.totalTokens > 0 ? input.measures.totalTokens : null, evidence: [], hitLabel: `总 token ${input.measures.totalTokens.toLocaleString()}` }),
  },
  tool_time: {
    label: '工具执行耗时（ms）',
    filterHint: '不适用过滤',
    measure: (input) => ({ value: input.measures.toolTimeMs > 0 ? input.measures.toolTimeMs : null, evidence: [], hitLabel: `工具耗时 ${input.measures.toolTimeMs.toLocaleString()}ms` }),
  },
  interrupts: {
    label: '用户打断次数',
    filterHint: '不适用过滤',
    measure: (input) => ({
      value: input.interrupts.length,
      evidence: input.interrupts.slice(0, 5).map(i => ev(i.turnIndex, '打断')),
      hitLabel: `打断 ${input.interrupts.length} 次`,
    }),
  },
};

const COMPARE_TEXT: Record<RuleSpec['compare'], string> = {
  gte: '≥', lte: '≤', eq: '=', exists: '存在（≥1）', absent: '不存在（=0）',
};

export function compareVerdict(value: number, spec: RuleSpec): boolean {
  switch (spec.compare) {
    case 'exists': return value >= 1;
    case 'absent': return value === 0;
    case 'gte': return value >= (spec.threshold ?? 1);
    case 'lte': return value <= (spec.threshold ?? 0);
    case 'eq': return value === (spec.threshold ?? 0);
  }
}

export class UserRuleScorer extends Scorer {
  readonly id: string;
  readonly needs = ['toolCalls', 'turns', 'measures'] as const;

  constructor(private readonly def: ScoreItemSchema, private readonly rule: RuleSpec) {
    super();
    this.id = def.id;
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const signal = SIGNALS[this.rule.signal];
    if (!signal) return notApplicable(ctx.def, `未知信号「${this.rule.signal}」`);
    let re: RegExp | null = null;
    if (this.rule.filter) {
      try {
        re = new RegExp(this.rule.filter, 'i');
      } catch {
        return notApplicable(ctx.def, `过滤正则无法编译：${this.rule.filter}`);
      }
    }
    const { value, evidence, hitLabel } = signal.measure(ctx.input, re);
    if (value == null) {
      return notApplicable(ctx.def, `${signal.label}测不到（${hitLabel}），无法评判`);
    }
    const pass = compareVerdict(value, this.rule);
    const target = this.rule.compare === 'exists' || this.rule.compare === 'absent'
      ? COMPARE_TEXT[this.rule.compare]
      : `${COMPARE_TEXT[this.rule.compare]} ${this.rule.threshold}`;
    return okResult(ctx.def, {
      verdict: pass ? 'pass' : 'fail',
      value: `${hitLabel}（${this.rule.filter ? `过滤 ${this.rule.filter} · ` : ''}${target}）`,
      score: pass ? 1 : 0,
      formula: `${signal.label}：${this.rule.filter ? `过滤「${this.rule.filter}」· ` : ''}${hitLabel} → ${target} → ${pass ? '通过' : '未通过'}${evidence.length > 0 ? `；证据 ${evidence.map(e => e.turnIndex != null ? `§${e.turnIndex}` : '§').join(' ')}` : ''}`,
      evidence,
      note: this.def.note ?? undefined,
    });
  }
}

/** 规则校验（loader 与试算共用）：信号存在、比较合法、阈值齐、正则可编译且不过长 */
export function validateRuleSpec(rule: unknown): rule is RuleSpec {
  if (!rule || typeof rule !== 'object') return false;
  const r = rule as Partial<RuleSpec>;
  if (typeof r.signal !== 'string' || !(r.signal in SIGNALS)) return false;
  if (!['gte', 'lte', 'eq', 'exists', 'absent'].includes(r.compare ?? '')) return false;
  if ((r.compare === 'gte' || r.compare === 'lte' || r.compare === 'eq') && typeof r.threshold !== 'number') return false;
  if (r.filter != null) {
    if (typeof r.filter !== 'string' || r.filter.length > 200) return false;
    try { new RegExp(r.filter, 'i'); } catch { return false; }
  }
  return true;
}
