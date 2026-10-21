// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 工作台主题（light，与全站白板一致）：色板单点声明（彩色只留给状态与
// 强调）。SVG 与 DOM 两侧共用，禁止散落硬编码。

export interface RunStatusMeta {
  label: string;
  color: string;
}

export const RUN_STATUS_META: Record<string, RunStatusMeta> = {
  passed: { label: "通过", color: "#1a7f37" },
  failed: { label: "失败", color: "#cf222e" },
  running: { label: "运行中", color: "#9a6700" },
  pending: { label: "待定", color: "#8c959f" },
  carried: { label: "承接", color: "#1b7c83" },
  unknown: { label: "未知", color: "#57606a" },
};

/** 失败归因徽标（failure-attribution 的 kind → 展示）：归因是启发式，
 *  「疑似」措辞保留——命中指纹 ≠ 实锤环境问题。 */
export const FAILURE_KIND_META: Record<string, RunStatusMeta> = {
  env: { label: "疑似环境", color: "#9a6700" },
  "same-cause": { label: "同因连败", color: "#8250df" },
  divergent: { label: "原因各异", color: "#57606a" },
};

export const RUN_COLORS = {
  canvas: "#ffffff",
  nodeFill: "#f6f8fa",
  textPrimary: "#1f2328",
  textMuted: "#57606a",
  textFaint: "#8c959f",
  edge: "#d0d7de",
  flow: "#8c959f",
  rollback: "#cf222e",
  accent: "#8250df",
} as const;

export function statusColor(status: string): string {
  return RUN_STATUS_META[status]?.color ?? RUN_STATUS_META.unknown.color;
}

/** 边流光颜色：跟随目标节点状态（通过=绿 / 运行中=琥珀 / 失败=红 / 承接=青），
 *  未执行（待定/未知）用中性灰——没跑过的管线不发光。 */
export function flowColor(status: string): string {
  if (status === "pending" || status === "unknown") return RUN_COLORS.flow;
  return statusColor(status);
}

export function statusLabel(status: string): string {
  return RUN_STATUS_META[status]?.label ?? status;
}

/** 指标透镜顺序色阶（浅→深）：节点按分位桶取色，越深消耗越大。 */
export const METRIC_SCALE = ["#edf1f6", "#c9dcf2", "#8fb9e7", "#4a93da", "#155fae"] as const;

/** 分位档 → 色阶下标（metricColor 与底色透明度共用，保证颜色深浅与染色
 *  浓淡严格同档）。 */
export function metricScaleIndex(rank: number, maxRank: number): number {
  if (maxRank <= 0) return METRIC_SCALE.length - 1;
  return Math.min(METRIC_SCALE.length - 1, Math.round((rank / maxRank) * (METRIC_SCALE.length - 1)));
}

export function metricColor(rank: number, maxRank: number): string {
  return METRIC_SCALE[metricScaleIndex(rank, maxRank)];
}

/** 透镜模式下无会话数据节点的描边：中灰（与有数据的浅蓝档一眼可分）。 */
export const METRIC_EMPTY = "#8c959f";

/** 节点面积信号（透镜可见度统一整改）：程度辨识靠**染色面积**不靠细描边——
 *  1px 半透明线肉眼难分档，节点盒底色按档位/状态染色后一眼可辨。描边统一
 *  加粗到 2px（选中 2.5px）；水位透镜例外（水体本身就是面积信号，盒底保持
 *  中性）；无数据节点不染色、灰描边，与最低档浅蓝可分。状态透镜的铺色较
 *  透镜档再降一档（0.08）——状态信号以描边 + 圆点为主，铺色只留底味。 */
export const NODE_STROKE_WIDTH = 2;
export const NODE_STROKE_WIDTH_SELECTED = 2.5;
export const STATUS_TINT_OPACITY = 0.08;

/** 分位档 → 底色染色浓度（最低档 0.08 → 最高档 0.26，与色阶同档递增）。 */
export function metricTintOpacity(rank: number, maxRank: number): number {
  const i = metricScaleIndex(rank, maxRank);
  return Math.round((0.08 + (i / (METRIC_SCALE.length - 1)) * 0.18) * 100) / 100;
}

/** 时间四元构成配色（执行 / 验收 / 派发间隙 / 重试等待）——侧栏时间块、
 *  时间轴摘要与泳道间隙连接线共用。 */
export const TIME_COMPOSE = {
  exec: "#4a93da",
  verify: "#8250df",
  gap: "#d0d7de",
  wait: "#8c959f",
} as const;

/** 水位透镜「容器注水」效果：节点盒 = 容器，上下文峰值 = 水深。水恒为蓝
 *  （深度只调透明度，文字保持可读），危险信号交给 80% 红色警戒线——水漫
 *  过线即逼限，不搞变色水污染隐喻。 */
export const WATER_COLOR = "#4a93da";
export const WATER_CRITICAL_PCT = 80;
export const WATER_BAND_OPACITY = { shallow: 0.16, mid: 0.30, deep: 0.38 } as const;

/** 冗余透镜三档配色（评分卡同款阈值 0.6/0.8，方向反转：低分才警示）——
 *  与用量透镜的「越深越多」蓝阶刻意区分，避免「深色=量大」的误读。
 *  tint = 底色染色浓度（越糙染越重，问题节点更抢眼）。 */
export const REDUNDANCY_BANDS = [
  { min: 0.8, color: "#1a7f37", label: "≥0.80 干净", tint: 0.06 },
  { min: 0.6, color: "#9a6700", label: "0.60–0.80 一般", tint: 0.13 },
  { min: 0, color: "#cf222e", label: "<0.60 糙", tint: 0.19 },
] as const;

/** 冗余规则分 → 档位色（RunGraph 描边/底色与侧栏/图例共用）。 */
export function redundancyColor(score: number): string {
  return REDUNDANCY_BANDS.find(b => score >= b.min)!.color;
}

/** 冗余规则分 → 底色染色浓度。 */
export function redundancyTint(score: number): number {
  return REDUNDANCY_BANDS.find(b => score >= b.min)!.tint;
}

export function bandLabel(generation: number): string {
  return generation === 0 ? "第 1 次运行" : `回滚 #${generation}`;
}
