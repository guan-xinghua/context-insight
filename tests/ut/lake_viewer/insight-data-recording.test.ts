// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// getScorecard recording 消歧（lake notes 快照贴错行修复，现场 f4c5b028）：
// capture → -proxy 捕获行，native → 非 -proxy 原生行；显式 framework 仍优先。
// 裸 taskId 回落对同 sid 双记录是随机的——快照会把 proxy 行的 mate 卡传成
// native 行的回落卡。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: { session: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));
vi.mock('@/lib/scoring', () => ({
  runScorecard: vi.fn(async () => null),
  scorecardStore: () => ({ get: async () => null, put: async () => {}, listForBaseline: async () => [] }),
  loadRegistry: async () => ({ defs: [], profile: null }),
}));
vi.mock('@/lib/scoring/core/overlays', () => ({ applyOverlays: async (c: unknown) => c }));

describe('getScorecard recording 消歧', () => {
  beforeEach(() => findFirst.mockReset());

  it("recording='capture' → 取 -proxy 捕获行", async () => {
    const { getScorecard } = await import('../../../src/app/lake_viewer/_lib/insight-data');
    findFirst.mockResolvedValue(null);
    await getScorecard('ses_x', undefined, 'capture');
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId: 'ses_x', framework: { endsWith: '-proxy' } },
    }));
  });

  it("recording='native' → 取非 -proxy 原生行", async () => {
    const { getScorecard } = await import('../../../src/app/lake_viewer/_lib/insight-data');
    findFirst.mockResolvedValue(null);
    await getScorecard('ses_x', undefined, 'native');
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId: 'ses_x', NOT: { framework: { endsWith: '-proxy' } } },
    }));
  });

  it('显式 framework 优先于 recording（observe 路由语义不变）', async () => {
    const { getScorecard } = await import('../../../src/app/lake_viewer/_lib/insight-data');
    findFirst.mockResolvedValue({ id: 'row1', framework: 'claude-code' });
    await getScorecard('ses_x', 'claude-code', 'native');
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId: 'ses_x', framework: 'claude-code' },
    }));
  });
});
