// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

export const ACTIVE_GAP_THRESHOLD_MS = 5 * 60 * 1000

/** 单轮 LLM 调用区间（latencyMs 展开）的可信上限——防 wire 伪延迟桥接挂机间隙 */
export const ACTIVE_LATENCY_CAP_MS = 10 * 60 * 1000

export interface ActiveTimeSplit {
  wallMs: number
  activeMs: number
  inactiveMs: number
  clusterCount: number
}

export interface ActiveTimeTurnRow {
  createdAt_ts: Date | null
  createdAt: Date
  latencyMs: number | null
  role: string
}

/**
 * 事件聚类：区间按开始时间排序，相邻间隔 > gapMs（默认 5min）即断开成新的活跃段。
 * 返回合并后的活跃段 [{start,end}]；相邻段之间的空档即休眠。
 * - Wall Clock 拆分（computeActiveTimeSplit）用它汇总；
 * - 泳道图用它按「每条泳道一组区间」重聚类（阈值可调）。
 */
export function clusterActiveSegments(
  intervals: Array<[number, number]>,
  gapMs: number = ACTIVE_GAP_THRESHOLD_MS,
): Array<{ start: number; end: number }> {
  const ivs = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [number, number])
    .sort((x, y) => x[0] - y[0])
  if (ivs.length === 0) return []
  const segments: Array<{ start: number; end: number }> = []
  let curStart = ivs[0][0]
  let curEnd = ivs[0][1]
  for (let i = 1; i < ivs.length; i++) {
    const [s, e] = ivs[i]
    if (s - curEnd > gapMs) {
      segments.push({ start: curStart, end: curEnd })
      curStart = s
      curEnd = e
    } else if (e > curEnd) {
      curEnd = e
    }
  }
  segments.push({ start: curStart, end: curEnd })
  return segments
}

export async function computeSessionActiveSplit(
  fetchTurns: () => Promise<ActiveTimeTurnRow[]>,
  sessionStartMs: number,
  sessionEndMs: number | null,
  expandLatency: boolean
): Promise<ActiveTimeSplit | null> {
  const rows = await fetchTurns()
  const intervals = rows.map((t) => {
    const ts = (t.createdAt_ts ?? t.createdAt).getTime()
    // 单轮调用区间的可信上限：真实 LLM 调用是秒到分钟级；wire/导入侧存在伪
    // latency（实测 49.66h——疑似 resume/补行的时间戳错位），不截断会把挂机
    // 间隙整个桥进活跃段（121h 墙钟算出 117h 活跃）
    const lat = expandLatency && t.role === 'assistant' && typeof t.latencyMs === 'number' && t.latencyMs > 0
      ? Math.min(t.latencyMs, ACTIVE_LATENCY_CAP_MS)
      : 0
    return (lat > 0 ? [ts - lat, ts] : [ts, ts]) as [number, number]
  })
  return computeActiveTimeSplit(intervals, sessionStartMs, sessionEndMs)
}

export function computeActiveTimeSplit(
  intervals: Array<[number, number]>,
  sessionStartMs: number,
  sessionEndMs: number | null
): ActiveTimeSplit | null {
  const segments = clusterActiveSegments(intervals)
  // 单个时间点（零跨度）算不出活跃/非活跃，返回 null 交调用方回落墙钟。
  if (segments.length === 0) return null
  if (segments.length === 1 && segments[0].start === segments[0].end) return null
  const start = Math.min(sessionStartMs, segments[0].start)
  const end = Math.max(sessionEndMs ?? segments[segments.length - 1].end, segments[segments.length - 1].end)
  const wallMs = Math.max(0, end - start)
  let activeMs = 0
  for (const seg of segments) activeMs += seg.end - seg.start
  if (activeMs > wallMs) activeMs = wallMs
  return { wallMs, activeMs, inactiveMs: wallMs - activeMs, clusterCount: segments.length }
}
