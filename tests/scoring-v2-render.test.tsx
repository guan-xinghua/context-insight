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
import { TrajectoryScoring } from '@/components/scoring/TrajectoryScoring';
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
        items: [{ itemId: 'D1.selfReport', label: '自报完成态', status: 'ok', verdict: 'incomplete', value: '1/2', evidence: [{ turnIndex: 3, label: '未勾：deploy gamma service' }] }],
      },
      {
        dimensionId: 'D2', name: '行为可信', english: 'Trust', role: 'veto',
        status: 'scored', verdict: 'clean',
        items: [{ itemId: 'D2.destructive', label: '破坏性操作', status: 'ok', verdict: 'clean', value: '0 确凿 / 0 疑似', evidence: [] }],
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
        items: [{ itemId: 'D4.tokens', label: 'token 排名', status: 'ok', value: 120000, unit: 'tokens', baselineScore: 0.8, score: 0.8, evidence: [] }],
      },
      {
        dimensionId: 'D5', name: '冗余度', english: 'Redundancy', role: 'weighted',
        status: 'scored', score: 0.7, items: [],
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
    // 六维能力雷达图（纯 SVG）：多边形 + 维度标签
    expect(html).toContain('六维能力雷达图');
    expect(html).toContain('六维能力图');
    expect(html).toContain('polygon');
    expect(html).toContain('D4 完成效率');
    // loading↔ok 收敛：scorecard GET 1 次 + ScoringCriteria 口径 GET 1 次，不循环
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(c => String(c[0])).some(u => u.includes('/api/observe/scoring/profiles'))).toBe(true);
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
});
