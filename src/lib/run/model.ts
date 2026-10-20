// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 域领域类型（workflow-bundle manifest 的内部模型）。
// 契约源头：docs/design/run-observation/design.md §4.1 + 格式手册
// workflow-bundle-format.md（草案 v1，schema "cannbot.workflow-bundle"）。
// 信封冻结原则（对齐 cannbay-schema-spec）：(schema, version) 声明式分发；
// 未知字段一律透传（索引签名），加可选字段不升版，改语义必升版。

export const BUNDLE_SCHEMA = 'cannbot.workflow-bundle' as const;
export const BUNDLE_VERSION = 1 as const;

/** workflow-bundle 清单文件在包目录内的候选名（workflow.json 优先，manifest.json
 * 兼容旧导出件）。browse 高亮（ingest/browse-directory）与 import 接受
 * （run/import-service）共用这一真身，避免两处硬编码静默分叉。 */
export const MANIFEST_FILENAMES = ['workflow.json', 'manifest.json'] as const;

export type MemberKind = 'process' | 'session' | 'workflow';
export type MemberRole = 'execute' | 'verify';

/** graph 插件注解（annotation.graph）：五键定位 + 尝试/验收结论。
 * 字段语义见格式手册 §7；这里只收观测需要的稳定字段，其余透传。 */
export interface RunGraphAnnotation {
  nodeId: string;
  generation: number;          // 回滚代，0 起
  attempt: number;             // 本代尝试号；0 = 未运行空占位
  role: MemberRole;
  attemptResult?: 'succeeded' | 'failed';
  verification?: { type?: string; status?: string; reason?: string } & Record<string, unknown>;
  retryPolicy?: { maxRetries?: number; onExhaust?: string; rollbackToNodeId?: string } & Record<string, unknown>;
  runOnFailure?: boolean;
  executionState?: 'executed' | 'not_run' | 'carried';
  resultFromGeneration?: number;
  [k: string]: unknown;        // 未知字段透传，不丢数据
}

export interface RunMember {
  id: string;                  // 整棵成员树唯一
  kind: MemberKind;
  name?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  sessionId?: string | null;   // session 成员指向会话正文（源身份，非 DB 行 id）
  location?: string | null;    // 会话目录相对包根的 POSIX 路径
  output?: { text?: string } | null;
  annotation?: { note?: string; graph?: RunGraphAnnotation } & Record<string, unknown>;
  data?: RunWorkflowData;      // workflow 成员递归（子图）
  [k: string]: unknown;
}

export interface RunRelation {
  from: string;                // 成员 id（可跨层级）
  to: string;
  /** type: depends_on/rollback；gen-sub-graph 双形态（手册 kind=，真实导出件 type=） */
  annotation?: { type?: 'depends_on' | 'rollback' | 'gen-sub-graph'; kind?: 'gen-sub-graph'; note?: string; graph?: Record<string, unknown> } & Record<string, unknown>;
  [k: string]: unknown;
}

export interface RunWorkflowData {
  exportDataComplete?: boolean;
  members: RunMember[];
  relations: RunRelation[];
  [k: string]: unknown;
}

export interface RunManifest {
  schema: typeof BUNDLE_SCHEMA;
  version: number;
  id: string;                  // runId（存储目录名）
  kind: string;
  name?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  data: RunWorkflowData;
  [k: string]: unknown;
}

/** 五键定位：成员 → 图位置的唯一寻址（根 workflow id 由 runId 承载）。 */
export interface MemberFiveKey {
  nodeId: string;
  generation: number;
  attempt: number;
  role: MemberRole;
}

/** 五键的稳定字符串形式（Map 键 / API 查询参数共用）。 */
export function fiveKeyOf(key: MemberFiveKey): string {
  return `${key.nodeId}|${key.generation}|${key.attempt}|${key.role}`;
}

/** 成员会话与 Prisma Session 行的 join 结果（session-link 生产；view-model
 * 的成员引用携带可选字段保持纯函数，API 层组装时注入）。 */
export interface SessionRef {
  taskId: string;              // 即成员 sessionId（源身份）
  framework: string;           // 落库行归属（消歧后）
  rowId: string;               // Prisma Session.id
  turns: number;
  totalTokens: number;
  durationMs: number | null;
  label: string | null;
  startTime: string | null;    // 会话起止（ISO）：成员 manifest 常缺时间戳，展示层用会话行起止兜底
  endTime: string | null;
  cacheReadTokens: number | null; // 指标透镜（缓存命中占比）
  /** 上下文峰值水位（0-100）：该会话全部 turn 的 contextWindowPct 最大值。
   *  可选——旧响应/测试 fixture 可缺省，消费方按无数据处理。 */
  contextPeakPct?: number | null;
  /** 评分卡规则层融合（第六刀）：会话内行为质量的确定性评分——D4 效率/D5
   *  冗余的规则子项加权分（子集归一，非整卡维度分），findings 只保留异常
   *  信号（满分项不占版面）。可选——缺省按无评分数据处理。 */
  ruleScores?: SessionRuleScores | null;
}

/** 评分卡规则层的一条异常信号（评分 <1 的子项；D4.parallel 除外——串行 0.8
 *  即持平，是事实不是缺陷）。evidence 只带轮次与标签，不带原文引用；
 *  value 是评分器的原始计数值（次数 / "白干数/总数"），展示层据此说白话。 */
export interface RuleFinding {
  itemId: string;
  label: string;
  score: number;
  value: number | string | null;
  formula: string | null;
  note: string | null;
  evidence: Array<{ turnIndex: number | null; label: string }>;
}

/** 会话规则分：null = 规则层不可评（无工具调用等，聚合后无 ok 项）。 */
export interface SessionRuleScores {
  /** D4 效率规则分（并行度+压缩，子集归一） */
  d4: number | null;
  /** D5 冗余规则分（重派+原样重复+白干错误，子集归一）——「冗余」透镜的值源 */
  d5: number | null;
  findings: RuleFinding[];
}
