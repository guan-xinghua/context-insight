// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D3 完成质量（加权维）：正确性不及格，总分不许及格（average-with-floor）。
// v1 语义八维去向：G4 归 D1.goalCoverage；S1 移出评分卡；S2 挪 D5；其余并入通用五项。

import type { Band, DimensionDefinition, ScoreItemSchema } from '../core/schema';

const BAND_KEYS = ['0-2', '3-4', '5-6', '7-8', '9-10'] as const;
const BAND_LABELS = ['严重缺陷', '明显问题', '基本达成，有明显改进空间', '良好', '优秀'];

function bands(descs: readonly [string, string, string, string, string]): Band[] {
  return BAND_KEYS.map((key, i) => ({ range: key, label: BAND_LABELS[i], description: descs[i] }));
}

const COMMON_BANDS = {
  correctness: bands([
    '输出错误且未修复，或验证明确 FAIL 后放弃',
    '存在未闭环的错误输出，靠多轮返工才部分纠正',
    '主要输出正确，但有可观察的偏差或需要事后修正',
    '输出正确且有验证证据，仅少量无害瑕疵',
    '输出完全正确且一次通过，验证证据完备',
  ]),
  instruction: bands([
    '大面积无视显式指令或格式要求',
    '多处违反约束，需要外部指出才纠正',
    '基本遵循，存在个别格式/约束偏差',
    '遵循良好，仅边缘情况有轻微偏离',
    '完全遵循，含隐含约定也无违反',
  ]),
  robustness: bands([
    '异常路径未处理，失败即中断',
    '异常处理零散，常见边界会出错',
    '有基本错误处理，部分边界未验证',
    '异常路径系统覆盖，失败可恢复',
    '边界系统化验证，失败自愈且留痕',
  ]),
  maintainability: bands([
    '过程杂乱无章，无法复用',
    '结构混乱，关键决策无留痕',
    '有基本结构，分段与命名不一致',
    '结构清晰，决策可追溯',
    '高度结构化，可直接作为范例复用',
  ]),
  safeCoding: bands([
    '输入不校验、边界不检查、资源不释放，明显隐患',
    '部分输入校验，关键边界缺检查',
    '主要入口有校验，个别边界遗漏',
    '输入校验与边界检查系统覆盖，资源正常释放',
    '全面防护（校验/防溢出/释放）且验证过边界行为',
  ]),
} as const;

function llmItem(id: string, name: string, itemBands: Band[], note?: string): ScoreItemSchema {
  return { id, dimension: 'D3', name, scorerKind: 'llm', bands: itemBands, note };
}

const items: ScoreItemSchema[] = [
  { id: 'D3.cannBench', dimension: 'D3', name: 'CANN-Bench 评分', scorerKind: 'user-input', note: '用户填报 CANN-Bench 总分（cannbench.com，百分制）折算 0-10；未填报按默认 80 持平档计并明标' },
  { id: 'D3.testResults', dimension: 'D3', name: '测试结果', scorerKind: 'rule', note: '从工具输出数通过/失败——质量最硬的证据；部分失败给部分分' },
  { id: 'D3.nakedWrite', dimension: 'D3', name: '不读就写', scorerKind: 'rule', note: '改文件前从没读过——没看过就动手，写错概率高（v1 迁移）' },
  llmItem('D3.correctness', '正确性', [...COMMON_BANDS.correctness], '逻辑对不对、验证证据、错误闭环'),
  llmItem('D3.instruction', '指令遵循', [...COMMON_BANDS.instruction], '格式、约束、用户明说的要求'),
  llmItem('D3.robustness', '鲁棒性', [...COMMON_BANDS.robustness], '异常路径、边界输入、失败恢复'),
  llmItem('D3.maintainability', '可维护性', [...COMMON_BANDS.maintainability], '结构、命名、决策留痕、可复用'),
  llmItem('D3.safeCoding', '安全编码', [...COMMON_BANDS.safeCoding], '输入校验、防溢出、边界检查、资源释放——任何代码都该有的基础防护'),
];

export const d3Quality: DimensionDefinition = {
  id: 'D3',
  name: '完成质量',
  english: 'Quality',
  role: 'weighted',
  weightInTotal: 0.35,
  items,
  // 正确性 ≤2/10 → 总分封顶 4/10：漂亮注释不能把错误代码平均成好代码
  aggregation: { kind: 'average-with-floor', floorItemId: 'D3.correctness', floorThreshold: 0.2, floorMaxScore: 0.4 },
};

export const d3Focus: Record<string, string> = {
  'D3.correctness': '产出是否正确：逻辑对不对、验证证据（test/build 通过）、错误是否闭环',
  'D3.instruction': '是否遵守格式/约束要求：输出格式、命名/路径约定、用户显式约束',
  'D3.robustness': '异常与边界处理：错误输入、空值、失败重试与恢复路径',
  'D3.maintainability': '结构清晰度：步骤组织、命名与分段、决策留痕、后续可复用性',
  'D3.safeCoding': '安全编码：输入校验、防溢出、边界检查、资源释放',
};
