// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 活跃时长 latency 展开上限：wire 伪延迟（实测 49.66h）不得把挂机间隙桥进活跃段
// ——现场 b38aeb37 捕获行 121h 墙钟被算出 117h 活跃。

import { describe, it, expect } from 'vitest';
import { computeSessionActiveSplit, ACTIVE_LATENCY_CAP_MS } from '../../src/lib/active-time';

const T0 = Date.parse('2026-09-24T01:14:00.000Z');
const mk = (role: string, offsetMin: number, latencyMs: number | null, isTs = true) => ({
  role,
  createdAt: new Date(T0),
  createdAt_ts: isTs ? new Date(T0 + offsetMin * 60_000) : null,
  latencyMs,
});

describe('computeSessionActiveSplit · latency 上限截断', () => {
  it('伪延迟（49.66h）不桥接挂机间隙：两段工作 burst 之间的 3 天空闲仍算 inactive', async () => {
    // burst1（t0 附近两轮）——【挂机 3 天】——burst2；其中一轮带 49.66h 伪 latency
    const rows = [
      mk('user', 0, null),
      mk('assistant', 1, 60_000),
      mk('assistant', 3, 49.66 * 3600_000),   // 伪延迟：现场实测值
      mk('user', 3 + 24 * 60, null),           // 3 天后的第二段
      mk('assistant', 3 + 24 * 60 + 2, 30_000),
    ];
    const split = await computeSessionActiveSplit(async () => rows, T0, T0 + (3 * 24 + 1) * 3600_000, true);
    expect(split).not.toBeNull();
    // 截断后单轮区间最多 ACTIVE_LATENCY_CAP_MS，3 天间隙不可能被桥掉
    expect(split!.activeMs).toBeLessThan(2 * 3600_000);
    expect(split!.inactiveMs).toBeGreaterThan(48 * 3600_000);
  });

  it('真实秒级延迟照常展开（burst 内区间正常拉宽），上限只拦异常值', async () => {
    const rows = [mk('user', 0, null), mk('assistant', 1, 90_000), mk('assistant', 4, 120_000)];
    const split = await computeSessionActiveSplit(async () => rows, T0, T0 + 5 * 60_000, true);
    expect(split!.activeMs).toBeGreaterThanOrEqual(4 * 60_000);   // 含展开的调用区间
    expect(ACTIVE_LATENCY_CAP_MS).toBe(10 * 60_000);
  });
});
