// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D1 完成度（未完成→一票否决，总分 0；维度分照常出供诊断）：三层结构——代码直算 D1.stopReason~verifiedRun 出三态，
// LLM 层 D1.acceptance/goalCoverage 把"无法判定"升级为逐条确凿结论（已判"未完成"不翻案）。
// 组合表（设计 §2.3）是数据：顺序敏感，负向规则在前（宁严），LLM 正向只救无法判定。
// 未完成 → 总分 ≤ 50 × 完成度分（completionScoreOf 子项均值：todo 比例/对账率/验证/清单/目标）。

import type { DimensionDefinition, ScoreItemSchema } from '../core/schema';

const items: ScoreItemSchema[] = [
  { id: 'D1.stopReason', dimension: 'D1', name: '结束原因', scorerKind: 'rule', note: '截断 → 整卡中止；错误崩溃 → 未完成' },
  { id: 'D1.selfReport', dimension: 'D1', name: '自报完成态', scorerKind: 'rule', note: '末次 TodoWrite 的 todos status——自报不是证据，只参与组合' },
  { id: 'D1.planReconcile', dimension: 'D1', name: '计划对账', scorerKind: 'rule', note: 'Todo 步骤去工具调用里找执行痕迹，只取两端（高匹配正面/大量缺失负面）' },
  { id: 'D1.verifiedRun', dimension: 'D1', name: '验证证据', scorerKind: 'rule', note: '白名单验证命令，须在最后一次改代码之后跑且通过' },
  {
    id: 'D1.acceptance', dimension: 'D1', name: '验收清单对账', scorerKind: 'llm',
    note: '工作流验收标准逐条对账（LLM 主判，最强信号）；context 无声明则不适用',
  },
  {
    id: 'D1.goalCoverage', dimension: 'D1', name: '目标覆盖对账', scorerKind: 'llm',
    note: '无验收标准时兜底：从首轮消息拆目标点逐项判',
  },
];

export const d1Completion: DimensionDefinition = {
  id: 'D1',
  name: '完成度',
  english: 'Completion',
  role: 'veto',
  items,
  aggregation: {
    kind: 'three-state',
    completionScoreOf: ['D1.selfReport', 'D1.planReconcile', 'D1.verifiedRun', 'D1.acceptance', 'D1.goalCoverage'],
    rules: [
      { when: { 'D1.stopReason': 'error' }, then: '未完成', disclose: '错误崩溃收场' },
      { when: { 'D1.acceptance': 'unmet' }, then: '未完成', disclose: '验收清单有未达标/未执行项' },
      { when: { 'D1.goalCoverage': 'missing' }, then: '未完成', disclose: '关键目标未完成' },
      { when: { 'D1.selfReport': 'incomplete' }, then: '未完成', disclose: 'Todo 有未勾项且之后再无动作' },
      { when: { 'D1.selfReport': 'completed', 'D1.verifiedRun': 'failed' }, then: '未完成', disclose: '自报完成但末次验证失败' },
      { when: { 'D1.selfReport': 'completed', 'D1.verifiedRun': 'passed' }, then: '完成' },
      { when: { 'D1.selfReport': 'completed', 'D1.planReconcile': 'low' }, then: '未完成', disclose: '未验证的成功：自报完成 + 大量步骤无痕迹 + 无验证' },
      { when: { 'D1.acceptance': 'met' }, then: '完成' },
      { when: { 'D1.goalCoverage': 'covered' }, then: '完成' },
      { when: { 'D1.selfReport': 'completed', 'D1.planReconcile': 'high' }, then: '完成', disclose: '无验证证据，完成判定降一档置信' },
    ],
    fallback: '无法判定',
  },
};
