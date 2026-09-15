// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 摘要/预览共用的噪声剥离：thinking 块吃掉 200 字符摘要预算、
// <system-reminder> 前缀显示为 XML 标签噪音——ingest 侧（turn-split/
// phase-split 的 contentSummary）与显示侧（LlmOutputView 折叠预览）同口径。

export function stripThinkingAndReminder(text: string | null): string | null {
  return text
    ?.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
    .replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '') || null;
}
