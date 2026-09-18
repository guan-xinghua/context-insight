// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { listCannbay2Overview, importCannbay2Session, uploadCannbay2Session, GovernanceError } from '@/lib/cannbay2';
import { resolveCannbay2Remote, testCannbay2Remote, listRemoteBranches, redactRemoteSecrets, normalizeDirPrefix } from '@/lib/cannbay2/remote';
import { listRemoteDirs } from '@/lib/cannbay2/mirror';
import type { CannbayRemoteInput } from '@/lib/cannbay-config';
import { prisma } from '@/lib/db';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let remote = resolveCannbay2Remote();
  let secrets: (string | undefined)[] = [];
  const fail = (message: string, status: number) =>
    NextResponse.json({ error: redactRemoteSecrets(message, remote, secrets) }, { status });
  try {
    const body = await request.json();
    const { action, config } = body as { action?: string; config?: CannbayRemoteInput };
    secrets = [config?.account, config?.password, config?.token];

    // test/branches 内部自行 resolve，但校验异常须与 list/dirs 一致按 400 出。
    // branches 是分支选择器：容忍用户正在编辑的脏 branch 字段（不消费它）
    if (config && (action === 'test' || action === 'branches')) {
      const toValidate = action === 'branches' ? { ...config, branch: undefined } : config;
      try {
        resolveCannbay2Remote(toValidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid cannbay config';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    if (action === 'test') {
      return NextResponse.json(await testCannbay2Remote(config));
    }

    if (action === 'branches') {
      try {
        return NextResponse.json({ branches: listRemoteBranches(config) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list branches';
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    try {
      remote = resolveCannbay2Remote(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid cannbay config';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    if (action === 'list') {
      // sessions + 顶层目录（dirs）一次返回：导入对话框的范式下拉 + 会话表
      // 共享单轮 mirror fetch（原先 dirs/list 两路各 fetch 一次）。dirs 字段
      // 与 action=dirs 同源（含 sessions/，调用方自行过滤）；自定义单根远端为 []
      const { sessions, topDirs } = listCannbay2Overview(remote);
      return NextResponse.json({ sessions, dirs: topDirs });
    }

    if (action === 'dirs') {
      const { prefix } = body as { prefix?: string };
      try {
        const dirs = listRemoteDirs(remote, normalizeDirPrefix(prefix));
        return NextResponse.json({ dirs });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid prefix';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    if (action === 'import') {
      const { sid, recording } = body as { sid: string; recording?: string };
      if (!sid) {
        return NextResponse.json({ error: 'Missing sid' }, { status: 400 });
      }
      // 记录类（同 sid 双记录）：native = <sid>.native/ 目录（原生 claude 会话），
      // 缺省 capture = 裸 <sid>/ 目录（wire 捕获 / 主位上传）
      if (recording != null && recording !== 'capture' && recording !== 'native') {
        return NextResponse.json({ error: `Invalid recording: "${recording}" (capture | native)` }, { status: 400 });
      }
      try {
        const result = await importCannbay2Session(sid, prisma, remote, recording === 'native' ? 'native' : 'capture');
        return NextResponse.json({ result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Import failed';
        return fail(message, 500);
      }
    }

    if (action === 'upload') {
      const { taskId, description, category, baseline, opGen, framework } = body as { taskId: string; description?: string; category?: string; baseline?: boolean; opGen?: string; framework?: string };
      if (!taskId) {
        return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
      }
      // opGen（算子生成结果标注）：只认 success/failure，其余值视为未标注
      const opGenValue = opGen === 'success' || opGen === 'failure' ? opGen : undefined;
      try {
        // framework：同 sid 双行（方案一）消歧——从捕获行页面上传必须带
        const result = await uploadCannbay2Session(prisma, taskId, description, remote, typeof category === 'string' ? category : undefined, baseline === true, opGenValue, typeof framework === 'string' ? framework : undefined);
        return NextResponse.json(result);
      } catch (err) {
        if (err instanceof GovernanceError) {
          return NextResponse.json({ error: err.message, governance: true }, { status: 422 });
        }
        const message = err instanceof Error ? err.message : 'Upload failed';
        return fail(message, 500);
      }
    }

    return NextResponse.json({ error: `Unknown action: "${action}". Supported: list, import, upload, test` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return fail(message, 500);
  }
}
