// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 安全修复 IT（0000026/0000050/0000088/0000143/0000147 等）：
// taskId 白名单（export-session / exportSession / audit-session-py）、
// projectPath realpath 校验（resolveProjectPath fail-closed）、cannbay
// filenames 遍历拒绝。按信任边界判定：外部威胁在文件内容侧（taskId/filenames
// 已在落地 sink 封堵）；导入/浏览路径与 breather 连接目标为本地自用功能，
// 刻意不设白名单。API 层走完整 POST/PATCH 数据流，mock prisma 与
// child_process（cannbay 镜像 fetch），不触网、不落真实 git 仓。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANNBAY_CACHE = path.join(os.tmpdir(), `cannbay-import-guard-${process.pid}`);
fs.rmSync(CANNBAY_CACHE, { recursive: true, force: true });
fs.mkdirSync(path.join(CANNBAY_CACHE, '.git'), { recursive: true });
process.env.CANNBAY_CACHE_DIR = CANNBAY_CACHE;

const execMock = vi.fn((_args: string[]) => Buffer.alloc(0));
vi.mock('node:child_process', () => ({ execFileSync: execMock }));

vi.mock('@/lib/db', () => ({ prisma: {} }));

const { exportMock } = vi.hoisted(() => ({ exportMock: vi.fn() }));
vi.mock('@/lib/ingest/export-service', () => ({ exportSession: exportMock }));

const { PATCH: handoffStatusPATCH } = await import('@/app/api/breather/handoff-status/route');
const { POST: importCannbayPOST } = await import('@/app/api/ingest/import-from-cannbay/route');
const { POST: exportSessionPOST } = await import('@/app/api/ingest/export-session/route');
const { resolveProjectPath, readHandoffRegistry, writeHandoffRegistry } = await import('@/lib/breather/handoff-registry');
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

describe('handoff-status 路由 — projectPath 校验', () => {
  it('opencode 返回的 directory 不存在 → 500 projectPath 错误（不落盘）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    try {
      const res = await handoffStatusPATCH(req('http://localhost/api/breather/handoff-status', {
        sessionId: 's1', status: 'running',
      }, 'PATCH'));
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('projectPath');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('import 路径守卫（仅 cannbay filenames 收敛 —— 导入/浏览路径为本地自用功能，不设白名单）', () => {
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

describe('resolveProjectPath — handoff registry fail-closed', () => {
  it('不存在路径 / 指向文件 → null；真实目录 → realpath', () => {
    expect(resolveProjectPath('/no/such/dir/xyz')).toBeNull();
    expect(resolveProjectPath(null)).toBeNull();
    const file = path.join(os.tmpdir(), `pg-file-${process.pid}`);
    fs.writeFileSync(file, 'x');
    try {
      expect(resolveProjectPath(file)).toBeNull();
    } finally {
      fs.unlinkSync(file);
    }
    const dir = fs.realpathSync(os.tmpdir());
    expect(resolveProjectPath(dir)).toBe(dir);
  });

  it('readHandoffRegistry 非法路径 → []；writeHandoffRegistry 非法路径 → throw', () => {
    expect(readHandoffRegistry('/no/such/dir/xyz')).toEqual([]);
    expect(() => writeHandoffRegistry('/no/such/dir/xyz', [])).toThrow();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-guard-'));
    try {
      writeHandoffRegistry(dir, [{ sessionId: 's1', from: null, to: [], birthHandoffDoc: null, handoffDoc: null }]);
      expect(readHandoffRegistry(dir).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('import-from-cannbay — filenames 遍历拒绝', () => {
  it('../ 与绝对路径 filename → Invalid filename；仅仓内相对名放行到存在性检查', async () => {
    const res = await importCannbayPOST(req('http://localhost/api/ingest/import-from-cannbay', {
      action: 'import',
      filenames: ['../escape.db', '/abs/escape.db', 'sub/ok.db'],
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(3);
    expect(data.results[0].error).toContain('Invalid filename');
    expect(data.results[0].imported).toBe(false);
    expect(data.results[1].error).toContain('Invalid filename');
    expect(data.results[2].error).toContain('not found');
  });
});
