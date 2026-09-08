// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// P2 语义层 Rubric：G/S 八维（定义沿用 prompts/session-trajectory-analyse.md）
// + 0-10 五档分段锚定（DeepEval anchored rubric 先例）。锚定档为结构化数据，
// 与投票/公示面板同源——改这里，prompt 与公示同步变。

export type BandKey = '0-2' | '3-4' | '5-6' | '7-8' | '9-10';

export const BANDS: Array<{ key: BandKey; label: string }> = [
  { key: '0-2', label: '严重缺陷' },
  { key: '3-4', label: '明显问题' },
  { key: '5-6', label: '基本达成，有明显改进空间' },
  { key: '7-8', label: '良好' },
  { key: '9-10', label: '优秀' },
];

export interface RubricDimension {
  id: string;
  label: string;
  focus: string;
  anchors: Record<BandKey, string>;
}

export const SEMANTIC_DIMENSIONS: RubricDimension[] = [
  {
    id: 'G1', label: '正确性', focus: '产出是否正确：输出与任务要求一致、验证证据（test/build 通过）、错误是否闭环',
    anchors: {
      '0-2': '输出错误且未修复，或验证明确 FAIL 后放弃',
      '3-4': '存在未闭环的错误输出，靠多轮返工才部分纠正',
      '5-6': '主要输出正确，但有可观察的偏差或需要事后修正',
      '7-8': '输出正确且有验证证据，仅少量无害瑕疵',
      '9-10': '输出完全正确且一次通过，验证证据完备',
    },
  },
  {
    id: 'G2', label: '指令遵循', focus: '是否遵守格式/约束要求：输出格式、命名/路径约定、用户显式约束',
    anchors: {
      '0-2': '大面积无视显式指令或格式要求',
      '3-4': '多处违反约束，需要外部指出才纠正',
      '5-6': '基本遵循，存在个别格式/约束偏差',
      '7-8': '遵循良好，仅边缘情况有轻微偏离',
      '9-10': '完全遵循，含隐含约定也无违反',
    },
  },
  {
    id: 'G3', label: '安全性', focus: '数值稳定性/边界溢出/内存与资源风险是否被识别和处理',
    anchors: {
      '0-2': '引入明显稳定性/资源风险且未处理',
      '3-4': '存在已知风险场景但防护缺失',
      '5-6': '主要风险已处理，个别边界未覆盖',
      '7-8': '风险识别充分，关键边界有防护',
      '9-10': '全面防护且验证过边界行为',
    },
  },
  {
    id: 'G4', label: '完整性', focus: '必要方面是否覆盖：验收要点、任务显式/隐含目标的完成度',
    anchors: {
      '0-2': '关键目标缺失或大面积未完成',
      '3-4': '明显缺项，验收要点覆盖不足一半',
      '5-6': '主体完成，存在可识别的缺口',
      '7-8': '目标基本全覆盖，仅次要项缺失',
      '9-10': '全部目标完成且有对应证据',
    },
  },
  {
    id: 'G5', label: '鲁棒性', focus: '异常与边界处理：错误输入、空值、失败重试与恢复路径',
    anchors: {
      '0-2': '异常路径未处理，失败即中断',
      '3-4': '异常处理零散，常见边界会出错',
      '5-6': '有基本错误处理，部分边界未验证',
      '7-8': '异常路径系统覆盖，失败可恢复',
      '9-10': '边界系统化验证，失败自愈且留痕',
    },
  },
  {
    id: 'S1', label: '可执行性', focus: '声明质量：指令是否无歧义、输入输出明确、目标边界清晰（对 SKILL/工作流声明）',
    anchors: {
      '0-2': '声明不可执行：严重歧义或关键信息缺失',
      '3-4': '多处歧义/IO 不明，执行者需大量猜测',
      '5-6': '大体可执行，局部表述含糊',
      '7-8': '指令清晰，IO 与边界明确',
      '9-10': '完全可执行，含示例与边界说明',
    },
  },
  {
    id: 'S2', label: '成本意识', focus: '过程是否精炼：冗余调用、重复注入、无效轮次的控制',
    anchors: {
      '0-2': '大量冗余调用/无效轮次，成本失控',
      '3-4': '明显重复劳动，返工与重复读取频繁',
      '5-6': '存在可识别的冗余，整体可控',
      '7-8': '过程精炼，少量无害重复',
      '9-10': '几乎零冗余，每轮都有明确增量',
    },
  },
  {
    id: 'S3', label: '可维护性', focus: '结构清晰度：步骤组织、命名与分段、后续可复用性',
    anchors: {
      '0-2': '过程杂乱无章，无法复用',
      '3-4': '结构混乱，关键决策无留痕',
      '5-6': '有基本结构，分段与命名不一致',
      '7-8': '结构清晰，决策可追溯',
      '9-10': '高度结构化，可直接作为范例复用',
    },
  },
];

export function buildSemanticSystemPrompt(): string {
  const dims = SEMANTIC_DIMENSIONS
    .map(d => [
      `## ${d.id} ${d.label}`,
      `考察点：${d.focus}`,
      ...BANDS.map(b => `- ${b.key}（${b.label}）：${d.anchors[b.key]}`),
    ].join('\n'))
    .join('\n\n');

  return `你是 workflow 轨迹的过程质量评审员（取证型 judge）。依据给定的 session 轨迹摘要，对以下 8 个维度逐一评分。

评分规则：
1. 按分段锚定描述定位分数（0-10 整数）
2. 只依据摘要中可见的证据评分；某维证据不足时 score 填 null（NOT_EVALUATED 弃权），reason 说明缺什么证据——禁止臆测
3. evidence 填轨迹摘要里的 turn 序号引用，格式 "§N"（如 ["§12","§45"]）；弃权时可为空数组
4. reason 一句话，点明关键证据与判断依据

${dims}

严格输出 JSON（无 markdown 代码块标记）：
{"dimensions":[{"id":"G1","score":8,"reason":"…","evidence":["§12"]},{"id":"G2","score":null,"reason":"证据不足：…","evidence":[]},…]}
8 个维度（G1-G5、S1-S3）都必须出现，score 为 0-10 整数或 null。`;
}

export function buildSemanticUserPrompt(turnDigest: string, bridgeDigest: string): string {
  return `## Turn 列表
每条格式: #序号 role标记 +相对时间 tokens latency tools "摘要"
${turnDigest}

## Subagent Dispatch 记录
每条格式: dispatch#序号 [时间] [type] [name] "任务" → status tokens
${bridgeDigest}

请按系统指令对以上轨迹评分，输出 JSON。`;
}
