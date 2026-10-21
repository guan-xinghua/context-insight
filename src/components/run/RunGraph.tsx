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
import { nudgeParallelRuns, vChainPoints } from "@/lib/run/edge-geometry";
import { memo, useId } from "react";
import { RUN_COLORS, METRIC_EMPTY, NODE_STROKE_WIDTH, NODE_STROKE_WIDTH_SELECTED, STATUS_TINT_OPACITY, WATER_BAND_OPACITY, WATER_COLOR, WATER_CRITICAL_PCT, flowColor, metricColor, metricTintOpacity, redundancyColor, redundancyTint, statusColor } from "@/components/run/run-theme";
import { lensBoundaries, lensFixedBoundaries, lensRank, lensValue, lensValueText, nodeUsageOf, type LensKey } from "@/lib/run/run-metrics";

export { bandLabel } from "@/components/run/run-theme";

const NODE_W = 168;
const NODE_H = 48;

/** 水位透镜的「容器注水」：节点盒即容器，上下文峰值即水深。水面微波荡漾
 *  （SMIL 位移，相位按节点错开避免整齐划一的机械感），80% 红色警戒线常显，
 *  水漫过线即逼限。纯 SVG；clip 到盒内，波幅不会溢出圆角。 */
function NodeWater({ pct, phase, clipId }: { pct: number; phase: number; clipId: string }) {
  const clamped = Math.max(Math.min(pct, 100), 1);
  const surfaceY = NODE_H * (1 - clamped / 100);
  const opacity = clamped >= WATER_CRITICAL_PCT
    ? WATER_BAND_OPACITY.deep
    : clamped >= 50 ? WATER_BAND_OPACITY.mid : WATER_BAND_OPACITY.shallow;
  const a = 1.6;
  const wave = `M 0 ${surfaceY} C ${NODE_W * 0.25} ${surfaceY - a} ${NODE_W * 0.25} ${surfaceY - a} ${NODE_W / 2} ${surfaceY} C ${NODE_W * 0.75} ${surfaceY + a} ${NODE_W * 0.75} ${surfaceY + a} ${NODE_W} ${surfaceY}`;
  const body = `${wave} L ${NODE_W} ${NODE_H + 2} L 0 ${NODE_H + 2} Z`;
  return (
    <g clipPath={`url(#${clipId})`}>
      <defs>
        <clipPath id={clipId}>
          <rect width={NODE_W} height={NODE_H} rx={11} />
        </clipPath>
      </defs>
      <g className="run-node-water">
        <animateTransform
          attributeName="transform"
          type="translate"
          values="0 0; 0 1.3; 0 0"
          keyTimes="0; 0.5; 1"
          calcMode="spline"
          keySplines="0.45 0 0.55 1; 0.45 0 0.55 1"
          dur="3.8s"
          begin={`${phase}s`}
          repeatCount="indefinite"
        />
        <path d={body} fill={WATER_COLOR} fillOpacity={opacity} />
        <path d={wave} fill="none" stroke={WATER_COLOR} strokeOpacity={0.7} strokeWidth={1.1} />
      </g>
      <line
        className="run-water-line"
        x1={0}
        x2={NODE_W}
        y1={NODE_H * (1 - WATER_CRITICAL_PCT / 100)}
        y2={NODE_H * (1 - WATER_CRITICAL_PCT / 100)}
        stroke="#cf222e"
        strokeOpacity={0.5}
        strokeWidth={1}
        strokeDasharray="3 2.5"
      />
    </g>
  );
}

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

export const RunGraph = memo(function RunGraph({
  view,
  nodesByKey,
  selectedKey,
  onSelectNode,
  onOpenSubgraph,
  lens = "status",
  svgRef,
}: {
  view: RunView;
  nodesByKey: Map<string, NodeInstance>;
  selectedKey: string | null;
  onSelectNode: (key: string) => void;
  onOpenSubgraph?: (key: string) => void;
  /** 指标透镜：status = 状态着色（默认）；其余按节点会话用量分位着色 */
  lens?: LensKey;
  /** SVG 根元素引用（RunCanvas 相机模型持有：手势落定后按显示分辨率
   *  重设 width/height，矢量重栅格保证任意缩放下清晰） */
  svgRef?: React.RefObject<SVGSVGElement | null>;
}) {
  const { layout } = view;
  const nodes = view.nodeKeys.map(k => nodesByKey.get(k)).filter((n): n is NodeInstance => n !== undefined);
  const hasSel = selectedKey !== null;
  const dotId = `run-dots-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const contentW = Math.max(layout.width, 200);

  // 指标透镜：节点用量 → 边界 → 逐节点取色。水位走绝对阈值（50/80——健康
  // 区间与分布无关），其余按全图分位。无会话数据节点灰描边（状态仍由左侧
  // 圆点表达，不丢信息）
  const metricLens = lens !== "status";
  const usageByKey = new Map(nodes.map(n => [n.key, nodeUsageOf(n)]));
  const fixed = lensFixedBoundaries(lens);
  const boundaries = metricLens
    ? fixed ?? lensBoundaries(nodes.flatMap(n => {
        const u = usageByKey.get(n.key) ?? null;
        const v = u !== null ? lensValue(lens, u) : null;
        return v === null ? [] : [v];
      }))
    : [];

  // 边折线（依赖 + 回滚）先统一计算，再收集 PCB 交叉跳线，最后渲染——
  // 跳线在 base 与流光叠加层共享同一条 d
  const depGeoms = view.edgeChains.flatMap(chain => {
    const a = layout.positions[chain.from];
    const b = layout.positions[chain.to];
    if (!a || !b) return [];
    // 端口偏移：扇出/扇入 ≥3 时锚点沿节点缘错开（view-model 7e），缺省中心
    const pts = vChainPoints([
      { x: a.x + NODE_W / 2 + (chain.fromDx ?? 0), y: a.y + NODE_H },
      ...chain.bends,
      { x: b.x + NODE_W / 2 + (chain.toDx ?? 0), y: b.y },
    ]);
    return [{ id: `dep:${chain.from}->${chain.to}`, chain, pts }];
  });
  // 平行段错开：共线重叠的垂直段横向错开（主干全同叠线保留）——在跳线
  // 检测前应用，跳线按错开后的最终几何计算
  const depNudged = nudgeParallelRuns(depGeoms);
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
  const hops = collectHops([...depNudged, ...rbGeoms], HOP_R + 5);
  const hopsOf = (id: string, pts: Array<{ x: number; y: number }>) =>
    pts.slice(0, -1).map((_, i) => hops.get(`${id}:${i}`) ?? []);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${contentW} ${layout.height}`}
      className="block max-w-none select-none"
      role="img"
      aria-label={view.title}
    >
      <defs>
        {/* 点阵网格底：pattern 随 viewBox 矢量缩放——任意缩放档位下不糊（此
            前 CSS 背景挂 DOM 层，与 SVG 缩放档位脱钩）。双层透明度：主点阵
            之外叠半幅加密点（角点 0.5x 透明度），细密而不喧宾夺主 */}
        <pattern id={dotId} width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="12" cy="12" r="0.9" fill="rgba(27, 31, 36, 0.07)" />
          <circle cx="0" cy="0" r="0.9" fill="rgba(27, 31, 36, 0.035)" />
          <circle cx="24" cy="0" r="0.9" fill="rgba(27, 31, 36, 0.035)" />
          <circle cx="0" cy="24" r="0.9" fill="rgba(27, 31, 36, 0.035)" />
          <circle cx="24" cy="24" r="0.9" fill="rgba(27, 31, 36, 0.035)" />
        </pattern>
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

      {/* 点阵底：四边外扩 2000，平移/缩放过程中网格始终铺满视野 */}
      <rect x={-2000} y={-2000} width={contentW + 4000} height={layout.height + 4000} fill={`url(#${dotId})`} />

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
      {depNudged.map(({ id, chain, pts }) => {
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

      {/* 节点：暗底卡 + 状态描边/圆点 + 主/次两行文本。指标透镜下描边改为用量
          分位着色（无数据灰描边），副标第二段换成用量缩写，状态圆点保留 */}
      {nodes.map((node, idx) => {
        const pos = layout.positions[node.key];
        if (!pos) return null;
        const usage = metricLens ? usageByKey.get(node.key) ?? null : null;
        const metricVal = usage !== null ? lensValue(lens, usage) : null;
        // 冗余透镜走独立三档色（绿/琥珀/红，低分警示）——与用量透镜的「越深
        // 越多」蓝阶方向相反，复用 metricColor 会把「最糙」染成最浅色
        const color = !metricLens
          ? statusColor(node.status)
          : metricVal === null ? METRIC_EMPTY
          : lens === "redundancy" ? redundancyColor(metricVal)
          : metricColor(lensRank(boundaries, metricVal), boundaries.length);
        // 面积信号：程度靠染色面积传达（细描边肉眼难分档）。水位透镜例外——
        // 水体本身就是面积信号，盒底保持中性；无数据节点不染色
        const tint = !metricLens
          ? { opacity: STATUS_TINT_OPACITY }
          : metricVal === null || lens === "context" ? null
          : lens === "redundancy"
            ? { opacity: redundancyTint(metricVal) }
            : { opacity: metricTintOpacity(lensRank(boundaries, metricVal), boundaries.length) };
        const selected = selectedKey === node.key;
        const retries = Math.max(node.attempts.length - 1, 0);
        const carried = node.executionState === "carried";
        const subText = metricLens && usage !== null && metricVal !== null
          ? `${TASK_TYPE_LABEL[node.taskType]} · ${lensValueText(lens, usage)}`
          : `${TASK_TYPE_LABEL[node.taskType]}${retries > 0 ? ` · 重试 ${retries}` : ""}${carried ? " · 承接" : ""}`;
        return (
          <g
            key={node.key}
            transform={`translate(${pos.x}, ${pos.y})`}
            onClick={() => onSelectNode(node.key)}
            className="run-node cursor-pointer"
          >
            {selected ? (
              <>
                {/* 玻璃高光外圈：双层同心光晕（透镜/状态色随行），保留盒体
                    描边加粗——选中态从「线变粗」升级为「发光体」 */}
                <rect x={-4.5} y={-4.5} width={NODE_W + 9} height={NODE_H + 9} rx={15.5} fill="none" stroke={color} strokeOpacity={0.32} strokeWidth={1.5} />
                <rect x={-9} y={-9} width={NODE_W + 18} height={NODE_H + 18} rx={20} fill="none" stroke={color} strokeOpacity={0.12} strokeWidth={2.5} />
              </>
            ) : null}
            <rect
              className="run-node-box"
              width={NODE_W}
              height={NODE_H}
              rx={11}
              fill={tint !== null ? color : RUN_COLORS.nodeFill}
              fillOpacity={tint !== null ? tint.opacity : undefined}
              stroke={color}
              strokeOpacity={selected ? 1 : 0.9}
              strokeWidth={selected ? NODE_STROKE_WIDTH_SELECTED : NODE_STROKE_WIDTH}
              strokeDasharray={carried ? "4 3" : undefined}
            />
            {lens === "context" && metricVal !== null ? (
              <NodeWater pct={metricVal} phase={(idx % 5) * 0.75} clipId={`water-${node.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`} />
            ) : null}
            <circle cx={14} cy={17.5} r={3.5} fill={statusColor(node.status)} />
            <text x={24} y={21.5} fontSize={13} fontWeight={600} fill={RUN_COLORS.textPrimary}>
              {truncate(node.label, 17)}
            </text>
            <text x={24} y={37.5} fontSize={10.5} fill={RUN_COLORS.textMuted} letterSpacing="0.01em">
              {subText}
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
});
