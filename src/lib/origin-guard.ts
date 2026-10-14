// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 浏览器跨源守卫（纯函数）：服务只绑 127.0.0.1 且 API 无鉴权（本地自用工具，
// docs/multi-user-server.md），非浏览器调用方（CLI / TUI / cpx 自动导入 /
// smart-agent）本来就不带 Origin/Referer 头，全放行；但用户浏览器里的恶意
// 网页可以拿 localhost 端口当靶子——no-cors 模式 POST text/plain 一样能被
// request.json() 解析，借服务端触发导入/删除/上传等写副作用（响应虽被 CORS
// 挡住不可读，破坏已经发生）。两条封堵：
//   1. 带 Origin/Referer 的请求必须与服务自身同源（http(s)://<Host>）；
//   2. Host 主机名必须是回环地址——封 DNS rebinding（外域解析到 127.0.0.1
//      后 Host 变成外域主机名，此时页面"同源"但并非本机页面）。
// Origin: "null"（沙箱 iframe / 隐私上下文）按不可信处理。

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '[::1]', '::1']);

const API_PATH_PREFIXES = ['/api/', '/lake_viewer/api/'];

export type OriginGuardDecision =
  | { allow: true }
  | { allow: false; reason: string };

function isApiPath(pathname: string): boolean {
  return API_PATH_PREFIXES.some(p => pathname === p.slice(0, -1) || pathname.startsWith(p));
}

export function guardBrowserOrigin(input: {
  pathname: string;
  origin: string | null;
  referer: string | null;
  host: string | null;
}): OriginGuardDecision {
  if (!isApiPath(input.pathname)) return { allow: true };
  // 非浏览器客户端（Node fetch / curl 不带这两个头）零影响
  if (input.origin == null && input.referer == null) return { allow: true };

  const host = (input.host ?? '').trim().toLowerCase();
  if (host === '') {
    return { allow: false, reason: 'Forbidden: request carries browser headers but no Host header' };
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return { allow: false, reason: `Forbidden: malformed Host header "${host}"` };
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return { allow: false, reason: `Forbidden: non-loopback Host "${host}"` };
  }

  const sameOrigins = [`http://${host}`, `https://${host}`];
  if (input.origin != null) {
    if (input.origin === 'null') {
      return { allow: false, reason: 'Forbidden: opaque origin "null" (sandboxed or privacy context)' };
    }
    if (!sameOrigins.includes(input.origin.trim().toLowerCase())) {
      return { allow: false, reason: `Forbidden: cross-origin request from "${input.origin}"` };
    }
    return { allow: true };
  }
  // Origin 缺席但 Referer 存在（表单提交等路径）：Referer 的 origin 同样必须同源
  try {
    const ref = new URL(input.referer ?? '');
    const refOrigin = `${ref.protocol}//${ref.host}`.toLowerCase();
    if (sameOrigins.includes(refOrigin)) return { allow: true };
    return { allow: false, reason: `Forbidden: cross-origin referer "${input.referer}"` };
  } catch {
    return { allow: false, reason: `Forbidden: malformed Referer header "${input.referer}"` };
  }
}
