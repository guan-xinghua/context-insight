// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 重试浪费账本 + 平行宇宙模拟（图结构独有观测）：
// - 账本：实例级浪费 = 节点时长 − 末次尝试跨度（被覆盖的尝试 + 重试等待，
//   即「没能留住的尝试」）
// - 平行宇宙：同一「意图管线」DAG 只换时长假设——现实（Σ 实例节点时长）vs
//   首试即过（各实例只保留末次尝试）。节点按 nodeId 折叠：回滚 = 同节点重跑，
//   回滚边折叠为自环自然消解。两个宇宙之差恒等于账本总额（可对账）。
//   生成器节点时长 = 其子图的模拟墙钟（递归）。

import type { AttemptRecord, NodeInstance, RunViewModel, RunView } from "./view-model";
import { attemptRangeOf, attemptSpanMs, nodeUsageOf, validTs } from "./run-metrics";

// ── 重试浪费账本 ────────────────────────────────────────────

export interface RetryWaste {
  attempts: number;
  /** 被覆盖尝试 + 重试等待（实例墙钟 − 末次尝试跨度）；null = 时间不可计量 */
  wastedMs: number | null;
  /** 被覆盖尝试的 token（末次尝试不计；等待不耗 token） */
  wastedTokens: number;
}

function attemptTokensOf(a: AttemptRecord): number {
  let t = 0;
  for (const m of [a.executeMember, a.verifyMember]) {
    if (m?.session) t += m.session.totalTokens;
  }
  return t;
}

/** 实例墙钟：首尝试开始 → 末尝试结束（attemptRangeOf 同口径：manifest
 *  attempt 时间戳优先，会话行起止兜底）——A 宇宙与账本的单点口径。 */
function attemptWallMs(node: NodeInstance): number | null {
  if (node.attempts.length === 0) return null;
  let st: number | null = null;
  let en: number | null = null;
  for (const a of node.attempts) {
    const r = attemptRangeOf(a);
    const s = validTs(r.start);
    const e = validTs(r.end);
    if (s !== null) st = st === null ? s : Math.min(st, s);
    if (e !== null) en = en === null ? e : Math.max(en, e);
  }
  return st !== null && en !== null && en >= st ? en - st : null;
}

/** 实例级重试浪费。单次尝试（无重试故事）返回 null。 */
export function retryWasteOf(node: NodeInstance): RetryWaste | null {
  if (node.attempts.length <= 1) return null;
  const last = node.attempts[node.attempts.length - 1];
  const usage = nodeUsageOf(node);
  const wall = attemptWallMs(node);
  const lastSpan = attemptSpanMs(last);
  const wastedMs = wall !== null && lastSpan !== null
    ? Math.max(wall - lastSpan, 0)
    : null;
  const wastedTokens = usage !== null
    ? Math.max(usage.totalTokens - attemptTokensOf(last), 0)
    : 0;
  return { attempts: node.attempts.length, wastedMs, wastedTokens };
}

// ── 平行宇宙模拟 ────────────────────────────────────────────

export interface UniverseSummary {
  /** 模拟墙钟（意图管线关键路径）；依赖含环 → null */
  wallMs: number | null;
  /** Σ 节点时长（生成器按子图墙钟计） */
  busyMs: number;
  tokens: number;
}

export interface UniversesResult {
  real: UniverseSummary;
  ideal: UniverseSummary;
  cyclic: boolean;
}

type Universe = "real" | "ideal";

function lastAttemptMs(node: NodeInstance): number {
  if (node.attempts.length === 0) return 0;
  return attemptSpanMs(node.attempts[node.attempts.length - 1]) ?? 0;
}

function lastAttemptTokens(node: NodeInstance): number {
  if (node.attempts.length === 0) return 0;
  return attemptTokensOf(node.attempts[node.attempts.length - 1]);
}

/** DAG 最长路径（Kahn 拓扑 + 前驱完成时间取 max）；自环与未知端点跳过，含环返回 null。 */
function longestPathMs(
  ids: string[],
  edges: Array<[string, string]>,
  dur: Map<string, number>,
): number | null {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    adj.set(id, []);
    indeg.set(id, 0);
  }
  for (const [f, t] of edges) {
    if (f === t || !adj.has(f) || !adj.has(t)) continue;
    adj.get(f)!.push(t);
    indeg.set(t, (indeg.get(t) ?? 0) + 1);
  }
  const finish = new Map<string, number>();
  const queue: string[] = [];
  for (const id of ids) {
    if (indeg.get(id) === 0) {
      finish.set(id, dur.get(id) ?? 0);
      queue.push(id);
    }
  }
  let processed = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    processed += 1;
    for (const nxt of adj.get(cur)!) {
      finish.set(nxt, Math.max(finish.get(nxt) ?? 0, finish.get(cur) ?? 0));
      const left = (indeg.get(nxt) ?? 0) - 1;
      indeg.set(nxt, left);
      if (left === 0) {
        finish.set(nxt, (finish.get(nxt) ?? 0) + (dur.get(nxt) ?? 0));
        queue.push(nxt);
      }
    }
  }
  if (processed < ids.length) return null;
  return ids.reduce((m, id) => Math.max(m, finish.get(id) ?? 0), 0);
}

/** 单个视图域的模拟：nodeKeys 的实例按 nodeId 折叠后算最长路径。
 *  生成器实例的时长 = 其子视图（sub:<key>）的同宇宙模拟墙钟（递归 + memo）。
 *  overrideNodeIds：修复反事实——这些 nodeId 在 real 宇宙中改用「首试即过」
 *  时长（用于 leave-one-out 修复收益分析）。 */
function simScope(
  view: RunView,
  universe: Universe,
  byKey: Map<string, NodeInstance>,
  viewByParent: Map<string, RunView>,
  memo: Map<string, UniverseSummary>,
  overrideNodeIds: Set<string> | null,
): UniverseSummary {
  const memoKey = `${view.id}|${universe}|${overrideNodeIds ? [...overrideNodeIds].sort().join(",") : ""}`;
  const cached = memo.get(memoKey);
  if (cached) return cached;

  const instances = view.nodeKeys.map(k => byKey.get(k)).filter((n): n is NodeInstance => n !== undefined);
  // nodeId → 实例组（跨代折叠；回滚 = 同节点重跑）
  const byNodeId = new Map<string, NodeInstance[]>();
  for (const n of instances) {
    const list = byNodeId.get(n.nodeId) ?? [];
    list.push(n);
    byNodeId.set(n.nodeId, list);
  }

  const subOf = (gen: NodeInstance, effUniverse: Universe): UniverseSummary | null => {
    const sub = viewByParent.get(gen.key);
    return sub ? simScope(sub, effUniverse, byKey, viewByParent, memo, overrideNodeIds) : null;
  };

  const dur = new Map<string, number>();
  const tokens = new Map<string, number>();
  let busyMs = 0;
  let totalTokens = 0;
  for (const [nodeId, group] of byNodeId) {
    // 修复反事实：被 override 的 nodeId 在 real 宇宙里直接采用 ideal 时长
    const overridden = universe === "real" && (overrideNodeIds?.has(nodeId) ?? false);
    const eff: Universe = overridden ? "ideal" : universe;
    let d = 0;
    let t = 0;
    for (const n of group) {
      if (n.taskType === "generator") {
        const sub = subOf(n, eff);
        if (sub) {
          d += sub.wallMs ?? 0;
          t += sub.tokens;
        }
      } else if (eff === "real") {
        d += attemptWallMs(n) ?? nodeUsageOf(n)?.totalMs ?? 0;
        t += nodeUsageOf(n)?.totalTokens ?? 0;
      } else {
        d += lastAttemptMs(n);
        t += lastAttemptTokens(n);
      }
    }
    dur.set(nodeId, d);
    tokens.set(nodeId, t);
    busyMs += d;
    totalTokens += t;
  }

  const edges: Array<[string, string]> = [];
  for (const e of view.edges) edges.push([e.from, e.to]);
  for (const r of view.rollbackLinks) edges.push([r.from, r.to]);
  const collapse = (key: string): string | null => byKey.get(key)?.nodeId ?? null;
  const collapsed: Array<[string, string]> = [];
  for (const [f, t] of edges) {
    const cf = collapse(f);
    const ct = collapse(t);
    if (cf !== null && ct !== null) collapsed.push([cf, ct]);
  }

  const result: UniverseSummary = {
    wallMs: longestPathMs([...byNodeId.keys()], collapsed, dur),
    busyMs,
    tokens: totalTokens,
  };
  memo.set(memoKey, result);
  return result;
}

/** 平行宇宙对比：主图（意图管线）上现实 vs 首试即过。 */
export function simulateUniverses(vm: RunViewModel): UniversesResult {
  const main = vm.views[0];
  const byKey = new Map(vm.nodes.map(n => [n.key, n]));
  const viewByParent = new Map(vm.views.filter(v => v.parentKey !== null).map(v => [v.parentKey as string, v]));
  const memo = new Map<string, UniverseSummary>();
  const real = simScope(main, "real", byKey, viewByParent, memo, null);
  const ideal = simScope(main, "ideal", byKey, viewByParent, memo, null);
  return { real, ideal, cyclic: real.wallMs === null || ideal.wallMs === null };
}

/** 修复收益（leave-one-out 反事实）：假设单个 nodeId 的重试被消除（其余节点
 *  保持现状），run 模拟墙钟可提前的量。与浪费时长之差 = 该节点的浪费在并行
 *  分支中被吸收、不推迟完成时间的部分。无法模拟返回 null。 */
export function marginalSavingsOf(vm: RunViewModel, nodeIds: string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (nodeIds.length === 0) return out;
  const main = vm.views[0];
  const byKey = new Map(vm.nodes.map(n => [n.key, n]));
  const viewByParent = new Map(vm.views.filter(v => v.parentKey !== null).map(v => [v.parentKey as string, v]));
  const base = simScope(main, "real", byKey, viewByParent, new Map(), null);
  if (base.wallMs === null) {
    for (const id of nodeIds) out.set(id, null);
    return out;
  }
  for (const id of nodeIds) {
    const fixed = simScope(main, "real", byKey, viewByParent, new Map(), new Set([id]));
    out.set(id, fixed.wallMs === null ? null : Math.max(base.wallMs - fixed.wallMs, 0));
  }
  return out;
}
