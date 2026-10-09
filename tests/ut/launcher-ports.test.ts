// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * 启动器端口编排 IT（bin/ports.mjs，真实 socket）。
 *
 * 客户 bug：npm 安装后启动报 EADDRINUSE 21026——BASE(21025) 被占时 next 滚到
 * BASE+1，smart-agent 钉死 BASE+1 且先于 next spawn，python 抢先绑定 → next
 * start 绑定同端口崩溃。端口分配必须互相避让（现 next 固定 BASE_PORT 不漂移，
 * 避让保留为结构保险）。
 */
import { describe, it, expect } from "vitest"
import net from "node:net"
import http from "node:http"
import { isTcpFree, isHttpHealthy, isSmartAgent, findPortOwnerPid } from "../../bin/ports.mjs"

function ephemeralPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(port, "127.0.0.1", () => resolve(s))
  })
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe("启动器端口编排（bin/ports.mjs）", () => {
  it("isTcpFree：占用 → false，释放 → true", async () => {
    const p = await ephemeralPort()
    expect(await isTcpFree(p)).toBe(true)
    const s = await occupy(p)
    expect(await isTcpFree(p)).toBe(false)
    await close(s)
    expect(await isTcpFree(p)).toBe(true)
  })

  it("isHttpHealthy：/health 200 → true；关闭端口与非 2xx → false", async () => {
    const dead = await ephemeralPort()
    expect(await isHttpHealthy(dead)).toBe(false)

    const server = http.createServer((req, res) => {
      if (req.url === "/health") res.writeHead(200).end("ok")
      else res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as net.AddressInfo).port
    expect(await isHttpHealthy(port)).toBe(true)
    expect(await isHttpHealthy(port, "/nope")).toBe(false)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await isHttpHealthy(port)).toBe(false)
  })

  it("isSmartAgent 正身判定：通用 /health（2xx 但无服务标识）不认，带 cannbot-smart-agent 标识才认", async () => {
    const dead = await ephemeralPort()
    expect(await isSmartAgent(dead)).toBe(false)

    // 通用 /health 服务三种形态：纯文本 "ok"、JSON 无 service 字段、非 2xx
    const plain = http.createServer((req, res) => {
      if (req.url === "/health") res.writeHead(200).end("ok")
      else res.writeHead(404).end()
    })
    const actuator = http.createServer((req, res) => {
      if (req.url === "/health") res.writeHead(200).end('{"status":"ok"}')
      else res.writeHead(404).end()
    })
    const notFound = http.createServer((req, res) => res.writeHead(404).end())
    const agent = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200).end('{"status":"ok","service":"cannbot-smart-agent"}')
      } else {
        res.writeHead(404).end()
      }
    })
    await Promise.all([
      new Promise<void>((r) => plain.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => actuator.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => notFound.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => agent.listen(0, "127.0.0.1", r)),
    ])
    try {
      expect(await isSmartAgent((plain.address() as net.AddressInfo).port)).toBe(false)
      expect(await isSmartAgent((actuator.address() as net.AddressInfo).port)).toBe(false)
      expect(await isSmartAgent((notFound.address() as net.AddressInfo).port)).toBe(false)
      expect(await isSmartAgent((agent.address() as net.AddressInfo).port)).toBe(true)
    } finally {
      await Promise.all([plain, actuator, notFound, agent].map(
        (s) => new Promise<void>((r) => s.close(() => r())),
      ))
    }
  })

  it("findPortOwnerPid：定位端口监听属主 PID，释放后无属主（--stop 击杀锚定）", async () => {
    const server = http.createServer((req, res) => res.writeHead(404).end())
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as net.AddressInfo).port
    try {
      if (process.platform === "linux") {
        // 自己的监听 socket → 属主就是当前进程；他人进程天然定位不到（权限模型）
        expect(findPortOwnerPid(port)).toBe(process.pid)
      } else {
        // 非 Linux 无 /proc → 结构性降级 null（启动器据此避让而非击杀）
        expect(findPortOwnerPid(port)).toBeNull()
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
    expect(findPortOwnerPid(port)).toBeNull()
  })
})
