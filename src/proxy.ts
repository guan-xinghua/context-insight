// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// API 单点入口守卫（Next 16 proxy，前身 middleware）：所有 /api/* 与
// /lake_viewer/api/* 请求先过浏览器跨源检查（src/lib/origin-guard.ts），
// 非浏览器调用方（CLI / cpx 自动导入）不带 Origin/Referer，零影响。
// 页面路由不拦——浏览器导航无写副作用，响应本就受同源策略保护。
import { NextRequest, NextResponse } from 'next/server';
import { guardBrowserOrigin } from '@/lib/origin-guard';

export default function proxy(request: NextRequest): NextResponse {
  const decision = guardBrowserOrigin({
    pathname: request.nextUrl.pathname,
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    host: request.headers.get('host') ?? request.nextUrl.host,
  });
  if (!decision.allow) {
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*', '/lake_viewer/api/:path*'],
};
