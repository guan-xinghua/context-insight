// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// LLM 评审层：整体重跑（确定性层免费 + LLM 层）合并写盘。
// NDJSON 流式响应：每个 LLM 子项完成推一条 {type:"progress"}，收尾推 {type:"done",card}
// 或 {type:"error"}——用户能看见在工作，不必干等几分钟黑盒。
// LLM 配置复用现有语义评审面板的配置来源（localStorage → 请求体传入），不另建配置入口。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { runScorecard } from '@/lib/scoring';

export async function POST(request: NextRequest) {
  let apiKey = '';
  try {
    const body = await request.json() as {
      taskId?: string;
      framework?: string;
      provider?: { baseUrl?: string; apiKey?: string; model?: string };
    };
    if (!body.taskId || !body.provider?.baseUrl || !body.provider?.model) {
      return NextResponse.json({ error: 'Missing taskId or provider config (baseUrl/model required)' }, { status: 400 });
    }
    apiKey = body.provider.apiKey ?? '';
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing provider apiKey（在设置页配置 LLM）' }, { status: 400 });
    }
    const { taskId, provider, framework } = body;

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        try {
          const card = await runScorecard(taskId, prisma, {
            withSemantic: true,
            framework: framework || undefined,
            provider: { baseUrl: provider.baseUrl!, apiKey, model: provider.model! },
            onProgress: p => send({ type: 'progress', done: p.done, total: p.total, current: p.current }),
          });
          if (!card) {
            send({ type: 'error', message: 'Session not found' });
          } else {
            send({ type: 'done', card });
          }
        } catch (err) {
          let message = err instanceof Error ? err.message : 'Unknown error';
          if (apiKey) message = message.split(apiKey).join('***');
          send({ type: 'error', message });
        } finally {
          controller.close();
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Unknown error';
    if (apiKey) message = message.split(apiKey).join('***');
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
