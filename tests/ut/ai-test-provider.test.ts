// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// provider 连接测试 IT：主判据 = 真发一条提示词到对话端点（buildChatUrl 口径），
// /models 仅参考。回归背景：火山方舟 Ark 网关 /v1/models 可达但对话端点在
// /api/v3/chat/completions，旧版只测 models 给出误导性绿灯。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const route = await import('../../src/app/api/ai/test-provider/route.ts');

const req = (body: unknown) =>
  new NextRequest('http://localhost/api/ai/test-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const PROVIDER = { baseUrl: 'http://llm.test/api/v3', apiKey: 'sk-test', model: 'qwen-max' };

function stubFetch(calls: {
  chat?: { status: number; body?: string };
  models?: { status: number; body?: string };
}) {
  const seen: Array<{ method: string; url: string }> = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    seen.push({ method: init?.method ?? 'GET', url: u });
    if (u.includes('/chat/completions')) {
      const c = calls.chat ?? { status: 200 };
      return { ok: c.status >= 200 && c.status < 300, status: c.status, text: async () => c.body ?? '' } as never;
    }
    const m = calls.models ?? { status: 200, body: '{"data":[{"id":"a"},{"id":"b"}]}' };
    return {
      ok: m.status >= 200 && m.status < 300,
      status: m.status,
      text: async () => m.body ?? '',
      json: async () => JSON.parse(m.body ?? '{}'),
    } as never;
  });
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe('POST /api/ai/test-provider — 对话探针为主判据', () => {
  it('对话 200 → 成功，消息为「✅ 连接成功」，URL 走 /api/v3 口径', async () => {
    const seen = stubFetch({ chat: { status: 200 } });
    const res = await route.POST(req(PROVIDER));
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe('✅ 连接成功');
    expect(seen[0].url).toBe('http://llm.test/api/v3/chat/completions');
    expect(seen[0].method).toBe('POST');
  });

  it('对话 404 + /models 可达 → 失败并指出路径问题与火山方舟 /api/v3 改法', async () => {
    stubFetch({ chat: { status: 404 }, models: { status: 200, body: '{"data":[]}' } });
    const res = await route.POST(req({ ...PROVIDER, baseUrl: 'http://llm.test/v1' }));
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain('http://llm.test/v1/chat/completions');
    expect(data.message).toContain('HTTP 404');
    expect(data.message).toContain('/api/v3');
  });

  it('对话 401 + /models 401 → 失败并提示先检查 API Key', async () => {
    stubFetch({ chat: { status: 401, body: 'Consumer authentication failed.' }, models: { status: 401 } });
    const res = await route.POST(req(PROVIDER));
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain('先检查 API Key');
  });

  it('缺 model → 400（对话探针需要模型名）', async () => {
    const res = await route.POST(req({ baseUrl: 'http://llm.test', apiKey: 'k' }));
    expect(res.status).toBe(400);
  });
});
