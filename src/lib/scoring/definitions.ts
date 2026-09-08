// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 客户端安全出口：只有维度定义（纯数据）与类型——只依赖六个 d*/definition.ts
// 与 core/schema（全是类型与常量）。不触碰执行器/装配器/用户定义加载器
//（collect 与 user/loader 走 node:fs，进不了浏览器 bundle）。
// 客户端组件按值导入一律走这里；index.ts 是服务端全量出口（API 路由用）。

import type { DimensionDefinition } from './core/schema';
import { d1Completion } from './d1-completion/definition';
import { d2Trust } from './d2-trust/definition';
import { d3Quality } from './d3-quality/definition';
import { d4Efficiency } from './d4-efficiency/definition';
import { d5Redundancy } from './d5-redundancy/definition';
import { d6Autonomy } from './d6-autonomy/definition';

export const BUILTIN_DIMENSIONS: DimensionDefinition[] = [
  d1Completion,
  d2Trust,
  d3Quality,
  d4Efficiency,
  d5Redundancy,
  d6Autonomy,
];

export type { DimensionDefinition, ScoreItemSchema, Band, DimensionRole, AggregationPolicy, ThreeStateRule } from './core/schema';
export type { Scorecard, DimensionResult, SubItemResult, Evidence } from './core/types';
export type { UserDimensionFile } from './user/loader';
