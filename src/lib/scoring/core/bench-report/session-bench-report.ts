// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基准测试填报：用户从基准测试排行榜抄总分（百分制）填进 Score 页，
// 折算 0-10 进 D3。存 ~/.context-insight/bench-reports/<sessionId>.json。
// 旧名目录（op-benchmarks/，旧 schema workflow-session-op-bench）读兜底——
// 存量填报无感迁移：读旧写新，首次保存即落新目录，旧文件原地保留。

import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CONTEXT_HOME } from '../store';

const BENCH_REPORT_SCHEMA = 'workflow-session-bench-report';
const LEGACY_BENCH_REPORT_SCHEMA = 'workflow-session-op-bench';

export interface SessionBenchReportFile {
  schema: 'workflow-session-bench-report';
  version: 1;
  sessionId: string;
  /** 基准测试总分（百分制 0-100） */
  score: number;
  note?: string;
  filledAt: string;
}

export function benchReportDir(): string {
  if (process.env.SCORING_BENCH_REPORT_DIR) return process.env.SCORING_BENCH_REPORT_DIR;
  if (process.env.SCORING_DATA_DIR) return path.join(process.env.SCORING_DATA_DIR, 'bench-reports');
  return path.join(CONTEXT_HOME, 'bench-reports');
}

function legacyBenchReportDir(): string {
  if (process.env.SCORING_DATA_DIR) return path.join(process.env.SCORING_DATA_DIR, 'op-benchmarks');
  return path.join(CONTEXT_HOME, 'op-benchmarks');
}

function isValidBenchReportShape(v: unknown, schemas: readonly string[]): v is SessionBenchReportFile {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (typeof b['schema'] !== 'string' || !schemas.includes(b['schema']) || b['version'] !== 1) return false;
  if (typeof b['sessionId'] !== 'string' || typeof b['filledAt'] !== 'string') return false;
  return typeof b['score'] === 'number' && Number.isFinite(b['score']);
}

export function isValidSessionBenchReport(v: unknown): v is SessionBenchReportFile {
  return isValidBenchReportShape(v, [BENCH_REPORT_SCHEMA, LEGACY_BENCH_REPORT_SCHEMA]);
}

export async function loadSessionBenchReport(sessionId: string): Promise<SessionBenchReportFile | null> {
  // 读序：新目录（严格新 schema）→ 旧目录（新旧 schema 都认）。命中旧 schema
  // 归一成新形态返回——消费方只见单一 schema，写侧永远落新目录
  for (const [dir, schemas] of [
    [benchReportDir(), [BENCH_REPORT_SCHEMA]],
    [legacyBenchReportDir(), [BENCH_REPORT_SCHEMA, LEGACY_BENCH_REPORT_SCHEMA]],
  ] as const) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, `${sessionId}.json`), 'utf-8')) as unknown;
      if (isValidBenchReportShape(raw, schemas)) {
        return { ...raw, schema: BENCH_REPORT_SCHEMA };
      }
    } catch { /* 无/坏文件 → 下一候选 */ }
  }
  return null;
}

export async function writeSessionBenchReport(file: SessionBenchReportFile): Promise<string> {
  const dir = benchReportDir();
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
