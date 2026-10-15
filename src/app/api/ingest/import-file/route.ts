// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { importSession } from '@/lib/ingest/data-service';
import {
  isKnownSource,
  isUmbrellaSource,
  resolveSource,
  SourceResolutionError,
  UMBRELLA_SOURCE_TYPES,
  KNOWN_SOURCE_TYPES,
} from '@/lib/ingest/adapters/registry';
import { NotOpencodeDbError } from '@/lib/ingest/adapters/opencode-db';
import { checkImportablePath } from '@/lib/ingest/import-paths';
import { prisma } from '@/lib/db';
import { logDebug, logError } from '@/lib/logger';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, filePath } = body;
    const { source } = body;

    // 源白名单单点（agent-source-framework 注册表）：伞形（jsonl/sqlite 族）
    // 与具体源都放行——伞形由解析单点（resolveSource）按内容落到具体源
    if (typeof source !== 'string' || !isKnownSource(source)) {
      return NextResponse.json(
        { error: `Unsupported source: "${source}". Supported: ${[...UMBRELLA_SOURCE_TYPES, ...KNOWN_SOURCE_TYPES].join(', ')}` },
        { status: 400 }
      );
    }

    if (!filePath) {
      return NextResponse.json(
        { error: 'Missing required field: filePath' },
        { status: 400 }
      );
    }

    // 白名单收紧（CANNBOT_INSIGHT_IMPORT_ROOTS 设置时）先于一切文件读取——
    // resolveSource/fileExists 都不得触碰白名单外的路径
    const pathDecision = checkImportablePath(filePath);
    if (!pathDecision.ok) {
      return NextResponse.json(
        { error: `Path "${filePath}" is outside the allowed import roots: ${pathDecision.roots.join(', ')}`, reason: 'path-outside-import-roots' },
        { status: 403 }
      );
    }

    // Distinguish "file missing" from "session already exists" up front:
    // both surface as imported:false downstream, and the UI used to label
    // every imported:false as "Already exists" — misleading when the capture
    // file was deleted or the path is wrong.
    // 三形态放行：明文/.7z/.gz 互找（readCaptureText 同款解析）——盘上只有
    // x.jsonl.7z（或存量 .gz）时手输 x.jsonl 不能在此被 404 拦截
    const fileExists = (p: string): boolean =>
      fs.existsSync(p)
      || (p.endsWith('.jsonl') && (fs.existsSync(`${p}.7z`) || fs.existsSync(`${p}.gz`)))
      || (/\.jsonl\.(7z|gz)$/.test(p) && fs.existsSync(p.replace(/\.(7z|gz)$/, '')));
    if (!fileExists(filePath)) {
      return NextResponse.json(
        { error: `File not found: ${filePath}`, reason: 'file-not-found' },
        { status: 404 }
      );
    }

    // 伞形 + 目录：内容探测需要具体文件；目录批量导入请传扫描条目自带的
    // 具体 source（/import-file/sessions 的条目已标记）
    if (isUmbrellaSource(source) && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      return NextResponse.json(
        { error: `Umbrella source "${source}" requires a concrete file path; directory imports should pass the per-entry source from /import-file/sessions`, reason: 'umbrella-needs-file' },
        { status: 400 }
      );
    }

    // 解析单点：伞形探测 / 具体验证 + 族内纠偏（原散装 detectSqliteSource
    // 纠偏的泛化——任何调用方传错源都被内容真相兜住）
    let resolved;
    try {
      resolved = resolveSource(source, filePath);
    } catch (e) {
      if (e instanceof SourceResolutionError) {
        logDebug('route:ingest/import-file', '伞形源无人认领', { source, filePath, error: e.message });
        return NextResponse.json({ error: e.message, reason: 'unresolved-source' }, { status: 400 });
      }
      throw e;
    }

    // sessionId 缺省 → 解析后具体源的命名规则推导（与该源 listSessions
    // 同源，UI/调用方不再各自复制；DSH 的规则取日志父目录名，故传完整路径）；
    // 认不出命名约定（改名件）→ 400 请显式传
    const effectiveSessionId: string | null =
      sessionId ?? resolved.deriveSessionId?.(filePath) ?? null;
    if (!effectiveSessionId) {
      return NextResponse.json(
        { error: `无法从路径推导 sessionId（"${filePath}" 不符合 ${resolved.sourceType} 命名约定），请显式传入 sessionId`, reason: 'session-id-underivable' },
        { status: 400 }
      );
    }

    const result = await importSession(filePath, effectiveSessionId, prisma, filePath, resolved.sourceType);

    // 导入后的会话归属（framework/version）以 DB 为准 —— proxy 捕获按文件内
    // source 标记归属（opencode-proxy → opencode），路径/文件名猜不出。
    // Recent Imports 历史条目据此显示正确的类型徽标。
    // 方案一（同 sid 双会话）：按本次写入/合并的行 id 精确取回——taskId 下
    // 可能有两行（原生 + 捕获），findFirst 会取错。
    const sessionRow = await prisma.session.findUnique({
      where: { id: result.sessionId },
      select: { framework: true, version: true },
    });

    return NextResponse.json({
      sessionId: result.sessionId,
      // 生效的会话键（taskId）：sessionId 由服务端推导时，调用方据此对账
      //（UI 状态行/导入历史都用它锚定）
      taskId: effectiveSessionId,
      imported: result.imported,
      // imported:false + query:null = 0 interactions parsed (unreadable file);
      // imported:false + query = session existed, merged;
      // imported:true + query:null = empty claude capture → placeholder created
      reason: result.imported ? (result.query ? 'imported' : 'imported-empty') : (result.query ? 'already-exists' : 'no-interactions'),
      query: result.query ?? null,
      framework: sessionRow?.framework ?? null,
      version: sessionRow?.version ?? null,
    });
  } catch (error) {
    // unrecognized sqlite schema → actionable 400 instead of a raw 500
    if (error instanceof NotOpencodeDbError) {
      logDebug('route:ingest/import-file', '非 opencode-db 文件被拒', { error: error.message });
      return NextResponse.json({ error: error.message, reason: 'not-opencode-db' }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:ingest/import-file', '导入失败', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
