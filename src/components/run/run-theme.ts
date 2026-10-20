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

export function bandLabel(generation: number): string {
  return generation === 0 ? "第 1 次运行" : `回滚 #${generation}`;
}
