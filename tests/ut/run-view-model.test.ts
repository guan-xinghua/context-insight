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
import { buildViewModel, findNodeInstance, nodeKeyOf, NODE_W } from '@/lib/run/view-model';

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

  it('代带布局：3 条带（第 1 次运行/回滚 #1/回滚 #2），同 nodeId 跨代 y 对齐', () => {
    const main = vm.views[0];
    expect(main.layout.bands.map(b => b.label)).toEqual(['第 1 次运行', '回滚 #1', '回滚 #2']);
    const g0 = main.layout.positions[nodeKeyOf('step-a', 0)]!;
    const g2 = main.layout.positions[nodeKeyOf('step-a', 2)]!;
    expect(g0.y).toBe(g2.y); // 同逻辑节点跨代共享 rank（横向对齐）
    expect(g2.x).toBeGreaterThan(g0.x + NODE_W); // 后代带在右侧
    // init（无前置）rank 0
    expect(main.ranks[nodeKeyOf('init', 0)]).toBe(0);
    expect(main.ranks[nodeKeyOf('step-a', 0)]).toBe(1);
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
});

describe('view-model：run 级汇总', () => {
  it('状态汇总：存在 failed 节点（always-fail 未执行但 bad-node 曾失败）', () => {
    // bad-node g1 终态 failed → run 汇总 failed
    expect(vm.status).toBe('failed');
    expect(vm.exportDataComplete).toBe(true);
    expect(vm.name).toBe('graph-demo');
  });
});
