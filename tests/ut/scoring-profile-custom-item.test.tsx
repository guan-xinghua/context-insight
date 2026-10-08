// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 自定义项编辑器校验提示：保存按钮灰着不说原因 = 用户猜谜（每档标准填「1」这种
// 常见坑）。不满足的条件必须直接显示出来；填好后提示消失、按钮可点。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { createElement } from 'react';
import { ProfileManager } from '@/components/scoring/ProfileManager';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setNativeValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const click = (el: Element) => {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

function stubProfilesApi() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ profiles: [], activeId: null }),
  })));
}

describe('ProfileManager 自定义项编辑器：校验原因可见', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    container = null;
    root = null;
    vi.restoreAllMocks();
  });

  async function mount() {
    stubProfilesApi();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(ProfileManager, { open: true, onOpenChange: () => {}, onChanged: () => {} }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    // 进入编辑面板：新建配置 → ProfileEditor（自定义项区在面板里）
    const create = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('新建配置'));
    expect(create).toBeTruthy();
    click(create!);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  }

  it('每档标准太短：按钮灰着且明说原因（档位红框 + 「还不能保存」清单）', async () => {
    await mount();

    const addBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('加一项'));
    expect(addBtn).toBeTruthy();
    click(addBtn!);

    const html = document.body.innerHTML;
    expect(html).toContain('还不能保存');
    expect(html).toContain('每档标准至少 4 字');
    expect(html).toContain('名称必填');
    const save = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('保存自定义项'));
    expect(save?.hasAttribute('disabled')).toBe(true);
  });

  it('名称与每档标准填够：提示消失、保存可点', async () => {
    await mount();

    click(Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('加一项'))!);

    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="如：文档同步"]')!;
    expect(nameInput).toBeTruthy();
    act(() => { setNativeValue(nameInput, '文档同步'); });

    const bandInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
      .filter(i => i.placeholder.includes('什么样算这一档'));
    expect(bandInputs).toHaveLength(5);
    act(() => {
      bandInputs.forEach((i, idx) => setNativeValue(i, `第${idx + 1}档的标准说明`));
    });

    expect(document.body.innerHTML).not.toContain('还不能保存');
    const save = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('保存自定义项'));
    expect(save?.hasAttribute('disabled')).toBe(false);
  });

  it('两档判定类型：切换后五档换成判定标准；标准填够可保存', async () => {
    await mount();

    click(Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('加一项'))!);

    const binaryRadio = Array.from(document.querySelectorAll('label'))
      .find(l => l.textContent?.includes('两档判定'))!
      .querySelector('input[type="radio"]')!;
    click(binaryRadio);

    const html = document.body.innerHTML;
    expect(html).toContain('判定标准（是非题');
    expect(html).not.toContain('每档标准');
    expect(html).toContain('判定标准至少 4 字');

    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="如：文档同步"]')!;
    act(() => { setNativeValue(nameInput, '文档同步'); });
    const criteria = document.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(criteria).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(criteria, '设计变更同步更新到 docs/ 下的设计文档');
      criteria.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(document.body.innerHTML).not.toContain('还不能保存');
    const save = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('保存自定义项'));
    expect(save?.hasAttribute('disabled')).toBe(false);
  });
});
