// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { BRAND_SOURCE_TYPE } from '@/lib/branding';
import { isKnownSource, getSource, KNOWN_SOURCE_TYPES } from '@/lib/ingest/adapters/registry';
import { NotOpencodeDbError } from '@/lib/ingest/adapters/opencode-db';
import { detectSqliteSource } from '@/lib/ingest/sqlite-detect';
import { logDebug, logError, logInfo } from '@/lib/logger';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filePath } = body;
    let { source } = body;

    // 源白名单单点（agent-source-framework 注册表）：新源在 registry 注册
    // 后此处自动放行，不再枚举字符串
    if (typeof source !== 'string' || !isKnownSource(source)) {
      return NextResponse.json(
        { error: `Unsupported source: "${source}". Supported: ${KNOWN_SOURCE_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    if (!filePath) {
      return NextResponse.json(
        { error: 'Missing required field: filePath' },
        { status: 400 }
      );
    }

    // 单一 SQLite 入口：opencode 与 CANNBot-Insight 导出库按 schema 自动
    // 区分（用户选错类型时按内容纠正，文件名不再是唯一判据）——两种 sqlite
    // 源的 schema 互纠，与其他源无关
    if (source === 'opencode-db' || source === BRAND_SOURCE_TYPE) {
      const detected = detectSqliteSource(filePath);
      if (detected && detected !== source) source = detected;
    }

    const descriptor = getSource(source);
    if (!descriptor) {
      return NextResponse.json(
        { error: `Adapter not available for source: "${source}"` },
        { status: 400 }
      );
    }

    const t0 = Date.now();
    const sessions = descriptor.listSessions(filePath);
    logInfo('ingest', 'listSessions', { source, path: filePath, count: sessions.length, ms: Date.now() - t0 });

    return NextResponse.json({
      sessions: sessions.map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        endedAt: s.endedAt ?? null,
        firstQuery: s.firstQuery,
        turnCount: s.turnCount,
        model: s.modelName,
        totalTokens: s.totalTokens ?? null,
      })),
    });
  } catch (error) {
    // unrecognized sqlite schema → actionable 400 instead of a raw 500
    // (e.g. "no such table: session" on opencode 2.x channel-suffixed dbs)
    if (error instanceof NotOpencodeDbError) {
      logDebug('route:ingest/import-file/sessions', '非 opencode-db 文件被拒', { error: error.message });
      return NextResponse.json({ error: error.message, reason: 'not-opencode-db' }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:ingest/import-file/sessions', '列会话失败', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
