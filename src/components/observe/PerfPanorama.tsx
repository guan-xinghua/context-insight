"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useEffect, useMemo, useState } from "react"
import {
  PerfTopTable, PerfBenchmarkChart,
  type SubagentStat, type TurnPerf, type BridgePerf,
} from "./perf-shared"

interface ExecItem {
  executionId: string
  agentName: string | null
  isSubagent: boolean
  subagentName: string | null
  agentSessionId: string | null
  depth: number
  tokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  cost: number
  latencyMs: number
  toolCallCount: number
  toolCallErrorCount: number
  llmCallCount: number
  model: string | null
  createdAt: string
}

interface Props {
  taskId: string
  framework?: string
  onJumpToTurn?: (turn: number) => void
  onJumpToSubagent?: (agentSessionId: string) => void
}

interface PerfModel {
  sub: ExecItem[]
  slices: number[]
  totalTokens: number
  totalInput: number
  totalOutput: number
  totalReasoning: number
  totalCacheRead: number
  totalCacheWrite: number
  totalCompute: number
  totalWall: number
  totalLlmCapped: number
  totalNonLlm: number
  totalLlm: number
  totalTools: number
  totalToolErr: number
  totalCost: number
  cacheRatio: number
  agentStats: [string, { count: number; tokens: number; ms: number; llm: number; tools: number }][]
  t0: number
}

// ── Color scheme (fixed per agent / token kind, never changes with rank) ──────
const AGENT_COLORS: Record<string, string> = {
  developer: "#4E79A7",
  verifier: "#76B7B2",
  "state-generator": "#B07AA1",
  "req-analyst": "#F28E2B",
  "req-verifier": "#FFBE7D",
  "spec-generator": "#59A14F",
  "spec-verifier": "#8CD17D",
  designer: "#E15759",
  "design-verifier": "#FF9D9A",
  "design-task-generator": "#D37295",
  "find-proto": "#FABFD2",
  "opdef-developer": "#B6992D",
  "blackbox-designer": "#499894",
  "st-verifier": "#86BCB6",
  "task-generator": "#9D7660",
  "tiling-developer": "#D4A6C8",
  "kernel-developer": "#79706E",
}
const DEFAULT_AGENT_COLOR = "#CCCCCC"
const TOKEN_COLORS = {
  input: "#4E79A7",
  cacheRead: "#A0CBE8",
  cacheWrite: "#F1CE63",
  output: "#59A14F",
}
const C = {
  axis: "#94a3b8",
  grid: "#e2e8f0",
  text: "#475569",
  dur: "#4E79A7",
  tok: "#59A14F",
  danger: "#dc2626",
}

function agentColor(name: string | null) {
  return AGENT_COLORS[name ?? ""] ?? DEFAULT_AGENT_COLOR
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtMs(ms: number): string {
  if (ms <= 0) return "0s"
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  if (m < 60) return `${m}m${rem.toString().padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  return `${h}h${(m % 60).toString().padStart(2, "0")}m`
}
function fmtTok(n: number): string {
  if (n === 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}
function fmtOffset(base: number, ts: string): string {
  const t = new Date(ts).getTime()
  if (!base || !t) return "—"
  const d = Math.max(0, Math.floor((t - base) / 1000))
  const h = Math.floor(d / 3600)
  const m = Math.floor((d % 3600) / 60)
  const s = d % 60
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
}

// ── 横轴 agent 名宽度:拉丁 1 / CJK 2 计单位;- 与空格后断行,≤2 行,超宽 … ────
const AXIS_NAME_MAX_UNITS = 12
const AXIS_NAME_MAX_LINES = 2

function textUnits(s: string): number {
  let u = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    u += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) ? 2 : 1
  }
  return u
}

function truncateUnits(s: string, maxUnits: number): string {
  if (textUnits(s) <= maxUnits) return s
  const chars = [...s]
  let u = 0
  let cut = 0
  for (let i = 0; i < chars.length; i++) {
    const cu = textUnits(chars[i])
    if (u + cu > maxUnits - 1) break
    u += cu
    cut = i + 1
  }
  return chars.slice(0, cut).join("") + "…"
}

function wrapAxisName(name: string): string[] {
  const pieces = name.split(/(?<=[- ])/)
  const lines: string[] = []
  let cur = ""
  for (const p of pieces) {
    if (cur && textUnits(cur + p) > AXIS_NAME_MAX_UNITS) {
      lines.push(cur)
      cur = p
    } else {
      cur += p
    }
  }
  if (cur) lines.push(cur)
  const out = lines.slice(0, AXIS_NAME_MAX_LINES).map(l => truncateUnits(l, AXIS_NAME_MAX_UNITS))
  if (lines.length > AXIS_NAME_MAX_LINES) {
    const t = truncateUnits(out[out.length - 1], AXIS_NAME_MAX_UNITS - 1)
    out[out.length - 1] = t.endsWith("…") ? t : `${t}…`
  }
  return out
}

// ── Wall-clock timeline slices: each task owns start→next-start ───────────────
function computeWallSlices(subtasks: ExecItem[]): number[] {
  const starts = subtasks.map(r => new Date(r.createdAt).getTime())
  const slices: number[] = []
  for (let i = 0; i < subtasks.length; i++) {
    if (i < subtasks.length - 1 && starts[i] && starts[i + 1]) {
      slices.push(Math.max(0, starts[i + 1] - starts[i]))
    } else {
      slices.push(subtasks[i].latencyMs)
    }
  }
  return slices
}

export function PerfPanorama({ taskId, framework, onJumpToTurn, onJumpToSubagent }: Props) {
  const [items, setItems] = useState<ExecItem[] | null>(null)
  const [turns, setTurns] = useState<TurnPerf[] | null>(null)
  const [bridges, setBridges] = useState<BridgePerf[]>([])
  const [loading, setLoading] = useState(true)
  const [includeRoot, setIncludeRoot] = useState(false)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ taskId })
    if (framework) params.set("framework", framework)
    Promise.all([
      fetch(`/api/observe/executions?${params}`).then(r => r.json()),
      fetch(`/api/observe/session/turns?${params}`).then(r => r.json()),
      fetch(`/api/observe/session/bridges?${params}`).then(r => r.json()),
    ])
      .then(([execData, turnsData, bridgesData]) => {
        if (cancelled) return
        setItems(execData.items ?? [])
        setTurns(turnsData.items ?? [])
        setBridges(bridgesData.items ?? [])
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setItems(null)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [taskId, framework])

  // perf top + 性能效率:per-subagent stats + per-root-turn TPS/TPOT series,
  // ported from PerfPanorama (turn-level, independent of execution wall-slice math).
  const perfTop = useMemo<{ subagents: SubagentStat[]; perfSeries: { turnIndex: number; createdAt: string | null; tpot: number; tps: number }[] }>(() => {
    if (!turns || turns.length === 0) return { subagents: [], perfSeries: [] }
    const rootTurns = turns.filter(t => !t.isSubagent)
    const subTurns = turns.filter(t => t.isSubagent)
    const bridgeBySession = new Map(bridges.map(b => [b.subagentSessionId ?? "", b]))
    const m = new Map<string, SubagentStat>()
    for (const t of subTurns) {
      const sid = t.subagentSessionId ?? "unknown"
      const ex = m.get(sid) ?? {
        sessionId: sid, name: t.subagentName ?? "unknown", taskDescription: null, turns: [],
        totalMs: 0, totalTokens: 0, totalGenTokens: 0, tps: 0,
        cacheRead: 0, inputTokens: 0, cacheHitRate: 0,
      } as SubagentStat
      ex.turns.push(t)
      ex.totalMs += t.latencyMs
      ex.totalTokens += t.totalTokens
      ex.totalGenTokens += (t.outputTokens ?? 0) + (t.reasoningTokens ?? 0)
      ex.cacheRead += t.cacheReadTokens
      ex.inputTokens += t.inputTokens
      m.set(sid, ex)
    }
    for (const s of m.values()) {
      const bridge = bridgeBySession.get(s.sessionId)
      const dc = bridge?.dispatchContent
      if (dc) {
        const cleaned = dc.replace(/[\n\r]+/g, " ").trim()
        s.taskDescription = cleaned.length > 50 ? cleaned.slice(0, 49) + "…" : cleaned
      }
      s.cacheHitRate = s.cacheRead + s.inputTokens > 0 ? (s.cacheRead / (s.cacheRead + s.inputTokens)) * 100 : 0
      s.tps = s.totalMs > 0 ? s.totalGenTokens / (s.totalMs / 1000) : 0
    }
    const subagents = [...m.values()]

    const dispatchTurnIds = new Set(bridges.map(b => b.dispatchTurnId).filter(Boolean) as string[])
    const perfSeries = rootTurns
      .filter(t => t.latencyMs > 0 && t.agentName !== "compaction" && t.agentName !== "continuation" && !dispatchTurnIds.has(t.turnId))
      .map(t => {
        const gen = (t.outputTokens ?? 0) + (t.reasoningTokens ?? 0)
        const tpot = gen > 0 ? t.latencyMs / gen : 0
        const tps = t.latencyMs > 0 ? gen / (t.latencyMs / 1000) : 0
        return { turnIndex: t.turnIndex, createdAt: t.createdAt, tpot, tps }
      })
    return { subagents, perfSeries }
  }, [turns, bridges])

  const model = useMemo<PerfModel | null>(() => {
    if (!items || items.length === 0) return null
    const sub = items
      .filter(r => includeRoot ? true : r.isSubagent)
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    if (sub.length === 0) return null
    const slices = computeWallSlices(sub)
    const totalTokens = sub.reduce((s, r) => s + r.tokens, 0)
    const totalInput = sub.reduce((s, r) => s + r.inputTokens, 0)
    const totalOutput = sub.reduce((s, r) => s + r.outputTokens, 0)
    const totalReasoning = sub.reduce((s, r) => s + r.reasoningTokens, 0)
    const totalCacheRead = sub.reduce((s, r) => s + r.cacheReadInputTokens, 0)
    const totalCacheWrite = sub.reduce((s, r) => s + r.cacheCreationInputTokens, 0)
    const totalCompute = sub.reduce((s, r) => s + r.latencyMs, 0)
    const totalWall = slices.reduce((s, x) => s + x, 0)
    // 逐任务钳制:LLM 耗时 = Σ min(latency, slice);LLM 外 = 总 - LLM。处处闭合。
    const totalLlmCapped = sub.reduce((s, r, i) => s + Math.min(r.latencyMs, slices[i]), 0)
    const totalNonLlm = Math.max(0, totalWall - totalLlmCapped)
    const totalLlm = sub.reduce((s, r) => s + r.llmCallCount, 0)
    const totalTools = sub.reduce((s, r) => s + r.toolCallCount, 0)
    const totalToolErr = sub.reduce((s, r) => s + r.toolCallErrorCount, 0)
    const totalCost = sub.reduce((s, r) => s + (r.cost || 0), 0)
    const cacheRatio = totalTokens > 0 ? ((totalCacheRead + totalCacheWrite) / totalTokens) * 100 : 0

    const agentMap = new Map<string, { count: number; tokens: number; ms: number; llm: number; tools: number }>()
    for (const r of sub) {
      const k = r.agentName ?? "—"
      const a = agentMap.get(k) ?? { count: 0, tokens: 0, ms: 0, llm: 0, tools: 0 }
      a.count++; a.tokens += r.tokens; a.ms += r.latencyMs; a.llm += r.llmCallCount; a.tools += r.toolCallCount
      agentMap.set(k, a)
    }
    const agentStats = [...agentMap.entries()].sort((a, b) => b[1].tokens - a[1].tokens)

    return {
      sub, slices,
      totalTokens, totalInput, totalOutput, totalReasoning, totalCacheRead, totalCacheWrite,
      totalCompute, totalWall, totalLlmCapped, totalNonLlm,
      totalLlm, totalTools, totalToolErr, totalCost, cacheRatio,
      agentStats, t0: new Date(sub[0].createdAt).getTime(),
    }
  }, [items, includeRoot])

  if (loading) {
    return <div className="rounded-lg border bg-card p-4 text-xs text-muted-foreground">加载中…</div>
  }
  if (!model) {
    return (
      <div className="rounded-lg border bg-card p-4 text-xs text-muted-foreground space-y-1">
        <div>暂无子代理 execution 数据</div>
        <button
          className="text-blue-600 dark:text-blue-400 underline cursor-pointer"
          onClick={() => setIncludeRoot(true)}
        >
          勾选「含 root」查看主 agent 性能数据 →
        </button>
      </div>
    )
  }

  const cards = [
    { label: "总耗时", value: fmtMs(model.totalWall), color: "text-rose-600", sub: `${model.sub.length} 子任务 · start→next` },
    { label: "LLM 耗时", value: fmtMs(model.totalLlmCapped), color: "text-indigo-600", sub: `${model.totalLlm} 次 · Σ min(lat,slice)` },
    { label: "LLM 外耗时", value: fmtMs(model.totalNonLlm), color: "text-amber-600", sub: `总-LLM · ${model.totalWall > 0 ? (model.totalNonLlm / model.totalWall * 100).toFixed(0) : 0}%` },
    { label: "总 Tokens", value: fmtTok(model.totalTokens), color: "text-blue-600", sub: `工具 ${model.totalTools} (错 ${model.totalToolErr})` },
    { label: "Cache 比率", value: `${model.cacheRatio.toFixed(1)}%`, color: "text-emerald-600", sub: `读+写 / 总量` },
    { label: "总成本", value: model.totalCost > 0 ? `$${model.totalCost.toFixed(4)}` : "—", color: "", sub: "USD" },
  ]

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5">
        <h3 className="font-semibold text-sm">overview</h3>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={includeRoot} onChange={e => setIncludeRoot(e.target.checked)} className="size-3" />
          含 root
        </label>
      </div>

      <div className="p-4 pt-0 space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            {cards.map(c => (
              <div key={c.label} className="rounded border p-1.5 leading-tight">
                <div className="text-xs text-muted-foreground">{c.label}</div>
                <div className={`font-semibold text-base ${c.color}`}>{c.value}</div>
                <div className="text-[10px] text-muted-foreground">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* Token decomposition bar */}
          <TokenBar
            input={model.totalInput}
            cacheRead={model.totalCacheRead}
            cacheWrite={model.totalCacheWrite}
            output={model.totalOutput}
            reasoning={model.totalReasoning}
          />

          {/* duration + token charts */}
          <TripleChart model={model} onJumpToSubagent={onJumpToSubagent} />

          {/* perf top — 子代理 Top 排序表(自 PerfPanorama) */}
          {perfTop.subagents.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-muted-foreground mb-1.5">Perf TopDown</h4>
              <PerfTopTable subagents={perfTop.subagents} onJumpToTurn={onJumpToTurn} />
            </div>
          )}

          {/* 性能效率 — per-root-turn TPS / TPOT(自 PerfPanorama) */}
          {perfTop.perfSeries.length > 1 && (
            <div>
              <h4 className="text-sm font-semibold text-muted-foreground mb-1.5">性能效率</h4>
              <PerfBenchmarkChart points={perfTop.perfSeries} onJumpToTurn={onJumpToTurn} />
            </div>
          )}

          {/* Agent type breakdown */}
          <AgentTable agentStats={model.agentStats} totalTokens={model.totalTokens} totalCompute={model.totalCompute} totalLlm={model.totalLlm} totalTools={model.totalTools} />

          {/* Task detail */}
          <TaskDetail model={model} />
        </div>
    </div>
  )
}

// ── Token decomposition stacked bar ──────────────────────────────────────────
function TokenBar({ input, cacheRead, cacheWrite, output, reasoning }: {
  input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number
}) {
  const total = input + cacheRead + cacheWrite + output + reasoning || 1
  const segs = [
    { label: "Input (fresh)", v: input, c: TOKEN_COLORS.input },
    { label: "Cache Read", v: cacheRead, c: TOKEN_COLORS.cacheRead },
    { label: "Cache Write", v: cacheWrite, c: TOKEN_COLORS.cacheWrite },
    { label: "Output", v: output, c: TOKEN_COLORS.output },
    { label: "Reasoning", v: reasoning, c: "#8b5cf6" },
  ]
  return (
    <div>
      <div className="flex h-6 w-full rounded overflow-hidden border">
        {segs.map(s => s.v > 0 && (
          <div key={s.label} style={{ width: `${(s.v / total) * 100}%`, background: s.c }} className="h-full" title={`${s.label}: ${fmtTok(s.v)} (${(s.v / total * 100).toFixed(1)}%)`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
        {segs.map(s => (
          <span key={s.label} className="flex items-center gap-1.5 text-[10px]">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.c }} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-semibold tabular-nums">{fmtTok(s.v)}</span>
            <span className="text-muted-foreground">({(s.v / total * 100).toFixed(1)}%)</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ── 横轴标签:#N(与 Task Detail 交叉引用)+ agent 名(按 agent 固定色,≤2 行) ──
function AxisLabels({ sub, x, barW, baseY, onJumpToSubagent, keyPrefix }: {
  sub: ExecItem[]
  x: (i: number) => number
  barW: number
  baseY: number
  onJumpToSubagent?: (agentSessionId: string) => void
  keyPrefix: string
}) {
  return (
    <>
      {sub.map((r, i) => {
        const jump = onJumpToSubagent && r.agentSessionId
          ? () => onJumpToSubagent(r.agentSessionId!)
          : undefined
        const name = r.subagentName ?? r.agentName ?? "—"
        return (
          <g key={`${keyPrefix}${i}`} onClick={jump} style={jump ? { cursor: "pointer" } : undefined}>
            <title>{`#${i + 1} ${name}（${r.agentName ?? "?"}）— 点击跳转 Turns`}</title>
            <text x={x(i) + barW / 2} y={baseY + 18} textAnchor="middle" fontSize="8" className="fill-muted-foreground">{`#${i + 1}`}</text>
            {wrapAxisName(name).map((ln, li) => (
              <text key={li} x={x(i) + barW / 2} y={baseY + 30 + li * 9} textAnchor="middle" fontSize="8" fontWeight="600" fill={agentColor(r.agentName)}>{ln}</text>
            ))}
          </g>
        )
      })}
    </>
  )
}

// ── charts: task duration (stacked 总耗时=LLM+LLM外) + stacked tokens ───────
function TripleChart({ model, onJumpToSubagent }: { model: PerfModel; onJumpToSubagent?: (agentSessionId: string) => void }) {
  const { sub, slices } = model
  const n = sub.length

  // 列距留足横轴 agent 名(≤2 行)空间,避免相邻标签重叠
  const barW = 30
  const gap = 28
  const padL = 44, padR = 12, padT = 16, padB = 48
  const W = Math.max(600, padL + padR + n * (barW + gap))
  const chartH = 180
  // Panel 1 + Panel 2 share one SVG; height must cover both (Panel 2 is
  // translated below Panel 1, so it was being clipped when height == p1H only).
  const p1H = padT + chartH + padB
  const p2PadT = 16, p2PadB = 48
  const p2H = p2PadT + chartH + p2PadB

  // 总耗时(wall) = start→next 切片; LLM 耗时 = min(latency, wall)(逐任务钳制); LLM 外 = 总-LLM
  const wall = slices.map(ms => ms / 1000)
  const llm = sub.map((r, i) => Math.min(r.latencyMs, slices[i]) / 1000)
  const nonLlm = sub.map((_, i) => Math.max(0, wall[i] - llm[i]))

  const tokIn = sub.map(r => r.inputTokens)
  const tokCr = sub.map(r => r.cacheReadInputTokens)
  const tokCw = sub.map(r => r.cacheCreationInputTokens)
  const tokOut = sub.map(r => r.outputTokens)
  const tokTot = sub.map(r => r.tokens)

  const dmax = Math.max(...wall, 1)
  const tmax = Math.max(...tokTot, 1)

  const x = (i: number) => padL + i * (barW + gap) + gap / 2
  const yDur = (v: number) => padT + chartH - (v / dmax) * chartH

  const DUR_LLM = "#6366f1"      // LLM 耗时
  const DUR_NONLLM = "#f59e0b"   // LLM 外耗时

  return (
    <div className="space-y-4">
      {/* Task Duration chart — 总耗时 = LLM 耗时 + LLM 外耗时 (stacked) */}
      <div className="rounded border p-3 bg-muted/5">
        <div className="flex items-center gap-4 mb-1.5">
          <h4 className="text-sm font-semibold text-muted-foreground">Task Duration</h4>
          {/* legend 放卡片头右上(HTML):不占 svg 底部,避免与横轴 agent 名冲突;宽图滚动时也始终可见 */}
          <div className="ml-auto flex items-center gap-3">
            {[
              { l: "LLM 耗时", c: DUR_LLM },
              { l: "LLM 外耗时", c: DUR_NONLLM },
            ].map(s => (
              <span key={s.l} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.c }} />
                {s.l}
              </span>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${p1H}`} width={W} height={p1H} className="block" style={{ minWidth: "100%" }}>
            {[0, 0.25, 0.5, 0.75, 1].map(f => {
              const v = dmax * f
              const y = padT + chartH - f * chartH
              return (
                <g key={f}>
                  <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={C.grid} strokeWidth={0.5} />
                  <text x={padL - 4} y={y + 3} textAnchor="end" fontSize="9" className="fill-muted-foreground">{fmtMs(v * 1000)}</text>
                </g>
              )
            })}
            {sub.map((r, i) => {
              const topY = yDur(wall[i])
              const llmH = (llm[i] / dmax) * chartH
              const nonLlmH = (nonLlm[i] / dmax) * chartH
              const jump = onJumpToSubagent && r.agentSessionId
                ? () => onJumpToSubagent(r.agentSessionId!)
                : undefined
              return (
                <g key={`d${i}`} onClick={jump} style={jump ? { cursor: "pointer" } : undefined}>
                  <title>{`#${i + 1} ${r.subagentName ?? r.agentName ?? "?"}（${r.agentName ?? "?"}）\n总耗时 ${fmtMs(wall[i] * 1000)} · tokens ${fmtTok(tokTot[i])}\n点击跳转 Turns 定位该 subagent`}</title>
                  <rect x={x(i)} y={padT + chartH - llmH} width={barW} height={llmH} fill={DUR_LLM} />
                  {nonLlm[i] > 0 && (
                    <rect x={x(i)} y={topY} width={barW} height={nonLlmH} fill={DUR_NONLLM} />
                  )}
                  {wall[i] >= dmax * 0.06 && (
                    <text x={x(i) + barW / 2} y={topY - 3} textAnchor="middle" fontSize="8" fontWeight="700" className="fill-foreground">
                      {wall[i] >= 60 ? `${(wall[i] / 60).toFixed(1)}m` : `${wall[i].toFixed(0)}s`}
                    </text>
                  )}
                </g>
              )
            })}
            <AxisLabels sub={sub} x={x} barW={barW} baseY={padT + chartH} onJumpToSubagent={onJumpToSubagent} keyPrefix="dl" />
          </svg>
        </div>
      </div>

      {/* Token consumption chart (stacked) */}
      <div className="rounded border p-3 bg-muted/5">
        <div className="flex items-center gap-4 mb-1.5">
          <h4 className="text-sm font-semibold text-muted-foreground">Token consumption</h4>
          <div className="ml-auto flex items-center gap-3">
            {[
              { l: "Input", c: TOKEN_COLORS.input },
              { l: "Cache Read", c: TOKEN_COLORS.cacheRead },
              { l: "Cache Write", c: TOKEN_COLORS.cacheWrite },
              { l: "Output", c: TOKEN_COLORS.output },
            ].map(s => (
              <span key={s.l} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.c }} />
                {s.l}
              </span>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${p2H}`} width={W} height={p2H} className="block" style={{ minWidth: "100%" }}>
            {(() => {
              const tpadT = 16
              const baseY = tpadT + chartH
              const yT = (v: number) => tpadT + chartH - (v / tmax) * chartH
              return (
                <>
                  {[0, 0.25, 0.5, 0.75, 1].map(f => {
                    const v = tmax * f
                    const y = baseY - f * chartH
                    return (
                      <g key={f}>
                        <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={C.grid} strokeWidth={0.5} />
                        <text x={padL - 4} y={y + 3} textAnchor="end" fontSize="9" className="fill-muted-foreground">{fmtTok(v)}</text>
                      </g>
                    )
                  })}
                  {sub.map((r, i) => {
                    const inH = (tokIn[i] / tmax) * chartH
                    const crH = (tokCr[i] / tmax) * chartH
                    const cwH = (tokCw[i] / tmax) * chartH
                    const outH = (tokOut[i] / tmax) * chartH
                    const xs = x(i)
                    const jump = onJumpToSubagent && r.agentSessionId
                      ? () => onJumpToSubagent(r.agentSessionId!)
                      : undefined
                    return (
                      <g key={`t${i}`} onClick={jump} style={jump ? { cursor: "pointer" } : undefined}>
                        <title>{`#${i + 1} ${r.subagentName ?? r.agentName ?? "?"}（${r.agentName ?? "?"}）\ntokens ${fmtTok(tokTot[i])} · 总耗时 ${fmtMs(wall[i] * 1000)}\n点击跳转 Turns 定位该 subagent`}</title>
                        <rect x={xs} y={yT(tokIn[i])} width={barW} height={inH} fill={TOKEN_COLORS.input} />
                        <rect x={xs} y={yT(tokIn[i] + tokCr[i])} width={barW} height={crH} fill={TOKEN_COLORS.cacheRead} />
                        <rect x={xs} y={yT(tokIn[i] + tokCr[i] + tokCw[i])} width={barW} height={cwH} fill={TOKEN_COLORS.cacheWrite} />
                        <rect x={xs} y={yT(tokIn[i] + tokCr[i] + tokCw[i] + tokOut[i])} width={barW} height={outH} fill={TOKEN_COLORS.output} />
                        {tokTot[i] >= tmax * 0.06 && (
                          <text x={xs + barW / 2} y={yT(tokTot[i]) - 3} textAnchor="middle" fontSize="8" fontWeight="700" className="fill-foreground">
                            {fmtTok(tokTot[i])}
                          </text>
                        )}
                      </g>
                    )
                  })}
                  <AxisLabels sub={sub} x={x} barW={barW} baseY={baseY} onJumpToSubagent={onJumpToSubagent} keyPrefix="tlx" />
                </>
              )
            })()}
          </svg>
        </div>
      </div>
    </div>
  )
}

// ── Agent type breakdown ──────────────────────────────────────────────────────
function AgentTable({ agentStats, totalTokens, totalCompute, totalLlm, totalTools }: {
  agentStats: [string, { count: number; tokens: number; ms: number; llm: number; tools: number }][]
  totalTokens: number; totalCompute: number; totalLlm: number; totalTools: number
}) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-muted-foreground mb-1.5">Agent Type Breakdown</h4>
      <div className="text-[10px] text-muted-foreground mb-2">Duration = Σ latencyMs（原始,可超总墙钟——并行/推导爆表所致,非墙钟口径）</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b text-right">
              <th className="text-left py-1.5 px-2 font-medium">Agent</th>
              <th className="py-1.5 px-2 font-medium">Runs</th>
              <th className="py-1.5 px-2 font-medium">Tokens</th>
              <th className="py-1.5 px-2 font-medium">%</th>
              <th className="py-1.5 px-2 font-medium">Duration</th>
              <th className="py-1.5 px-2 font-medium">LLM Calls</th>
              <th className="py-1.5 px-2 font-medium">Tool Calls</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {agentStats.map(([agent, s]) => (
              <tr key={agent} className="border-b border-border/40 hover:bg-muted/20">
                <td className="py-1.5 px-2 text-left">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-middle" style={{ background: agentColor(agent) }} />
                  <code className="text-[11px]">{agent}</code>
                </td>
                <td className="py-1.5 px-2 text-right">{s.count}</td>
                <td className="py-1.5 px-2 text-right">{fmtTok(s.tokens)}</td>
                <td className="py-1.5 px-2 text-right">{(s.tokens / Math.max(totalTokens, 1) * 100).toFixed(1)}%</td>
                <td className="py-1.5 px-2 text-right">{fmtMs(s.ms)}</td>
                <td className="py-1.5 px-2 text-right">{s.llm.toLocaleString()}</td>
                <td className="py-1.5 px-2 text-right">{s.tools.toLocaleString()}</td>
              </tr>
            ))}
            <tr className="font-semibold border-t-2">
              <td className="py-1.5 px-2 text-left">合计</td>
              <td className="py-1.5 px-2 text-right">{agentStats.reduce((a, [, s]) => a + s.count, 0)}</td>
              <td className="py-1.5 px-2 text-right">{fmtTok(totalTokens)}</td>
              <td className="py-1.5 px-2 text-right">100.0%</td>
              <td className="py-1.5 px-2 text-right">{fmtMs(totalCompute)}</td>
              <td className="py-1.5 px-2 text-right">{totalLlm.toLocaleString()}</td>
              <td className="py-1.5 px-2 text-right">{totalTools.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Task detail ───────────────────────────────────────────────────────────────
function TaskDetail({ model }: { model: PerfModel }) {
  const { sub, slices, t0 } = model
  return (
    <div>
      <h4 className="text-sm font-semibold text-muted-foreground mb-1.5">Task Detail</h4>
      <div className="text-[10px] text-muted-foreground mb-2">总耗时 = start→next 切片 · LLM 耗时 = min(latency, slice)（逐任务钳制）· LLM 外 = 总-LLM · Offset = 距首个子任务的相对时间</div>
      <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr className="text-muted-foreground border-b text-right">
              <th className="text-left py-1.5 px-2 font-medium">#</th>
              <th className="text-left py-1.5 px-2 font-medium">Agent</th>
              <th className="py-1.5 px-2 font-medium">+Offset</th>
              <th className="py-1.5 px-2 font-medium">总耗时</th>
              <th className="py-1.5 px-2 font-medium">LLM 耗时</th>
              <th className="py-1.5 px-2 font-medium">LLM 外</th>
              <th className="py-1.5 px-2 font-medium">Tokens</th>
              <th className="py-1.5 px-2 font-medium">In</th>
              <th className="py-1.5 px-2 font-medium">CacheR</th>
              <th className="py-1.5 px-2 font-medium">CacheW</th>
              <th className="py-1.5 px-2 font-medium">Out</th>
              <th className="py-1.5 px-2 font-medium">LLM</th>
              <th className="py-1.5 px-2 font-medium">Tools</th>
              <th className="py-1.5 px-2 font-medium">Err</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {sub.map((r, i) => (
              <tr key={r.executionId} className="border-b border-border/40 hover:bg-muted/20">
                <td className="py-1 px-2 text-left">{i + 1}</td>
                <td className="py-1 px-2 text-left"><code className="text-[10px]">{r.agentName ?? "—"}</code></td>
                <td className="py-1 px-2 text-right text-muted-foreground">{fmtOffset(t0, r.createdAt)}</td>
                <td className="py-1 px-2 text-right font-semibold text-rose-600">{fmtMs(slices[i])}</td>
                <td className="py-1 px-2 text-right text-indigo-600">{fmtMs(Math.min(r.latencyMs, slices[i]))}</td>
                <td className="py-1 px-2 text-right text-amber-600">{fmtMs(Math.max(0, slices[i] - r.latencyMs))}</td>
                <td className="py-1 px-2 text-right">{fmtTok(r.tokens)}</td>
                <td className="py-1 px-2 text-right">{fmtTok(r.inputTokens)}</td>
                <td className="py-1 px-2 text-right">{fmtTok(r.cacheReadInputTokens)}</td>
                <td className="py-1 px-2 text-right">{fmtTok(r.cacheCreationInputTokens)}</td>
                <td className="py-1 px-2 text-right">{fmtTok(r.outputTokens)}</td>
                <td className="py-1 px-2 text-right">{r.llmCallCount}</td>
                <td className="py-1 px-2 text-right">{r.toolCallCount}</td>
                <td className="py-1 px-2 text-right text-red-600">{r.toolCallErrorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// helper hook type alias for prop typing
