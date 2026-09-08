// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 注册表：内置六维（可被 active profile 覆盖）+ D7 用户实例 → 全部定义与评分器。
// 新增维度 = 加一个目录 + 在此登记。

import type { DimensionDefinition } from './core/schema';
import { Scorer } from './core/scorer';
import { BUILTIN_DIMENSIONS } from './definitions';
import { d1Scorers } from './d1-completion/scorers';
import { DestructiveOpsScorer, SecretsScorer, OutOfBoundsScorer } from './d2-trust/scorers';
import { redlineScorer, authEvasionScorer } from './d2-trust/llm';
import { d3Scorers } from './d3-quality/scorers';
import { d4Scorers } from './d4-efficiency/scorers';
import { d5Scorers } from './d5-redundancy/scorers';
import { d6Scorers } from './d6-autonomy/scorers';
import { loadUserDefinitions, userDimensionToDef, userDimensionScorers } from './user/loader';
import { applyProfile } from './core/profile/apply';
import { loadActiveProfile } from './core/profile/store';

function builtinScorers(): Scorer[] {
  return [
    ...d1Scorers(),
    new DestructiveOpsScorer(),
    new SecretsScorer(),
    new OutOfBoundsScorer(),
    redlineScorer(),
    authEvasionScorer(),
    ...d3Scorers(),
    ...d4Scorers(),
    ...d5Scorers(),
    ...d6Scorers(),
  ];
}

export interface Registry {
  defs: DimensionDefinition[];
  scorerOf: Map<string, Scorer>;
  /** 生效口径快照（null = 默认）；评分卡 framework.profile 的来源 */
  profile: { id: string; name: string } | null;
  /** profile 应用期警示（失效子项/语义退化），API 透传给 UI */
  warnings: string[];
}

/** 内置六维（active profile 覆盖后）+ D7 用户实例（数据文件）；加载失败的用户定义跳过 */
export async function loadRegistry(): Promise<Registry> {
  const active = await loadActiveProfile();
  const applied = applyProfile(BUILTIN_DIMENSIONS, active);
  const defs = applied.defs;
  const scorers = [...builtinScorers(), ...applied.scorers];
  const users = await loadUserDefinitions();
  for (const u of users) {
    defs.push(userDimensionToDef(u));
    scorers.push(...userDimensionScorers(u));
  }
  const scorerOf = new Map(scorers.map(s => [s.id, s]));
  return {
    defs,
    scorerOf,
    profile: active ? { id: active.id, name: active.name } : null,
    warnings: applied.warnings,
  };
}
