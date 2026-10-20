// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// manifest 索引 → 展示模型（纯函数）。原型 graph-demo-export-preview.html 的
// 构建逻辑（分组/子图挂接/代表成员/回滚记录/视图 rank），两处增强：
// ① attempt 无结论且验收 running 时推断 'running'（原型恒 'unknown'）；
// ② run 级状态汇总（列表页徽标）。布局（v2）：带内依赖自上而下流（rank → y），
// 代带为纵向列（代际左→右，同 nodeId 跨代行对齐）；同 rank 节点横向排布，
// 栈序用中位数启发式（前置栈序中位数）减少边扫过中间节点——边锚点与流向
// 一致（源底 → 目标顶），曲线走行间空隙。前端 SVG 只做渲染不做计算——
// 布局在此可被 IT 直接断言。

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
  x: number;                   // 带条左侧（带条为纵向列，代际左→右排列）
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
  /** 同代依赖边（跨视图边已按 representative 归约到本视图节点；逻辑边，测试/API 口径） */
  edges: { from: string; to: string }[];
  /** 渲染边链：跨 rank 长边经虚拟节点逐层下行（bends 为虚拟中转点坐标） */
  edgeChains: { from: string; to: string; bends: Array<{ x: number; y: number }> }[];
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

// ── 几何常量（v2：纵向 rank 流 + 纵向代带列）───────────────────

export const NODE_W = 168;
export const NODE_H = 48;
export const ROW_STEP = 120;   // rank 行距（节点间隙 72 即边曲线/跳线区）
export const COL_STEP = 212;   // 宽槽步进（真实节点列距）
const DUMMY_STEP = 34;         // 窄道步进（纯虚拟槽，只过曲线）
const BAND_PAD_X = 32;         // 带条左右内边距合计
const BAND_GAP = 64;           // 带条间距（回滚边曲线区）
const ORIGIN_X = 18;
const ORIGIN_Y = 44;           // 顶部留出带条标签行

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
  //    指向生成器节点实例（原型 subgraphParentByGeneration）。subgraphGeneratorsOf
  //    反查「子图容器 → 生成器实例」：真实导出件（d01dfbaa）存在「目标 depends_on
  //    生成器产出的子图」形态——依赖源是子图 workflow 容器成员（无 graph 注解），
  //    需归约到生成器节点实例才能进入图视图。
  const generatorNodeIds = new Set<string>();
  const subgraphParentByGeneration = new Map<string, string>();
  const subgraphGeneratorsOf = new Map<string, string[]>();
  // 先独立预遍历建全「子图容器 → 生成器实例」反转表：manifest 里 data.relations 的
  // 声明顺序不保证 gen-sub-graph 先于其 depends_on——若建表与依赖计数同轮进行，
  // depends_on 声明在前时会因 subgraphGeneratorsOf 尚无该容器条目而误判「源不可
  // 归约」，把本可归约的边失真计入 droppedDeps（第 3 步随后仍能正确归约出边）。
  for (const rel of index.relations) {
    const ann = rel.raw.annotation ?? {};
    // gen-sub-graph 双形态：手册定义 kind=，真实导出件（d01dfbaa）用 type=——读侧兼容
    const isGenSubGraph = ann.kind === 'gen-sub-graph' || ann.type === 'gen-sub-graph';
    if (!isGenSubGraph) continue;
    const sourceGraph = rel.from.graph;
    if (!sourceGraph) continue;
    generatorNodeIds.add(sourceGraph.nodeId);
    const sourceGroupKey = memberGroup.get(rel.from.member.id);
    if (!sourceGroupKey) continue;
    subgraphParentByGeneration.set(`${rel.to.member.id}|${sourceGraph.generation}`, sourceGroupKey);
    const generators = subgraphGeneratorsOf.get(rel.to.member.id) ?? [];
    if (!generators.includes(sourceGroupKey)) generators.push(sourceGroupKey);
    subgraphGeneratorsOf.set(rel.to.member.id, generators);
  }
  // 依赖端点不可归约计数：depends_on 可进入图视图当且仅当「目标为图成员，且源为
  // 图成员或子图容器」；其余（端点无 graph 注解）计数告警。
  let droppedDeps = 0;
  for (const rel of index.relations) {
    if ((rel.raw.annotation ?? {}).type !== 'depends_on') continue;
    const fromResolved = memberGroup.has(rel.from.member.id) || subgraphGeneratorsOf.has(rel.from.member.id);
    if (!rel.to.graph || !memberGroup.has(rel.to.member.id) || !fromResolved) {
      droppedDeps++;
    }
  }
  if (droppedDeps > 0) {
    warnings.push(`${droppedDeps} 条 depends_on 关系的端点无 graph 注解，未进入图视图`);
  }

  // 3. 同代依赖来源表（原型 dependencySources；跨代边也保留，视图层归约）。
  //    源端为子图 workflow 容器时归约到生成器实例（容器被多代生成时全挂，
  //    渲染层按同代过滤、rank 按逻辑 nodeId 归约，语义等价于「依赖该生成器」）
  const dependencySources = new Map<string, Set<string>>();
  for (const rel of index.relations) {
    if ((rel.raw.annotation ?? {}).type !== 'depends_on') continue;
    const toGk = memberGroup.get(rel.to.member.id);
    if (!toGk) continue;
    const fromGks = memberGroup.has(rel.from.member.id)
      ? [memberGroup.get(rel.from.member.id)!]
      : subgraphGeneratorsOf.get(rel.from.member.id) ?? [];
    for (const fromGk of fromGks) {
      if (fromGk === toGk) continue;
      let set = dependencySources.get(toGk);
      if (!set) {
        set = new Set();
        dependencySources.set(toGk, set);
      }
      set.add(fromGk);
    }
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
    // 渲染边 = 同代边（跨代依赖不画线，由回滚边/承接语义表达）
    const renderEdges = allEdges.filter(
      e => nodesByKey.get(e.from)!.generation === nodesByKey.get(e.to)!.generation,
    );

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

    // 7a. 虚拟节点（Sugiyama dummy）+ 汇聚主干：跨 rank 长边逐层下行不扫节点。
    //     扇入（同目标 ≥2 条长边）与扇出（同源 ≥2 条）各合并为一条共享主干——
    //     源以短 stub 汇入 / 目标从主干接出，虚拟点数量大幅下降（典型「验收
    //     节点依赖一大片」的拓扑从 N 条平行链塌缩为 1 主干 + N stub）。
    //     扇入优先于扇出（目标侧语义更常见）。
    const chainKeysOf = new Map<string, string[]>(); // 渲染边 → [from, ...dummies, to]
    const dummyRank = new Map<string, number>();     // 虚拟节点 → rank
    const dummyGen = new Map<string, number>();      // 虚拟节点 → 所属代（带列）
    const skipEdges = renderEdges.filter(e => ranks[e.to] > ranks[e.from] + 1);
    const inGroups = new Map<string, { from: string; to: string }[]>();
    const outGroups = new Map<string, { from: string; to: string }[]>();
    for (const e of skipEdges) {
      if (!inGroups.has(e.to)) inGroups.set(e.to, []);
      inGroups.get(e.to)!.push(e);
      if (!outGroups.has(e.from)) outGroups.set(e.from, []);
      outGroups.get(e.from)!.push(e);
    }
    const trunkLanes = new Map<string, Map<number, string>>(); // 主干键 → rank→dummy
    const makeTrunk = (trunkKey: string, startRank: number, endRank: number, gen: number) => {
      const lanes = new Map<number, string>();
      for (let r = startRank; r < endRank; r++) {
        const key = `${trunkKey}-r${r}`;
        dummyRank.set(key, r);
        dummyGen.set(key, gen);
        lanes.set(r, key);
      }
      trunkLanes.set(trunkKey, lanes);
      return lanes;
    };
    renderEdges.forEach((e, idx) => {
      const r1 = ranks[e.from];
      const r2 = ranks[e.to];
      const chain = [e.from];
      if (r2 > r1 + 1) {
        let lanes: Map<number, string> | undefined;
        if ((inGroups.get(e.to)?.length ?? 0) >= 2) {
          const trunkKey = `t-in-${e.to}`;
          lanes = trunkLanes.get(trunkKey)
            ?? makeTrunk(trunkKey, Math.min(...inGroups.get(e.to)!.map(x => ranks[x.from])) + 1, r2, nodesByKey.get(e.to)!.generation);
        } else if ((outGroups.get(e.from)?.length ?? 0) >= 2) {
          const trunkKey = `t-out-${e.from}`;
          lanes = trunkLanes.get(trunkKey)
            ?? makeTrunk(trunkKey, r1 + 1, Math.max(...outGroups.get(e.from)!.map(x => ranks[x.to])), nodesByKey.get(e.from)!.generation);
        }
        if (lanes) {
          for (let r = r1 + 1; r < r2; r++) {
            const k = lanes.get(r);
            if (k) chain.push(k);
          }
        } else {
          for (let r = r1 + 1; r < r2; r++) {
            const key = `d-${idx}-${r}`;
            dummyRank.set(key, r);
            dummyGen.set(key, nodesByKey.get(e.from)!.generation);
            chain.push(key);
          }
        }
      }
      chain.push(e.to);
      chainKeysOf.set(`${e.from}|${e.to}`, chain);
    });

    // 7b. 同 rank 横向栈序：交替中位数启发式（Sugiyama 层序，正/反向各一轮再
    //     正向收尾）——每轮按邻居（前向=前置 / 反向=后继）当前栈序的中位数
    //     重排，让相连节点（含虚拟中转点）彼此靠近；并列按 key 字典序稳定 tie-break
    const orderedKeys = [...visible.map(n => n.key), ...dummyRank.keys()];
    const stackOrder = new Map<string, number>();
    const rankBuckets = new Map<number, string[]>();
    for (const key of orderedKeys) {
      const r = dummyRank.has(key) ? dummyRank.get(key)! : ranks[key];
      if (!rankBuckets.has(r)) rankBuckets.set(r, []);
      rankBuckets.get(r)!.push(key);
    }
    const predOf = new Map<string, string[]>();
    const succOf = new Map<string, string[]>();
    for (const chain of chainKeysOf.values()) {
      for (let i = 0; i < chain.length - 1; i++) {
        if (!predOf.has(chain[i + 1])) predOf.set(chain[i + 1], []);
        predOf.get(chain[i + 1])!.push(chain[i]);
        if (!succOf.has(chain[i])) succOf.set(chain[i], []);
        succOf.get(chain[i])!.push(chain[i + 1]);
      }
    }
    const ranksAsc = [...rankBuckets.keys()].sort((a, b) => a - b);
    const reorder = (forward: boolean) => {
      const seq = forward ? ranksAsc : [...ranksAsc].reverse();
      for (const r of seq) {
        rankBuckets.get(r)!
          .map(key => {
            const neigh = (forward ? predOf.get(key) ?? [] : succOf.get(key) ?? [])
              .map(k => stackOrder.get(k))
              .filter((x): x is number => x !== undefined);
            const median = neigh.length > 0
              ? [...neigh].sort((a, b) => a - b)[Math.floor((neigh.length - 1) / 2)]
              : stackOrder.get(key) ?? -1;
            return { key, median };
          })
          .sort((a, b) => a.median - b.median || a.key.localeCompare(b.key))
          .forEach((s, i) => stackOrder.set(s.key, i));
      }
    };
    reorder(true);
    reorder(false);
    reorder(true);

    // 7c. 代带布局：带条为纵向列（代际左→右），带内 rank → y 自上而下流。
    //     槽位制：每个栈序号占一个槽；任一 rank 有真实节点的槽为宽槽
    //     （COL_STEP 步进），纯虚拟槽为窄道（DUMMY_STEP 步进，只过曲线）——
    //     虚拟链走窄道不撑宽画布，纵向通道全程无节点。rank 按逻辑 nodeId
    //     计算 → 同节点跨代行对齐
    const gens = [...new Set(visible.map(n => n.generation))].sort((a, b) => a - b);
    const positions: Record<string, { x: number; y: number }> = {};
    const bands: BandLayout[] = [];
    let x = ORIGIN_X;
    for (const gen of gens) {
      const inBand = orderedKeys.filter(k =>
        dummyGen.has(k) ? dummyGen.get(k) === gen : nodesByKey.get(k)!.generation === gen,
      );
      // 槽 → 条目（每槽在不同 rank 各至多一条；同槽跨 rank 共享 x 才能对齐列）
      const slotEntries = new Map<number, Array<{ key: string; isDummy: boolean; rank: number }>>();
      for (const key of inBand) {
        const isDummy = dummyRank.has(key);
        const rank = isDummy ? dummyRank.get(key)! : ranks[key];
        const slot = stackOrder.get(key)!;
        if (!slotEntries.has(slot)) slotEntries.set(slot, []);
        slotEntries.get(slot)!.push({ key, isDummy, rank });
      }
      const slotHasReal = new Map<number, boolean>();
      for (const [slot, entries] of slotEntries) {
        slotHasReal.set(slot, entries.some(e => !e.isDummy));
      }
      const slotsAsc = [...slotEntries.keys()].sort((a, b) => a - b);
      const slotX = new Map<number, number>();
      let cursor = BAND_PAD_X / 2;
      for (const s of slotsAsc) {
        slotX.set(s, cursor);
        cursor += slotHasReal.get(s) ? COL_STEP : DUMMY_STEP;
      }
      let maxRight = 0;
      for (const [slot, entries] of slotEntries) {
        const sx = x + slotX.get(slot)!;
        const wide = slotHasReal.get(slot)!;
        for (const e of entries) {
          if (!e.isDummy) {
            positions[e.key] = { x: sx, y: ORIGIN_Y + e.rank * ROW_STEP };
            maxRight = Math.max(maxRight, sx + NODE_W - x);
          } else {
            const dx = wide ? sx + NODE_W / 2 : sx + DUMMY_STEP / 2;
            positions[e.key] = { x: dx, y: ORIGIN_Y + e.rank * ROW_STEP + NODE_H / 2 };
            maxRight = Math.max(maxRight, dx + 6 - x);
          }
        }
      }
      const width = Math.max(maxRight + BAND_PAD_X / 2 + 4, NODE_W + BAND_PAD_X);
      bands.push({
        generation: gen,
        label: gen === 0 ? '第 1 次运行' : `回滚 #${gen}`,
        x,
        width,
      });
      x += width + BAND_GAP;
    }

    // 7c′. 拐弯最小化（非必要不拐弯）：重排虚拟点 x——扇入组并入目标列、扇
    //     出组并入源列（主干一次水平过渡到位），列被挡时整组退到最近自由走
    //     廊；独立长边用 Dijkstra 最短路（状态 = 隙号 × 列，垂直下探 0 拐、
    //     隙上换列 1 拐）保证拐数最小。垂直通道唯一硬约束是不穿真实节点（按
    //     行占用检查；边-边交叉由渲染层 PCB 跳线表达，无需窄道错峰）；全程
    //     无解的组/链保留 7c 槽位阶梯降级
    const rowSpans = new Map<number, Array<[number, number]>>();
    for (const n of visible) {
      const p = positions[n.key]!;
      const r = ranks[n.key];
      if (!rowSpans.has(r)) rowSpans.set(r, []);
      rowSpans.get(r)!.push([p.x - 4, p.x + NODE_W + 4]);
    }
    const colFree = (col: number, fromRow: number, toRow: number): boolean => {
      for (let r = fromRow; r <= toRow; r++) {
        for (const [a, b] of rowSpans.get(r) ?? []) {
          if (col > a && col < b) return false;
        }
      }
      return true;
    };
    const nodeCenterX = (key: string) => positions[key]!.x + NODE_W / 2;
    const setDummyCols = (keys: string[], colList: number[]) => {
      keys.forEach((k, i) => { positions[k] = { x: colList[i], y: positions[k]!.y }; });
    };
    const rightEdge = Math.max(x - BAND_GAP, ORIGIN_X);
    // 走廊列：行区间内所有节点间隙的中点（含带间隙；间隙 ≥12 才容得下线宽）
    const corridorCols = (fromRow: number, toRow: number): number[] => {
      const cols = new Set<number>();
      for (let r = fromRow; r <= toRow; r++) {
        const spans = [...(rowSpans.get(r) ?? [])].sort((a, b) => a[0] - b[0]);
        let prev = ORIGIN_X;
        for (const [a, b] of spans) {
          if (a - prev >= 12) cols.add(Math.round((prev + a) / 2));
          prev = Math.max(prev, b);
        }
        if (rightEdge - prev >= 12) cols.add(Math.round((prev + rightEdge) / 2));
      }
      return [...cols];
    };
    const longEdges = renderEdges.filter(e => ranks[e.to] > ranks[e.from] + 1);
    const inCnt = new Map<string, number>();
    const outCnt = new Map<string, number>();
    for (const e of longEdges) {
      inCnt.set(e.to, (inCnt.get(e.to) ?? 0) + 1);
      outCnt.set(e.from, (outCnt.get(e.from) ?? 0) + 1);
    }
    const fanIn = new Map<string, { from: string; to: string }[]>();
    const fanOut = new Map<string, { from: string; to: string }[]>();
    for (const e of longEdges) {
      if ((inCnt.get(e.to) ?? 0) >= 2) {
        if (!fanIn.has(e.to)) fanIn.set(e.to, []);
        fanIn.get(e.to)!.push(e);
      } else if ((outCnt.get(e.from) ?? 0) >= 2) {
        if (!fanOut.has(e.from)) fanOut.set(e.from, []);
        fanOut.get(e.from)!.push(e);
      }
    }
    const trunkColNear = (prefer: number, top: number, bottom: number): number | undefined =>
      colFree(prefer, top, bottom)
        ? prefer
        : corridorCols(top, bottom)
          .filter(c => colFree(c, top, bottom))
          .sort((a, b) => Math.abs(a - prefer) - Math.abs(b - prefer))[0];
    for (const [to, members] of fanIn) {
      const col = trunkColNear(nodeCenterX(to), Math.min(...members.map(e => ranks[e.from])) + 1, ranks[to] - 1);
      if (col === undefined) continue;
      for (const e of members) {
        setDummyCols(chainKeysOf.get(`${e.from}|${e.to}`)!.slice(1, -1), chainKeysOf.get(`${e.from}|${e.to}`)!.slice(1, -1).map(() => col));
      }
    }
    for (const [from, members] of fanOut) {
      const col = trunkColNear(nodeCenterX(from), ranks[from] + 1, Math.max(...members.map(e => ranks[e.to])) - 1);
      if (col === undefined) continue;
      for (const e of members) {
        setDummyCols(chainKeysOf.get(`${e.from}|${e.to}`)!.slice(1, -1), chainKeysOf.get(`${e.from}|${e.to}`)!.slice(1, -1).map(() => col));
      }
    }
    for (const e of longEdges) {
      if ((inCnt.get(e.to) ?? 0) >= 2 || (outCnt.get(e.from) ?? 0) >= 2) continue;
      const chain = chainKeysOf.get(`${e.from}|${e.to}`)!;
      const dummies = chain.slice(1, -1);
      if (dummies.length === 0) continue;
      const top = ranks[e.from] + 1;
      const bottom = ranks[e.to] - 1;
      const sCol = nodeCenterX(e.from);
      const tCol = nodeCenterX(e.to);
      const D = dummies.length;
      const cols = [...new Set([sCol, tCol, ...corridorCols(top, bottom)])];
      const N = cols.length;
      const si = cols.indexOf(sCol);
      const ti = cols.indexOf(tCol);
      const runEnd = cols.map(c => {
        const g = new Array<number>(D + 1);
        g[D] = D;
        for (let i = D - 1; i >= 0; i--) g[i] = colFree(c, top + i, top + i) ? g[i + 1] : i;
        return g;
      });
      const dist = new Array<number>((D + 1) * N).fill(Infinity);
      const prevSt = new Array<number>((D + 1) * N).fill(-1);
      dist[si] = 0;
      const pq: Array<[number, number]> = [[0, si]];
      while (pq.length > 0) {
        pq.sort((a, b) => a[0] - b[0]);
        const [cost, s] = pq.shift()!;
        if (cost > dist[s]) continue;
        const i = Math.floor(s / N);
        const ci = s % N;
        if (i === D && ci === ti) break;
        for (let cj = 0; cj < N; cj++) {
          if (cj === ci) continue;
          const ns = i * N + cj;
          const nc = cost + 1_000_000 + Math.abs(cols[ci] - cols[cj]) + (D - i);
          if (nc < dist[ns]) {
            dist[ns] = nc;
            prevSt[ns] = s;
            pq.push([nc, ns]);
          }
        }
        for (let j = i + 1; j <= runEnd[ci][i]; j++) {
          const ns = j * N + ci;
          if (cost < dist[ns]) {
            dist[ns] = cost;
            prevSt[ns] = s;
            pq.push([cost, ns]);
          }
        }
      }
      const goal = D * N + ti;
      if (dist[goal] === Infinity) continue;
      // 回溯换列点：隙 g 换到新列 → 向下传播到下一次换列（垂直段整段同列）
      const switchAt = new Map<number, number>();
      for (let s = goal; s !== si; s = prevSt[s]) {
        const p = prevSt[s];
        if (Math.floor(p / N) === Math.floor(s / N) && p % N !== s % N) {
          switchAt.set(Math.floor(s / N), cols[s % N]);
        }
      }
      const dcols: number[] = [];
      let cur = sCol;
      for (let g = 0; g < D; g++) {
        if (switchAt.has(g)) cur = switchAt.get(g)!;
        dcols.push(cur);
      }
      setDummyCols(dummies, dcols);
    }

    const maxRank = visible.length > 0 ? Math.max(...visible.map(n => ranks[n.key])) : 0;
    const layout: RunViewLayout = {
      bands,
      positions,
      width: x - BAND_GAP + 8,
      height: ORIGIN_Y + maxRank * ROW_STEP + NODE_H + 26,
    };

    // 7d. 渲染边链：源底 → 各虚拟点 → 目标顶（vBezier 垂直手柄在衔接处切向
    //     连续，链式拼出一条平滑曲线）
    const edgeChains = renderEdges.map(e => {
      const chain = chainKeysOf.get(`${e.from}|${e.to}`)!;
      return {
        from: e.from,
        to: e.to,
        bends: chain.slice(1, -1).map(k => positions[k]).filter((p): p is { x: number; y: number } => p !== undefined),
      };
    });

    const parent = parentKey ? nodesByKey.get(parentKey) : null;
    return {
      id: parentKey ? `sub:${parentKey}` : 'main',
      title: parent ? `${parent.label} · 第 ${parent.generation + 1} 代子图` : '主图（所有代）',
      parentKey,
      nodeKeys: visible.map(n => n.key),
      ranks,
      edges: renderEdges,
      edgeChains,
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
