// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 域会话隔离读侧（design 补充决策）：bundle 导入的成员会话行（sidecar
// ownedSessions 精确到 (taskId, framework) 对）不进 Sessions 域视图——首页
// 计数/聚合/列表排除，run 删除时级联清理。用户自有会话（导入前已存在、
// sourcePath 不在包内）不受影响。轻量扫描只读 import.json sidecar，不碰
// manifest 大文件。

import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { RunImportMeta } from './run-store';
import { cascadeDeleteSessionRows } from '@/lib/ingest/session-cascade';

export interface RunOwnedSessionRow {
  sid: string;
  framework: string | null;
}

function ownedKey(sid: string, framework: string | null): string {
  return `${sid}\u0000${framework ?? ''}`;
}

/** 全部 run 声明的 owned 会话对（扫描各 run 目录的 import.json；坏目录跳过）。 */
export function runOwnedSessionRows(root: string): RunOwnedSessionRow[] {
  if (!fs.existsSync(root)) return [];
  const out: RunOwnedSessionRow[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sidecar = path.join(root, entry.name, 'import.json');
    try {
      const meta = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as RunImportMeta;
      for (const row of meta?.data?.ownedSessions ?? []) {
        if (row && typeof row.sid === 'string') {
          out.push({ sid: row.sid, framework: typeof row.framework === 'string' ? row.framework : null });
        }
      }
    } catch {
      // 坏 sidecar 不阻断隔离计算（与 listRuns 的降级口径一致）
    }
  }
  return out;
}

/** Sessions 域视图排除集：owned 对命中的 Prisma 行 id。空集 = 无 run 会话。 */
export async function excludedSessionIds(prisma: PrismaClient, root: string): Promise<string[]> {
  const owned = runOwnedSessionRows(root);
  if (owned.length === 0) return [];
  const ownedKeys = new Set(owned.map(o => ownedKey(o.sid, o.framework)));
  const sids = [...new Set(owned.map(o => o.sid))];
  const rows = await prisma.session.findMany({
    where: { taskId: { in: sids } },
    select: { id: true, taskId: true, framework: true },
  });
  return rows.filter(r => ownedKeys.has(ownedKey(r.taskId, r.framework))).map(r => r.id);
}

/** run 删除级联：清理由该 run 导入的会话行（owned 对精确匹配，含子行）。 */
export async function deleteOwnedSessionRows(
  prisma: PrismaClient,
  root: string,
  owned: RunOwnedSessionRow[],
): Promise<number> {
  if (owned.length === 0) return 0;
  const ownedKeys = new Set(owned.map(o => ownedKey(o.sid, o.framework)));
  const sids = [...new Set(owned.map(o => o.sid))];
  const rows = await prisma.session.findMany({
    where: { taskId: { in: sids } },
    select: { id: true, taskId: true, framework: true },
  });
  const ids = rows.filter(r => ownedKeys.has(ownedKey(r.taskId, r.framework))).map(r => r.id);
  return cascadeDeleteSessionRows(prisma, ids);
}
