// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { listLakeOverview, importLakeSession, uploadLakeSession, GovernanceError } from '@/lib/lake';
import { resolveLakeRemote, resolveAdhocRemote, testLakeRemote, listRemoteBranches, redactRemoteSecrets, normalizeDirPrefix } from '@/lib/lake/remote';
import { classifyLakeError } from '@/lib/lake/auth';
import { listRemoteDirs } from '@/lib/lake/mirror';
import type { LakeRemoteInput } from '@/lib/lake-config';
import { prisma } from '@/lib/db';
import { logError, logWarn } from '@/lib/logger';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // 单源架构：数据动作（list/dirs/import/upload）的远端一律 resolveLakeRemote()
  // 读服务端 lake-config.json，请求体 config 对它们无意义（忽略）。探测动作
  // （test/branches/dirs 浏览）走 resolveAdhocRemote 拿编辑态显式值。remote
  // 在各分支内按需 resolve；fail() 脱敏消费 nullable remote
  let remote: ReturnType<typeof resolveLakeRemote> | null = null;
  let secrets: (string | undefined)[] = [];
  // 错误出边界统一走这里：消息脱敏 + classifyLakeError 产出结构化 code
  // （no-credentials/auth-failed/forbidden/quota/unknown）——前端据 code 给
  // 「前往设置页配置凭据」等定向引导，而不是让用户看脱敏后的 git 原文
  const fail = (err: unknown, status = 500) => {
    const code = classifyLakeError(err);
    const message = redactRemoteSecrets(
      err instanceof Error ? err.message : String(err), remote ?? undefined, secrets,
    );
    logError('route:ingest/lake', 'lake action 失败', { code, error: message });
    return NextResponse.json({ error: message, code }, { status: code === 'no-credentials' ? 400 : status });
  };
  try {
    const body = await request.json();
    const { action, config } = body as { action?: string; config?: LakeRemoteInput };
    secrets = [config?.account, config?.password, config?.token];

    // test/branches：编辑态探测（adhoc）——校验异常按 400 出。branches 是
    // 分支选择器：容忍用户正在编辑的脏 branch 字段（不消费它）
    if (config && (action === 'test' || action === 'branches')) {
      const toValidate = action === 'branches' ? { ...config, branch: undefined } : config;
      try {
        resolveAdhocRemote(toValidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid lake config';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    if (action === 'test') {
      return NextResponse.json(await testLakeRemote(config));
    }

    if (action === 'branches') {
      try {
        return NextResponse.json({ branches: listRemoteBranches(config) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list branches';
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    if (action === 'dirs') {
      // 目录浏览（设置页选择上传目录）：编辑态地址（adhoc）——浏览的就是
      // 用户正在输入/已保存表单里的远端
      const { prefix } = body as { prefix?: string };
      try {
        remote = resolveAdhocRemote(config);
        const dirs = listRemoteDirs(remote, normalizeDirPrefix(prefix));
        return NextResponse.json({ dirs });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid prefix';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    // 数据动作：单源（服务端 lake-config.json），忽略请求体 config
    try {
      remote = resolveLakeRemote();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid lake config';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    if (action === 'list') {
      // sessions + 顶层目录（dirs）一次返回：导入对话框的范式下拉 + 会话表
      // 共享单轮 mirror fetch（原先 dirs/list 两路各 fetch 一次 ~1s×2）
      const { sessions, topDirs } = listLakeOverview(remote);
      return NextResponse.json({ sessions, dirs: topDirs });
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
        const result = await importLakeSession(sid, prisma, remote, recording === 'native' ? 'native' : 'capture');
        return NextResponse.json({ result });
      } catch (err) {
        return fail(err);
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
        const result = await uploadLakeSession(prisma, taskId, description, remote, typeof category === 'string' ? category : undefined, baseline === true, opGenValue, typeof framework === 'string' ? framework : undefined);
        return NextResponse.json(result);
      } catch (err) {
        if (err instanceof GovernanceError) {
          logWarn('route:ingest/lake', '上传熔断拒绝', { sid: taskId, error: err.message });
          return NextResponse.json({ error: err.message, governance: true }, { status: 422 });
        }
        return fail(err);
      }
    }

    return NextResponse.json({ error: `Unknown action: "${action}". Supported: list, import, upload, test` }, { status: 400 });
  } catch (err) {
    return fail(err);
  }
}
