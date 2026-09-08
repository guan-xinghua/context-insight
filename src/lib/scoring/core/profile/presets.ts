// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 内置模板（只读数据，客户端安全）：「勾除全部 LLM 项」按 scorerKind 程序化生成——
// 内置子项 id 演进后模板自动跟随。直接依赖六个维度定义模块，避免与 definitions.ts 成环。

import { d1Completion } from '../../d1-completion/definition';
import { d2Trust } from '../../d2-trust/definition';
import { d3Quality } from '../../d3-quality/definition';
import { d4Efficiency } from '../../d4-efficiency/definition';
import { d5Redundancy } from '../../d5-redundancy/definition';
import { d6Autonomy } from '../../d6-autonomy/definition';
import type { ScoringProfile } from './types';

const BUILTINS = [d1Completion, d2Trust, d3Quality, d4Efficiency, d5Redundancy, d6Autonomy];

const llmItemIds = (): string[] =>
  BUILTINS.flatMap(d => d.items.filter(i => i.scorerKind === 'llm').map(i => i.id));

export const PRESETS: ScoringProfile[] = [
  {
    schema: 'scoring-profile',
    version: 1,
    id: 'preset:quick',
    name: '快速免评审',
    note: '勾除全部 LLM 子项——零成本出完整确定性卡，覆盖度不受 LLM 项缺失拖累',
    excludedItems: llmItemIds(),
  },
  {
    schema: 'scoring-profile',
    version: 1,
    id: 'preset:operator',
    name: '算子开发',
    note: '重产出质量：D3 权重提到 45%，D2 让位到 10%',
    dimensionWeights: { D2: 0.10, D3: 0.45, D4: 0.15, D5: 0.15, D6: 0.15 },
  },
  {
    schema: 'scoring-profile',
    version: 1,
    id: 'preset:minimal',
    name: '极简核心',
    note: '快速免评审再勾除需 wire 的两个基线项（D5.dup / D5.stale），只留最硬的核心信号',
    excludedItems: [...llmItemIds(), 'D5.dup', 'D5.stale'],
  },
];

export const isPresetId = (id: string): boolean => id.startsWith('preset:');

export const findPreset = (id: string): ScoringProfile | null => PRESETS.find(p => p.id === id) ?? null;
