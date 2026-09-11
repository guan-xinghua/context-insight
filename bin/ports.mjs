#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 启动器端口工具（bin/cannbot-insight.mjs 与 tests/launcher-ports.test.ts 共用）。
// 修复背景：smart-agent 端口曾钉死 BASE_PORT+1 且先于 next start 启动——BASE_PORT
// 被占时 next 滚到 BASE_PORT+1，smart-agent 抢先绑定同端口 → next start
// EADDRINUSE 崩溃（客户实测 21026）。端口分配必须互相避让。

/** 端口在 127.0.0.1 上是否空闲（真实 bind 探测，非启发）。 */
export function isTcpFree(port) {
  return new Promise((resolve) => {
    import('node:net').then((net) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.once('listening', () => { s.close(() => resolve(true)) })
      s.listen(port, '127.0.0.1')
    })
  })
}

/** 端口上是否有 HTTP 服务健康应答（Node >= 20 内置 fetch，无 curl 依赖）。 */
export async function isHttpHealthy(port, path = '/health', timeoutMs = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ac.signal })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** smart-agent /health 响应体里的服务标识（正身依据，server.py 同步维护）。 */
export const SMART_AGENT_SERVICE = 'cannbot-smart-agent'

/**
 * 端口上是否为本 smart-agent：/health 2xx 且响应体带服务标识。
 * 仅凭 2xx 不够——Actuator、k8s 风格健康检查、各类 Node dev server 都有
 * /health，误认会导致复用陌生后端（breather/v2 全部调用打错服务）。
 */
export async function isSmartAgent(port, timeoutMs = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal })
    if (!r.ok) return false
    const body = await r.json()
    return body?.service === SMART_AGENT_SERVICE
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 start 起找首个空闲端口。
 * skip：必须避让的端口（如 next 实际选中的端口）——smart-agent 分配时传入，
 * 保证辅助服务永不与主服务撞端口。
 */
export async function findFreePort(start, { limit = 128, skip } = {}) {
  for (let p = start; p < start + limit; p++) {
    if (skip !== undefined && p === skip) continue
    if (await isTcpFree(p)) return p
  }
  return null
}
