// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 边几何引擎（纯函数）：链点正交化 + 平行段错开。view-model 产出
// edgeChains（源底 → 虚拟点 → 目标顶），本模块补齐渲染前最后两步几何。

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeGeom {
  id: string;
  pts: Pt[];
}

/** 链点正交化：相邻点 x 不同时在中点 y 插水平过渡（链点 → 纯横/竖交替
 *  折线；跳线检测/圆角化/错开均基于正交段语义） */
export function vChainPoints(pts: Pt[]): Pt[] {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (p.x !== q.x) {
      const midY = (p.y + q.y) / 2;
      out.push({ x: p.x, y: midY }, { x: q.x, y: midY });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const NUDGE_LANE = 3;           // 相邻错开档位步进（px）
const NUDGE_T = 14;             // 端点回归过渡段长（px）
const NUDGE_MIN_OVERLAP = 4;    // y 区间重叠阈值（小于视作擦肩）
const NUDGE_MIN_LEN = 3 * NUDGE_T + 8; // 可错开的最短段长（两过渡 + 中段余量）

/** 平行段错开（nudging）：不同边的共线垂直段 y 区间重叠时横向错开——
 *  束内按边 id 稳定序分配档位 0 / ±3 / ±6…交替展开，错开只发生在中段，
 *  两端以正交小折回归原锚点（端口/跳线/跑马灯几何不受影响）。
 *  完全同段（y1/y2 全同）视为汇聚主干的有意叠线，保留不动。
 *  段长不足（< 3×过渡 + 余量）不参与。 */
export function nudgeParallelRuns<T extends EdgeGeom>(edges: T[]): T[] {
  interface Seg {
    ei: number;
    si: number;
    x: number;
    y1: number;
    y2: number;
  }
  // 1. 垂直段清单（正交折线上 x 相邻同值即垂直段）
  const segs: Seg[] = [];
  edges.forEach((e, ei) => {
    for (let si = 0; si < e.pts.length - 1; si++) {
      const p = e.pts[si];
      const q = e.pts[si + 1];
      if (p.x !== q.x || p.y === q.y) continue;
      segs.push({ ei, si, x: p.x, y1: Math.min(p.y, q.y), y2: Math.max(p.y, q.y) });
    }
  });
  // 2. 同列分桶 → 重叠连通分量（区间相交超阈值且分属不同边）
  const byCol = new Map<number, Seg[]>();
  for (const s of segs) {
    if (!byCol.has(s.x)) byCol.set(s.x, []);
    byCol.get(s.x)!.push(s);
  }
  const patches = new Map<number, Map<number, number>>(); // ei → si → 档位
  for (const colSegs of byCol.values()) {
    const usable = colSegs.filter(s => s.y2 - s.y1 >= NUDGE_MIN_LEN);
    if (usable.length < 2) continue;
    // 并查集：重叠（不同边）连通
    const parent = usable.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        const A = usable[i];
        const B = usable[j];
        if (A.ei === B.ei) continue;
        if (Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1) > NUDGE_MIN_OVERLAP) {
          parent[find(i)] = find(j);
        }
      }
    }
    const comps = new Map<number, Seg[]>();
    usable.forEach((s, i) => {
      const root = find(i);
      if (!comps.has(root)) comps.set(root, []);
      comps.get(root)!.push(s);
    });
    for (const comp of comps.values()) {
      if (comp.length < 2) continue;
      // 完全同段（y1/y2 全同）= 汇聚主干叠线：整束保留
      const allIdentical = comp.every(s => s.y1 === comp[0].y1 && s.y2 === comp[0].y2);
      if (allIdentical) continue;
      // 档位分组：同 y 区间同档（整组一起动），组间按稳定序 0/+3/-3/+6…
      const groups = new Map<string, Seg[]>();
      for (const s of comp) {
        const gk = `${s.y1}:${s.y2}`;
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk)!.push(s);
      }
      const ordered = [...groups.values()].sort((a, b) => {
        const ka = `${edges[a[0].ei].id}:${a[0].y1}`;
        const kb = `${edges[b[0].ei].id}:${b[0].y1}`;
        return ka.localeCompare(kb);
      });
      ordered.forEach((group, gi) => {
        const lane = gi === 0 ? 0 : Math.ceil(gi / 2) * NUDGE_LANE * (gi % 2 === 1 ? 1 : -1);
        if (lane === 0) return;
        for (const s of group) {
          if (!patches.has(s.ei)) patches.set(s.ei, new Map());
          patches.get(s.ei)!.set(s.si, lane);
        }
      });
    }
  }
  // 3. 段替换：p→q 垂直段 → p →(x, y+T)→(x', y+T)→(x', y'-T)→(x, y'-T)→ q
  //    （正交小折，圆角化后与主干同风格；首尾锚点原样保留）
  return edges.map((e, ei) => {
    const bySeg = patches.get(ei);
    if (!bySeg || bySeg.size === 0) return e;
    const out: Pt[] = [];
    for (let si = 0; si < e.pts.length - 1; si++) {
      const p = e.pts[si];
      out.push(p);
      const lane = bySeg.get(si);
      if (lane === undefined) continue;
      const q = e.pts[si + 1];
      const yTop = Math.min(p.y, q.y);
      const yBot = Math.max(p.y, q.y);
      const t = Math.min(NUDGE_T, (yBot - yTop) / 3);
      out.push(
        { x: p.x, y: yTop + t },
        { x: p.x + lane, y: yTop + t },
        { x: p.x + lane, y: yBot - t },
        { x: p.x, y: yBot - t },
      );
    }
    out.push(e.pts[e.pts.length - 1]);
    return { ...e, pts: out };
  });
}

/** 段语义工具（测试口径）：正交折线的垂直段清单 */
export function verticalRuns(pts: Pt[]): Array<{ x: number; y1: number; y2: number }> {
  const out: Array<{ x: number; y1: number; y2: number }> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (p.x === q.x && p.y !== q.y) {
      out.push({ x: p.x, y1: Math.min(p.y, q.y), y2: Math.max(p.y, q.y) });
    }
  }
  return out;
}
