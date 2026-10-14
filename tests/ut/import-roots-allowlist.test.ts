// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 可选导入路径白名单 IT（安全报告 0000021/0000036 的纵深选项）：
// CANNBOT_INSIGHT_IMPORT_ROOTS 未设置 → 任意位置可导入（既有功能零回归）；
// 设置后 → import-file / import-file/sessions / browse-directory 三路由只放行
// 白名单根内路径（403 先于一切文件读取），数据主目录（cpx 捕获落点）恒放行。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkImportablePath, importRootsFromEnv } from '@/lib/ingest/import-paths';
import { POST as importFileSessions } from '@/app/api/ingest/import-file/sessions/route';
import { POST as importFile } from '@/app/api/ingest/import-file/route';
import { POST as browseDirectory } from '@/app/api/ingest/browse-directory/route';

const ENV_KEYS = ['CANNBOT_INSIGHT_IMPORT_ROOTS', 'CANNBOT_INSIGHT_HOME'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('checkImportablePath 纯函数矩阵', () => {
  it('未设置 / 空串 / 纯空白 → 不受限（默认行为）', () => {
    delete process.env.CANNBOT_INSIGHT_IMPORT_ROOTS;
    expect(checkImportablePath('/etc/passwd')).toEqual({ ok: true });
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = '';
    expect(checkImportablePath('/etc/passwd')).toEqual({ ok: true });
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = '  ';
    expect(checkImportablePath('/etc/passwd')).toEqual({ ok: true });
    expect(importRootsFromEnv()).toBeNull();
  });

  it('根内放行（含根本身），根外拒绝', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-a-'));
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = root;
    expect(checkImportablePath(root)).toEqual({ ok: true });
    expect(checkImportablePath(path.join(root, 'x', 'session.jsonl'))).toEqual({ ok: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-b-'));
    const d = checkImportablePath(path.join(outside, 'session.jsonl'));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.roots).toEqual([path.resolve(root)]);
  });

  it('多根逗号分隔、空白段忽略、~ 展开', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-c-'));
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = ` ${rootA} , ~/import-roots-home-x ,, `;
    expect(checkImportablePath(path.join(rootA, 'a.db'))).toEqual({ ok: true });
    expect(checkImportablePath(path.join(os.homedir(), 'import-roots-home-x', 'a.db'))).toEqual({ ok: true });
    expect(checkImportablePath('/etc/passwd').ok).toBe(false);
  });

  it('数据主目录恒放行（cpx 捕获自动导入不受白名单误伤）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-d-'));
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-home-'));
    process.env.CANNBOT_INSIGHT_HOME = dataHome;
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = root;
    expect(checkImportablePath(path.join(dataHome, 'proxy', 'cpx-sid.jsonl.7z'))).toEqual({ ok: true });
    expect(checkImportablePath(path.join(root, 'a.db'))).toEqual({ ok: true });
    expect(checkImportablePath('/etc/passwd').ok).toBe(false);
  });

  it('符号链接逃逸被封死：根内链接指向根外时按根外拒绝', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-sym-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-out-'));
    fs.writeFileSync(path.join(outside, 'secret.db'), 'x');
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = root;
    // 词法上 root/link/secret.db 在 root 内，但 link 指向 outside——realpath 归一并比较后必须拒绝
    expect(checkImportablePath(path.join(root, 'link', 'secret.db')).ok).toBe(false);
  });

  it('别名路径不误伤：根以符号链接形式配置时，别名两侧都放行', () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-real-'));
    const aliasRoot = path.join(os.tmpdir(), `import-roots-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.symlinkSync(realRoot, aliasRoot, 'dir');
    fs.writeFileSync(path.join(realRoot, 'a.db'), 'x');
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = aliasRoot;
    // 请求经别名根或真实根，realpath 归一后都命中同一个根（macOS /tmp↔/private/tmp 同款别名形态）
    expect(checkImportablePath(path.join(aliasRoot, 'a.db'))).toEqual({ ok: true });
    expect(checkImportablePath(path.join(realRoot, 'a.db'))).toEqual({ ok: true });
  });

  it('根内不存在的深层路径放行（根带符号链接前缀时两侧归一对称）', () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-real-deep-'));
    const aliasRoot = path.join(os.tmpdir(), `import-roots-alias-deep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.symlinkSync(realRoot, aliasRoot, 'dir');
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = aliasRoot;
    // 目标不存在 → canonicalizePath 递归归一最近存在的祖先（aliasRoot → realRoot），
    // 与已 realpath 的根同侧比较，不得误判 403（旧实现回退词法形式 → 前缀永不相等 → 全红）
    expect(checkImportablePath(path.join(aliasRoot, 'x', 'session.jsonl'))).toEqual({ ok: true });
    expect(checkImportablePath(path.join(aliasRoot, 'proxy', 'cpx-sid.jsonl.7z'))).toEqual({ ok: true });
  });

  it('符号链接逃逸在不存在目标下仍被封死：根内链接指向根外的深层不存在路径按根外拒绝', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-sym-miss-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-out-miss-'));
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = root;
    // link 指向 outside，目标本身不存在——realpath 失败后递归解析 link 到 outside
    // 再拼回不存在尾段 → 落在根外，必须拒绝（不得因「回退词法」而误放行）
    expect(checkImportablePath(path.join(root, 'link', 'secret.db')).ok).toBe(false);
  });
});

describe('路由级 IT：白名单生效时三路由 403，默认时零回归', () => {
  it('browse-directory：根外 403（reason 标识），根内 200', async () => {
    const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-e-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-f-'));
    fs.writeFileSync(path.join(outside, 'leak.txt'), 'x');

    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = inside;
    const denied = await browseDirectory(post('http://localhost/api/ingest/browse-directory', { dirPath: outside }));
    expect(denied.status).toBe(403);
    const body = await denied.json();
    expect(body.reason).toBe('path-outside-import-roots');

    const allowed = await browseDirectory(post('http://localhost/api/ingest/browse-directory', { dirPath: inside }));
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).isDirectory).toBe(true);
  });

  it('browse-directory：根内符号链接指向根外目录 → 403（防 symlink 逃逸）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-sym-e-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-out-e-'));
    fs.writeFileSync(path.join(outside, 'secret.db'), 'x');
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');

    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = root;
    const denied = await browseDirectory(post('http://localhost/api/ingest/browse-directory', { dirPath: path.join(root, 'link') }));
    expect(denied.status).toBe(403);
    expect((await denied.json()).reason).toBe('path-outside-import-roots');
  });

  it('browse-directory：默认（未设置白名单）任意目录照常可浏览', async () => {
    delete process.env.CANNBOT_INSIGHT_IMPORT_ROOTS;
    const anywhere = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-g-'));
    const res = await browseDirectory(post('http://localhost/api/ingest/browse-directory', { dirPath: anywhere }));
    expect(res.status).toBe(200);
    expect((await res.json()).isDirectory).toBe(true);
  });

  it('import-file：白名单外路径 403，且先于 file-not-found 404（不触碰文件系统）', async () => {
    const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-h-'));
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = inside;
    const res = await importFile(post('http://localhost/api/ingest/import-file', {
      source: 'claude-jsonl',
      sessionId: 'allowlist-it',
      filePath: '/etc/definitely-outside.jsonl',
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('path-outside-import-roots');
  });

  it('import-file/sessions：白名单外路径 403，且先于 adapter 打开文件', async () => {
    const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-i-'));
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = inside;
    const res = await importFileSessions(post('http://localhost/api/ingest/import-file/sessions', {
      source: 'claude-jsonl',
      filePath: '/etc/definitely-outside.jsonl',
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('path-outside-import-roots');
  });

  it('import-file/sessions：数据主目录内路径放行（cpx 自动导入形态）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-j-'));
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'import-roots-home-'));
    const captureDir = path.join(dataHome, 'proxy');
    fs.mkdirSync(captureDir, { recursive: true });
    const capture = path.join(captureDir, 'cpx-allowlist-it.jsonl');
    fs.writeFileSync(capture, '');
    process.env.CANNBOT_INSIGHT_HOME = dataHome;
    process.env.CANNBOT_INSIGHT_IMPORT_ROOTS = root;
    const res = await importFileSessions(post('http://localhost/api/ingest/import-file/sessions', {
      source: 'claude-jsonl',
      filePath: capture,
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).sessions).toEqual([]);
  });
});
