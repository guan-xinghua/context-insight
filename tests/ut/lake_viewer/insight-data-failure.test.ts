// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// getScorecard 查询失败语义（review #190172809）：DB 故障必须上抛（调用方
// 降级但不缓存），不能吞成 null——否则瞬态故障被 300s TTL 放大成「未评分」。
// 必须在 import src 模块前指向不可达 DB（PrismaClient 构造时读 env）。
process.env.DATABASE_URL = 'file:/nonexistent-lake-viewer-failure/db.sqlite';

import { describe, it, expect } from 'vitest';

describe('getScorecard 查询失败上抛', () => {
  it('DB 不可达 → rejects（区别于「确定无卡」的 null）', async () => {
    const { getScorecard } = await import('../../../src/app/lake_viewer/_lib/insight-data');
    await expect(getScorecard('any-sid')).rejects.toThrow();
  });
});
