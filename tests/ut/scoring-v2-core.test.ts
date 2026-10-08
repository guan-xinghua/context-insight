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
import { aggregateCard, aggregateDimension, deriveItemScores } from '../../src/lib/scoring/core/aggregator';
import type { DimensionDefinition, ScoreItemSchema } from '../../src/lib/scoring/core/schema';
import type { DimensionResult, SubItemResult } from '../../src/lib/scoring/core/types';
import { FileScorecardStore } from '../../src/lib/scoring/core/store';
import { SCORECARD_SCHEMA, type Scorecard } from '../../src/lib/scoring/core/types';
import { splitShell, hasFlag } from '../../src/lib/scoring/core/shell-parser';
import { parseTestOutput, isVerifyCommand } from '../../src/lib/scoring/core/test-parser';
import { buildDigest } from '../../src/lib/scoring/core/assembler/digest';
import type { ScoreToolCall } from '../../src/lib/scoring/core/assembler/types';
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

  it('无否决：材料缺失 na（缺少测试运行）不进覆盖度分母 → 覆盖度 1，总分不打折', () => {
    const f = aggregateCard(dims, defs);
    expect(f.veto).toBeNull();
    expect(f.coverage).toBe(1);
    expect(f.totalScore).toBe(Math.round(((1 * 0.35 + 0.5 * 0.15) / 0.5) * 100) / 100);
  });

  it('评审缺口 na（未开启 LLM 评审 / Mate 未给出）拉低覆盖度：6/7 = 0.86', () => {
    const gapped = dims.map(d => d.dimensionId === 'D3'
      ? { ...d, items: d.items.map(i => i.itemId === 'D3.cannBench' ? item('D3.cannBench', { status: 'not-applicable', note: '未开启 LLM 评审，无法评判' }) : i) }
      : d);
    const f = aggregateCard(gapped, defs);
    expect(f.coverage).toBe(0.86);
    expect(f.totalScore).toBe(Math.round(((1 * 0.35 + 0.5 * 0.15) / 0.5) * 0.86 * 100) / 100);
  });

  it('na 归因：显式 naKind 优先于 note 文案', () => {
    const explicit = dims.map(d => d.dimensionId === 'D3'
      ? { ...d, items: d.items.map(i => i.itemId === 'D3.cannBench' ? item('D3.cannBench', { status: 'not-applicable', note: '缺少改代码后的测试运行，无法评判', naKind: 'gap' }) : i) }
      : d);
    expect(aggregateCard(explicit, defs).coverage).toBe(0.86);   // naKind:'gap' 即使 note 是材料缺失
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

describe('digest 用户交互小节（提问工具答复可见性）', () => {
  const tc = (over: Partial<ScoreToolCall>): ScoreToolCall => ({ id: 't', toolName: 'bash', argsJson: null, resultJson: null, state: 'completed', errorType: null, durationMs: 0, turnIndex: 1, isSubagent: false, agentName: null, seq: 1, ...over });
  const qArgs = JSON.stringify({ questions: [{ question: '本次设计流水线的 autonomy_level（门控档位）？', header: '门控档位', options: [{ label: '3 全自动 (Recommended)' }, { label: '0 全人工' }] }] });
  const qResult = 'User has answered your questions: "本次设计流水线的 autonomy_level（门控档位）？等级越高，reviewer 通过后越少打断你。"="3 全自动 (Recommended)". You can now continue with the user\'s answers in mind.';

  it('question 调用 → 小节列出问题/选项/用户选择——答复正文里选择排在长引文之后，Turn 列表 200 字截断会把它切掉（现场 §f5fe259d D2.authorization 误判）', () => {
    const d = buildDigest([], [tc({ toolName: 'question', turnIndex: 5, argsJson: qArgs, resultJson: qResult })], []);
    expect(d.trajectoryDigest).toContain('## 用户交互');
    expect(d.trajectoryDigest).toContain('autonomy_level');
    expect(d.trajectoryDigest).toContain('3 全自动 (Recommended)');
  });
  it('超长问题/答复不再整对失配（回归：{1,600} 上限让 D2 授权证据变「(无答复)」静默丢失）', () => {
    const longQ = '本次变更涉及生产环境，是否授权执行？'.padEnd(800, '详');
    const longA = '授权，按以下口径执行：'.padEnd(700, '细');
    const result = `User has answered your questions: "${longQ}"="${longA}". You can now continue.`;
    const d = buildDigest([], [tc({ toolName: 'question', turnIndex: 7, argsJson: qArgs, resultJson: result })], []);
    expect(d.trajectoryDigest).toContain('授权，按以下口径执行');
    expect(d.trajectoryDigest).not.toContain('(无答复)');
  });
  it('普通工具不产生该小节；子代理的提问不算主链用户交互', () => {
    expect(buildDigest([], [tc({ argsJson: '{}', resultJson: 'ok' })], []).trajectoryDigest).not.toContain('## 用户交互');
    expect(buildDigest([], [tc({ toolName: 'question', isSubagent: true, argsJson: qArgs, resultJson: qResult })], []).trajectoryDigest).not.toContain('## 用户交互');
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
  it('设计流水线门控：闸门通过 X/Y / 计入验收 X/Y / [PASS][FAIL]', () => {
    expect(parseTestOutput('=== base kernel branches === 闸门通过 6/6；计入验收 6/6 ==='))
      .toMatchObject({ passed: 6, failed: 0, framework: 'gate' });
    expect(parseTestOutput('闸门通过 4/6；计入验收 4/6'))
      .toMatchObject({ passed: 4, failed: 2, framework: 'gate' });
    expect(parseTestOutput('[PASS] ORDER  [PASS] BODY  [FAIL] HEADER'))
      .toMatchObject({ passed: 2, failed: 1, framework: 'gate' });
  });
  it('布尔门控（validate_spec.py 形态）：overall: PASS/FAIL 无计数行也能判（现场 §2358 误判不可解析）', () => {
    expect(parseTestOutput('=== 最终校验 ===\n        msg : kind=\'equals\' 暂不支持机器复核，条目 \'…\' 跳过\n\n=== overall: PASS ===\n=== 退出码 ===\nexit=0'))
      .toMatchObject({ passed: 1, failed: 0, framework: 'gate' });
    expect(parseTestOutput('=== overall: FAIL ===')).toMatchObject({ passed: 0, failed: 1, framework: 'gate' });
    expect(isVerifyCommand('python3 .opencode/skills/ops-spec-gen/scripts/validate_spec.py output/x/spec.yaml')).toBe(true);
  });
  it('deriveItemScores 盖章维内占比：加权维计分子项有 weightInDim，组合/按次扣分维与诊断项没有', async () => {
    const { BUILTIN_DIMENSIONS } = await import('../../src/lib/scoring/definitions');
    const item = (over: Partial<SubItemResult>): SubItemResult => ({ itemId: 'x', label: 'x', status: 'ok', evidence: [], ...over } as SubItemResult);
    const card = {
      dimensions: [
        { dimensionId: 'D4', name: 'D4', english: 'D4', role: 'weighted', status: 'scored', score: 0.5,
          items: [item({ itemId: 'D4.tokens', score: 0.8 }), item({ itemId: 'D4.waste', value: '诊断' })] },
        { dimensionId: 'D1', name: 'D1', english: 'D1', role: 'veto', status: 'scored', score: 0.5,
          items: [item({ itemId: 'D1.selfReport', verdict: 'incomplete', score: 0.5 })] },
      ],
    } as unknown as import('../../src/lib/scoring/core/types').Scorecard;
    const out = deriveItemScores(card, BUILTIN_DIMENSIONS);
    const d4 = out.dimensions[0].items;
    expect(d4.find(i => i.itemId === 'D4.tokens')!.weightInDim).toBe(0.25);
    expect(d4.find(i => i.itemId === 'D4.waste')!.weightInDim).toBeUndefined();   // 诊断项
    expect(out.dimensions[1].items[0].weightInDim).toBeUndefined();               // 三态组合维没有逐项权重
  });
  it('deriveItemScores 盖章未覆盖清单：评审缺口 na 与 error 列入，材料缺失 na 与诊断项不列（现场 §f4c5b028 97% 看不到哪项）', async () => {
    const { BUILTIN_DIMENSIONS } = await import('../../src/lib/scoring/definitions');
    const item = (over: Partial<SubItemResult>): SubItemResult => ({ itemId: 'x', label: 'x', status: 'ok', evidence: [], ...over } as SubItemResult);
    const mkCard = (flip: (id: string) => Partial<SubItemResult> | null) => ({
      dimensions: BUILTIN_DIMENSIONS.map(def => ({
        dimensionId: def.id, name: def.name, english: def.english, role: def.role, status: 'scored',
        items: def.items.map(i => item({ itemId: i.id, label: i.name, verdict: 'met', ...(flip(i.id) ?? {}) })),
      })),
    }) as unknown as import('../../src/lib/scoring/core/types').Scorecard;
    // 满覆盖 → 空清单
    expect(deriveItemScores(mkCard(() => null), BUILTIN_DIMENSIONS).framework.coverageGap).toEqual([]);
    // goalCoverage=Mate 未给出（缺口）+ D3.testResults=缺少测试运行（材料缺失）+ 诊断项 D4.waste 出错 → 只列前者
    const gap = deriveItemScores(
      mkCard(id => id === 'D1.goalCoverage'
        ? { status: 'not-applicable', verdict: undefined, note: 'Mate 评审未给出该子项：…' }
        : id === 'D3.testResults'
          ? { status: 'not-applicable', verdict: undefined, note: '缺少改代码后的测试运行，无法评判' }
          : id === 'D4.waste'
            ? { status: 'error', verdict: undefined }
            : null),
      BUILTIN_DIMENSIONS,
    ).framework.coverageGap!;
    expect(gap).toHaveLength(1);
    expect(gap[0]).toContain('D1.goalCoverage');
    expect(gap[0]).toContain('目标覆盖对账');
  });
  it('check_*.py / gate_lib 是验证命令（D1.verifiedRun/D3.testResults 白名单）', () => {
    expect(isVerifyCommand('python3 docs/design/check_kernel_branches.py')).toBe(true);
    expect(isVerifyCommand('python3 check_merge.py')).toBe(true);
    expect(isVerifyCommand('GATE_LIB_DIR=lib python3 check_ir_substance.py')).toBe(true);
    expect(isVerifyCommand('python3 gather_refs.py')).toBe(false);
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
  it('整数分不塌缩（7/8/9 各自保留，不再统一拉到档位中点 8）', () => {
    const five = ['0-2', '3-4', '5-6', '7-8', '9-10'].map(range => ({ range, label: '', description: '' }));
    expect(clampToBandScore(7, five)).toBe(7);
    expect(clampToBandScore(8, five)).toBe(8);
    expect(clampToBandScore(9, five)).toBe(9);
    expect(clampToBandScore(10, five)).toBe(10);
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

  it('空正文加配额重试成功后正常记账（calls/tokens 按每次真实消耗累计——重试的响应也花钱）', async () => {
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
    expect(bodies.map(b => b.max_tokens)).toEqual([4096, 16384]);
    expect(client.calls).toBe(2);
    expect(client.tokens).toBe(15);   // 首响应无 usage 记 0 token，但 call 计数不丢
  });

  it('截断正文（finish_reason=length 但有内容）→ 用更大配额重试一次', async () => {
    const bodies: Array<{ max_tokens: number }> = [];
    const responses = [
      { choices: [{ message: { content: '{"reason": "逐步核对：……（被截断' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 4096 } },
      { choices: [{ message: { content: '{"reason":"逐步核对：完整","score":8}' } }], usage: { prompt_tokens: 10, completion_tokens: 50 } },
    ];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => responses[bodies.length - 1] } as unknown as Response;
    }));
    const { TrackedLlmClient } = await import('../../src/lib/scoring/core/llm');
    const client = new TrackedLlmClient(provider);
    const r = await client.complete('sys', 'user');
    expect(r.content).toContain('"score":8');
    expect(bodies.map(b => b.max_tokens)).toEqual([4096, 16384]);
    expect(client.calls).toBe(2);
    expect(client.tokens).toBe(4166);   // 截断重试的 10+4096 也计（曾系统性少记）
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

  it('空正文逐挡加配额（推理吃满配额）4k→16k→32k 全空后如实报错', async () => {
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

  it('GENERIC_JUDGE_SYSTEM 声明先推理后结论 + 输出写给人看（去 AI 腔、不自造词语）', () => {
    expect(GENERIC_JUDGE_SYSTEM).toContain('先写推理字段再写结论字段');
    expect(GENERIC_JUDGE_SYSTEM).toContain('写给人看');
    expect(GENERIC_JUDGE_SYSTEM).toContain('不自造词语');
  });

  it('解析与字段序无关：旧序（score 在前）输出照样解析', () => {
    const oldOrder = parseJudgeJson('{"score": 8, "reason": "ok", "evidence": ["§1"]}');
    expect(oldOrder?.['score']).toBe(8);
    const newOrder = parseJudgeJson('{"reason": "逐步核对：ok", "score": 8, "evidence": ["§1"]}');
    expect(newOrder?.['score']).toBe(8);
  });
});

describe('classifyTask · 任务文本兜底（opencode 原生无 system 的算子设计会话）', () => {
  it('首条用户消息含「算子/operator/kernel」→ operator（文档为主的流水线会话路径启发匹配不上）', async () => {
    const { classifyTask } = await import('../../src/lib/scoring/core/assembler/task-classifier');
    expect(classifyTask(null, [], '开发 bn3d_training_update_grad 算子的设计文档，Ascend C，支持 Ascend 950，全自动执行不要确认。')).toBe('operator');
    expect(classifyTask(null, [], 'Fusion design for confusion_mul_grad operator, run the design pipeline from P1.')).toBe('operator');
    expect(classifyTask(null, [], '/ops-registry-invoke-fusion-design /home/u/fused-op-dev/confusion_mul_grad/confusion_mul_grad/spec.yaml auto')).toBe('operator');
    // 普通任务文本不误判：无标签 + 无算子路径 → general/unknown 走原启发
    expect(classifyTask(null, [{ toolName: 'Write', argsJson: '{"file_path":"/docs/note.md","content":"x"}', id: 'a', resultJson: null, state: 'ok', errorType: null, durationMs: 0, turnIndex: 0, isSubagent: false, agentName: null, seq: 0 } as never], '帮我整理一下项目 README')).toBe('general');
  });
});

describe('cannbay 上报快照 · 溯源字段', () => {
  it('appendScorecard → parseRecords 往返：算式/模板/评审工具/耗时/覆盖度不丢', async () => {
    const { parseRecords } = await import('../../src/lib/lake/notes');
    const line = JSON.stringify({
      ts: '2026-09-30T02:27:00.000Z', type: 'scorecard',
      totalScore: 0.43,
      dimensions: [{ dimensionId: 'D2', name: '行为可信', score: 1 }],
      computedAt: '2026-09-30T02:27:00.000Z',
      formula: 'D2 15%×100 + D3 35%×93 → 63 × 覆盖度 68% = 43',
      profile: '默认',
      reviewer: '确定性层评审完成 · LLM 评审未执行',
      completedAt: '2026-09-30T02:27:00.000Z',
      durationMs: 425000,
      coverage: 0.68,
    });
    const recs = parseRecords(line);
    expect(recs).toHaveLength(1);
    const r = recs[0] as import('../../src/lib/lake/notes').ScorecardEntry;
    expect(r.formula).toContain('覆盖度 68% = 43');
    expect(r.reviewer).toContain('LLM 评审未执行');
    expect(r.durationMs).toBe(425000);
    expect(r.coverage).toBe(0.68);
    expect(r.profile).toBe('默认');
  });
  it('旧格式快照（无新字段）解析不炸、字段缺省', async () => {
    const { parseRecords } = await import('../../src/lib/lake/notes');
    const recs = parseRecords(JSON.stringify({ ts: 'x', type: 'scorecard', totalScore: 0.5, dimensions: [], computedAt: 'y' }));
    expect(recs).toHaveLength(1);
    const r = recs[0] as import('../../src/lib/lake/notes').ScorecardEntry;
    expect(r.formula).toBeUndefined();
    expect(r.coverage).toBeUndefined();
  });
});
