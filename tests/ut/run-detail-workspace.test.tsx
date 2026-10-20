// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Run 详情页工作台渲染 IT：真实 fixture（mini-bundle）→ 真实 view-model →
// mock fetch → 组件树断言。锁四件事：① 工作台结构（视图标题/图例/概览侧栏，
// 子图为弹窗不占顶层视图）；② 节点点击后侧栏切换为运行历史；③ 概览统计与
// 代际信息来自真实数据；④ 画布缩放（工具条按钮 + Ctrl 滚轮）与跑马灯按需
// 点亮（选中节点 → 关联边状态色加粗 + 白色蚂蚁线，点击空白熄灭）；另设
// 确定性几何拓扑锁 PCB 交叉跳线、回滚 fixture 锁子图弹窗（代际切换）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import RunDetailPage from '@/app/run/[runId]/page';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import type { NodeInstance, RunView } from '@/lib/run/view-model';
import { RunGraph } from '@/components/run/RunGraph';
import { RUN_COLORS, flowColor, statusColor } from '@/components/run/run-theme';
import type { RunImportMeta } from '@/lib/run/run-store';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => '/run/minidemo01',
  useSearchParams: () => new URLSearchParams(''),
}))

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'),
) as unknown;
const index = parseAndIndex(fixture);
const viewModel = buildViewModel(index);
const importMeta: RunImportMeta['data'] = {
  importedAt: '2026-10-15T10:00:00+08:00',
  sourceDir: '/bundle/mini',
  manifestFile: 'workflow.json',
  exportDataComplete: true,
  sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
  failures: [],
  warnings: [],
};
const responseBody = {
  run: {
    runId: 'minidemo01',
    name: index.manifest.name ?? null,
    status: viewModel.status,
    exportDataComplete: viewModel.exportDataComplete,
    startedAt: viewModel.startedAt,
    finishedAt: viewModel.finishedAt,
    import: importMeta,
  },
  viewModel,
};

vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => responseBody,
})))

let root: Root | null = null

async function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(RunDetailPage, { params: Promise.resolve({ runId: 'minidemo01' }) }),
      ),
    )
  })
  await act(async () => {
    await new Promise(r => setTimeout(r, 0))
  })
}

function clickNode(labelPart: string) {
  const node = Array.from(document.querySelectorAll('.run-node')).find(g =>
    g.textContent?.includes(labelPart),
  )
  expect(node, `图上应存在含「${labelPart}」的节点`).toBeTruthy()
  node!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('Run 详情页暗色工作台', () => {
  it('工作台结构：视图标题、图例、Run 概览侧栏（子图为弹窗，不占顶层视图）', async () => {
    await renderPage()

    expect(document.querySelector('.run-canvas')).toBeTruthy()
    // 工具条无视图 tab——主图即工作台，子图经生成器节点入口以弹窗展开
    expect(document.querySelectorAll('[role="tab"]').length).toBe(0)
    expect(document.body.textContent).toContain('主图（所有代）')

    const text = document.body.textContent ?? ''
    expect(text).toContain('依赖')
    expect(text).toContain('回滚')
    expect(text).toContain('Run 概览')
    expect(text).toContain('节点')
    expect(text).toContain('第 1 次运行')

    // 边渲染：默认全部静止（跑马灯按需点亮——见下个用例），正交走线无三次贝塞尔
    expect(document.querySelectorAll('.run-edge-flow').length).toBe(0)
    expect(document.querySelectorAll('.run-rb-flow').length).toBe(0)
    const depPaths = document.querySelectorAll('path.run-dep')
    expect(depPaths.length).toBeGreaterThan(0)
    for (const p of depPaths) {
      const d = p.getAttribute('d') ?? ''
      expect(d).toMatch(/^M [\d.]+ [\d.]+ (L|Q) /)
      expect(d).not.toContain('C ') // 无三次贝塞尔（曲线走线禁用）
    }

    // 侧栏宽度 360px（工作台标准侧栏）
    const aside = document.querySelector('aside')
    expect(aside?.className).toContain('w-[360px]')
  })

  it('选中节点点亮关联边跑马灯（状态色加粗 + 白色蚂蚁线），点击空白熄灭', async () => {
    await renderPage()
    const main = viewModel.views[0]
    const byKey = new Map(viewModel.nodes.map(n => [n.key, n]))
    const initKey = main.nodeKeys.find(k => byKey.get(k)!.nodeId === 'init')!

    // 点击 init：其关联边（直接连出/连入）点亮
    await act(async () => {
      clickNode('init')
    })
    const relatedCount = main.edgeChains.filter(c => c.from === initKey || c.to === initKey).length
    expect(relatedCount).toBeGreaterThan(0)
    const flows = document.querySelectorAll('.run-edge-flow')
    expect(flows.length).toBe(relatedCount)
    for (const p of flows) {
      expect(p.getAttribute('stroke')).toBe(RUN_COLORS.canvas) // 白色蚂蚁线
    }
    // 关联边 base 以目标状态色加粗，未关联边保持灰色
    const depBase = document.querySelectorAll('path.run-dep')
    expect(depBase.length).toBe(main.edgeChains.length)
    main.edgeChains.forEach((c, i) => {
      const related = c.from === initKey || c.to === initKey
      expect(depBase[i].getAttribute('stroke')).toBe(
        related ? flowColor(byKey.get(c.to)!.status) : RUN_COLORS.edge,
      )
      expect(depBase[i].getAttribute('stroke-width')).toBe(related ? '2' : '1.25')
    })
    // 回滚边不关联 init → 保持静止（爬行只在关联时点亮）
    expect(document.querySelectorAll('.run-rb-flow').length).toBe(0)

    // 点击画布空白（非节点、非拖拽）→ 取消选中，跑马灯熄灭
    const canvas = document.querySelector('.run-canvas') as HTMLElement
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(document.querySelectorAll('.run-edge-flow').length).toBe(0)
    expect(document.querySelectorAll('.run-rb-flow').length).toBe(0)
  })

  it('画布缩放：工具条按钮 / Ctrl+滚轮 / 重置 / 适配', async () => {
    await renderPage()
    const zoomLabel = () => document.querySelector('[aria-label="重置缩放"]')!.textContent
    expect(zoomLabel()).toBe('100%')

    await act(async () => {
      ;(document.querySelector('[aria-label="放大"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('115%')

    // Ctrl + 滚轮以光标为锚缩放（native listener，passive: false）。
    // happy-dom 的 WheelEvent 不读修饰键 init，用 MouseEvent 补 deltaY 模拟
    const canvas = document.querySelector('.run-canvas') as HTMLElement
    await act(async () => {
      const ev = new MouseEvent('wheel', { ctrlKey: true, cancelable: true })
      Object.defineProperty(ev, 'deltaY', { value: -100 })
      canvas.dispatchEvent(ev)
    })
    expect(zoomLabel()).toBe('129%') // 1.15 × 1.12 = 1.288

    await act(async () => {
      ;(document.querySelector('[aria-label="缩小"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('112%') // 1.288 / 1.15

    await act(async () => {
      ;(document.querySelector('[aria-label="重置缩放"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('100%')

    // 适配画布（happy-dom 视口为 0 → 兜底重置为 100%）
    await act(async () => {
      ;(document.querySelector('[aria-label="放大"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('115%')
    await act(async () => {
      ;(document.querySelector('[aria-label="适配画布"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('100%')
  })

  it('点击节点：侧栏从概览切换为运行历史（逐次尝试）', async () => {
    await renderPage()
    expect(document.body.textContent).toContain('Run 概览')

    await act(async () => {
      clickNode('build')
    })

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('Run 概览')
    expect(text).toContain('build')
    expect(text).toContain('第 1 次')
    expect(text).toContain('执行：')
  })

  it('再次点击同一节点：侧栏收起回到概览', async () => {
    await renderPage()
    await act(async () => {
      clickNode('build')
    })
    expect(document.body.textContent).not.toContain('Run 概览')

    await act(async () => {
      clickNode('build')
    })
    expect(document.body.textContent).toContain('Run 概览')
  })
})

describe('子图弹窗（gen-sub 三代，回滚 fixture）', () => {
  const rollbackFixture = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, './data/run/graph-demo-rollback-manifest.json'), 'utf-8'),
  ) as unknown;
  const rollbackVm = buildViewModel(parseAndIndex(rollbackFixture));
  // 模拟 API 层组装（session-link.ts）：成员-会话 join 后成员引用才带 session
  // 详情，子图弹窗的会话下钻链接依赖该注入——sub-agent-a g1 执行成员为已导入会话
  attachSessionRefs(rollbackVm, new Map([
    ['S5082A31602EE15ED', {
      taskId: 'S5082A31602EE15ED',
      framework: 'opencode',
      rowId: 'row-a1',
      turns: 3,
      totalTokens: 1234,
      durationMs: 5000,
      label: 'gen-sub:sub-agent-a',
      startTime: '2026-10-10T02:01:30Z',
      endTime: '2026-10-10T02:01:35Z',
    }],
  ]));
  // 会话时间兜底：manifest 成员时间戳缺失（session 成员常见）→ 用会话行起止组合范围
  const agentAG1 = rollbackVm.nodes.find(n => n.key === 'n-gen-sub:sub-agent-a-g1')!;
  agentAG1.attempts[0].startedAt = null;
  agentAG1.attempts[0].finishedAt = null;
  // 长验收报告（Agent 逐项证据，源自真实 bundle 形态）→ 侧栏折叠展示
  const subFlakyG1 = rollbackVm.nodes.find(n => n.key === 'n-gen-sub:sub-flaky-g1')!;
  subFlakyG1.attempts[0].status = 'failed';
  subFlakyG1.attempts[0].verification = {
    type: 'agent',
    status: 'failed',
    reason: [
      '我已完成全部验收项的核查。以下为逐项证据与结论。',
      '## 验收报告',
      '**1. 包骨架（op_host/op_kernel/op_graph/tests + build.sh/CMakeLists.txt/README.md）— met** `test -d ... && test -f ...` 全部命中，退出 0。',
      '**2. 无样例名残留 — met** `grep -rE \'add_custom|AddCustom|ADD_CUSTOM\'` 无任何匹配。',
      '**3. 包标识 == op.type（python3 REG_OP/OP_END_FACTORY_REG==Add, exits 0）— not met** 命令退出 1，AssertionError: (\'OpType\', \'OpType\', \'Add\')。',
    ].join('\n'),
  };
  const rollbackBody = {
    run: {
      runId: 'roller01',
      name: 'graph-demo',
      status: rollbackVm.status,
      exportDataComplete: rollbackVm.exportDataComplete,
      startedAt: rollbackVm.startedAt,
      finishedAt: rollbackVm.finishedAt,
      import: importMeta,
    },
    viewModel: rollbackVm,
  };

  async function renderRollbackPage() {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => rollbackBody,
    })));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          Suspense,
          { fallback: null },
          createElement(RunDetailPage, { params: Promise.resolve({ runId: 'roller01' }) }),
        ),
      );
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
  }

  function clickSubgraphChip(index: number) {
    // 主图上带「子图 ▸」入口的生成器节点（gen-sub g0/g1/g2 三个实例）
    const hosts = Array.from(document.querySelectorAll('.run-node')).filter(g =>
      g.textContent?.includes('子图 ▸'),
    );
    expect(hosts.length, '主图应有 3 个 gen-sub 生成器节点').toBe(3);
    const chip = hosts[index].querySelector('g');
    expect(chip, '节点内应有子图入口').toBeTruthy();
    chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('点击「子图 ▸」打开弹窗：锁定入口代子图，点击子图节点可下钻会话', async () => {
    await renderRollbackPage();
    expect(document.querySelectorAll('[role="tab"]').length).toBe(0);

    // g1 入口（gen-sub 第 1 代 = 回滚 #1）→ 弹窗只展示该代子图
    await act(async () => { clickSubgraphChip(1); });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    // 主图画布仍在，弹窗画布为子图节点
    expect(document.querySelectorAll('.run-canvas').length).toBe(2);
    expect((dialog!.textContent ?? '')).toContain('gen-sub');
    expect((dialog!.textContent ?? '')).toContain('回滚 #1');
    // 无代际 tab——弹窗锁定入口节点所在代，不混入其他代
    expect(dialog!.querySelectorAll('[role="tab"]').length).toBe(0);
    // 宽度覆盖回归锁：DialogContent 默认 sm:max-w-sm（384px 上限）必须被显式替换，
    // 否则桌面端弹窗被压回 384px，340px 侧栏挤掉画布 → 空白弹窗
    // （[role="dialog"] 即 DialogPrimitive.Popup，与 data-slot="dialog-content" 同元素）
    const contentClass = dialog!.getAttribute('class') ?? '';
    expect(contentClass).not.toContain('sm:max-w-sm');
    expect(contentClass).toContain('sm:max-w-[min(1180px,94vw)]');
    // 该代子图 5 节点全部通过：sub-flaky 描边为通过色（g0 为失败红）
    const flaky = Array.from(dialog!.querySelectorAll('.run-node')).find(n =>
      n.textContent?.includes('sub-flaky'),
    );
    expect(flaky?.querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#1a7f37');

    // 点击子图节点 → 弹窗侧栏运行历史 + 成员会话链接（sub-agent-a 执行成员为 session）
    await act(async () => {
      Array.from(dialog!.querySelectorAll('.run-node'))
        .find(n => n.textContent?.includes('sub-agen'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect((dialog!.textContent ?? '')).toContain('第 1 次');
    // 验收类型并入标头（脚本 · 通过），时间行不再为「—」（会话行起止兜底）
    expect((dialog!.textContent ?? '')).toContain('脚本 · 通过');
    expect((dialog!.textContent ?? '')).not.toContain('—');
    const sessionLink = dialog!.querySelector('a[href^="/session/"]');
    expect(sessionLink, '子图节点会话入口').toBeTruthy();
    // 角色词精简（执行/验收）+ 短 id 展示（完整 id 在 title/href 保留全量）
    expect(sessionLink!.textContent).toContain('执行：S5082A31602EE1');
    expect(sessionLink!.getAttribute('href')).toContain('S5082A31602EE15ED');
    expect(sessionLink!.getAttribute('title')).toBe('S5082A31602EE15ED');
    // 成员行美化：链接 + 右侧用量胶囊（完整数值悬浮）；尝试卡片带耗时徽标
    const memberRow = sessionLink!.parentElement!;
    expect(memberRow.textContent).toContain('3 turns · 1.2k');
    expect(memberRow.querySelector('span[title]')?.getAttribute('title')).toBe('3 turns · 1234 tokens');
    expect((dialog!.textContent ?? '')).toContain('5.0s');

    // 关闭弹窗回到主图：弹窗卸载，主图画布保留
    await act(async () => {
      dialog!.querySelector('[data-slot="dialog-close"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelectorAll('.run-canvas').length).toBe(1);
    // 主图画布节点仍是主图集合（含 gen-sub 生成器，不含子图成员）
    const mainNodes = document.querySelectorAll('.run-canvas .run-node');
    expect(Array.from(mainNodes).some(n => n.textContent?.includes('sub-init'))).toBe(false);
  });

  it('g0 入口展示「第 1 次运行」代子图：sub-flaky 失败红描边，与回滚代区分', async () => {
    await renderRollbackPage();

    await act(async () => { clickSubgraphChip(0); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect((dialog.textContent ?? '')).toContain('第 1 次运行');
    const flaky = Array.from(dialog.querySelectorAll('.run-node')).find(n =>
      n.textContent?.includes('sub-flaky'),
    );
    expect(flaky?.querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#cf222e');

    // 未选中子图节点时，侧栏为提示文案（无运行历史、无会话链接）
    expect(dialog.querySelectorAll('a[href^="/session/"]').length).toBe(0);
    expect((dialog.textContent ?? '')).toContain('点击子图节点查看运行历史');
  });

  it('长验收报告折叠展示：默认 2 行预览 + 字数徽标，展开为可滚动代码块', async () => {
    await renderRollbackPage();

    await act(async () => { clickSubgraphChip(1); });
    const dialog = document.querySelector('[role="dialog"]')!;
    await act(async () => {
      Array.from(dialog.querySelectorAll('.run-node'))
        .find(n => n.textContent?.includes('sub-flaky'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 尝试标头：验收类型 + 状态（Agent · 失败，不再在验收行重复），长报告默认收起
    expect((dialog.textContent ?? '')).toContain('Agent · 失败');
    expect((dialog.textContent ?? '')).toContain('验收报告');
    const toggle = dialog.querySelector('button[aria-expanded="false"]');
    expect(toggle).toBeTruthy();
    expect(dialog.querySelector('.line-clamp-2')).toBeTruthy();

    // 展开 → 滚动代码块（无行数截断），可再收起
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dialog.querySelector('button[aria-expanded="true"]')).toBeTruthy();
    expect(dialog.querySelector('.line-clamp-2')).toBeNull();
    await act(async () => {
      dialog.querySelector('button[aria-expanded="true"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dialog.querySelector('.line-clamp-2')).toBeTruthy();
  });
});

describe('RunGraph 走线几何（PCB 交叉跳线 + 选中点亮）', () => {
  const mkNode = (key: string, nodeId: string, status: NodeInstance['status']): NodeInstance => ({
    key,
    nodeId,
    generation: 0,
    label: nodeId,
    taskType: 'bash',
    status,
    executionState: 'executed',
    carriedFromGeneration: null,
    attempts: [],
    pendingMembers: [],
    retryPolicy: null,
    runOnFailure: null,
    predecessorKeys: [],
    parentKey: null,
    hasSubgraph: false,
  })

  // 确定性交叉拓扑：a→c 的水平段（行间隙 y=84，x 84→684）先后被回滚边竖段
  // （x=234）与 b→d 竖段（x=384）穿过——水平段做 PCB 半圆跳线，垂直段直行
  const nodesByKey = new Map([
    ['n-a-g0', mkNode('n-a-g0', 'a', 'passed')],
    ['n-b-g0', mkNode('n-b-g0', 'b', 'passed')],
    ['n-c-g0', mkNode('n-c-g0', 'c', 'failed')],
    ['n-d-g0', mkNode('n-d-g0', 'd', 'passed')],
  ])
  const view: RunView = {
    id: 'main',
    title: '几何测试',
    parentKey: null,
    nodeKeys: [...nodesByKey.keys()],
    ranks: { 'n-a-g0': 0, 'n-b-g0': 0, 'n-c-g0': 1, 'n-d-g0': 1 },
    edges: [
      { from: 'n-a-g0', to: 'n-c-g0' },
      { from: 'n-b-g0', to: 'n-d-g0' },
    ],
    edgeChains: [
      { from: 'n-a-g0', to: 'n-c-g0', bends: [] },
      { from: 'n-b-g0', to: 'n-d-g0', bends: [] },
    ],
    rollbackLinks: [{ from: 'n-a-g0', to: 'n-d-g0', label: '回滚 #1', ordinal: 1 }],
    layout: {
      width: 800,
      height: 300,
      bands: [],
      positions: {
        'n-a-g0': { x: 0, y: 0 },
        'n-b-g0': { x: 300, y: 0 },
        'n-c-g0': { x: 600, y: 120 },
        'n-d-g0': { x: 300, y: 240 },
      },
    },
  }

  function renderGraph(selectedKey: string | null) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const r = createRoot(container)
    act(() => {
      r.render(
        createElement(RunGraph, {
          view,
          nodesByKey,
          selectedKey,
          onSelectNode: () => {},
          onOpenSubgraph: () => {},
        }),
      )
    })
    return { container, r }
  }

  it('交叉处 PCB 半圆跳线（水平段跳过垂直段，2 处），无贝塞尔，默认静止', () => {
    const { container, r } = renderGraph(null)
    const ds = [...container.querySelectorAll('path.run-dep')].map(p => p.getAttribute('d') ?? '')
    expect(ds).toHaveLength(2)
    const hopCount = ds.reduce((acc, d) => acc + (d.match(/A 4\.5 4\.5 0 0 1 /g)?.length ?? 0), 0)
    expect(hopCount).toBe(2)
    for (const d of ds) expect(d).not.toContain('C ')
    expect(container.querySelectorAll('.run-edge-flow').length).toBe(0)
    expect(container.querySelectorAll('.run-rb-flow').length).toBe(0)
    act(() => r.unmount())
  })

  it('选中 a：关联边（a→c + 回滚 a→d）点亮流动，b→d 压暗静止', () => {
    const { container, r } = renderGraph('n-a-g0')
    const groups = [...container.querySelectorAll('g.run-edge')]
    expect(groups).toHaveLength(2)
    expect(groups[0].getAttribute('opacity')).toBe('1')
    expect(groups[1].getAttribute('opacity')).toBe('0.35')
    const depPaths = [...container.querySelectorAll('path.run-dep')]
    expect(depPaths[0].getAttribute('stroke')).toBe(statusColor('failed')) // 目标 c=failed
    expect(depPaths[0].getAttribute('stroke-width')).toBe('2')
    expect(depPaths[1].getAttribute('stroke')).toBe(RUN_COLORS.edge)
    const flows = container.querySelectorAll('.run-edge-flow')
    expect(flows).toHaveLength(1)
    expect(flows[0].getAttribute('stroke')).toBe(RUN_COLORS.canvas)
    expect(container.querySelectorAll('.run-rb-flow')).toHaveLength(1)
    act(() => r.unmount())
  })

  it('选中 b：b→d 点亮，a→c 与回滚边压暗静止', () => {
    const { container, r } = renderGraph('n-b-g0')
    const groups = [...container.querySelectorAll('g.run-edge')]
    expect(groups[0].getAttribute('opacity')).toBe('0.35')
    expect(groups[1].getAttribute('opacity')).toBe('1')
    expect(container.querySelectorAll('.run-edge-flow')).toHaveLength(1)
    expect(container.querySelectorAll('.run-rb-flow')).toHaveLength(0)
    expect(container.querySelector('g.run-rb')?.getAttribute('opacity')).toBe('0.35')
    act(() => r.unmount())
  })
})
