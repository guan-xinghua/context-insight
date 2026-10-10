"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useEffect } from "react"
import { BRAND_NAME, BRAND_SOURCE_TYPE } from '@/lib/branding'
import { isProxyVersion, agentFrameworkOf } from '@/lib/shared/session-format'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TrashIcon } from "lucide-react"

export interface ImportHistoryEntry {
  taskId: string
  importedAt: string
  turnCount: number
  status: "success" | "error"
  query: string | null
  filePath: string | null
  sourceType?: string
  framework?: string | null
  version?: string | null
}

const STORAGE_KEY = "cannbot-import-history"
const MAX_ENTRIES = 20

export function saveImportHistory(entries: ImportHistoryEntry[]) {
  try {
    const existing: ImportHistoryEntry[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
    const merged = [...entries, ...existing].slice(0, MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {}
}

export function getImportHistory(): ImportHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
  } catch {
    return []
  }
}

/** 行定位键（删除 loading 态）：同 sid 双记录（方案一）两条目共享 taskId，
 *  用 taskId+framework 区分单条；framework 缺失（旧版前端写入的条目）回落
 *  裸 taskId */
function historyKeyOf(entry: Pick<ImportHistoryEntry, "taskId" | "framework">): string {
  return entry.framework ? `${entry.taskId}|${entry.framework}` : entry.taskId
}

function removeImportHistoryEntry(taskId: string, framework?: string | null) {
  try {
    const existing: ImportHistoryEntry[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
    // 同 sid 双记录两条目共享 taskId——按 taskId+framework 双键定位单条，
    // 只清点击的那条；旧条目（framework null）也只清 null 条目
    const filtered = existing.filter(e => !(e.taskId === taskId && (e.framework ?? null) === (framework ?? null)))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
  } catch {}
}

function clearImportHistory() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

function formatTime(iso: string): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1)
    const day = String(d.getDate())
    const hour = String(d.getHours()).padStart(2, '0')
    const minute = String(d.getMinutes()).padStart(2, '0')
    return `${year}/${month}/${day} ${hour}:${minute}`
  } catch {
    return iso
  }
}

export function ImportHistory() {
  const [history, setHistory] = useState<ImportHistoryEntry[] | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deletingAll, setDeletingAll] = useState(false)
  // 旧条目（framework 缺失）删除的确认弹窗：delete-session 返回 409（无消歧
  // 且该 taskId 在 DB 有多行——同 sid 双记录）时挂起，用户显式确认后才带
  // confirmAll 重发
  const [pendingMultiDelete, setPendingMultiDelete] = useState<{ entry: ImportHistoryEntry; rowCount: number } | null>(null)
  // taskId → DB 里的 {framework, version}（导入事实源）。Recent Imports 的
  // 类型徽标以 DB 为准 —— localStorage 条目可能由旧版前端写入（缺 framework
  // 字段），挂载时拉取会话列表自愈；DB 查不到的条目（已删除会话）回退条目
  // 自带字段 → 再回退路径启发式。
  const [dbMeta, setDbMeta] = useState<Map<string, { framework: string | null; version: string | null }>>(new Map())

  useEffect(() => {
    setHistory(getImportHistory())
    fetch("/api/observe/data?limit=500")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const items = (d?.items ?? []) as Array<{ taskId: string; framework: string | null; version: string | null }>
        // 同 sid 双记录两行共享 taskId——主键 taskId|framework 精确到行；
        // 裸 taskId 兜底键（首行）服务 framework 缺失的旧条目（自愈语义不变）
        const m = new Map<string, { framework: string | null; version: string | null }>()
        for (const i of items) {
          const meta = { framework: i.framework, version: i.version }
          if (i.framework) m.set(`${i.taskId}|${i.framework}`, meta)
          if (!m.has(i.taskId)) m.set(i.taskId, meta)
        }
        setDbMeta(m)
      })
      .catch(() => { /* 离线/失败时走条目字段回退 */ })
  }, [])

  if (history === null) {
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Recent Imports</h2>
        <div className="h-8 rounded-md bg-muted/30 animate-pulse" />
      </div>
    )
  }

  if (history.length === 0) return null

  async function doDeleteEntry(entry: ImportHistoryEntry, confirmAll = false) {
    setDeleting(historyKeyOf(entry))
    try {
      const res = await fetch("/api/ingest/delete-session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        // framework：同 sid 双记录（方案一）消歧——不带会命中两行全部级联
        // 删除。旧条目（framework 缺失）由服务端兜底：命中多行时返回 409 +
        // rowCount（事实源判定，不受列表拉取窗口截断影响），前端弹确认后
        // 带 confirmAll 重发
        body: JSON.stringify({
          taskId: entry.taskId,
          ...(entry.framework ? { framework: entry.framework } : {}),
          ...(confirmAll ? { confirmAll: true } : {}),
        }),
      })
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}))
        if (data?.multiRow === true) {
          setPendingMultiDelete({ entry, rowCount: Number(data.rowCount) || 0 })
          setDeleting(null)
          return
        }
      }
      // Remove from localStorage regardless of API result (session may already be deleted from DB)
      removeImportHistoryEntry(entry.taskId, entry.framework ?? null)
      setHistory(getImportHistory())
      if (res.ok) {
        window.location.reload()
      }
    } catch {
      // Still remove from localStorage even on network error
      removeImportHistoryEntry(entry.taskId, entry.framework ?? null)
      setHistory(getImportHistory())
    }
    setDeleting(null)
  }

  async function handleDeleteAll() {
    setDeletingAll(true)
    try {
      const res = await fetch("/api/ingest/delete-session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteAll: true }),
      })
      if (res.ok) {
        clearImportHistory()
        setHistory([])
        window.location.reload()
      }
    } catch { /* ignore */ }
    setDeletingAll(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Recent Imports ({history.length})</h2>        <Button
          variant="destructive"
          size="sm"
          disabled={deletingAll}
          onClick={handleDeleteAll}
        >
          {deletingAll ? "Deleting..." : "Delete All"}
        </Button>
      </div>
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">File Path</TableHead>
              <TableHead className="text-xs">Query</TableHead>
              <TableHead className="text-xs whitespace-nowrap">Import Time</TableHead>
              <TableHead className="text-xs">Type</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="w-[40px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((entry, i) => {
              // 类型徽标事实源优先级：DB（挂载时拉取）> 条目自带字段（新前端
              // 写入）> 路径启发式（历史 localStorage 兜底）。DB 查找按行定位
              // 键（双记录共享 taskId，framework 精确到行；旧条目回落裸键）
              const db = dbMeta.get(historyKeyOf(entry))
              const fwSource = db?.framework ?? entry.framework ?? null
              const vSource = db?.version ?? entry.version ?? null
              // 方案一：捕获行 framework 带 -proxy 记录后缀（claude-code-proxy
              // 等）——剥后缀归一到 agent 框架后进白名单，proxy 徽标仍走 version
              const agentFw = agentFrameworkOf(fwSource)
              const knownFramework = agentFw === "opencode" || agentFw === "claude-code" || agentFw === "cannbot" || agentFw === "dsh" || agentFw === BRAND_SOURCE_TYPE
                ? agentFw
                : null
              const isProxy = isProxyVersion(vSource)
              const isProxyCapture = entry.sourceType === "claude-jsonl" && (entry.filePath?.includes("/proxy/") ?? false)
              const legacyOpencode = isProxyCapture && /cpx-ses_[^/]*\.jsonl$/.test(entry.filePath ?? "")
              const showOpencode = knownFramework === "opencode" || (!knownFramework && legacyOpencode)
              const showProxy = knownFramework ? isProxy : isProxyCapture
              return (
              <TableRow key={`${entry.taskId}-${i}`}>
                <TableCell className="max-w-[400px] truncate text-xs font-mono text-muted-foreground" title={entry.filePath ?? ""}>{entry.filePath ?? "—"}</TableCell>
                <TableCell className="max-w-[260px] truncate text-xs" title={entry.query ?? entry.taskId}>{entry.query ?? entry.taskId}</TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatTime(entry.importedAt)}</TableCell>
                <TableCell className="text-xs">
                  {knownFramework === BRAND_SOURCE_TYPE ? (
                    <Badge variant="purple">{BRAND_NAME}</Badge>
                  ) : knownFramework ? (
                    <span className="inline-flex items-center gap-1">
                      {knownFramework === "cannbot" ? <Badge variant="green">CANNBot</Badge>
                        : knownFramework === "dsh" ? <Badge variant="purple">DSH</Badge>
                        : showOpencode ? <Badge variant="blue">OpenCode</Badge> : <Badge variant="orange">Claude</Badge>}
                      {showProxy && <Badge variant="yellow">proxy</Badge>}
                    </span>
                  ) : entry.sourceType === "opencode-db" ? (
                    <Badge variant="blue">OpenCode</Badge>
                  ) : entry.sourceType === "claude-jsonl" ? (
                    isProxyCapture ? (
                      <span className="inline-flex items-center gap-1">
                        {legacyOpencode ? <Badge variant="blue">OpenCode</Badge> : <Badge variant="orange">Claude</Badge>}
                        <Badge variant="yellow">proxy</Badge>
                      </span>
                    ) : (
                      <Badge variant="orange">Claude</Badge>
                    )
                  ) : "—"}
                </TableCell>
                <TableCell className="text-xs">
                  {entry.status === "success" ? (
                    <Badge variant="green">OK</Badge>
                  ) : (
                    <Badge variant="red">error</Badge>
                  )}
                </TableCell>
                <TableCell className="px-2 text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-red-600"
                    disabled={deleting === historyKeyOf(entry)}
                    onClick={() => doDeleteEntry(entry)}
                    title="Delete from Insight"
                  >
                    {deleting === historyKeyOf(entry) ? <span className="text-xs">…</span> : <TrashIcon className="size-3.5" />}
                  </Button>
                </TableCell>
              </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* 旧条目（无 framework 消歧）删除多行确认：delete-session 检出该
          taskId 多行（同 sid 双记录）返回 409——用户知情后才带 confirmAll
          执行全部删除 */}
      <Dialog open={pendingMultiDelete != null} onOpenChange={(v) => { if (!v) setPendingMultiDelete(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除全部记录？</DialogTitle>
            <DialogDescription>
              该导入条目来自旧版前端（无记录类信息），且此会话在 DB 中有
              {" "}{pendingMultiDelete?.rowCount ?? 0}{" "}
              份记录（同 sid 双记录并存）。删除将移除<b>全部</b>记录及关联数据，且无法区分具体是哪一份。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingMultiDelete(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const pending = pendingMultiDelete
                setPendingMultiDelete(null)
                if (pending) await doDeleteEntry(pending.entry, true)
              }}
            >
              删除全部
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
