// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/*
 * start.sh --stop 与随会话清理（多人服务器，docs/design/multi-user/）：
 *
 * 行为用例（hermetic）：start.sh 拷到临时目录执行——SCRIPT_DIR/cwd 锚定把
 * 击杀范围锁在该目录，伪造 next-server 进程（exec -a 改 argv[0]）验证：
 *   1. --stop 击杀自家实例（cwd 在本 checkout 的 next 系进程）
 *   2. --stop 不误杀别人（cwd 在别处的 next 系进程原样存活）——多人隔离锁
 *   3. --stop 幂等（无实例运行时 exit 0）
 * 源断言（防回归锁）：HUP trap / BASE_PORT env 化 / cleanup 三 PID 覆盖 /
 * 端口登记写入 / --stop 先于 smart-agent 拉起。行为面真实 Ctrl+C/HUP 无法
 * 在 e2e 里可靠模拟（需要真终端会话），源断言 + --stop 行为组合覆盖。
 */
import { describe, it, expect } from "vitest"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const START_SH = path.resolve(__dirname, "../..", "start.sh")
const startSrc = fs.readFileSync(START_SH, "utf8")

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

/** 伪造 next 系进程：exec -a 把 argv[0] 改成 next-server（pgrep -f 可匹配），
 * cwd 指定锚定目录。等待 exec 完成后再返回（cmdline 已变为 next-server）。 */
function spawnFakeNextServer(cwd: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", "exec -a next-server sleep 60"], {
      cwd,
      stdio: "ignore",
    })
    const deadline = Date.now() + 5000
    const poll = () => {
      try {
        const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, "utf8")
        if (cmdline.startsWith("next-server")) return resolve(child)
      } catch { /* /proc 尚未就绪 */ }
      if (Date.now() > deadline) return reject(new Error("fake next-server exec 未完成"))
      setTimeout(poll, 50)
    }
    poll()
  })
}

function waitForExit(child: ChildProcess, ms = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true)
    const t = setTimeout(() => resolve(false), ms)
    child.once("exit", () => { clearTimeout(t); resolve(true) })
  })
}

function runStop(scriptDir: string, port: number): { status: number; stdout: string } {
  const r = spawnSync("bash", [path.join(scriptDir, "start.sh"), "--stop"], {
    env: { ...process.env, CANNBOT_INSIGHT_PORT: String(port) },
    encoding: "utf8",
    timeout: 30000,
  })
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") }
}

describe("start.sh --stop 与随会话清理（多人服务器）", () => {
  it("源断言：trap 覆盖 HUP（SSH 断开/终端关闭即清理——历史残留主洞）", () => {
    expect(startSrc).toContain("trap cleanup EXIT INT TERM HUP")
  })

  it("源断言：BASE_PORT 可用 CANNBOT_INSIGHT_PORT 覆盖（每用户固定端口）", () => {
    expect(startSrc).toContain('BASE_PORT="${CANNBOT_INSIGHT_PORT:-21025}"')
  })

  it("源断言：cleanup 覆盖 BACKEND/NEXT/AGENT 三个子进程 PID", () => {
    expect(startSrc).toContain("for label in BACKEND_PID NEXT_PID AGENT_PID")
  })

  it("源断言：服务就绪后写端口登记文件（发现契约写入端）", () => {
    expect((startSrc.match(/echo "\$PORT" > "\$INSIGHT_PORT_REGISTRY"/g) ?? []).length).toBe(2)
  })

  it("源断言：登记锚定跟随 CANNBOT_INSIGHT_HOME（与 npm 启动器/读侧一致）", () => {
    expect(startSrc).toContain(
      'CANNBOT_HOME_DIR="$(dirname "${CANNBOT_PROXY_DIR:-${CANNBOT_INSIGHT_HOME:-$HOME/.cannbot-insight}/proxy}")"',
    )
  })

  it("源断言：--stop 分支先于 smart-agent 拉起（stop 不残留 agent）", () => {
    const stopIdx = startSrc.indexOf('if [ "$STOP_REQUESTED" = true ]')
    const agentIdx = startSrc.indexOf("# Launch Python smart-agent")
    expect(stopIdx).toBeGreaterThan(-1)
    expect(agentIdx).toBeGreaterThan(stopIdx)
  })

  it("行为：--stop 击杀 cwd 在本 checkout 的 next 系进程", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stop-own-")))
    fs.copyFileSync(START_SH, path.join(dir, "start.sh"))
    const port = await ephemeralPort()
    const fake = await spawnFakeNextServer(dir)
    try {
      const r = runStop(dir, port)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain("[stop] stopped")
      expect(await waitForExit(fake)).toBe(true)
    } finally {
      fake.kill("SIGKILL")
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("行为：--stop 不误杀别人（cwd 在别处的 next 系进程存活）——多人隔离锁", async () => {
    const ownDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stop-own-")))
    const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stop-other-")))
    fs.copyFileSync(START_SH, path.join(ownDir, "start.sh"))
    const port = await ephemeralPort()
    const ownFake = await spawnFakeNextServer(ownDir)
    const otherFake = await spawnFakeNextServer(otherDir)
    try {
      const r = runStop(ownDir, port)
      expect(r.status).toBe(0)
      expect(await waitForExit(ownFake)).toBe(true)
      // 别人的进程必须原样存活（kill -0 仍成功）
      expect(otherFake.exitCode).toBeNull()
      expect(() => process.kill(otherFake.pid!, 0)).not.toThrow()
    } finally {
      ownFake.kill("SIGKILL")
      otherFake.kill("SIGKILL")
      fs.rmSync(ownDir, { recursive: true, force: true })
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it("行为：--stop 幂等（无实例运行时 exit 0）", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stop-idem-")))
    fs.copyFileSync(START_SH, path.join(dir, "start.sh"))
    const port = await ephemeralPort()
    try {
      const r = runStop(dir, port)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain("[stop] stopped")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
