// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run DAG 图（纯 SVG，禁图表库——仓库铁律）。布局由 view-model 预计算（rank
// y / 代带 x：带内依赖自上而下流，代带为纵向列），本组件只渲染：代带条带、
// 同代依赖边（源底 → 虚拟点 → 目标顶的正交走线，水平过渡只进行间隙）、回滚
// 边（跨带正交虚线 + 暗底 chip 标签）、节点（暗底卡 + 状态圆点）。色板见
// run-theme.ts。
//
// 交互语义：跑马灯按需点亮——默认全部静止，选中节点后其关联边（直接连出/
// 连入）以状态色加粗 + 白色蚂蚁线流动，其余边压暗；回滚虚线爬行同理。走线
// 交叉处做 PCB 式半圆跳线（水平段跳过垂直段），表达「交叉不相连」。

import type { NodeInstance, RunView } from "@/lib/run/view-model";
import { RUN_COLORS, flowColor, statusColor } from "@/components/run/run-theme";

export { bandLabel } from "@/components/run/run-theme";

const NODE_W = 168;
const NODE_H = 48;

const TASK_TYPE_LABEL: Record<NodeInstance["taskType"], string> = {
  agent: "agent",
  bash: "bash",
  generator: "生成器",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const HOP_R = 4.5;

interface Pt {
  x: number;
  y: number;
}

/** PCB 式交叉跳线收集：不同边的水平段与垂直段相交时，水平段在交叉点做
 *  半圆突起（垂直段直行）——「交叉不相连」的电路图语义。段端保护带
 *  （margin）内不放跳线（避开节点锚点与拐角 fillet），端点重合处是汇聚
 *  连接而非交叉；同段多个跳线保持间距。返回 `${edgeId}:${段索引}` →
 *  跳线位置列表（距段起点距离）。 */
function collectHops(edges: Array<{ id: string; pts: Pt[] }>, margin: number): Map<string, number[]> {
  const raw = new Map<string, number[]>();
  for (let a = 0; a < edges.length; a++) {
    for (let b = a + 1; b < edges.length; b++) {
      for (let i = 0; i < edges[a].pts.length - 1; i++) {
        const s1 = edges[a].pts[i];
        const e1 = edges[a].pts[i + 1];
        if (s1.x === e1.x && s1.y === e1.y) continue;
        for (let j = 0; j < edges[b].pts.length - 1; j++) {
          const s2 = edges[b].pts[j];
          const e2 = edges[b].pts[j + 1];
          if (s2.x === e2.x && s2.y === e2.y) continue;
          const h1 = s1.y === e1.y;
          const h2 = s2.y === e2.y;
          if (h1 === h2) continue; // 平行（含共享主干的共线重叠——连接而非交叉）
          const hs = h1 ? [s1, e1] : [s2, e2];
          const vs = h1 ? [s2, e2] : [s1, e1];
          const owner = h1 ? edges[a] : edges[b];
          const segIdx = h1 ? i : j;
          const x = vs[0].x;
          const y = hs[0].y;
          const hxMin = Math.min(hs[0].x, hs[1].x);
          const hxMax = Math.max(hs[0].x, hs[1].x);
          const vyMin = Math.min(vs[0].y, vs[1].y);
          const vyMax = Math.max(vs[0].y, vs[1].y);
          if (x <= hxMin + 0.5 || x >= hxMax - 0.5 || y <= vyMin + 0.5 || y >= vyMax - 0.5) continue;
          const dist = Math.abs(x - hs[0].x);
          const len = hxMax - hxMin;
          if (dist < margin || dist > len - margin) continue;
          const key = `${owner.id}:${segIdx}`;
          const list = raw.get(key) ?? [];
          list.push(dist);
          raw.set(key, list);
        }
      }
    }
  }
  const hops = new Map<string, number[]>();
  for (const [key, list] of raw) {
    list.sort((p, q) => p - q);
    const kept: number[] = [];
    for (const d of list) {
      if (kept.length === 0 || d - kept[kept.length - 1] >= 2 * HOP_R + 1) kept.push(d);
    }
    hops.set(key, kept);
  }
  return hops;
}

/** 折线圆角化 + 段内跳线：拐点用小二次曲线 fillet（r≈4px，非曲线走线）；
 *  hopsBySeg 为跳线位置（距段起点距离），以半圆弧 A 命令突起。 */
function roundedPolyline(pts: Array<{ x: number; y: number }>, r = 4, hopsBySeg: number[][] = []): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 0.01) continue;
    const ux = (q.x - p.x) / len;
    const uy = (q.y - p.y) / len;
    const at = (t: number) => `${p.x + ux * t} ${p.y + uy * t}`;
    let endCut = 0;
    let outLen = 0;
    if (i < pts.length - 2) {
      const next = pts[i + 2];
      outLen = Math.hypot(next.x - q.x, next.y - q.y);
      endCut = Math.min(r, len / 2, outLen / 2);
    }
    const hops = (hopsBySeg[i] ?? [])
      .filter(h => h - HOP_R > 4 && h + HOP_R < len - endCut)
      .sort((x, y) => x - y);
    for (const h of hops) {
      d += ` L ${at(h - HOP_R)} A ${HOP_R} ${HOP_R} 0 0 1 ${at(h + HOP_R)}`;
    }
    d += ` L ${at(len - endCut)}`;
    if (endCut >= 0.5) {
      const next = pts[i + 2];
      const ox = (next.x - q.x) / (outLen || 1);
      const oy = (next.y - q.y) / (outLen || 1);
      d += ` Q ${q.x} ${q.y} ${q.x + ox * endCut} ${q.y + oy * endCut}`;
    }
  }
  return d;
}

/** 纵向链正交走线：源底 → 虚拟点 → 目标顶。水平过渡只发生在相邻行的间隙
 *  （midY 恒落进行间隙），垂直段沿虚拟窄道下行——全程不穿节点。 */
function vChainPoints(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
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

/** 横向正交走线（回滚边跨带）：源右缘 → 带隙中竖 → 目标左缘。 */
function hChainPoints(sx: number, sy: number, tx: number, ty: number): Array<{ x: number; y: number }> {
  if (Math.abs(sy - ty) < 1) return [{ x: sx, y: sy }, { x: tx, y: ty }];
  const midX = (sx + tx) / 2;
  return [
    { x: sx, y: sy },
    { x: midX, y: sy },
    { x: midX, y: ty },
    { x: tx, y: ty },
  ];
}

export function RunGraph({
  view,
  nodesByKey,
  selectedKey,
  onSelectNode,
  onOpenSubgraph,
}: {
  view: RunView;
  nodesByKey: Map<string, NodeInstance>;
  selectedKey: string | null;
  onSelectNode: (key: string) => void;
  onOpenSubgraph?: (key: string) => void;
}) {
  const { layout } = view;
  const nodes = view.nodeKeys.map(k => nodesByKey.get(k)).filter((n): n is NodeInstance => n !== undefined);
  const hasSel = selectedKey !== null;

  // 边折线（依赖 + 回滚）先统一计算，再收集 PCB 交叉跳线，最后渲染——
  // 跳线在 base 与流光叠加层共享同一条 d
  const depGeoms = view.edgeChains.flatMap(chain => {
    const a = layout.positions[chain.from];
    const b = layout.positions[chain.to];
    if (!a || !b) return [];
    const pts = vChainPoints([
      { x: a.x + NODE_W / 2, y: a.y + NODE_H },
      ...chain.bends,
      { x: b.x + NODE_W / 2, y: b.y },
    ]);
    return [{ id: `dep:${chain.from}->${chain.to}`, chain, pts }];
  });
  const rbGeoms = view.rollbackLinks.flatMap(link => {
    const a = layout.positions[link.from];
    const b = layout.positions[link.to];
    if (!a || !b) return [];
    let pts: Array<{ x: number; y: number }>;
    if (b.x > a.x + NODE_W + 8) {
      pts = hChainPoints(a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + NODE_H / 2);
    } else {
      const topY = Math.min(a.y, b.y) - 18;
      pts = [
        { x: a.x + NODE_W / 2, y: a.y },
        { x: a.x + NODE_W / 2, y: topY },
        { x: b.x + NODE_W / 2, y: topY },
        { x: b.x + NODE_W / 2, y: b.y },
      ];
    }
    return [{ id: `rb:${link.ordinal}`, link, pts }];
  });
  const hops = collectHops([...depGeoms, ...rbGeoms], HOP_R + 5);
  const hopsOf = (id: string, pts: Array<{ x: number; y: number }>) =>
    pts.slice(0, -1).map((_, i) => hops.get(`${id}:${i}`) ?? []);

  return (
    <svg
      width={Math.max(layout.width, 200)}
      height={layout.height}
      className="block max-w-none select-none"
      role="img"
      aria-label={view.title}
    >
      <defs>
        <marker id="run-dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill={RUN_COLORS.edge} />
        </marker>
        {/* 选中态箭头随目标状态着色（状态值均为字母，id 安全） */}
        {[...new Set(nodes.map(n => n.status))].map(st => (
          <marker key={st} id={`run-dep-arrow-${st}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill={flowColor(st)} />
          </marker>
        ))}
        <marker id="run-rollback-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill={RUN_COLORS.rollback} />
        </marker>
      </defs>

      {/* 代带列：纵向条带（代际左→右）；标签在带顶（回滚带带红点） */}
      {layout.bands.map(band => {
        const isRollback = band.generation > 0;
        return (
          <g key={band.generation}>
            <rect
              x={band.x}
              y={8}
              width={band.width}
              height={layout.height - 16}
              rx={10}
              fill={isRollback ? RUN_COLORS.rollback : RUN_COLORS.textPrimary}
              fillOpacity={isRollback ? 0.028 : 0.015}
            />
            {isRollback ? (
              <circle cx={band.x + 19} cy={21.5} r={3} fill={RUN_COLORS.rollback} fillOpacity={0.8} />
            ) : null}
            <text
              x={band.x + (isRollback ? 28 : 14)}
              y={25}
              fontSize={11}
              fill={isRollback ? RUN_COLORS.rollback : RUN_COLORS.textMuted}
              fillOpacity={0.9}
              letterSpacing="0.02em"
            >
              {band.label}
            </text>
          </g>
        );
      })}

      {/* 同代依赖边链：正交走线（源底 → 虚拟点 → 目标顶，水平过渡只进行间隙）。
          跑马灯按需点亮：默认静止，选中节点后其关联边以状态色加粗 + 白色
          蚂蚁线流动（运行中提速），其余边压暗；交叉处 PCB 半圆跳线 */}
      {depGeoms.map(({ id, chain, pts }) => {
        const target = nodesByKey.get(chain.to);
        const flow = target ? flowColor(target.status) : RUN_COLORS.flow;
        const active = target?.status === "running";
        const related = hasSel && (chain.from === selectedKey || chain.to === selectedKey);
        const d = roundedPolyline(pts, 4, hopsOf(id, pts));
        return (
          <g key={id} className="run-edge" opacity={hasSel && !related ? 0.35 : 1}>
            <path
              className="run-dep"
              d={d}
              fill="none"
              stroke={related ? flow : RUN_COLORS.edge}
              strokeWidth={related ? 2 : 1.25}
              markerEnd={related && target ? `url(#run-dep-arrow-${target.status})` : "url(#run-dep-arrow)"}
            />
            {related ? (
              <path
                d={d}
                fill="none"
                className={active ? "run-edge-flow run-edge-flow-active" : "run-edge-flow"}
                stroke={RUN_COLORS.canvas}
                strokeWidth={1.6}
              />
            ) : null}
          </g>
        );
      })}

      {/* 回滚边：目标带在右 → 正交跨带（源右缘 → 带隙竖转 → 目标左缘）；
          同带异常数据兜底上绕。虚线爬行只在选中关联时点亮，chip 标签挂
          路径中点 */}
      {rbGeoms.map(({ id, link, pts }) => {
        const related = hasSel && (link.from === selectedKey || link.to === selectedKey);
        const d = roundedPolyline(pts, 4, hopsOf(id, pts));
        const mid = pts.length === 2
          ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
          : { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 };
        const chipW = link.label.length * 6.2 + 18;
        return (
          <g key={id} className="run-rb" opacity={hasSel && !related ? 0.35 : 1}>
            <path
              d={d}
              fill="none"
              stroke={RUN_COLORS.rollback}
              strokeWidth={related ? 1.8 : 1.4}
              strokeDasharray="5 4"
              className={related ? "run-rb-flow" : undefined}
              markerEnd="url(#run-rollback-arrow)"
            />
            <rect
              x={mid.x - chipW / 2}
              y={mid.y - 14}
              width={chipW}
              height={17}
              rx={8.5}
              fill={RUN_COLORS.canvas}
              stroke={RUN_COLORS.rollback}
              strokeOpacity={0.45}
              strokeWidth={1}
            />
            <text x={mid.x} y={mid.y - 2} fontSize={9.5} fill={RUN_COLORS.rollback} textAnchor="middle">
              {link.label}
            </text>
          </g>
        );
      })}

      {/* 节点：暗底卡 + 状态描边/圆点 + 主/次两行文本 */}
      {nodes.map(node => {
        const pos = layout.positions[node.key];
        if (!pos) return null;
        const color = statusColor(node.status);
        const selected = selectedKey === node.key;
        const retries = Math.max(node.attempts.length - 1, 0);
        const carried = node.executionState === "carried";
        return (
          <g
            key={node.key}
            transform={`translate(${pos.x}, ${pos.y})`}
            onClick={() => onSelectNode(node.key)}
            className="run-node cursor-pointer"
          >
            {selected ? (
              <rect x={-3.5} y={-3.5} width={NODE_W + 7} height={NODE_H + 7} rx={9.5} fill="none" stroke={RUN_COLORS.textPrimary} strokeOpacity={0.22} strokeWidth={1} />
            ) : null}
            <rect
              className="run-node-box"
              width={NODE_W}
              height={NODE_H}
              rx={7}
              fill={RUN_COLORS.nodeFill}
              stroke={color}
              strokeOpacity={selected ? 1 : 0.55}
              strokeWidth={selected ? 1.6 : 1}
              strokeDasharray={carried ? "4 3" : undefined}
            />
            <circle cx={14} cy={17.5} r={3.5} fill={color} />
            <text x={24} y={21.5} fontSize={12.5} fontWeight={600} fill={RUN_COLORS.textPrimary}>
              {truncate(node.label, 17)}
            </text>
            <text x={24} y={37.5} fontSize={10.5} fill={RUN_COLORS.textMuted} letterSpacing="0.01em">
              {TASK_TYPE_LABEL[node.taskType]}
              {retries > 0 ? ` · 重试 ${retries}` : ""}
              {carried ? " · 承接" : ""}
            </text>
            {/* 子图入口：生成器节点右上角（未提供入口回调时不渲染——子图弹窗内画布无嵌套入口） */}
            {node.hasSubgraph && onOpenSubgraph ? (
              <g
                transform={`translate(${NODE_W - 44}, 5)`}
                onClick={e => {
                  e.stopPropagation();
                  onOpenSubgraph(node.key);
                }}
              >
                <rect width={38} height={15} rx={7.5} fill={RUN_COLORS.accent} fillOpacity={0.14} stroke={RUN_COLORS.accent} strokeOpacity={0.6} strokeWidth={0.9} />
                <text x={19} y={11} fontSize={9} fill={RUN_COLORS.accent} textAnchor="middle">
                  子图 ▸
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
