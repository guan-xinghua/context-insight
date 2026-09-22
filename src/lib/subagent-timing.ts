// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

type Timestamp = string | Date | null;

export function subagentTiming(
  turns: Array<{ createdAt_ts: Timestamp; completedAt: Timestamp; latencyMs: number }>,
  dispatchTimestamp: Timestamp,
): { responseTimestamp: string; latencyMs: number } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const turn of turns) {
    const start = turn.createdAt_ts ? new Date(turn.createdAt_ts).getTime() : NaN;
    const end = turn.completedAt
      ? new Date(turn.completedAt).getTime()
      : start + Math.max(turn.latencyMs, 0);
    if (Number.isFinite(start)) starts.push(start);
    if (Number.isFinite(end)) ends.push(end);
  }
  if (!starts.length || !ends.length) return null;
  const dispatch = dispatchTimestamp ? new Date(dispatchTimestamp).getTime() : NaN;
  const start = Math.min(...starts, ...(Number.isFinite(dispatch) ? [dispatch] : []));
  const end = Math.max(...ends);
  return { responseTimestamp: new Date(end).toISOString(), latencyMs: Math.max(end - start, 0) };
}
