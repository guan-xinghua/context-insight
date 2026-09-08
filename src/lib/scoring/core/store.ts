// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分卡存取（文件实现）：~/.cannbot-insight/scorecards/<sessionId>.json + archive/ 留历史。
// 事实源永远是 turns 数据，表里的卡只是缓存——随时可删、可整目录重算。
// 不动 Prisma（"零 schema 改动"红线不破例）；将来上库只换本文件一个实现。
// 运行时产物住用户目录不住代码目录（与 cpx 捕获文件同惯例，dev.db 迁移另议）；
// 旧仓库 data/scorecards/ 首次访问时自动搬过来。

import { promises as fs } from 'node:fs';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Scorecard } from './types';
import { SCORECARD_SCHEMA } from './types';

export interface BaselineFilter {
  taskType?: 'operator' | 'general' | 'unknown';
  schemaVersion?: string;
}

export interface ScorecardStore {
  get(sessionId: string): Promise<Scorecard | null>;
  put(scorecard: Scorecard): Promise<void>;
  listForBaseline(f?: BaselineFilter): Promise<Scorecard[]>;
}

const SAFE_ID_RE = /^[A-Za-z0-9_.\-]+$/;

function safeFileName(sessionId: string): string {
  if (!SAFE_ID_RE.test(sessionId)) {
    throw new Error(`非法 sessionId（含路径字符）：${sessionId.slice(0, 40)}`);
  }
  return `${sessionId}.json`;
}

function isValidCard(v: unknown): v is Scorecard {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<Scorecard>;
  return c.schemaVersion === SCORECARD_SCHEMA && typeof c.sessionId === 'string';
}

export class FileScorecardStore implements ScorecardStore {
  constructor(private readonly dir: string) {}

  private latestPath(sessionId: string): string {
    return path.join(this.dir, safeFileName(sessionId));
  }

  private archivePath(sessionId: string, computedAt: string): string {
    // safeFileName 校验过 sessionId 合法（无路径字符），目录名用裸 id
    if (!SAFE_ID_RE.test(sessionId)) {
      throw new Error(`非法 sessionId（含路径字符）：${sessionId.slice(0, 40)}`);
    }
    const stamp = computedAt.replace(/[:.]/g, '-');
    return path.join(this.dir, 'archive', sessionId, `${stamp}.json`);
  }

  async get(sessionId: string): Promise<Scorecard | null> {
    try {
      const raw = await fs.readFile(this.latestPath(sessionId), 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return isValidCard(parsed) ? parsed : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(scorecard: Scorecard): Promise<void> {
    // aborted 卡不写盘（整卡出局），调用方直接返回
    if (scorecard.status !== 'completed') return;
    await fs.mkdir(this.dir, { recursive: true });
    const latest = this.latestPath(scorecard.sessionId);
    const prev = await this.get(scorecard.sessionId);
    if (prev) {
      // 历史保留：重算不删旧卡，挪 archive（趋势/对比/远期人工修正都要）
      const archive = this.archivePath(scorecard.sessionId, prev.computedAt);
      await fs.mkdir(path.dirname(archive), { recursive: true });
      await fs.rename(latest, archive);
    }
    const tmp = `${latest}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(scorecard, null, 2), 'utf-8');
    await fs.rename(tmp, latest);   // 原子替换
  }

  async listForBaseline(f: BaselineFilter = {}): Promise<Scorecard[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const cards: Scorecard[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf-8')) as unknown;
        if (!isValidCard(parsed)) continue;
        // 基线语料只收有效测量：否决卡是处分不是成绩，aborted 不存在盘上
        if (parsed.status !== 'completed') continue;
        if (parsed.framework?.veto?.triggered) continue;
        if (f.taskType && parsed.taskType !== f.taskType) continue;
        if (f.schemaVersion && parsed.schemaVersion !== f.schemaVersion) continue;
        cards.push(parsed);
      } catch { /* 单文件损坏跳过，不阻断扫描 */ }
    }
    return cards;
  }
}

/** 用户目录下的应用数据根（cpx 捕获文件同址） */
export const CANNBOT_HOME = path.join(os.homedir(), '.cannbot-insight');

const DEFAULT_DIR = path.join(CANNBOT_HOME, 'scorecards');

/**
 * 一次性迁移：把仓库内旧位置的数据搬到用户目录（目标已有数据则不动，防覆盖；
 * 跨文件系统 rename 失败回退为复制）。best-effort——搬不动就留在原地，不阻断。
 */
export function migrateLegacyDir(legacyDir: string, targetDir: string): 'moved' | 'skipped-target-exists' | 'skipped-no-legacy' | 'failed' {
  try {
    if (!existsSync(legacyDir)) return 'skipped-no-legacy';
    if (existsSync(targetDir) && readdirSync(targetDir).length > 0) return 'skipped-target-exists';
    mkdirSync(targetDir, { recursive: true });
    for (const name of readdirSync(legacyDir)) {
      const from = path.join(legacyDir, name);
      const to = path.join(targetDir, name);
      try {
        renameSync(from, to);
      } catch {
        cpSync(from, to, { recursive: true });   // EXDEV 等跨设备场景
        rmSync(from, { recursive: true, force: true });
      }
    }
    rmdirSync(legacyDir);
    return 'moved';
  } catch {
    return 'failed';
  }
}

let defaultStore: FileScorecardStore | null = null;

export function scorecardStore(): FileScorecardStore {
  if (!defaultStore) {
    if (!process.env.SCORING_DATA_DIR) {
      migrateLegacyDir(path.join(process.cwd(), 'data', 'scorecards'), DEFAULT_DIR);
    }
    defaultStore = new FileScorecardStore(process.env.SCORING_DATA_DIR ?? DEFAULT_DIR);
  }
  return defaultStore;
}
