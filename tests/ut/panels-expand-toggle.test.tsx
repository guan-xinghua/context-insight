// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 展开收起交互统一的全面板覆盖（bug 修复 IT）：LLM Output / Tool Calls / Wire Rounds
// 面板的行空白处点击不触发展开，仅行尾三角（▶/▼）可触发。与 context-expand-toggle
// 共同构成「三角唯一触发点」契约的完整覆盖。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { LlmOutputView } from '@/components/observe/LlmOutputView';
import { ToolCallList } from '@/components/observe/ToolCallList';
import { WireRounds } from '@/components/observe/WireRounds';

const THINKING_TAIL = 'THINKING-FULL-TAIL-MARKER';
const ARGS_MARKER = 'ARGS-FULL-MARKER';
const WIRE_MSG = 'WIRE-MSG-FULL-MARKER';

function renderSync(el: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(el); });
  return container;
}

async function renderAsync(el: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  await act(async () => {}); // flush 数据拉取的微任务
  return container;
}

// 只认三角（▶/▼）：CopyButton 同为 role="button"，须排除
function toggles(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[role="button"]'))
    .filter(el => el.textContent?.trim() === '▶' || el.textContent?.trim() === '▼');
}

function rowOf(tri: Element): HTMLElement {
  const row = tri.closest('div');
  expect(row, 'triangle should live in a row div').toBeTruthy();
  return row as HTMLElement;
}

function click(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

// 三角位于行尾（自身或前置兄弟承载 ml-auto / justify-between 布局）
function isRowEnd(tri: Element): boolean {
  return rowOf(tri).lastElementChild === tri;
}

function toggleByRowText(container: HTMLElement, rowText: string): Element {
  const tri = toggles(container).find(el => rowOf(el).textContent?.includes(rowText));
  expect(tri, `row containing "${rowText}" should have a triangle toggle`).toBeDefined();
  return tri!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LlmOutputView 展开收起交互', () => {
  function renderOutput() {
    return renderSync(createElement(LlmOutputView, {
      content: `<thinking>${THINKING_TAIL}</thinking>Final answer`,
      contentJson: null,
      contentSummary: null,
      outputTokens: 100,
      reasoningTokens: 50,
    } as never));
  }

  it('面板头：空白点击不收起，三角点击收起/展开；三角在行尾', () => {
    const c = renderOutput();
    const tri = toggles(c)[0];
    expect(tri).toBeDefined();
    expect(isRowEnd(tri)).toBe(true);

    // 小输出默认展开（≤2000t 且内容 ≤6000 字符）
    expect(c.textContent).toContain('thinking');
    click(rowOf(tri)); // 行空白处
    expect(c.textContent).toContain('thinking');
    click(tri); // 三角 → 收起
    expect(c.textContent).not.toContain('thinking');
    click(tri); // 再点 → 展开
    expect(c.textContent).toContain('thinking');
  });

  it('thinking 段：空白点击不展开，三角点击展开全文', () => {
    const c = renderOutput(); // 面板默认展开
    const thinkTri = toggleByRowText(c, 'thinking');

    expect(c.textContent).not.toContain(THINKING_TAIL);
    click(rowOf(thinkTri)); // 行空白处
    expect(c.textContent).not.toContain(THINKING_TAIL);
    click(thinkTri); // 三角
    expect(c.textContent).toContain(THINKING_TAIL);
  });
});

describe('ToolCallList 展开收起交互', () => {
  function renderTools() {
    return renderSync(createElement(ToolCallList, {
      toolCalls: [{
        id: 'tc1', toolCallId: 'tc1', toolName: 'Bash',
        argsJson: `{"cmd": "${ARGS_MARKER}"}`, resultJson: 'ok',
        state: 'ok', errorType: null, errorMessage: null,
        durationMs: 120, isSkillRelated: false,
      }],
    } as never));
  }

  it('工具调用行：空白点击不展开，三角点击展开 Args/Result；三角在行尾', () => {
    const c = renderTools();
    const tri = toggleByRowText(c, 'Bash');
    expect(isRowEnd(tri)).toBe(true);

    expect(c.textContent).not.toContain(ARGS_MARKER);
    click(rowOf(tri)); // 行空白处
    expect(c.textContent).not.toContain(ARGS_MARKER);
    click(tri); // 三角
    expect(c.textContent).toContain(ARGS_MARKER);
    expect(c.textContent).toContain('Args');
    click(tri); // 收起
    expect(c.textContent).not.toContain(ARGS_MARKER);
  });
});

describe('WireRounds 展开收起交互', () => {
  async function renderWire() {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        taskId: 't1', sourcePath: '/x/cpx-t1.jsonl', delta: false, totalRounds: 1,
        rounds: [{
          index: 1, timestamp: '2026-09-16T10:00:00', model: 'test-model',
          usage: { input: 10, output: 5 }, newFrom: 0,
          requestMessages: [{
            role: 'user',
            content: { json: WIRE_MSG, truncated: false, chars: 20 },
            timestamp: '2026-09-16T10:00:00',
          }],
          response: { content: { json: '{}', truncated: false, chars: 2 }, blocks: ['text'], text: 'hi' },
        }],
      }),
    })));
    return renderAsync(createElement(WireRounds, { taskId: 't1' }));
  }

  it('Round 头：空白点击不展开，三角点击展开；三角在行尾', async () => {
    const c = await renderWire();
    const tri = toggles(c)[0];
    expect(tri).toBeDefined();
    expect(isRowEnd(tri)).toBe(true);

    expect(c.textContent).not.toContain('其中本轮新增'); // 展开区未出现
    click(rowOf(tri)); // 行空白处
    expect(c.textContent).not.toContain('其中本轮新增');
    click(tri); // 三角
    expect(c.textContent).toContain('其中本轮新增');
    click(tri); // 收起
    expect(c.textContent).not.toContain('其中本轮新增');
  });

  it('消息行：空白点击不展开全文，三角点击解除高度裁剪', async () => {
    const c = await renderWire();
    click(toggles(c)[0]); // 展开 Round（默认收起）
    // 消息头行含 role badge 'user'（内容标记在行下方 pre 里，不在行内）
    const msgTri = toggleByRowText(c, 'user');

    // 折叠态：内容在 DOM 但被 max-h 裁剪；展开态：高度放开
    const preOf = () => Array.from(c.querySelectorAll('pre'))
      .find(el => el.textContent?.includes(WIRE_MSG)) as HTMLElement;
    expect(preOf().className).toContain('max-h-[54px]');
    click(rowOf(msgTri)); // 行空白处
    expect(preOf().className).toContain('max-h-[54px]');
    click(msgTri); // 三角
    expect(preOf().className).toContain('max-h-[480px]');
  });
});
