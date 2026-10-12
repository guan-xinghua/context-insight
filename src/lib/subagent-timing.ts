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
  // schema 列为 Int(32 位)：时延跨 ~24.8 天即溢出（脏数据里出现过起点塌成 epoch 0、
  // 时延=完整毫秒时间戳 1.78e12 的实例，SQLite 照存、Prisma 读取抛错）。上限钳到
  // INT32_MAX 保底列不炸；正常子代理会话时延远小于该界，行为不变。
  const latencyMs = Math.min(Math.max(end - start, 0), 2_147_483_647);
  return { responseTimestamp: new Date(end).toISOString(), latencyMs };
}
