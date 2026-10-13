// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex rollout 文件名单一事实源（纯函数、无 fs）：服务端适配器
// （codex-jsonl.ts）与客户端组件（LocalFileImport 单文件直导）双消费。
// 两处各持一份正则一旦漂移，同一路径会落不同 taskId（同会话双身份入库）。

export const ROLLOUT_NAME_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

export function isRolloutFileName(fileName: string): boolean {
  return ROLLOUT_NAME_RE.test(fileName);
}

export function rolloutSessionIdOf(fileName: string): string | null {
  return ROLLOUT_NAME_RE.exec(fileName)?.[1] ?? null;
}
