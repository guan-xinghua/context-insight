// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分配置 profile：叠在内置口径上的覆盖层（引用式，非拷贝）。
// 本文件与 presets.ts 客户端安全（无 node:fs）；store/apply 是服务端模块。

import type { Band } from '../schema';
import type { RuleSpec } from '../../user/rule-scorer';

export type ProfileDimension = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

export interface CustomItemSpec {
  /** '<dim>.<kebab>'，如 'D3.doc-sync'；前缀必须与 targetDimension 一致 */
  id: string;
  targetDimension: ProfileDimension;
  name: string;
  note?: string;
  /** llm=五档评分 / rule=零 LLM 规则判定 / binary=两档判定（LLM 是非题：达成 1 / 未达成 0） */
  kind: 'llm' | 'rule' | 'binary';
  /** binary 的判定标准写在 note；llm 的五档在 bands；rule 的声明在 rule */
  bands?: Band[];
  rule?: RuleSpec;
  /** D4/D5 目标必填（内置子项标尺合计≈1）；D3 可选默认等权；D1/D2/D6 无意义会被剥离 */
  weight?: number;
}

export interface ScoringProfile {
  schema: 'scoring-profile';
  version: 1;
  /** 用户 kebab-case；'preset:*' 为内置模板保留前缀 */
  id: string;
  name: string;
  note?: string;
  /** D1 否决维无权重、D7 归自定义维度自己管，两者拒绝 */
  dimensionWeights?: Partial<Record<Exclude<ProfileDimension, 'D1'>, number>>;
  /** 内置子项 id；D1 规则四项拒绝；未知 id 剥离进 warnings */
  excludedItems?: string[];
  itemWeights?: Record<string, number>;
  customItems?: CustomItemSpec[];
}

/** D1 否决证据链四项：任何 profile 都不可勾除 */
export const D1_LOCKED_ITEMS = ['D1.stopReason', 'D1.selfReport', 'D1.planReconcile', 'D1.verifiedRun'] as const;

/** 勾除后语义退化的子项与提示（保存校验与应用双侧共用） */
export const EXCLUDE_DEGRADES: Record<string, string> = {
  'D1.acceptance': '验收清单对账被勾除：三态退回代码层判定（与不跑语义评审同口径）',
  'D1.goalCoverage': '目标覆盖对账被勾除：三态退回代码层判定（与不跑语义评审同口径）',
  'D2.authorization': '授权与规避被勾除：授权豁免失效，确凿违规不再降疑似留痕',
  'D3.correctness': '正确性被勾除：质量地板失效，D3 变纯（加权）平均',
};
