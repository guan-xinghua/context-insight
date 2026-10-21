// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// P3 材质红线 IT（design.md §12.4/12.5）：玻璃只出现在浮层 chrome（缩放
// 工具条 / 概览侧栏 / 子图弹窗），内容层（RunGraph SVG 节点/边/文本）零
// backdrop-filter；材质类与 @supports 降级在 globals.css 单点定义；节点卡
// 圆角、选中态高光外圈、点阵细化、工具条微交互类均有 DOM 锁。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, Suspense, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import RunDetailPage from '@/app/run/[runId]/page';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel } from '@/lib/run/view-model';
import type { RunImportMeta } from '@/lib/run/run-store';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => '/run/minidemo01',
  useSearchParams: () => new URLSearchParams(''),
}))

const importMeta: RunImportMeta['data'] = {
  importedAt: '2026-10-15T10:00:00+08:00',
  sourceDir: '/bundle/mini',
  manifestFile: 'workflow.json',
  exportDataComplete: true,
  sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
  failures: [],
  warnings: [],
};

function bodyOf(fixturePath: string, runId: string) {
  const index = parseAndIndex(JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as unknown);
  const vm = buildViewModel(index);
  return {
    run: {
      runId,
      name: index.manifest.name ?? null,
      status: vm.status,
      exportDataComplete: vm.exportDataComplete,
      startedAt: vm.startedAt,
      finishedAt: vm.finishedAt,
      import: importMeta,
    },
    viewModel: vm,
  };
}

const miniBody = bodyOf(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'minidemo01');
const rollbackBody = bodyOf(path.resolve(__dirname, './data/run/graph-demo-rollback-manifest.json'), 'roller01');

let root: Root | null = null

async function renderPage(body: typeof miniBody, runId: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })))
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(RunDetailPage, { params: Promise.resolve({ runId }) }),
      ),
    )
  })
  await act(async () => {
    await new Promise(r => setTimeout(r, 0))
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('P3 材质：玻璃浮层落点（页面级）', () => {
  it('缩放工具条与概览侧栏为玻璃浮层，画布内容层零玻璃', async () => {
    await renderPage(miniBody, 'minidemo01')

    // 工具条：run-glass 容器 + 按钮微交互类（spring/按压/hover 内衬）
    const zoomIn = document.querySelector('button[aria-label="放大"]') as HTMLElement
    expect(zoomIn, '缩放工具条应存在').toBeTruthy()
    const toolbar = zoomIn.parentElement as HTMLElement
    expect(toolbar.getAttribute('class')).toContain('run-glass')
    for (const btn of Array.from(toolbar.querySelectorAll('button'))) {
      expect(btn.getAttribute('class')).toContain('run-tool-btn')
    }

    // 概览侧栏：浮层玻璃 + 滚动边缘渐隐（mask），不再依赖硬边框/硬分割线
    const aside = document.querySelector('aside') as HTMLElement
    expect(aside, '概览侧栏应存在').toBeTruthy()
    const asideClass = aside.getAttribute('class') ?? ''
    expect(asideClass).toContain('run-glass')
    expect(asideClass).toContain('run-scroll-fade')
    expect(asideClass).toContain('absolute')

    // 红线：玻璃类不得出现在画布 viewport 内（内容层 = 节点/边/文本）
    expect(document.querySelector('.run-canvas .run-glass')).toBeNull()
  })

  it('子图弹窗为玻璃 chrome：弹窗容器与内嵌侧栏玻璃，画布仍零玻璃', async () => {
    await renderPage(rollbackBody, 'roller01')

    const hosts = Array.from(document.querySelectorAll('.run-node')).filter(g =>
      g.textContent?.includes('子图 ▸'),
    )
    expect(hosts.length).toBeGreaterThan(0)
    await act(async () => {
      hosts[0].querySelector('g')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute('class')).toContain('run-glass')
    const dialogAside = dialog.querySelector('aside') as HTMLElement
    expect(dialogAside).toBeTruthy()
    const asideClass = dialogAside.getAttribute('class') ?? ''
    expect(asideClass).toContain('run-glass')
    expect(asideClass).toContain('run-scroll-fade')
    // 主图与弹窗两块画布的内容层都不得出现玻璃
    for (const canvas of Array.from(document.querySelectorAll('.run-canvas'))) {
      expect(canvas.querySelector('.run-glass')).toBeNull()
    }
  })
})

describe('P3 材质：节点卡与画布底（SVG 内容层）', () => {
  it('节点卡连续圆角 rx=11，点阵细化 r=0.9 且半幅加密', async () => {
    await renderPage(miniBody, 'minidemo01')

    const boxes = document.querySelectorAll('.run-node-box')
    expect(boxes.length).toBeGreaterThan(0)
    for (const box of Array.from(boxes)) {
      expect(box.getAttribute('rx')).toBe('11')
    }

    // 点阵：主点 + 四角半透明加密点（24px pattern → 有效 12px 网格）
    const dots = document.querySelectorAll('.run-canvas svg pattern circle')
    expect(dots.length).toBe(5)
    for (const dot of Array.from(dots)) {
      expect(dot.getAttribute('r')).toBe('0.9')
    }
  })

  it('选中态：玻璃高光双层外圈（同心 rx 15.5/20）+ 描边加粗保持', async () => {
    await renderPage(miniBody, 'minidemo01')

    const node = document.querySelector('.run-node') as SVGGElement
    expect(node).toBeTruthy()
    await act(async () => {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // 选中节点带双层高光外圈；全图唯一（其余节点无 halo）
    const halos = document.querySelectorAll('.run-node rect[rx="15.5"]')
    expect(halos.length).toBe(1)
    const selected = halos[0].closest('.run-node') as SVGGElement
    expect(selected.querySelector('rect[rx="20"]')).toBeTruthy()
    expect(selected.querySelector('.run-node-box')?.getAttribute('stroke-width')).toBe('2.5')
    const others = Array.from(document.querySelectorAll('.run-node')).filter(n => n !== selected)
    for (const n of others) {
      expect(n.querySelector('rect[rx="15.5"]')).toBeNull()
      expect(n.querySelector('.run-node-box')?.getAttribute('stroke-width')).toBe('2')
    }
  })
})

describe('P3 材质：样式契约（globals.css 单点）', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../src/app/globals.css'), 'utf-8')
  const graphSrc = fs.readFileSync(path.resolve(__dirname, '../../src/components/run/RunGraph.tsx'), 'utf-8')

  it('内容层（RunGraph）源码零 backdrop-filter / 零玻璃类', () => {
    expect(graphSrc).not.toContain('backdrop-filter')
    expect(graphSrc).not.toContain('run-glass')
  })

  it('玻璃材质：blur(20px) saturate(1.6) + 对角高光渐变 + @supports 降级为不透明白', () => {
    expect(css).toMatch(/\.run-glass\s*{[^}]*backdrop-filter:\s*blur\(20px\)\s+saturate\(1\.6\)/)
    expect(css).toMatch(/\.run-glass\s*{[^}]*background-image:\s*linear-gradient\(\s*135deg/)
    const fallback = css.match(/@supports not[^{]*{[\s\S]*?\.run-glass\s*{([^}]*)}/)
    expect(fallback, '@supports 降级块应存在').toBeTruthy()
    expect(fallback![1]).toMatch(/background:\s*#fff/)
    // 降级必须用 background 简写（连 background-image 一并重置），否则渐变
    // 高光会在无 backdrop-filter 的环境单独漏出来
    expect(fallback![1]).not.toContain('background-image')
  })

  it('微交互：spring 缓动 + 按压 scale(0.98) + 滚动边缘 mask 渐隐', () => {
    expect(css).toMatch(/--run-spring:\s*cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)/)
    expect(css).toMatch(/\.run-tool-btn:active\s*{[^}]*transform:\s*scale\(0\.98\)/)
    expect(css).toMatch(/\.run-scroll-fade\s*{[^}]*mask-image:\s*linear-gradient/)
  })
})
