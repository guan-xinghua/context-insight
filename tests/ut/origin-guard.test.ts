// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 浏览器跨源守卫 IT：纯函数矩阵 + proxy 入口直调（NextRequest → 403 / 放行）
// + 端到端链路（proxy 放行后真实路由 handler 正常应答）。威胁模型：本地
// 无鉴权 API 被用户浏览器里的恶意网页跨源 POST（no-cors text/plain 同样能
// 被 request.json() 解析）；非浏览器调用方（CLI/cpx 自动导入）不带
// Origin/Referer 必须零影响。

import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardBrowserOrigin } from '../../src/lib/origin-guard';
import proxy, { config as proxyConfig } from '../../src/proxy';
import { POST as browsePost } from '../../src/app/api/ingest/browse-directory/route';

const HOST = '127.0.0.1:21025';
const SAME_ORIGIN = `http://${HOST}`;

function req(
  url: string,
  init: { method?: string; origin?: string | null; referer?: string | null; host?: string; body?: unknown } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (init.origin !== undefined) headers['origin'] = init.origin as string;
  if (init.referer !== undefined) headers['referer'] = init.referer as string;
  if (init.host !== undefined) headers['host'] = init.host;
  return new NextRequest(url, {
    method: init.method ?? 'POST',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { ...headers, 'content-type': 'application/json' } } : {}),
  });
}

describe('guardBrowserOrigin 纯函数矩阵', () => {
  it('非 API 路径不拦（页面导航带外源 Origin 也放行）', () => {
    const d = guardBrowserOrigin({ pathname: '/session/abc', origin: 'https://evil.com', referer: null, host: HOST });
    expect(d).toEqual({ allow: true });
  });

  it('lake_viewer API 路径在守卫范围内', () => {
    const d = guardBrowserOrigin({ pathname: '/lake_viewer/api/lake-status', origin: 'https://evil.com', referer: null, host: HOST });
    expect(d.allow).toBe(false);
  });

  it('/api 裸路径同样在守卫范围内', () => {
    const d = guardBrowserOrigin({ pathname: '/api', origin: 'https://evil.com', referer: null, host: HOST });
    expect(d.allow).toBe(false);
  });

  it('非浏览器客户端（无 Origin/Referer）放行——CLI/cpx 自动导入零影响', () => {
    const d = guardBrowserOrigin({ pathname: '/api/ingest/import-file', origin: null, referer: null, host: HOST });
    expect(d).toEqual({ allow: true });
  });

  it('同源 Origin 放行（http/https、大小写不敏感）', () => {
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: SAME_ORIGIN, referer: null, host: HOST })).toEqual({ allow: true });
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: `https://${HOST}`, referer: null, host: HOST })).toEqual({ allow: true });
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: `HTTP://LOCALHOST:21025`, referer: null, host: 'LOCALHOST:21025' })).toEqual({ allow: true });
  });

  it('跨源 Origin 拒绝（恶意网页 no-cors POST 形态）', () => {
    const d = guardBrowserOrigin({ pathname: '/api/ingest/import-file', origin: 'https://evil.com', referer: null, host: HOST });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('cross-origin');
  });

  it('Origin: "null"（沙箱 iframe）拒绝', () => {
    const d = guardBrowserOrigin({ pathname: '/api/ingest/browse-directory', origin: 'null', referer: null, host: HOST });
    expect(d.allow).toBe(false);
  });

  it('端口不一致的 Origin 拒绝（邻位实例互调）', () => {
    const d = guardBrowserOrigin({ pathname: '/api/observe/data', origin: 'http://127.0.0.1:21030', referer: null, host: HOST });
    expect(d.allow).toBe(false);
  });

  it('Referer 兜底：同源放行、跨源拒绝、畸形拒绝', () => {
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: null, referer: `${SAME_ORIGIN}/session/x`, host: HOST })).toEqual({ allow: true });
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: null, referer: 'https://evil.com/page', host: HOST }).allow).toBe(false);
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: null, referer: 'not-a-url', host: HOST }).allow).toBe(false);
  });

  it('Host 非回环拒绝——封 DNS rebinding（外域解析到 127.0.0.1）', () => {
    const d = guardBrowserOrigin({ pathname: '/api/observe/data', origin: 'https://evil.com:21025', referer: null, host: 'evil.com:21025' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('non-loopback');
  });

  it('Host 缺失但带浏览器头时拒绝；Host 畸形拒绝', () => {
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: SAME_ORIGIN, referer: null, host: null }).allow).toBe(false);
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: SAME_ORIGIN, referer: null, host: '///bad' }).allow).toBe(false);
  });

  it('IPv6 回环 Host 放行', () => {
    expect(guardBrowserOrigin({ pathname: '/api/observe/data', origin: 'http://[::1]:21025', referer: null, host: '[::1]:21025' })).toEqual({ allow: true });
  });
});

describe('proxy 入口直调 IT', () => {
  it('恶意网页跨源 POST → 403 + JSON error，路由不触达', async () => {
    const res = await proxy(req('http://127.0.0.1:21025/api/ingest/import-file', {
      origin: 'https://evil.com',
      body: { source: 'claude-jsonl', sessionId: 'x', filePath: '/etc/passwd' },
    }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it('无浏览器头（CLI/cpx 形态）→ 放行透传', async () => {
    const res = await proxy(req('http://127.0.0.1:21025/api/ingest/import-file', { body: { sessionId: 'x', filePath: '/tmp/x' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('同源浏览器请求（insight 自己的页面）→ 放行透传', async () => {
    const res = await proxy(req('http://localhost:21025/api/observe/data', { origin: 'http://localhost:21025', host: 'localhost:21025' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('matcher 覆盖两个 API 前缀（/api 与 /lake_viewer/api）', () => {
    expect(proxyConfig.matcher).toContain('/api/:path*');
    expect(proxyConfig.matcher).toContain('/lake_viewer/api/:path*');
  });
});

describe('端到端链路 IT：proxy 放行后真实路由可用', () => {
  it('同源请求穿过 proxy → browse-directory 路由正常应答', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-guard-it-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '{"type":"user"}');
    const request = req('http://127.0.0.1:21025/api/ingest/browse-directory', {
      origin: SAME_ORIGIN,
      host: HOST,
      body: { dirPath: dir },
    });
    const gate = await proxy(request);
    expect(gate.status).toBe(200);
    const res = await browsePost(request as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isDirectory).toBe(true);
    expect(body.entries.some((e: { name: string }) => e.name === 'a.jsonl')).toBe(true);
  });

  it('恶意网页同一路径在 proxy 处被拦（对照组：路由不可达）', async () => {
    const request = req('http://127.0.0.1:21025/api/ingest/browse-directory', {
      origin: 'https://evil.com',
      host: HOST,
      body: { dirPath: '/' },
    });
    const res = await proxy(request);
    expect(res.status).toBe(403);
  });
});
