// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// CANN-Bench 填报：用户从 cannbench.com 排行榜抄总分（百分制）填进 Score 页，
// 折算 0-10 进 D3。存 ~/.cannbot-insight/op-benchmarks/<sessionId>.json。

import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CANNBOT_HOME } from '../store';

export interface SessionOpBenchFile {
  schema: 'workflow-session-op-bench';
  version: 1;
  sessionId: string;
  /** CANN-Bench 总分（百分制 0-100） */
  score: number;
  note?: string;
  filledAt: string;
}

export function opBenchDir(): string {
  if (process.env.SCORING_OP_BENCH_DIR) return process.env.SCORING_OP_BENCH_DIR;
  if (process.env.SCORING_DATA_DIR) return path.join(process.env.SCORING_DATA_DIR, 'op-benchmarks');
  return path.join(CANNBOT_HOME, 'op-benchmarks');
}

export function isValidSessionOpBench(v: unknown): v is SessionOpBenchFile {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (b['schema'] !== 'workflow-session-op-bench' || b['version'] !== 1) return false;
  if (typeof b['sessionId'] !== 'string' || typeof b['filledAt'] !== 'string') return false;
  return typeof b['score'] === 'number' && Number.isFinite(b['score']);
}

export async function loadSessionOpBench(sessionId: string): Promise<SessionOpBenchFile | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(opBenchDir(), `${sessionId}.json`), 'utf-8')) as unknown;
    return isValidSessionOpBench(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function writeSessionOpBench(file: SessionOpBenchFile): Promise<string> {
  const dir = opBenchDir();
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${file.sessionId}.json`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await fs.rename(tmp, target);   // 原子替换
  return target;
}

// 百分制 → 0-10（连续值，不吸档位中点——真实测量不丢信息）
export function benchToScore10(score100: number): number {
  const v = Math.min(100, Math.max(0, score100));
  return Math.round((v / 10) * 100) / 100;
}
