// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * Server-only（spawn/child_process）：spawn sift audit，流式读 stdout，解析 on_progress
 * 输出算百分比，事件以 NDJSON 回传前端。管道模式（非 tty）下 rich 输出纯文本，可可靠解析。
 *
 * 进度结构（auditor.py 的 on_progress）：
 *   "对账 transcript k/N: name"                          — transcript 层进度
 *   "  [精筛] 批 k/total 判定 N 条…" / "…完成 ⏱ Xs"      — 精筛(refine)
 *   "  [headline] 批 k/total 判定 N 条…" / "…完成 ⏱ Xs"  — headline
 *   "  [条件性|禁令|步骤] 批 k/total 判定 N 条…"          — 3 类 LLM 判定并发
 *   "  [条件性|禁令|步骤] 批 k/total 完成 ⏱ Xs"
 *
 * 进度模型（v2.03 修正）：预处理（精筛+headline）占 0→15%；判定段 15→95% 按**全局批计数**
 * ——所有已见过的 [label] 批 k/total 累计（完成批数/总批数），不再"3 类各自平均"：
 * 步骤类 24 批 × 禁令/条件性各 3 批的真实场景下，快类提前完成曾把三类平均顶到高位、
 * 之后长时间不动（"卡 95%"观感）。95→100% 由 close 时读报告/发 result 填上，无静默段。
 *
 * 看门狗：LLM 批次实测 40s~21min（thinking 顶满 max_tokens 触发整批重试），正常静默可很长；
 * 但进程崩溃/孤儿化（实测出现过：sift 死、claude 孤儿、close 不来）会让流永远挂着。
 * SILENCE_KILL_MS（默认 12min）内无任何 stdout 输出 → 判定挂死，SIGKILL + error 事件收尾。
 */
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { AuditLayerInfo } from "@/lib/sift-audit-types"
import { logError, logInfo, logWarn } from "@/lib/logger"

export interface SiftEvent {
  stage: "progress" | "result" | "error"
  percent?: number
  msg?: string
  report?: unknown
  _html?: string
  /** root 组合声明的层信息（规程/计划），随 result 事件回传供前端 finding 分层徽章。 */
  _layers?: AuditLayerInfo[]
}

/** 5 个有 LLM 调用的阶段（output 类 PROGRAMMATIC 瞬间完成不跟踪）。 */
type StageKey = "精筛" | "headline" | "条件性" | "禁令" | "步骤"
const STAGES: StageKey[] = ["精筛", "headline", "条件性", "禁令", "步骤"]
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

/** 看门狗：连续静默超过此时长（无 stdout 行）→ 判挂死杀进程。LLM 单批实测可达 21min，
 * 取 12min：比正常最慢批次略宽，又能比 30min 硬超时更早暴露孤儿/死进程。 */
export const SILENCE_KILL_MS = 12 * 60 * 1000

interface StageState {
  done: boolean
  k: number
  total: number
}

/**
 * 全局批计数进度：
 * - 预处理（精筛 + headline）：0% → 15%
 * - 判定（3 类 LLM 合并计数）：15% → 95%，完成批数/总批数 = sum(各 stage.k)/sum(各 stage.total)
 *   （未见过 total 的类贡献 0/0，不虚增分母；类完成〔done〕按满贡献计）
 * - 多 slice（--kind skill 切片）：**跨 slice 累计批数**（不按 slice 数均分预支——slice 大小
 *   悬殊〔实测 10KB vs 89KB〕时均分严重失真；总批数在后续 slice 输出批号时自然增长，
 *   进度可能小幅回落，比虚假高位更诚实）。新 slice 开始时重置上一 slice 的 done/k/total
 *   （auditor 对每 slice 独立跑三类），由 handleLine 的 transcript 切换检测完成。
 * - 95→100% 留给 close 时读报告/发 result，无静默段。
 */
export function computePercent(
  stages: Record<StageKey, StageState>,
  started: boolean,
  transcriptK: number,
  transcriptTotal: number,
): number {
  if (!started) return 0
  void transcriptK
  void transcriptTotal

  const refinePct = stageProgress(stages["精筛"]) * 0.5
  const headlinePct = stageProgress(stages["headline"]) * 0.5
  const preprocessPct = (refinePct + headlinePct) * 15

  // 判定段：全局批计数（步骤/禁令/条件性合并）——步骤类批多（实测 24/30），曾按类平均
  // 会让快类完成后进度僵在高位、慢类独自推进时百分点几乎不动（"卡 95%"的观感来源）
  let doneBatches = 0
  let totalBatches = 0
  for (const key of ["条件性", "禁令", "步骤"] as const) {
    const s = stages[key]
    if (s.done || s.total > 0) {
      doneBatches += s.done ? s.total : s.k
      totalBatches += s.total
    }
  }
  const judgeFrac = totalBatches > 0 ? doneBatches / totalBatches : 0

  const pct = Math.round(preprocessPct + 15 + judgeFrac * 80)
  // 判定全部完成（含 3 类 done 且 transcript 走到最后一个）→ 允许到 95 上限；读报告段由 result=100 收尾
  return Math.min(Math.max(pct, started ? 3 : 0), 95)
}

function stageProgress(s: StageState): number {
  if (s.done) return 1
  return s.total > 0 ? s.k / s.total : 0
}

function runSiftAuditStreaming(opts: {
  args: string[]
  outputDir: string
  onEvent: (e: SiftEvent) => void
  timeoutMs?: number
  silenceKillMs?: number
  layers?: AuditLayerInfo[]
}): Promise<void> {
  const { args, outputDir, onEvent, layers, timeoutMs = 1_800_000, silenceKillMs = SILENCE_KILL_MS } = opts
  return new Promise<void>((resolve) => {
    const stages: Record<StageKey, StageState> = {
      "精筛": { done: false, k: 0, total: 0 },
      "headline": { done: false, k: 0, total: 0 },
      "条件性": { done: false, k: 0, total: 0 },
      "禁令": { done: false, k: 0, total: 0 },
      "步骤": { done: false, k: 0, total: 0 },
    }
    let started = false
    let transcriptK = 1
    let transcriptTotal = 1
    let lastProgressMsg = ""
    let settled = false
    // 前置声明（finish/resetSilenceTimer 引用，赋值在 spawn 之后）
    const timerRef: { t?: ReturnType<typeof setTimeout> } = {}
    let silenceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timerRef.t)
      clearTimeout(silenceTimer)
      resolve()
    }

    function handleLine(raw: string): void {
      const line = raw.replace(ANSI_RE, "").replace(/\r/g, "").trim()
      if (!line) return
      started = true
      lastProgressMsg = line
      // 看门狗喂狗：sift 还在输出（哪怕只是重试提示）就不算挂死
      resetSilenceTimer()

      // transcript k/N（多 slice 进度）：新 slice 开始时重置 3 类判定状态——auditor.py
      // 对每个 transcript 独立跑三类判定（"对账 transcript 2/2" 后各类重新批 1/N），
      // 残留上一 slice 的 done 会让全局批计数虚满（旧 bug：slice 2 一上来就 95%）。
      // 判定段本身跨 slice 累计（见 computePercent 注释），不按 slice 数预支。
      // 精筛/headline 是 per-skill 的（跨 transcript 只跑一次），不重置。
      const tm = line.match(/对账 transcript\s+(\d+)\/(\d+)/)
      if (tm) {
        const newK = parseInt(tm[1], 10)
        if (newK !== transcriptK || parseInt(tm[2], 10) !== transcriptTotal) {
          stages["条件性"] = { done: false, k: 0, total: 0 }
          stages["禁令"] = { done: false, k: 0, total: 0 }
          stages["步骤"] = { done: false, k: 0, total: 0 }
        }
        transcriptK = newK
        transcriptTotal = parseInt(tm[2], 10)
      }

      // [label] 批 k/total — 统一解析 5 个阶段
      const bm = line.match(/\[(精筛|headline|条件性|禁令|步骤)\][^\n]*?批\s*(\d+)\/(\d+)/)
      if (bm) {
        const stage = bm[1] as StageKey
        stages[stage].k = parseInt(bm[2], 10)
        stages[stage].total = parseInt(bm[3], 10)
      }
      // 完成检测（精确匹配 "完成 ⏱" 避免误匹配"未完成"）
      for (const s of STAGES) {
        if (line.includes(`[${s}]`) && line.includes("完成")) stages[s].done = true
      }
      // 精筛的旧式完成信号（缓存 hit 时不输出批次，只输出滤除/无候选）
      if (line.includes("精筛") && (line.includes("滤除") || line.includes("无候选") || line.includes("完成"))) {
        stages["精筛"].done = true
      }

      onEvent({ stage: "progress", percent: computePercent(stages, started, transcriptK, transcriptTotal), msg: line })
    }

    const t0 = Date.now()
    logInfo("sift", "audit start", { kind: args.includes("--kind") ? (args[args.indexOf("--kind") + 1] ?? "") : "", outputDir })
    let proc: ChildProcess
    try {
      proc = spawn("sift", args, {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (e: unknown) {
      onEvent({ stage: "error", msg: e instanceof Error ? e.message : String(e) })
      resolve()
      return
    }

    let stdoutBuf = ""
    let stderrBuf = ""
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8")
      const lines = stdoutBuf.split(/\n/)
      stdoutBuf = lines.pop() ?? ""
      for (const l of lines) handleLine(l)
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8")
    })

    timerRef.t = setTimeout(() => {
      try {
        proc.kill("SIGKILL"); logWarn("sift", "静默超时击杀", { ms: Date.now() - t0 })
      } catch {
        /* ignore */
      }
      onEvent({
        stage: "error",
        msg: `sift audit 超过 ${Math.round(timeoutMs / 60000)} 分钟总时限，已终止（LLM 判定批次过慢，可减小声明规模后重跑）。`,
      })
      finish()
    }, timeoutMs)

    // 静默看门狗：每次 stdout 输出重置；连续静默超 silenceKillMs → 判挂死。
    // LLM 单批实测可达 21min（thinking 顶满 max_tokens 整批重试），静默阈值须比单批
    // 慢尾更宽才不误杀——默认 SILENCE_KILL_MS=12min 对慢批会误杀？
    // 不会：单批执行期间每 40s~257s 有 "判定 N 条…" / "重试 k/4…" 输出持续喂狗，
    // 真正的静默只出现在进程死亡（close 丢失）或 LLM 彻底无响应。
    function resetSilenceTimer(): void {
      clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => {
        if (settled) return
        try {
          proc.kill("SIGKILL"); logWarn("sift", "静默超时击杀（兜底）", { ms: Date.now() - t0 })
        } catch {
          /* ignore */
        }
        onEvent({
          stage: "error",
          msg: `sift audit 已 ${Math.round(silenceKillMs / 60000)} 分钟无任何输出，判定挂死（进程崩溃或 LLM 无响应），已终止。最后输出：${(lastProgressMsg || "(无)").slice(0, 200)}`,
        })
        finish()
      }, silenceKillMs)
    }
    resetSilenceTimer()

    proc.on("error", (e: Error & { code?: string }) => {
      if (settled) { resolve(); return }
      settled = true
      clearTimeout(timerRef.t)
      clearTimeout(silenceTimer)
      if (e.code === "ENOENT") {
        logError("sift", "sift 未找到（不在 PATH）", { ms: Date.now() - t0 })
        onEvent({ stage: "error", msg: "sift 未找到：装好 sift 并确保 `sift` 在 PATH。" })
      } else {
        logError("sift", "spawn 失败", { error: e.message, ms: Date.now() - t0 })
        onEvent({ stage: "error", msg: e.message })
      }
      resolve()
    })

    proc.on("close", (code: number | null) => {
      if (settled) { resolve(); return }
      settled = true
      clearTimeout(timerRef.t)
      clearTimeout(silenceTimer)
      if (stdoutBuf) handleLine(stdoutBuf)
      if (code !== 0) {
        const tail = stderrBuf.trim().slice(-500)
        logError("sift", "audit 失败", { code: code ?? null, tail: tail.slice(0, 300), ms: Date.now() - t0 })
        onEvent({
          stage: "error",
          msg: `sift audit 失败${code != null ? ` (exit ${code})` : ""}${tail ? `: ${tail}` : ""}`,
        })
        resolve()
        return
      }
      const reportPath = path.join(outputDir, "audit-report.json")
      if (!fs.existsSync(reportPath)) {
        logError("sift", "跑完但报告缺失", { reportPath, ms: Date.now() - t0 })
        onEvent({ stage: "error", msg: "sift 跑完但没产出 audit-report.json。" })
        resolve()
        return
      }
      let report: unknown
      try {
        report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
      } catch (e: unknown) {
        logError("sift", "报告解析失败", { error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 })
        onEvent({ stage: "error", msg: `audit-report.json 解析失败：${e instanceof Error ? e.message : String(e)}` })
        resolve()
        return
      }
      const htmlPath = path.join(outputDir, "audit-report.html")
      const _html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : undefined
      logInfo("sift", "audit done", { ms: Date.now() - t0 })
      onEvent({ stage: "result", percent: 100, report, _html, _layers: layers })
      resolve()
    })
  })
}

/**
 * 把一次 sift audit 跑成 NDJSON 流式 Response（progress → result/error）。
 * 路由 prep 好 args + outputDir 后调用本函数返回给前端。
 * cleanup 在流结束（无论成功/失败）后调用——tmp 目录的清理必须等流消费完（sift 跑完），
 * 不能在路由 return 时就删（否则 sift 还没读到 SKILL.md/session.json）。
 * extras._layers：root 组合声明的层信息，随 result 事件一并回传（前端 finding 归层徽章）。
 */
export function makeStreamingAuditResponse(
  args: string[],
  outputDir: string,
  cleanup?: () => void,
  extras?: { _layers?: AuditLayerInfo[] },
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: SiftEvent): void => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
      }
      try {
        await runSiftAuditStreaming({ args, outputDir, onEvent: send, layers: extras?._layers })
      } catch (e: unknown) {
        send({ stage: "error", msg: e instanceof Error ? e.message : String(e) })
      } finally {
        try {
          cleanup?.()
        } catch {
          /* cleanup 失败忽略 */
        }
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
