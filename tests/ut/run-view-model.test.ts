// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 域 view-model IT：多代 DAG 展示模型（分组/尝试历史/carried/空占位/回滚/
// 子图视图/代带布局）——交互原型 graph-demo-export-preview.html 的回归锁。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel, findNodeInstance, nodeKeyOf, NODE_W, NODE_H } from '@/lib/run/view-model';

const FIXTURE = path.resolve(__dirname, './data/run/graph-demo-rollback-manifest.json');
function parseAndIndexFixture() {
  return parseAndIndex(JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')));
}
const vm = buildViewModel(parseAndIndexFixture());

describe('view-model：节点实例（(nodeId, generation) 聚簇）', () => {
  it('40 实例 / 16 逻辑节点 / 3 代', () => {
    expect(vm.nodes).toHaveLength(40);
    expect(new Set(vm.nodes.map(n => n.nodeId)).size).toBe(16);
    expect(vm.generations).toEqual([0, 1, 2]);
  });

  it('flaky-step g0：3 次尝试（2 次重试），终态 passed，verify 逐次配对', () => {
    const node = findNodeInstance(vm, 'flaky-step', 0)!;
    expect(node).not.toBeNull();
    expect(node.attempts.map(a => a.ordinal)).toEqual([1, 2, 3]);
    expect(node.attempts.map(a => a.status)).toEqual(['failed', 'failed', 'passed']);
    expect(node.status).toBe('passed');
    // 每次尝试的 verify 成员与 attempt 对齐（脚本验收：failed/failed/passed）
    expect(node.attempts.map(a => a.verification.status)).toEqual(['failed', 'failed', 'passed']);
    expect(node.taskType).toBe('bash');
  });

  it('carried 语义：gen-sub 第 1 代沿用第 0 代结果', () => {
    const node = findNodeInstance(vm, 'gen-sub', 1)!;
    expect(node.status).toBe('carried');
    expect(node.executionState).toBe('carried');
    expect(node.carriedFromGeneration).toBe(0);
    expect(node.attempts).toHaveLength(0);
    expect(node.pendingMembers).toHaveLength(0); // carried ≠ 空占位
  });

  it('空占位语义：final-report 三代均为 attempt=0 待执行', () => {
    for (const gen of [0, 1, 2]) {
      const node = findNodeInstance(vm, 'final-report', gen)!;
      expect(node).not.toBeNull();
      expect(node.status).toBe('pending');
      expect(node.executionState).toBe('not_run');
      expect(node.pendingMembers).toHaveLength(1);
      expect(node.pendingMembers[0].sessionId).toBeNull();
      expect(node.pendingMembers[0].kind).toBe('process');
    }
    // runOnFailure 透传（final-report g0 成员声明）
    expect(findNodeInstance(vm, 'final-report', 0)!.runOnFailure).toBe(true);
  });

  it('taskType：agent 节点（step-a）与 generator（gen-sub）', () => {
    expect(findNodeInstance(vm, 'step-a', 0)!.taskType).toBe('agent');
    expect(findNodeInstance(vm, 'gen-sub', 0)!.taskType).toBe('generator');
    // agent 成员的执行会话引用携带 sessionId/location
    const build = findNodeInstance(vm, 'step-a', 0)!;
    expect(build.attempts[0].executeMember.sessionId).toBe('S2BB26D62E3566801');
    expect(build.attempts[0].executeMember.location).toBe('sessions/S2BB26D62E3566801.native');
  });

  it('重试策略透传：bad-node 首执行成员的 retryPolicy', () => {
    const node = findNodeInstance(vm, 'bad-node', 0)!;
    expect(node.retryPolicy).toMatchObject({ onExhaust: 'rollback', rollbackToNodeId: 'step-a' });
  });
});

describe('view-model：回滚记录', () => {
  it('2 条回滚：sub-flaky g0 → sub-init g1；bad-node g1 → step-a g2', () => {
    expect(vm.rollbacks).toHaveLength(2);
    const [r1, r2] = vm.rollbacks;
    expect(r1.from).toMatchObject({ nodeId: 'gen-sub:sub-flaky', generation: 0 });
    expect(r1.to).toMatchObject({ nodeId: 'gen-sub:sub-init', generation: 1, attempt: 1 });
    expect(r2.from).toMatchObject({ nodeId: 'bad-node', generation: 1 });
    expect(r2.to).toMatchObject({ nodeId: 'step-a', generation: 2 });
    // trigger/target 键指向节点实例
    expect(r2.triggerKey).toBe(nodeKeyOf('bad-node', 1));
    expect(r2.targetKey).toBe(nodeKeyOf('step-a', 2));
  });
});

describe('view-model：视图（主图 + 子图）', () => {
  it('4 个视图：主图 + gen-sub 三代各一个子图视图', () => {
    expect(vm.views).toHaveLength(4);
    expect(vm.views[0].id).toBe('main');
    expect(vm.views[0].parentKey).toBeNull();
    const subKeys = vm.views.slice(1).map(v => v.parentKey);
    expect(subKeys).toEqual([
      nodeKeyOf('gen-sub', 0),
      nodeKeyOf('gen-sub', 1),
      nodeKeyOf('gen-sub', 2),
    ]);
  });

  it('主图 25 实例（40 - 15 子图实例），子图节点 parentKey 指向生成器', () => {
    expect(vm.views[0].nodeKeys).toHaveLength(25);
    const subInit = findNodeInstance(vm, 'gen-sub:sub-init', 0)!;
    expect(subInit.parentKey).toBe(nodeKeyOf('gen-sub', 0));
  });

  it('gen-sub-graph 双形态兼容：annotation.type= 与 kind= 等价（真实导出件用 type）', () => {
    const mutated = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as {
      data: { relations: Array<{ annotation?: { kind?: string; type?: string } }> };
    };
    // 把 fixture 的 kind= 形态全部改写成真实导出件的 type= 形态
    for (const r of mutated.data.relations) {
      if (r.annotation?.kind === 'gen-sub-graph') {
        r.annotation.type = 'gen-sub-graph';
        delete r.annotation.kind;
      }
    }
    const vm2 = buildViewModel(parseAndIndex(mutated));
    expect(vm2.views.map(v => v.id)).toEqual(vm.views.map(v => v.id));
    expect(vm2.views[0].nodeKeys).toHaveLength(25);
  });

  it('代带布局：3 条带（第 1 次运行/回滚 #1/回滚 #2），同 nodeId 跨代行对齐', () => {
    const main = vm.views[0];
    expect(main.layout.bands.map(b => b.label)).toEqual(['第 1 次运行', '回滚 #1', '回滚 #2']);
    const g0 = main.layout.positions[nodeKeyOf('step-a', 0)]!;
    const g2 = main.layout.positions[nodeKeyOf('step-a', 2)]!;
    expect(g0.y).toBe(g2.y); // 同逻辑节点跨代共享 rank（行对齐）
    expect(g2.x).toBeGreaterThan(g0.x + NODE_W); // 后代带在右侧
    // init（无前置）rank 0
    expect(main.ranks[nodeKeyOf('init', 0)]).toBe(0);
    expect(main.ranks[nodeKeyOf('step-a', 0)]).toBe(1);
  });

  it('同 rank 同代节点横向栈位互不重叠（栈序生效）', () => {
    const main = vm.views[0];
    const byRow = new Map<number, Set<number>>();
    for (const n of main.nodeKeys) {
      const p = main.layout.positions[n]!;
      const row = p.y;
      if (!byRow.has(row)) byRow.set(row, new Set());
      byRow.get(row)!.add(p.x);
    }
    // 每行的 x 集合大小 = 该行节点数（无重叠 x）
    for (const [row, xs] of byRow) {
      const count = main.nodeKeys.filter(k => main.layout.positions[k]!.y === row).length;
      expect(xs.size, `y=${row} 行节点应互不重叠`).toBe(count);
    }
  });

  it('同代依赖边才进 edges：跨代依赖（init g0 → step-a g2）不画线', () => {
    const main = vm.views[0];
    const crossGen = main.edges.filter(
      e => vm.nodes.find(n => n.key === e.from)!.generation !== vm.nodes.find(n => n.key === e.to)!.generation,
    );
    expect(crossGen).toHaveLength(0);
    // 主图回滚连线 2 条（红虚线数据源）
    expect(main.rollbackLinks).toHaveLength(2);
    expect(main.rollbackLinks.map(l => l.label)).toEqual(['回滚 #1', '回滚 #2']);
  });

  it('子图容器作依赖源：depends_on 从子图 workflow 成员出发归约到生成器实例（d01dfbaa 形态）', () => {
    // fixture 尾部含真实导出件形态的边：MAC41B7669DBB2BD6（gen-sub 生成的子图
    // 容器，无 graph 注解）→ final-report g0 执行成员。修复前该边被静默丢弃，
    // final-report 误为根节点；修复后归约到生成器 gen-sub 各代实例。
    const report = findNodeInstance(vm, 'final-report', 0)!;
    expect(report.predecessorKeys).toContain(nodeKeyOf('gen-sub', 0));
    const main = vm.views[0];
    // 主图只画同代边 gen-sub@0 → final-report@0；跨代归约边不画线
    expect(main.edges).toContainEqual({ from: nodeKeyOf('gen-sub', 0), to: nodeKeyOf('final-report', 0) });
    expect(main.edges).not.toContainEqual({ from: nodeKeyOf('gen-sub', 1), to: nodeKeyOf('final-report', 0) });
    // rank 归约：final-report 排到生成器之后，不再是根
    expect(main.ranks[nodeKeyOf('final-report', 0)]).toBeGreaterThan(main.ranks[nodeKeyOf('gen-sub', 0)]);
  });

  it('子图容器依赖源的归约与关系声明顺序无关：depends_on 先于 gen-sub-graph 不误告警', () => {
    // reader 原样保留 manifest 里 data.relations 声明顺序。真实导出件里「子图容器
    // 依赖边」可能声明在其 gen-sub-graph 之前——若 droppedDeps 计数与 subgraphGeneratorsOf
    // 建表同轮进行，先到 depends_on 时反转表尚未建全，会把本可归约的边误计入告警。
    const mutated = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as {
      data: { relations: Array<{ from: string; to: string; annotation?: { kind?: string; type?: string } }> };
    };
    const rels = mutated.data.relations;
    const depIdx = rels.findIndex(r => r.from === 'MAC41B7669DBB2BD6' && r.annotation?.type === 'depends_on');
    expect(depIdx).toBeGreaterThanOrEqual(0);
    const [dep] = rels.splice(depIdx, 1);
    const firstGenIdx = rels.findIndex(r => r.annotation?.kind === 'gen-sub-graph' || r.annotation?.type === 'gen-sub-graph');
    rels.splice(firstGenIdx, 0, dep);

    const vm2 = buildViewModel(parseAndIndex(mutated));
    // 修复前：误报「1 条 depends_on 关系的端点无 graph 注解，未进入图视图」
    expect(vm2.warnings.filter(w => w.includes('端点无 graph 注解'))).toEqual([]);
    // 边仍正确归约到生成器实例（顺序无关，与未重排的 vm 一致）
    const report = findNodeInstance(vm2, 'final-report', 0)!;
    expect(report.predecessorKeys).toContain(nodeKeyOf('gen-sub', 0));
    expect(vm2.warnings).toEqual(vm.warnings);
  });
});

describe('view-model：拐弯最小化（非必要不拐弯）', () => {
  type View = (typeof vm.views)[number];
  const COMB = path.resolve(__dirname, './data/run/graph-bend-comb-manifest.json');
  const BRAID = path.resolve(__dirname, './data/run/graph-bend-braid-manifest.json');
  const loadMain = (file: string) => {
    const m = buildViewModel(parseAndIndex(JSON.parse(fs.readFileSync(file, 'utf-8'))));
    return { m, view: m.views[0] };
  };
  // 渲染层 vChainPoints 的同构折线：源底 → 虚拟点 → 目标顶（x 变化处隙中点水平过渡）
  const chainPts = (view: View, c: View['edgeChains'][number]) => [
    { x: view.layout.positions[c.from]!.x + NODE_W / 2, y: view.layout.positions[c.from]!.y + NODE_H },
    ...c.bends,
    { x: view.layout.positions[c.to]!.x + NODE_W / 2, y: view.layout.positions[c.to]!.y },
  ];
  const transitionsOf = (pts: Array<{ x: number }>) =>
    pts.slice(0, -1).filter((p, i) => p.x !== pts[i + 1].x).length;
  // 正交段（垂直下探 + 隙中点水平）与节点矩形（±2 容差，排除边端点）的相交数
  const piercingsOf = (view: View, c: View['edgeChains'][number]): number => {
    const pts = chainPts(view, c);
    const nodes = view.nodeKeys.map(k => ({ key: k, ...view.layout.positions[k]! }));
    let hits = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const midY = (p.y + q.y) / 2;
      const segs = p.x === q.x
        ? [{ x1: p.x, x2: q.x, y1: p.y, y2: q.y }]
        : [
            { x1: p.x, x2: p.x, y1: p.y, y2: midY },
            { x1: p.x, x2: q.x, y1: midY, y2: midY },
            { x1: q.x, x2: q.x, y1: midY, y2: q.y },
          ];
      for (const s of segs) {
        for (const n of nodes) {
          if (n.key === c.from || n.key === c.to) continue;
          if (Math.max(s.x1, s.x2) > n.x + 2 && Math.min(s.x1, s.x2) < n.x + NODE_W - 2
            && Math.max(s.y1, s.y2) > n.y + 2 && Math.min(s.y1, s.y2) < n.y + NODE_H - 2) hits++;
        }
      }
    }
    return hits;
  };
  const chainOf = (m: typeof vm, view: View, fromId: string, toId: string) => {
    const keyOf = (id: string) => m.nodes.find(n => n.nodeId === id && n.generation === 0)!.key;
    return view.edgeChains.find(c => c.from === keyOf(fromId) && c.to === keyOf(toId))!;
  };

  it('comb 拓扑：所有边 ≤2 次水平过渡且零穿框；扇入主干虚拟点全落目标列', () => {
    const { m, view } = loadMain(COMB);
    for (const c of view.edgeChains) {
      expect(transitionsOf(chainPts(view, c)), `${c.from}→${c.to}`).toBeLessThanOrEqual(2);
      expect(piercingsOf(view, c), `${c.from}→${c.to} 不穿节点`).toBe(0);
    }
    // 稠密列分配（P2 留白压缩）后的拐弯分布：b1→c4 的两条直落列（b1 列/
    // c4 列）均被 row1-2 的 b2/b3、c2/c3 挡住——1 次过渡几何上不可行，走
    // 廊绕行 2 次为最优；代价换来 c3→c4 同列 0 过渡直落与整体宽度收缩
    // （总拐弯数与旧稀疏布局持平）
    expect(transitionsOf(chainPts(view, chainOf(m, view, 'b1', 'c4'))), 'b1→c4 走廊绕行').toBe(2);
    expect(transitionsOf(chainPts(view, chainOf(m, view, 'c3', 'c4'))), 'c3→c4 同列直落').toBe(0);
    // a1→b4 / c1→b4 扇入组：共享主干单列下行（走廊或目标列），≤2 次过渡汇入
    // （P2 稠密列：b4 紧贴 c1 列右侧，主干落列间走廊——合并语义保持，整体
    // 宽度较旧布局收缩 28%）
    for (const [f, t] of [['a1', 'b4'], ['c1', 'b4']] as const) {
      const c = chainOf(m, view, f, t);
      const trunkX = c.bends[0]?.x;
      expect(c.bends.length, `${f}→${t} 有主干`).toBeGreaterThan(0);
      expect(c.bends.every(p => p.x === trunkX), `${f}→${t} 主干单列合并`).toBe(true);
      expect(transitionsOf(chainPts(view, c)), `${f}→${t} 汇入过渡`).toBeLessThanOrEqual(2);
    }
  });

  it('braid 拓扑：所有边 ≤2 次水平过渡且零穿框（旧槽位阶梯为 3-4 次）', () => {
    const { m, view } = loadMain(BRAID);
    for (const c of view.edgeChains) {
      expect(transitionsOf(chainPts(view, c)), `${c.from}→${c.to}`).toBeLessThanOrEqual(2);
      expect(piercingsOf(view, c), `${c.from}→${c.to} 不穿节点`).toBe(0);
    }
    // 稠密列分配（P2 留白压缩）后的拐弯分布：a2→e4 的两条直落列（a2 列/
    // e4 列）均被 row2 的 a3/e3 挡住——1 次过渡几何上不可行，走廊绕行 2 次
    // 为最优；代价换来 e3→e4 同列 0 过渡直落与整体宽度收缩。b1→d5 列被
    // 挡，与下组一样走廊绕行 2 次
    expect(transitionsOf(chainPts(view, chainOf(m, view, 'a2', 'e4'))), 'a2→e4 走廊绕行').toBe(2);
    expect(transitionsOf(chainPts(view, chainOf(m, view, 'e3', 'e4'))), 'e3→e4 同列直落').toBe(0);
    expect(transitionsOf(chainPts(view, chainOf(m, view, 'b1', 'd5'))), 'b1→d5 走廊绕行').toBe(2);
    // 两端列均被挡的长边/组绕行自由走廊：恰好 2 次水平过渡（d1→b5 主干
    // 落走廊列，同此）
    for (const [f, t] of [['e1', 'a5'], ['d1', 'b5'], ['c1', 'c4']] as const) {
      expect(transitionsOf(chainPts(view, chainOf(m, view, f, t))), `${f}→${t} 走廊绕行`).toBe(2);
    }
  });

  it('回滚 fixture 主图：所有边 ≤1 次水平过渡且零穿框（真实形态回归锁）', () => {
    const view = vm.views[0];
    for (const c of view.edgeChains) {
      expect(transitionsOf(chainPts(view, c)), `${c.from}→${c.to}`).toBeLessThanOrEqual(1);
      expect(piercingsOf(view, c), `${c.from}→${c.to} 不穿节点`).toBe(0);
    }
  });
});

describe('view-model：右行下单调走线（依赖边水平段只向右）', () => {
  // 修复回归锁：中位数栈序不保证目标在源右侧——修复前连 mini-bundle 唯一
  // 一条边 init→build 都向左走，braid 半数边向左。7b′ 槽位传播 + 走廊/主干
  // 右行偏好后，所有视图的所有边链 x 单调不减（直行或右行）、y 单调不减
  const FILES = [
    'graph-demo-rollback-manifest.json',
    'graph-bend-comb-manifest.json',
    'graph-bend-braid-manifest.json',
    'mini-bundle/workflow.json',
  ];
  type View = (typeof vm.views)[number];
  const chainPts = (view: View, c: View['edgeChains'][number]) => [
    { x: view.layout.positions[c.from]!.x + NODE_W / 2, y: view.layout.positions[c.from]!.y + NODE_H },
    ...c.bends,
    { x: view.layout.positions[c.to]!.x + NODE_W / 2, y: view.layout.positions[c.to]!.y },
  ];

  it.each(FILES)('%s：全部视图全部边链右行/下行（x、y 单调不减）', file => {
    const m = buildViewModel(parseAndIndex(JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run', file), 'utf-8'))));
    expect(m.views.length).toBeGreaterThan(0);
    let checked = 0;
    for (const view of m.views) {
      for (const c of view.edgeChains) {
        const pts = chainPts(view, c);
        for (let i = 0; i < pts.length - 1; i++) {
          expect(pts[i + 1].x, `${file} ${view.id} ${c.from}→${c.to} 第 ${i} 段向左`).toBeGreaterThanOrEqual(pts[i].x);
          expect(pts[i + 1].y, `${file} ${view.id} ${c.from}→${c.to} 第 ${i} 段向上`).toBeGreaterThanOrEqual(pts[i].y);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('view-model：run 级汇总', () => {
  it('状态汇总：存在 failed 节点（always-fail 未执行但 bad-node 曾失败）', () => {
    // bad-node g1 终态 failed → run 汇总 failed
    expect(vm.status).toBe('failed');
    expect(vm.exportDataComplete).toBe(true);
    expect(vm.name).toBe('graph-demo');
  });
});

describe('view-model：端口分布（P2 布线简洁）', () => {
  const COMB = path.resolve(__dirname, './data/run/graph-bend-comb-manifest.json');
  const BRAID = path.resolve(__dirname, './data/run/graph-bend-braid-manifest.json');
  const loadMain = (file: string) => {
    const m = buildViewModel(parseAndIndex(JSON.parse(fs.readFileSync(file, 'utf-8'))));
    return { m, view: m.views[0] };
  };

  it('braid：扇出 ≥3（e1/b1/c1）出边 fromDx 互异且 ≤72；扇入 ≥3（b5/e5）入边 toDx 互异', () => {
    const { m, view } = loadMain(BRAID);
    const keyOf = (id: string) => m.nodes.find(n => n.nodeId === id && n.generation === 0)!.key;
    for (const id of ['e1', 'b1', 'c1']) {
      const dxs = view.edgeChains.filter(c => c.from === keyOf(id)).map(c => c.fromDx);
      expect(dxs.length, `${id} 扇出`).toBeGreaterThanOrEqual(3);
      expect(new Set(dxs).size, `${id} 端口互异`).toBe(dxs.length);
      for (const dx of dxs) expect(Math.abs(dx!), `${id} |dx| ≤ 72`).toBeLessThanOrEqual(72);
    }
    for (const id of ['b5', 'e5']) {
      const dxs = view.edgeChains.filter(c => c.to === keyOf(id)).map(c => c.toDx);
      expect(dxs.length, `${id} 扇入`).toBeGreaterThanOrEqual(3);
      expect(new Set(dxs).size, `${id} 端口互异`).toBe(dxs.length);
    }
  });

  it('端口序按对端列单调（端口处不扭线）：fromDx 随目标列 x 单调不减', () => {
    const { m, view } = loadMain(BRAID);
    const e1 = m.nodes.find(n => n.nodeId === 'e1' && n.generation === 0)!.key;
    const outs = view.edgeChains
      .filter(c => c.from === e1)
      .sort((a, b) => view.layout.positions[a.to]!.x - view.layout.positions[b.to]!.x);
    expect(outs.length).toBe(3);
    for (let i = 0; i < outs.length - 1; i++) {
      expect(outs[i + 1].fromDx!, '对端更靠右的端口不更靠左').toBeGreaterThanOrEqual(outs[i].fromDx!);
    }
  });

  it('锚点仍在节点缘内（内收 12）：x+12 ≤ 中心+dx ≤ x+NODE_W-12', () => {
    const { view } = loadMain(BRAID);
    for (const c of view.edgeChains) {
      if (c.fromDx !== undefined) {
        const a = view.layout.positions[c.from]!;
        expect(a.x + NODE_W / 2 + c.fromDx).toBeGreaterThanOrEqual(a.x + 12);
        expect(a.x + NODE_W / 2 + c.fromDx).toBeLessThanOrEqual(a.x + NODE_W - 12);
      }
      if (c.toDx !== undefined) {
        const b = view.layout.positions[c.to]!;
        expect(b.x + NODE_W / 2 + c.toDx).toBeGreaterThanOrEqual(b.x + 12);
        expect(b.x + NODE_W / 2 + c.toDx).toBeLessThanOrEqual(b.x + NODE_W - 12);
      }
    }
  });

  it('扇出/扇入 <3 不设端口（低扇出叠线交给渲染层错开）：comb 仅 b4 三条入边带 toDx', () => {
    const { m, view } = loadMain(COMB);
    const withDx = view.edgeChains.filter(c => c.fromDx !== undefined || c.toDx !== undefined);
    expect(withDx.length).toBe(3);
    expect(withDx.every(c => c.toDx !== undefined && c.fromDx === undefined)).toBe(true);
    const b4 = m.nodes.find(n => n.nodeId === 'b4' && n.generation === 0)!.key;
    expect(withDx.every(c => c.to === b4)).toBe(true);
  });
});

describe('view-model：留白压缩（P2 真实节点稠密列）', () => {
  const COMB = path.resolve(__dirname, './data/run/graph-bend-comb-manifest.json');
  const BRAID = path.resolve(__dirname, './data/run/graph-bend-braid-manifest.json');
  const ROLLBACK = path.resolve(__dirname, './data/run/graph-demo-rollback-manifest.json');
  const loadMain = (file: string) => {
    const m = buildViewModel(parseAndIndex(JSON.parse(fs.readFileSync(file, 'utf-8'))));
    return { m, view: m.views[0] };
  };
  // 旧槽位布局（虚拟点占槽把真实列推散）的主图宽度基线：虚拟点密集的拓扑
  // （braid/comb）收缩显著；rollback 原布局已近稠密，收益被预留列抵平 → 不劣化锁
  const OLD_WIDTH: Record<string, number> = {
    [BRAID]: 2596,
    [COMB]: 1502,
    [ROLLBACK]: 1826,
  };

  it.each([[BRAID], [COMB]])('主图宽度较旧布局收缩 ≥10%（列序装箱）', file => {
    const { view } = loadMain(file);
    expect(view.layout.width, `${file} 宽度`).toBeLessThanOrEqual(OLD_WIDTH[file] * 0.9);
  });

  it('rollback 主图宽度不劣于旧布局（原已近稠密，收益与预留列相抵）', () => {
    const { view } = loadMain(ROLLBACK);
    expect(view.layout.width).toBeLessThanOrEqual(OLD_WIDTH[ROLLBACK]);
  });

  it('braid 25 节点 5 列拓扑：宽度 ≤ 7 列 + 走廊余量（旧槽位 ~10 列，收缩 ≥30%）', () => {
    const { view } = loadMain(BRAID);
    // 5 列网格 + 右行/预留带来的 2 列级联余量：18（原点）+ 7×212 + 32（带
    // 内边距）+ 20（右缘）+ 缓冲
    expect(view.layout.width).toBeLessThanOrEqual(2596 * 0.7);
  });

  it('同带相邻真实列距 ≥ COL_STEP（列节奏不被压缩）', () => {
    const { m, view } = loadMain(ROLLBACK);
    for (const band of view.layout.bands) {
      const xs = [...new Set(
        view.nodeKeys
          .filter(k => m.nodes.find(n => n.key === k)!.generation === band.generation)
          .map(k => view.layout.positions[k]!.x),
      )].sort((a, b) => a - b);
      for (let i = 0; i < xs.length - 1; i++) {
        expect(xs[i + 1] - xs[i], `带 g${band.generation} 列距 ≥ 212`).toBeGreaterThanOrEqual(212);
      }
    }
  });

  it('跨带相邻节点缘间距 ≥ 96（回滚曲线区保持）', () => {
    const { m, view } = loadMain(ROLLBACK);
    for (let i = 0; i < view.layout.bands.length - 1; i++) {
      const g1 = view.layout.bands[i].generation;
      const g2 = view.layout.bands[i + 1].generation;
      const rightMost = Math.max(...view.nodeKeys
        .filter(k => m.nodes.find(n => n.key === k)!.generation === g1)
        .map(k => view.layout.positions[k]!.x + NODE_W));
      const leftMost = Math.min(...view.nodeKeys
        .filter(k => m.nodes.find(n => n.key === k)!.generation === g2)
        .map(k => view.layout.positions[k]!.x));
      expect(leftMost - rightMost, `g${g1}→g${g2} 带隙`).toBeGreaterThanOrEqual(96);
    }
  });
});

describe('view-model：无 graph 注解容错（导出侧未启用 graph 插件）', () => {
  /** 递归剥掉全树成员的 annotation（模拟不带 graph 插件的导出包），关系保留 */
  function stripAnnotations(node: { members?: Array<Record<string, unknown>> }): void {
    for (const m of node.members ?? []) {
      delete m.annotation;
      if (m.data) stripAnnotations(m.data as { members?: Array<Record<string, unknown>> });
    }
  }

  it('成员全无 annotation.graph → 主图空视图 + 白话警告（不静默）', () => {
    const manifest = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as Record<string, unknown>;
    stripAnnotations(manifest.data as { members?: Array<Record<string, unknown>> });
    const vm2 = buildViewModel(parseAndIndex(manifest));
    expect(vm2.nodes).toHaveLength(0);
    expect(vm2.views[0].nodeKeys).toHaveLength(0);
    expect(vm2.warnings.some(w => w.includes('未包含 graph 注解数据'))).toBe(true);
    expect(vm2.warnings.some(w => w.includes('成员会话信息仍可查看'))).toBe(true);
  });
});
