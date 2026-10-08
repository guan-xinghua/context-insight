// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// provider 连接测试：主判据 = 真发一条 1-token 提示词打到对话端点（buildChatUrl
// 与 analyzer/语义评审同一口径），GET /models 仅作参考——部分网关（如火山方舟
// Ark 专属网关）实现了 /v1/models 却只把 chat 挂在 /api/v3/chat/completions，
// 仅测 models 会给出误导性绿灯。

import { NextRequest, NextResponse } from 'next/server';
import { buildChatUrl } from '@/lib/ai/analyzer';
import { logError } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { baseUrl, apiKey, model } = body as { baseUrl: string; apiKey: string; model?: string };

    if (!baseUrl || !apiKey) {
      return NextResponse.json({ error: 'Missing baseUrl or apiKey' }, { status: 400 });
    }
    if (!model) {
      return NextResponse.json({ error: 'Missing model（对话探针需要模型名）' }, { status: 400 });
    }

    const chatUrl = buildChatUrl(baseUrl);
    let chatStatus = 0;
    let chatBody = '';
    try {
      const res = await fetch(chatUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      chatStatus = res.status;
      chatBody = (await res.text().catch(() => '')).slice(0, 150);
      if (res.ok) {
        return NextResponse.json({ success: true, message: '✅ 连接成功' });
      }
    } catch (e) {
      chatBody = e instanceof Error ? e.message : 'network error';
    }

    // 对话探针失败：区分「路径/模型问题」与「鉴权问题」，直接给出该改什么
    let modelsNote = '';
    try {
      const modelsRes = await fetch(`${baseUrl.trim().replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (modelsRes.ok) {
        modelsNote = `（/models 列表可达——多为对话路径或模型名问题，火山方舟等网关对话端点在 /api/v3/chat/completions，baseUrl 应填到 /api/v3）`;
      } else if (modelsRes.status === 401 || modelsRes.status === 403) {
        modelsNote = `（/models 也返回 ${modelsRes.status}——先检查 API Key）`;
      }
    } catch { /* 忽略 */ }
    return NextResponse.json({
      success: false,
      message: `❌ 对话端点 ${chatUrl.replace(/\?.*$/, '')} HTTP ${chatStatus}: ${chatBody || '无响应体'}${modelsNote}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:ai/test-provider', '连接测试异常', { error: message });
    return NextResponse.json({ success: false, message: `❌ ${message}` }, { status: 500 });
  }
}
