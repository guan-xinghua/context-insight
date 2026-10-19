// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { sniffImportableFile } from '@/lib/ingest/adapters/registry';
import { expandHome, checkImportablePath } from '@/lib/ingest/import-paths';
import { MANIFEST_FILENAMES } from '@/lib/run/model';
import fs from 'node:fs';
import path from 'node:path';
import { logError, logWarn } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dirPath } = body;

    if (!dirPath) {
      return NextResponse.json(
        { error: 'Missing required field: dirPath' },
        { status: 400 },
      );
    }

    // 白名单收紧（CANNBOT_INSIGHT_IMPORT_ROOTS 设置时）先于一切目录读取
    const pathDecision = checkImportablePath(dirPath);
    if (!pathDecision.ok) {
      return NextResponse.json(
        { error: `Path "${dirPath}" is outside the allowed import roots: ${pathDecision.roots.join(', ')}`, reason: 'path-outside-import-roots' },
        { status: 403 },
      );
    }

    const resolved = path.resolve(expandHome(dirPath));

    if (!fs.existsSync(resolved)) {
      return NextResponse.json(
        { error: `Path does not exist: ${resolved}` },
        { status: 404 },
      );
    }

    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return NextResponse.json({
        isDirectory: false,
        entries: [],
        parentPath: path.dirname(resolved),
        currentPath: resolved,
      });
    }

    const names = fs.readdirSync(resolved).sort((a, b) => {
      try {
        const aIsDir = fs.statSync(path.join(resolved, a)).isDirectory();
        const bIsDir = fs.statSync(path.join(resolved, b)).isDirectory();
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.localeCompare(b);
      } catch {
        return a.localeCompare(b);
      }
    });

    const entries = names.map(name => {
      const full = path.join(resolved, name);
      try {
        const s = fs.statSync(full);
        const isDir = s.isDirectory();
        // importableType 单点判定（agent-source-framework 注册表嗅探）：
        // 声明序即优先级——前缀精确嗅探（cannbot_session_ / rollout-）先于
        // 扩展名兜底（.db / .jsonl），codex 的 rollout-*.jsonl 不再误判成
        // claude 捕获件；压缩三形态（.jsonl.7z/.gz）由 claude 兜底覆盖
        const importableType = isDir ? null : sniffImportableFile(name);
        // run 域展示提示（增量字段，读方按需消费）：目录内含 bundle 清单文件
        // 即标记——BundleImport 浏览视图高亮可导入的 workflow-bundle 目录。
        // 候选名与 import-service 共用 model.MANIFEST_FILENAMES（同一事实源）。
        const isBundleDir = isDir
          && MANIFEST_FILENAMES.some(n => fs.existsSync(path.join(full, n)));
        return {
          name,
          fullPath: full,
          isDir,
          size: isDir ? 0 : s.size,
          mtime: s.mtimeMs,
          isImportableFile: importableType != null,
          importableType,
          isBundleDir,
        };
      } catch (e) {
        logWarn('route:ingest/browse-directory', '目录项读取失败', { name, error: e instanceof Error ? e.message : String(e) });
        return {
          name,
          fullPath: full,
          isDir: false,
          size: 0,
          mtime: 0,
          isImportable: false,
          isImportableFile: false,
          importableType: null,
        };
      }
    });

    return NextResponse.json({
      isDirectory: true,
      entries,
      parentPath: path.dirname(resolved),
      currentPath: resolved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:ingest/browse-directory', '浏览失败', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
