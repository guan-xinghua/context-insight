"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Agent Swimlane V2（与旧块 AgentCallGraph 并排对比）：
// ①并发槽位数 = 当前可见集合的真实最大并发（旧块固定 5 槽）
// ②底部图例 = 子代理类型（resolveSubagentIdentity 唯一入口）可勾选过滤
// ③点击泳道内两点测时距（第三次点击重置）
import { useMemo, useState, useCallback, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { clusterActiveSegments } from "@/lib/active-time"
import { resolveSubagentIdentity } from "@/lib/subagent-identity"
import { resolveLaneKey } from "@/lib/swimlane-lanes"
import { assignLaneSlots, computeMaxConcurrency } from "@/lib/swimlane-slots"
import type { AgentItem, BridgeItem } from "./AgentCallGraph"

const LANE_LABEL_WIDTH = 109
const SUB_BAR_H = 12
const SUB_GAP = 3
const MIN_ZOOM = 1
const MAX_ZOOM = 64
const ZOOM_FACTOR = 2
const MAX_VISIBLE_HEIGHT = 300
const THRESHOLD_PRESETS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]
// 单击（测距）要等这个窗口确认不是双击（跳转）的第一击
const DBLCLICK_GUARD_MS = 250


function fmtLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`
  return `${(ms / 3_600_000).toFixed(2)}h`
}
function fmtTok(n: number): string {
  if (n === 0) return ""
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}
function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

function fmtAxisLabel(ms: number, intervalMs: number, withDate = false): string {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (intervalMs >= 12 * 3_600_000 || withDate) {
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`
  }
  if (intervalMs >= 60_000) return hm
  return `${hm}:${String(d.getSeconds()).padStart(2, "0")}`
}
function computeTickInterval(totalMs: number): number {
  const H = 3_600_000, D = 86_400_000
  const candidates = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
    H, 3 * H, 6 * H, 12 * H, D]
  for (const c of candidates) {
    if (totalMs / c <= 6) return c
  }
  return Math.ceil(totalMs / 6 / D) * D
}
function fmtTick(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${Math.round(ms / 3_600_000)}h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`
  return `${ms}`
}

interface Span {
  agent: AgentItem
  start: number
  end: number
  key: string
  // 按派发拆分时该条对应的桥（首发/返工各自一根）；整段口径为 undefined
  bridge?: BridgeItem
  // 业务车道键（swimlane-lanes 声明 × 步骤文本匹配）；null=未分类走贪心槽
  laneKey?: string | null
}

interface TooltipData {
  x: number
  y: number
  label: string
  step: string | null
  dispatchCount: number
  firstPrompt: string | null
  tokens: number
  maxSingleCallTokens: number
  latencyMs: number
  startTime: string
  endTime: string
  toolCallCount: number
  model: string | null
  status: string
}

type Measure = { a: { pct: number; t: number }; b?: { pct: number; t: number } }

export function AgentSwimlaneV2({ agents, bridges, isProxy = false, onViewTurns, lanes = [], lanesInferred = false }: {
  agents: AgentItem[]
  bridges: BridgeItem[]
  isProxy?: boolean
  onViewTurns?: (agentSessionId: string | null, sinceMs?: number) => void
  lanes?: string[]
  lanesInferred?: boolean
}) {
  const [zoom, setZoom] = useState(1)
  const [thresholdMs, setThresholdMs] = useState(THRESHOLD_PRESETS_MS[1])
  const [tooltip, setTooltip] = useState<TooltipData | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [measure, setMeasure] = useState<Measure | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const measureTimer = useRef<number | null>(null)
  const cancelPendingMeasure = useCallback(() => {
    if (measureTimer.current !== null) {
      clearTimeout(measureTimer.current)
      measureTimer.current = null
    }
  }, [])
  useEffect(() => cancelPendingMeasure, [cancelPendingMeasure])

  const clampZoom = useCallback((z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)), [])
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

  // 同一子代理会话可能被多次派发（首发 + 返工重入）——单值 Map 后写覆盖会让
  // 浮窗只剩最后一次派发的步骤，这里收集全部并按派发时间升序（首发在前）
  const bridgeBySessionId = useMemo(() => {
    const map = new Map<string, BridgeItem[]>()
    for (const b of bridges) {
      if (!b.subagentSessionId) continue
      const list = map.get(b.subagentSessionId)
      if (list) list.push(b)
      else map.set(b.subagentSessionId, [b])
    }
    for (const list of map.values()) {
      list.sort((x, y) =>
        new Date(x.dispatchTimestamp ?? 0).getTime() - new Date(y.dispatchTimestamp ?? 0).getTime())
    }
    return map
  }, [bridges])

  // 身份唯一入口：类型（泳道条配色/图例/浮窗）+ 步骤（浮窗第二行）
  const identityOf = useCallback((a: AgentItem) =>
    a.isSubagent && a.agentSessionId
      ? resolveSubagentIdentity({
          subagentName: a.agentName,
          bridge: bridgeBySessionId.get(a.agentSessionId)?.[0] ?? null,
          isProxy,
        })
      : null, [bridgeBySessionId, isProxy])
  const keyOf = useCallback((a: AgentItem): string =>
    a.isSubagent ? (identityOf(a)?.subagentType ?? a.agentName ?? "unknown") : "root", [identityOf])

  // 图例全集（不受过滤影响，顺序稳定：root 在前、按首现）
  const legendKeys = useMemo(() => {
    const seen: string[] = []
    const sortedAgents = [...agents].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    for (const a of sortedAgents) {
      const k = keyOf(a)
      if (k === "root") continue
      if (!seen.includes(k)) seen.push(k)
    }
    return seen
  }, [agents, keyOf])

  // 类型配色：黄金角度色相序列——任意类型数都不回绕撞色（固定 12 色对 >12 类型会复色，
  // 导致「图例里的类型」和「泳道里的条子」无法对上）；顺序取图例首现序，数据不变则配色稳定
  const colorOf = useMemo(() => {
    const m = new Map<string, string>([["root", "#3b82f6"]])
    legendKeys.forEach((k, i) => m.set(k, `hsl(${Math.round((i * 137.508) % 360)} 65% 55%)`))
    return m
  }, [legendKeys])

  const visible = useMemo(() => agents.filter(a => !hidden.has(keyOf(a))), [agents, hidden, keyOf])

  const visibleSorted = useMemo(() =>
    [...visible].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()), [visible])

  // 区间基（与旧块一致）：后端给的 turns 跨度 span，缺省退化 createdAt+latency。
  // 不能用 wall（start→next start）口径——那区间首尾相接永不重叠，并发恒为 1
  const spanOf = useCallback((a: AgentItem): { start: number; end: number } => {
    if (a.span) return a.span
    const start = new Date(a.createdAt).getTime()
    return { start, end: start + Math.max(0, a.latencyMs) }
  }, [])

  const globalStartMs = useMemo(() =>
    visibleSorted.length === 0 ? 0 : Math.min(...visibleSorted.map(a => spanOf(a).start)), [visibleSorted, spanOf])
  const globalEndMs = useMemo(() => {
    if (visibleSorted.length === 0) return 1
    const end = Math.max(...visibleSorted.map(a => spanOf(a).end))
    return Number.isFinite(end) ? end : 1
  }, [visibleSorted, spanOf])
  const totalDuration = globalEndMs - globalStartMs || 1

  const segmentsByAgent = useMemo(() => {
    const m = new Map<string, Array<{ start: number; end: number }>>()
    for (const a of visible) {
      const raw = a.activeIntervals ?? []
      const ivs: Array<[number, number]> = raw.map(s => [s.start, Math.min(s.end, s.start + thresholdMs)])
      m.set(a.executionId, clusterActiveSegments(ivs, thresholdMs))
    }
    return m
  }, [visible, thresholdMs])

  const rootSpans = useMemo<Span[]>(() =>
    visibleSorted.filter(a => !a.isSubagent).map(a => {
      const sp = spanOf(a)
      return { agent: a, start: sp.start, end: sp.end, key: a.executionId }
    }), [visibleSorted, spanOf])

  // 子代理条：会话被多次派发（首发+返工）时按派发拆条——各根区间取该次桥的
  // dispatch→response，返工的时间位置/时长/状态独立可见；仅一次派发或缺时间戳
  // 则回落整段会话口径（后端 turns 跨度）
  const subSpans = useMemo<Span[]>(() => {
    const out: Span[] = []
    const tOf = (v: string | null | undefined) => {
      const t = v ? new Date(v).getTime() : NaN
      return Number.isFinite(t) ? t : NaN
    }
    for (const a of visibleSorted.filter(x => x.isSubagent)) {
      const sp = spanOf(a)
      const usable = (a.agentSessionId ? bridgeBySessionId.get(a.agentSessionId) ?? [] : [])
        .filter(b => Number.isFinite(tOf(b.dispatchTimestamp)))
      if (usable.length >= 2) {
        usable.forEach((b, i) => {
          const start = tOf(b.dispatchTimestamp)!
          const respEnd = tOf(b.responseTimestamp)
          const nextStart = tOf(usable[i + 1]?.dispatchTimestamp)
          // 端点钳到下次派发（ingest [dispatch_i, dispatch_{i+1}) 同口径）：
          // completedAt 越过下次派发时条子不得越过下一条的起点
          const candidates = [respEnd, nextStart].filter(Number.isFinite)
          const end = candidates.length > 0 ? Math.min(...candidates) : sp.end
          out.push({ agent: a, start, end: Math.max(start + 1, end), key: `${a.executionId}#${i}`, bridge: b,
            laneKey: resolveLaneKey(b.dispatchContent, lanes) })
        })
      } else {
        // 整段条：车道匹配优先用桥派发内容（与浮窗展示同源）——proxy 形态的
        // agentName 常是类型名（design-step-reviewer，不含车道词），先用它会
        // 把「④ base R 门控」这类条漏到贪心槽（现场 ses_f4da12dc #7）
        const joinedSteps = usable.map(b => b.dispatchContent).filter(Boolean).join(' · ')
        out.push({ agent: a, start: sp.start, end: sp.end, key: a.executionId,
          laneKey: resolveLaneKey(joinedSteps, lanes) ?? resolveLaneKey(identityOf(a)?.step, lanes) })
      }
    }
    return out
  }, [visibleSorted, spanOf, bridgeBySessionId, lanes, identityOf])

  // 图例项尾的派发次数（按拆分后条数计，对齐 context 页图例的「N轮」）
  const countByKey = useMemo(() => {
    const m = new Map<string, number>()
    for (const sp of subSpans) {
      const k = keyOf(sp.agent)
      if (k !== "root") m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [subSpans, keyOf])

  // ①真实最大并发（子代理区间扫掠；端点相接不算并发——end 先于 start 处理）
  const maxConcurrency = useMemo(() => computeMaxConcurrency(subSpans), [subSpans])

  // 槽位分配：车道池（声明车道按序占 ⌈内部并发⌉ 槽，钉死不漂移）+ 未分类贪心。
  // 纯逻辑在 swimlane-slots.ts（函数级 IT）；此处只做分组与百分比换算
  const slotAssignment = useMemo(
    () => assignLaneSlots(subSpans, lanes),
    [subSpans, lanes],
  )
  const slotLabels = slotAssignment.labels
  const slots = useMemo(() => {
    const out: Array<Array<{ span: Span; startPct: number; widthPct: number }>> = Array.from({ length: slotLabels.length }, () => [])
    for (const s of subSpans) {
      const idx = slotAssignment.slotOf.get(s.key) ?? 0
      out[idx]?.push({
        span: s,
        startPct: ((s.start - globalStartMs) / totalDuration) * 100,
        widthPct: Math.max(0.15, ((s.end - s.start) / totalDuration) * 100),
      })
    }
    return out
  }, [subSpans, slotAssignment, slotLabels.length, globalStartMs, totalDuration])

  const tickInterval = computeTickInterval(totalDuration / zoom)
  // 刻度对齐本地午夜网格：87h 会话若从起点直接累加，间隔（如 15h）会把标签打到
  // 08:38/02:38 这类怪时刻；对齐后标签永远落在整点/半天/整天上
  // 日期可见性：首个刻度与跨日后的首个刻度带 MM-DD（小时级刻度只看 HH:MM
  // 不知道是哪天），≥12h 大间隔刻度维持原有整排带日期
  const ticks = useMemo(() => {
    const out: Array<{ pct: number; label: string }> = []
    const d0 = new Date(globalStartMs)
    const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime()
    const first = midnight + Math.ceil(Math.max(0, globalStartMs - midnight) / tickInterval) * tickInterval
    const gEnd = globalStartMs + totalDuration
    let prevDay = -1
    for (let t = first; t <= gEnd; t += tickInterval) {
      const day = new Date(t).getDate()
      out.push({ pct: ((t - globalStartMs) / totalDuration) * 100, label: fmtAxisLabel(t, tickInterval, day !== prevDay) })
      prevDay = day
    }
    return out
  }, [totalDuration, tickInterval, globalStartMs])

  const handleMouseEnter = useCallback((e: React.MouseEvent, span: Span) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const id = identityOf(span.agent)
    const bs = span.agent.isSubagent && span.agent.agentSessionId
      ? bridgeBySessionId.get(span.agent.agentSessionId) ?? []
      : []
    const steps = (span.bridge ? [span.bridge] : bs)
      .map(b => b.dispatchContent?.replace(/[\n\r]+/g, " ").trim())
      .filter((v): v is string => Boolean(v))
    setTooltip({
      x: rect.left + rect.width / 2,
      y: rect.top,
      label: id?.subagentType ?? span.agent.agentName ?? (span.agent.isSubagent ? "subagent" : "root"),
      step: steps.length > 0 ? steps.join(" · ") : (id?.step ?? null),
      dispatchCount: span.bridge ? 1 : bs.length,
      firstPrompt: span.agent.firstPrompt,
      tokens: span.agent.tokens,
      maxSingleCallTokens: span.agent.maxSingleCallTokens,
      latencyMs: Math.max(0, span.end - span.start),
      startTime: fmtClock(span.start),
      endTime: fmtClock(span.end),
      toolCallCount: span.agent.toolCallCount,
      model: span.agent.model,
      status: span.bridge?.status ?? bs.at(-1)?.status ?? "completed",
    })
  }, [bridgeBySessionId, identityOf])
  const handleMouseLeave = useCallback(() => setTooltip(null), [])

  // ③测时距：点击时间轴区域记两点（相对本行的横向比例 → 绝对时间），第三击重置
  const handlePlotClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
    const t = globalStartMs + (pct / 100) * totalDuration
    cancelPendingMeasure()
    measureTimer.current = window.setTimeout(() => {
      measureTimer.current = null
      setMeasure(m => (!m || m.b ? { a: { pct, t } } : { ...m, b: { pct, t } }))
    }, DBLCLICK_GUARD_MS)
  }, [globalStartMs, totalDuration, cancelPendingMeasure])

  if (agents.length === 0) {
    return (
      <Card size="sm">
        <CardHeader><CardTitle>Agent Swimlane (0)</CardTitle></CardHeader>
        <CardContent><div className="text-sm text-muted-foreground">No agents found</div></CardContent>
      </Card>
    )
  }

  const measureInfo = measure?.b
    ? { from: Math.min(measure.a.t, measure.b.t), to: Math.max(measure.a.t, measure.b.t) }
    : null

  const laneH = (n: number) => Math.max(22, n * SUB_BAR_H + (n + 1) * SUB_GAP)

  const renderBar = (span: Span, startPct: number, widthPct: number) => {
    const color = colorOf.get(keyOf(span.agent)) ?? "#94a3b8"
    const isErr = span.agent.isSubagent
      && ["error", "failed"].includes(span.bridge?.status
        ?? bridgeBySessionId.get(span.agent.agentSessionId ?? "")?.at(-1)?.status ?? "")
    // 拆分条只画落在本派发区间内的活跃段（裁剪到 [start,end]，另一派的段不外溢）
    const active = (segmentsByAgent.get(span.agent.executionId) ?? [])
      .map(seg => ({ start: Math.max(seg.start, span.start), end: Math.min(seg.end, span.end) }))
      .filter(seg => seg.end > seg.start)
    const spanMs = Math.max(1, span.end - span.start)
    return (
      <div key={span.key} className="absolute pointer-events-none" style={{ left: `${startPct}%`, width: `${widthPct}%`, top: 0, height: "100%" }}>
        <div
          data-bar={span.key}
          className="absolute w-full cursor-pointer pointer-events-auto"
          style={{ top: SUB_GAP, height: SUB_BAR_H, backgroundColor: color, opacity: isErr ? 0.15 : 0.2 }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            cancelPendingMeasure()
            const sinceMs = span.bridge?.dispatchTimestamp
              ? new Date(span.bridge.dispatchTimestamp).getTime()
              : undefined
            onViewTurns?.(span.agent.isSubagent ? span.agent.agentSessionId : null, sinceMs)
          }}
          onMouseEnter={(e) => handleMouseEnter(e, span)}
          onMouseLeave={handleMouseLeave}
        />
        {active.length > 0
          ? active.map((seg, si) => (
              <div key={si} className="absolute pointer-events-none" style={{
                left: `${((seg.start - span.start) / spanMs) * 100}%`,
                width: `${((seg.end - seg.start) / spanMs) * 100}%`,
                top: SUB_GAP, height: SUB_BAR_H, backgroundColor: color, opacity: isErr ? 0.45 : 0.9,
              }} />
            ))
          : (
            <div className="absolute w-full pointer-events-none" style={{ top: SUB_GAP, height: SUB_BAR_H, backgroundColor: color, opacity: isErr ? 0.4 : 0.8 }} />
          )}
      </div>
    )
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Agent Swimlane ({agents.length}) · 最大并发 {maxConcurrency}{lanesInferred && lanes.length > 0
          && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(车道按内容推断)</span>}</CardTitle>
        <CardAction>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">休眠阈值</span>
              {THRESHOLD_PRESETS_MS.map(ms => (
                <Button key={ms} variant={thresholdMs === ms ? "default" : "outline"} size="xs"
                  onClick={() => setThresholdMs(ms)}>{ms / 60_000}min</Button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="xs" onClick={() => setZoom(z => clampZoom(z / ZOOM_FACTOR))} disabled={zoom <= MIN_ZOOM}>−</Button>
              <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">{zoom}×</span>
              <Button variant="outline" size="xs" onClick={() => setZoom(z => clampZoom(z * ZOOM_FACTOR))} disabled={zoom >= MAX_ZOOM}>+</Button>
              <Button variant="ghost" size="xs" onClick={() => setZoom(1)} disabled={zoom === 1}>全览</Button>
            </div>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {measure && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">测距</span>
            {measureInfo
              ? <span>{fmtClock(measureInfo.from)} → {fmtClock(measureInfo.to)} · <span className="font-semibold text-foreground">{fmtLatency(measureInfo.to - measureInfo.from)}</span></span>
              : <span>已标记起点 {fmtClock(measure.a.t)}，再点一点标记终点</span>}
            <Button variant="ghost" size="xs" onClick={() => { cancelPendingMeasure(); setMeasure(null) }}>清除</Button>
          </div>
        )}
        <div className="overflow-y-auto" style={{ maxHeight: MAX_VISIBLE_HEIGHT }}>
          <div className="flex">
            <div className="shrink-0" style={{ width: LANE_LABEL_WIDTH }}>
              <div className="h-[20px]" />
              <div className="h-px bg-border" />
              <div className="flex flex-col items-center justify-center text-[10px] font-bold border-r-2 leading-tight px-1.5"
                style={{ height: laneH(rootSpans.length), backgroundColor: "#3b82f620", borderColor: "#3b82f6", color: "#3b82f6" }}>
                <span className="break-all text-center">root</span>
              </div>
              {slots.map((lane, i) => (
                <div key={i} className="flex flex-col items-center justify-center text-[10px] font-bold border-r-2 leading-tight px-1.5"
                  style={{ height: laneH(1), backgroundColor: "#94a3b812", borderColor: "#94a3b8", color: "#94a3b8" }}>
                  <span className="break-all text-center">{slotLabels[i] ?? `slot${i + 1}`}</span>
                </div>
              ))}
            </div>
            <div ref={scrollRef} className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
              <div style={{ width: `${zoom * 100}%`, minWidth: "100%" }} className="relative">
                <div className="relative h-[20px]">
                  {(() => {
                    // 会话起止边界时刻：网格刻度只落整点（首格 18:00 前的 17:3x、
                    // 末格 20:00 后的尾巴从不显示）——两端补真实起止 HH:MM，
                    // 与近邻网格刻度太近（<6% 轴宽）时去重防叠字
                    const firstPct = ticks[0]?.pct ?? 0
                    const lastPct = ticks[ticks.length - 1]?.pct ?? 100
                    const hm = (ms: number) => {
                      const d = new Date(ms)
                      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
                    }
                    const edge = "absolute text-[10px] text-muted-foreground/60 tabular-nums whitespace-nowrap"
                    return (
                      <>
                        {firstPct > 6 && (
                          <div className={edge} style={{ left: 0 }}>{hm(globalStartMs)}</div>
                        )}
                        {lastPct < 94 && (
                          <div className={edge} style={{ left: "100%", transform: "translateX(-100%)" }}>{hm(globalEndMs)}</div>
                        )}
                      </>
                    )
                  })()}
                  {ticks.map((t, i) => (
                    <div key={i} className="absolute text-[10px] text-muted-foreground tabular-nums whitespace-nowrap"
                      style={{
                        left: `${t.pct}%`,
                        // 首刻度左对齐/末刻度右对齐：居中位移会把 pct=0/100 的标签
                        // 切掉一半（带日期后标签更长，截断更明显）
                        transform: i === 0 ? "none" : i === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
                      }}>{t.label}</div>
                  ))}
                </div>
                <div className="h-px bg-border" />
                <div className="relative border-b" style={{ height: laneH(rootSpans.length) }} onClick={handlePlotClick} data-lane="root">
                  {ticks.filter(t => t.pct > 0 && t.pct < 100).map((t, i) => (
                    <div key={i} className="absolute top-0 h-full w-px bg-border/20" style={{ left: `${t.pct}%` }} />
                  ))}
                  {measure && measure.a.pct > 0 && (
                    <div className="absolute top-0 h-full border-l border-dashed border-rose-500" style={{ left: `${measure.a.pct}%` }} />
                  )}
                  {measure?.b && measure.b.pct > 0 && (
                    <div className="absolute top-0 h-full border-l border-dashed border-rose-500" style={{ left: `${measure.b.pct}%` }} />
                  )}
                  {measure?.b && (
                    <div className="absolute top-0 h-full bg-rose-500/10" style={{
                      left: `${Math.min(measure.a.pct, measure.b.pct)}%`,
                      width: `${Math.abs(measure.b.pct - measure.a.pct)}%`,
                    }} />
                  )}
                  {rootSpans.map(s => renderBar(s, ((s.start - globalStartMs) / totalDuration) * 100, Math.max(0.15, ((s.end - s.start) / totalDuration) * 100)))}
                </div>
                {slots.map((lane, i) => (
                  <div key={i} className="relative border-b last:border-b-0" style={{ height: laneH(1) }} onClick={handlePlotClick} data-lane={`slot-${i + 1}`}>
                    {ticks.filter(t => t.pct > 0 && t.pct < 100).map((t, ti) => (
                      <div key={ti} className="absolute top-0 h-full w-px bg-border/20" style={{ left: `${t.pct}%` }} />
                    ))}
                    {measure && measure.a.pct > 0 && (
                      <div className="absolute top-0 h-full border-l border-dashed border-rose-500" style={{ left: `${measure.a.pct}%` }} />
                    )}
                    {measure?.b && measure.b.pct > 0 && (
                      <div className="absolute top-0 h-full border-l border-dashed border-rose-500" style={{ left: `${measure.b.pct}%` }} />
                    )}
                    {measure?.b && (
                      <div className="absolute top-0 h-full bg-rose-500/10" style={{
                        left: `${Math.min(measure.a.pct, measure.b.pct)}%`,
                        width: `${Math.abs(measure.b.pct - measure.a.pct)}%`,
                      }} />
                    )}
                    {lane.map(({ span, startPct, widthPct }) => renderBar(span, startPct, widthPct))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ②图例 = 类型过滤（勾选显示），样式与 context 页图例同款；root 常显。
            「全部」= 单复选框双态主开关（全勾 ↔ 全清） */}
        <div className="flex flex-wrap gap-2 items-center pt-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#3b82f6" }} />
            <span className="font-medium text-blue-600 dark:text-blue-400">root</span>
          </div>
          {legendKeys.map(k => {
            const color = colorOf.get(k) ?? "#94a3b8"
            const on = !hidden.has(k)
            const count = countByKey.get(k) ?? 0
            return (
              <label key={k} className="flex items-center gap-1.5 text-xs cursor-pointer select-none px-1.5 py-0.5 rounded-md">
                <input type="checkbox" data-legend={k} checked={on}
                  onChange={() => setHidden(prev => {
                    const next = new Set(prev)
                    if (next.has(k)) next.delete(k)
                    else next.add(k)
                    return next
                  })}
                  className="size-3 accent-current" style={{ accentColor: color }} />
                <span className="inline-block w-2.5 h-2.5 rounded-full transition-all" style={{ backgroundColor: on ? color : "#d1d5db" }} />
                <span className={on ? "font-medium" : "text-muted-foreground line-through"}>{k}</span>
                {on && count > 0 && <span className="text-muted-foreground">{count}次</span>}
              </label>
            )
          })}
          {legendKeys.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground ml-1">|</span>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                <input type="checkbox" data-legend-all checked={hidden.size === 0}
                  onChange={() => setHidden(hidden.size === 0 ? new Set(legendKeys) : new Set())}
                  className="size-3 accent-red-500" />
                <span className="text-xs">全部</span>
              </label>
            </>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground">
          槽位 = 可见集合真实最大并发 · 单击泳道测时距（两点，第三下重置） · 双击条子跳 turns · 横向滚动可平移 · Ctrl/⌘ + 滚轮缩放
        </div>
      </CardContent>

      {tooltip && (
        <div data-tooltip="" className="fixed z-[9999] bg-popover border rounded-md shadow-lg px-3 py-2 text-xs max-w-[340px] pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y - 8, transform: "translate(-50%, -100%)" }}>
          <div className="font-medium mb-1">{tooltip.label}</div>
          {tooltip.step && <div className="text-muted-foreground break-words mb-1" title={tooltip.step}>{tooltip.step}</div>}
          {tooltip.dispatchCount > 1 && <div className="text-muted-foreground mb-1">{tooltip.dispatchCount} 次派发（首发 + 返工重入）</div>}
          {tooltip.firstPrompt && (
            <div className="text-muted-foreground break-words line-clamp-2 mb-1">{tooltip.firstPrompt}</div>
          )}
          <div className="text-muted-foreground space-y-0.5">
            <div>{fmtTok(tooltip.maxSingleCallTokens)} token max · {fmtTok(tooltip.tokens)} total · {fmtLatency(tooltip.latencyMs)}</div>
            <div>{tooltip.startTime} → {tooltip.endTime}</div>
            <div>{tooltip.toolCallCount} tools{tooltip.model ? ` · ${tooltip.model}` : ""} · {tooltip.status}</div>
          </div>
        </div>
      )}
    </Card>
  )
}
