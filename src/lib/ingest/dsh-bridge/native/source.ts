// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import { truncateUtf16Safe } from '../../../shared/text-strip';
import path from 'node:path';
import type { RawInteraction, SessionListItem } from '@/lib/shared/types';
import { decodeDshLogFile } from '../core';
import type { DshEvent, DshSessionHeader } from '../core/types';
import { convertDshSession, USER_KINDS, blocksToText } from './convert';

// ── DSH 原生会话「读取」层（发现 + 列举 + 读取）──────────────────────
// 磁盘形态（DSH 落盘 + dsh-export 导出两布局同源）：
//   <root>/<encoded-cwd>/<sid>/session.v4.jsonl.zstd     DSH 原生（多帧 zstd）
//   <root>/<sid>/session.v4.jsonl                        dsh-export（明文）
//   <sid>/subagents/<childId>/session.v4.jsonl           导出态子代理（平铺）
// 导入单元 = 直接包含会话日志文件的目录（id = 目录名 = header.id）。
// 子代理在**原生布局**下是同级的独立 <childId>/ 目录（header.origin='subagent'
// + header.parentSession 指向父会话），在**导出布局**下位于 <sid>/subagents/。
// 两种布局统一用 header.parentSession 建链，无需特判目录结构。
// 注意：不能从文件名取 id —— 原生日志文件名是固定代际名 session.v4.jsonl，
// 一个导出根下所有会话同名，只能靠目录名区分（design §4.2 踩坑 #3）。

// 一个会话的日志有两种形态名：明文 session.v4.jsonl（dsh-export 导出）与
// session.v4.jsonl.zstd（DSH 原生）。数组顺序 = 同一目录同时存在两者时的取值
// 优先级（明文在前，免解压）：resolveSessionFile 的快路径按同样顺序试，两处一致。
const SESSION_LOG_NAMES = ['session.v4.jsonl', 'session.v4.jsonl.zstd'];
const SESSION_LOG_NAME_SET = new Set(SESSION_LOG_NAMES);
const SESSION_LOG_NAME_RANK = new Map(SESSION_LOG_NAMES.map((name, i) => [name, i]));

/** 文件级识别：DSH 会话日志的固定代际名（browse-directory 嗅探用）。 */
export function isDshSessionLogName(fileName: string): boolean {
  return SESSION_LOG_NAME_SET.has(fileName);
}

/** 路径 → 会话 id（SourceDescriptor.deriveSessionId 能力）：id = 日志所在
 * 目录名（与 listSessions 的推导同源——日志文件名固定代际名，从文件名取
 * 不到 id）；路径不是 DSH 会话日志时返回 null（认不出命名约定）。 */
export function deriveSessionId(filePath: string): string | null {
  return isDshSessionLogName(path.basename(filePath))
    ? path.basename(path.dirname(filePath))
    : null;
}

/** 同一目录里两种形态并存时只留优先级最高的那个。否则同一个会话会在列表里
 *  出现两条（id 相同），而且 readSession 读到哪份取决于 readdir 顺序。 */
function dedupeByDirectory(refs: SessionFileRef[]): SessionFileRef[] {
  // 先按路径排序，让「保留哪条」不依赖 readdir 顺序
  const sorted = [...refs].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const byDir = new Map<string, SessionFileRef>();
  for (const ref of sorted) {
    const dir = path.dirname(ref.filePath);
    const prev = byDir.get(dir);
    const rank = SESSION_LOG_NAME_RANK.get(path.basename(ref.filePath)) ?? Number.MAX_SAFE_INTEGER;
    const prevRank = prev ? (SESSION_LOG_NAME_RANK.get(path.basename(prev.filePath)) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    if (!prev || rank < prevRank) byDir.set(dir, ref);
  }
  return [...byDir.values()];
}

interface SessionFileRef {
  filePath: string;
  /** 直接包含日志文件的目录名（= 会话 id 来源）。 */
  sessionId: string;
}

interface DecodedSession {
  ref: SessionFileRef;
  header: DshSessionHeader;
  events: DshEvent[];
  warnings: string[];
}

function collectSessionFiles(rootDir: string): SessionFileRef[] {
  const found: SessionFileRef[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isDshSessionLogName(entry.name)) {
        found.push({ filePath: full, sessionId: path.basename(dir) });
      }
    }
  };
  walk(rootDir);
  return dedupeByDirectory(found);
}

/** 统一入口：dbPath 可能是单个会话文件、会话目录（<sid>/）、
 *  encoded-cwd 目录（含多个 <sid>/）或导出根 / sessions 根。 */
function sessionFilesFromInput(dbPath: string): SessionFileRef[] {
  if (!dbPath) return [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return isDshSessionLogName(path.basename(dbPath))
      ? [{ filePath: dbPath, sessionId: path.basename(path.dirname(dbPath)) }]
      : [];
  }
  if (stat.isDirectory()) return collectSessionFiles(dbPath);
  return [];
}

function decodeRef(ref: SessionFileRef): DecodedSession | null {
  try {
    const decoded = decodeDshLogFile(ref.filePath);
    return { ref, header: decoded.header, events: decoded.events, warnings: decoded.warnings };
  } catch {
    // 坏件/半写件：跳过不炸整次导入（与 codex/claude listSessions 同纪律）
    return null;
  }
}

// 按会话 id 定位日志文件（listSessions 单会话版）：目录走快路径 + 递归
// 兜底，文件形态只认 DSH 固定代际名。原生会话对位发现（native-counterpart）
// 与适配器共用同一推导
export function resolveSessionFile(dbPath: string, sessionId: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    return null;
  }
  if (stat.isFile()) return isDshSessionLogName(path.basename(dbPath)) ? dbPath : null;
  if (!stat.isDirectory()) return null;

  // 快路径：<dbPath>/<sid>/session.v4.jsonl[.zstd]
  for (const name of SESSION_LOG_NAMES) {
    const direct = path.join(dbPath, sessionId, name);
    if (fs.existsSync(direct)) return direct;
  }
  // 兜底：递归扫描（dbPath 是 sessions 根时，会话在 <encoded-cwd>/<sid>/）
  return collectSessionFiles(dbPath).find(ref => ref.sessionId === sessionId)?.filePath ?? null;
}

function buildListItem(decoded: DecodedSession): SessionListItem {
  const { header, events, ref } = decoded;
  const id = typeof header.id === 'string' && header.id ? header.id : ref.sessionId;
  const createdAtMs = typeof header.createdAt === 'number' ? header.createdAt : 0;

  let firstQuery: string | null = null;
  let title: string | null = null;
  let modelName: string | null = null;
  let endedAtMs = createdAtMs;
  let turnCount = 0;
  let totalTokens = 0;

  for (const event of events) {
    const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
    if (typeof event.time === 'number' && event.time > endedAtMs) endedAtMs = event.time;
    if (event.type === 'turn/start') turnCount += 1;
    if (event.type === 'session/title' && typeof data.title === 'string' && !title) title = data.title;
    if (event.type === 'request/context' && typeof data.model === 'string' && !modelName) modelName = data.model;
    if (event.type === 'assistant/message') {
      const usage = data.usage as { totalTokens?: unknown } | undefined;
      if (usage && typeof usage.totalTokens === 'number') totalTokens += usage.totalTokens;
    }
    if (event.type === 'user/message' && firstQuery == null) {
      const source = data.source as { kind?: unknown } | undefined;
      const kind = source && typeof source.kind === 'string' ? source.kind : null;
      if (kind != null && USER_KINDS.has(kind)) {
        const text = blocksToText(data.content);
        if (text) firstQuery = truncateUtf16Safe(text, 200);
      }
    }
  }

  const version = typeof header.dshVersion === 'string'
    ? header.dshVersion
    : typeof header.agentVersion === 'string'
      ? header.agentVersion
      : null;

  return {
    id,
    createdAt: new Date(createdAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    firstQuery: firstQuery ?? title,
    turnCount,
    modelName,
    totalTokens,
    version,
  };
}

/** 列举顶层会话（子代理不作为顶层条目——并入主会话，与 claude/codex 同语义）。 */
export function listSessions(dbPath: string): SessionListItem[] {
  // 同一个会话可能被多处收录（同一目录两种形态，或原生/导出两种布局并存）：
  // 按会话 id 去重，先命中的保留
  const byId = new Map<string, SessionListItem>();
  for (const ref of sessionFilesFromInput(dbPath)) {
    const decoded = decodeRef(ref);
    if (!decoded) continue;
    if (decoded.header.origin === 'subagent') continue;
    const item = buildListItem(decoded);
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 读取单个会话 → RawInteraction[]（主会话，未打标）。 */
export function readSession(dbPath: string, sessionId: string): RawInteraction[] {
  const file = resolveSessionFile(dbPath, sessionId);
  if (!file) return [];
  const decoded = decodeDshLogFile(file);
  return convertDshSession(decoded.header, decoded.events).interactions;
}

function subagentDescriptor(events: DshEvent[]): { name: string | null; type: string | null } {
  for (const event of events) {
    if (event.type !== 'subagent/descriptor') continue;
    const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
    return {
      name: typeof data.label === 'string' && data.label ? data.label : null,
      type: typeof data.mode === 'string' && data.mode ? data.mode : null,
    };
  }
  return { name: null, type: null };
}

/** 发现并读取子代理会话（header.parentSession 建链，递归含嵌套孙代理），
 *  产出统一打标（subagent_session_id/name/type）的 interactions。
 *  父代理转发消息（user/message kind='agent-message'）随子会话一并转换。 */
export function readSubagentInteractions(dbPath: string, sessionId: string): RawInteraction[] {
  // 只扫描父会话所在目录（= 含全部同级 <sid>/ 的那个目录）：原生布局里子代理是
  // 同 encoded-cwd 下的兄弟目录，导出布局里子代理在 <sid>/subagents/ 下——两者
  // 都在该目录内。避免对 sessions 根做全量解码（O(N) → O(同 cwd 会话数)）。
  const parentFile = resolveSessionFile(dbPath, sessionId);
  const scanRoot = parentFile ? path.dirname(path.dirname(parentFile)) : dbPath;
  const refs = fs.existsSync(scanRoot) ? collectSessionFiles(scanRoot) : sessionFilesFromInput(dbPath);

  const all: DecodedSession[] = [];
  for (const ref of refs) {
    const decoded = decodeRef(ref);
    if (decoded) all.push(decoded);
  }

  const childrenByParent = new Map<string, DecodedSession[]>();
  for (const decoded of all) {
    const parent = decoded.header.parentSession;
    if (typeof parent === 'string' && parent) {
      const list = childrenByParent.get(parent) ?? [];
      list.push(decoded);
      childrenByParent.set(parent, list);
    }
  }

  const result: RawInteraction[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string, depth: number): void => {
    if (depth > 8) return; // 嵌套深度上限（防异常环）
    for (const child of childrenByParent.get(parentId) ?? []) {
      const childId = typeof child.header.id === 'string' ? child.header.id : child.ref.sessionId;
      if (visited.has(childId)) continue;
      visited.add(childId);

      const descriptor = subagentDescriptor(child.events);
      const converted = convertDshSession(child.header, child.events).interactions;
      for (const interaction of converted) {
        interaction.subagent_session_id = childId;
        if (descriptor.name) interaction.subagent_name = descriptor.name;
        if (descriptor.type) interaction.subagent_type = descriptor.type;
      }
      result.push(...converted);
      walk(childId, depth + 1);
    }
  };
  walk(sessionId, 0);
  return result;
}

/** 从会话头提取 DSH 版本号（Session.version 候选）。 */
export function extractVersion(dbPath: string, sessionId?: string): string | null {
  const file = sessionId ? resolveSessionFile(dbPath, sessionId) : (fs.existsSync(dbPath) && fs.statSync(dbPath).isFile() ? dbPath : null);
  if (!file) return null;
  try {
    const { header } = decodeDshLogFile(file);
    if (typeof header.dshVersion === 'string') return header.dshVersion;
    if (typeof header.agentVersion === 'string') return header.agentVersion;
    return null;
  } catch {
    return null;
  }
}
