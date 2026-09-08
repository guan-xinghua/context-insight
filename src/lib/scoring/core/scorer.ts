// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分器统一接口（角色②）：规则 / LLM / 基线对比三类共用一个形状。
// needs 声明要什么料——执行器按此注入（TS 无运行时签名反射，显式声明）。

import type { AssembledInput, LlmClient } from './assembler/types';
import type { ScoreItemSchema } from './schema';
import type { Evidence, SubItemResult } from './types';

export interface ScorerContext {
  input: AssembledInput;
  def: ScoreItemSchema;
  llm?: LlmClient;
  /** 多次采样次数，默认 1（留口：评审花钱，先省着） */
  samples?: number;
  /** 本 session 的内部 ID（user-input 评分器按它读用户填报值） */
  sessionId?: string;
}

export abstract class Scorer {
  abstract readonly id: string;
  abstract readonly needs: readonly (keyof AssembledInput)[];
  abstract run(ctx: ScorerContext): Promise<SubItemResult>;
}

// ── 结果构造器：三种状态各一个出口，评分器体里只填内容 ─────────

export function okResult(def: ScoreItemSchema, fields: Partial<SubItemResult> = {}): SubItemResult {
  return { itemId: def.id, label: def.name, status: 'ok', evidence: [], ...fields };
}

export function notApplicable(def: ScoreItemSchema, note: string, fields: Partial<SubItemResult> = {}): SubItemResult {
  return { itemId: def.id, label: def.name, status: 'not-applicable', note, evidence: [], ...fields };
}

export function errorResult(def: ScoreItemSchema, message: string): SubItemResult {
  return { itemId: def.id, label: def.name, status: 'error', evidence: [], error: { message } };
}

export function ev(turnIndex: number | null, label: string, quote?: string): Evidence {
  return { turnIndex, label, quote };
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
