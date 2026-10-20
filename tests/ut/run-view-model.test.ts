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

  it('comb 拓扑：所有边 ≤1 次水平过渡且零穿框；扇入主干虚拟点全落目标列', () => {
    const { m, view } = loadMain(COMB);
    for (const c of view.edgeChains) {
      expect(transitionsOf(chainPts(view, c)), `${c.from}→${c.to}`).toBeLessThanOrEqual(1);
      expect(piercingsOf(view, c), `${c.from}→${c.to} 不穿节点`).toBe(0);
    }
    // a1→b4 / c1→b4 扇入组：共享主干并入 b4 中心列，各以 1 次水平过渡汇入
    const b4Col = view.layout.positions[m.nodes.find(n => n.nodeId === 'b4')!.key]!.x + NODE_W / 2;
    for (const [f, t] of [['a1', 'b4'], ['c1', 'b4']] as const) {
      const c = chainOf(m, view, f, t);
      expect(c.bends.every(p => p.x === b4Col), `${f}→${t} 主干并入目标列`).toBe(true);
      expect(transitionsOf(chainPts(view, c))).toBe(1);
    }
  });

  it('braid 拓扑：所有边 ≤2 次水平过渡且零穿框（旧槽位阶梯为 3-4 次）', () => {
    const { m, view } = loadMain(BRAID);
    for (const c of view.edgeChains) {
      expect(transitionsOf(chainPts(view, c)), `${c.from}→${c.to}`).toBeLessThanOrEqual(2);
      expect(piercingsOf(view, c), `${c.from}→${c.to} 不穿节点`).toBe(0);
    }
    // 源/目标同列且通道畅通的长边全程直行（0 次水平过渡）
    for (const [f, t] of [['b1', 'd5'], ['a2', 'e4']] as const) {
      expect(transitionsOf(chainPts(view, chainOf(m, view, f, t))), `${f}→${t} 直行`).toBe(0);
    }
    // 两端列均被挡的长边/组绕行自由走廊：恰好 2 次水平过渡
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

describe('view-model：run 级汇总', () => {
  it('状态汇总：存在 failed 节点（always-fail 未执行但 bad-node 曾失败）', () => {
    // bad-node g1 终态 failed → run 汇总 failed
    expect(vm.status).toBe('failed');
    expect(vm.exportDataComplete).toBe(true);
    expect(vm.name).toBe('graph-demo');
  });
});
