// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run Trace 时间轴（纯 SVG，禁图表库——仓库铁律）：把整个 Run 摊在真实时间
// 轴上做系统级观测——每条成员会话是一根横条（x = 真实起止，颜色 = 尝试状态，
// 执行条实心 / 验收条描边淡填充），按节点分泳道、按尝试叠行。顶部摘要栏回答
// 系统级问题：墙钟多少、Σ会话多少、平均并发多高、重试/验收开销占多大——
// 「这次 Run 的两个小时花在哪」。泳道条可点击选中节点（与结构图、侧栏联动）。

import { useEffect, useRef, useState } from "react";
import type { NodeInstance, RunView } from "@/lib/run/view-model";
import { RUN_COLORS, statusColor, TIME_COMPOSE } from "@/components/run/run-theme";
import { compactTokens, formatDurationMs, runUsageOf } from "@/lib/run/run-metrics";

const LABEL_W = 176;
const MIN_TIME_W = 900;   // 时间区保底宽度（窄容器时横向滚动）
const HEADER_H = 26;   // 时间刻度行
const ROW_H = 16;      // 尝试行高（执行条 8px + 验收条 4.5px 叠行）
const LANE_PAD_Y = 7;

const TICK_STEPS = [
  30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000,
  3_600_000, 7_200_000, 14_400_000, 43_200_000, 86_400_000,
];

interface TraceBar {
  key: string;
  role: "execute" | "verify";
  attempt: number;
  status: string;
  start: number;
  end: number;
  tokens: number;
  turns: number;
}

interface TraceLane {
  node: NodeInstance;
  bars: TraceBar[];
  height: number;
  rows: Array<{ ordinal: number; bars: TraceBar[] }>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toTs(iso: string | null): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function shortClock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fullClock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${shortClock(t)}`;
}

export function RunTrace({
  view,
  nodesByKey,
  selectedKey,
  onSelectNode,
}: {
  view: RunView;
  nodesByKey: Map<string, NodeInstance>;
  selectedKey: string | null;
  onSelectNode: (key: string) => void;
}) {
  const viewNodes = view.nodeKeys
    .map(k => nodesByKey.get(k))
    .filter((n): n is NodeInstance => n !== undefined);

  // 自适应宽度：时间区拉满容器（ResizeObserver），未测得/窄容器时保底横向滚动
  const scrollRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setBoxW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 泳道构建：仅渲染有会话时间数据的节点（时间轴关心过程，未运行/无会话节点不占行）
  const lanes: TraceLane[] = [];
  for (const node of viewNodes) {
    const bars: TraceBar[] = [];
    for (const a of node.attempts) {
      for (const m of [a.executeMember, a.verifyMember]) {
        if (!m?.session) continue;
        const st = toTs(m.session.startTime);
        if (st === null) continue;
        const enRaw = toTs(m.session.endTime);
        const en = enRaw !== null && enRaw >= st ? enRaw : st + (m.session.durationMs ?? 0);
        if (en <= st) continue;
        bars.push({
          key: `${node.key}:${a.ordinal}:${m.role}`,
          role: m.role,
          attempt: a.ordinal,
          status: a.status,
          start: st,
          end: en,
          tokens: m.session.totalTokens,
          turns: m.session.turns,
        });
      }
    }
    if (bars.length === 0) continue;
    bars.sort((x, y) => x.start - y.start || x.attempt - y.attempt);
    const rows: TraceLane["rows"] = [];
    for (const b of bars) {
      const row = rows.find(r => r.ordinal === b.attempt);
      if (row) row.bars.push(b);
      else rows.push({ ordinal: b.attempt, bars: [b] });
    }
    rows.sort((x, y) => x.ordinal - y.ordinal);
    lanes.push({ node, bars, rows, height: rows.length * ROW_H + 2 * LANE_PAD_Y });
  }
  lanes.sort((a, b) => a.bars[0].start - b.bars[0].start);

  const usage = runUsageOf(viewNodes);
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  const composeParts = usage.busyMs > 0
    ? ([
        { key: "exec", label: "执行", ms: usage.execMs, color: TIME_COMPOSE.exec },
        { key: "verify", label: "验收", ms: usage.verifyMs, color: TIME_COMPOSE.verify },
        { key: "gap", label: "间隙", ms: usage.gapMs, color: TIME_COMPOSE.gap },
        { key: "wait", label: "重试等待", ms: usage.waitMs, color: TIME_COMPOSE.wait },
      ] as const).filter(p => p.ms > 0)
    : [];
  const summary: Array<{ label: string; value: string; tip: string; compose?: typeof composeParts }> = [
    { label: "墙钟", value: usage.wallMs !== null ? formatDurationMs(usage.wallMs) : "—", tip: "最早会话开始 → 最晚会话结束" },
    { label: "Σ时长", value: formatDurationMs(usage.busyMs), tip: "各节点时长之和（含派发间隙与重试等待，与节点侧栏/时长透镜同口径）" },
    { label: "并行度", value: usage.parallelism !== null ? usage.parallelism.toFixed(1) : "—", tip: "Σ时长 ÷ 墙钟（平均并发数，>1 即存在并行）" },
    { label: "重试开销", value: pct(usage.retryShare), tip: "失败尝试的时长占 Σ时长 比例（不含其后的重试等待）" },
    {
      label: "峰值水位",
      value: usage.contextPeakPct !== null ? `${Math.round(usage.contextPeakPct)}%` : "—",
      tip: "成员会话的上下文窗口峰值占用（≥80% 逼限：易遗忘指令、复读旧错——考虑拆分任务或压缩上下文）",
    },
    {
      label: "构成",
      value: composeParts.length > 0
        ? composeParts.map(p => `${p.label} ${Math.round((p.ms / usage.busyMs) * 100)}%`).join(" · ")
        : "—",
      tip: "Σ时长的时间构成：执行会话 / 验收会话 / 间隙（执行→验收派发）/ 重试等待（尝试之间）；零值不展示",
      compose: composeParts.length > 0 ? composeParts : undefined,
    },
  ];

  if (lanes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <p className="text-xs text-[#8c959f]">
          暂无会话时间数据（成员未导入，或本图节点均为脚本/进程成员）——导入 bundle 会话后可见时间轴
        </p>
      </div>
    );
  }

  // 时间域（至少 1 分钟跨度，避免零宽）
  const t0 = Math.min(...lanes.flatMap(l => l.bars.map(b => b.start)));
  const t1 = Math.max(...lanes.flatMap(l => l.bars.map(b => b.end)));
  const span = Math.max(t1 - t0, 60_000);
  const timeW = boxW !== null ? Math.max(Math.floor(boxW) - LABEL_W, MIN_TIME_W) : MIN_TIME_W;
  const svgW = LABEL_W + timeW;
  const xOf = (t: number) => LABEL_W + ((t - t0) / span) * timeW;

  // 自适应刻度（≤7 根），跨度 ≥1 天带日期
  const step = TICK_STEPS.find(s => span / s <= 7) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  const withDate = span >= 86_400_000;
  const totalH = HEADER_H + lanes.reduce((s, l) => s + l.height, 0) + 12;

  return (
    <div className="run-trace flex h-full w-full min-w-0 flex-col">
      {/* 摘要栏：系统级指标（时间花在哪） */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-3.5 pt-2.5 text-[11px] leading-5">
        {summary.map(s => (
          <span key={s.label} className="inline-flex items-baseline gap-1.5" title={s.tip}>
            <span className="text-[#8c959f]">{s.label}</span>
            {s.compose ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="flex h-1.5 w-14 overflow-hidden rounded-full bg-black/[0.05]" aria-hidden>
                  {s.compose.map(p => (
                    <span key={p.key} style={{ flexGrow: Math.max(p.ms, 1), backgroundColor: p.color }} />
                  ))}
                </span>
                <span className="font-semibold tabular-nums text-[#1f2328]">{s.value}</span>
              </span>
            ) : (
              <span className="font-semibold tabular-nums text-[#1f2328]">{s.value}</span>
            )}
          </span>
        ))}
      </div>

      <div ref={scrollRef} className="min-h-0 w-full flex-1 overflow-auto p-3">
        <svg width={svgW} height={totalH} className="block max-w-none select-none" role="img" aria-label={`${view.title} 时间轴`}>
          {/* 时间刻度：竖向虚线网格 + 顶部时刻 */}
          {ticks.map(t => (
            <g key={t}>
              <line x1={xOf(t)} y1={HEADER_H} x2={xOf(t)} y2={totalH - 10} stroke={RUN_COLORS.edge} strokeWidth={1} strokeDasharray="3 4" />
              <text x={xOf(t)} y={16} fontSize={9.5} fill={RUN_COLORS.textFaint} textAnchor="middle">
                {withDate ? fullClock(t) : shortClock(t)}
              </text>
            </g>
          ))}

          {/* 泳道：节点标签 + 逐尝试的执行/验收条 */}
          {lanes.map((lane, li) => {
            const y = HEADER_H + lanes.slice(0, li).reduce((s, l) => s + l.height, 0);
            const selected = lane.node.key === selectedKey;
            return (
              <g key={lane.node.key} className="trace-lane">
                {selected ? (
                  <rect x={0} y={y} width={svgW} height={lane.height} fill={RUN_COLORS.textPrimary} fillOpacity={0.035} />
                ) : null}
                <line x1={LABEL_W - 6} y1={y} x2={LABEL_W - 6} y2={y + lane.height} stroke={RUN_COLORS.edge} strokeWidth={1} />
                <circle cx={16} cy={y + lane.height / 2} r={3.5} fill={statusColor(lane.node.status)} />
                <text x={26} y={y + lane.height / 2 + 4} fontSize={11.5} fontWeight={600} fill={RUN_COLORS.textPrimary}>
                  {truncate(lane.node.label, 18)}
                </text>
                {lane.rows.map((row, ri) => {
                  const rowY = y + LANE_PAD_Y + ri * ROW_H;
                  const showOrdinal = lane.rows.length > 1;
                  // 派发间隙显影：执行条结束 → 验收条开始之间的点状连接线
                  //（编排等待在时间轴上直接可见）
                  const execBar = row.bars.find(b => b.role === "execute");
                  const verifyBar = row.bars.find(b => b.role === "verify");
                  const gapLine = execBar && verifyBar && verifyBar.start > execBar.end ? (
                    <line
                      className="trace-gap"
                      x1={xOf(execBar.end)}
                      y1={rowY + 8.75}
                      x2={xOf(verifyBar.start)}
                      y2={rowY + 8.75}
                      stroke={TIME_COMPOSE.gap}
                      strokeWidth={1.2}
                      strokeDasharray="2 2"
                    />
                  ) : null;
                  return (
                    <g key={row.ordinal}>
                      {gapLine}
                      {row.bars.map(bar => {
                    const bx = xOf(bar.start);
                    const bw = Math.max(xOf(bar.end) - bx, 2);
                    const c = statusColor(bar.status);
                    const title = [
                      `${lane.node.label} · 第 ${bar.attempt} 次 · ${bar.role === "execute" ? "执行" : "验收"}`,
                      `${fullClock(bar.start)} → ${fullClock(bar.end)} · ${formatDurationMs(bar.end - bar.start)}`,
                      `${bar.turns} turns · ${compactTokens(bar.tokens)} tokens`,
                    ].join("\n");
                    return bar.role === "execute" ? (
                      <g
                        key={bar.key}
                        className="trace-bar cursor-pointer"
                        onClick={() => onSelectNode(lane.node.key)}
                      >
                        <title>{title}</title>
                        <rect x={bx} y={rowY} width={bw} height={8} rx={2} fill={c} fillOpacity={0.82} />
                        {showOrdinal && bw > 34 ? (
                          <text x={bx + 4} y={rowY + 6.5} fontSize={7.5} fill="#ffffff" fillOpacity={0.95}>
                            {`第${bar.attempt}次`}
                          </text>
                        ) : null}
                      </g>
                    ) : (
                      <g
                        key={bar.key}
                        className="trace-bar trace-bar-verify cursor-pointer"
                        onClick={() => onSelectNode(lane.node.key)}
                      >
                        <title>{title}</title>
                        <rect x={bx} y={rowY + 9.5} width={bw} height={4.5} rx={2} fill={c} fillOpacity={0.22} stroke={c} strokeWidth={0.8} strokeOpacity={0.85} />
                      </g>
                    );
                      })}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
