// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * sift-runner：mock spawn，验证 stdout 进度解析（批 k/total + 完成 → 百分比）+ result/error 事件。
 */

const REPORT = { skill_name: "x", summary: { total: 2, pass: 1, fail: 1, na: 0 }, findings: [] }

// vi.mock 工厂会被提升到文件顶部，引用不到 it 内的局部变量；用 vi.hoisted 拿稳定引用。
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

/** 手写最小事件面（on/emit），与 node:events 的测试 mock 惯用法零重合。 */
class FakeStream {
  private readonly handlers = new Map<string, Array<(chunk: unknown) => void>>()
  on(event: string, fn: (chunk: unknown) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(fn)
    this.handlers.set(event, list)
    return this
  }
  emit(event: string, chunk?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(chunk)
  }
}

/** spawn 桩用的假子进程：事件面 + 标准流；kill 记标记，可选携带被杀时的清理钩子。 */
class FakeChild extends FakeStream {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  killed = false
  private readonly onKill?: () => void
  constructor(onKill?: () => void) {
    super()
    this.onKill = onKill
  }
  kill(): boolean {
    this.killed = true
    this.onKill?.()
    return true
  }
}

/** 从 CLI 参数里取 -o 指定的输出目录。 */
function outputDirOf(args: string[]): string | undefined {
  for (let i = 0; i + 1 < args.length; i += 1) {
    if (args[i] === "-o") return args[i + 1]
  }
  return undefined
}

function happyImpl(progressLines: string[]) {
  return (_cmd: string, args: string[]) => {
    const child = new FakeChild()
    setTimeout(() => {
      for (const line of progressLines) child.stdout.emit("data", Buffer.from(line + "\n"))
      const outDir = outputDirOf(args)
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, "audit-report.json"), JSON.stringify(REPORT))
        fs.writeFileSync(path.join(outDir, "audit-report.html"), "<!doctype html><body>STUB</body>")
      }
      child.emit("close", 0)
    }, 0)
    return child
  }
}

let tmpOut = ""
beforeEach(() => {
  tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "runner-out-"))
  spawnMock.mockReset()
})
afterEach(() => {
  fs.rmSync(tmpOut, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("runSiftAuditStreaming (via makeStreamingAuditResponse)", () => {
  it("progress 解析 + result 事件", async () => {
    spawnMock.mockImplementation(happyImpl([
      "对账 transcript 1/1: session.json",
      "  [精筛] 判定 5 条…",
      "  [精筛] 完成 ⏱ 10s",
      "  [条件性] 批 1/2 判定 10 条…",
      "  [条件性] 批 1/2 完成 ⏱ 60s",
      "  [禁令] 判定 8 条…",
      "  [禁令] 完成 ⏱ 50s",
      "  [步骤] 判定 12 条…",
      "  [步骤] 完成 ⏱ 40s",
      "  [条件性] 批 2/2 判定 5 条…",
      "  [条件性] 批 2/2 完成 ⏱ 30s",
    ]))
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    const stages = events.map((e: { stage: string }) => e.stage)
    expect(stages).toContain("progress")
    expect(stages.at(-1)).toBe("result")
    const result = events.at(-1) as { stage: string; report: unknown; _html: string; percent: number }
    expect(result.report).toMatchObject({ skill_name: "x" })
    expect(result._html).toContain("STUB")
    expect(result.percent).toBe(100)

    // 百分比单调非减
    const percents = events.filter((e: { stage: string }) => e.stage === "progress").map((e: { percent: number }) => e.percent)
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1])
    }
    expect(percents.at(-1)).toBeGreaterThan(0)
  })

  it("ENOENT → error 事件（sift 未找到）", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => child.emit("error", Object.assign(new Error("enoent"), { code: "ENOENT" })))
      return child
    })
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    expect(events.at(-1)).toMatchObject({ stage: "error" })
    expect((events.at(-1) as { msg: string }).msg).toMatch(/sift 未找到/)
  })

  it("非 0 退出 → error 事件带 exit code", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("切段为空"))
        child.emit("close", 2)
      })
      return child
    })
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    expect(events.at(-1)).toMatchObject({ stage: "error" })
    expect((events.at(-1) as { msg: string }).msg).toMatch(/exit 2/)
  })

  it("退出 0 但无 audit-report.json → error", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => child.emit("close", 0))
      return child
    })
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    expect((events.at(-1) as { stage: string }).stage).toBe("error")
  })

  it("cleanup 在流结束后调用", async () => {
    spawnMock.mockImplementation(happyImpl([]))
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const cleanup = vi.fn()
    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut, cleanup)
    await res.text()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})

describe("computePercent（全局批计数进度模型）", () => {
  // 回归场景：步骤类 24 批 + 禁令/条件性各 3 批。旧模型（3 类平均）在快类完成后
  // 进度高位僵住；新模型按全局完成批数/总批数推进。
  const mk = (over: Partial<Record<"精筛" | "headline" | "条件性" | "禁令" | "步骤", { done?: boolean; k?: number; total?: number }>>) => {
    const base = { done: false, k: 0, total: 0 }
    return {
      "精筛": { ...base, ...over["精筛"] },
      "headline": { ...base, ...over["headline"] },
      "条件性": { ...base, ...over["条件性"] },
      "禁令": { ...base, ...over["禁令"] },
      "步骤": { ...base, ...over["步骤"] },
    }
  }

  it("快类完成、慢类推进 → 进度持续前进（不再高位僵住）", async () => {
    const { computePercent } = await import("@/lib/sift-runner")
    // 禁令/条件性各 3 批全完成；步骤 24 批跑到第 12 批
    const st = mk({ "禁令": { done: true, total: 3 }, "条件性": { done: true, total: 3 }, "步骤": { k: 12, total: 24 } })
    // 全局：完成 3+3+12=18 / 总 30 → 判定段 60% → 15 + 80*0.6 = 63
    expect(computePercent(st, true, 1, 1)).toBe(63)
  })

  it("全部判定完成 → 恰好 95（读报告段由 result=100 收尾，无静默段）", async () => {
    const { computePercent } = await import("@/lib/sift-runner")
    const st = mk({ "禁令": { done: true, total: 3 }, "条件性": { done: true, total: 3 }, "步骤": { done: true, total: 24 } })
    expect(computePercent(st, true, 1, 1)).toBe(95)
  })

  it("未见过 total 的类不虚增分母（步骤类还没输出批号时）", async () => {
    const { computePercent } = await import("@/lib/sift-runner")
    const st = mk({ "精筛": { done: true }, "条件性": { done: true, total: 3 } })
    // 只有条件性贡献 3/3 → 判定段满 → 15+80=95
    expect(computePercent(st, true, 1, 1)).toBe(95)
  })

  it("百分比上限 95（判定段未完成时不冒进到 96+）", async () => {
    const { computePercent } = await import("@/lib/sift-runner")
    const st = mk({ "精筛": { done: true, total: 1 }, "headline": { done: true, total: 1 }, "禁令": { done: true, total: 3 }, "条件性": { done: true, total: 3 }, "步骤": { k: 23, total: 24 } })
    // 全局 29/30 ≈ 0.967 → 15+77.3=92（< 95 上限，正常）
    expect(computePercent(st, true, 1, 1)).toBeLessThanOrEqual(95)
  })
})

describe("多 slice（--kind skill 切片）进度", () => {
  it("新 transcript 开始时进度回落（3 类状态按 slice 重置，不残留上一片的 done）", async () => {
    // 真实场景：skill 被切成 2 个 slice（小 1-1 + 大 1-2）。旧 bug：slice 1 全部完成
    // （3 类 done）后 slice 2 开始，stages 残留 → 全局批计数虚满 → 一上来就 95%。
    spawnMock.mockImplementation(happyImpl([
      "对账 transcript 1/2: tmpX-skill-1-1.jsonl",
      "  [精筛] 无候选",
      "  [条件性] 批 1/1 判定 4 条…",
      "  [条件性] 批 1/1 完成 ⏱ 60s",
      "  [禁令] 批 1/1 判定 6 条…",
      "  [禁令] 批 1/1 完成 ⏱ 55s",
      "  [步骤] 批 1/1 判定 8 条…",
      "  [步骤] 批 1/1 完成 ⏱ 70s",
      "对账 transcript 2/2: tmpX-skill-1-2.jsonl",
      "  [条件性] 批 1/5 判定 10 条…",
      "  [步骤] 批 1/7 判定 10 条…",
    ]))
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    const progressPcts = events
      .filter((e: { stage: string }) => e.stage === "progress")
      .map((e: { percent: number }) => e.percent)
    // slice 1 结束：单 slice 内 3 类各 1/1 完成 → 判定段满 → 95（上限）
    const atSlice1End = progressPcts[7]
    expect(atSlice1End).toBe(95)
    // slice 2 批输出后：3 类已重置（slice 1 的 done 不残留）→ 全局 2/12 批 → 15+80*2/12 ≈ 28
    const atSlice2Start = progressPcts[progressPcts.length - 1]
    expect(atSlice2Start).toBeLessThan(50)
    expect(atSlice2Start).toBeGreaterThan(15) // 判定段已开始
    // 回归锁定：旧 bug（slice 状态残留）时 slice 2 开始即 95
    expect(atSlice2Start).toBeLessThan(95)
  })
})

describe("静默看门狗", () => {
  it("静默超阈值 → SIGKILL + error 事件（带最后输出上下文）", async () => {
    vi.useFakeTimers()
    try {
      spawnMock.mockImplementation(() => {
        const child = new FakeChild()
        // 输出一行进度后彻底静默（模拟进程崩溃/close 丢失）
        setImmediate(() => child.stdout.emit("data", Buffer.from("  [步骤] 批 5/24 判定 10 条…\n")))
        return child
      })
      const { makeStreamingAuditResponse, SILENCE_KILL_MS } = await import("@/lib/sift-runner")

      const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
      const textPromise = res.text()
      // 推进到静默阈值 + 1s（fake timer 不自动跑，需手动 advance）
      await vi.advanceTimersByTimeAsync(SILENCE_KILL_MS + 1000)
      const events = (await textPromise).trim().split("\n").map((l) => JSON.parse(l))
      const last = events.at(-1) as { stage: string; msg: string }
      expect(last.stage).toBe("error")
      expect(last.msg).toMatch(/无任何输出/)
      expect(last.msg).toContain("[步骤] 批 5/24")
      expect(last.msg).toMatch(/挂死/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("持续输出喂狗 → 看门狗不触发（长时间运行被允许）", async () => {
    vi.useFakeTimers()
    try {
      spawnMock.mockImplementation(() => {
        const child = new FakeChild()
        // 每 5 分钟输出一行（模拟慢 LLM 批次间的重试提示），3 轮共 15min > 12min 阈值
        const lines = ["  [步骤] 批 1/3 判定 10 条…", "  [步骤] 批 1/3 重试 1/4…", "  [步骤] 批 2/3 判定 10 条…"]
        let i = 0
        const emitNext = (): void => {
          if (i < lines.length) {
            child.stdout.emit("data", Buffer.from(lines[i++] + "\n"))
            setTimeout(emitNext, 5 * 60 * 1000)
          } else {
            fs.mkdirSync(tmpOut, { recursive: true })
            fs.writeFileSync(path.join(tmpOut, "audit-report.json"), JSON.stringify(REPORT))
            child.emit("close", 0)
          }
        }
        setImmediate(emitNext)
        return child
      })
      const { makeStreamingAuditResponse, SILENCE_KILL_MS } = await import("@/lib/sift-runner")

      const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
      const textPromise = res.text()
      // 总时长 3×5min = 15min > 12min 静默阈值，但每次输出都在重置看门狗
      await vi.advanceTimersByTimeAsync(3 * SILENCE_KILL_MS + 60_000)
      const events = (await textPromise).trim().split("\n").map((l) => JSON.parse(l))
      expect((events.at(-1) as { stage: string }).stage).toBe("result")
    } finally {
      vi.useRealTimers()
    }
  })

  it("总时限超时 → error 事件（LLM 判定过慢提示）", async () => {    vi.useFakeTimers()
    try {
      spawnMock.mockImplementation(() => {
        const child = new FakeChild(() => clearInterval(interval))
        // 持续输出喂狗（不触发静默看门狗），模拟判定一直在跑但跑不完
        const interval = setInterval(() => child.stdout.emit("data", Buffer.from("  [步骤] 批 1/24 判定 10 条…\n")), 60_000)
        return child
      })
      const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

      // 走内部 runSiftAuditStreaming 需经 makeStreamingAuditResponse（无 timeoutMs 参数）→
      // 用总时限 30min 默认值：advance 31min
      const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
      const textPromise = res.text()
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
      const events = (await textPromise).trim().split("\n").map((l) => JSON.parse(l))
      const last = events.at(-1) as { stage: string; msg: string }
      expect(last.stage).toBe("error")
      expect(last.msg).toMatch(/总时限/)
    } finally {
      vi.useRealTimers()
    }
  })
})
