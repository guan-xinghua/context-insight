// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 装配入口（角色①）：collect → 九种料 → AssembledInput。
// 留口（暂不实现）：缺字段时 LLM 补抽——extractFallback?: LlmClient。

import type { PrismaClient } from '@prisma/client';
import type { AssembledInput } from './types';
import { collectForScoring, type CollectedData } from './collect';
import { buildDigest } from './digest';
import { parseWorkflowDeclaration } from './workflow-decl';
import { classifyTask } from './task-classifier';

export type { CollectedData };

export async function assembleInput(taskId: string, prisma: PrismaClient, framework?: string): Promise<{ input: AssembledInput; raw: CollectedData } | null> {
  const raw = await collectForScoring(taskId, prisma, framework);
  if (!raw) return null;

  const { trajectoryDigest, userMessages } = buildDigest(raw.turns, raw.toolCalls, raw.bridges);
  const workflowDecl = parseWorkflowDeclaration(raw.fullContext);
  // 任务文本 = 首条主链用户消息（算子类任务自述里就带着"算子/operator/kernel"）
  const firstUser = raw.turns.find(t => !t.isSubagent && t.role === 'user');
  const taskType = classifyTask(workflowDecl, raw.toolCalls, firstUser?.content ?? firstUser?.contentSummary ?? '');

  // 工具时长：wire 轮间隙推导优先（DB per-call duration 采集侧未回填，全库为 0）；
  // 无 wire（原生导入）回落 DB——两处都空则 D4.toolTime 如实无法评判
  const wireToolMs = raw.wire?.toolIntervals?.reduce((s, i) => s + (i.kind === 'local' ? i.endMs - i.startMs : 0), 0) ?? 0;
  const toolTimeMs = wireToolMs > 0
    ? wireToolMs
    : raw.toolCalls.reduce((s, tc) => s + (tc.durationMs || 0), 0);
  const llmTimeMs = raw.turns.reduce((s, t) => s + (t.latencyMs || 0), 0);
  const inputTokens = raw.turns.reduce((s, t) => s + (t.inputMessagesTokens || t.inputTokens || 0), 0);

  return {
    raw,
    input: {
      trajectoryDigest,
      memoryDigest: (raw.fullContext?.memoryFiles ?? '').slice(0, 8000),
      userMessages,
      toolCalls: raw.toolCalls,
      turns: raw.turns,
      measures: {
        totalTokens: raw.session.totalTokens,
        toolTimeMs,
        llmTimeMs,
        inputTokens,
      },
      taskType,
      workflowDecl,
      finishReason: raw.finishReason,
      interrupts: raw.interrupts,
      wire: raw.wire,
      redactionEvents: raw.redactionEvents,
      executions: raw.executions,
    },
  };
}
