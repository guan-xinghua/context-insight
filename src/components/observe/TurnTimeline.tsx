"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useEffect, useRef, type RefObject } from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { isCommandTurn, isCommandCaveat, isCommandStdout, parseCommandTurns, formatCommandDisplay, isContinuationTurn, parseContinuationTurn } from "@/lib/shared/command-parser"
import { buildSubagentNumbers } from "@/lib/subagent-numbering"
import { isSubagentReturnText, isTaskNotificationSummaryText } from "@/lib/tool-conventions"

interface TurnRowItem {
  turnId: string
  turnIndex: number
  role: string
  contentSummary: string | null
  agentName: string | null
  isSubagent: boolean
  subagentName: string | null
  subagentSessionId: string | null
  parentExecutionId: string | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  latencyMs: number
  createdAt: string | null
  completedAt: string | null
  model: string | null
  toolCalls: Array<{ toolCallId: string; toolName: string; state: string; durationMs: number }>
  skillEvents: Array<{ skillName: string; eventType: string; success: boolean }>
}

interface BridgeItem {
  bridgeId: string
  dispatchTurnId: string | null
  dispatchContent: string | null
  dispatchTimestamp?: string | null
  responseTimestamp?: string | null
  subagentSessionId: string | null
  subagentType: string | null
  subagentName: string | null
  agentName: string | null
  status: string
  subagentTokens: number
  subagentLatencyMs: number
  /** 派发是否后台异步（bridges API 由派发 ToolCall args/result 判定） */
  dispatchBackground?: boolean | null
}

interface TurnTimelineProps {
  turns: TurnRowItem[]
  bridges: BridgeItem[]
  selectedTurnId: string | null
  onSelectTurn: (turnId: string) => void
  highlightSubagentTurnId?: string | null
  scrollToTurnId?: string | null
  onJumpToTurnIndex?: (turnIndex: number) => void
}

const ROLE_COLORS: Record<string, string> = {
  user: "border-l-blue-500 bg-blue-50/50 dark:bg-blue-500/5",
  assistant: "border-l-emerald-500 bg-emerald-50/50 dark:bg-emerald-500/5",
  system: "border-l-gray-400 bg-gray-50/50 dark:bg-gray-500/5",
  tool_result: "border-l-teal-500 bg-teal-50/50 dark:bg-teal-500/5",
  command: "border-l-gray-500 bg-gray-50/50 dark:bg-gray-500/5",
  continuation: "border-l-purple-500 bg-purple-50/50 dark:bg-purple-500/5",
  compaction: "border-l-amber-500 bg-amber-50/50 dark:bg-amber-500/5",
  "subagent-return": "border-l-slate-400 bg-slate-50/50 dark:bg-slate-500/5",
}

const ROLE_ICONS: Record<string, string> = {
  user: "👤",
  assistant: "🤖",
  system: "⚙️",
  tool_result: "🔧",
  command: "⚡",
  continuation: "⏸",
  compaction: "⚡",
  "subagent-return": "⤴",
}

// displayRole → 用户可见标签（continuation 在 UI 显示为 /compact，更直观）
const ROLE_LABELS: Record<string, string> = {
  continuation: "/compact",
  "subagent-return": "后台完成",
}

const ROLE_BADGE_VARIANTS: Record<string, "blue" | "green" | "gray" | "purple" | "orange" | "yellow" | "slate"> = {
  user: "blue",
  assistant: "green",
  system: "gray",
  tool_result: "purple",
  command: "gray",
  continuation: "purple",
  compaction: "yellow",
  "subagent-return": "slate",
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

interface SubagentLane {
  bridgeId: string
  sessionId: string | null
  name: string
  type: string | null
  background: boolean
  summary: string | null
  turns: TurnRowItem[]
  status: string
  totalTokens: number
  latencyMs: number
  turnCount: number
}

interface LaneCtx {
  subagentBlocksByTurnId: Map<string, SubagentLane[]>
  expandedSubagents: Set<string>
  onToggleBridge: (bridgeId: string) => void
  selectedTurnId: string | null
  onSelectTurn: (turnId: string) => void
  // 可空：静态渲染/单 lane 直渲的调用方无滚动定位需求，传 null 即可
  selectedSubRef: RefObject<HTMLButtonElement | null> | null
}

// Recursive subagent lane: renders a lane's turns AND, nested, any sub-lanes
// dispatched by those turns (supports subagent-of-subagent, not just root→subagent).
// 布局约束：lane 可能被放进窄容器（并行组的展开区、嵌套子 lane），根节点必须
// min-w-0（grid/flex 子项默认 min-width:auto 会被内容撑破轨道），内部行必须
// flex-wrap + 固定元素 shrink-0 + 摘要可截断——否则 #635 / "1 tools" / token 数
// 等最小内容宽度超出容器后横向溢出到框外，覆盖相邻内容。
export function SubagentLaneView({ lane, ctx }: { lane: SubagentLane; ctx: LaneCtx }) {
  const isExpanded = ctx.expandedSubagents.has(lane.bridgeId)
  const isError = lane.status === "error"
  return (
    <div className={cn(
      "border rounded-lg min-w-0",
      isError ? "border-red-300 bg-red-50/30 dark:bg-red-500/5" : "border-orange-200 bg-orange-50/20 dark:bg-orange-500/5"
    )}>
      <div className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left">
        <Badge variant="orange" className="text-xs max-w-[60%] truncate">{lane.name}</Badge>
        {lane.background && <Badge variant="yellow" className="text-xs shrink-0" title="后台异步派发：立即返回，完成后再通知父会话">background</Badge>}
        {lane.summary && <span className="text-xs text-foreground/80 truncate">{lane.summary}</span>}
        {isError && <Badge variant="red" className="text-xs shrink-0">error</Badge>}
        <span
          role="button"
          tabIndex={0}
          className="ml-auto shrink-0 px-2 py-1 -mr-2 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer select-none"
          onClick={() => ctx.onToggleBridge(lane.bridgeId)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') ctx.onToggleBridge(lane.bridgeId) }}
        >
          {isExpanded ? "▼" : "▶"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 px-2 pb-1 text-xs text-muted-foreground">
        <span>{lane.turnCount} turns</span>
        {lane.totalTokens > 0 && <span>{formatTokenCount(lane.totalTokens)} tok</span>}
        {lane.latencyMs > 0 && <span>{formatLatency(lane.latencyMs)}</span>}
      </div>
      {isExpanded && lane.turns.length > 0 && (
        <div className="px-2 pb-2 space-y-1">
          {lane.turns.map(st => (
            <div key={st.turnId} className="space-y-1">
              <button
                ref={ctx.selectedTurnId === st.turnId ? ctx.selectedSubRef : null}
                className={cn(
                  "w-full text-left flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-2 py-1 rounded border-l-2 text-xs transition-colors cursor-pointer",
                  "border-l-orange-400 bg-orange-50/30 dark:bg-orange-500/10",
                  ctx.selectedTurnId === st.turnId ? "ring-1 ring-primary/50" : "hover:bg-accent/30"
                )}
                onClick={() => ctx.onSelectTurn(st.turnId)}
              >
                <span className="font-mono text-muted-foreground shrink-0">#{st.turnIndex}</span>
                <Badge variant={ROLE_BADGE_VARIANTS[st.role] ?? "gray"} className="text-xs shrink-0">
                  {ROLE_ICONS[st.role]} {st.role}
                </Badge>
                {st.toolCalls.length > 0 && <Badge variant="outline" className="text-xs shrink-0">{st.toolCalls.length} tools</Badge>}
                {st.contentSummary && (
                  <span className="text-foreground/80 truncate min-w-[60px] max-w-[200px]">
                    {st.contentSummary.replace(/^<thinking>/, "").substring(0, 40)}
                  </span>
                )}
                {st.totalTokens > 0 && <span className="text-muted-foreground shrink-0">{formatTokenCount(st.totalTokens)}</span>}
              </button>
              {(() => {
                // 嵌套子 lane 就地挂载在派发轮行后（root 层同款：单 lane 直渲、
                // 多 lane 并行组），不再统一追加在父 lane 末尾——后台子代理真实
                // 运行在父的中段，末尾挂载会读成「父结束后才启动」（现场：
                // designer 运行中段派生的两个 Explore 被读成由末轮 #1847 启动）
                const lns = ctx.subagentBlocksByTurnId.get(st.turnId)
                if (!lns || lns.length === 0) return null
                return (
                  <div className="ml-3 pl-3 border-l border-orange-200 dark:border-orange-500/30 min-w-0">
                    {lns.length === 1
                      ? <SubagentLaneView lane={lns[0]} ctx={ctx} />
                      : <ParallelSubagentGroup lanes={lns} ctx={ctx} />}
                  </div>
                )
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 并行派发组（同一 turn 派发 N>1 个 subagent）：不再用多列 grid 并排展开——
// lane 长度不齐时短侧下方必然留白（grid 行高取最高者），窄列还会被行内容撑破。
// 改为「紧凑 chip 行 + 就地展开」：
//   - 折叠态：每个 subagent 一个单行 chip（名/turns/时延/错误态），短名同行换行排布；
//   - 点击 chip：该 lane 紧贴自己的 chip 下方全宽展开（wrapper basis-full 独占
//     一行，turn 行不挤窄列）——展开区跟在所属 chip 后而非整个 chip 行末尾，
//     点第一个 chip 时详情不会跑到最后一个 chip 下面；可多个同时展开（保持
//     跨 tab 导航祖先链的多桥展开语义）；
//   - 组头 ⇄ 标识 + 汇总统计，并行关系与规模一目了然。
export function ParallelSubagentGroup({ lanes, ctx }: { lanes: SubagentLane[]; ctx: LaneCtx }) {
  const totalTurns = lanes.reduce((s, l) => s + l.turnCount, 0)
  const totalTokens = lanes.reduce((s, l) => s + l.totalTokens, 0)
  return (
    <div className="ml-4 mt-1 min-w-0 rounded-lg border border-orange-200/70 dark:border-orange-500/20 bg-orange-50/10 dark:bg-orange-500/5 p-1.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
        <span className="text-[11px] text-muted-foreground shrink-0">⇄ {lanes.length} parallel subagents</span>
        <span className="text-[11px] text-muted-foreground">
          {totalTurns} turns{totalTokens > 0 ? ` · ${formatTokenCount(totalTokens)} tok` : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 items-start">
        {lanes.map(lane => {
          const isExpanded = ctx.expandedSubagents.has(lane.bridgeId)
          const isError = lane.status === "error"
          return (
            <div key={lane.bridgeId} className={cn("min-w-0 flex flex-col gap-1.5", isExpanded && "basis-full")}>
              <button
                className={cn(
                  "inline-flex self-start items-center gap-1.5 px-2 py-1 rounded-md border text-xs min-w-0 max-w-full transition-colors cursor-pointer",
                  isExpanded
                    ? "border-orange-400 bg-orange-100/60 dark:bg-orange-500/15"
                    : isError
                      ? "border-red-300 bg-red-50/40 dark:bg-red-500/10 hover:bg-red-50/70 dark:hover:bg-red-500/20"
                      : "border-orange-200 bg-background hover:bg-accent/40"
                )}
                onClick={() => ctx.onToggleBridge(lane.bridgeId)}
              >
                <span className="select-none shrink-0">{isExpanded ? "▼" : "▶"}</span>
                <Badge variant="orange" className="max-w-[180px] truncate">{lane.name}</Badge>
                {lane.background && <Badge variant="yellow" className="shrink-0" title="后台异步派发：立即返回，完成后再通知父会话">background</Badge>}
                {isError && <Badge variant="red" className="shrink-0">error</Badge>}
                <span className="text-muted-foreground shrink-0">{lane.turnCount}t</span>
                {lane.latencyMs > 0 && <span className="text-muted-foreground shrink-0">{formatLatency(lane.latencyMs)}</span>}
              </button>
              {isExpanded && <SubagentLaneView lane={lane} ctx={ctx} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function TurnTimeline({ turns, bridges, selectedTurnId, onSelectTurn, highlightSubagentTurnId, scrollToTurnId, onJumpToTurnIndex }: TurnTimelineProps) {
  const [expandedSubagents, setExpandedSubagents] = useState<Set<string>>(new Set())
  const [filterRole, setFilterRole] = useState<string | null>(null)
  const [jumpInput, setJumpInput] = useState("")
  const [jumpNotFound, setJumpNotFound] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLDivElement>(null)
  const selectedSubRef = useRef<HTMLButtonElement>(null)

  // Expand subagent block(s) when highlightSubagentTurnId is set (cross-tab navigation).
  // highlightSubagentTurnId may be either a turnId or a subagentSessionId.
  // For nested subagents (subagent-of-subagent), walk the bridge chain up to root
  // and expand EVERY ancestor bridge so the target turn is actually rendered.
  useEffect(() => {
    if (!highlightSubagentTurnId) return
    let subTurn = turns.find(t => t.turnId === highlightSubagentTurnId)
    if (!subTurn) {
      subTurn = turns.find(t => t.isSubagent && t.subagentSessionId === highlightSubagentTurnId)
    }
    if (!subTurn?.isSubagent || !subTurn?.subagentSessionId) return
    const toExpand = new Set<string>()
    const seen = new Set<string | null>()
    let curSid: string | null = subTurn.subagentSessionId
    while (curSid && !seen.has(curSid)) {
      seen.add(curSid)
      const bridge = bridges.find(b => b.subagentSessionId === curSid)
      if (!bridge) break
      toExpand.add(bridge.bridgeId)
      if (!bridge.dispatchTurnId) break
      const dispTurn = turns.find(t => t.turnId === bridge.dispatchTurnId)
      curSid = dispTurn?.isSubagent ? (dispTurn.subagentSessionId ?? null) : null
    }
    if (toExpand.size) {
      setExpandedSubagents(prev => {
        const next = new Set(prev)
        for (const id of toExpand) next.add(id)
        return next
      })
    }
  }, [highlightSubagentTurnId, turns, bridges])

  const dispatchTurnIdForSelected = (() => {
    if (!selectedTurnId) return null
    const selTurn = turns.find(t => t.turnId === selectedTurnId)
    if (selTurn?.isSubagent && selTurn?.subagentSessionId) {
      const bridge = bridges.find(b => b.subagentSessionId === selTurn.subagentSessionId)
      return bridge?.dispatchTurnId ?? null
    }
    return null
  })()

  // Scroll to the targeted turn after expansion + selection are committed
  useEffect(() => {
    if (!scrollToTurnId) return
    const timer = setTimeout(() => {
      const isSub = turns.find(t => t.turnId === scrollToTurnId)?.isSubagent
      const ref = isSub ? selectedSubRef.current : selectedRef.current
      if (ref) ref.scrollIntoView({ behavior: "smooth", block: "nearest" })
    }, 200)
    return () => clearTimeout(timer)
  }, [scrollToTurnId, turns])

  const rootTurns = turns.filter(t => !t.isSubagent)

  const onToggleBridge = (bridgeId: string) => {
    setExpandedSubagents(prev => {
      const next = new Set(prev)
      if (next.has(bridgeId)) next.delete(bridgeId)
      else next.add(bridgeId)
      return next
    })
  }

  // Process command turns: group consecutive command-related turns, parse each group
  const commandInfoMap = new Map<string, { display: string; output: string | null }>()
  let commandGroupTexts: string[] = []
  let commandGroupLeadId: string | null = null

  for (const t of rootTurns) {
    const text = t.contentSummary ?? ""
    const isCmd = isCommandTurn(text)
    const isCav = isCommandCaveat(text)
    const isStd = isCommandStdout(text)

    if (isCmd || isCav || isStd) {
      commandGroupTexts.push(text)
      if (isCmd) commandGroupLeadId = t.turnId
    } else {
      // Flush the group when we hit a non-command turn
      if (commandGroupTexts.length > 0 && commandGroupLeadId) {
        const info = parseCommandTurns(commandGroupTexts)
        commandInfoMap.set(commandGroupLeadId, { display: formatCommandDisplay(info), output: info.output })
      }
      commandGroupTexts = []
      commandGroupLeadId = null
    }
  }
  // Flush any remaining group at end
  if (commandGroupTexts.length > 0 && commandGroupLeadId) {
    const info = parseCommandTurns(commandGroupTexts)
    commandInfoMap.set(commandGroupLeadId, { display: formatCommandDisplay(info), output: info.output })
  }

  // Build display-enhanced root turns: skip caveat/stdout, tag command turns.
  // Then reorder compact groups: opencode assigns the continuation summary a
  // lower turnIndex than the /compact command that produced it, so naive
  // turnIndex order shows the summary BEFORE the command. Swap each adjacent
  // [continuation, /compact command] pair so the command leads its summary.
  const displayRootTurns = (() => {
    const enhanced = rootTurns
      .filter(t => {
        const text = t.contentSummary ?? ""
        // Hide caveat and stdout companion turns
        return !(isCommandCaveat(text) || isCommandStdout(text))
      })
      .map(t => {
        const text = t.contentSummary ?? ""
        if (t.agentName === 'compaction-boundary') {
          return {
            ...t,
            displayRole: "compaction" as string,
            displayContent: text || "/compact",
            commandOutput: null as string | null,
            continuationSummary: null as string | null,
          }
        }
        if (isCommandTurn(text)) {
          const cmdInfo = commandInfoMap.get(t.turnId)
          return {
            ...t,
            displayRole: "command" as string,
            displayContent: cmdInfo?.display ?? "/unknown",
            commandOutput: cmdInfo?.output ?? null,
            continuationSummary: null as string | null,
          }
        }
        // opencode 异步 Task 完成回传：wire 是 user 行但说话的是子代理——
        // 不显示 user 徽标（悬停可见原文与来源子代理）。claude 形态在导入层
        // 已重分类为 system 摘要轮（✅ Task …），同款徽标——文案与泳道
        // 「后台异步派发/background」同一套话术（派发 → 完成闭环）
        if ((t.role === 'user' && isSubagentReturnText(text)) ||
            (t.role === 'system' && isTaskNotificationSummaryText(text))) {
          return {
            ...t,
            displayRole: "subagent-return" as string,
            displayContent: text,
            commandOutput: null as string | null,
            continuationSummary: null as string | null,
          }
        }
        if (isContinuationTurn(text)) {
          const info = parseContinuationTurn(text)
          return {
            ...t,
            displayRole: "continuation" as string,
            displayContent: info.summaryLine ?? "Compact summary",
            commandOutput: null as string | null,
            continuationSummary: info.fullSummary,
          }
        }
        if (t.agentName === 'continuation') {
          const summaryLine = text.split('\n').find(l => l.trim()) ?? "Compact summary"
          return {
            ...t,
            displayRole: "continuation" as string,
            displayContent: summaryLine.substring(0, 120),
            commandOutput: null as string | null,
            continuationSummary: text,
          }
        }
        const displayRole = t.role
        let displayContent = t.contentSummary ?? ""
        if (t.agentName === 'compaction') {
          displayContent = text
        }
        return { ...t, displayRole, displayContent, commandOutput: null as string | null, continuationSummary: null as string | null }
      })
    const result = [...enhanced]
    for (let i = 0; i < result.length - 1; i++) {
      const cur = result[i]
      const next = result[i + 1]
      if (
        cur.displayRole === "continuation" &&
        next.displayRole === "command" &&
        (next.displayContent.includes("/compact") || next.displayContent === "compact")
      ) {
        [result[i], result[i + 1]] = [result[i + 1], result[i]]
        i++
      }
    }
    return result
  })()

  const subTurnsBySession = new Map<string, TurnRowItem[]>()
  for (const t of turns) {
    if (t.isSubagent && t.subagentSessionId) {
      const arr = subTurnsBySession.get(t.subagentSessionId) ?? []
      arr.push(t)
      subTurnsBySession.set(t.subagentSessionId, arr)
    }
  }

  const bridgesByTurnId = new Map<string, BridgeItem[]>()
  for (const b of bridges) {
    if (b.dispatchTurnId) {
      const arr = bridgesByTurnId.get(b.dispatchTurnId) ?? []
      arr.push(b)
      bridgesByTurnId.set(b.dispatchTurnId, arr)
    }
  }

  const subagentBlocksByTurnId = new Map<string, SubagentLane[]>()
  const subagentNumbers = buildSubagentNumbers(turns)
  for (const [turnId, bs] of bridgesByTurnId) {
    const lanes: SubagentLane[] = []
    for (const b of bs) {
      const sid = b.subagentSessionId
      let sturns = sid ? (subTurnsBySession.get(sid) ?? []) : []
      // 复用会话（首发+返工同 sid）：lane 只显示该派发窗口内的 turn，
      // 否则 turn10/turn19 两个 lane 各含全会话 turn，互相包含
      const dMs = b.dispatchTimestamp ? new Date(b.dispatchTimestamp).getTime() : null
      // 上界钳到同 sid 下次派发时刻（ingest [dispatch_i, dispatch_{i+1}) 同口径）：
      // 窗内末条 turn 的 completedAt 可能越过下次派发，不钳会把下窗 turn 吞进来
      let rMs = b.responseTimestamp ? new Date(b.responseTimestamp).getTime() : null
      if (sid && dMs !== null) {
        const next = bridges
          .map(x => x.subagentSessionId === sid && x.dispatchTimestamp ? new Date(x.dispatchTimestamp).getTime() : null)
          .filter((t): t is number => t !== null && t > dMs)
          .sort((x, y) => x - y)[0]
        if (next !== undefined && (rMs === null || rMs > next)) rMs = next
      }
      if (sid && dMs !== null && rMs !== null && sturns.length > 0) {
        const w = sturns.filter(t => {
          const ts = t.createdAt ? new Date(t.createdAt).getTime() : NaN
          return Number.isFinite(ts) && ts >= dMs && ts <= rMs
        })
        if (w.length > 0) sturns = w
      }
      const laneNum = sid ? subagentNumbers.get(sid) : undefined
      lanes.push({
        bridgeId: b.bridgeId,
        sessionId: sid,
        name: (b.agentName ?? b.subagentName ?? b.subagentType ?? "subagent") + (laneNum !== undefined ? ` #${laneNum}` : ""),
        type: b.subagentType,
        background: b.dispatchBackground === true,
        summary: b.dispatchContent,
        turns: sturns,
        status: b.status,
        totalTokens: sturns.reduce((s, t) => s + t.totalTokens, 0) + b.subagentTokens,
        latencyMs: b.subagentLatencyMs,
        turnCount: sturns.length,
      })
    }
    subagentBlocksByTurnId.set(turnId, lanes)
  }

  const filteredRootTurns = displayRootTurns.filter(t => {
    if (filterRole && t.displayRole !== filterRole) return false
    return true
  })

  const rootRoles = [...new Set(displayRootTurns.map(t => t.displayRole))]

  const laneCtx: LaneCtx = {
    subagentBlocksByTurnId,
    expandedSubagents,
    onToggleBridge,
    selectedTurnId,
    onSelectTurn,
    selectedSubRef,
  }

  const handleJump = () => {
    if (!onJumpToTurnIndex) return
    const raw = jumpInput.trim().replace(/^#/, "")
    const idx = parseInt(raw, 10)
    if (!Number.isFinite(idx) || idx <= 0) {
      setJumpNotFound(true)
      return
    }
    const exists = turns.some(t => t.turnIndex === idx)
    if (!exists) {
      setJumpNotFound(true)
      return
    }
    setJumpNotFound(false)
    onJumpToTurnIndex(idx)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-3 py-2 border-b space-y-1.5">
        <div className="flex flex-wrap gap-1.5 items-center">
          <button
            className={cn(
              "px-2 py-1 rounded text-xs font-medium transition-colors",
              !filterRole ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            )}
            onClick={() => setFilterRole(null)}
          >
            All ({displayRootTurns.length})
          </button>
          {rootRoles.map(role => (
            <button
              key={role}
              className={cn(
                "px-2 py-1 rounded text-xs font-medium transition-colors",
                filterRole === role ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
              )}
              onClick={() => setFilterRole(role === filterRole ? null : role)}
            >
              {ROLE_ICONS[role] ?? role} {ROLE_LABELS[role] ?? role} ({displayRootTurns.filter(t => t.displayRole === role).length})
            </button>
          ))}
        </div>

        {onJumpToTurnIndex && (
          <div className="flex gap-1.5">
            <Input
              placeholder="Go to turn #"
              value={jumpInput}
              onChange={(e) => {
                setJumpInput(e.target.value)
                setJumpNotFound(false)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleJump()
                }
              }}
              className={cn(
                "h-6 text-xs w-28 font-mono",
                jumpNotFound && "border-red-500 focus-visible:ring-red-500"
              )}
              inputMode="numeric"
              title="Jump to a turn by its number (e.g. 459 or #459) and scroll it into view. Works for subagent turns too. Press Enter or click Go."
            />
            <button
              type="button"
              onClick={handleJump}
              className="h-6 px-2 rounded text-xs font-medium bg-muted text-muted-foreground hover:bg-accent transition-colors shrink-0"
              title="Jump to a turn by its number (e.g. 459 or #459) and scroll it into view. Works for subagent turns too. Press Enter or click Go."
            >
              Go
            </button>
          </div>
        )}
        {jumpNotFound && (
          <p className="text-xs text-red-500">Turn #{jumpInput.trim().replace(/^#/, "")} not found</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0" ref={containerRef}>
        <div className="px-3 py-2 space-y-1.5">
          {filteredRootTurns.map(turn => {
            const borderColor = ROLE_COLORS[turn.displayRole] ?? "border-l-gray-300 bg-gray-50/50"
            const lanes = subagentBlocksByTurnId.get(turn.turnId) ?? []

            return (
              <div key={turn.turnId} ref={selectedTurnId === turn.turnId || turn.turnId === dispatchTurnIdForSelected ? selectedRef : null}>
                <button

                  className={cn(
                    "w-full text-left rounded-lg border-l-3 p-2.5 transition-colors cursor-pointer",
                    borderColor,
                    selectedTurnId === turn.turnId || turn.turnId === dispatchTurnIdForSelected ? "ring-2 ring-primary/50" : "hover:bg-accent/50"
                  )}
                  onClick={() => onSelectTurn(turn.turnId)}
                >
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <span className="text-xs font-mono text-muted-foreground shrink-0">#{turn.turnIndex}</span>
                    <Badge variant={ROLE_BADGE_VARIANTS[turn.displayRole] ?? "gray"}>
                      {ROLE_ICONS[turn.displayRole] ?? turn.displayRole} {ROLE_LABELS[turn.displayRole] ?? turn.displayRole}
                    </Badge>
                    {turn.toolCalls.length > 0 && (
                      <Badge variant="outline">{turn.toolCalls.length} tools</Badge>
                    )}
                    {/* 子代理徽标与实际渲染的泳道同口径（bridge-builder：失败派发
                        不建桥、无泳道——错误 tool call 在主时间线 verbatim 可见） */}
                    {lanes.length > 0 && (
                      <Badge variant="orange" className="text-xs">🔗 {lanes.length} subagent</Badge>
                    )}
                    {turn.skillEvents.length > 0 && (
                      <Badge variant="yellow" className="text-xs">
                        {turn.skillEvents.length === 1
                          ? `⚡ ${turn.skillEvents[0].skillName}`
                          : `⚡ ${turn.skillEvents[0].skillName} +${turn.skillEvents.length - 1}`}
                      </Badge>
                    )}
                    {turn.agentName === 'compaction' && turn.displayRole !== 'compaction' && (
                      <Badge variant="yellow" className="text-xs">⚡ compact</Badge>
                    )}

                  </div>

                  {turn.displayContent && (
                    <p className="text-xs text-foreground/80 line-clamp-2 mb-1">
                      {turn.displayRole === "command"
                        ? <span className="font-mono font-medium">{turn.displayContent}</span>
                        : turn.displayRole === "continuation"
                          ? <span className="italic">{turn.displayContent}</span>
                          : turn.displayRole === "compaction"
                            ? <span className="font-mono font-medium">{turn.displayContent}</span>
                            : turn.displayContent}
                      {turn.commandOutput && (
                        <span className="block opacity-60 mt-0.5">{turn.commandOutput}</span>
                      )}
                    </p>
                  )}

                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {turn.totalTokens > 0 && (
                      <span>{formatTokenCount(turn.totalTokens)} tokens</span>
                    )}
                    {turn.latencyMs > 0 && (
                      <span>{formatLatency(turn.latencyMs)}</span>
                    )}
                    {turn.model && (
                      <span className="truncate">{turn.model}</span>
                    )}
                  </div>
                </button>

                {lanes.length === 1 && (
                  <div className="ml-4 mt-1 min-w-0">
                    <SubagentLaneView lane={lanes[0]} ctx={laneCtx} />
                  </div>
                )}
                {lanes.length > 1 && (
                  <ParallelSubagentGroup lanes={lanes} ctx={laneCtx} />
                )}
              </div>
            )
          })}

          {filteredRootTurns.length === 0 && displayRootTurns.length > 0 && (
            <div className="text-center text-muted-foreground py-8">
              No turns match the current filters
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
