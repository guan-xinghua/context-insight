// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/by-session/[taskId]?framework= —— 反向归属（session
// 详情页 RunBadge 数据源）。按 sid 扫描全部 run manifest；framework 参数仅作
// 展示消歧提示（归属本身与记录类无关：同 sid 双行的成员身份一致）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { findRunMemberships } from '@/lib/run/session-link';

export const GET = withRouteLog(
  'observe/run/by-session/[taskId]',
  async (request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) => {
    const { taskId } = await params;
    const framework = request.nextUrl.searchParams.get('framework');
    const memberships = findRunMemberships(taskId);
    return NextResponse.json({ taskId, framework, memberships });
  },
);
