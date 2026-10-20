// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分卡规则层独立出口（ruleScoresOf）：Run 观测台融合的取分口径——只跑
// D4/D5 的规则子项（不读 wire 文件、不走基线、不请 LLM），维度分 = 规则子集
// 加权归一（na/error 剔除）。fixture 直接构造 ScoreTurn/ScoreToolCall，锁定
// 五个子项的触发条件与豁免规则（环境类错误不罚）。

import { describe, it, expect } from 'vitest';
import { ruleScoresOf } from '@/lib/scoring/rules';
import type { ScoreToolCall, ScoreTurn } from '@/lib/scoring/core/assembler/types';

const turn = (i: number, over: Partial<ScoreTurn> = {}): ScoreTurn => ({
  id: `t${i}`, turnIndex: i, role: 'assistant', agentName: null, isSubagent: false,
  subagentSessionId: null, contentSummary: null, content: null, totalTokens: 100,
  inputTokens: 100, inputMessagesTokens: 100, latencyMs: 10,
  createdAtISO: null, createdAtTsISO: null, model: null, ...over,
});

const call = (i: number, over: Partial<ScoreToolCall> = {}): ScoreToolCall => ({
  id: `c${i}`, toolName: 'Bash', argsJson: `{"cmd":"echo ${i}"}`, resultJson: null,
  state: 'ok', errorType: null, errorMessage: null, durationMs: 100,
  startedAtMs: null, completedAtMs: null, turnIndex: i, isSubagent: false,
  agentName: null, seq: i, ...over,
});

const itemOf = (r: Awaited<ReturnType<typeof ruleScoresOf>>, id: string) =>
  r.items.find(i => i.itemId === id)!;

describe('ruleScoresOf：评分卡规则层（Run 融合取分口径）', () => {
  it('干净会话：五个规则子项全可评/满分（无派发 → redispatch 不适用并从冗余分中剔除）', async () => {
    const r = await ruleScoresOf([turn(0), turn(1)], [0, 1, 2, 3].map(i => call(i)));
    expect(r.items.map(i => i.itemId).sort()).toEqual([
      'D4.compaction', 'D4.parallel', 'D5.redispatch', 'D5.repeat', 'D5.toolErrors',
    ]);
    expect(itemOf(r, 'D5.redispatch').status).toBe('not-applicable');
    expect(itemOf(r, 'D5.repeat').score).toBe(1);
    expect(itemOf(r, 'D5.toolErrors').score).toBe(1);
    expect(r.d5).toBe(1);
    expect(itemOf(r, 'D4.compaction').score).toBe(1);
    expect(itemOf(r, 'D4.parallel').status).toBe('not-applicable');
    expect(r.d4).toBe(1);
  });

  it('原样重复：同参数连发 ≥3 记段长−1，×10 线性扣', async () => {
    const same = { toolName: 'Bash', argsJson: '{"cmd":"git status"}' };
    const calls = [
      call(0, same), call(1, same), call(2, same),
      call(3), call(4), call(5),
    ];
    const r = await ruleScoresOf([turn(0), turn(1)], calls);
    const repeat = itemOf(r, 'D5.repeat');
    expect(repeat.score).toBe(0); // 2 次重复 ÷ 6 调用 ×10 → 0
    expect(repeat.formula).toContain('原样连发 2 次');
    expect(repeat.evidence.some(e => e.label.includes('原样连发 ×3'))).toBe(true);
    expect(r.d5).toBeCloseTo(0.4); // (repeat 0×0.15 + toolErrors 1×0.10) / 0.25
  });

  it('环境类连发豁免：三连同发的每次都是网络超时 → 不罚（不是 agent 的错）', async () => {
    const same = { toolName: 'Bash', argsJson: '{"cmd":"curl api"}', state: 'error', errorMessage: 'ETIMEDOUT network timeout' };
    const calls = [call(0, same), call(1, same), call(2, same), call(3), call(4), call(5)];
    const r = await ruleScoresOf([turn(0)], calls);
    expect(itemOf(r, 'D5.repeat').score).toBe(1);
    expect(itemOf(r, 'D5.repeat').formula).toContain('环境类重试豁免 2 次不计');
    expect(itemOf(r, 'D5.toolErrors').score).toBe(1);
    expect(r.d5).toBe(1);
  });

  it('工具白干错误：可避免错误线性扣、环境类豁免；原样连发段内只计首错', async () => {
    const calls = Array.from({ length: 9 }, (_, i) => call(i));
    calls.push(call(9, { state: 'error', errorMessage: 'No such file or directory: /a/b' }));
    calls.push(call(10, { state: 'error', errorMessage: 'ECONNREFUSED connection refused' }));
    const r = await ruleScoresOf([turn(0)], calls);
    const errors = itemOf(r, 'D5.toolErrors');
    expect(errors.score).toBe(0.09); // 可避免 1/11 ≈ 9% ×10 线性扣 → 0.09（白干频率是稀有事件放大档）
    expect(errors.formula).toContain('可避免错误 1 / 总调用 11');
    expect(errors.formula).toContain('环境类豁免 1');
    expect(errors.evidence[0]?.label).toContain('No such file or directory');
  });

  it('subagent 重派：同任务标识（Task12）两次派发记 1 次重派，50 当量 ×10 线性扣', async () => {
    const dispatch = (i: number, over: Partial<ScoreToolCall> = {}) => call(i, {
      toolName: 'Task',
      argsJson: JSON.stringify({ subagent_type: 'reviewer', description: '复审模块 Task12 的实现' }),
      ...over,
    });
    const calls = [dispatch(0), ...Array.from({ length: 10 }, (_, i) => call(i + 1)), dispatch(11)];
    const r = await ruleScoresOf([turn(0), turn(1)], calls);
    const redispatch = itemOf(r, 'D5.redispatch');
    expect(redispatch.score).toBe(0); // 1×50 ÷ 12 ×10 → 0
    expect(redispatch.formula).toContain('重派 1 次 ×50 当量 ÷ 总调用 12');
    expect(redispatch.evidence[0]?.label).toContain('reviewer ×2');
    expect(r.d5).toBeCloseTo(0.31); // (redispatch 0×0.55 + repeat 1×0.15 + toolErrors 1×0.10) / 0.80
  });

  it('压缩事件：compaction-boundary 轮记 1 次压缩 → 效率规则分线性扣', async () => {
    const turns = [turn(0), turn(1, { agentName: 'compaction-boundary' }), turn(2)];
    const r = await ruleScoresOf(turns, [call(0), call(1)]);
    expect(itemOf(r, 'D4.compaction').score).toBe(0.8); // 1 次 ×0.2
    expect(itemOf(r, 'D4.compaction').formula).toContain('压缩 1 次');
    expect(r.d4).toBe(0.8); // parallel 无时间戳 na → 子集归一只剩 compaction
  });

  it('空会话（无 turns/toolCalls）：D5 子项全部不适用（冗余分 null）；压缩「未触发」仍算 ok', async () => {
    const r = await ruleScoresOf([], []);
    expect(r.d4).toBe(1); // compaction：0 轮 → 未触发压缩 = ok 1（评分器语义）
    expect(r.d5).toBeNull();
    expect(r.items.filter(i => i.itemId.startsWith('D5')).every(i => i.status === 'not-applicable')).toBe(true);
  });
});
