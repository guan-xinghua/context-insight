// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * npm 全局启动器多人服务器行为 IT（bin/cannbot-insight.mjs，真实进程/真实 socket）。
 *
 * 补齐 npm 形态的多人链路（与 start.sh 收口对齐）：
 *   - 固定端口语义：被占 fail-fast，绝不静默漂移（漂移断 cpx 发现与书签，
 *     且两实例各持一个库 = 数据静默分叉）
 *   - --stop：PID 文件锚定击杀自家全家福 + 候选区间验明正身的孤儿 smart-agent；
 *     陌生进程占用端口 → 绝不代杀
 */
import { describe, it, expect, afterEach } from "vitest"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isTcpFree } from "../../bin/ports.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LAUNCHER = path.resolve(__dirname, "../../bin/cannbot-insight.mjs")
const LAUNCHER_SRC = fs.readFileSync(LAUNCHER, "utf8")
const PORTS_SRC = fs.readFileSync(path.resolve(__dirname, "../../bin/ports.mjs"), "utf8")

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((fn) => {
    try { fn() } catch { /* 尽力而为 */ }
  })
})

function mkHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-launcher-it-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
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

/** BASE 与候选区间 BASE+1~+3 全空的起点（保证 --stop 扫描场景确定性）。 */
async function freeBase(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const b = await ephemeralPort()
    if ((await isTcpFree(b + 1)) && (await isTcpFree(b + 2)) && (await isTcpFree(b + 3))) return b
  }
  throw new Error("20 次内未找到四连空闲端口段")
}

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(port, "127.0.0.1", () => resolve(s))
  })
}

function runLauncher(cliArgs: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [LAUNCHER, ...cliArgs], {
    env: { ...process.env, ...env, CANNBOT_NO_BROWSER: "1" },
    encoding: "utf8",
    timeout: 90_000,
  })
}

function isDead(pid: number | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return false } catch { return true }
}

/**
 * 轮询等进程消失：spawnSync 期间测试进程收不到 SIGCHLD，被杀子进程会先以
 * 僵尸态存在（kill-0 仍成功），事件循环恢复后才被收割——立刻断言会误判存活。
 */
async function eventuallyDead(pid: number | undefined, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (isDead(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return isDead(pid)
}

/** 等 exec -a 替换完成（cmdline 就位），保证 PID 复用防御的形态校验命中。 */
async function waitCmdline(pid: number | undefined, marker: string): Promise<void> {
  if (!pid) throw new Error("无 pid")
  for (let i = 0; i < 40; i++) {
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker)) return
    } catch {
      return // 非 Linux / 进程已退出 —— 不阻塞
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`cmdline 未出现 ${marker} (pid ${pid})`)
}

/** 假自家进程：exec -a 换 argv0，让 /proc cmdline 形态校验（pidMatchesOurFamily）命中。 */
function fakeProc(argv0: string): ChildProcess {
  const child = spawn("bash", ["-c", `exec -a ${argv0} sleep 120`], { stdio: "ignore" })
  cleanups.push(() => { try { child.kill("SIGKILL") } catch { /* 尽力而为 */ } })
  return child
}

describe("cbi --stop（击杀锚定：PID 文件 + 候选区间验明正身，绝不盲杀）", () => {
  it("按 PID 文件击杀自家全家福：next/agent 死透，已死 PID 跳过，记录清除", async () => {
    const home = mkHome()
    const base = await freeBase()
    const fakeNext = fakeProc("next-server")
    const fakeAgent = fakeProc("server.py")
    await waitCmdline(fakeNext.pid, "next-server")
    await waitCmdline(fakeAgent.pid, "server.py")
    // 已死 PID（launcher 位）：kill-0 守卫应跳过，不误伤复用该 PID 的进程
    const dying = spawn("bash", ["-c", "sleep 120"], { stdio: "ignore" })
    dying.kill("SIGKILL")
    await new Promise<void>((r) => dying.on("exit", r))

    fs.writeFileSync(
      path.join(home, "insight.pid"),
      JSON.stringify({ launcher: dying.pid, next: fakeNext.pid, agents: [fakeAgent.pid], port: base }),
    )

    const r = runLauncher(["--stop"], { CANNBOT_INSIGHT_HOME: home, CANNBOT_INSIGHT_PORT: String(base) })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("PID 记录")
    expect(await eventuallyDead(fakeNext.pid)).toBe(true)
    expect(await eventuallyDead(fakeAgent.pid)).toBe(true)
    expect(fs.existsSync(path.join(home, "insight.pid"))).toBe(false)
  })

  it("候选区间孤儿 smart-agent 兜底回收（验明正身 + 属主可定位才动手）", async () => {
    const home = mkHome()
    const base = await freeBase()
    // 假 smart-agent：独立子进程（不能在测试进程内起——属主定位会指到 vitest worker 自己）
    const script = `
      // fake server.py marker（cmdline 形态校验命中用）
      require("node:http").createServer((q, s) => {
        if (q.url === "/health") {
          s.writeHead(200, { "content-type": "application/json" })
          s.end(JSON.stringify({ service: "cannbot-smart-agent" }))
        } else { s.writeHead(404).end() }
      }).listen(${base + 1}, "127.0.0.1")
    `
    const agent = spawn(process.execPath, ["-e", script], { stdio: "ignore" })
    cleanups.push(() => { try { agent.kill("SIGKILL") } catch { /* 尽力而为 */ } })
    let ready = false
    for (let i = 0; i < 40 && !ready; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${base + 1}/health`)
        ready = res.ok && (await res.json()).service === "cannbot-smart-agent"
      } catch { /* 未就绪 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 100))
    }
    expect(ready).toBe(true)

    const r = runLauncher(["--stop"], { CANNBOT_INSIGHT_HOME: home, CANNBOT_INSIGHT_PORT: String(base) })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("孤儿 smart-agent")
    expect(await eventuallyDead(agent.pid)).toBe(true)
  })

  it("端口被陌生进程占用 → 退出 1 且绝不代杀", async () => {
    const home = mkHome()
    const base = await freeBase()
    const holder = await occupy(base) // 无 /health 契约的陌生 TCP 服务
    const r = runLauncher(["--stop"], { CANNBOT_INSIGHT_HOME: home, CANNBOT_INSIGHT_PORT: String(base) })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("仍被占用")
    // 占用者毫发无损（若启动器误杀端口属主，本测试进程会被杀——双重负向锁）
    expect(holder.listening).toBe(true)
  })
})

describe("固定端口语义（多人服务器：每人固定端口，绝不静默漂移）", () => {
  it("默认启动端口被占 → fail-fast 退出 1（不 migrate、不 build、不漂移）", async () => {
    const home = mkHome()
    const base = await freeBase()
    const holder = await occupy(base)
    const r = runLauncher([], { CANNBOT_INSIGHT_HOME: home, CANNBOT_INSIGHT_PORT: String(base) })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`端口 ${base} 被占用`)
    expect(r.stderr).toContain("CANNBOT_INSIGHT_PORT")
    // 重活（migrate/build）绝不在端口被占时启动——fail-fast 必须先于重活
    expect(r.stdout).not.toContain("Prisma migrations")
    expect(r.stderr).not.toContain("Prisma migrations")
    // 占用者毫发无损（若启动器误杀端口属主，本测试进程会被杀——双重负向锁）
    expect(holder.listening).toBe(true)
  })
})

describe("源断言（回归锁：多人零残留的关键路径）", () => {
  it("SIGHUP 已挂——SSH 断开/终端关闭走清理链", () => {
    expect(LAUNCHER_SRC).toContain("process.on('SIGHUP'")
  })

  it("端口登记写入发现契约（读侧 cpx/cbi，持久保留）", () => {
    expect(LAUNCHER_SRC).toContain("writeFileSync(registryPath(), `${port}\\n`)")
  })

  it("登记路径回落 DATA_DIR（= CANNBOT_INSIGHT_HOME || ~/.cannbot-insight），与读侧一致", () => {
    expect(LAUNCHER_SRC).toContain("path.join(DATA_DIR, 'insight-port')")
    expect(LAUNCHER_SRC).toContain("process.env.CANNBOT_INSIGHT_HOME || path.join(homedir(), '.cannbot-insight')")
  })

  it("PID 全家福落盘——--stop 的击杀锚定", () => {
    expect(LAUNCHER_SRC).toContain("path.join(DATA_DIR, 'insight.pid')")
    expect(LAUNCHER_SRC).toContain("writeFileSync(PID_FILE")
  })

  it("findFreePort 已退役——固定端口语义不漂移", () => {
    expect(LAUNCHER_SRC).not.toContain("findFreePort")
    expect(PORTS_SRC).not.toContain("findFreePort")
  })

  it("smart-agent 恒 clean——复用路径已移除", () => {
    expect(LAUNCHER_SRC).toContain("startSmartAgentClean")
    expect(LAUNCHER_SRC).not.toContain("不重复 spawn")
  })

  it("击杀升级路径：TERM 宽限 → SIGKILL（next-server 无视 TERM 实测）", () => {
    expect(LAUNCHER_SRC).toContain("'SIGKILL'")
  })
})
