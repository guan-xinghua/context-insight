"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useMemo, useState, useCallback, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { clusterActiveSegments } from "@/lib/active-time"

interface AgentItem {
  executionId: string
  agentName: string | null
  agentSessionId: string | null
  isSubagent: boolean
  parentExecutionId: string | null
  tokens: number
  maxSingleCallTokens: number
  cost: number
  toolCallCount: number
  skillLoadCount: number
  model: string | null
  createdAt: string
  latencyMs: number
  // turns 跨度：首条 turn 的 createdAt_ts → 末条 turn 的 completedAt
  // （与 Turns 页签的 subagent 分组同口径，不切段）
  span?: { start: number; end: number } | null
  // 每个 turn 的原始区间（不合并、不截断）：按当前「休眠阈值」前端重聚类成活跃段画深色；
  // span 里其余部分就是休眠，画浅色。
  activeIntervals?: Array<{ start: number; end: number }>
  firstPrompt: string | null
}

interface BridgeItem {
  bridgeId: string
  dispatchExecutionId: string
  dispatchTurnId: string | null
  dispatchToolCallId: string | null
  dispatchContent: string | null
  dispatchTimestamp: string | null
  responseExecutionId: string | null
  responseTurnId: string | null
  responseContent: string | null
  responseTimestamp: string | null
  subagentSessionId: string | null
  subagentType: string | null
  subagentName: string | null
  agentName: string | null
  status: string
  subagentTokens: number
  subagentLatencyMs: number
}

interface AgentCallGraphProps {
  agents: AgentItem[]
  bridges: BridgeItem[]
  onViewTurns?: (agentSessionId: string | null) => void
}

const LANE_LABEL_WIDTH = 109
const SLOT_COUNT = 5
const MIN_ZOOM = 1
const MAX_ZOOM = 64
const ZOOM_FACTOR = 2
const SUB_BAR_H = 12
const SUB_GAP = 3
const MAX_VISIBLE_HEIGHT = 300
// 休眠阈值预设（ms）：单条 turn 最多算多久活跃 + 相邻间隔多大算断开（两者同值）。
// 调档位在前端重聚类，不重新请求；默认 5min 与详情页 Wall Clock 拆分同口径。
const THRESHOLD_PRESETS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]

const AGENT_COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
  "#14b8a6", "#e11d48", "#a855f7", "#22c55e", "#d946ef",
]

const agentColorCache = new Map<string, string>()
let agentColorIdx = 0

function getAgentColor(agentName: string | null): string {
  const key = agentName ?? "root"
  if (agentColorCache.has(key)) return agentColorCache.get(key)!
  agentColorCache.set(key, AGENT_COLORS[agentColorIdx % AGENT_COLORS.length])
  agentColorIdx++
  return agentColorCache.get(key)!
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

function formatTokenCount(n: number): string {
  if (n === 0) return ""
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

function formatTimeAbsolute(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

function computeTickInterval(totalMs: number): number {
  const candidates = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000]
  for (const c of candidates) {
    if (totalMs / c <= 6) return c
  }
  return Math.ceil(totalMs / 6 / 3600000) * 3600000
}

interface LaneDef {
  key: string
  label: string
  color: string
  bg: string
}

const LANE_PATTERNS: Array<{ pattern: RegExp; label: string; color: string; bg: string }> = [
  { pattern: /architect/i, label: "架构", color: "#10b981", bg: "#10b98120" },
  { pattern: /design/i, label: "设计", color: "#f59e0b", bg: "#f59e0b20" },
  { pattern: /review/i, label: "评审", color: "#8b5cf6", bg: "#8b5cf620" },
  { pattern: /test/i, label: "测试", color: "#ef4444", bg: "#ef444420" },
  { pattern: /general/i, label: "通用", color: "#06b6d4", bg: "#06b6d420" },
]

function assignToLane(agent: AgentItem): LaneDef {
  if (!agent.isSubagent) {
    return { key: "command", label: "总控", color: "#3b82f6", bg: "#3b82f620" }
  }
  const name = (agent.agentName ?? "").toLowerCase()
  for (const p of LANE_PATTERNS) {
    if (p.pattern.test(name)) {
      return { key: p.label, label: p.label, color: p.color, bg: p.bg }
    }
  }
  const shortName = agent.agentName ?? "unknown"
  const color = getAgentColor(agent.agentName)
  return { key: shortName, label: shortName, color, bg: `${color}20` }
}

interface TooltipData {
  x: number
  y: number
  label: string
  firstPrompt: string | null
  tokens: number
  maxSingleCallTokens: number
  latencyMs: number
  startTime: string
  endTime: string
  toolCallCount: number
  model: string | null
  lane: string
  status: string
}

export function AgentCallGraph({ agents, bridges, onViewTurns }: AgentCallGraphProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null)
  // 时间轴缩放：1 = 全览（整段会话铺满宽度），越大越细
  const [zoom, setZoom] = useState(1)
  // 休眠阈值（ms）：预设档位切换，前端按它重聚类活跃段（不发请求）。
  const [thresholdMs, setThresholdMs] = useState(THRESHOLD_PRESETS_MS[1])
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevZoomRef = useRef(1)
  const clampZoom = useCallback((z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)), [])

  // 缩放后让「视口中心」停在原来的时间点上，而不是跳回最左
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      const ratio = zoom / prevZoomRef.current
      const center = el.scrollLeft + el.clientWidth / 2
      el.scrollLeft = center * ratio - el.clientWidth / 2
    }
    prevZoomRef.current = zoom
  }, [zoom])

  // Ctrl/⌘ + 滚轮缩放（要用非被动监听，否则 preventDefault 不生效）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setZoom(z => clampZoom(e.deltaY < 0 ? z * ZOOM_FACTOR : z / ZOOM_FACTOR))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [clampZoom])

  const sorted = useMemo(() =>
    [...agents].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [agents]
  )

  // 每个 agent 的活跃段：把后端给的原始 per-turn 区间按当前阈值「截断 + 聚类」。
  // 阈值同时作为 cap（单 turn 最多算多久活跃）与 gap（相邻间隔多大算断开）。
  const segmentsByAgent = useMemo(() => {
    const m = new Map<string, Array<{ start: number; end: number }>>()
    for (const a of agents) {
      const raw = a.activeIntervals ?? []
      const ivs: Array<[number, number]> = raw.map(s => [s.start, Math.min(s.end, s.start + thresholdMs)])
      m.set(a.executionId, clusterActiveSegments(ivs, thresholdMs))
    }
    return m
  }, [agents, thresholdMs])

  const globalStartMs = useMemo(() =>
    agents.length === 0 ? 0 : Math.min(...agents.map(a => new Date(a.createdAt).getTime())),
    [agents]
  )

  // 墙钟跨度 = start→next 切片（与 Perf 柱状图同口径）：execution 从自己开始
  // 到下一个 execution 开始，最后一项用自身 latencyMs 兜底。直接用
  // Execution.latencyMs 是首口径——现场：subagent 跑数分钟、4.8M tokens，
  // 泳道只显示首轮的 5.1s
  const wallMs = useMemo(() => {
    const m = new Map<string, number>()
    for (let i = 0; i < sorted.length; i++) {
      const start = new Date(sorted[i].createdAt).getTime()
      const next = i + 1 < sorted.length ? new Date(sorted[i + 1].createdAt).getTime() : null
      m.set(sorted[i].executionId, next != null ? Math.max(0, next - start) : sorted[i].latencyMs)
    }
    return m
  }, [sorted])

  // 轴右端要把所有真实活跃分段也算进去：光用 createdAt+wallMs 会漏掉主 agent
  // 最后那几段（实测漏 1.5 分钟 → 最后一根条子右端溢出容器 0.03%）。
  const globalEndMs = useMemo(() => {
    if (agents.length === 0) return 1
    let end = Number.NEGATIVE_INFINITY
    for (const a of agents) {
      const w = wallMs.get(a.executionId) ?? a.latencyMs
      end = Math.max(end, new Date(a.createdAt).getTime() + w)
      if (a.span) end = Math.max(end, a.span.end)
    }
    return Number.isFinite(end) ? end : 1
  }, [agents, wallMs])

  const totalDuration = globalEndMs - globalStartMs || 1

  // 刻度密度跟着缩放走：按「当前可视时长」选刻度间隔，放大后刻度才会变细
  const tickInterval = computeTickInterval(totalDuration / zoom)

  const ticks = useMemo(() => {
    const result: Array<{ ms: number; pct: number; label: string }> = []
    for (let ms = 0; ms <= totalDuration; ms += tickInterval) {
      if (result.length > 400) break // 放大到极限时的保护
      result.push({ ms, pct: (ms / totalDuration) * 100, label: formatTimeAbsolute(new Date(globalStartMs + ms).toISOString()) })
    }
    return result
  }, [totalDuration, tickInterval, globalStartMs])

  const lanes = useMemo(() => {
    // 泳道模式：
    //   "slots"  —— B 方案：主 agent 一条 + N 个并发槽位复用（谁先空谁接下一个）
    //   "single" —— 所有任务挤在第一行
    //   "byRole" —— 原始：按角色分组
    const LANE_MODE: string = "slots"

    // 一个 agent = 一根条子：用后端给的 turns 跨度，缺省退化到 createdAt+latencyMs
    // （不再按 5 分钟空档切段——口径与 Turns 页签的 subagent 分组保持一致）
    const spanOf = (agent: AgentItem): { start: number; end: number } => {
      if (agent.span) return agent.span
      const start = new Date(agent.createdAt).getTime()
      return { start, end: start + Math.max(0, agent.latencyMs) }
    }

    // 把若干 [start,end] 区间塞进一条泳道：不重叠的共用一轨，重叠的往下分轨
    const packSpans = (
      spans: Array<{ agent: AgentItem; key: string; start: number; end: number }>,
    ) => {
      const trackEnds: number[] = []
      const packed = spans.map(sp => {
        const startPct = getStartPct(sp.start)
        const widthPct = getWidthPct(sp.end - sp.start)
        const rightPct = Math.min(100, startPct + widthPct)
        let ti = trackEnds.findIndex(e => e <= startPct + 1e-9)
        if (ti === -1) { ti = trackEnds.length; trackEnds.push(rightPct) }
        else trackEnds[ti] = rightPct
        return { agent: sp.agent, key: sp.key, trackIdx: ti, startPct, widthPct, startMs: sp.start, endMs: sp.end }
      })
      return { packed, trackCount: Math.max(1, trackEnds.length) }
    }

    // 旧口径：一个 agent = 一条（长度用 start→next start 的墙钟）
    const packAgents = (list: AgentItem[]) => {
      const spans = list.map(agent => {
        const start = new Date(agent.createdAt).getTime()
        return { agent, key: agent.executionId, start, end: start + (wallMs.get(agent.executionId) ?? agent.latencyMs) }
      })
      return packSpans(spans)
    }

    if (LANE_MODE === "slots") {
      // ── 第 1 行：主 agent（按真实活跃分段画，不再是一条 87 小时实心条）──
      const rootSpans = sorted
        .filter(a => !a.isSubagent)
        .map(a => { const sp = spanOf(a); return { agent: a, key: a.executionId, start: sp.start, end: sp.end } })
      const rootLane = {
        key: "__root",
        def: { key: "__root", label: "主 agent", color: "#3b82f6", bg: "#3b82f620" } as LaneDef,
        ...packSpans(rootSpans),
      }

      // ── 之后：N 个并发槽位复用 ──────────────────────────────────────
      // 把所有 subagent 的活跃分段按开始时间排序，逐个丢进「最早空闲」的槽
      const subSpans = sorted
        .filter(a => a.isSubagent)
        .map(a => { const sp = spanOf(a); return { agent: a, key: a.executionId, start: sp.start, end: sp.end } })
        .sort((x, y) => x.start - y.start)

      const slotFreeAt = new Array<number>(SLOT_COUNT).fill(Number.NEGATIVE_INFINITY)
      const slotSpans: Array<Array<{ agent: AgentItem; key: string; start: number; end: number }>> =
        Array.from({ length: SLOT_COUNT }, () => [])
      for (const sp of subSpans) {
        let idx = slotFreeAt.findIndex(f => f <= sp.start)
        // 并发超过槽位数时兜底：挤进最早空出来的那个槽（该槽会自己分轨，不会真正重叠）
        if (idx === -1) idx = slotFreeAt.indexOf(Math.min(...slotFreeAt))
        slotFreeAt[idx] = Math.max(slotFreeAt[idx], sp.end)
        slotSpans[idx].push(sp)
      }

      const slotLanes = slotSpans.map((spans, i) => ({
        key: `slot-${i + 1}`,
        def: { key: `slot-${i + 1}`, label: `并发槽 ${i + 1}`, color: "#94a3b8", bg: "#94a3b812" } as LaneDef,
        ...packSpans(spans),
      }))

      return [rootLane, ...slotLanes]
    }

    if (LANE_MODE === "single") {
      const def: LaneDef = { key: "all", label: "全部", color: "#64748b", bg: "#64748b20" }
      const spans = sorted.map(agent => {
        const start = new Date(agent.createdAt).getTime()
        return { agent, key: agent.executionId, start, end: start + (wallMs.get(agent.executionId) ?? agent.latencyMs) }
      })
      return [{ key: "all", def, packed: spans.map(sp => ({
        agent: sp.agent, key: sp.key, trackIdx: 0,
        startPct: getStartPct(sp.start), widthPct: getWidthPct(sp.end - sp.start),
        startMs: sp.start, endMs: sp.end,
      })), trackCount: 1 }]
    }

    // ── 原始逻辑：按角色分组的多泳道 ────────────────────────────────
    const laneMap = new Map<string, { def: LaneDef; agents: AgentItem[] }>()
    for (const agent of sorted) {
      const def = assignToLane(agent)
      const existing = laneMap.get(def.key)
      if (existing) existing.agents.push(agent)
      else laneMap.set(def.key, { def, agents: [agent] })
    }
    const entries = [...laneMap.entries()]
    entries.sort((a, b) => {
      if (a[0] === "command") return -1
      if (b[0] === "command") return 1
      return new Date(a[1].agents[0].createdAt).getTime() - new Date(b[1].agents[0].createdAt).getTime()
    })
    return entries.map(([key, { def, agents }]) => {
      return { key, def, ...packAgents(agents) }
    })
  }, [sorted, wallMs, totalDuration, globalStartMs])

  const bridgeBySessionId = useMemo(() => {
    const map = new Map<string, BridgeItem>()
    for (const b of bridges) {
      if (b.subagentSessionId) map.set(b.subagentSessionId, b)
    }
    return map
  }, [bridges])

  function getStartPct(when: string | number): number {
    const t = typeof when === "number" ? when : new Date(when).getTime()
    // 起点上限用 100%（不能再用 98%）：轴上最后一段时间的多个分段会被一起钳到
    // 同一个 x，被避让逻辑排成一列竖堆。宽度本身已经由右边界收敛，不会溢出。
    return Math.max(0, Math.min(((t - globalStartMs) / totalDuration) * 100, 100))
  }

  function getWidthPct(latencyMs: number): number {
    // STEP 1：去掉 2% 的最小宽度，按真实时长占比显示
    return totalDuration === 0 ? 5 : (latencyMs / totalDuration) * 100
  }

  // 浮窗必须用「鼠标所在那根条子」自己的起止（真实活跃分段），
  // 不能用 wallMs（= 自己开始 → 下一条开始）——那会把中间的空档算进时长，
  // 看起来像每个任务都顶在下一条的前面。
  const handleMouseEnter = useCallback((
    e: React.MouseEvent, agent: AgentItem, laneLabel: string, startMs: number, endMs: number,
  ) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const bridge = agent.isSubagent && agent.agentSessionId ? bridgeBySessionId.get(agent.agentSessionId) : undefined
    setTooltip({
      x: rect.left + rect.width / 2,
      y: rect.top,
      label: agent.agentName ?? (agent.isSubagent ? "subagent" : "root"),
      firstPrompt: agent.firstPrompt,
      tokens: agent.tokens,
      maxSingleCallTokens: agent.maxSingleCallTokens,
      latencyMs: Math.max(0, endMs - startMs),
      startTime: formatTimeAbsolute(new Date(startMs).toISOString()),
      endTime: formatTimeAbsolute(new Date(endMs).toISOString()),
      toolCallCount: agent.toolCallCount,
      model: agent.model,
      lane: laneLabel,
      status: bridge?.status ?? "completed",
    })
  }, [bridgeBySessionId])

  const handleMouseLeave = useCallback(() => setTooltip(null), [])

  if (agents.length === 0) {
    return (
      <Card size="sm">
        <CardHeader><CardTitle>Agent Swimlane (0)</CardTitle></CardHeader>
        <CardContent><div className="text-sm text-muted-foreground">No agents found</div></CardContent>
      </Card>
    )
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Agent Swimlane ({agents.length})</CardTitle>
        <CardAction>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">休眠阈值</span>
              {THRESHOLD_PRESETS_MS.map(ms => (
                <Button key={ms} variant={thresholdMs === ms ? "default" : "outline"} size="xs"
                  title={`单条 turn 最多算 ${ms / 60_000} 分钟活跃；相邻活跃间隔 >${ms / 60_000} 分钟判为休眠`}
                  onClick={() => setThresholdMs(ms)}>{ms / 60_000}min</Button>
              ))}
            </div>
            <div className="flex items-center gap-1">
            <Button variant="outline" size="xs" title="缩小"
              onClick={() => setZoom(z => clampZoom(z / ZOOM_FACTOR))}
              disabled={zoom <= MIN_ZOOM}>−</Button>
            <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">{zoom}×</span>
            <Button variant="outline" size="xs" title="放大"
              onClick={() => setZoom(z => clampZoom(z * ZOOM_FACTOR))}
              disabled={zoom >= MAX_ZOOM}>+</Button>
            <Button variant="ghost" size="xs" title="回到全览"
              onClick={() => setZoom(1)}
              disabled={zoom === 1}>全览</Button>
            </div>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* 纵向滚动包住整行（标签列 + 时间轴一起滚）；横向滚动只作用于时间轴 */}
        <div className="overflow-y-auto" style={{ maxHeight: MAX_VISIBLE_HEIGHT }}>
          <div className="flex">
            {/* 左侧固定标签列 */}
            <div className="shrink-0" style={{ width: LANE_LABEL_WIDTH }}>
              <div className="h-[20px]" />
              <div className="h-px bg-border" />
              {lanes.map(({ key, def, trackCount }) => (
                <div
                  key={key}
                  data-lane-label={key}
                  className="flex flex-col items-center justify-center text-[10px] font-bold border-r-2 leading-tight px-1.5"
                  style={{
                    height: Math.max(22, trackCount * SUB_BAR_H + (trackCount + 1) * SUB_GAP),
                    backgroundColor: def.bg, borderColor: def.color, color: def.color,
                  }}
                >
                  <span className="break-all text-center">{def.label}</span>
                </div>
              ))}
            </div>

            {/* 右侧时间轴：宽度 = zoom × 100%，超出部分横向滚动（即平移） */}
            <div ref={scrollRef} className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
              <div style={{ width: `${zoom * 100}%`, minWidth: "100%" }}>
                <div className="relative h-[20px]">
                  {ticks.map((t, i) => (
                    <div key={i} className="absolute text-[10px] text-muted-foreground tabular-nums whitespace-nowrap"
                      style={{ left: `${t.pct}%`, transform: "translateX(-50%)" }}>
                      {t.label}
                    </div>
                  ))}
                </div>
                <div className="h-px bg-border" />

                {lanes.map(({ key, def, packed, trackCount }) => (
                  <div key={key} data-lane={key} className="relative border-b last:border-b-0"
                    style={{ height: Math.max(22, trackCount * SUB_BAR_H + (trackCount + 1) * SUB_GAP) }}>
                    {ticks.filter(t => t.pct > 0 && t.pct < 100).map((t, i) => (
                      <div key={i} className="absolute top-0 h-full w-px bg-border/20" style={{ left: `${t.pct}%` }} />
                    ))}
                    {packed.map(({ agent, key: spanKey, trackIdx, startPct, widthPct, startMs, endMs }) => {
                      const agentColor = getAgentColor(agent.agentName)
                      const bridge = agent.isSubagent && agent.agentSessionId ? bridgeBySessionId.get(agent.agentSessionId) : undefined
                      const isError = bridge?.status === "error" || bridge?.status === "failed"
                      const barTop = SUB_GAP + trackIdx * (SUB_BAR_H + SUB_GAP)
                      const spanMs = Math.max(1, endMs - startMs)
                      const active = (segmentsByAgent.get(agent.executionId) ?? []).filter(seg => seg.end > seg.start)
                      return (
                        // 外层 = 这一根条子的横向范围（相对整条时间轴定位）。
                        // 它铺满整条泳道高（含其它轨的行），且同一泳道里不同轨的条子
                        // 横向必然重叠——所以必须 pointer-events-none，否则后渲染条子的
                        // 透明外层会盖掉前面轨条子的 hover/click（命中测试不看透明度）。
                        <div
                          key={spanKey}
                          data-bar={agent.executionId}
                          className="absolute pointer-events-none"
                          style={{ left: `${startPct}%`, width: `${widthPct}%`, top: 0, height: "100%" }}
                        >
                          {/* 浅色底 = 整根 turns 跨度（含休眠时段），也是鼠标交互区 */}
                          <div
                            className="absolute w-full cursor-pointer pointer-events-auto"
                            style={{
                              top: barTop,
                              height: SUB_BAR_H,
                              backgroundColor: agentColor,
                              opacity: isError ? 0.15 : 0.2,
                            }}
                            onClick={() => onViewTurns?.(agent.isSubagent ? agent.agentSessionId : null)}
                            onMouseEnter={(e) => handleMouseEnter(e, agent, def.label, startMs, endMs)}
                            onMouseLeave={handleMouseLeave}
                          />
                          {/* 深色 = 活跃段；没有活跃段数据时退回整根实色 */}
                          {(active.length > 0
                            ? active.map((seg, si) => (
                                <div
                                  key={si}
                                  className="absolute pointer-events-none"
                                  style={{
                                    left: `${((seg.start - startMs) / spanMs) * 100}%`,
                                    width: `${((seg.end - seg.start) / spanMs) * 100}%`,
                                    top: barTop,
                                    height: SUB_BAR_H,
                                    backgroundColor: agentColor,
                                    opacity: isError ? 0.45 : 0.9,
                                  }}
                                />
                              ))
                            : (
                              <div
                                className="absolute w-full pointer-events-none"
                                style={{ top: barTop, height: SUB_BAR_H, backgroundColor: agentColor, opacity: isError ? 0.4 : 0.8 }}
                              />
                            ))}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          {[...new Set(agents.map(a => a.agentName ?? "root"))].map(name => (
            <div key={name} className="flex items-center gap-1 text-xs">
              <div className="w-3 h-3" style={{ backgroundColor: getAgentColor(name) }} />
              <span className="text-muted-foreground truncate max-w-[120px]">{name}</span>
            </div>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground">
          缩放 {zoom}× · 横向滚动可平移 · Ctrl/⌘ + 滚轮也能缩放
        </div>
      </CardContent>

      {tooltip && (
        <div
          data-tooltip=""
          className="fixed z-[9999] bg-popover border rounded-md shadow-lg px-3 py-2 text-xs max-w-[340px] pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y - 8, transform: "translate(-50%, -100%)" }}
        >
          <div className="font-medium mb-1">{tooltip.label}</div>
          {tooltip.firstPrompt && (
            <div className="text-muted-foreground break-words line-clamp-2 mb-1">{tooltip.firstPrompt}</div>
          )}
          <div className="text-muted-foreground space-y-0.5">
            <div>{formatTokenCount(tooltip.maxSingleCallTokens)} token max · {formatTokenCount(tooltip.tokens)} total · {formatLatency(tooltip.latencyMs)}</div>
            <div>{tooltip.startTime} → {tooltip.endTime}</div>
            <div>{tooltip.toolCallCount} tools{tooltip.model ? ` · ${tooltip.model}` : ""}</div>
          </div>
        </div>
      )}
    </Card>
  )
}
