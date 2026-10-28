// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 原生会话对位发现（捕获行 → 本机原生会话）：数据仓上传「同步上传原生会话」
// 选项的解析层。两级策略：
//   ① DB 直查：同 sid 原生行——claude-code / opencode / cannbot / dsh 的捕获
//      sid 与原生 sid 1:1（header 路由 / x-session-id）
//   ② 磁盘发现：按框架注册的发现器扫描本机默认根（与 import-ui quickDir
//      对齐）。codex 例外：cpx 固定 sid ≠ rollout uuid，按捕获时间窗 +
//      首问锚点匹配，唯一命中才收——原生行以自己的 uuid 落 <uuid>.native/
// 扩展点：NATIVE_DISCOVERERS 注册表（框架 → 发现器），新框架 = 一个发现
// 函数 + 一行注册；上传编排（lake/index.ts）与 API 层零改动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { agentFrameworkOf } from '@/lib/shared/session-format';
import { findSessionFile } from './adapters/claude-jsonl';
import { listSessions as listOpencodeSessions } from './adapters/opencode-db';
import { readSession as readCodexSession } from './adapters/codex-jsonl';
import { isRolloutFileName, rolloutSessionIdOf } from './adapters/codex-naming';
import { resolveSessionFile as resolveDshSessionFile } from './dsh-bridge/native';

export interface NativeCounterpartContext {
  /** 捕获行 sid */
  taskId: string;
  /** 捕获行 framework（含 -proxy 后缀） */
  framework: string;
  startTime: Date | null;
  endTime: Date | null;
  /** 首问文本（codex 锚点匹配用） */
  query: string | null;
}

export interface NativeDiskHit {
  sourceType: string;
  path: string;
  sessionId: string;
}

export type NativeCounterpartResolution =
  | { status: 'found'; origin: 'db'; taskId: string; framework: string }
  | { status: 'found'; origin: 'disk'; hit: NativeDiskHit }
  | { status: 'not-found'; reason: string };

export interface NativeDiscoveryRoots {
  claude: string;
  codex: string;
  dsh: string;
  opencode: string[];
}

export function defaultNativeDiscoveryRoots(): NativeDiscoveryRoots {
  const home = os.homedir();
  return {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    dsh: path.join(home, '.dsh', 'sessions'),
    // opencode 存储族（含 cannbot 等 opencode 系 fork 的 XDG 数据目录）：
    // 按 sid 精确查库，多根扫描无串扰
    opencode: [path.join(home, '.local', 'share', 'opencode'), path.join(home, '.local', 'share', 'cannbot')],
  };
}

type DiscoverResult = NativeDiskHit | { reason: string };

type NativeDiscoverer = (ctx: NativeCounterpartContext, roots: NativeDiscoveryRoots) => DiscoverResult;

function discoverClaude(ctx: NativeCounterpartContext, roots: NativeDiscoveryRoots): DiscoverResult {
  const found = findSessionFile(roots.claude, ctx.taskId);
  if (!found) return { reason: `本机 ${roots.claude} 下未找到该会话的原生日志` };
  return { sourceType: 'claude-jsonl', path: found, sessionId: ctx.taskId };
}

function discoverDsh(ctx: NativeCounterpartContext, roots: NativeDiscoveryRoots): DiscoverResult {
  const found = resolveDshSessionFile(roots.dsh, ctx.taskId);
  if (!found) return { reason: `本机 ${roots.dsh} 下未找到该会话的原生日志` };
  return { sourceType: 'dsh-native', path: found, sessionId: ctx.taskId };
}

function collectDbFiles(root: string, depth = 0, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith('.db')) out.push(full);
    else if (entry.isDirectory() && depth < 3) collectDbFiles(full, depth + 1, out);
  }
  return out;
}

function discoverOpencodeFamily(ctx: NativeCounterpartContext, roots: NativeDiscoveryRoots): DiscoverResult {
  for (const root of roots.opencode) {
    for (const dbPath of collectDbFiles(root)) {
      try {
        if (listOpencodeSessions(dbPath).some(s => s.id === ctx.taskId)) {
          return { sourceType: 'opencode-db', path: dbPath, sessionId: ctx.taskId };
        }
      } catch { /* 非 opencode 库 / 坏件跳过（与导入列举同纪律） */ }
    }
  }
  return { reason: `本机 opencode 存储目录（${roots.opencode.join(', ')}）下未找到该会话` };
}

interface RolloutCandidate {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

function collectRolloutFiles(root: string, out: RolloutCandidate[] = []): RolloutCandidate[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && isRolloutFileName(entry.name)) {
      const sessionId = rolloutSessionIdOf(entry.name);
      if (sessionId) {
        try {
          out.push({ path: full, sessionId, mtimeMs: fs.statSync(full).mtimeMs });
        } catch { /* 半删除件跳过 */ }
      }
    } else if (entry.isDirectory()) {
      collectRolloutFiles(full, out);
    }
  }
  return out;
}

function normalizeAnchor(text: string | null | undefined): string | null {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 160) : null;
}

function firstUserTextOfRollout(filePath: string, sessionId: string): string | null {
  try {
    const interactions = readCodexSession(filePath, sessionId);
    const first = interactions.find(i => i.role === 'user' && i.content);
    return first?.content ?? null;
  } catch {
    return null;
  }
}

// 锚点匹配：整串相等或前缀包含（query 预览可能截断，rollout 全文在前）
function anchorMatches(anchor: string, text: string | null): boolean {
  const candidate = normalizeAnchor(text);
  if (!candidate) return false;
  return anchor === candidate || anchor.startsWith(candidate) || candidate.startsWith(anchor);
}

const CODEX_WINDOW_MS = 15 * 60 * 1000;

function discoverCodex(ctx: NativeCounterpartContext, roots: NativeDiscoveryRoots): DiscoverResult {
  if (ctx.startTime == null) return { reason: '捕获行缺少开始时间，无法定位 Codex 原生会话' };
  const lo = ctx.startTime.getTime() - CODEX_WINDOW_MS;
  const hi = (ctx.endTime ?? ctx.startTime).getTime() + CODEX_WINDOW_MS;
  const inWindow = collectRolloutFiles(roots.codex).filter(c => c.mtimeMs >= lo && c.mtimeMs <= hi);
  if (inWindow.length === 0) return { reason: '捕获时间窗口内本机没有 Codex 原生会话' };
  const anchor = normalizeAnchor(ctx.query);
  if (anchor) {
    const matched = inWindow.filter(c => anchorMatches(anchor, firstUserTextOfRollout(c.path, c.sessionId)));
    if (matched.length === 1) return { sourceType: 'codex-jsonl', path: matched[0].path, sessionId: matched[0].sessionId };
    if (matched.length === 0) return { reason: '捕获时间窗口内没有首问内容匹配的 Codex 原生会话' };
    return { reason: `首问内容匹配到 ${matched.length} 个 Codex 原生会话，无法确定对应关系` };
  }
  if (inWindow.length === 1) return { sourceType: 'codex-jsonl', path: inWindow[0].path, sessionId: inWindow[0].sessionId };
  return { reason: `捕获时间窗口内有 ${inWindow.length} 个 Codex 原生会话且捕获行无首问锚点，无法确定对应关系` };
}

// 框架 → 磁盘发现器注册表（扩展点）：新框架 = 一个发现函数 + 一行注册
const NATIVE_DISCOVERERS: Record<string, NativeDiscoverer> = {
  'claude-code': discoverClaude,
  opencode: discoverOpencodeFamily,
  cannbot: discoverOpencodeFamily,
  codex: discoverCodex,
  dsh: discoverDsh,
};

export async function resolveNativeCounterpart(
  prisma: PrismaClient,
  ctx: NativeCounterpartContext,
  roots: NativeDiscoveryRoots = defaultNativeDiscoveryRoots(),
): Promise<NativeCounterpartResolution> {
  const nativeFramework = agentFrameworkOf(ctx.framework);
  if (!nativeFramework || nativeFramework === ctx.framework) {
    return { status: 'not-found', reason: '仅支持从 wire 捕获行同步上传原生会话' };
  }
  const dbRow = await prisma.session.findFirst({
    where: { taskId: ctx.taskId, framework: nativeFramework },
    select: { taskId: true, framework: true },
  });
  if (dbRow) return { status: 'found', origin: 'db', taskId: dbRow.taskId, framework: dbRow.framework };

  const discoverer = NATIVE_DISCOVERERS[nativeFramework];
  if (!discoverer) return { status: 'not-found', reason: `暂不支持 ${nativeFramework} 框架的本机原生会话发现` };
  const result = discoverer(ctx, roots);
  if ('reason' in result) return { status: 'not-found', reason: result.reason };
  return { status: 'found', origin: 'disk', hit: result };
}
