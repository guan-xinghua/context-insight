// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 设置页「运行日志」API IT：PUT 校验（level 白名单/布尔）→ 落盘 0600 →
// GET 回读一致（缺省回默认）→ envOverrides 反映 env 压制 → DELETE 恢复默认。
// 直调路由 handler（import-file-api.test.ts 先例），CONTEXT_LOG_CONFIG 指
// mkdtemp 隔离。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-logger-cfg-api-'));
const CFG_FILE = path.join(TMP, 'logger-config.json');
process.env.CONTEXT_LOG_CONFIG = CFG_FILE;
process.env.CONTEXT_LOG = '0';   // 路由内部 logger 调用静音（不写真实目录）

const savedEnv: Record<string, string | undefined> = {};
for (const k of ['CONTEXT_LOG', 'CONTEXT_LOG_CONFIG', 'CONTEXT_LOG_LEVEL', 'CONTEXT_LOG_FILE', 'CONTEXT_LOG_STDOUT'] as const) {
  savedEnv[k] = process.env[k];
}

const route = await import('../../src/app/api/settings/logger-config/route');

function put(body: unknown): Promise<Response> {
  return route.PUT(new NextRequest('http://localhost/api/settings/logger-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeAll(() => {
  delete process.env.CONTEXT_LOG_LEVEL;
  delete process.env.CONTEXT_LOG_FILE;
  delete process.env.CONTEXT_LOG_STDOUT;
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(CFG_FILE, { force: true });
});

describe('settings/logger-config 路由', () => {
  it('GET 缺省：configured=false + 全默认值（开/info/文件与屏幕双开）+ logDir 提示', async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    // envOverrides 会包含本测试自设的 CONTEXT_LOG（静音用）——语义由专测覆盖
    const data = await res.json() as Record<string, unknown>;
    expect(data).toMatchObject({ configured: false, enabled: true, level: 'info', file: true, stdout: true });
    expect(String(data.logDir)).toMatch(/logs$/);
  });

  it('PUT 合法 → 落盘 0600、GET 回读一致（含 stdout）', async () => {
    const res = await put({ enabled: false, level: 'warn', file: true, stdout: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const stat = fs.statSync(CFG_FILE);
    expect(stat.mode & 0o777).toBe(0o600);
    const get = await route.GET();
    expect(await get.json()).toMatchObject({ configured: true, enabled: false, level: 'warn', file: true, stdout: false });
  });

  it('PUT 非法 level → 400；缺布尔字段（含 stdout）→ 400；不落盘', async () => {
    for (const bad of [{ enabled: true, level: 'verbose', file: true, stdout: true }, { enabled: 'yes', level: 'info', file: true, stdout: true }, { enabled: true, level: 'info', file: null, stdout: true }, { enabled: true, level: 'info', file: true, stdout: 'no' }]) {
      const res = await put(bad);
      expect(res.status).toBe(400);
    }
    expect(fs.existsSync(CFG_FILE)).toBe(false);
  });

  it('envOverrides：CONTEXT_LOG_LEVEL 设了就被列出（UI 提示被压制）', async () => {
    process.env.CONTEXT_LOG_LEVEL = 'debug';
    try {
      const res = await route.GET();
      const data = await res.json() as { envOverrides: string[] };
      expect(data.envOverrides).toContain('CONTEXT_LOG_LEVEL');
      expect(data.envOverrides).not.toContain('CONTEXT_LOG_FILE');
      expect(data.envOverrides).not.toContain('CONTEXT_LOG_STDOUT');
    } finally {
      delete process.env.CONTEXT_LOG_LEVEL;
    }
  });

  it('DELETE → 文件删除、GET 回缺省默认', async () => {
    await put({ enabled: true, level: 'error', file: false, stdout: false });
    const res = await route.DELETE();
    expect(res.status).toBe(200);
    expect(fs.existsSync(CFG_FILE)).toBe(false);
    const get = await route.GET();
    expect(await get.json()).toMatchObject({ configured: false, level: 'info' });
  });
});
