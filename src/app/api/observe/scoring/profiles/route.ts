// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分配置 profile 存取：~/.cannbot-insight/scoring-profiles/<id>.json + active.json（激活指针）。
// 全局单激活（activeId null = 默认口径）；内置模板只读（preset: 前缀）。
// 保存/导入统一走 PUT（sanitizeProfile 硬错 400、软伤 warnings 透传）。

import { NextRequest, NextResponse } from 'next/server';
import {
  activeApplyWarnings, deleteProfile, findPreset, getActiveId, loadProfiles, saveProfile, setActiveId,
} from '@/lib/scoring';

export async function GET() {
  try {
    return NextResponse.json({
      profiles: await loadProfiles(),
      activeId: await getActiveId(),
      warnings: await activeApplyWarnings(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as { profile?: unknown };
    const { warnings } = await saveProfile(body.profile);
    return NextResponse.json({ ok: true, profiles: await loadProfiles(), warnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** 激活/恢复默认；body = { activeId: string | null }（null = 默认口径） */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { activeId?: unknown };
    const activeId = body.activeId;
    if (activeId !== null) {
      if (typeof activeId !== 'string' || activeId.length === 0) {
        return NextResponse.json({ error: 'activeId 必须是非空字符串或 null' }, { status: 400 });
      }
      const exists = findPreset(activeId) != null || (await loadProfiles()).some(p => p.id === activeId);
      if (!exists) {
        return NextResponse.json({ error: `profile 不存在：${activeId}` }, { status: 400 });
      }
    }
    await setActiveId(activeId);
    return NextResponse.json({ ok: true, activeId, warnings: await activeApplyWarnings() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }
    await deleteProfile(id);
    if ((await getActiveId()) === id) await setActiveId(null);
    return NextResponse.json({ ok: true, profiles: await loadProfiles(), activeId: await getActiveId() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
