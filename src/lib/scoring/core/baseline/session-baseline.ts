// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 单会话基线：基线 = 一个样例会话（同类任务各设一个），不是语料分布。
// 新会话与基线会话逐指标比比值——与数据仓「范式 baseline 会话」（位置即身份）
// 同构：一个标杆，不做统计。存 ~/.context-insight/baselines/<taskType>.json。

import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CONTEXT_HOME } from '../store';

export interface SessionBaselineMetric {
  value: number;
  unit: string;
}

export interface SessionBaselineFile {
  schema: 'workflow-session-baseline';
  version: 1;
  taskType: 'operator' | 'general' | 'unknown';
  sessionId: string;
  label: string;
  computedAt: string;
  metrics: Record<string, SessionBaselineMetric>;
  /** 概要（可选，新写盘带）：基线会话跑在什么环境——对比时知道"基线是 glm-5.2 跑的" */
  context?: {
    models: string[];
    frameworkVersion: string | null;
  };
}

export function sessionBaselinesDir(): string {
  if (process.env.SCORING_BASELINE_DIR) return process.env.SCORING_BASELINE_DIR;
  if (process.env.SCORING_DATA_DIR) return path.join(process.env.SCORING_DATA_DIR, 'baselines');
  return path.join(CONTEXT_HOME, 'baselines');
}

const TASK_TYPES = ['operator', 'general', 'unknown'] as const;

export function isValidSessionBaseline(v: unknown): v is SessionBaselineFile {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (b['schema'] !== 'workflow-session-baseline' || b['version'] !== 1) return false;
  if (!TASK_TYPES.includes(b['taskType'] as never)) return false;
  if (typeof b['sessionId'] !== 'string' || typeof b['computedAt'] !== 'string') return false;
  if (!b['metrics'] || typeof b['metrics'] !== 'object') return false;
  for (const m of Object.values(b['metrics'] as Record<string, unknown>)) {
    const mm = m as Record<string, unknown>;
    if (typeof mm['value'] !== 'number' || !Number.isFinite(mm['value'])) return false;
  }
  return true;
}

export async function loadSessionBaseline(taskType: string): Promise<SessionBaselineFile | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(sessionBaselinesDir(), `${taskType}.json`), 'utf-8')) as unknown;
    return isValidSessionBaseline(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function writeSessionBaseline(file: SessionBaselineFile): Promise<string> {
  const dir = sessionBaselinesDir();
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${file.taskType}.json`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await fs.rename(tmp, target);   // 原子替换
  return target;
}

// ── 比值打分（lower-better 全体适用）：本次/基线 = ratio ──
// score = clamp((2 − ratio) / 1.25, 0, 1)：好 25% 封顶 1.0，与基线持平 0.8，2 倍基线归 0。
// 基线已到 0（理论最优）时无法再被"优于"：本次也为 0 → 两边都到天花板，给满分；
// 基线 0 而本次 >0 → 基线零冗余你都出了冗余，直接 0。

export function ratioScore(value: number, ref: number): number {
  if (ref <= 0) return value <= 0 ? 1 : 0;
  const ratio = value / ref;
  return Math.round(Math.max(0, Math.min(1, (2 - ratio) / 1.25)) * 100) / 100;
}

export function ratioGrade(value: number, ref: number): '优于基线' | '与基线相当' | '同为最优' | '差于基线' {
  if (ref <= 0) return value <= 0 ? '同为最优' : '差于基线';
  const ratio = value / ref;
  if (ratio <= 0.9) return '优于基线';
  return ratio <= 1.25 ? '与基线相当' : '差于基线';
}
