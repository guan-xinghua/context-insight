// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PrismaClient } from '@prisma/client';
import { isClaudeFormatSession } from '../shared/session-format';
import { opencodeReaderGeneration, v2ImportableTypeSql } from './adapters/opencode-db';

export interface AutoRefreshProbe {
  countChanged: boolean;
  sourceMessageCount: number;
  ourTurnCount: number;
  maxTimeUpdated: number;
  streaming: boolean;
  pendingInput: boolean;
  settled: boolean;
}

export interface ProbeSession {
  id: string;
  taskId: string;
  sourcePath: string | null;
  framework: string | null;
  // proxy 捕获判定需要（framework=opencode + version 带 -proxy 是 claude 格式）
  version?: string | null;
}

const NO_CHANGE: AutoRefreshProbe = {
  countChanged: false,
  sourceMessageCount: 0,
  ourTurnCount: 0,
  maxTimeUpdated: 0,
  streaming: false,
  pendingInput: false,
  settled: false,
};

// Claude Code metadata line types that don't carry conversational content.
// Mirrors NON_BREAKING_TYPES in the claude-jsonl adapter.
const CLAUDE_METADATA_TYPES = new Set([
  'ai-title',
  'attachment',
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'last-prompt',
  'system',
]);

export async function probeAutoRefresh(
  session: ProbeSession,
  prisma: PrismaClient,
): Promise<AutoRefreshProbe> {
  if (!session.sourcePath) return { ...NO_CHANGE };
  // claude 格式判定必须先于 opencode-db 分支：proxy 捕获的 opencode 会话
  // sourcePath 是 jsonl，按 sqlite 打开只会抛错退化为 NO_CHANGE（永不触发
  // 自动刷新）。原生 opencode（version 无 -proxy）不受影响。
  if (isClaudeFormatSession(session.framework, session.version)) {
    return probeClaudeCodeRefresh(session);
  }
  if (session.framework === 'opencode') {
    return probeOpencodeRefresh(session, prisma);
  }
  return { ...NO_CHANGE };
}

async function probeOpencodeRefresh(
  session: ProbeSession,
  prisma: PrismaClient,
): Promise<AutoRefreshProbe> {
  const taskId = session.taskId;
  let db: Database.Database | null = null;
  try {
    db = new Database(session.sourcePath!, { readonly: true });

    // opencode schema generation: v1 (session/message) vs v2 (session_v2/
    // session_message). Table names and the assistant-completeness predicate
    // differ; probe semantics (count / freshness / pending-input) stay equal.
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map(r => r.name));
    const isV2 = tableNames.has('session_v2');

    // 两代表共存（2.x 首跑回填 + 1.x 继续写 v1 表）：v2 副本自回填时刻停更，
    // 整库按 v2 计数会把回填后 1.x 的新消息漏计 → countChanged 永假、增量
    // 刷新静默停摆。计数/新鲜度/最新角色改按会话粒度选表，与 adapter 的
    // opencodeReaderGeneration 同口径（readSession 导入读哪张表，探针就数哪张）。
    if (isV2 && tableNames.has('session')) {
      return probeOpencodeRefreshMixed(db, session, prisma);
    }

    const msgTable = isV2 ? 'session_message' : 'message';
    const sessTable = isV2 ? 'session_v2' : 'session';
    const assistantIncomplete = isV2
      ? `type = 'assistant' AND json_extract(data, '$.time.completed') IS NULL`
      : `json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.time.completed') IS NULL`;
    const latestRoleExpr = isV2 ? 'type' : `json_extract(data, '$.role')`;
    const latestOrder = isV2 ? 'ORDER BY time_created DESC, seq DESC' : 'ORDER BY time_created DESC';

    // v2 事件源表混有控制面行（idle/shell/*-switched）与未知未来类型，
    // adapter 一律不产 turn（见 opencode-db.ts v2 reader 的跳过清单）。
    // 探针计数与 maxTimeUpdated 必须同口径白名单过滤：否则 opencode 每轮
    // 响应后追加的 idle 会把 sourceMessageCount 恒顶在 ourTurnCount 之上，
    // countChanged 永真，客户端每 5s 空刷新 + "自动同步完成" toast 刷屏。
    const importableFilter = isV2 ? ` AND ${v2ImportableTypeSql()}` : '';

    const parentStats = db.prepare(
      `SELECT COUNT(*) as cnt, MAX(time_updated) as max_updated FROM ${msgTable} WHERE session_id = ?${importableFilter}`
    ).get(taskId) as { cnt: number; max_updated: number | null };

    const subagentStats = db.prepare(
      `SELECT COUNT(*) as cnt, MAX(time_updated) as max_updated FROM ${msgTable} WHERE session_id IN (SELECT id FROM ${sessTable} WHERE parent_id = ?)${importableFilter}`
    ).get(taskId) as { cnt: number; max_updated: number | null };

    const sourceMessageCount = parentStats.cnt + subagentStats.cnt;
    const maxTimeUpdated = Math.max(
      parentStats.max_updated ?? 0,
      subagentStats.max_updated ?? 0
    );

    // 活跃流式须过新鲜度窗口：未完成 assistant 只有在"最近 STREAM_FRESH_MS
    // 内有更新且时间戳不超前系统时钟"才算正在写。被遗弃的未完成消息（用户
    // Esc 打断 / opencode 崩溃 / VM 时钟回拨留下的超前 time_updated）会永远
    // 缺 completed 标记——不过滤会把 settled 永久堵死，轮次间歇也不再同步
    // （客户现场：一条遗弃消息堵塞 54 分钟、积压 7 条消息不导入）。
    const STREAM_FRESH_MS = 5 * 60 * 1000;
    const now = Date.now();
    const freshArgs = [now - STREAM_FRESH_MS, now];
    const incompleteFreshParent = db.prepare(
      `SELECT COUNT(*) as cnt FROM ${msgTable} WHERE session_id = ? AND ${assistantIncomplete} AND time_updated >= ? AND time_updated <= ?`
    ).get(taskId, ...freshArgs) as { cnt: number };

    const incompleteFreshSub = db.prepare(
      `SELECT COUNT(*) as cnt FROM ${msgTable} WHERE session_id IN (SELECT id FROM ${sessTable} WHERE parent_id = ?) AND ${assistantIncomplete} AND time_updated >= ? AND time_updated <= ?`
    ).get(taskId, ...freshArgs) as { cnt: number };

    const streaming = (incompleteFreshParent.cnt + incompleteFreshSub.cnt) > 0;

    const latestParent = db.prepare(
      `SELECT ${latestRoleExpr} as role FROM ${msgTable} WHERE session_id = ? ${latestOrder} LIMIT 1`
    ).get(taskId) as { role: string | null } | undefined;

    const latestSub = db.prepare(
      `SELECT ${latestRoleExpr} as role FROM ${msgTable} WHERE session_id IN (SELECT id FROM ${sessTable} WHERE parent_id = ?) ${latestOrder} LIMIT 1`
    ).get(taskId) as { role: string | null } | undefined;

    const pendingInput = (latestParent?.role === 'user' || latestSub?.role === 'user');

    const ourTurnCount = await prisma.turn.count({ where: { sessionId: session.id } });
    const countChanged = sourceMessageCount > ourTurnCount;
    const settled = !streaming && !pendingInput;

    return { countChanged, sourceMessageCount, ourTurnCount, maxTimeUpdated, streaming, pendingInput, settled };
  } catch {
    return { ...NO_CHANGE };
  } finally {
    if (db) db.close();
  }
}

// 混合代际库的探针：父会话与每个子代理各自按 opencodeReaderGeneration
// 选表（v1 message / v2 session_message），计数/新鲜度/最新角色在各自
// 表上计算后聚合。语义与非混合路径一致（importable 白名单、流式新鲜度
// 窗口、pendingInput 判定）。
async function probeOpencodeRefreshMixed(
  db: Database.Database,
  session: ProbeSession,
  prisma: PrismaClient,
): Promise<AutoRefreshProbe> {
  const taskId = session.taskId;
  try {
    const subIds = new Set<string>();
    for (const c of db.prepare('SELECT id FROM session_v2 WHERE parent_id = ?').all(taskId) as { id: string }[]) subIds.add(c.id);
    for (const c of db.prepare('SELECT id FROM session WHERE parent_id = ?').all(taskId) as { id: string }[]) subIds.add(c.id);
    const allIds = [taskId, ...subIds];

    const STREAM_FRESH_MS = 5 * 60 * 1000;
    const now = Date.now();
    const freshArgs = [now - STREAM_FRESH_MS, now];

    let sourceMessageCount = 0;
    let maxTimeUpdated = 0;
    let streaming = false;
    let pendingInput = false;

    for (const sid of allIds) {
      const gen = opencodeReaderGeneration(db, sid);
      const msgTable = gen === 2 ? 'session_message' : 'message';
      const importableFilter = gen === 2 ? ` AND ${v2ImportableTypeSql()}` : '';
      const assistantIncomplete = gen === 2
        ? `type = 'assistant' AND json_extract(data, '$.time.completed') IS NULL`
        : `json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.time.completed') IS NULL`;
      const latestRoleExpr = gen === 2 ? 'type' : `json_extract(data, '$.role')`;
      const latestOrder = gen === 2 ? 'ORDER BY time_created DESC, seq DESC' : 'ORDER BY time_created DESC';

      const stats = db.prepare(
        `SELECT COUNT(*) as cnt, MAX(time_updated) as max_updated FROM ${msgTable} WHERE session_id = ?${importableFilter}`
      ).get(sid) as { cnt: number; max_updated: number | null };
      sourceMessageCount += stats.cnt;
      maxTimeUpdated = Math.max(maxTimeUpdated, stats.max_updated ?? 0);

      const incompleteFresh = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${msgTable} WHERE session_id = ? AND ${assistantIncomplete} AND time_updated >= ? AND time_updated <= ?`
      ).get(sid, ...freshArgs) as { cnt: number };
      if (incompleteFresh.cnt > 0) streaming = true;

      const latest = db.prepare(
        `SELECT ${latestRoleExpr} as role FROM ${msgTable} WHERE session_id = ? ${latestOrder} LIMIT 1`
      ).get(sid) as { role: string | null } | undefined;
      if (latest?.role === 'user') pendingInput = true;
    }

    const ourTurnCount = await prisma.turn.count({ where: { sessionId: session.id } });
    const countChanged = sourceMessageCount > ourTurnCount;
    const settled = !streaming && !pendingInput;

    return { countChanged, sourceMessageCount, ourTurnCount, maxTimeUpdated, streaming, pendingInput, settled };
  } catch {
    return { ...NO_CHANGE };
  }
}

async function probeClaudeCodeRefresh(
  session: ProbeSession,
): Promise<AutoRefreshProbe> {
  const filePath = resolveClaudeSessionFile(session.sourcePath!, session.taskId);
  if (!filePath) return { ...NO_CHANGE };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ...NO_CHANGE };
  }
  if (!stat.isFile()) return { ...NO_CHANGE };

  const maxTimeUpdated = stat.mtimeMs;

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { ...NO_CHANGE };
  }

  const lines = rawContent.length > 0
    ? rawContent.split('\n').filter(l => l.trim())
    : [];

  const parsed: Array<{ type?: string; message?: { role?: string; content?: unknown; stop_reason?: string | null }; stopReason?: string | null }> = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  // Find the last meaningful (non-metadata) line to determine session state.
  let lastMeaningful: { type?: string; message?: { content?: unknown; stop_reason?: string | null }; stopReason?: string | null } | null = null;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const t = parsed[i].type;
    if (t && !CLAUDE_METADATA_TYPES.has(t)) {
      lastMeaningful = parsed[i];
      break;
    }
  }

  let streaming = false;
  let pendingInput = false;

  if (lastMeaningful) {
    const t = lastMeaningful.type;
    if (t === 'assistant') {
      // Claude Code emits a `stop_reason` (end_turn / tool_use / ...) on a finalized
      // assistant response segment. Mirrors opencode's `time.completed IS NULL` check:
      // a present stop_reason means the response is complete (not streaming); an
      // absent stop_reason means the response is still in progress. Proxy captures
      // carry it as a TOP-LEVEL `stopReason` extension field (v1.74+) — read both,
      // otherwise proxy captures look streaming forever and never auto-refresh.
      const stopReason = lastMeaningful.message?.stop_reason ?? lastMeaningful.stopReason;
      streaming = !stopReason;
    } else if (t === 'result') {
      // Final result marker emitted after a completed assistant response.
      // settled = true (neither streaming nor pendingInput).
    } else if (t === 'user') {
      const content = lastMeaningful.message?.content;
      const hasRealText =
        typeof content === 'string'
          ? content.trim().length > 0
          : Array.isArray(content) &&
            content.some(
              (b): b is { type: string; text?: string } =>
                typeof b === 'object' && b !== null && (b as { type: string }).type === 'text' &&
                Boolean(((b as { text?: string }).text ?? '').trim())
            );
      if (hasRealText) {
        // User prompt waiting for an assistant response.
        pendingInput = true;
      } else {
        // tool_result-only user line: mid tool loop, assistant response pending.
        streaming = true;
      }
    }
  }

  const settled = !streaming && !pendingInput;
  // claude-code detects change via mtime; count-based fields are opencode's
  // mechanism and not consumed by the claude client (left inert to skip the
  // prisma query on every file-change event).
  return { countChanged: false, sourceMessageCount: 0, ourTurnCount: 0, maxTimeUpdated, streaming, pendingInput, settled };
}

export function resolveClaudeSessionFile(sourcePath: string, sessionId: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return null;
  }
  if (stat.isFile()) return sourcePath;
  if (stat.isDirectory()) {
    const direct = path.join(sourcePath, sessionId + '.jsonl');
    try {
      if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    } catch {
      // fall through to recursive search
    }
    return findJsonlRecursive(sourcePath, sessionId);
  }
  return null;
}

function findJsonlRecursive(dirPath: string, sessionId: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'subagents') continue;
      const found = findJsonlRecursive(full, sessionId);
      if (found) return found;
    } else if (entry.isFile() && entry.name === sessionId + '.jsonl') {
      return full;
    }
  }
  return null;
}
