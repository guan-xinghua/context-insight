// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run DAG 图（纯 SVG，禁图表库——对齐 TraceView 风格；仓库铁律）。布局由
// view-model 预计算（代带 x / rank y），本组件只渲染：代带背景、同代依赖边
// （实线箭头）、回滚边（红虚线）、节点框（状态着色）、子图入口。

import type { NodeInstance, RunView } from "@/lib/run/view-model";

const NODE_W = 168;
const NODE_H = 48;

/** 状态 → 主色（描边/图标色；填充用同色 10% 透明，明暗两主题通用）。 */
const STATUS_COLOR: Record<string, string> = {
  passed: "#67bc45",
  failed: "#df4052",
  running: "#d89d25",
  pending: "#9ca3af",
  carried: "#0891b2",
  unknown: "#9ca3af",
};

const TASK_TYPE_LABEL: Record<NodeInstance["taskType"], string> = {
  agent: "agent",
  bash: "bash",
  generator: "生成器",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function bandLabel(generation: number): string {
  return generation === 0 ? "第 1 次运行" : `回滚 #${generation}`;
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
  onOpenSubgraph: (key: string) => void;
}) {
  const { layout } = view;
  const nodes = view.nodeKeys.map(k => nodesByKey.get(k)).filter((n): n is NodeInstance => n !== undefined);

  return (
    <svg
      width={Math.max(layout.width, 200)}
      height={layout.height}
      className="max-w-none select-none"
      role="img"
      aria-label={view.title}
    >
      <defs>
        <marker id="run-dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="currentColor" opacity="0.55" />
        </marker>
        <marker id="run-rollback-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="#df4052" />
        </marker>
      </defs>

      {/* 代带背景 + 标题 */}
      {layout.bands.map(band => (
        <g key={band.generation}>
          <rect
            x={band.x}
            y={8}
            width={band.width}
            height={layout.height - 16}
            rx={8}
            fill="currentColor"
            opacity={0.04}
          />
          <text x={band.x + 12} y={26} fontSize={11} fill="currentColor" opacity={0.65}>
            {band.label}
          </text>
        </g>
      ))}

      {/* 同代依赖边：源节点右缘 → 目标节点左缘 */}
      {view.edges.map(edge => {
        const a = layout.positions[edge.from];
        const b = layout.positions[edge.to];
        if (!a || !b) return null;
        return (
          <line
            key={`${edge.from}->${edge.to}`}
            x1={a.x + NODE_W}
            y1={a.y + NODE_H / 2}
            x2={b.x}
            y2={b.y + NODE_H / 2}
            stroke="currentColor"
            strokeOpacity={0.35}
            strokeWidth={1.2}
            markerEnd="url(#run-dep-arrow)"
          />
        );
      })}

      {/* 回滚边：红虚线（不参与拓扑分层） */}
      {view.rollbackLinks.map(link => {
        const a = layout.positions[link.from];
        const b = layout.positions[link.to];
        if (!a || !b) return null;
        const midX = (a.x + NODE_W + b.x) / 2;
        const midY = Math.min(a.y, b.y) - 8;
        return (
          <g key={`rb-${link.ordinal}-${link.from}->${link.to}`}>
            <path
              d={`M ${a.x + NODE_W / 2} ${a.y} Q ${midX} ${midY} ${b.x + NODE_W / 2} ${b.y}`}
              fill="none"
              stroke="#df4052"
              strokeWidth={1.4}
              strokeDasharray="5 4"
              markerEnd="url(#run-rollback-arrow)"
            />
            <text x={midX} y={midY + 2} fontSize={10} fill="#df4052" textAnchor="middle">
              {link.label}
            </text>
          </g>
        );
      })}

      {/* 节点 */}
      {nodes.map(node => {
        const pos = layout.positions[node.key];
        if (!pos) return null;
        const color = STATUS_COLOR[node.status] ?? STATUS_COLOR.unknown;
        const selected = selectedKey === node.key;
        const retries = Math.max(node.attempts.length - 1, 0);
        return (
          <g
            key={node.key}
            transform={`translate(${pos.x}, ${pos.y})`}
            onClick={() => onSelectNode(node.key)}
            className="cursor-pointer"
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={6}
              fill={color}
              fillOpacity={node.executionState === "carried" ? 0.05 : 0.1}
              stroke={color}
              strokeWidth={selected ? 2.2 : 1.2}
              strokeDasharray={node.executionState === "carried" ? "4 3" : undefined}
            />
            {selected ? (
              <rect x={-2} y={-2} width={NODE_W + 4} height={NODE_H + 4} rx={7} fill="none" stroke="currentColor" strokeOpacity={0.5} strokeWidth={0.8} />
            ) : null}
            <text x={9} y={19} fontSize={12} fontWeight={600} fill="currentColor">
              {truncate(node.label, 17)}
            </text>
            <text x={9} y={35} fontSize={10} fill="currentColor" opacity={0.7}>
              {node.status}
              {" · "}
              {TASK_TYPE_LABEL[node.taskType]}
              {retries > 0 ? ` · 重试 ${retries}` : ""}
            </text>
            {/* 子图入口：生成器节点右上角 */}
            {node.hasSubgraph ? (
              <g
                transform={`translate(${NODE_W - 40}, 4)`}
                onClick={e => {
                  e.stopPropagation();
                  onOpenSubgraph(node.key);
                }}
              >
                <rect width={34} height={14} rx={3} fill="#8b5cf6" fillOpacity={0.18} stroke="#8b5cf6" strokeWidth={0.8} />
                <text x={17} y={10.5} fontSize={9} fill="#8b5cf6" textAnchor="middle">
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
