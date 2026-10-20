// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 成员行用量胶囊的缩写回归锁：compactTokens 在 999,500 ≤ n < 1,000,000 时
// Math.round(n/1000)=1000 曾产出「1000k」，与 ≥1M 档「1.0M」衔接不一致。
// 组件层断言（真实 RunNodeDetail 渲染），锁 k/M 档衔接。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RunNodeDetail } from '@/components/run/RunNodeDetail';
import type { AttemptRecord, NodeInstance } from '@/lib/run/view-model';
import type { SessionRef } from '@/lib/run/model';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => '/run/demo',
  useSearchParams: () => new URLSearchParams(''),
}))

function mkNode(totalTokens: number): NodeInstance {
  const session: SessionRef = {
    taskId: 'S_BOUNDARY',
    framework: 'opencode',
    rowId: 'row-boundary',
    turns: 3,
    totalTokens,
    durationMs: 5000,
    label: null,
    startTime: '2026-10-10T02:01:30Z',
    endTime: '2026-10-10T02:01:35Z',
    cacheReadTokens: 0,
  };
  const attempt: AttemptRecord = {
    ordinal: 1,
    status: 'passed',
    startedAt: '2026-10-10T02:01:30Z',
    finishedAt: '2026-10-10T02:01:35Z',
    outputText: null,
    verification: { type: 'agent', status: 'passed', reason: null },
    executeMember: {
      memberId: 'M_BOUNDARY',
      kind: 'session',
      role: 'execute',
      name: null,
      note: null,
      sessionId: 'S_BOUNDARY',
      location: null,
      startedAt: null,
      finishedAt: null,
      session,
    },
    verifyMember: null,
  };
  return {
    key: 'n-step-a-g0',
    nodeId: 'step-a',
    generation: 0,
    label: 'step-a',
    taskType: 'agent',
    status: 'passed',
    executionState: 'executed',
    carriedFromGeneration: null,
    attempts: [attempt],
    pendingMembers: [],
    retryPolicy: null,
    runOnFailure: null,
    predecessorKeys: [],
    parentKey: null,
    hasSubgraph: false,
  };
}

let root: Root | null = null;

function renderTokens(totalTokens: number): string {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(RunNodeDetail, {
        node: mkNode(totalTokens),
        rollbacks: [],
        peers: [],
        onSelectNode: () => {},
        onClose: () => {},
      }),
    );
  });
  return container.textContent ?? '';
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
})

describe('RunNodeDetail：会话用量胶囊缩写（k/M 档衔接）', () => {
  it('999,499 落 999k，999,500 起不再产出 1000k 而回落 1.0M', () => {
    expect(renderTokens(999_499)).toContain('999k');

    const atBoundary = renderTokens(999_500);
    expect(atBoundary).toContain('1.0M');
    expect(atBoundary).not.toContain('1000k');
  });

  it('999,999 与 1,000,000 均落 1.0M（档位衔接一致）', () => {
    expect(renderTokens(999_999)).toContain('1.0M');
    expect(renderTokens(1_000_000)).toContain('1.0M');
  });

  it('常规档位不受影响：1,234 → 1.2k', () => {
    expect(renderTokens(1_234)).toContain('1.2k');
  });
});
