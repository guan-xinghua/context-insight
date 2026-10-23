// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * smart-agent 端口选择器行为 IT（scripts/pick-smart-agent-port.sh，真实进程 + 真实端口）。
 *
 * 修两类"运行中被杀死/撞车"事故：
 * 1. start.sh 曾无差别击杀 AGENT_PORT 占用者（kill → kill -9），无关服务占 21026
 *    就会被误杀（"已杀死"事故来源之一）——现在 /health 应答体须带服务标识
 *    context-smart-agent 才验明正身杀旧重启，否则错开端口（带通用 /health 的
 *    无关服务——Actuator、dev server 等——同样不认、不杀）；
 * 2. smart-agent 钉死 BASE+1，BASE 被占时 next 滚进 BASE+1 与之相撞（EADDRINUSE）——
 *    现在候选避让 next 实占端口。
 */
import { describe, it, expect } from "vitest"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import net from "node:net"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PICK = path.resolve(__dirname, "../..", "scripts", "pick-smart-agent-port.sh")

function occupyTcp(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(port, "127.0.0.1", () => resolve(s))
  })
}

/** 带通用 /health 的无关服务（Actuator / k8s 探针 / dev server 形态）：2xx 但无服务标识。 */
function occupyGenericHealthService(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      if (req.url === "/health") res.writeHead(200).end('{"status":"ok"}')
      else res.writeHead(404).end()
    })
    s.once("error", reject)
    s.listen(port, "127.0.0.1", () => resolve(s))
  })
}

function closeServer(s: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => {
    // 哑 TCP 服务被 curl 探测过的连接可能不随对端关闭而结束，
    // server.close() 会等全部连接挂起——closeAllConnections 强制断 + 2s 兜底
    const anyS = s as net.Server & { closeAllConnections?: () => void }
    anyS.closeAllConnections?.()
    s.close(() => resolve())
    setTimeout(resolve, 2000)
  })
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

/** 取四连空闲端口段起点（b..b+3 均空），保证场景确定性。 */
async function freeQuadBase(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const b = await ephemeralPort()
    let ok = true
    for (let d = 1; d <= 3; d++) {
      const probe = net.createServer()
      await new Promise<void>((resolve) => {
        probe.once("error", () => { ok = false; resolve() })
        probe.once("listening", () => { probe.close(() => resolve()) })
        probe.listen(b + d, "127.0.0.1")
      })
      if (!ok) break
    }
    if (ok) return b
  }
  throw new Error("20 次内未找到四连空闲端口段")
}

function pick(base: number, nextPort: number, insightRoot?: string, mode?: string) {
  const args = [PICK, String(base), String(nextPort)]
  // 显式占位：undefined 跳过会让后续参数错位（mode 落到 INSIGHT_ROOT 槽）
  args.push(insightRoot ?? "")
  if (mode) args.push(mode)
  return execFileAsync("bash", args, { timeout: 30_000 })
}

describe("smart-agent 端口选择器（pick-smart-agent-port.sh）", () => {
  it("空闲场景：返回 BASE+1", async () => {
    const base = await freeQuadBase()
    const { stdout } = await pick(base, base)
    expect(stdout.trim()).toBe(String(base + 1))
  })

  it("撞车规避：next 占了 BASE+1（BASE 被占滚进来的），smart-agent 必须避让到 BASE+2", async () => {
    const base = await freeQuadBase()
    const { stdout, stderr } = await pick(base, base + 1)
    expect(stdout.trim()).toBe(String(base + 2))
    expect(stderr).toContain("skipped (next is using it)")
  })

  it("无关进程占口：绝不击杀，错开到下一候选", async () => {
    const base = await freeQuadBase()
    const foreign = await occupyTcp(base + 1) // 哑 TCP 服务（无 /health）= 无关进程
    try {
      const { stdout, stderr } = await pick(base, base)
      expect(stdout.trim()).toBe(String(base + 2))
      expect(stderr).toContain("non-smart-agent process")
      // 关键断言：无关进程仍存活（旧行为会 kill -9 它）
      expect(foreign.listening).toBe(true)
    } finally {
      await closeServer(foreign)
    }
  }, 30_000)

  it("存量 smart-agent（/health 带服务标识）：杀旧重启并复用该端口", async () => {
    const base = await freeQuadBase()
    // 存量 smart-agent 用独立子进程承载（脚本会杀它，必须隔离于测试进程之外）；
    // /health 应答带服务标识（server.py 契约），否则正身校验不过不会杀；
    // 立即挂 catch 防止被杀时在 await 前触发 unhandledRejection
    const child = execFileAsync("node", ["-e", `
      const http = require("node:http")
      const s = http.createServer((req, res) => req.url === "/health"
        ? res.writeHead(200).end('{"status":"ok","service":"context-smart-agent"}')
        : res.writeHead(404).end())
      s.listen(${base + 1}, "127.0.0.1", () => console.log("up"))
    `], { timeout: 60_000 })
    child.catch(() => {})
    for (let i = 0; i < 50; i++) {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:${base + 1}/health`, (r) => { r.resume(); resolve(r.statusCode === 200) })
        req.on("error", () => resolve(false))
      })
      if (ok) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const { stdout, stderr } = await pick(base, base, undefined, "clean")
    expect(stdout.trim()).toBe(String(base + 1))
    expect(stderr).toContain("Restarting smart-agent")
    await expect(child).rejects.toThrow() // 子进程被终止（非零退出）
  }, 60_000)

  it("带通用 /health 的无关服务（Actuator/dev server 式 2xx）：不杀、错开到下一候选", async () => {
    const base = await freeQuadBase()
    // 回归锁定：旧实现只看 /health 2xx，带通用健康端点的无关服务会被误杀
    const foreign = await occupyGenericHealthService(base + 1)
    try {
      const { stdout, stderr } = await pick(base, base)
      expect(stdout.trim()).toBe(String(base + 2))
      expect(stderr).toContain("non-smart-agent process")
      expect(foreign.listening).toBe(true)
    } finally {
      await closeServer(foreign)
    }
  }, 30_000)

  it("候选全被无关进程占满：返回空（调用方跳过 smart-agent）", async () => {
    const base = await freeQuadBase()
    const a = await occupyTcp(base + 1)
    const b = await occupyTcp(base + 2)
    const c = await occupyTcp(base + 3)
    try {
      const { stdout } = await pick(base, base)
      expect(stdout.trim()).toBe("")
    } finally {
      await closeServer(a)
      await closeServer(b)
      await closeServer(c)
    }
  }, 30_000)

  it("server.py 只绑 127.0.0.1（不再 0.0.0.0 全网卡暴露）", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../..", "smart-agent", "server.py"), "utf8")
    expect(src).toContain('ThreadingHTTPServer(("127.0.0.1", PORT), Handler)')
    expect(src).not.toContain('ThreadingHTTPServer(("0.0.0.0", PORT), Handler)')
  })

  it("正身契约：server.py /health 带服务标识；picker lsof 分支只取 LISTEN", () => {
    const py = fs.readFileSync(path.resolve(__dirname, "../..", "smart-agent", "server.py"), "utf8")
    // /health 服务标识是 shell picker 与 mjs 启动器共用的正身依据
    expect(py).toContain('"service": "context-smart-agent"')
    const sh = fs.readFileSync(PICK, "utf8")
    // lsof -ti tcp:$port 默认匹配连接两端：ESTABLISHED 客户端 PID 可能被
    // head -1 取到而杀错进程（macOS 正走 lsof 分支），必须带 LISTEN 过滤
    expect(sh).toContain('lsof -ti "tcp:$port" -sTCP:LISTEN')
  })

  // 规则 3：自家 insight 残留实例（开发期累积的 next-server 僵尸占满候选端口）
  const PKG_ROOT = path.resolve(__dirname, "../..")

  /** 模拟自家 insight 残留：cmdline 首段 next-server + cwd 在包内 + 监听端口。 */
  function spawnStaleInsight(port: number, cwd: string) {
    return spawn("bash", ["-c",
      `exec -a next-server node -e 'require("net").createServer().listen(${port}, "127.0.0.1")'`,
    ], { cwd, stdio: "ignore" })
  }

  async function waitListening(port: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true) })
        s.on("error", () => resolve(false))
      })
      if (ok) return
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error("stale insight simulator never listened")
  }

  // is_our_insight 依赖 /proc/<pid>/{cmdline,cwd}——macOS 无 /proc 恒不认定
  //（行为回退为避让，正确但断言必失败），非 Linux 跳过击杀断言
  it.skipIf(!fs.existsSync("/proc"))("自家 insight 残留实例（next-server + cwd 在包内）：击杀回收并复用端口", async () => {
    const base = await freeQuadBase()
    const child = spawnStaleInsight(base + 1, PKG_ROOT)
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
    child.once("error", () => {}) // spawn 失败兜底，避免 unhandled
    try {
      await waitListening(base + 1)
      const { stdout, stderr } = await pick(base, base, PKG_ROOT, "clean")
      expect(stdout.trim()).toBe(String(base + 1))
      expect(stderr).toContain("stale insight instance")
      await exited // 被脚本击杀
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  }, 60_000)

  it("别人的 next-server（cwd 不在包内）：不认定、不杀、错开到下一候选", async () => {
    const base = await freeQuadBase()
    // 双重限定的另一半：仅 cmdline 匹配不足以击杀（别的 Next.js 项目）
    const child = spawnStaleInsight(base + 1, os.tmpdir())
    child.once("error", () => {})
    try {
      await waitListening(base + 1)
      const { stdout, stderr } = await pick(base, base, PKG_ROOT, "clean")
      expect(stdout.trim()).toBe(String(base + 2))
      expect(stderr).toContain("non-smart-agent process")
      expect(child.exitCode === null).toBe(true) // 未被杀
    } finally {
      child.kill("SIGKILL")
    }
  }, 60_000)

  it("keep 模式（默认启动）：自家实例也不杀——用户并跑双实例的保障", async () => {
    const base = await freeQuadBase()
    const child = spawnStaleInsight(base + 1, PKG_ROOT)
    child.once("error", () => {})
    try {
      await waitListening(base + 1)
      const { stdout, stderr } = await pick(base, base, PKG_ROOT, "keep")
      expect(stdout.trim()).toBe(String(base + 2))
      expect(stderr).toContain("non-smart-agent process")
      expect(child.exitCode === null).toBe(true) // 未被杀
    } finally {
      child.kill("SIGKILL")
    }
  }, 60_000)
})
