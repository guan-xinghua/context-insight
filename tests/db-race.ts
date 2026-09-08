// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 共享 dev.db 的并行测试文件（e2e-import-observe / cannbay2 等）用同一 opencode
// fixture 会话，一方的 deleteMany 会与另一方的 merge update 赛跑（dedup 查到行、
// update 时行已被删 → P2025）。对这类瞬时消失重试一次即可通过。
export async function withDbRaceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('No record was found') || msg.includes('Session not found')) return await fn();
    throw e;
  }
}
