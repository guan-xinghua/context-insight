// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 安全修复 IT（0000026/0000050/0000088/0000143/0000147 等）：
// taskId 白名单（export-session / exportSession / audit-session-py）、
// lake filenames 遍历拒绝。按信任边界判定：外部威胁在文件内容侧
// （taskId/filenames 已在落地 sink 封堵）；导入/浏览路径为本地自用功能，
// 刻意不设白名单。API 层走完整 POST 数据流，mock prisma 与
// child_process（lake 镜像 fetch），不触网、不落真实 git 仓。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LAKE_CACHE = path.join(os.tmpdir(), `lake-import-guard-${process.pid}`);
fs.rmSync(LAKE_CACHE, { recursive: true, force: true });
fs.mkdirSync(path.join(LAKE_CACHE, '.git'), { recursive: true });
process.env.LAKE_CACHE_DIR = LAKE_CACHE;

const execMock = vi.fn((_args: string[]) => Buffer.alloc(0));
vi.mock('node:child_process', () => ({ execFileSync: execMock }));

vi.mock('@/lib/db', () => ({ prisma: {} }));

const { exportMock } = vi.hoisted(() => ({ exportMock: vi.fn() }));
vi.mock('@/lib/ingest/export-service', () => ({ exportSession: exportMock }));

const { POST: exportSessionPOST } = await import('@/app/api/ingest/export-session/route');
const { isPathInside } = await import('@/lib/ingest/import-paths');
const { exportSession } = await vi.importActual<typeof import('@/lib/ingest/export-service')>('@/lib/ingest/export-service');

function req(url: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  execMock.mockReset().mockImplementation(() => Buffer.alloc(0));
  exportMock.mockReset();
});

describe('import 路径守卫（仅 lake filenames 收敛 —— 导入/浏览路径为本地自用功能，不设白名单）', () => {
  it('isPathInside 单元口径', () => {
    expect(isPathInside('/data/clone', 'sub/x.db')).toBe(true);
    expect(isPathInside('/data/clone', '../../etc/passwd')).toBe(false);
    expect(isPathInside('/data/clone', '/etc/passwd')).toBe(false);
  });
});

describe('taskId 白名单 — export-session / exportSession', () => {
  it('export-session 路由：遍历 taskId → 400，不触达 exportSession', async () => {
    const res = await exportSessionPOST(req('http://localhost/api/ingest/export-session', {
      taskId: '../../evil',
    }));
    expect(res.status).toBe(400);
    expect(exportMock).not.toHaveBeenCalled();
  });

  it('export-session 路由：合法 taskId → 到达 exportSession', async () => {
    const dummy = path.join(os.tmpdir(), `export-guard-${process.pid}.db`);
    fs.writeFileSync(dummy, Buffer.from('x'));
    exportMock.mockResolvedValue(dummy);
    const res = await exportSessionPOST(req('http://localhost/api/ingest/export-session', {
      taskId: 'ses_ok',
    }));
    expect(res.status).toBe(200);
    expect(exportMock).toHaveBeenCalledWith('ses_ok', undefined, expect.anything(), undefined);
  });

  it('exportSession 库函数：非法 taskId 先于 Prisma 查询抛错；合法 taskId 走查询', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const fakePrisma = { session: { findFirst } } as never;
    await expect(exportSession('x/../../evil', undefined, fakePrisma)).rejects.toThrow('Invalid taskId');
    await expect(exportSession('', undefined, fakePrisma)).rejects.toThrow('Invalid taskId');
    await expect(exportSession('a'.repeat(129), undefined, fakePrisma)).rejects.toThrow('Invalid taskId');
    await expect(exportSession('ses_ok', undefined, fakePrisma)).rejects.toThrow('Session not found');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

