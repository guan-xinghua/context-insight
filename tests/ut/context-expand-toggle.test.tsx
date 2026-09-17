// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 展开收起交互统一（bug 修复 IT）：三角按钮（▶/▼）是行内唯一的展开入口——
// 行空白处点击不触发；且统一锚定行最右侧（自身或其右控组带 ml-auto）。
// 覆盖两个上下文查看面：session 页 TurnContextPanel 与 turn 详情 LlmContextView。

import { describe, it, expect } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { TurnContextPanel } from '@/components/observe/TurnContextPanel';
import { LlmContextView } from '@/components/observe/LlmContextView';

// 内容构造：摘要（前 80 字符）含唯一前缀，全文含唯一尾部——两者互不包含，
// 才能区分「行可见（摘要）」与「内容展开（全文）」
const LONG_USER_TEXT = 'CTX-SUMMARY-MARKER-' + 'A'.repeat(120) + '<<UNIQUE-FULL-TAIL>>';
const LONG_USER_TAIL = '<<UNIQUE-FULL-TAIL>>'; // 只会出现在完整展开的内容里
const LONG_USER_ROW = 'CTX-SUMMARY-MARKER-'; // 摘要前缀，行可见即在

function render(el: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(el); });
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

function toggleByRowText(container: HTMLElement, rowText: string): Element {
  const tri = toggles(container).find(el => rowOf(el).textContent?.includes(rowText));
  expect(tri, `row containing "${rowText}" should have a triangle toggle`).toBeDefined();
  return tri!;
}

function click(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

// 右锚定：三角自身 ml-auto，或所在右控组容器 ml-auto（LlmContextView 消息行的 copy+三角 组）
function isRightAnchored(tri: Element): boolean {
  const self = (tri as HTMLElement).className ?? '';
  const parent = (tri.parentElement as HTMLElement | null)?.className ?? '';
  return self.includes('ml-auto') || parent.includes('ml-auto');
}

function turnContextInfo() {
  return {
    agentName: null,
    model: null,
    inputMessagesJson: JSON.stringify([
      { role: 'user', content: LONG_USER_TEXT, tokenCount: 120 },
      { role: 'assistant', content: 'short', tokenCount: 10, tool_calls: [{ name: 'Bash', args: 'ls', result: 'ok' }] },
    ]),
    inputMessagesCount: 2,
    inputMessagesTokens: 130,
    contextWindowPct: 5,
    endContextWindowPct: null,
    contextWindowLimit: 200000,
    systemOverheadTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    isSubagent: false,
    subagentName: null,
  };
}

describe('TurnContextPanel 展开收起交互', () => {
  function renderPanel() {
    return render(createElement(TurnContextPanel, {
      selectedTurn: { turnId: 't1', turnIndex: 0, role: 'assistant' },
      rootContext: turnContextInfo(),
      subagentContexts: [],
      prevContextPct: null,
    } as never));
  }

  it('「Show full context」：行空白点击不展开，三角点击展开；所有三角右锚定', () => {
    const c = renderPanel();
    expect(toggles(c).length).toBe(1);
    const tri = toggles(c)[0];
    expect(tri.textContent).toBe('▶');
    expect(isRightAnchored(tri)).toBe(true);

    click(rowOf(tri)); // 行空白处
    expect(c.textContent).not.toContain('msg ·'); // 分类行未出现

    click(tri); // 三角
    expect(c.textContent).toContain('msg ·');
    expect(c.textContent).toContain('User');
    expect(c.textContent).toContain('Assistant');
  });

  it('分类行：空白点击不展开消息，三角点击展开', () => {
    const c = renderPanel();
    click(toggles(c)[0]); // 展开 full context
    const catTri = toggleByRowText(c, 'User');

    click(rowOf(catTri)); // 行空白处
    expect(c.textContent).not.toContain(LONG_USER_ROW); // 消息行未出现

    click(catTri);
    expect(c.textContent).toContain(LONG_USER_ROW); // 消息行 + 摘要出现
    expect(isRightAnchored(catTri)).toBe(true);
  });

  it('消息行：空白点击不展开全文，三角点击展开/收起', () => {
    const c = renderPanel();
    click(toggles(c)[0]); // 展开 full context
    click(toggleByRowText(c, 'User')); // 展开分类
    const msgTri = toggleByRowText(c, LONG_USER_ROW);

    expect(c.textContent).not.toContain(LONG_USER_TAIL); // 默认折叠，只有摘要
    click(rowOf(msgTri)); // 行空白处
    expect(c.textContent).not.toContain(LONG_USER_TAIL);
    click(msgTri); // 三角
    expect(c.textContent).toContain(LONG_USER_TAIL);
    click(msgTri); // 再点收起
    expect(c.textContent).not.toContain(LONG_USER_TAIL);
    expect(isRightAnchored(msgTri)).toBe(true);
  });

  it('短内容但有 tool_calls 的消息也有三角，点开可见 tool call', () => {
    const c = renderPanel();
    click(toggles(c)[0]); // 展开 full context
    click(toggleByRowText(c, 'Assistant')); // 展开 assistant 分类

    const toolTri = toggleByRowText(c, 'short'); // 短消息行（有 tool_calls → 有三角）
    click(toolTri);
    expect(c.textContent).toContain('Bash');
    expect(c.textContent).toContain('tool call');
  });
});

describe('LlmContextView 展开收起交互', () => {
  function renderView() {
    return render(createElement(LlmContextView, {
      inputMessagesJson: JSON.stringify([
        { role: 'user', content: LONG_USER_TEXT, tokenCount: 120 },
      ]),
      inputMessagesCount: 1,
      inputMessagesTokens: 120,
      contextWindowPct: 1,
      systemOverheadTokens: 0,
      systemPrompt: null,
      fullContext: { tools: [], memoryFiles: '', skills: '' },
    } as never));
  }

  it('消息行：空白点击不展开，三角点击展开/收起；三角右锚定（copy 组 ml-auto）', () => {
    const c = renderView();
    const msgTri = toggleByRowText(c, 'user');
    expect(isRightAnchored(msgTri)).toBe(true);

    // 垂直对齐修复：copy 图标必须 flex 居中（内联 SVG 基线排版会溢出固定盒子），
    // 与三角（文本字形居中）在同一水平线上
    const copyBtn = Array.from(c.querySelectorAll('[role="button"]'))
      .find(el => (el as HTMLElement).title === 'Copy');
    expect(copyBtn, 'copy button in msg row should exist').toBeDefined();
    const copyCls = (copyBtn as HTMLElement).className;
    expect(copyCls).toContain('inline-flex');
    expect(copyCls).toContain('items-center');

    expect(c.textContent).not.toContain(LONG_USER_TAIL);
    click(rowOf(msgTri)); // 行空白处
    expect(c.textContent).not.toContain(LONG_USER_TAIL);
    click(msgTri); // 三角
    expect(c.textContent).toContain(LONG_USER_TAIL);
    click(msgTri); // 收起
    expect(c.textContent).not.toContain(LONG_USER_TAIL);
  });

  it('面板头：空白点击无效果，三角点击收起整个面板', () => {
    const c = renderView();
    // 面板默认展开（消息行可见）；面板头三角 = 所在行不含消息 role 的那个
    const headerTri = toggles(c).find(el => !rowOf(el).textContent?.includes('user'));
    expect(headerTri, 'panel header triangle should exist').toBeDefined();
    expect(isRightAnchored(headerTri!)).toBe(true);

    click(rowOf(headerTri!)); // 行空白处
    expect(c.textContent).toContain('user'); // 面板仍展开

    click(headerTri!); // 三角 → 收起
    expect(c.textContent).not.toContain('user');
    click(headerTri!); // 再点 → 展开
    expect(c.textContent).toContain('user');
  });
});
