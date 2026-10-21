// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FIT FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D5 冗余度（加权维）：白背的上下文 + 白干的尝试。
// D4 看一共花了多少（总量），D5 看花掉的里面多少是白背/白干的（比率）。
// 重派 55% 大头——实测一次 subagent 重派是十几 turn、M 级 token 的完整子会话，
// 是最大的单点冗余；原样连发（低层重复）15%；工具调用出错（白干频率）10%；
// 两类 token 比率各 5%、熟练度 10%（项目说明相关性已删——CLAUDE.md 在提示词里，
// 指令遵循 D3.instruction 已审计遵从情况，重复评没有增量）。

import type { Band, DimensionDefinition, ScoreItemSchema } from '../core/schema';

const PROFICIENCY_BANDS: Band[] = [
  { range: '0-2', label: '严重缺陷', description: '大量轮次零进展：绕路、白干、每步看着都在动但没有实际推进' },
  { range: '3-4', label: '明显问题', description: '多条明显的无效路径：走到一半放弃、换方向重来' },
  { range: '5-6', label: '基本达成', description: '有可识别的绕路，但整体在推进' },
  { range: '7-8', label: '良好', description: '每步基本直接推进任务，少量无害的探索' },
  { range: '9-10', label: '优秀', description: '几乎每轮都有明确增量；工具返回的结果后续都真正用上了' },
];

const items: ScoreItemSchema[] = [
  { id: 'D5.tools', dimension: 'D5', name: '没用上的工具说明', scorerKind: 'rule', diagnostic: true, note: '声明了却从未调用——工具列表每会话全量注入，单会话没用不代表浪费；只统计不扣分' },
  { id: 'D5.skills', dimension: 'D5', name: '没用上的 skill', scorerKind: 'rule', diagnostic: true, note: 'CLI 内置技能不可控已剔除，只评用户/项目装的那部分；skill 每会话全量注入，单会话没用不代表浪费；只统计不扣分' },
  { id: 'D5.dup', dimension: 'D5', name: '重复塞进来的内容', scorerKind: 'baseline-compare', weight: 0.05, note: '只看单次请求内部（k 份相同算 k−1 份白背）；跨轮前缀重发不算——恒真无信息量' },
  { id: 'D5.stale', dimension: 'D5', name: '过期的旧结果', scorerKind: 'baseline-compare', weight: 0.05, note: '文件已改，旧工具结果还留在上下文里' },
  { id: 'D5.redispatch', dimension: 'D5', name: 'subagent 重派', scorerKind: 'rule', weight: 0.55, note: '同任务重派（编号聚簇，不要求连续）×50 当量——一次重派是十几 turn、M 级 token 的完整子会话，非常大的冗余；环境类重试豁免' },
  { id: 'D5.repeat', dimension: 'D5', name: '原样重复', scorerKind: 'rule', weight: 0.15, note: '同参数原样连发 ≥3（工具/调用层的低层重复，单价低轻罚）；环境类重试豁免' },
  { id: 'D5.toolErrors', dimension: 'D5', name: '工具调用出错', scorerKind: 'rule', weight: 0.10, note: '可避免错误率（路径/参数/语法/文件不存在/权限不足；环境类豁免）×10 线性扣——错误的代价归 D4 比值罚，这里只罚白干频率；原样重复段内只计首错（后续重发归 D5.repeat）' },
  { id: 'D5.proficiency', dimension: 'D5', name: '工作过程熟练度', scorerKind: 'llm', weight: 0.10, bands: PROFICIENCY_BANDS, note: 'v1 语义 S2 挪来改名：每轮有没有实际进展；结果为空或失败后的合理重试不算忽略' },
];

export const d5Redundancy: DimensionDefinition = {
  id: 'D5',
  name: '冗余度',
  english: 'Redundancy',
  role: 'weighted',
  weightInTotal: 0.15,
  items,
  aggregation: { kind: 'weighted-average' },
};
