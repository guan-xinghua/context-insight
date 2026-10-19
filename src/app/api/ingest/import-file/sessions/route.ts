// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import {
  isKnownSource,
  isUmbrellaSource,
  getSource,
  requireSource,
  resolveSource,
  SOURCE_FAMILIES,
  SourceResolutionError,
  UMBRELLA_SOURCE_TYPES,
  KNOWN_SOURCE_TYPES,
} from '@/lib/ingest/adapters/registry';
import type { SourceDescriptor } from '@/lib/ingest/adapters/contract';
import { NotOpencodeDbError } from '@/lib/ingest/adapters/opencode-db';
import { checkImportablePath } from '@/lib/ingest/import-paths';
import { logDebug, logError, logInfo } from '@/lib/logger';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filePath } = body;
    const { source } = body;

    // 源白名单单点（agent-source-framework 注册表）：伞形（jsonl/sqlite 族）
    // 与具体源都放行——伞形按目录内容族扫描
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
    // resolveSource/listSessions 都不得触碰白名单外的路径
    const pathDecision = checkImportablePath(filePath);
    if (!pathDecision.ok) {
      return NextResponse.json(
        { error: `Path "${filePath}" is outside the allowed import roots: ${pathDecision.roots.join(', ')}`, reason: 'path-outside-import-roots' },
        { status: 403 }
      );
    }

    // 解析参与列出的源集合，条目带各自 sourceType 标记（批量导入按条目
    // source 发，混合目录天然正确）：
    // - 伞形 + 目录 → 族扫描：全体成员各列各的（claude 侧已跳过 rollout /
    //   DSH 日志件，不会交叉误吞）；路径不存在时各成员自然返回空（与旧行为一致）
    // - 伞形 + 文件 → resolveSource 落单源（内容探测）
    // - 具体 + 文件 → resolveSource（安全网纠偏，原散装 sqlite detect 泛化）
    // - 具体 + 目录 → 信任声明（目录无法内容探测；原行为）
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    let members: SourceDescriptor[];
    if (isUmbrellaSource(source)) {
      members = (stat == null || stat.isDirectory())
        ? SOURCE_FAMILIES[source]
            .map(t => getSource(t))
            .filter((m): m is SourceDescriptor => m != null)
        : [resolveSource(source, filePath)];
    } else {
      members = stat?.isFile() ? [resolveSource(source, filePath)] : [requireSource(source)];
    }

    const sessions = [];
    for (const m of members) {
      const t0 = Date.now();
      const listed = m.listSessions(filePath);
      logInfo('ingest', 'listSessions', { source: m.sourceType, path: filePath, count: listed.length, ms: Date.now() - t0 });
      sessions.push(...listed.map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        endedAt: s.endedAt ?? null,
        firstQuery: s.firstQuery,
        turnCount: s.turnCount,
        model: s.modelName,
        totalTokens: s.totalTokens ?? null,
        source: m.sourceType,
        // 会话级身份声明（容器导出件逐会话不同；单框架源缺省 null——
        // 上传/预览消费方按"有值用值，无值走源级映射"兜底）
        framework: s.framework ?? null,
      })));
    }

    return NextResponse.json({ sessions });
  } catch (error) {
    // 伞形 + 单文件但族内无人认领 → 可行动 400
    if (error instanceof SourceResolutionError) {
      logDebug('route:ingest/import-file/sessions', '伞形源无人认领', { error: error.message });
      return NextResponse.json({ error: error.message, reason: 'unresolved-source' }, { status: 400 });
    }
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
