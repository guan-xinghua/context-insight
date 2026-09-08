"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { WorkflowFlowChart, type Analysis } from "./WorkflowFlowChart"
import { WorkflowAgentAudit, isV4Analysis, type V4Analysis } from "./WorkflowAgentAudit"
import { AIProviderConfigPanel } from "./AIProviderConfigPanel"
import { loadProviderConfig, subscribeProviderConfig, getProviderConfigSnapshot, getProviderConfigServerSnapshot } from "@/lib/ai-provider-config"
import {
  subscribeAgentVersion,
  getAgentVersionSnapshot,
  getAgentVersionServerSnapshot,
  saveAgentVersion,
  type AgentVersion,
} from "@/lib/agent-version"
import {
  subscribeAuditJob,
  getAuditJobSnapshot,
  getAuditJobServerSnapshot,
  startAuditJob,
  type FailedAuditReport,
} from "@/lib/audit-job"
import { buildAuditExportPayload } from "@/lib/audit-export"

const STORAGE_KEY = (taskId: string) => `wf-analysis-${taskId}`

function isAnalysis(obj: unknown): obj is Analysis {
  return !!obj && typeof obj === "object" && Array.isArray((obj as { flow?: unknown }).flow)
}

function isFailedAuditReport(obj: unknown): obj is FailedAuditReport {
  return !!obj && typeof obj === "object" && (obj as { reportKind?: unknown }).reportKind === "audit-failure"
}

function isAnyAnalysis(obj: unknown): obj is Analysis | V4Analysis | FailedAuditReport {
  return isAnalysis(obj) || isV4Analysis(obj) || isFailedAuditReport(obj)
}

function versionLabel(v: AgentVersion): string {
  if (v === "v4") return "agent v4（agent 中心·三维度，claude code 本地）"
  if (v === "v3") return "agent v3（claude code 本地，15 分钟超时）"
  if (v === "v2") return "agent v2（含压缩）"
  return "agent v1"
}

// Same-tab localStorage writes don't fire the `storage` event, so writes call emit()
// to notify useSyncExternalStore subscribers to re-read.
const listeners = new Set<() => void>()
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function emit() {
  for (const l of listeners) l()
}

interface Props {
  taskId: string
  framework?: string
  onJumpToTurn?: (turn: number) => void
}

export function WorkflowAnalyseTab({ taskId, framework, onJumpToTurn }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const job = useSyncExternalStore(
    subscribeAuditJob,
    () => getAuditJobSnapshot(taskId),
    getAuditJobServerSnapshot,
  )
  const generating = job.generating
  const genError = job.genError
  const progress = job.progress
  const elapsed = job.elapsed

  const agentVersion = useSyncExternalStore(
    subscribeAgentVersion,
    getAgentVersionSnapshot,
    getAgentVersionServerSnapshot,
  ) as AgentVersion

  const providerRaw = useSyncExternalStore(
    subscribeProviderConfig,
    getProviderConfigSnapshot,
    getProviderConfigServerSnapshot,
  )
  const hasConfig = useMemo(() => {
    if (!providerRaw) return false
    try {
      const c = JSON.parse(providerRaw) as { apiKey?: string; baseUrl?: string; model?: string }
      return !!(c.apiKey && c.baseUrl && c.model)
    } catch {
      return false
    }
  }, [providerRaw])

  function setAgentVersion(v: AgentVersion) {
    saveAgentVersion(v)
  }

  const raw = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(STORAGE_KEY(taskId)),
    () => null,
  )
  const analysis = useMemo<Analysis | V4Analysis | FailedAuditReport | null>(() => {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return isAnyAnalysis(parsed) ? parsed : null
    } catch {
      return null
    }
  }, [raw])

  function persist(json: string) {
    localStorage.setItem(STORAGE_KEY(taskId), json)
    emit()
  }

  function loadJson(raw: string) {
    setError(null)
    setExportMsg(null)
    try {
      const trimmed = raw.trim()
      const parsed = JSON.parse(trimmed)
      if (!isAnyAnalysis(parsed)) {
        setError("JSON 不是受支持的成功或失败审计报告格式")
        return
      }
      persist(trimmed)
    } catch (e) {
      setError(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function onFilePicked(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      loadJson(result)
    }
    reader.onerror = () => setError("文件读取失败")
    reader.readAsText(f)
    e.target.value = ""
  }

  function clearSaved() {
    localStorage.removeItem(STORAGE_KEY(taskId))
    emit()
    setError(null)
    setExportMsg(null)
  }

  function generateAudit() {
    startAuditJob({
      taskId,
      framework,
      agentVersion,
      provider: loadProviderConfig() ?? { apiKey: "", baseUrl: "", model: "" },
      onResult: (a) => persist(JSON.stringify(a)),
    })
  }

  async function exportAudit() {
    if (exporting || !analysis) return
    setExporting(true)
    setExportMsg(null)
    setError(null)
    const { text, defaultName, mime } = buildAuditExportPayload(taskId, analysis)
    const blob = new Blob([text], { type: mime })
    try {
      const picker = typeof window !== "undefined"
        ? (window as Window & { showSaveFilePicker?: (options: { suggestedName?: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ name: string; createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker
        : undefined
      if (typeof picker === "function") {
        try {
          const handle = await picker({
            suggestedName: defaultName,
            types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          setExportMsg(`已导出到 ${handle.name}`)
          return
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === "AbortError") return
          throw e
        }
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = defaultName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      setExportMsg(`已下载 ${defaultName}`)
    } catch (e) {
      setError(e instanceof Error ? `导出失败：${e.message}` : "导出失败")
    } finally {
      setExporting(false)
    }
  }

  if (analysis) {
    return (
      <div className="h-full overflow-auto">
        {!hasConfig && (
          <div className="px-4 py-2 border-b bg-amber-50 dark:bg-amber-500/10 space-y-1">
            <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">未配置 LLM API，重新生成审计报告前需先保存配置</p>
            <AIProviderConfigPanel compact />
          </div>
        )}
        <div className="flex items-center justify-between px-4 py-2 border-b sticky top-0 bg-background z-10">
          <p className="text-xs text-muted-foreground">
            分析数据存于 localStorage（按 session 隔离）。
          </p>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border p-0.5">
              {(["v1", "v2", "v3", "v4"] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setAgentVersion(v)}
                  className={cn(
                    "px-2 py-0.5 text-xs rounded transition-colors",
                    agentVersion === v
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            <Button variant="default" size="sm" onClick={generateAudit} disabled={generating}>
              {generating ? "生成中…" : "重新生成审计报告"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>从文件导入</Button>
            <Button variant="outline" size="sm" onClick={exportAudit} disabled={exporting}>
              {exporting ? "导出中…" : "导出到文件"}
            </Button>
            <Button variant="outline" size="sm" onClick={clearSaved}>清除</Button>
            {exportMsg && <span className="text-xs text-emerald-600 dark:text-emerald-400">{exportMsg}</span>}
          </div>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFilePicked} />
        </div>
        {(generating || genError) && (
          <div className="px-4 py-2 border-b bg-accent/20 text-xs space-y-1">
            {generating && (
              <>
                <div className="font-medium text-foreground flex items-center gap-2">
                  生成中… <span className="tabular-nums text-muted-foreground">{elapsed}s</span>
                  <span className="text-muted-foreground">（{versionLabel(agentVersion)}，约 5-20 分钟）</span>
                </div>
                <div className="text-amber-700 dark:text-amber-400">
                  新报告生成中；下方暂时展示历史报告，成功后会自动替换。
                </div>
                {progress.map((p, i) => (
                  <div key={i} className="text-muted-foreground flex gap-1.5">
                    <span className="text-muted-foreground/40">→</span>
                    <span>{p.msg}</span>
                  </div>
                ))}
              </>
            )}
            {genError && (
              <>
                <div className="text-red-600">生成失败：{genError}</div>
                <div className="text-amber-700 dark:text-amber-400">
                  本次失败报告已写入浏览器，可查看进度详情或导出排查。
                </div>
              </>
            )}
          </div>
        )}
        {isFailedAuditReport(analysis)
          ? <FailedAuditReportView report={analysis} />
          : isV4Analysis(analysis)
          ? <WorkflowAgentAudit analysis={analysis} onJumpToTurn={onJumpToTurn} />
          : <WorkflowFlowChart analysis={analysis} onJumpToTurn={onJumpToTurn} />}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        {!hasConfig && <AIProviderConfigPanel compact />}

        <div className="rounded-lg border bg-card p-4 space-y-2">
          <h3 className="font-semibold text-sm">一键生成审计报告</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            基于当前 session 的实际轨迹，自动生成流程框图 + 节点问题 + 技能质量评估 + 优化建议（约 5-20 分钟）。
          </p>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border p-0.5">
              {(["v1", "v2", "v3", "v4"] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setAgentVersion(v)}
                  className={cn(
                    "px-2 py-0.5 text-xs rounded transition-colors",
                    agentVersion === v
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            <Button size="sm" onClick={generateAudit} disabled={generating}>
              {generating ? "生成中…" : "生成审计报告"}
            </Button>
            {genError && <span className="text-xs text-red-600">生成失败：{genError}</span>}
          </div>
          {generating && (
            <div className="rounded-md border bg-accent/20 p-3 text-xs space-y-1">
              <div className="font-medium text-foreground flex items-center gap-2">
                生成中… <span className="tabular-nums text-muted-foreground">{elapsed}s</span>
                <span className="text-muted-foreground">（{versionLabel(agentVersion)}，约 5-20 分钟）</span>
              </div>
              {progress.map((p, i) => (
                <div key={i} className="text-muted-foreground flex gap-1.5">
                  <span className="text-muted-foreground/40">→</span>
                  <span>{p.msg}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-2">
          <h3 className="font-semibold text-sm">从文件导入</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            点击「选择 JSON 文件」上传本地分析 JSON，自动渲染流程框图与节点问题。
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>选择 JSON 文件</Button>
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFilePicked} />
        </div>
      </div>
    </div>
  )
}

function FailedAuditReportView({ report }: { report: FailedAuditReport }) {
  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-500/10 p-4 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-semibold text-red-700 dark:text-red-400">审计报告生成失败</h3>
          <span className="text-xs text-muted-foreground">耗时 {report.elapsedSec}s</span>
        </div>
        <p className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap">{report.error}</p>
        <div className="text-xs text-muted-foreground grid gap-1 sm:grid-cols-2">
          <span>版本：{report.agentVersion}</span>
          <span>任务：{report.taskId}</span>
          <span>开始：{new Date(report.startedAt).toLocaleString()}</span>
          <span>结束：{new Date(report.generatedAt).toLocaleString()}</span>
        </div>
      </div>
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <h4 className="font-medium text-sm">执行进度（{report.progress.length}）</h4>
        {report.progress.length === 0
          ? <p className="text-xs text-muted-foreground">失败前没有收到进度事件。</p>
          : report.progress.map((item, index) => (
              <div key={index} className="text-xs flex gap-2">
                <span className="text-muted-foreground shrink-0">{item.stage || "progress"}</span>
                <span>{item.msg}</span>
              </div>
            ))}
      </div>
      {report.partialAnalysis && (
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <h4 className="font-medium text-sm">已通过校验的部分结果</h4>
          {isV4Analysis(report.partialAnalysis)
            ? <WorkflowAgentAudit analysis={report.partialAnalysis} />
            : <WorkflowFlowChart analysis={report.partialAnalysis} />}
        </div>
      )}
    </div>
  )
}
