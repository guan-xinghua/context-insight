// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS PROGRAM IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

type TimeInput = Date | string | null | undefined;

function toMs(t: TimeInput): number | null {
  if (t == null) return null;
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

// 会话墙钟时长：startTime → endTime 的真实跨度。endTime 缺失或倒挂时
// 回落 totalLatencyMs（Σ turn latency，含并行 subagent 双计，仅作兜底）。
// 列表 / CLI / TUI 的 "Duration" 客户端用本函数 + 已有 start/end/Σ 字段自算，
// 无需 API 派生冗余字段。全局 Avg Duration 服务端聚合也用本函数。
export function sessionDurationMs(
  startTime: TimeInput,
  endTime: TimeInput,
  totalLatencyMs: number | null,
): number {
  const start = toMs(startTime);
  const end = toMs(endTime);
  if (start != null && end != null && end >= start) return end - start;
  return totalLatencyMs ?? 0;
}

// LLM 在途窗口：单个 assistant turn 的大模型工作时间区间。
// - completedAt 有值（opencode / claude 多行）：[createdAt, completedAt]
// - completedAt 缺失（cpx proxy 行，createdAt_ts=响应完成时刻）：[createdAt - latencyMs, createdAt]
interface TurnWindowInput {
  createdAt_ts: string | Date | null;
  completedAt?: string | Date | null;
  latencyMs?: number | null;
}

function turnWindow(turn: TurnWindowInput): [number, number] | null {
  const created = toMs(turn.createdAt_ts);
  if (created == null) return null;
  const completed = toMs(turn.completedAt ?? null);
  if (completed != null && completed >= created) return [created, completed];
  const lat = typeof turn.latencyMs === 'number' && turn.latencyMs > 0 ? turn.latencyMs : 0;
  if (lat > 0) return [created - lat, created];
  return null;
}

// LLM 活跃时间：所有 assistant turn 在途窗口的区间并集（并行 subagent 重叠只计一次）。
// 性质：≤ 墙钟（不超）；排除无 LLM 在途的用户空闲间隙；Σ latency 双计在此被消除。
// 仅在详情 / compare / 单会话 stats 服务端算一次（需取该会话 Turn 行）；列表不加（N 会话×全 turns 太重）。
export function computeLlmActiveMs(turns: TurnWindowInput[]): number {
  const windows: [number, number][] = [];
  for (const t of turns) {
    const w = turnWindow(t);
    if (w) windows.push(w);
  }
  if (windows.length === 0) return 0;
  windows.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curEnd = -Infinity;
  for (const [s, e] of windows) {
    if (e <= curEnd) continue; // 完全包含于已合并区间
    const start = Math.max(s, curEnd);
    total += e - start;
    curEnd = e;
  }
  return Math.max(0, Math.round(total));
}
