// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 装配产物（角色①）：九种料。评分器按 needs 声明取用。

export interface ScoreTurn {
  id: string;
  turnIndex: number;
  role: string;
  agentName: string | null;
  isSubagent: boolean;
  subagentSessionId: string | null;
  contentSummary: string | null;
  content: string | null;
  totalTokens: number;
  inputTokens: number;
  inputMessagesTokens: number;
  latencyMs: number;
  createdAtISO: string | null;
  createdAtTsISO: string | null;
  model: string | null;
}

export interface ScoreToolCall {
  id: string;
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  state: string;
  errorType: string | null;
  /** 失败诊断原文——D5.toolErrors 按它切"可避免 / 环境类"错误 */
  errorMessage?: string | null;
  durationMs: number;
  /** 执行区间（epoch ms）——并行度用；durationMs 缺失时也从它推导（采集侧只回填了时间戳） */
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  turnIndex: number;
  isSubagent: boolean;
  agentName: string | null;
  seq: number;
}

export interface ScoreExecution {
  agentName: string;
  isSubagent: boolean;
  tokens: number;
  cost: number;
  latencyMs: number;
  toolCallCount: number;
  toolCallErrorCount: number;
}

/** 上下文构成（D5 原料）；非 proxy 的 session 为 null */
export interface WireSummary {
  declaredTools?: Array<{ name: string; approxTokens: number }>;
  availableSkills?: Array<{ name: string; description: string; approxTokens: number }>;
  /** 轮内重复注入副本（k 份计 k−1 份） */
  dupCopyTokens: number;
  /** 过期工具结果滞留 */
  staleResultTokens: number;
  /** 请求字符总量（比率的分母） */
  requestTokens: number;
  /** 项目说明（CLAUDE.md 等）注入量 */
  memoryTokens?: number;
  staleFiles?: Array<{ file: string; chars: number }>;
  perRound?: Array<{ index: number; dupCopyChars: number }>;
  /** 工具执行区间（wire 轮间隙推导，主链+子代理）：D4.toolTime/parallel 与 Perf 共用 */
  toolIntervals?: import('@/lib/tool-timing').ToolInterval[];
}

/** 捕获层脱敏命中（只记类型/位置/轮次，不含原文） */
export interface RedactionEvent {
  turnIndex: number;
  pattern: string;                 // 厂商格式（确凿）/ 泛格式（疑似）
  location: 'request' | 'tool-args' | 'file-write';
}

export interface Measures {
  totalTokens: number;
  /** 工具执行时间之和（进 D4 分） */
  toolTimeMs: number;
  /** LLM 推理时间（只展示，不进分） */
  llmTimeMs: number;
  /** 供 D5 比率的分母 */
  inputTokens: number;
}

/** 工作流声明：从 context（system prompt / memory）读，统一一个来源 */
export interface WorkflowDeclaration {
  acceptance?: string;
  redlines?: string;
  taskTypeTags?: string[];
  source: 'context';
}

export interface AssembledInput {
  /** 轨迹摘要（喂 LLM，不截尾） */
  trajectoryDigest: string;
  /** 项目说明（CLAUDE.md 等）节选（喂 D5 相关性评审；无捕获为空串） */
  memoryDigest: string;
  /** 用户消息原文表（喂 D6 分类） */
  userMessages: Array<{ turnIndex: number; text: string; at: string | null }>;
  toolCalls: ScoreToolCall[];
  turns: ScoreTurn[];
  measures: Measures;
  taskType: 'operator' | 'general' | 'unknown';
  workflowDecl: WorkflowDeclaration | null;
  finishReason: 'normal' | 'truncated' | 'error' | 'unknown';
  interrupts: Array<{ turnIndex: number }>;
  wire: WireSummary | null;
  redactionEvents: RedactionEvent[];
  executions: ScoreExecution[];
}

/** 一次评审调用的调用方上下文（过程日志用；不传也能跑） */
export interface JudgeCallMeta {
  dimensionId: string;
  itemId: string;
  itemName: string;
}

/** LLM 通道（评分器只依赖此接口；未配语义评审时为 undefined → LLM 评分器弃权） */
export interface LlmClient {
  /** 返回文本与用量；实现方负责 URL 归一（buildChatUrl）与 json_object 约束 */
  complete(system: string, user: string, meta?: JudgeCallMeta): Promise<{ content: string; promptTokens: number; completionTokens: number }>;
  readonly model: string;
}
