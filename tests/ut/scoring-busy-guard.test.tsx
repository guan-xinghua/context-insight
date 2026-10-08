// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 回归 IT（review ③ P1-2）：Mate 评审是 5-6 分钟的 NDJSON 长窗口，运行期间
// 「评分配置」入口未随 busy 禁用——保存 profile 触发 fetchCard(true) 抢占
// busy（运行横幅消失、按钮解禁），评审 done 事件随后用旧 profile 的卡覆盖
// 客户端与落盘结果。修复后：busy 期间配置入口禁用；期间零 scorecard POST。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { createElement } from 'react';
import { TrajectoryScoring } from '@/components/scoring/TrajectoryScoring';
import type { Scorecard } from '@/lib/scoring';
import { SCORECARD_SCHEMA } from '@/lib/scoring';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TASKID = 'busy-guard-t1';

function mkCard(): Scorecard {
  return {
    schemaVersion: SCORECARD_SCHEMA,
    sessionId: 's-busy',
    taskType: 'general',
    computedAt: '2026-10-05T10:00:00.000Z',
    status: 'completed',
    framework: { totalScore: 0.6, veto: null, coverage: 1, weightsUsed: { D3: 1 } },
    dimensions: [
      { dimensionId: 'D3', name: '完成质量', english: 'Quality', role: 'weighted', status: 'scored', score: 0.6, items: [] },
    ],
    judgeCost: null,
  };
}

describe('TrajectoryScoring 评审运行中的配置入口门控', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    container = null;
    root = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }

  const findBtn = (label: string): HTMLButtonElement | null => {
    for (const btn of container!.querySelectorAll('button')) {
      if (btn.textContent?.trim().includes(label)) return btn as HTMLButtonElement;
    }
    return null;
  };

  async function flush(ticks = 8): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    }
  }

  it('Mate 评审运行中：评分配置按钮禁用、零 scorecard 重算 POST；流收尾后恢复', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const scorecardPosts: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/observe/session/mate-agent') && init?.method === 'POST') {
        // 挂起的评审流：一条 progress 后不 close——模拟长评审窗口
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            streamController = c;
            c.enqueue(new TextEncoder().encode('{"type":"progress","done":1,"total":5,"current":"评分中"}\n'));
          },
        });
        return { ok: true, status: 200, body } as unknown as Response;
      }
      if (url.includes('/api/observe/session/mate-agent')) {
        return { ok: true, status: 200, json: async () => ({ tools: ['opencode'] }) } as unknown as Response;
      }
      if (url.includes('/api/observe/session/scorecard')) {
        if (init?.method === 'POST') scorecardPosts.push(url);
        return { ok: true, status: 200, json: async () => mkCard() } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    mount();
    await act(async () => {
      root!.render(createElement(TrajectoryScoring, { taskId: TASKID, embedded: true }));
    });
    await flush();

    // 评审前：配置入口可用，无重算 POST
    expect(findBtn('评分配置')?.disabled).toBe(false);

    // 启动 Mate 评审（挂起流）→ busy='mate'
    const runBtn = findBtn('运行评审');
    expect(runBtn, '运行评审按钮未找到').toBeTruthy();
    await act(async () => { runBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) });
    await flush();

    // ① 配置入口随 busy 禁用（修复前无 disabled）
    expect(findBtn('评分配置')?.disabled, '评审运行中评分配置应禁用').toBe(true);
    expect(findBtn('运行评审')?.disabled).toBe(true);
    // ② 运行期间零 scorecard 重算 POST（修复前 onChanged→fetchCard(true) 会发）
    expect(scorecardPosts).toHaveLength(0);

    // ③ 流收尾（评审结束）→ busy 回落，配置入口恢复
    streamController!.close();
    await flush();
    expect(findBtn('评分配置')?.disabled, '评审结束后评分配置应恢复可用').toBe(false);
  }, 30_000);
});
