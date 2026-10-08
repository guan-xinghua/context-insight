// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// withRouteLog 包装器单测：抛错 → 500 + 与既有路由 catch 逐字节一致的
// {error} 响应体 + 统一日志 error 行落盘；正常返回 → 默认级别无请求行、
// 开 debug 有 done 行；动态路由 ctx 透传（[turnId] 二参形态）。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-api-route-log-'));
process.env.CANNBOT_LOG_DIR = path.join(TMP, 'logs');
process.env.CANNBOT_LOG_CONFIG = path.join(TMP, 'logger-config.json');

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['CANNBOT_LOG', 'CANNBOT_LOG_LEVEL', 'CANNBOT_LOG_FILE', 'CANNBOT_LOG_STDOUT', 'CANNBOT_LOG_DIR', 'CANNBOT_LOG_CONFIG'] as const;

const { withRouteLog } = await import('../../src/lib/api-route');
const logger = await import('../../src/lib/logger');

function todayFile(): string {
  return path.join(TMP, 'logs', `insight-${new Date().toISOString().slice(0, 10)}.log`);
}

function readLog(): string {
  try { return fs.readFileSync(todayFile(), 'utf8'); } catch { return ''; }
}

function req(url = 'http://localhost/api/test'): NextRequest {
  return new NextRequest(url);
}

beforeAll(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; }
  delete process.env.CANNBOT_LOG;   // 抵消 tests/setup.ts 的全局静音
  delete process.env.CANNBOT_LOG_LEVEL;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'logs'), { recursive: true, force: true });
  logger.resetLoggerForTest();
});

describe('withRouteLog 包装器', () => {
  it('handler 抛错 → 500 + {error} 形状与既有路由 catch 一致 + error 行落盘', async () => {
    const GET = withRouteLog('test/boom', async () => {
      throw new Error('boom');
    });
    const res = await GET(req(), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom' });
    const out = readLog();
    expect(out).toContain('[ERROR][route:test/boom]:GET /api/test unhandled');
    expect(out).toContain('status=500');
    expect(out).toContain('error=boom');
    expect(out).toMatch(/ms=\d+/);
  });

  it('非 Error 抛出值 → Unknown error 兜底（与既有 catch 同文案）', async () => {
    const GET = withRouteLog('test/str', async () => {
      throw 'plain string';
    });
    const res = await GET(req(), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Unknown error' });
  });

  it('正常返回 → 默认 info 级无请求行；CANNBOT_LOG_LEVEL=debug 后有 done 行', async () => {
    const GET = withRouteLog('test/ok', async () => Response.json({ items: [] }));
    const res = await GET(req(), undefined);
    expect(res.status).toBe(200);
    expect(readLog()).toBe('');

    process.env.CANNBOT_LOG_LEVEL = 'debug';
    const res2 = await GET(req(), undefined);
    expect(res2.status).toBe(200);
    const out = readLog();
    expect(out).toContain('[DEBUG][route:test/ok]:GET /api/test done');
    expect(out).toContain('status=200');
    delete process.env.CANNBOT_LOG_LEVEL;
  });

  it('动态路由 ctx 透传：handler 收到 { params: Promise<...> } 二参', async () => {
    const GET = withRouteLog<{ params: Promise<{ turnId: string }> }>('test/dyn', async (_r, ctx) => {
      const { turnId } = await ctx.params;
      return Response.json({ turnId });
    });
    const res = await GET(req('http://localhost/api/observe/session/turns/t-42'), { params: Promise.resolve({ turnId: 't-42' }) });
    expect(await res.json()).toEqual({ turnId: 't-42' });
  });

  it('handler 返回 500 响应（不抛）也记 error 行', async () => {
    const GET = withRouteLog('test/soft500', async () => Response.json({ error: 'x' }, { status: 500 }));
    await GET(req(), undefined);
    expect(readLog()).toContain('[ERROR][route:test/soft500]:GET /api/test failed status=500');
  });
});
