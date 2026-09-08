// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分卡类型（角色④产出）：列表结构，不写死维度——新维度 = dimensions 多一个元素。

import type { DimensionRole } from './schema';

export const SCORECARD_SCHEMA = 'workflow-scorecard@2' as const;

export interface Evidence {
  turnIndex: number | null;
  label: string;
  quote?: string;
}

export interface SubItemResult {
  itemId: string;
  label: string;
  status: 'ok' | 'not-applicable' | 'error';
  /** 原始值：比率 / 次数 / 分数（0-10）/ 判定串——按子项类型而异 */
  value?: number | string | boolean;
  unit?: string;
  /** 归一化分（0-1）；verdict 型子项没有 */
  score?: number | null;
  /** 基线对比分（0-1，方向感知位置分）；双轨显示：绝对值与对比分并排 */
  baselineScore?: number | null;
  verdict?: string;       // '完成'|'未完成'|'无法判定' / 'violation'|'suspected'|'clean' / 子项中间判定
  formula?: string;       // 账本原则：可展开复算
  evidence: Evidence[];
  attribution?: Array<{ label: string; tokens?: number; pct?: number }>;
  note?: string;
  error?: { message: string };
}

export interface DimensionResult {
  dimensionId: string;
  name: string;
  english: string;
  custom?: boolean;        // D7 用户自定义
  role: DimensionRole;
  status: 'scored' | 'not-applicable' | 'error';
  score?: number | null;   // 0-1；否决维无分数
  verdict?: string;        // 否决维三态
  disclose?: string;       // 命中披露文案（如「无验证证据」）
  items: SubItemResult[];
}

export interface Scorecard {
  schemaVersion: typeof SCORECARD_SCHEMA;
  sessionId: string;
  taskType: 'operator' | 'general' | 'unknown';
  computedAt: string;
  /** 截断 → aborted：整卡出局，不写盘、不进基线语料 */
  status: 'completed' | 'aborted';
  abortReason?: 'truncated';
  framework: {
    totalScore: number | null;
    veto: { triggered: boolean; reasons: string[] } | null;
    /** 覆盖度折扣 = 已评项 / 应评项（not-applicable 与 error 都不入分子） */
    coverage: number;
    weightsUsed: Record<string, number>;
    /** 口径快照：生效的评分配置 profile（null = 默认口径）；旧缓存卡无此字段按默认显示 */
    profile?: { id: string; name: string } | null;
  };
  dimensions: DimensionResult[];
  judgeCost: { calls: number; tokens: number } | null;
  /** 概要：会话身份信息（模型/工具/版本等）——不参与任何评分，跨 session 对比时的参考上下文 */
  context?: {
    models: string[];
    tools: string[];
    frameworkVersion: string | null;
    turns: number;
    totalTokens: number;
  };
  meta?: { semanticUsed: boolean; scorerVersion: string; judgeLogFile?: string };
}
