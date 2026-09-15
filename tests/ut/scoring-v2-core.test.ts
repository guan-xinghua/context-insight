// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分体系 v2 单元锁：聚合引擎五种策略 + 否决 + 覆盖度 + 新维度零改引擎回归、
// shell 拆分、测试输出解析、judge 输出约束、评分卡文件存储、基线位置分。
// 全部手算值。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { aggregateCard, aggregateDimension } from '../../src/lib/scoring/core/aggregator';
import type { DimensionDefinition, ScoreItemSchema } from '../../src/lib/scoring/core/schema';
import type { DimensionResult, SubItemResult } from '../../src/lib/scoring/core/types';
import { FileScorecardStore } from '../../src/lib/scoring/core/store';
import { SCORECARD_SCHEMA, type Scorecard } from '../../src/lib/scoring/core/types';
import { splitShell, hasFlag } from '../../src/lib/scoring/core/shell-parser';
import { parseTestOutput, isVerifyCommand } from '../../src/lib/scoring/core/test-parser';
import { clampToBandScore, parseJudgeJson, validEvidenceTurns, buildBandJudgeAsk, GENERIC_JUDGE_SYSTEM } from '../../src/lib/scoring/core/llm';
import { positionScore, gradeOf } from '../../src/lib/scoring/core/baseline/service';
import { buildChatUrl, stripJsonFence } from '../../src/lib/ai/analyzer';

function item(id: string, fields: Partial<SubItemResult> = {}): SubItemResult {
  return { itemId: id, label: id, status: 'ok', evidence: [], ...fields };
}

function dimDef(id: string, role: DimensionDefinition['role'], items: ScoreItemSchema[], aggregation: DimensionDefinition['aggregation'], weightInTotal?: number): DimensionDefinition {
  return { id, name: id, english: id, role, items, aggregation, weightInTotal };
}

const scoreItem = (id: string, extra: Partial<ScoreItemSchema> = {}): ScoreItemSchema => ({
  id, dimension: 'X', name: id, scorerKind: 'rule', ...extra,
});

describe('聚合引擎 · three-state（组合表是数据）', () => {
  const def = dimDef('T', 'veto', [scoreItem('a'), scoreItem('b')], {
    kind: 'three-state',
    rules: [
      { when: { a: 'bad' }, then: '未完成' },
      { when: { '*': 'violation' }, then: 'violation' },
      { when: { a: 'good', b: 'good' }, then: '完成' },
    ],
    fallback: '无法判定',
  });

  it('具名条件命中', () => {
    const r = aggregateDimension(def, [item('a', { verdict: 'bad' }), item('b', { verdict: 'good' })]);
    expect(r.verdict).toBe('未完成');
  });

  it('通配 *：任一子项 violation 即触发', () => {
    const r = aggregateDimension(def, [item('a', { verdict: 'good' }), item('b', { verdict: 'violation' })]);
    expect(r.verdict).toBe('violation');
  });

  it('多条件 AND：a、b 都 good 才完成', () => {
    expect(aggregateDimension(def, [item('a', { verdict: 'good' }), item('b', { verdict: 'good' })]).verdict).toBe('完成');
    expect(aggregateDimension(def, [item('a', { verdict: 'good' }), item('b', { verdict: 'other' })]).verdict).toBe('无法判定');
  });
});

describe('聚合引擎 · average-with-floor（正确性不及格总分不许及格）', () => {
  const def = dimDef('Q', 'weighted', [scoreItem('correctness'), scoreItem('style'), scoreItem('docs')], {
    kind: 'average-with-floor', floorItemId: 'correctness', floorThreshold: 0.2, floorMaxScore: 0.4,
  });
  const good = [item('correctness', { score: 0.9 }), item('style', { score: 0.9 }), item('docs', { score: 0.9 })];
  const bad = [item('correctness', { score: 0.2 }), item('style', { score: 0.9 }), item('docs', { score: 0.9 })];

  it('正常：平均 0.9', () => {
    expect(aggregateDimension(def, good).score).toBe(0.9);
  });
  it('正确性 2/10：min(0.9, 0.4) = 0.4——漂亮注释不能把错误代码平均成好代码', () => {
    expect(aggregateDimension(def, bad).score).toBe(0.4);
  });
  it('诊断项不进平均', () => {
    const defD = { ...def, items: [...def.items, scoreItem('waste', { diagnostic: true })] };
    const r = aggregateDimension(defD, [...bad, item('waste', { value: 99 })]);
    expect(r.score).toBe(0.4);
  });
});

describe('聚合引擎 · weighted-average / count-deduction / direct', () => {
  it('D4 80/20：0.8×1 + 0.2×0.5 = 0.9', () => {
    const def = dimDef('E', 'weighted', [scoreItem('tokens', { weight: 0.8 }), scoreItem('toolTime', { weight: 0.2 })], { kind: 'weighted-average' });
    expect(aggregateDimension(def, [item('tokens', { score: 1 }), item('toolTime', { score: 0.5 })]).score).toBe(0.9);
  });

  it('扣分制：1 − (2×0.15 + 1×0.08) = 0.62', () => {
    const def = dimDef('A', 'weighted', [scoreItem('interrupts'), scoreItem('similar')], {
      kind: 'count-deduction', perEvent: { interrupts: 0.15, similar: 0.08 },
    });
    expect(aggregateDimension(def, [item('interrupts', { value: 2 }), item('similar', { value: 1 })]).score).toBe(0.62);
  });

  it('扣到 0 为止', () => {
    const def = dimDef('A2', 'weighted', [scoreItem('interrupts')], { kind: 'count-deduction', perEvent: { interrupts: 0.15 } });
    expect(aggregateDimension(def, [item('interrupts', { value: 99 })]).score).toBe(0);
  });

  it('直接分：单子项分数即维度分', () => {
    const def = dimDef('C', 'optional', [scoreItem('x')], { kind: 'direct' });
    expect(aggregateDimension(def, [item('x', { score: 0.7 })]).score).toBe(0.7);
  });
});

describe('整卡聚合：否决 + 覆盖度 + 权重归一', () => {
  const defs: DimensionDefinition[] = [
    dimDef('D1', 'veto', [scoreItem('D1.stopReason'), scoreItem('D1.selfReport')], { kind: 'three-state', rules: [], fallback: '完成' }),
    dimDef('D3', 'weighted', [scoreItem('D3.testResults'), scoreItem('D3.nakedWrite'), scoreItem('D3.cannBench')], { kind: 'weighted-average' }, 0.35),
    dimDef('D4', 'weighted', [scoreItem('D4.1'), scoreItem('D4.2')], { kind: 'weighted-average' }, 0.15),
  ];

  const dims: DimensionResult[] = [
    { dimensionId: 'D1', name: 'D1', english: 'D1', role: 'veto', status: 'scored', verdict: '完成', items: [item('D1.stopReason', { verdict: 'x' }), item('D1.selfReport', { verdict: 'y' })] },
    { dimensionId: 'D3', name: 'D3', english: 'D3', role: 'weighted', status: 'scored', score: 1, items: [item('D3.testResults', { score: 1 }), item('D3.nakedWrite', { score: 1 }), item('D3.cannBench', { status: 'not-applicable' })] },
    { dimensionId: 'D4', name: 'D4', english: 'D4', role: 'weighted', status: 'scored', score: 0.5, items: [item('D4.1', { score: 1 }), item('D4.2', { score: 0 })] },
  ];

  it('无否决：总分 = (1×0.35 + 0.5×0.15)/0.5 × 覆盖度 6/7', () => {
    const f = aggregateCard(dims, defs);
    expect(f.veto).toBeNull();
    expect(f.coverage).toBe(0.86);
    expect(f.totalScore).toBe(Math.round(((1 * 0.35 + 0.5 * 0.15) / 0.5) * 0.86 * 100) / 100);
  });

  it('否决：D1 未完成 → 一票否决 totalScore 0 + 原因标注（维度分照常出）', () => {
    const vetoed: DimensionResult[] = dims.map(d => d.dimensionId === 'D1' ? { ...d, verdict: '未完成' } : d);
    const f = aggregateCard(vetoed, defs);
    expect(f.veto?.triggered).toBe(true);
    expect(f.veto?.reasons[0]).toContain('未完成');
    expect(f.totalScore).toBe(0);                     // 否决是 0 分，不是没分
    expect(vetoed.find(d => d.dimensionId === 'D3')!.score).toBeGreaterThan(0);   // 其他维度照常判断
  });

  it('回归：新增 D8 维度零改引擎（只加定义）', () => {
    const d8 = dimDef('D8', 'weighted', [scoreItem('D8.1')], { kind: 'weighted-average' }, 0.1);
    const f = aggregateCard([
      ...dims,
      { dimensionId: 'D8', name: 'D8', english: 'D8', role: 'weighted', status: 'scored', score: 0.8, items: [item('D8.1', { score: 0.8 })] },
    ], [...defs, d8]);
    expect(Object.keys(f.weightsUsed)).toEqual(['D3', 'D4', 'D8']);
    expect(f.totalScore).not.toBeNull();
  });
});

describe('shell 拆分（自研轻量）', () => {
  it('复合命令按 && ; | 断句，取首词与 flag', () => {
    const segs = splitShell('cd /repo && rm -rf ./* | grep foo; git status');
    expect(segs.map(s => s.command)).toEqual(['cd', 'rm', 'grep', 'git']);
    expect(hasFlag(segs[1], '-r')).toBe(true);
    expect(hasFlag(segs[1], '-f')).toBe(true);
  });

  it('引号内的分隔符不断开；echo "rm -rf" 不是执行 rm', () => {
    const segs = splitShell('echo "rm -rf /" && ls');
    expect(segs[0].command).toBe('echo');
    expect(segs.map(s => s.command)).not.toContain('rm');
  });

  it('命令替换 / 变量标 uncertain（调用方只提示不硬判）', () => {
    const segs = splitShell('rm -rf $(pwd)/build && rm -rf $HOME/tmp');
    expect(segs[0].uncertain).toBe(true);
    expect(segs[1].uncertain).toBe(true);
  });
});

describe('测试输出解析（D1.verifiedRun/D3.testResults 共用）', () => {
  it('vitest：1483 passed | 3 skipped', () => {
    expect(parseTestOutput('Test Files  145 passed\n\n Tests  1483 passed | 3 skipped'))
      .toMatchObject({ passed: 1483, failed: 0, skipped: 3, framework: 'vitest/jest' });
  });
  it('pytest：3 passed, 1 failed', () => {
    expect(parseTestOutput('=== 3 passed, 1 failed in 0.12s ==='))
      .toMatchObject({ passed: 3, failed: 1 });
  });
  it('ctest：97% tests passed, 3 failed out of 120', () => {
    expect(parseTestOutput('97% tests passed, 3 tests failed out of 120'))
      .toMatchObject({ passed: 117, failed: 3, framework: 'ctest' });
  });
  it('maven / cargo', () => {
    expect(parseTestOutput('Tests run: 10, Failures: 2, Errors: 1, Skipped: 0'))
      .toMatchObject({ passed: 7, failed: 3 });
    expect(parseTestOutput('test result: ok. 8 passed; 2 failed; 0 ignored'))
      .toMatchObject({ passed: 8, failed: 2 });
  });
  it('认不出返回 null（宁漏勿错）；grep/cat 不是验证命令', () => {
    expect(parseTestOutput('some random output')).toBeNull();
    expect(isVerifyCommand('grep "test" foo.txt')).toBe(false);
    expect(isVerifyCommand('cat report.txt')).toBe(false);
    expect(isVerifyCommand('npm run test')).toBe(true);
    expect(isVerifyCommand('npx vitest run tests/x.test.ts')).toBe(true);
  });
});

describe('judge 输出三层约束', () => {
  const bands = [
    { range: '0-2', label: '差', description: '' },
    { range: '9-10', label: '优', description: '' },
  ];
  it('档位外的分数拉回最近档（7.3 → 9-10 档中值）', () => {
    expect(clampToBandScore(7.3, bands)).toBe(10);
    expect(clampToBandScore(1, bands)).toBe(1);
  });
  it('解析失败返回 null（不猜不重试）', () => {
    expect(parseJudgeJson('不是 JSON')).toBeNull();
    expect(parseJudgeJson('```json\n{"score": 8}\n```')).toEqual({ score: 8 });
  });
  it('§N 证据校验：材料里不存在的轮次剔除', () => {
    expect(validEvidenceTurns(['§3', '§99', 'x'], [3, 5])).toEqual([3]);
  });
});

describe('LLM 通道传输层重试（超时 / 空正文）', () => {
  const provider = { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' };
  afterEach(() => vi.unstubAllGlobals());

  it('空正文加配额重试成功后正常记账（calls/tokens 只记成功那次）', async () => {
    const bodies: Array<{ max_tokens: number }> = [];
    const responses = [
      { choices: [{ message: { content: '' }, finish_reason: 'length' }] },
      { choices: [{ message: { content: '{"score":8}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => responses[bodies.length - 1] } as unknown as Response;
    }));
    const { TrackedLlmClient } = await import('../../src/lib/scoring/core/llm');
    const client = new TrackedLlmClient(provider);
    const r = await client.complete('sys', 'user');
    expect(r.content).toBe('{"score":8}');
    expect(bodies.map(b => b.max_tokens)).toEqual([4096, 8192]);
    expect(client.calls).toBe(1);
    expect(client.tokens).toBe(15);
  });

  it('首轮超时 → 重试一次；重试成功则正常返回（并行×3 下网关排队会偶发慢）', async () => {
    const bodies: Array<{ max_tokens: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"score":6}' } }] }) } as unknown as Response;
    }));
    const { TrackedLlmClient } = await import('../../src/lib/scoring/core/llm');
    const client = new TrackedLlmClient(provider);
    const r = await client.complete('sys', 'user');
    expect(r.content).toBe('{"score":6}');
    expect(bodies).toHaveLength(2);
  });

  it('两次超时 → 错误翻译成人话（不再是裸 DOMException 文案）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' });
    }));
    const { TrackedLlmClient } = await import('../../src/lib/scoring/core/llm');
    const client = new TrackedLlmClient(provider);
    await expect(client.complete('sys', 'user')).rejects.toThrow('LLM 调用超时（300s · model=m），重试一次仍超时');
  });

  it('空正文重试（推理吃满配额）首轮 4096 → 8192 成功后正常记账', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '', reasoning_content: '思考很久' }, finish_reason: 'length' }] }),
    }) as unknown as Response));
    const { TrackedLlmClient } = await import('../../src/lib/scoring/core/llm');
    const client = new TrackedLlmClient(provider);
    await expect(client.complete('sys', 'user')).rejects.toThrow(/finish_reason=length.*reasoning_content 非空/);
  });
});

describe('评分卡文件存储（不动 Prisma）', () => {
  it('put/get + 重算归档 + 基线语料过滤（否决卡不进）', async () => {
    const dir = await import('node:fs/promises').then(fs => fs.mkdtemp('scoring-store-'));
    const { join } = await import('node:path');
    const store = new FileScorecardStore(dir);
    const mk = (status: 'completed' | 'aborted', veto: boolean): Scorecard => ({
      schemaVersion: SCORECARD_SCHEMA,
      sessionId: 's1',
      taskType: 'general',
      computedAt: '2026-08-31T10:00:00.000Z',
      status,
      framework: { totalScore: 0.5, veto: veto ? { triggered: true, reasons: ['x'] } : null, coverage: 1, weightsUsed: {} },
      dimensions: [],
      judgeCost: null,
    });
    const card1 = mk('completed', false);

    await store.put(card1);
    expect((await store.get('s1'))?.computedAt).toBe('2026-08-31T10:00:00.000Z');

    // 重算：旧卡挪 archive
    await store.put({ ...card1, computedAt: '2026-08-31T11:00:00.000Z' });
    expect((await store.get('s1'))?.computedAt).toBe('2026-08-31T11:00:00.000Z');
    const archive = await store.listForBaseline();
    expect(archive.length).toBe(1);

    // 否决卡是处分不是成绩，不进基线语料
    const vetoCard = { ...card1, computedAt: '2026-08-31T12:00:00.000Z', framework: { ...card1.framework, veto: { triggered: true, reasons: ['r'] } } };
    await store.put(vetoCard);
    expect((await store.listForBaseline()).length).toBe(0);
    expect((await store.get('s1'))?.framework.veto?.triggered).toBe(true);

    // aborted 卡不写盘
    await store.put(mk('aborted', false));
    expect((await store.get('s1'))?.status).toBe('completed');

    // 非法 sessionId（路径穿越）拒绝
    await expect(store.get('../etc/passwd')).rejects.toThrow();
    void join;
    await import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true }));
  });
});

describe('基线位置分（方向感知）', () => {
  const base = { direction: 'lower-better' as const, p25: 100, p50: 200, p75: 300 };
  it('≤P25 记 1，P25~P75 线性，≥P75 记 0；越高越好反向', () => {
    expect(positionScore(100, base)).toBe(1);
    expect(positionScore(200, base)).toBe(0.5);
    expect(positionScore(300, base)).toBe(0);
    expect(positionScore(50, base)).toBe(1);
    const higher = { ...base, direction: 'higher-better' as const };
    expect(positionScore(300, higher)).toBe(1);
    expect(positionScore(100, higher)).toBe(0);
  });
  it('四态判定', () => {
    expect(gradeOf(90, base)).toBe('BETTER');
    expect(gradeOf(200, base)).toBe('COMPARABLE');
    expect(gradeOf(400, base)).toBe('WORSE');
  });
});

// ── parity 用例：与 Python 侧 smart-agent/tests/test_trajectory.py 同表，改动两侧同步 ──

describe('buildChatUrl 端点归一（parity）', () => {
  it('裸主机补 /v1；/v1 与 /api/v3 直接拼；已含 /chat/completions 原样；尾斜杠先剥', () => {
    expect(buildChatUrl('http://llm.test')).toBe('http://llm.test/v1/chat/completions');
    expect(buildChatUrl('http://llm.test/v1')).toBe('http://llm.test/v1/chat/completions');
    expect(buildChatUrl('http://llm.test/v1/')).toBe('http://llm.test/v1/chat/completions');
    expect(buildChatUrl('https://gw.apigateway-cn-beijing.volceapi.com/api/v3')).toBe('https://gw.apigateway-cn-beijing.volceapi.com/api/v3/chat/completions');
    expect(buildChatUrl('http://llm.test/api/v3/chat/completions')).toBe('http://llm.test/api/v3/chat/completions');
  });
  it('首尾空白先 trim', () => {
    expect(buildChatUrl(' https://open.bigmodel.cn/api/coding/paas/v4 ')).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
    expect(buildChatUrl('http://llm.test/v1\n')).toBe('http://llm.test/v1/chat/completions');
  });
});

describe('stripJsonFence（parity）', () => {
  it('全围栏 / 无围栏 / 半截围栏', () => {
    expect(stripJsonFence('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(stripJsonFence('```\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(stripJsonFence('{"a": 1}')).toBe('{"a": 1}');
    expect(stripJsonFence('```json\n{"a": 1}')).toBe('{"a": 1}');
    expect(stripJsonFence('  ```json\n{"a": 1}\n```  \n')).toBe('{"a": 1}');
  });
});

// ── 强制 CoT 契约（学 MLflow：JSON 字段序=生成序，推理字段必须在结论字段之前， ──
//    且 reason 强制「逐步核对：」开头——防模型先吐结论再补事后辩解）

describe('judge prompt 强制 CoT 契约', () => {
  const cotItem: ScoreItemSchema = {
    id: 'D3.correctness', dimension: 'D3', name: '正确性', scorerKind: 'llm',
    bands: [
      { range: '9-10', label: '优', description: '验证齐全无错' },
      { range: '0-2', label: '差', description: '错误未发现或残留' },
    ],
  };

  it('打分型 JSON 模板 reason 在 score 前，且要求「逐步核对：」开头', () => {
    const ask = buildBandJudgeAsk(cotItem, '产出是否正确');
    const tpl = ask.split('\n').find(l => l.startsWith('{"reason"'));
    expect(tpl).toBeDefined();
    expect(tpl!.indexOf('"reason"')).toBeLessThan(tpl!.indexOf('"score"'));
    expect(tpl).toContain('逐步核对：');
    expect(ask).toContain('reason 必须写在 score 之前');
  });

  it('清单/目标对账模板结论字段（status）排最后', async () => {
    const { ChecklistJudgeScorer } = await import('../../src/lib/scoring/core/judge');
    const captured: string[] = [];
    const llm = { model: 'stub', complete: async (_s: string, user: string) => { captured.push(user); return { content: '{"items":[]}', promptTokens: 1, completionTokens: 1 }; } };
    const scorer = new ChecklistJudgeScorer(
      { id: 'D2.redlines', dimension: 'D2', name: '红线', scorerKind: 'llm' },
      { declaration: () => '- 不许 rm -rf', declarationLabel: '红线声明', itemStatuses: ['met', 'unmet'], failStatuses: ['unmet'], failVerdict: 'violation', passVerdict: 'clean', fallbackVerdict: 'unidentifiable' },
    );
    await scorer.run({
      input: { trajectoryDigest: '', memoryDigest: '', userMessages: [], toolCalls: [], turns: [], measures: { totalTokens: 0, toolTimeMs: 0, llmTimeMs: 0, inputTokens: 0 }, taskType: 'general', workflowDecl: { raw: '- 不许 rm -rf', sections: [] }, finishReason: 'normal', interrupts: [], wire: null, redactionEvents: [], executions: [] } as never,
      def: { id: 'D2.redlines', dimension: 'D2', name: '红线', scorerKind: 'llm' }, llm,
    });
    const tpl = captured[0].split('\n').find(l => l.startsWith('{"items"'));
    expect(tpl).toBeDefined();
    expect(tpl!.lastIndexOf('"status"')).toBeGreaterThan(tpl!.lastIndexOf('"note"'));
  });

  it('GENERIC_JUDGE_SYSTEM 声明先推理后结论', () => {
    expect(GENERIC_JUDGE_SYSTEM).toContain('先写推理字段再写结论字段');
  });

  it('解析与字段序无关：旧序（score 在前）输出照样解析', () => {
    const oldOrder = parseJudgeJson('{"score": 8, "reason": "ok", "evidence": ["§1"]}');
    expect(oldOrder?.['score']).toBe(8);
    const newOrder = parseJudgeJson('{"reason": "逐步核对：ok", "score": 8, "evidence": ["§1"]}');
    expect(newOrder?.['score']).toBe(8);
  });
});
