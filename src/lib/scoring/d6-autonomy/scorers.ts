// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D6 评分器：代码直算层（打断/关键词疑似/相似重发）+ LLM 九分类。
// 三条防误判纪律（Phoenix 验证过）写进分类 prompt；证据两可时判不扣。

import { Scorer, okResult, ev, type ScorerContext } from '../core/scorer';
import type { SubItemResult } from '../core/types';
import { MessageClassificationScorer } from '../core/judge';

class InterruptsScorer extends Scorer {
  readonly id = 'D6.interrupts';
  readonly needs = ['interrupts'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const n = ctx.input.interrupts.length;
    return okResult(ctx.def, {
      value: n,
      unit: 'times',
      formula: `打断标记 ${n} 次（中断信号轮：${ctx.input.interrupts.map(i => `§${i.turnIndex}`).join('、') || '无'}）`,
      evidence: ctx.input.interrupts.slice(0, 8).map(i => ev(i.turnIndex, '用户中途取消')),
      note: n > 0 ? '打断的是 agent 自作主张还是用户改主意，由 LLM 分类层细分' : undefined,
    });
  }
}

const CORRECTION_RE = /(不对|错了|不是这个|搞错了|回滚|撤销|撤回|重来|别这样|停下来|停停|越改越|怎么又|wrong|revert|undo|roll?back|no,|not this)/i;

class CorrectionKeywordsScorer extends Scorer {
  readonly id = 'D6.correctionKeywords';
  readonly needs = ['userMessages'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const hits = ctx.input.userMessages.filter(m => CORRECTION_RE.test(m.text));
    return okResult(ctx.def, {
      value: hits.length,
      unit: 'times',
      formula: `纠正关键词命中 ${hits.length} 条（只作疑似——中文"不对/回滚/撤销"等；是否真纠错由 LLM 分类层判定）`,
      evidence: hits.slice(0, 8).map(m => ev(m.turnIndex, m.text.slice(0, 60))),
      note: hits.length > 0 ? '疑似信号不直接扣分' : undefined,
    });
  }
}

const normalizeMsg = (t: string) => t.toLowerCase().replace(/[\s，。！？,.!?！？"'「」]/g, '').slice(0, 60);

class SimilarMessagesScorer extends Scorer {
  readonly id = 'D6.similarMessages';
  readonly needs = ['userMessages'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const groups = new Map<string, number[]>();
    ctx.input.userMessages.forEach(m => {
      const key = normalizeMsg(m.text);
      if (key.length < 6) return;
      const arr = groups.get(key) ?? [];
      arr.push(m.turnIndex);
      groups.set(key, arr);
    });
    const repeats: Array<{ turnIndexes: number[] }> = [];
    for (const [, idx] of groups) {
      if (idx.length >= 2) repeats.push({ turnIndexes: idx });
    }
    const count = repeats.reduce((s, r) => s + r.turnIndexes.length - 1, 0);
    return okResult(ctx.def, {
      value: count,
      unit: 'times',
      formula: `逐字相同的重发 ${repeats.length} 组 / 多发 ${count} 次（同一诉求没得到响应的信号）`,
      evidence: repeats.slice(0, 5).flatMap(r => r.turnIndexes.map(t => ev(t, '相似消息重发'))).slice(0, 8),
    });
  }
}

// LLM 九分类（设计 §7.2 表 + 两条判定标准 + 三条防误判纪律）
export function classificationScorer(): Scorer {
  return new MessageClassificationScorer(
    { id: 'D6.classification', dimension: 'D6', name: '用户消息九分类', scorerKind: 'llm' },
    {
      categories: [
        { key: 'correction', label: '纠正', deduct: 'major' },
        { key: 'interrupt-agent', label: '打断自作主张（含叫停时明显抱怨）', deduct: 'major' },
        { key: 'shirk-decision', label: '推卸决策（任务已授权它定，却让用户选）', deduct: 'major' },
        { key: 'question-unjustified', label: '不该问的问（答案已给过/上下文或项目文件里现成有）', deduct: 'minor' },
        { key: 'clarify-justified', label: '需求真有歧义的澄清', deduct: 'none' },
        { key: 'interrupt-user', label: '用户叫停自己要求的活（改主意，不扣）', deduct: 'none' },
        { key: 'decision-out-of-scope', label: '越界决策问用户（业务方向/影响外部/不可逆）', deduct: 'none' },
        { key: 'confirm-before-risk', label: '高危操作前主动求确认', deduct: 'none' },
        { key: 'supplement', label: '补充信息 / 新需求 / 致谢寒暄 / 首条消息', deduct: 'none' },
      ],
      discipline: [
        '只看明说的不满——用户沉默、话短、带负面词，都不能推断成不满',
        '先过一遍"不扣"清单，再判是不是纠正',
        '证据两可时判不扣——宁可漏判，不可冤枉',
        '决策看在不在任务的授权范围内：任务里已包含的决定（怎么实现、用什么写法）该自己拿主意；任务没覆盖的决定（业务方向、影响外部、不可逆操作）问是对的',
        '提问看答案在不在 agent 够得着的地方：用户说过、上下文里有、项目文件里查得到，还问就是不该问',
      ],
    },
  );
}

export function d6Scorers(): Scorer[] {
  return [
    new InterruptsScorer(),
    new CorrectionKeywordsScorer(),
    new SimilarMessagesScorer(),
    classificationScorer(),
  ];
}
