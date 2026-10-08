// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// v2 渲染冒烟：通用维度卡渲染六维 + 否决标注 + D7 自定义维度自动有呈现
//（呈现层不认识具体维度）；loading↔ok 收敛不循环（fetch 恰好一次）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { createElement } from 'react';
import { TrajectoryScoring, totalFormulaOf, MateProgressText } from '@/components/scoring/TrajectoryScoring';
import type { Scorecard } from '@/lib/scoring';
import { SCORECARD_SCHEMA } from '@/lib/scoring';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TASKID = 'render-v2-t1';

function mkCard(): Scorecard {
  return {
    schemaVersion: SCORECARD_SCHEMA,
    sessionId: 's-render',
    taskType: 'general',
    computedAt: '2026-08-31T10:00:00.000Z',
    status: 'completed',
    framework: {
      totalScore: 0,
      veto: { triggered: true, reasons: ['完成度（未完成） · Todo 有未勾项'] },
      coverage: 0.72,
      weightsUsed: { D3: 0.47, D4: 0.2, D5: 0.33 },
    },
    dimensions: [
      {
        dimensionId: 'D1', name: '完成度', english: 'Completion', role: 'veto',
        status: 'scored', verdict: '未完成', disclose: 'Todo 有未勾项且之后再无动作',
        items: [{ itemId: 'D1.selfReport', label: '自报完成态', status: 'ok', verdict: 'incomplete', value: '1/2', effScore: 0.5, evidence: [{ turnIndex: 3, label: '未勾：deploy gamma service' }] }],
      },
      {
        dimensionId: 'D2', name: '行为可信', english: 'Trust', role: 'veto',
        status: 'scored', verdict: 'clean',
        items: [{ itemId: 'D2.destructive', label: '破坏性操作', status: 'ok', verdict: 'clean', value: '0 确凿 / 0 疑似', effScore: 1, evidence: [] }],
      },
      {
        dimensionId: 'D3', name: '完成质量', english: 'Quality', role: 'weighted',
        status: 'scored', score: 0.82,
        items: [
          { itemId: 'D3.testResults', label: '测试结果', status: 'ok', value: '6✓/0✗', score: 1, formula: '通过率 1', evidence: [] },
          { itemId: 'D3.correctness', label: '正确性', status: 'not-applicable', note: '语义评审未开启', evidence: [] },
        ],
      },
      {
        dimensionId: 'D4', name: '完成效率', english: 'Efficiency', role: 'weighted',
        status: 'scored', score: 0.55,
        items: [{ itemId: 'D4.tokens', label: 'token 排名', status: 'ok', value: 120000, unit: 'tokens', baselineScore: 0.8, score: 0.8, effScore: 0.8, weightInDim: 0.25, evidence: [] }],
      },
      {
        dimensionId: 'D5', name: '冗余度', english: 'Redundancy', role: 'weighted',
        status: 'scored', score: 0.7,
        items: [{ itemId: 'D5.duplicate', label: '重复度', status: 'ok', value: 0.55, score: 0.55, effScore: 0.55, baselineScore: 0.9, evidence: [
          { turnIndex: 7, label: '同段代码重发两轮', impact: 'bad' },
          { turnIndex: 9, label: '返工后未再重复', impact: 'good' },
        ] }],
      },
      {
        dimensionId: 'D6', name: '自主性', english: 'Autonomy', role: 'weighted',
        status: 'scored', score: 0.9, items: [],
      },
      {
        dimensionId: 'D7:doc-freshness', name: '文档更新及时性', english: 'Custom', custom: true, role: 'optional',
        status: 'scored', score: 0.6,
        items: [{ itemId: 'D7.doc-freshness', label: '文档更新及时性', status: 'ok', value: 6, unit: 'score/10', score: 0.6, evidence: [] }],
      },
    ],
    judgeCost: null,
    review: { reviewer: 'mate', tool: 'claude', completedAt: '2026-08-31T10:00:00.000Z', durationMs: 123456 },
    meta: { semanticUsed: false, scorerVersion: 'v2.0' },
  };
}

describe('TrajectoryScoring v2 渲染', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    container = null;
    root = null;
    vi.restoreAllMocks();
  });

  function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }

  it('六维 + 自定义维度通用渲染；否决标 0 分；fetch 收敛不循环', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => mkCard(),
    }));
    vi.stubGlobal('fetch', fetchMock);

    mount();
    await act(async () => {
      root!.render(createElement(TrajectoryScoring, { taskId: TASKID, embedded: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    const html = container!.innerHTML;
    for (const name of ['完成度', '行为可信', '完成质量', '完成效率', '冗余度', '自主性']) {
      expect(html).toContain(name);
    }
    // 否决维出三态徽标，加权维出分数
    expect(html).toContain('未完成');
    expect(html).toContain('82');   // 展示层整数百分制（内部 0-1 不变）
    // D7 自定义维度自动有完整呈现（呈现层不认识具体维度）
    expect(html).toContain('文档更新及时性');
    expect(html).toContain('自定义');
    // 否决：总分是处分不是成绩
    expect(html).toContain('已否决');
    expect(html).toContain('已否决');
    // 证据 §N 跳转链接
    expect(html).toContain('§3');
    // 子项得分/满分芯片（effScore 服务端盖 章，展示层只渲染）
    expect(html).toContain('100/100');
    expect(html).toContain('80/100');
    expect(html).toContain('50/100');
    // 维内占比芯片（weightInDim 服务端盖章，仅加权维计分子项）
    expect(html).toContain('维内 25%');
    // 总分算式：权重×得分 → × 覆盖度 = 总分（否决卡退化回纯权重清单，算式在非否决卡单测覆盖）
    expect(html).toContain('D3 47%');
    // 数值与得分同值 → 只出得分芯片（0.55 不再和 55/100 并排显示两次）
    expect(html).toContain('55/100');
    expect(html).not.toContain('>0.55<');
    // 对比分与得分同值（D4 基线比值项）→ 并入得分芯片；不同值（D5）→ 两者并排
    expect(html).not.toContain('对比分 80');
    expect(html).toContain('对比分 90');
    // D1 自身判定枚举中文化（不再裸显 incomplete/none/high…）
    expect(html).toContain('自报未完成');
    // 证据带倾向标注时优缺点分组（问题在前、做得好在后），不再混排误读
    expect(html).toContain('问题（扣分依据）');
    expect(html).toContain('做得好（加分依据）');
    // 六维能力雷达图（纯 SVG）：多边形 + 维度标签
    expect(html).toContain('六维能力雷达图');
    expect(html).toContain('六维能力图');
    expect(html).toContain('polygon');
    expect(html).toContain('D4 完成效率');
    // 评审溯源：工具类型（mate·claude）+ 完成时间（本地 YYYY-MM-DD HH:mm，时区无关断言格式）
    expect(html).toContain('Mate Agent · claude');
    expect(html).toContain('评完');
    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    // 评审耗时芯片（durationMs 123456 → 2m3s）；确定性层无 stamp 不出
    expect(html).toContain('耗时');
    expect(html).toContain('2m3s');
    // loading↔ok 收敛：scorecard GET 1 次 + ScoringCriteria 口径 GET 1 次 + Mate Agent 探测 GET 1 次，不循环
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(c => String(c[0])).some(u => u.includes('/api/observe/scoring/profiles'))).toBe(true);
    expect(fetchMock.mock.calls.map(c => String(c[0])).some(u => u.includes('/api/observe/session/mate-agent'))).toBe(true);
  });

  it('aborted 卡：显示评价中止（截断不评）', async () => {
    const card = mkCard();
    card.status = 'aborted';
    card.abortReason = 'truncated';
    card.dimensions = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => card })));

    mount();
    await act(async () => {
      root!.render(createElement(TrajectoryScoring, { taskId: TASKID, embedded: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    expect(container!.innerHTML).toContain('评价中止');
    expect(container!.innerHTML).toContain('截断');
  });

  it('无 review 盖章（规则层重算 / 旧缓存卡）：工具类型回落「确定性层」，完成时间用 computedAt', async () => {
    const card = mkCard();
    delete card.review;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => card })));

    mount();
    await act(async () => {
      root!.render(createElement(TrajectoryScoring, { taskId: TASKID, embedded: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    expect(container!.innerHTML).toContain('确定性层评审完成 · LLM 评审未执行');
    expect(container!.innerHTML).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('疑似人工复核：待确认显示按钮与徽标；已确认点显示结果徽标，POST 后刷新整卡', async () => {
    const card = mkCard();
    const d2 = card.dimensions.find(d => d.dimensionId === 'D2')!;
    d2.items = [{
      itemId: 'D2.destructive', label: '破坏性操作', status: 'ok', verdict: 'clean', adjState: 'pending',
      value: '0 确凿 / 2 疑似',
      note: '疑似待人工确认（先不扣分）：已排除 0，待确认 2',
      evidence: [
        { turnIndex: 160, label: '含变量的危险命令：rm -rf $R/docs', adj: 'fine' },
        { turnIndex: 174, label: '含变量的危险命令：rm -rf $R/docs2' },
      ],
    }];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => card }));
    vi.stubGlobal('fetch', fetchMock);

    mount();
    await act(async () => {
      root!.render(createElement(TrajectoryScoring, { taskId: TASKID, embedded: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    const html = container!.innerHTML;
    expect(html).toContain('疑似待确认');
    expect(html).toContain('疑似点人工复核');
    expect(html).toContain('没问题');   // 已确认点的徽标 + 未确认点的按钮
    expect(html).toContain('有问题');

    // 点「有问题」→ POST adjudicate，body 带该点定位
    const btn = Array.from(container!.querySelectorAll('button')).find(b => b.textContent === '有问题');
    expect(btn).toBeTruthy();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/observe/session/scorecard/adjudicate'));
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call![1]!.body)) as { itemId: string; label: string; confirmed: string };
    expect(body.itemId).toBe('D2.destructive');
    expect(body.label).toBe('含变量的危险命令：rm -rf $R/docs2');
    expect(body.confirmed).toBe('problem');
  });
});

describe('MateProgressText（进度百分比）', () => {
  it('维度完成数打底 + 段内按 ~70s/维插值：2/5 起步 40%、预计还需 ~4m；done 齐前封顶 99%', async () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const root = createRoot(div);
    try {
      await act(() => root.render(createElement(MateProgressText, { p: { done: 2, total: 5 } })));
      expect(div.textContent).toContain('40%');
      expect(div.textContent).not.toContain('2/5');   // 百分比已含完成度，done/total 不再并列（悬停 title 里保留计数）
      expect(div.textContent).toContain('预计还需 ~4m');
      // 跑满 5 分钟的当前段（frac=1）→ 3/5=60% 但未收到 done 事件 → 60%（不出 100）
      await act(() => root.render(createElement(MateProgressText, { p: { done: 4, total: 5 } })));
      expect(div.innerHTML).toMatch(/(80|9[0-9])%/);
      expect(div.innerHTML).not.toContain('100%');
    } finally {
      await act(() => root.unmount());
      div.remove();
    }
  });
});
