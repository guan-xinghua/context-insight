// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 任务类型判定（D1.acceptance / D3 CANN-Bench 评分共用，判断一次两边共用）：
// 工作流声明标签 → 改文件路径启发。判定不了 → unknown（CANN-Bench 评分不适用）。

import { extractFilePath } from '@/lib/file-restore';
import type { ScoreToolCall, WorkflowDeclaration } from './types';

// 算子仓库路径启发：ops/ 算子目录、test/ 下 op 用例、常见算子文件名
const OPERATOR_PATH_RE = /(^|\/)(ops?|operator|operators|kernel|ascend_clarith|actge|aol|opapi)(\/|$)/i;
const OPERATOR_FILE_RE = /(op_|_op\b|operator|kernel).*\.(cc|cpp|cu|h|hpp|py|json)$/i;

export function classifyTask(
  decl: WorkflowDeclaration | null,
  toolCalls: ScoreToolCall[],
): 'operator' | 'general' | 'unknown' {
  if (decl?.taskTypeTags?.includes('operator')) return 'operator';

  const writeFamilies = new Set(['write', 'edit', 'edit1', 'multiedit']);
  const writtenFiles = toolCalls
    .filter(tc => writeFamilies.has(tc.toolName.toLowerCase()))
    .map(tc => extractFilePath(tc.argsJson))
    .filter((f): f is string => f != null);

  if (writtenFiles.length === 0) return 'unknown';
  const hits = writtenFiles.filter(f => OPERATOR_PATH_RE.test(f) || OPERATOR_FILE_RE.test(f));
  // 写过的文件里算子路径占一半以上才算算子任务（防单文件误判）
  if (hits.length > 0 && hits.length / writtenFiles.length >= 0.5) return 'operator';
  return 'general';
}
