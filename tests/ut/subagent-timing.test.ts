// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, expect, it } from 'vitest';
import { subagentTiming } from '@/lib/subagent-timing';

describe('subagentTiming', () => {
  it('uses latency to recover a missing completion timestamp', () => {
    const result = subagentTiming([
      { createdAt_ts: '2026-01-01T00:00:02.000Z', completedAt: null, latencyMs: 120_000 },
    ], '2026-01-01T00:00:00.000Z');
    expect(result).toEqual({ responseTimestamp: '2026-01-01T00:02:02.000Z', latencyMs: 122_000 });
  });

  it('spans all child turns and includes dispatch-to-first-turn wait', () => {
    const result = subagentTiming([
      { createdAt_ts: '2026-01-01T00:00:05.000Z', completedAt: '2026-01-01T00:00:06.000Z', latencyMs: 1_000 },
      { createdAt_ts: '2026-01-01T00:00:08.000Z', completedAt: null, latencyMs: 4_000 },
    ], '2026-01-01T00:00:00.000Z');
    expect(result?.latencyMs).toBe(12_000);
    expect(result?.responseTimestamp).toBe('2026-01-01T00:00:12.000Z');
  });
});
