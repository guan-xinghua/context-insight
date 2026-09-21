// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

export const ACTIVE_GAP_THRESHOLD_MS = 5 * 60 * 1000

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

export async function computeSessionActiveSplit(
  fetchTurns: () => Promise<ActiveTimeTurnRow[]>,
  sessionStartMs: number,
  sessionEndMs: number | null,
  expandLatency: boolean
): Promise<ActiveTimeSplit | null> {
  const rows = await fetchTurns()
  const intervals = rows.map((t) => {
    const ts = (t.createdAt_ts ?? t.createdAt).getTime()
    const lat = expandLatency && t.role === 'assistant' && typeof t.latencyMs === 'number' && t.latencyMs > 0 ? t.latencyMs : 0
    return (lat > 0 ? [ts - lat, ts] : [ts, ts]) as [number, number]
  })
  return computeActiveTimeSplit(intervals, sessionStartMs, sessionEndMs)
}

export function computeActiveTimeSplit(
  intervals: Array<[number, number]>,
  sessionStartMs: number,
  sessionEndMs: number | null
): ActiveTimeSplit | null {
  const ivs = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [number, number])
    .sort((x, y) => x[0] - y[0])
  if (ivs.length === 0) return null
  if (ivs.length === 1 && ivs[0][0] === ivs[0][1]) return null
  const start = Math.min(sessionStartMs, ivs[0][0])
  const end = Math.max(sessionEndMs ?? ivs[ivs.length - 1][1], ivs[ivs.length - 1][1])
  const wallMs = Math.max(0, end - start)
  let activeMs = 0
  let clusterCount = 0
  let clusterStart = ivs[0][0]
  let prevEnd = ivs[0][1]
  for (let i = 1; i < ivs.length; i++) {
    const [s, e] = ivs[i]
    if (s - prevEnd > ACTIVE_GAP_THRESHOLD_MS) {
      activeMs += prevEnd - clusterStart
      clusterCount++
      clusterStart = s
      prevEnd = e
    } else if (e > prevEnd) {
      prevEnd = e
    }
  }
  activeMs += prevEnd - clusterStart
  clusterCount++
  if (activeMs > wallMs) activeMs = wallMs
  return { wallMs, activeMs, inactiveMs: wallMs - activeMs, clusterCount }
}
