"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { auditKindsForEvents, MAIN_AGENT_WORKFLOW_NAME, isDispatchOnlyAgent } from "@/lib/sift-audit"
import { SkillCharts } from "@/components/observe/SkillCharts"
import { SkillCoverageCard } from "@/components/observe/SkillCoverageCard"
import { SkillContentAudit } from "@/components/observe/SkillContentAudit"
import { BookOpenIcon } from "lucide-react"
import { useSkillContent } from "@/components/observe/use-skill-content"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"

interface SessionSkillItem {
  skillName: string
  version: number | null
  invocationCount: number
}

interface SkillEventItem {
  id: string
  skillName: string
  skillVersion: number | null
  eventType: string
  success: boolean
  errorMessage: string | null
  durationMs: number
  turnIndex: number
  agentName: string | null
  isSubagent: boolean
  subagentSessionId: string | null
  turnTokens: {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
}

interface SkillDetailProps {
  taskId: string
  sessionSkills: SessionSkillItem[]
  skillEvents: SkillEventItem[]
  /** 主 agent 编排 对账目标是否可用（STATE.md 可恢复 → 顶部合成 root 行）。 */
  hasMainAgentWorkflow?: boolean
  /** 主 agent 编排 的真名（扫盘反查的 identifier）；未取/回退时用合成名。 */
  mainAgentWorkflowName?: string | null
  /** 主 agent 编排 合成行的逐栏数据（dispatch 计数 + 主 agent turn token 汇总）。 */
  mainAgentWorkflowStats?: {
    dispatchCount: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    totalTokens: number
  }
  onNavigateToTurn?: (turnIndex: number) => void
  /** 跳转到 Audit 板块的 Skill 子 tab 并预选该 {name, kind} 进行对账。按行 eventType+isSubagent 路由 kind。 */
  onAuditSkill?: (skillName: string, kind: "skill" | "agent" | "root" | "llm-root") => void
  framework?: string
}

const EVENT_TYPE_BADGE: Record<string, "blue" | "green" | "orange" | "gray"> = {
  load: "blue",
  invoke: "green",
  use: "green",
  unload: "gray",
}

function formatDuration(ms: number): string {
  if (ms === 0) return "0ms"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(n: number): string {
  if (n === 0) return "0"
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

/** 模块级缓存：taskId → LLM 提取状态。切 tab 不 re-fetch，切 session 才重取。 */
const llmExtractCache = new Map<string, { loading: boolean; content: string | null; source: string | null; error: string | null }>();

export function SkillDetail({ taskId, sessionSkills, skillEvents, hasMainAgentWorkflow, mainAgentWorkflowName, mainAgentWorkflowStats, onNavigateToTurn, onAuditSkill, framework }: SkillDetailProps) {
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const sc = useSkillContent(taskId)
  // agent .md 全文用独立实例（磁盘扫描），与 skill SKILL.md（session 注入）分桶，避免同名覆盖。
  const scAgent = useSkillContent(taskId)
  // LLM 提取组合声明（泛化路径：候选收集 + LLM 选择 + 共享装配）：不自动触发，点「提取」才跑。
  const cached = llmExtractCache.get(taskId)
  const [llmLoading, setLlmLoading] = useState(cached ? cached.loading : false)
  const [llmContent, setLlmContent] = useState<string | null>(cached ? cached.content : null)
  const [llmSource, setLlmSource] = useState<string | null>(cached ? cached.source : null)
  const [llmError, setLlmError] = useState<string | null>(cached ? cached.error : null)

  /** 点击「提取/重试」按钮：启动 LLM 组合声明提取 + 轮询（不自动触发，只在用户点击时跑）。
   * force=true（重试）：丢弃已失败的缓存，首发请求带 restart=1 让服务端重启失败的 job。
   * restart=1 只随首发请求走；后续轮询一律 restart=0——若轮询也带 restart=1，
   * 每次轮询都会重启已 settle 的失败 job，且响应恰是重启瞬间的 loading:true，
   * 失败态永远轮不到（表现为「提取中…」无限转圈、服务端每 5s 重 spawn CLI）。 */
  function fetchLlmWorkflow(force = false) {
    const cached = llmExtractCache.get(taskId)
    if (!force) {
      // 已完成缓存（成功或失败）→ 直接展开，不重跑
      if (cached && !cached.loading) {
        setLlmLoading(false)
        setLlmContent(cached.content)
        setLlmSource(cached.source)
        setLlmError(cached.error)
        toggleExpanded("__llm_workflow__")
        return
      }
    }
    if (cached && cached.loading) return // 已在轮询中（force 也不重复启动）

    const initState = { loading: true, content: null, source: null, error: null as string | null }
    llmExtractCache.set(taskId, initState)
    setLlmLoading(true)
    setLlmContent(null)
    setLlmSource(null)
    setLlmError(null)
    toggleExpanded("__llm_workflow__")

    let timer: ReturnType<typeof setTimeout>
    let active = true
    // 重试意图（restart=1）只表达在首发请求；进入轮询后即清零（见函数头注释）。
    let first = true

    const poll = async () => {
      try {
        const r = await fetch(
          `/api/observe/session/llm-workflow-extract?taskId=${encodeURIComponent(taskId)}&framework=${encodeURIComponent(framework ?? "")}&restart=${force && first ? "1" : "0"}`
        )
        first = false
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        if (!active) return

        const state = { loading: !!d.loading, content: d.content ?? null, source: d.source ?? null, error: d.error ?? null }
        llmExtractCache.set(taskId, state)
        setLlmLoading(state.loading)
        setLlmContent(state.content)
        setLlmSource(state.source)
        setLlmError(state.error)

        if (state.loading) timer = setTimeout(poll, 5000)
      } catch (e) {
        if (!active) return
        const msg = e instanceof Error ? e.message : String(e)
        const state = { loading: false, content: null, source: null, error: msg }
        llmExtractCache.set(taskId, state)
        setLlmLoading(false)
        setLlmError(msg)
      }
    }
    poll()

    return () => { active = false; if (timer) clearTimeout(timer) }
  }
  // 主 agent 编排 显示名：真名（扫盘）→ 回退合成名。对账按钮传此 name（与 SkillAuditTab target 一致）。
  // 全文 fetch 仍用 MAIN_AGENT_WORKFLOW_NAME sentinel（skill-content 路由按 sentinel 识别走 STATE.md 恢复）。
  const workflowName = mainAgentWorkflowName || MAIN_AGENT_WORKFLOW_NAME

  function toggleExpanded(skillName: string) {
    setExpandedSkills(prev => {
      const next = new Set(prev)
      if (next.has(skillName)) next.delete(skillName)
      else next.add(skillName)
      return next
    })
  }

  const sharedTurnKeys = (() => {
    const m = new Map<string, number>()
    for (const se of skillEvents) {
      const key = `${se.turnIndex}-${se.isSubagent}`
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
  })()

  const allSkillAggregates = (() => {
    const byName = new Map<string, {
      skillName: string
      version: number | null
      invocationCount: number
      totalEvents: number
      successCount: number
      failCount: number
      avgDuration: number
      totalTokens: number
      inputTokens: number
      outputTokens: number
      reasoningTokens: number
      cacheReadTokens: number
      events: SkillEventItem[]
    }>()

    for (const ss of sessionSkills) {
      const events = skillEvents.filter(se => se.skillName === ss.skillName)
      const invokeEvents = events.filter(se => se.eventType === "invoke" || se.eventType === "use")
      const successCount = events.filter(se => se.success).length
      const failCount = events.filter(se => !se.success).length
      const avgDuration = invokeEvents.length > 0
        ? Math.round(invokeEvents.reduce((sum, e) => sum + e.durationMs, 0) / invokeEvents.length)
        : 0
      const totalTokens = events.reduce((sum, e) => sum + e.turnTokens.totalTokens, 0)
      const inputTokens = events.reduce((sum, e) => sum + e.turnTokens.inputTokens, 0)
      const outputTokens = events.reduce((sum, e) => sum + e.turnTokens.outputTokens, 0)
      const reasoningTokens = events.reduce((sum, e) => sum + e.turnTokens.reasoningTokens, 0)
      const cacheReadTokens = events.reduce((sum, e) => sum + e.turnTokens.cacheReadTokens, 0)

      byName.set(ss.skillName, {
        skillName: ss.skillName,
        version: ss.version ?? events[0]?.skillVersion ?? null,
        invocationCount: ss.invocationCount,
        totalEvents: events.length,
        successCount,
        failCount,
        avgDuration,
        totalTokens,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        events,
      })
    }

    for (const se of skillEvents) {
      if (byName.has(se.skillName)) continue
      byName.set(se.skillName, {
        skillName: se.skillName,
        version: se.skillVersion ?? null,
        invocationCount: 1,
        totalEvents: 1,
        successCount: se.success ? 1 : 0,
        failCount: se.success ? 0 : 1,
        avgDuration: se.durationMs,
        totalTokens: se.turnTokens.totalTokens,
        inputTokens: se.turnTokens.inputTokens,
        outputTokens: se.turnTokens.outputTokens,
        reasoningTokens: se.turnTokens.reasoningTokens,
        cacheReadTokens: se.turnTokens.cacheReadTokens,
        events: [se],
      })
    }

    return Array.from(byName.values())
  })()

  // Skills + subagent（dispatch）都展示：invoke/use 的 skill 行 + dispatch-only 的 agent 行。
  // 与 Audit 的 skill/agent 划分对齐：auditKindsForEvents 按行 events 路由对账按钮 kind。
  const skillAggregates = allSkillAggregates

  const skillNames = skillAggregates.map(s => s.skillName)

  // 图表同表一致：全部展示。
  const chartSkillEvents = skillEvents

  if (skillAggregates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground">
        <span>No skill data found</span>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3">
        <Badge variant="outline">Skills</Badge>
        <span className="text-sm text-muted-foreground">
          {skillAggregates.length} skills/agents, {skillEvents.length} events
        </span>
      </div>

      <SkillCoverageCard taskId={taskId} framework={framework} />

      <SkillCharts taskId={taskId} skillEvents={chartSkillEvents} />

      <Card size="sm">
        <CardHeader>
          <CardTitle>Skill Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs"></TableHead>
                <TableHead className="text-xs">Skill Name</TableHead>
                <TableHead className="text-xs">Version</TableHead>
                <TableHead className="text-xs">Invocations</TableHead>
                <TableHead className="text-xs">Success</TableHead>
                <TableHead className="text-xs">Fail</TableHead>
                <TableHead className="text-xs">Avg Duration</TableHead>
                <TableHead className="text-xs">Input Tok</TableHead>
                <TableHead className="text-xs">Output Tok</TableHead>
                <TableHead className="text-xs">Reason Tok</TableHead>
                  <TableHead className="text-xs">Cache Read Tok</TableHead>
                  <TableHead className="text-xs">Total Tok</TableHead>
                  <TableHead className="text-xs w-28 text-center">全文</TableHead>
                  <TableHead className="text-xs">对账</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
              {hasMainAgentWorkflow && onAuditSkill && [
                <TableRow key="__main_agent_workflow__" className="bg-amber-500/5">
                  <TableCell className="text-xs select-none w-6">◆</TableCell>
                  <TableCell className="text-xs font-medium truncate max-w-[20ch]" title={workflowName}>
                    <div className="flex items-center gap-1">
                      <Badge variant="yellow" className="h-4 px-1 text-[10px] shrink-0">root</Badge>
                      <span className="truncate">workflow</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">N/A</TableCell>
                  <TableCell className="text-xs tabular-nums" title="主 agent 的 dispatch 次数（编排动作数）">
                    {mainAgentWorkflowStats?.dispatchCount ?? 0}
                  </TableCell>
                  <TableCell><span className="text-muted-foreground">—</span></TableCell>
                  <TableCell><span className="text-muted-foreground">—</span></TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">N/A</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatTokens(mainAgentWorkflowStats?.inputTokens ?? 0)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatTokens(mainAgentWorkflowStats?.outputTokens ?? 0)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatTokens(mainAgentWorkflowStats?.reasoningTokens ?? 0)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatTokens(mainAgentWorkflowStats?.cacheReadTokens ?? 0)}</TableCell>
                  <TableCell className="text-xs tabular-nums font-medium">{formatTokens(mainAgentWorkflowStats?.totalTokens ?? 0)}</TableCell>
                  <TableCell className="text-right w-20">
                    <span
                      role="button"
                      title="查看主 agent 编排 组合声明全文（规程层编排规程 + 计划层任务计划）"
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold border transition-colors ${
                        sc.content.has(MAIN_AGENT_WORKFLOW_NAME) || sc.error.has(MAIN_AGENT_WORKFLOW_NAME)
                          ? "border-amber-500 bg-amber-500/25 text-amber-700 dark:text-amber-200"
                          : "border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300 hover:bg-amber-500/25 hover:border-amber-500"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (sc.content.has(MAIN_AGENT_WORKFLOW_NAME) || sc.error.has(MAIN_AGENT_WORKFLOW_NAME)) {
                          sc.clear(MAIN_AGENT_WORKFLOW_NAME)
                        } else if (!sc.loading.has(MAIN_AGENT_WORKFLOW_NAME)) {
                          sc.fetchOne(MAIN_AGENT_WORKFLOW_NAME)
                        }
                      }}
                    >
                      <BookOpenIcon className="size-3" />
                      {sc.loading.has(MAIN_AGENT_WORKFLOW_NAME) ? "加载中…" : (sc.content.has(MAIN_AGENT_WORKFLOW_NAME) || sc.error.has(MAIN_AGENT_WORKFLOW_NAME)) ? "收起" : "全文"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-6 px-2"
                      title="跳转到 Audit · Skill 子 tab 用 --kind root 对账主 agent 编排（组合声明 = 规程层 + 计划层）"
                      onClick={(e) => { e.stopPropagation(); onAuditSkill(workflowName, "root") }}
                    >
                      root ↗
                    </Button>
                  </TableCell>
                </TableRow>,
                (sc.content.has(MAIN_AGENT_WORKFLOW_NAME) || sc.error.has(MAIN_AGENT_WORKFLOW_NAME)) && (
                  <TableRow key="__main_agent_workflow__-content">
                    <TableCell colSpan={14} className="p-3 bg-amber-500/5 border-x border-amber-400/30">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                            <BookOpenIcon className="size-3.5" />
                            workflow 声明
                            {sc.content.get(MAIN_AGENT_WORKFLOW_NAME)?.source && (
                              <span className="text-muted-foreground">
                                （来源：{sc.content.get(MAIN_AGENT_WORKFLOW_NAME)?.source}，{sc.content.get(MAIN_AGENT_WORKFLOW_NAME)?.length} 字符）
                              </span>
                            )}
                          </span>
                          <span className="flex items-center gap-3">
                            {sc.content.get(MAIN_AGENT_WORKFLOW_NAME)?.content && (
                              <span
                                role="button"
                                className="text-xs font-medium text-blue-500 cursor-pointer hover:underline"
                                onClick={(e) => { e.stopPropagation(); sc.download(MAIN_AGENT_WORKFLOW_NAME) }}
                              >
                                Download
                              </span>
                            )}
                            <span
                              role="button"
                              title="收起"
                              className="text-muted-foreground cursor-pointer hover:text-foreground text-sm leading-none px-1"
                              onClick={(e) => { e.stopPropagation(); sc.clear(MAIN_AGENT_WORKFLOW_NAME) }}
                            >
                              ×
                            </span>
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground leading-snug">
                          主 agent 的 workflow 组合声明：规程层（skill resources / SKILL.md body / turn0 注入）+ 计划层（STATE.md 等计划文件的 Read）分层拼接。即 --kind root 对账所用的声明（同时审编排纪律遵循度 + 任务完成度）。
                        </div>
                        {sc.error.get(MAIN_AGENT_WORKFLOW_NAME) ? (
                          <div className="text-xs text-destructive">Error: {sc.error.get(MAIN_AGENT_WORKFLOW_NAME)}</div>
                        ) : sc.content.get(MAIN_AGENT_WORKFLOW_NAME)?.content ? (
                          <pre className="max-h-[28rem] overflow-auto rounded border bg-background p-2 text-xs font-mono whitespace-pre-wrap break-words">
                            {sc.content.get(MAIN_AGENT_WORKFLOW_NAME)?.content}
                          </pre>
                        ) : (
                          <div className="text-xs text-muted-foreground">此 session 无可恢复的 workflow 声明（规程层与计划层皆无，跳过 root 目标）。</div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              ]}
              {onAuditSkill && [
                <TableRow key="__llm_workflow__" className="bg-amber-500/5">
                  <TableCell className="text-xs select-none w-6">◆</TableCell>
                  <TableCell className="text-xs font-medium truncate max-w-[20ch]" title={`${workflowName}（LLM）`}>
                    <div className="flex items-center gap-1">
                      <Badge variant="yellow" className="h-4 px-1 text-[10px] shrink-0">llm</Badge>
                      <span className="truncate">workflow（LLM提取）</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">N/A</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">—</TableCell>
                  <TableCell><span className="text-muted-foreground">—</span></TableCell>
                  <TableCell><span className="text-muted-foreground">—</span></TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">N/A</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">—</TableCell>
                  <TableCell className="text-right w-20">
                    {llmLoading ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold border border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300 animate-pulse">
                        提取中…
                      </span>
                    ) : llmContent ? (
                      <span
                        role="button"
                        title="查看 LLM 提取的组合声明全文（规程层 + 计划层）"
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold border transition-colors ${
                          expandedSkills.has("__llm_workflow__")
                            ? "border-amber-500 bg-amber-500/25 text-amber-700 dark:text-amber-200"
                            : "border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300 hover:bg-amber-500/25 hover:border-amber-500"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleExpanded("__llm_workflow__")
                        }}
                      >
                        <BookOpenIcon className="size-3" />
                        {expandedSkills.has("__llm_workflow__") ? "收起" : "全文"}
                      </span>
                    ) : (
                      <span
                        role="button"
                        title={llmError ? (llmError + "（点击重试）") : "点击用 LLM（claude CLI）从 session 选择提取组合声明（规程层 + 计划层，泛化路径，不依赖领域插件）"}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold border border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300 hover:bg-amber-500/25 hover:border-amber-500 cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); fetchLlmWorkflow(!!llmError) }}
                      >
                        {llmError ? "重试" : "提取"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-6 px-2"
                      title="跳转到 Audit · Skill 子 tab 用 --kind root + LLM 提取组合声明（泛化路径：LLM 从候选中选择，与确定性/插件提取对比）"
                      onClick={(e) => { e.stopPropagation(); onAuditSkill(`${workflowName}（LLM）`, "llm-root") }}
                    >
                      llm-root ↗
                    </Button>
                  </TableCell>
                </TableRow>,
                !llmLoading && llmContent && expandedSkills.has("__llm_workflow__") && (
                  <TableRow key="__llm_workflow__-content">
                    <TableCell colSpan={14} className="p-3 bg-amber-500/5 border-x border-amber-400/30">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                            <BookOpenIcon className="size-3.5" />
                            workflow（LLM提取）· 组合声明
                            <span className="text-muted-foreground">
                              （来源：claude CLI LLM 选择提取{llmSource ? `，${llmSource}` : ""}，{llmContent.length} 字符）
                            </span>
                          </span>
                          <span className="flex items-center gap-3">
                            <span
                              role="button"
                              className="text-xs font-medium text-blue-500 cursor-pointer hover:underline"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (llmContent) {
                                  const blob = new Blob([llmContent], { type: "text/plain;charset=utf-8" })
                                  const url = URL.createObjectURL(blob)
                                  const a = window.document.createElement("a")
                                  a.href = url
                                  a.download = `${workflowName.replace(/[^a-zA-Z0-9_-]/g, "_")}.LLM.md`
                                  window.document.body.appendChild(a)
                                  a.click()
                                  window.document.body.removeChild(a)
                                  URL.revokeObjectURL(url)
                                }
                              }}
                            >
                              Download
                            </span>
                            <span
                              role="button"
                              title="收起"
                              className="text-muted-foreground cursor-pointer hover:text-foreground text-sm leading-none px-1"
                              onClick={(e) => { e.stopPropagation(); toggleExpanded("__llm_workflow__") }}
                            >
                              ×
                            </span>
                          </span>
                        </div>
                        <pre className="max-h-[28rem] overflow-auto rounded border bg-background p-2 text-xs font-mono whitespace-pre-wrap break-words">
                          {llmContent}
                        </pre>
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              ]}
              {skillAggregates.map(sa => {
                const isExpanded = expandedSkills.has(sa.skillName)
                const isAgentOnly = isDispatchOnlyAgent(sa.events)
                const kinds = auditKindsForEvents(sa.events)
                const hasAgentMd = kinds.includes("agent")
                const rows = [
                  <TableRow key={sa.skillName}>
                    <TableCell className="text-xs w-6">
                      <span
                        role="button"
                        tabIndex={0}
                        className="inline-flex items-center justify-center px-1 py-1 -ml-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer select-none"
                        onClick={() => toggleExpanded(sa.skillName)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpanded(sa.skillName) }}
                      >
                        {isExpanded ? "▼" : "▶"}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs font-medium truncate max-w-[20ch]">
                      {sa.skillName}
                    </TableCell>
                    <TableCell className="text-xs">{sa.version != null ? `v${sa.version}` : "N/A"}</TableCell>
                    <TableCell className="text-xs tabular-nums">{sa.invocationCount}</TableCell>
                    <TableCell>
                      <Badge variant="green">{sa.successCount}</Badge>
                    </TableCell>
                    <TableCell>
                      {sa.failCount > 0 ? (
                        <Badge variant="red">{sa.failCount}</Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {sa.avgDuration > 0 ? formatDuration(sa.avgDuration) : "N/A"}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{formatTokens(sa.inputTokens)}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatTokens(sa.outputTokens)}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatTokens(sa.reasoningTokens)}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatTokens(sa.cacheReadTokens)}</TableCell>
                    <TableCell className="text-xs tabular-nums font-medium">
                      {formatTokens(sa.totalTokens)}
                      {(() => {
                        const hasShared = sa.events.some(se => {
                          const k = `${se.turnIndex}-${se.isSubagent}`
                          return (sharedTurnKeys.get(k) ?? 0) > 1
                        })
                        if (hasShared) return (
                          <Tooltip>
                            <TooltipTrigger render={<Badge variant="outline" className="text-xs ml-1 cursor-help">shared</Badge>} delay={0} closeDelay={0} />
                            <TooltipContent side="top">Token 总和包含被多个 Skill 共享的 Turn 的完整消耗，不精确。同一个 Turn 里的多个 Skill 调用共享该 Turn 的全部 Token，无法单独计算。</TooltipContent>
                          </Tooltip>
                        )
                        return null
                      })()}
                    </TableCell>
                    <TableCell className="text-right w-28">
                      {/* skill 全文（session 里 Skill invoke 的 SKILL.md body）；isAgentOnly 无 skill kind 不显 */}
                      {!isAgentOnly && (() => {
                        const loaded = sc.content.has(sa.skillName) || sc.error.has(sa.skillName)
                        return (
                          <span
                            role="button"
                            title="查看 SKILL.md 全文（session 注入内容）"
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold border transition-colors ${
                              loaded
                                ? "border-teal-500 bg-teal-500/25 text-teal-700 dark:text-teal-200"
                                : "border-teal-500/50 bg-teal-500/15 text-teal-600 dark:text-teal-300 hover:bg-teal-500/25 hover:border-teal-500"
                            } ${sc.loading.has(sa.skillName) ? "animate-pulse" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (loaded) sc.clear(sa.skillName)
                              else if (!sc.loading.has(sa.skillName)) sc.fetchOne(sa.skillName)
                            }}
                          >
                            <BookOpenIcon className="size-3" />
                            {sc.loading.has(sa.skillName) ? "加载中…" : loaded ? "收起" : "全文"}
                          </span>
                        )
                      })()}
                      {/* agent .md 全文（单一入口）：会话恢复（system 注入）为主数据、磁盘扫描兜底，两级优先由服务端内置；有 agent kind 才显 */}
                      {hasAgentMd && (() => {
                        const k = `agent:${sa.skillName}`
                        const loaded = scAgent.content.has(k) || scAgent.error.has(k)
                        return (
                          <span
                            role="button"
                            title="查看 agent .md 全文（优先从会话恢复——子代理运行时 system 注入的声明原文，即当时真正生效的版本；会话无该 agent 注入数据时兜底磁盘扫描当前文件）"
                            className={`ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold border transition-colors ${
                              loaded
                                ? "border-purple-500 bg-purple-500/25 text-purple-700 dark:text-purple-200"
                                : "border-purple-500/50 bg-purple-500/15 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25 hover:border-purple-500"
                            } ${scAgent.loading.has(k) ? "animate-pulse" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (loaded) scAgent.clear(k)
                              else if (!scAgent.loading.has(k)) scAgent.fetchAgent(sa.skillName, framework)
                            }}
                          >
                            <BookOpenIcon className="size-3" />
                            {scAgent.loading.has(k) ? "加载中…" : loaded ? "收起" : "全文"}
                          </span>
                        )
                      })()}
                    </TableCell>
                    <TableCell className="text-xs">
                      {onAuditSkill && kinds.map(k => (
                        <Button
                          key={k}
                          size="sm"
                          variant="ghost"
                          className="text-xs h-6 px-2"
                          title={`跳转到 Audit · Skill 子 tab 对账此 ${k}（${k === "agent" ? ".md 磁盘扫描" : "正文从 session 恢复"}）`}
                          onClick={(e) => { e.stopPropagation(); onAuditSkill(sa.skillName, k) }}
                        >
                          {k} ↗
                        </Button>
                      ))}
                    </TableCell>
                  </TableRow>,
                ]
                // skill 全文内容行（teal, session 注入的 SKILL.md body）；isAgentOnly 无 skill kind 跳过
                const skillContentData = !isAgentOnly ? sc.content.get(sa.skillName) : undefined
                const skillContentError = !isAgentOnly ? sc.error.get(sa.skillName) : undefined
                if (skillContentData || skillContentError) {
                  rows.push(
                    <TableRow key={`${sa.skillName}-content`}>
                      <TableCell colSpan={14} className="p-3 border-x bg-teal-500/5 border-teal-400/30">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 dark:text-teal-400">
                              <BookOpenIcon className="size-3.5" />
                              {sa.skillName} · SKILL.md
                              {skillContentData?.source && (
                                <span className="text-muted-foreground">
                                  （来源：{skillContentData.source === "skill-tool" ? "Skill 工具注入" : "Read 读取"}，{skillContentData.length} 字符
                                  {skillContentData.source === "read"
                                    ? skillContentData.fullRead
                                      ? "，判定全文·无 offset/limit"
                                      : "，部分读取·有 offset/limit 或截断"
                                    : "，框架注入全文"}
                                  {skillContentData.maxLine != null && `，到第 ${skillContentData.maxLine} 行`}）
                                </span>
                              )}
                            </span>
                            <span className="flex items-center gap-3">
                              {skillContentData?.content && (
                                <span
                                  role="button"
                                  className="text-xs font-medium text-blue-500 cursor-pointer hover:underline"
                                  onClick={(e) => { e.stopPropagation(); sc.download(sa.skillName) }}
                                >
                                  Download
                                </span>
                              )}
                              <span
                                role="button"
                                title="收起"
                                className="text-muted-foreground cursor-pointer hover:text-foreground text-sm leading-none px-1"
                                onClick={(e) => { e.stopPropagation(); sc.clear(sa.skillName) }}
                              >
                                ×
                              </span>
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground leading-snug">
                            按时间顺序取本会话内该 skill 的注入内容或 SKILL.md 读取结果；若多次加载，取最长版本。仅含已采集内容，非运行时实时文件。
                          </div>
                          {skillContentError ? (
                            <div className="text-xs text-destructive">Error: {skillContentError}</div>
                          ) : skillContentData?.content ? (
                            <pre className="max-h-[28rem] overflow-auto rounded border bg-background p-2 text-xs font-mono whitespace-pre-wrap break-words">
                              {skillContentData.content}
                            </pre>
                          ) : (
                            <div className="text-xs text-muted-foreground">未采集到该 skill 的 SKILL.md 内容（本会话可能未通过 Skill 工具加载或读取 SKILL.md）。</div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                }
                // agent .md 全文内容行（单一入口，自适应来源）：会话恢复（orange，system 注入）为主，
                // 磁盘兜底（purple）时以 via 区分并提示差异说明；有 agent kind 才显（isAgentOnly 或 dual）
                const agentKey = `agent:${sa.skillName}`
                const agentData = hasAgentMd ? scAgent.content.get(agentKey) : undefined
                const agentError = hasAgentMd ? scAgent.error.get(agentKey) : undefined
                if (agentData || agentError) {
                  const viaDisk = agentData?.via === "disk"
                  rows.push(
                    <TableRow key={`${sa.skillName}-agent-content`}>
                      <TableCell
                        colSpan={14}
                        className={
                          viaDisk
                            ? "p-3 border-x bg-purple-500/5 border-purple-400/30"
                            : "p-3 border-x bg-orange-500/5 border-orange-400/30"
                        }
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span
                              className={`inline-flex items-center gap-1 text-xs font-medium ${
                                viaDisk
                                  ? "text-purple-600 dark:text-purple-400"
                                  : "text-orange-600 dark:text-orange-400"
                              }`}
                            >
                              <BookOpenIcon className="size-3.5" />
                              {sa.skillName} · agent.md
                              <span className="text-muted-foreground font-normal">
                                {viaDisk ? "〔磁盘兜底〕" : "〔会话恢复〕"}
                              </span>
                              {agentData?.source && (
                                <span className="text-muted-foreground">
                                  （{agentData.source}，{agentData.length} 字符）
                                </span>
                              )}
                            </span>
                            <span className="flex items-center gap-3">
                              {agentData?.content && (
                                <span
                                  role="button"
                                  className="text-xs font-medium text-blue-500 cursor-pointer hover:underline"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const blob = new Blob([agentData.content!], { type: "text/plain;charset=utf-8" })
                                    const url = URL.createObjectURL(blob)
                                    const a = window.document.createElement("a")
                                    a.href = url
                                    a.download = `${sa.skillName.replace(/[^a-zA-Z0-9_-]/g, "_")}.${viaDisk ? "disk" : "session"}.agent.md`
                                    window.document.body.appendChild(a)
                                    a.click()
                                    window.document.body.removeChild(a)
                                    URL.revokeObjectURL(url)
                                  }}
                                >
                                  Download
                                </span>
                              )}
                              <span
                                role="button"
                                title="收起"
                                className="text-muted-foreground cursor-pointer hover:text-foreground text-sm leading-none px-1"
                                onClick={(e) => { e.stopPropagation(); scAgent.clear(agentKey) }}
                              >
                                ×
                              </span>
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground leading-snug">
                            {viaDisk
                              ? "会话内无该 agent 的声明注入数据（如 opencode 工作流派发的 general 子代理），兜底从本地 AGENTS_SCAN_ROOT 扫描 agents/ 目录读当前文件——多插件同名按本会话派发覆盖 + 字母序消歧，可能与运行时实际版本不同。"
                              : "从会话子代理捕获的 system 注入恢复——运行时真正生效的声明原文：远端机器当时的版本，文件事后被改/被删仍还原历史原貌，多插件同名以当时实际注入的那份为准（已剥运行时附加块）。"}
                          </div>
                          {agentError ? (
                            <div className="text-xs text-destructive">Error: {agentError}</div>
                          ) : agentData?.content ? (
                            <pre className="max-h-[28rem] overflow-auto rounded border bg-background p-2 text-xs font-mono whitespace-pre-wrap break-words">
                              {agentData.content}
                            </pre>
                          ) : (
                            <div className="text-xs text-muted-foreground">会话与磁盘均未恢复到该 agent 的 .md（会话无该 agent 的 system 注入，且扫描根下 agents/ 目录无此文件）。</div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                }
                if (isExpanded) {
                  rows.push(
                    <TableRow key={`${sa.skillName}-detail`}>
                      <TableCell colSpan={14} className="p-3 bg-muted/20">
                        {sa.events.length === 0 ? (
                          <div className="text-sm text-muted-foreground">No events recorded</div>
                        ) : (
                          <div className="space-y-1.5">
                            {sa.events.map(se => {
                              const turnKey = `${se.turnIndex}-${se.isSubagent}`
                              const isSharedTurn = (sharedTurnKeys.get(turnKey) ?? 0) > 1
                              return (
                                <div key={se.id} className={cn(
                                  "flex items-center gap-2 px-2 py-1.5 border rounded-md text-sm",
                                  se.success ? "bg-emerald-50/30 dark:bg-emerald-500/5" : "bg-red-50/30 dark:bg-red-500/5"
                                )}>
                                  <span className="text-xs text-muted-foreground">Turn {onNavigateToTurn ? <button className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer" onClick={(e) => { e.stopPropagation(); onNavigateToTurn(se.turnIndex) }}>{se.turnIndex}</button> : se.turnIndex} · Agent: {se.agentName ?? "root"}{se.isSubagent ? " (sub)" : ""}</span>
                                  <Badge variant={EVENT_TYPE_BADGE[se.eventType] ?? "gray"}>
                                    {se.eventType}
                                  </Badge>
                                  <Badge variant={se.success ? "green" : "red"}>
                                    {se.success ? "ok" : "fail"}
                                  </Badge>
                                  {isSharedTurn && (
                                    <Tooltip>
                                      <TooltipTrigger render={<Badge variant="outline" className="text-xs cursor-help">shared</Badge>} delay={0} closeDelay={0} />
                                      <TooltipContent side="top">Token 数为整个 Turn 的消耗，不精确。该 Turn 内还有其他 Skill 调用共享了这些 Token，无法单独计算本 Skill 的精确消耗。</TooltipContent>
                                    </Tooltip>
                                  )}
                                  {se.skillVersion != null && (
                                    <span className="text-xs text-muted-foreground">v{se.skillVersion}</span>
                                  )}
                                  {se.durationMs > 0 && (
                                    <span className="text-xs text-muted-foreground">{formatDuration(se.durationMs)}</span>
                                  )}
                                  {se.turnTokens.totalTokens > 0 && (
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                      {formatTokens(se.turnTokens.totalTokens)} tok ({formatTokens(se.turnTokens.inputTokens)} in / {formatTokens(se.turnTokens.outputTokens)} out / {formatTokens(se.turnTokens.reasoningTokens)} reason / {formatTokens(se.turnTokens.cacheReadTokens)} cache)
                                    </span>
                                  )}
                                  {se.errorMessage && (
                                    <span className="text-xs text-red-600 dark:text-red-400 truncate">{se.errorMessage}</span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                }
                return rows
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SkillContentAudit
        taskId={taskId}
        skillNames={skillNames}
        onView={(skillName) => {
          if (!expandedSkills.has(skillName)) {
            setExpandedSkills(prev => new Set(prev).add(skillName))
          }
          if (!sc.content.has(skillName) && !sc.error.has(skillName) && !sc.loading.has(skillName)) {
            sc.fetchOne(skillName)
          }
        }}
      />
    </div>
  )
}
