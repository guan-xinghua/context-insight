// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import Database from 'better-sqlite3';

// SQLite 来源嗅探：opencode（v1 小写表 session/message/part、v2 表
// session_v2/session_message——2.x 起 schema 改名）与 CANNBot-Insight 导出
// （Prisma 大写表 "Session"/"Turn"）靠 schema 区分。文件名约定
// （cannbot_session_ 前缀）只是 browse 层的提示；导入时按内容纠正，
// 让单一 SQLite 入口对两种库透明。
// 表级探测 util（peekSqliteTables）供两源适配器的 detectContent 能力消费；
// detectSqliteSource 保留为组合薄壳（既有调用方与测试契约不变）。
export function peekSqliteTables(filePath: string): Set<string> | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(filePath, { readonly: true });
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    return new Set(rows.map(r => r.name));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

export function detectSqliteSource(filePath: string): 'opencode-db' | 'cannbot-insight' | null {
  const tables = peekSqliteTables(filePath);
  if (tables == null) return null;
  if (tables.has('Session')) return 'cannbot-insight';
  if (tables.has('session') || tables.has('session_v2')) return 'opencode-db';
  return null;
}
