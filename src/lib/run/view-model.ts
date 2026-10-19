// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// manifest 索引 → 展示模型（纯函数）。移植交互原型 graph-demo-export-preview.html
// 的构建逻辑（分组/子图挂接/代表成员/回滚记录/视图 rank/代带布局），两处增强：
// ① attempt 无结论且验收 running 时推断 'running'（原型恒 'unknown'）；
// ② run 级状态汇总（列表页徽标）。布局数值与原型一致（168 宽节点 × 188 列距 ×
// 100 行距），前端 SVG 只做渲染不做计算——布局在此可被 IT 直接断言。

import type { RunIndex, IndexedMember } from './reader';
import type { MemberKind, MemberRole, RunGraphAnnotation, SessionRef } from './model';

// ── 类型 ──────────────────────────────────────────────────────

/** 成员引用（节点历史侧栏 / 下钻入口的数据形状）。session 由 API 层注入。 */
export interface SessionMemberRef {
  memberId: string;
  kind: MemberKind;
  role: MemberRole;
  name: string | null;
  note: string | null;
  sessionId: string | null;
  location: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** session-link join 结果（未导入/无会话成员为 null） */
  session?: SessionRef | null;
}

export interface AttemptRecord {
  ordinal: number;             // 本代第几次尝试（1 起）
  status: 'passed' | 'failed' | 'running' | 'unknown';
  startedAt: string | null;
  finishedAt: string | null;
  outputText: string | null;   // process 成员的 Bash 输出（可能截断）
  verification: { type: string; status: string; reason: string | null };
  executeMember: SessionMemberRef;
  verifyMember: SessionMemberRef | null;
}

export type NodeStatus = 'passed' | 'failed' | 'running' | 'pending' | 'carried' | 'unknown';

export interface NodeInstance {
  key: string;                 // `n-<nodeId>-g<generation>`
  nodeId: string;
  generation: number;
  label: string;               // = nodeId（跨代稳定的逻辑名）
  taskType: 'agent' | 'bash' | 'generator';
  status: NodeStatus;
  executionState: 'executed' | 'not_run' | 'carried';
  carriedFromGeneration: number | null;
  attempts: AttemptRecord[];
  /** attempt=0 且无 executionState 的空占位成员（「本代尚未运行」） */
  pendingMembers: SessionMemberRef[];
  retryPolicy: RunGraphAnnotation['retryPolicy'] | null;
  runOnFailure: boolean | null;
  /** 同代依赖的来源节点实例 key（跨代边也保留，视图按 representative 归约） */
  predecessorKeys: string[];
  /** 子图挂接：生成器节点实例 key（主图成员为 null） */
  parentKey: string | null;
  /** 本实例是否有子图视图（views 里存在 parentKey === key 的视图） */
  hasSubgraph: boolean;
}

export interface RollbackRecord {
  ordinal: number;
  from: { nodeId: string; generation: number; attempt: number };
  to: { nodeId: string; generation: number; attempt: number };
  triggerKey: string;
  targetKey: string;
  note: string | null;
}

export interface BandLayout {
  generation: number;
  label: string;               // 第 1 次运行 / 回滚 #N
  x: number;
  width: number;
}

export interface RunViewLayout {
  bands: BandLayout[];
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export interface RunView {
  id: string;                  // 'main' | `sub:<parentKey>`
  title: string;
  parentKey: string | null;
  nodeKeys: string[];
  ranks: Record<string, number>;
  /** 同代依赖边（跨视图边已按 representative 归约到本视图节点） */
  edges: { from: string; to: string }[];
  rollbackLinks: { from: string; to: string; label: string; ordinal: number }[];
  layout: RunViewLayout;
}

export interface RunViewModel {
  runId: string;
  name: string | null;
  status: NodeStatus;          // run 级汇总（展示用，见 buildViewModel）
  exportDataComplete: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  generations: number[];       // 升序去重
  nodes: NodeInstance[];       // 主图 + 子图全部节点实例
  rollbacks: RollbackRecord[];
  views: RunView[];            // views[0] 恒为主图
  warnings: string[];
}

// ── 几何常量（与原型一致）──────────────────────────────────────

export const NODE_W = 168;
export const NODE_H = 48;
export const COL_STEP = 188;   // 同 rank 相邻节点列距
export const ROW_STEP = 100;   // rank 行距
const BAND_PAD = 38;           // 代带内边距
const BAND_GAP = 70;           // 代带间距
const ORIGIN_X = 18;
const ORIGIN_Y = 60;

// ── 构建 ──────────────────────────────────────────────────────

export function nodeKeyOf(nodeId: string, generation: number): string {
  return `n-${nodeId}-g${generation}`;
}

function memberRef(m: IndexedMember, role: MemberRole): SessionMemberRef {
  const member = m.member;
  return {
    memberId: member.id,
    kind: member.kind,
    role,
    name: member.name ?? null,
    note: (member.annotation?.note as string | undefined) ?? null,
    sessionId: member.sessionId ?? null,
    location: member.location ?? null,
    startedAt: member.startedAt ?? null,
    finishedAt: member.finishedAt ?? null,
  };
}

function attemptStatus(execute: IndexedMember, verify: IndexedMember | undefined): AttemptRecord['status'] {
  const result = execute.graph?.attemptResult;
  if (result === 'succeeded') return 'passed';
  if (result === 'failed') return 'failed';
  // 无最终结论：验收 running 或成员已开始未结束 → 运行中（原型为 unknown 的增强）
  if (verify?.graph?.verification?.status === 'running') return 'running';
  if (execute.member.startedAt && !execute.member.finishedAt) return 'running';
  return 'unknown';
}

interface Group {
  key: string;
  nodeId: string;
  generation: number;
  members: IndexedMember[];
}

export function buildViewModel(index: RunIndex): RunViewModel {
  const warnings = [...index.warnings];

  // 1. 分组：graphMembers 按 (nodeId, generation) 聚簇（原型 collect）
  const groups = new Map<string, Group>();
  const memberGroup = new Map<string, string>();
  for (const m of index.graphMembers) {
    const g = m.graph!;
    const key = nodeKeyOf(g.nodeId, g.generation);
    let group = groups.get(key);
    if (!group) {
      group = { key, nodeId: g.nodeId, generation: g.generation, members: [] };
      groups.set(key, group);
    }
    group.members.push(m);
    memberGroup.set(m.member.id, key);
  }

  // 2. 子图挂接表：gen-sub-graph 关系按「子图 workflow 成员 id + 生成器代数」
  //    指向生成器节点实例（原型 subgraphParentByGeneration）
  const generatorNodeIds = new Set<string>();
  const subgraphParentByGeneration = new Map<string, string>();
  let droppedDeps = 0;
  for (const rel of index.relations) {
    const ann = rel.raw.annotation ?? {};
    // gen-sub-graph 双形态：手册定义 kind=，真实导出件（d01dfbaa）用 type=——读侧兼容
    const isGenSubGraph = ann.kind === 'gen-sub-graph' || ann.type === 'gen-sub-graph';
    if (isGenSubGraph) {
      const sourceGraph = rel.from.graph;
      if (sourceGraph) {
        generatorNodeIds.add(sourceGraph.nodeId);
        const sourceGroupKey = memberGroup.get(rel.from.member.id);
        if (sourceGroupKey) {
          subgraphParentByGeneration.set(`${rel.to.member.id}|${sourceGraph.generation}`, sourceGroupKey);
        }
      }
    }
    if (ann.type === 'depends_on') {
      // 依赖边端点无 graph 注解（非图成员）→ 无法挂到节点，计数告警
      if (!rel.from.graph || !rel.to.graph || !memberGroup.has(rel.from.member.id) || !memberGroup.has(rel.to.member.id)) {
        droppedDeps++;
      }
    }
  }
  if (droppedDeps > 0) {
    warnings.push(`${droppedDeps} 条 depends_on 关系的端点无 graph 注解，未进入图视图`);
  }

  // 3. 同代依赖来源表（原型 dependencySources；跨代边也保留，视图层归约）
  const dependencySources = new Map<string, Set<string>>();
  for (const rel of index.relations) {
    if ((rel.raw.annotation ?? {}).type !== 'depends_on') continue;
    const fromGk = memberGroup.get(rel.from.member.id);
    const toGk = memberGroup.get(rel.to.member.id);
    if (!fromGk || !toGk || fromGk === toGk) continue;
    let set = dependencySources.get(toGk);
    if (!set) {
      set = new Set();
      dependencySources.set(toGk, set);
    }
    set.add(fromGk);
  }

  // 4. 节点实例（原型 records）
  const nodes: NodeInstance[] = [];
  for (const group of groups.values()) {
    const executions = group.members.filter(m => m.graph!.role === 'execute');
    const actual = executions.filter(m => m.graph!.attempt > 0).sort((a, b) => a.graph!.attempt - b.graph!.attempt);
    const representative = actual.at(-1) ?? executions[0] ?? group.members[0];

    const attempts: AttemptRecord[] = actual.map(execute => {
      const at = execute.graph!.attempt;
      const verify = group.members.find(m => m.graph!.role === 'verify' && m.graph!.attempt === at);
      const verificationSource = verify?.graph?.verification ?? representative.graph?.verification;
      return {
        ordinal: at,
        status: attemptStatus(execute, verify),
        startedAt: execute.member.startedAt ?? null,
        finishedAt: execute.member.finishedAt ?? null,
        outputText: execute.member.kind === 'process' ? execute.member.output?.text ?? null : null,
        verification: {
          type: verificationSource?.type ?? 'none',
          status: verificationSource?.status ?? 'unknown',
          reason: verificationSource?.reason ?? null,
        },
        executeMember: memberRef(execute, 'execute'),
        verifyMember: verify ? memberRef(verify, 'verify') : null,
      };
    });

    const carried = executions.find(m => m.graph!.executionState === 'carried');
    const kindSource = actual[0] ?? executions[0] ?? representative;
    nodes.push({
      key: group.key,
      nodeId: group.nodeId,
      generation: group.generation,
      label: group.nodeId,
      taskType: generatorNodeIds.has(group.nodeId)
        ? 'generator'
        : kindSource.member.kind === 'session' ? 'agent' : 'bash',
      status: carried ? 'carried' : attempts.length > 0 ? attempts[attempts.length - 1].status : 'pending',
      executionState: carried ? 'carried' : attempts.length > 0 ? 'executed' : 'not_run',
      carriedFromGeneration: carried?.graph?.resultFromGeneration ?? null,
      attempts,
      pendingMembers: executions
        .filter(m => m.graph!.attempt === 0 && !m.graph!.executionState)
        .map(m => memberRef(m, m.graph!.role)),
      retryPolicy: executions.find(m => m.graph!.retryPolicy)?.graph!.retryPolicy ?? null,
      runOnFailure: executions.find(m => m.graph!.runOnFailure !== undefined)?.graph!.runOnFailure ?? null,
      predecessorKeys: [...(dependencySources.get(group.key) ?? [])],
      parentKey: subgraphParentByGeneration.get(
        `${representative.ownerWorkflowId ?? ''}|${group.generation}`,
      ) ?? null,
      hasSubgraph: false,
    });
  }
  const nodesByKey = new Map(nodes.map(n => [n.key, n]));

  // 5. 回滚记录（原型 rollbackRecords）
  const rollbacks: RollbackRecord[] = [];
  let rollbackOrdinal = 0;
  for (const rel of index.relations) {
    if ((rel.raw.annotation ?? {}).type !== 'rollback') continue;
    const sourceGk = memberGroup.get(rel.from.member.id);
    const targetGk = memberGroup.get(rel.to.member.id);
    const sourceGroup = sourceGk ? groups.get(sourceGk) : undefined;
    const targetGroup = targetGk ? groups.get(targetGk) : undefined;
    if (!sourceGroup || !targetGroup) {
      warnings.push(`回滚关系 ${rel.raw.from} → ${rel.raw.to} 端点无 graph 注解，未进入图视图`);
      continue;
    }
    const sourceMember = sourceGroup.members.find(m => m.member.id === rel.raw.from)!;
    const targetMember = targetGroup.members.find(m => m.member.id === rel.raw.to)!;
    rollbackOrdinal += 1;
    rollbacks.push({
      ordinal: rollbackOrdinal,
      from: {
        nodeId: sourceGroup.nodeId,
        generation: sourceGroup.generation,
        attempt: sourceMember.graph!.attempt,
      },
      to: {
        nodeId: targetGroup.nodeId,
        generation: targetGroup.generation,
        attempt:
          (rel.raw.annotation?.graph?.targetAttempt as number | undefined)
          ?? targetMember.graph!.attempt,
      },
      triggerKey: sourceGroup.key,
      targetKey: targetGroup.key,
      note: rel.raw.annotation?.note ?? null,
    });
  }

  // 6. 视图（原型 makeView）：主图 + 每个被挂接的生成器实例一个子图视图
  const parentKeysWithChildren = new Set(nodes.map(n => n.parentKey).filter((k): k is string => k !== null));
  for (const n of nodes) n.hasSubgraph = parentKeysWithChildren.has(n.key);

  const views: RunView[] = [];
  const buildView = (parentKey: string | null): RunView => {
    const visible = nodes.filter(n => (n.parentKey ?? null) === parentKey);
    const visibleKeys = new Set(visible.map(n => n.key));
    // 跨视图依赖归约：沿 parentKey 链上溯到本视图内的祖先实例
    const representative = (id: string | null): string | null => {
      let cur = id;
      while (cur && !visibleKeys.has(cur)) {
        cur = nodesByKey.get(cur)?.parentKey ?? null;
      }
      return cur;
    };

    const dependencies = new Map<string, { from: string; to: string }>();
    for (const n of nodes) {
      for (const source of n.predecessorKeys) {
        const from = representative(source);
        const to = representative(n.key);
        if (from && to && from !== to) dependencies.set(`${from}|${to}`, { from, to });
      }
    }
    const allEdges = [...dependencies.values()];

    // rank 按逻辑 nodeId 计算：同节点跨代实例共享行（代带横向对齐的来源）
    const predecessors = new Map(visible.map(n => [n.nodeId, new Set<string>()]));
    for (const e of allEdges) {
      const a = nodesByKey.get(e.from)!;
      const b = nodesByKey.get(e.to)!;
      if (a.nodeId !== b.nodeId) predecessors.get(b.nodeId)?.add(a.nodeId);
    }
    const depth = new Map<string, number>();
    const rank = (nodeId: string, path: Set<string>): number => {
      const memo = depth.get(nodeId);
      if (memo !== undefined) return memo;
      if (path.has(nodeId)) return 0; // 环防御：按 0 层处理
      const next = new Set(path).add(nodeId);
      const before = [...(predecessors.get(nodeId) ?? [])];
      const r = before.length > 0 ? Math.max(...before.map(p => rank(p, next) + 1)) : 0;
      depth.set(nodeId, r);
      return r;
    };
    const ranks: Record<string, number> = {};
    for (const n of visible) ranks[n.key] = rank(n.nodeId, new Set());

    const rollbackLinks = rollbacks
      .map(r => {
        const from = representative(r.triggerKey);
        const to = representative(r.targetKey);
        return from && to && from !== to
          ? { from, to, label: `回滚 #${r.ordinal}`, ordinal: r.ordinal }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // 7. 代带布局（原型 render 的几何）：竖向代带 + 横向 rank 行
    const gens = [...new Set(visible.map(n => n.generation))].sort((a, b) => a - b);
    const positions: Record<string, { x: number; y: number }> = {};
    const bands: BandLayout[] = [];
    let x = ORIGIN_X;
    for (const gen of gens) {
      const group = visible.filter(n => n.generation === gen);
      const byRank = new Map<number, NodeInstance[]>();
      for (const n of group) {
        const r = ranks[n.key];
        if (!byRank.has(r)) byRank.set(r, []);
        byRank.get(r)!.push(n);
      }
      const width = Math.max(...[...byRank.values()].map(a => a.length)) * COL_STEP + BAND_PAD;
      bands.push({
        generation: gen,
        label: gen === 0 ? '第 1 次运行' : `回滚 #${gen}`,
        x,
        width,
      });
      for (const [rank, items] of byRank) {
        items
          .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
          .forEach((n, i) => {
            positions[n.key] = { x: x + 18 + i * COL_STEP, y: ORIGIN_Y + rank * ROW_STEP };
          });
      }
      x += width + BAND_GAP;
    }
    const maxRank = visible.length > 0 ? Math.max(...visible.map(n => ranks[n.key])) : 0;
    const layout: RunViewLayout = {
      bands,
      positions,
      width: Math.max(x - 45, 0),
      height: (maxRank + 1) * ROW_STEP + 85,
    };

    const parent = parentKey ? nodesByKey.get(parentKey) : null;
    return {
      id: parentKey ? `sub:${parentKey}` : 'main',
      title: parent ? `${parent.label} · 第 ${parent.generation + 1} 代子图` : '主图（所有代）',
      parentKey,
      nodeKeys: visible.map(n => n.key),
      ranks,
      edges: allEdges.filter(e => nodesByKey.get(e.from)!.generation === nodesByKey.get(e.to)!.generation),
      rollbackLinks,
      layout,
    };
  };

  views.push(buildView(null));
  for (const key of parentKeysWithChildren) views.push(buildView(key));

  // 8. run 级状态汇总：任何节点运行中 → running；否则有失败 → failed；
  //    有成功/承接 → passed；全空占位 → unknown（展示口径，非业务终态）
  const statuses = nodes.map(n => n.status);
  const runStatus: NodeStatus = statuses.includes('running')
    ? 'running'
    : statuses.includes('failed')
      ? 'failed'
      : statuses.some(s => s === 'passed' || s === 'carried')
        ? 'passed'
        : 'unknown';

  return {
    runId: index.runId,
    name: index.manifest.name ?? null,
    status: runStatus,
    exportDataComplete: index.manifest.data.exportDataComplete === true,
    startedAt: index.manifest.startedAt ?? null,
    finishedAt: index.manifest.finishedAt ?? null,
    generations: [...new Set(nodes.map(n => n.generation))].sort((a, b) => a - b),
    nodes,
    rollbacks,
    views,
    warnings,
  };
}

/** 按 (nodeId, generation) 取节点实例（成员下钻 API 用）。 */
export function findNodeInstance(vm: RunViewModel, nodeId: string, generation: number): NodeInstance | null {
  return vm.nodes.find(n => n.nodeId === nodeId && n.generation === generation) ?? null;
}
