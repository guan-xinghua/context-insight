// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D7 用户自定义维度存取（组模型）：~/.context-insight/user-definitions/<groupId>.group.json。
// 一个组 = 一套标准，组内维度一条条增删改（客户端编辑整组后整组保存）。
// 评分是后端执行的，定义必须后端读得到（localStorage 后端不可见，已定走文件）。

import { NextRequest, NextResponse } from 'next/server';
import { deleteUserGroup, importUserGroups, loadUserGroups, saveUserGroup } from '@/lib/scoring';
import { withRouteLog } from '@/lib/api-route';
import { logInfo, logWarn } from '@/lib/logger';

export const GET = withRouteLog('observe/scoring/user-definitions', async () => {
  return NextResponse.json({ groups: await loadUserGroups() });
});

export const PUT = withRouteLog('observe/scoring/user-definitions', async (request: NextRequest) => {
  const body = await request.json() as { group?: unknown };
  try {
    await saveUserGroup(body.group as never);
    logInfo('route:observe/scoring/user-definitions', '自定义维度组已保存', { id: (body.group as { id?: string } | null)?.id ?? '' });
    return NextResponse.json({ ok: true, groups: await loadUserGroups() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logWarn('route:observe/scoring/user-definitions', '组保存被拒', { error: message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
});

/** 导入组；body = { groups: [...], mode?: 'merge' | 'replace' }（merge 只补缺不覆盖，replace 清空本地以文件为准） */
export const POST = withRouteLog('observe/scoring/user-definitions', async (request: NextRequest) => {
  const body = await request.json() as { groups?: unknown; mode?: unknown };
  if (!Array.isArray(body.groups)) {
    return NextResponse.json({ error: 'Missing groups array' }, { status: 400 });
  }
  const mode = body.mode === 'replace' ? 'replace' as const : 'merge' as const;
  try {
    const summary = await importUserGroups(body.groups, undefined, mode);
    (mode === 'replace' ? logWarn : logInfo)('route:observe/scoring/user-definitions', '自定义维度组已导入',
      { mode, addedGroups: summary.addedGroups, mergedGroups: summary.mergedGroups, addedDims: summary.addedDims, skippedDims: summary.skippedDims });
    return NextResponse.json({ ok: true, summary, groups: await loadUserGroups() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logWarn('route:observe/scoring/user-definitions', '组导入被拒', { error: message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
});

export const DELETE = withRouteLog('observe/scoring/user-definitions', async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  try {
    await deleteUserGroup(id);
    logInfo('route:observe/scoring/user-definitions', '自定义维度组已删除', { id });
    return NextResponse.json({ ok: true, groups: await loadUserGroups() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logWarn('route:observe/scoring/user-definitions', '组删除被拒', { id, error: message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
