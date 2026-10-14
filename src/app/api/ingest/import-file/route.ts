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
import { BRAND_SOURCE_TYPE } from '@/lib/branding';
import { isKnownSource, KNOWN_SOURCE_TYPES } from '@/lib/ingest/adapters/registry';
import { NotOpencodeDbError } from '@/lib/ingest/adapters/opencode-db';
import { detectSqliteSource } from '@/lib/ingest/sqlite-detect';
import { checkImportablePath } from '@/lib/ingest/import-paths';
import { prisma } from '@/lib/db';
import { logDebug, logError } from '@/lib/logger';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, filePath } = body;
    let { source } = body;

    // 源白名单单点（agent-source-framework 注册表）：新源在 registry 注册
    // 后此处自动放行，不再枚举字符串
    if (typeof source !== 'string' || !isKnownSource(source)) {
      return NextResponse.json(
        { error: `Unsupported source: "${source}". Supported: ${KNOWN_SOURCE_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    if (!sessionId || !filePath) {
      return NextResponse.json(
        { error: 'Missing required fields: sessionId, filePath' },
        { status: 400 }
      );
    }

    // 白名单收紧（CANNBOT_INSIGHT_IMPORT_ROOTS 设置时）先于一切文件读取——
    // detectSqliteSource/fileExists 都不得触碰白名单外的路径
    const pathDecision = checkImportablePath(filePath);
    if (!pathDecision.ok) {
      return NextResponse.json(
        { error: `Path "${filePath}" is outside the allowed import roots: ${pathDecision.roots.join(', ')}`, reason: 'path-outside-import-roots' },
        { status: 403 }
      );
    }

    // 单一 SQLite 入口：opencode 与 CANNBot-Insight 导出库按 schema 自动
    // 区分（与 /import-file/sessions 同一纠正逻辑）
    if (source === 'opencode-db' || source === BRAND_SOURCE_TYPE) {
      const detected = detectSqliteSource(filePath);
      if (detected && detected !== source) source = detected;
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

    const result = await importSession(filePath, sessionId, prisma, filePath, source);

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
