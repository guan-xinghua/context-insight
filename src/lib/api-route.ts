// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// API 路由统一错误日志包装器：此前各路由的 catch 只把错误折进 JSON 响应
// 体——客户端不打印就彻底蒸发，服务端零痕迹。包一层后未捕获异常落统一日志
// （method/path/ms/error），响应形状与各路由既有 catch 逐字节一致
// （{error: message} + 500），route 直调测试零回归。成功路径走 debug 请求行
// （默认 info 级安静；开 debug 得到全量访问日志），handler 返回 5xx 的软失败
// 同样记 error。泛型 Ctx 保住 [turnId] 等动态路由的 { params: Promise<...> }
// 第二参数类型。
import { NextResponse } from 'next/server';
import { logDebug, logError } from './logger';

// 入参用基础 Request 而非 NextRequest：原路由签名两种都有（Request/
// NextRequest），wrapper 不得收窄类型；Next 运行时恒传 NextRequest，
// 需要 nextUrl 的 handler 自行按原签名收。
// handler 形参位用 never（TS 逆变通配惯用法）：无论 handler 声明 Request
// 还是 NextRequest 都可赋值，调用侧原样透传运行时对象。
type RouteHandler<Ctx> = (request: never, ctx: Ctx) => Promise<Response> | Response;

export function withRouteLog<Ctx = unknown>(scope: string, handler: RouteHandler<Ctx>) {
  // 双参可选：静态路由本就无参（Next 传 undefined），测试直调也常省略
  return async (request?: Request, ctx?: Ctx): Promise<Response> => {
    const started = Date.now();
    let path = '';
    if (request) {
      try { path = new URL(request.url).pathname; } catch { path = request.url; }   // 相对 URL（测试直调形态）原样
    }
    const desc = request ? `${request.method} ${path}` : scope;
    try {
      const res = await handler(request as never, ctx as Ctx);
      if (res.status >= 500) {
        logError(`route:${scope}`, `${desc} failed`, { status: res.status, ms: Date.now() - started });
      } else {
        logDebug(`route:${scope}`, `${desc} done`, { status: res.status, ms: Date.now() - started });
      }
      return res;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logError(`route:${scope}`, `${desc} unhandled`, { status: 500, ms: Date.now() - started, error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}
