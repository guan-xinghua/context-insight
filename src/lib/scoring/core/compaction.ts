// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 上下文压缩（/compact）标记轮识别：D4.compaction 评分与 LLM 轨迹摘要标注共读这一份。
// opencode 落库带显式标记（agent=compaction 摘要轮 / compaction-boundary 合成边界轮，
// 后者 content 为 "/compact" 或 "/compact (auto)"）；claude 侧无显式标记，用 continuation
// 轮启发式（与 turn-split 的单调下限重置同口径）。

import { isContinuationTurn } from '@/lib/shared/command-parser';

export interface CompactionTurnShape {
  agentName: string | null;
  isSubagent: boolean;
  role: string;
  content: string | null;
}

/** 压缩标记轮（一次压缩事件的边界或摘要；同链连续标记轮算同一次事件） */
export function isCompactionMarkerTurn(t: CompactionTurnShape): boolean {
  return t.agentName === 'compaction' || t.agentName === 'compaction-boundary'
    || (!t.isSubagent && t.role === 'user' && !!t.content && isContinuationTurn(t.content));
}
