"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useEffect, useCallback } from "react"
import { BRAND_NAME, BRAND_SLUG, BRAND_SOURCE_TYPE, BAY_NAME } from '@/lib/branding'
import { loadCannbayConfig, cannbayRemoteInput, isDefaultCannbayRemote, DEFAULT_CANNBAY_ADDRESS } from '@/lib/cannbay-config'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { saveImportHistory, type ImportHistoryEntry } from "@/components/ImportHistory"
import { Button } from "@/components/ui/button"
import { DownloadIcon, LoaderIcon, FolderIcon, FileIcon, ChevronRightIcon, ChevronDownIcon, ChevronUpIcon, ArrowUpIcon, GlobeIcon, SearchIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { isProxyVersion, agentFrameworkOf } from "@/lib/shared/session-format"

// imported:false has three distinct causes — label them accurately instead of
// blanket "Already exists" (which hid file-missing behind an exists message)
function importResultMessage(data: { imported?: boolean; reason?: string; error?: string }): string {
  if (data.imported) return data.reason === "imported-empty" ? "Imported (empty capture — turns appear via refresh)" : "Imported";
  if (data.reason === "no-interactions") return "No parseable records (empty or unrecognized file)";
  return "Already exists (merged)";
}

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface SessionPreview {
  id: string
  /** 数据仓导入的记录类——同 sid 双记录（capture/native）两条 preview 共享
   *  id，按 recording 区分归属（本地导入 preview 无值） */
  recording?: "capture" | "native"
  createdAt: string
  endedAt: string | null
  firstQuery: string | null
  turnCount: number
  totalTokens: number | null
}

interface ImportStatus {
  /** 状态更新/列表渲染定位键：本地导入 = sid；数据仓导入 = sid@recording（同 sid 双记录两条目状态各自独立） */
  key: string
  /** 真实 sid —— 流入 ImportHistory taskId / 列表 label / dbMeta 等共享路径（一律按裸 sid 消费，复合键不得外泄） */
  sessionId: string
  /** 数据仓导入的记录类（仓内目录：capture=裸 <sid>/ / native=<sid>.native/）；本地导入无值 */
  recording?: "capture" | "native"
  /** 数据仓条目所在范式目录（默认仓顶层目录；存量区/自定义远端为 null）——File Path 显示真实仓路径 */
  paradigm?: string | null
  status: "pending" | "importing" | "success" | "error"
  message?: string
  framework?: string | null
  version?: string | null
}

interface DirEntry {
  name: string
  fullPath: string
  isDir: boolean
  size: number
  mtime?: number | null
  isImportableFile: boolean
  importableType: string | null
}

/** 目录浏览排序：目录置顶（导航优先），组内按修改时间升/降序（默认降序=最新
 *  在前，方便按时间找会话捕获文件；asc=false 降序 / asc=true 升序）。mtime
 *  缺失（旧后端响应）按 0 兜底——降序排尾 / 升序排头（紧跟目录）。导出供
 *  IT 直接验证两个方向。 */
export function sortDirEntries(entries: DirEntry[], asc: boolean): DirEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const am = a.mtime ?? 0
    const bm = b.mtime ?? 0
    if (am === bm) return a.name.localeCompare(b.name)
    return asc ? am - bm : bm - am
  })
}

interface CannbaySession {
  sid: string
  fileCount: number
  author: string
  submitter: string
  description: string
  commitTime: string
  framework?: string | null
  ccVersion?: string | null
  producer?: string | null
  /** 所在顶层范式目录（目录即注册表）；存量区 sessions/ 为 null */
  paradigm?: string | null
  /** 范式 baseline 会话（位置即身份：<paradigm>/baseline/<sid>/，路径推导） */
  isBaseline?: boolean
  /** 算子生成结果标注（cc-session-meta 可选字段 opGen，上传时勾选），null/缺省 = 未标注 */
  opGen?: 'success' | 'failure' | null
  /** 记录类（同 sid 双记录）：native = <sid>.native/ 原生 claude 会话；capture = 裸 <sid>/（wire 捕获 / 主位） */
  recording?: 'capture' | 'native'
}

/** 同 sid 双记录：列表选择键 = sid@recording（同一 sid 的捕获与原生各占一条目） */
function cannbayEntryKey(s: Pick<CannbaySession, 'sid' | 'recording'>): string {
  return `${s.sid}@${s.recording ?? 'capture'}`
}

/** preview 归属匹配：id 相等且记录类一致（本地导入双方均无 recording）——
 *  同 sid 双记录两条 preview 共享 id，只按 id 查会永远命中第一条 */
function previewOf(previews: SessionPreview[], s: { sessionId: string; recording?: "capture" | "native" }): SessionPreview | undefined {
  return previews.find(p => p.id === s.sessionId && (p.recording ?? undefined) === (s.recording ?? undefined))
}

type Step = "input" | "browse" | "select" | "cannbay" | "importing"

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1048576) return `${(size / 1024).toFixed(1)}K`
  return `${(size / 1048576).toFixed(1)}M`
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  } catch {
    return iso
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1000000).toFixed(2)}M`
}

export function LocalFileImport() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("input")
  const [filePath, setFilePath] = useState("/")
  const [sourceType, setSourceType] = useState<"opencode-db" | "claude-jsonl" | "cannbay" | typeof BRAND_SOURCE_TYPE>("claude-jsonl")
  const [sessions, setSessions] = useState<SessionPreview[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 会话选择步的 keyword/sessionID 过滤（firstQuery 或 id 子串，大小写不敏感）
  const [sessionFilter, setSessionFilter] = useState("")
  const [importStatuses, setImportStatuses] = useState<ImportStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dirEntries, setDirEntries] = useState<DirEntry[]>([])
  // 目录浏览时间排序方向：默认降序（最新在前），点表头箭头切换
  const [dirSortAsc, setDirSortAsc] = useState(false)
  const [currentDir, setCurrentDir] = useState<string | null>(null)
  const [parentDir, setParentDir] = useState<string | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  // Load Sessions 扫描目录/读库期间的前端反馈（对齐 browseLoading/cannbayLoading）
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [cannbaySessions, setCannbaySessions] = useState<CannbaySession[]>([])
  const [cannbayScope, setCannbayScope] = useState("")
  const [cannbaySelected, setCannbaySelected] = useState<Set<string>>(new Set())
  const [cannbayLoading, setCannbayLoading] = useState(false)
  const [cannbayFilter, setCannbayFilter] = useState("")
  // 范式优先导入：先选范式目录（数据仓顶层目录即注册表），再看该范式下会话。
  // null = 范式选择阶段；'__none__' = 未标注（存量 sessions/ 区）；其余 = 范式目录名
  const [cannbayParadigms, setCannbayParadigms] = useState<string[]>([])
  const [cannbayParadigm, setCannbayParadigm] = useState<string | null>(null)

  function resetState() {
    setStep("input")
    setFilePath("/")
    setSourceType("claude-jsonl")
    setSessions([])
    setSelectedIds(new Set())
    setSessionFilter("")
    setImportStatuses([])
    setError(null)
    setDirEntries([])
    setCurrentDir(null)
    setParentDir(null)
    setBrowseLoading(false)
    setSessionsLoading(false)
    setCannbaySessions([])
    setCannbaySelected(new Set())
    setCannbayLoading(false)
    setCannbayFilter("")
    setCannbayParadigms([])
    setCannbayParadigm(null)
  }

  async function browseDirectory(dirPath: string) {
    setBrowseLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/ingest/browse-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirPath }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Failed to browse directory")
        setBrowseLoading(false)
        return
      }
      if (!data.isDirectory) {
        const parent = data.parentPath ?? (dirPath.split("/").slice(0, -1).join("/") || "/")
        browseDirectory(parent)
        return
      }
      setDirEntries(data.entries ?? [])
      setCurrentDir(data.currentPath)
      setParentDir(data.parentPath)
      setStep("browse")
      setBrowseLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error")
      setBrowseLoading(false)
    }
  }

  async function handleDirectImportJsonl(entry: DirEntry) {
    // .jsonl.gz（cpx 压缩捕获）双形态 + 剥 cpx- 前缀：与退出自动导入（真实
    // sid）落同一 taskId，避免同会话双身份入库
    const sessionId = entry.name.replace(/\.jsonl(\.gz)?$/, "").replace(/^cpx-/, "")
    setFilePath(entry.fullPath)
    setSourceType("claude-jsonl")
    setStep("importing")
    setImportStatuses([{ key: sessionId, sessionId, status: "importing" }])
    try {
      const res = await fetch("/api/ingest/import-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "claude-jsonl", sessionId, filePath: entry.fullPath }),
      })
      const data = await res.json()
      if (res.ok && data.query) {
        setSessions([{ id: sessionId, createdAt: new Date().toISOString(), endedAt: null, firstQuery: data.query, turnCount: 0, totalTokens: null }])
      }
      setImportStatuses(prev =>
        prev.map(s => s.key === sessionId
          ? { ...s, status: res.ok ? "success" : "error", message: res.ok ? importResultMessage(data) : (data.error ?? "Import failed") }
          : s)
      )
    } catch (e) {
      setImportStatuses(prev =>
        prev.map(s => s.key === sessionId ? { ...s, status: "error", message: e instanceof Error ? e.message : "Network error" } : s)
      )
    }
  }

  function handleDirEntryClick(entry: DirEntry) {
    if (entry.isDir) {
      browseDirectory(entry.fullPath)
    } else if (entry.isImportableFile) {
      if (entry.importableType === "claude-jsonl") {
        handleDirectImportJsonl(entry)
      } else {
        setFilePath(entry.fullPath)
        if (entry.importableType) {
          setSourceType(entry.importableType as "opencode-db" | "claude-jsonl" | typeof BRAND_SOURCE_TYPE)
        }
        setStep("input")
      }
    }
  }

  function handleGoUp() {
    if (parentDir) {
      browseDirectory(parentDir)
    }
  }

  async function handleLoadSessions() {
    if (!filePath.trim()) {
      setError("Please enter a file path")
      return
    }
    setError(null)

    // Claude Code JSONL single file: one session per file, skip selection step
    // （.jsonl.gz 压缩捕获同走直导；cpx- 前缀剥掉与自动导入 taskId 对齐）
    if (sourceType === "claude-jsonl" && (filePath.trim().endsWith(".jsonl") || filePath.trim().endsWith(".jsonl.gz"))) {
      // Derive sessionId from filename
      const filename = filePath.trim().split("/").pop() ?? ""
      const sessionId = filename.replace(/\.jsonl(\.gz)?$/, "").replace(/^cpx-/, "")
      setStep("importing")
      setImportStatuses([{ key: sessionId, sessionId, status: "importing" }])
      try {
        const res = await fetch("/api/ingest/import-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: sourceType, sessionId, filePath: filePath.trim() }),
        })
        const data = await res.json()
        if (res.ok && data.query) {
          setSessions([{ id: sessionId, createdAt: new Date().toISOString(), endedAt: null, firstQuery: data.query, turnCount: 0, totalTokens: null }])
        }
        setImportStatuses(prev =>
          prev.map(s => s.key === sessionId
            ? { ...s, status: res.ok ? "success" : "error", message: res.ok ? importResultMessage(data) : (data.error ?? "Import failed"), framework: data.framework ?? undefined, version: data.version ?? undefined }
            : s)
        )
      } catch (e) {
        setImportStatuses(prev =>
          prev.map(s => s.key === sessionId ? { ...s, status: "error", message: e instanceof Error ? e.message : "Network error" } : s)
        )
      }
      return
    }

    setSessionsLoading(true)
    try {
      const res = await fetch("/api/ingest/import-file/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: sourceType, filePath: filePath.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Failed to load sessions")
        return
      }
      setSessions(data.sessions ?? [])
      if (data.sessions?.length === 0) {
        setError("No sessions found in this database")
        return
      }
      setSessionFilter("")
      setStep("select")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error")
    } finally {
      setSessionsLoading(false)
    }
  }

  function handleBrowseFromInput() {
    browseDirectory(filePath.trim() || "/")
  }

  // 常用默认路径快捷入口（服务端 ~ 展开）：一键直达，免逐级 Browse
  const QUICK_DIRS: Record<"claude-jsonl" | "sqlite", Array<{ label: string; path: string }>> = {
    "claude-jsonl": [
      { label: "cpx proxy 捕获", path: "~/.cannbot-insight/proxy" },
      { label: "Claude 原生", path: "~/.claude/projects" },
    ],
    sqlite: [
      { label: "opencode 数据", path: "~/.local/share/opencode" },
    ],
  }
  const quickDirs = sourceType === "claude-jsonl" ? QUICK_DIRS["claude-jsonl"] : sourceType === "opencode-db" || sourceType === BRAND_SOURCE_TYPE ? QUICK_DIRS.sqlite : []

  function handleQuickJump(dirPath: string) {
    setFilePath(dirPath)
    browseDirectory(dirPath)
  }

  // 范式优先打开：默认仓拉取范式目录清单（注册表）+ 全量会话列表，进入范式
  // 选择阶段（选中后本地过滤，切换零延迟）。自定义数据湖远端不启用范式目录
  // （后端单根模式，任意顶层目录不是范式注册表）——只拉列表，直接进会话表。
  // list 一次请求同时返回 sessions + dirs（顶层目录）：后端单轮 mirror fetch
  // 服务两份数据（原先 dirs/list 两路各 fetch 一次 ~1s×2）
  async function handleOpenCannbay() {
    setCannbayLoading(true)
    setError(null)
    setCannbaySessions([])
    setCannbaySelected(new Set())
    setCannbayParadigms([])
    setCannbayParadigm(null)
    const cfg = loadCannbayConfig()
    const paradigmEnabled = isDefaultCannbayRemote(cfg)
    const addr = cfg?.address.trim() && cfg.address.trim() !== DEFAULT_CANNBAY_ADDRESS ? cfg.address.trim() : "默认仓"
    setCannbayScope(paradigmEnabled
      ? `${addr} · 分支 ${cfg?.branch.trim() || "main"}`
      : `${addr} · 分支 ${cfg?.branch.trim() || "main"} · 目录 /${cfg?.directory.trim() || "sessions"}`)
    try {
      const listRes = await fetch("/api/ingest/cannbay2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", ...cannbayRemoteInput(cfg) }),
      })
      const listData = await listRes.json()
      if (!listRes.ok) throw new Error(listData.error ?? `Failed to fetch ${BAY_NAME} sessions`)
      if (paradigmEnabled) {
        const paradigms = ((listData.dirs ?? []) as string[]).filter(d => d !== "sessions")
        if (paradigms.length === 0) {
          setError("数据仓暂无范式目录：请先在数据仓顶层新建范式目录")
          return
        }
        setCannbayParadigms(paradigms)
      }
      setCannbaySessions(listData.sessions ?? [])
      // 自定义远端直接进会话表（未标注 = 单根全量）；默认仓停在范式选择阶段
      setCannbayParadigm(paradigmEnabled ? null : "__none__")
      setStep("cannbay")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error")
    } finally {
      setCannbayLoading(false)
    }
  }

  function pickCannbayParadigm(p: string) {
    setCannbayParadigm(p)
    setCannbayFilter("")
    setCannbaySelected(new Set())
  }

  function toggleCannbaySelection(filename: string) {
    setCannbaySelected(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  async function handleImportCannbay() {
    if (cannbaySelected.size === 0) return
    setStep("importing")

    // 选择键 = sid@recording（同 sid 双记录各一条目）；导入按各自记录类定位目录。
    // 复合键只用于选择集与状态更新定位（key 字段）——sessionId 一律真实 sid：
    // 共享路径（ImportHistory taskId / dbMeta / 列表 label / delete-session）
    // 全部按裸 sid 消费，复合键外泄会让删除 404 静默失败、File Path 列错显
    const keys = Array.from(cannbaySelected)
    const byKey = new Map(cannbaySessions.map(s => [cannbayEntryKey(s), s]))
    const selectedEntries = keys
      .map(k => byKey.get(k))
      .filter((s): s is CannbaySession => s != null)
    setImportStatuses(selectedEntries.map(e => ({
      key: cannbayEntryKey(e),
      sessionId: e.sid,
      recording: e.recording ?? 'capture',
      paradigm: e.paradigm ?? null,
      status: "pending" as const,
    })))

    const importedPreviews: SessionPreview[] = []

    async function importOne(key: string) {
      setImportStatuses(prev =>
        prev.map(s => s.key === key ? { ...s, status: "importing" as const } : s)
      )
      const entry = byKey.get(key)
      const sid = entry?.sid ?? key.split('@')[0]
      const recording = entry?.recording ?? 'capture'
      try {
        const res = await fetch("/api/ingest/cannbay2", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "import", sid, recording, ...cannbayRemoteInput(loadCannbayConfig()) }),
        })
        const data = await res.json()
        const result = res.ok ? data.result : null
        const ok = Boolean(result)
        setImportStatuses(prev => prev.map(s =>
          s.key === key
            ? { ...s, status: ok ? "success" as const : "error" as const, message: ok ? importResultMessage(result) : (data.error ?? "Import failed"), framework: result?.framework ?? undefined, version: result?.version ?? undefined }
            : s))
        if (ok) {
          importedPreviews.push({
            id: sid,
            recording,
            createdAt: new Date().toISOString(),
            endedAt: null,
            firstQuery: result.query ?? null,
            turnCount: 0,
            totalTokens: null,
          })
        }
      } catch (e) {
        setImportStatuses(prev => prev.map(s =>
          s.key === key
            ? { ...s, status: "error" as const, message: e instanceof Error ? e.message : "Network error" }
            : s))
      }
    }

    // Concurrent pool（与本地导入同款）：物化网络下载并行，wall-time ÷N
    const CONCURRENCY = 4
    let nextIndex = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, keys.length) }, async () => {
      while (nextIndex < keys.length) {
        await importOne(keys[nextIndex++])
      }
    })
    await Promise.all(workers)
    setSessions(prev => [...prev, ...importedPreviews])
  }

  function toggleSelection(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // select 步的过滤结果：keyword 匹配 firstQuery，或 sessionID 子串（大小写不敏感）
  const sessionQuery = sessionFilter.trim().toLowerCase()
  const filteredSessions = sessionQuery
    ? sessions.filter(s =>
        s.firstQuery?.toLowerCase().includes(sessionQuery)
        || s.id.toLowerCase().includes(sessionQuery))
    : sessions

  function toggleAll() {
    // 全选作用于当前过滤视图（与数据仓列表同款语义）
    if (filteredSessions.length > 0 && filteredSessions.every(s => selectedIds.has(s.id))) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        for (const s of filteredSessions) next.delete(s.id)
        return next
      })
    } else {
      setSelectedIds(prev => new Set([...prev, ...filteredSessions.map(s => s.id)]))
    }
  }

  async function handleImportSelected() {
    if (selectedIds.size === 0) return
    setStep("importing")

    const ids = Array.from(selectedIds)
    const statuses: ImportStatus[] = ids.map(id => ({
      key: id,
      sessionId: id,
      status: "pending" as const,
    }))
    setImportStatuses(statuses)

    const CONCURRENCY = 4
    let nextIndex = 0

    async function importOne(sessionId: string) {
      setImportStatuses(prev =>
        prev.map(s => s.key === sessionId ? { ...s, status: "importing" } : s)
      )

      try {
        const res = await fetch("/api/ingest/import-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: sourceType, sessionId, filePath: filePath.trim() }),
        })
        const data = await res.json()
        if (!res.ok) {
          setImportStatuses(prev =>
            prev.map(s => s.key === sessionId ? { ...s, status: "error", message: data.error ?? "Import failed" } : s)
          )
        } else {
          setImportStatuses(prev =>
            prev.map(s => s.key === sessionId ? { ...s, status: "success", message: importResultMessage(data), framework: data.framework ?? undefined, version: data.version ?? undefined } : s)
          )
        }
      } catch (e) {
        setImportStatuses(prev =>
          prev.map(s => s.key === sessionId ? { ...s, status: "error", message: e instanceof Error ? e.message : "Network error" } : s)
        )
      }
    }

    // Concurrent pool: run up to CONCURRENCY imports at a time
    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (nextIndex < ids.length) {
        const idx = nextIndex++
        await importOne(ids[idx])
      }
    })

    await Promise.all(workers)
  }

  const handleDone = useCallback(() => {
    const hasSuccess = importStatuses.some(s => s.status === "success")
    if (hasSuccess) {
      // File Path 列显示真实仓路径：目录 = 范式目录（默认仓条目实际在
      // <paradigm>/<sid>[.native]/，存量区/自定义远端回落 cfg.directory），
      // 记录类决定 <sid> vs <sid>.native
      const cannbayRepoRef = (sid: string, recording?: "capture" | "native", paradigm?: string | null): string => {
        const cfg = loadCannbayConfig()
        const addr = cfg?.address.trim() && cfg.address.trim() !== DEFAULT_CANNBAY_ADDRESS
          ? cfg.address.trim()
          : DEFAULT_CANNBAY_ADDRESS
        const branch = cfg?.branch.trim() || "main"
        const dir = paradigm ?? (cfg?.directory.trim() || "sessions")
        const dirName = recording === "native" ? `${sid}.native` : sid
        return `${BAY_NAME}@${addr.replace(/^https?:\/\//, "")}@${branch}:${dir}/${dirName}`
      }
      const entries: ImportHistoryEntry[] = importStatuses.map(s => {
        const session = previewOf(sessions, s)
        return {
          // taskId 一律真实 sid（复合键外泄会让 delete-session 404 静默失败、
          // dbMeta 徽标源永远 miss）
          taskId: s.sessionId,
          importedAt: new Date().toISOString(),
          turnCount: session?.turnCount ?? 0,
          status: s.status === "success" ? "success" as const : "error" as const,
          query: session?.firstQuery ?? null,
          filePath: sourceType === "cannbay" ? cannbayRepoRef(s.sessionId, s.recording, s.paradigm) : filePath.trim(),
          sourceType: sourceType === "cannbay" ? BRAND_SOURCE_TYPE : sourceType,
          framework: s.framework ?? null,
          version: s.version ?? null,
        }
      })
      saveImportHistory(entries)
      toast.success("Import complete", { description: `${entries.filter(e => e.status === "success").length} sessions imported.` })
    }
    setOpen(false)
    resetState()
    if (hasSuccess) {
      window.location.reload()
    }
  }, [importStatuses, sessions, filePath, sourceType])

  const allSuccessOrError = importStatuses.length > 0 && importStatuses.every(s => s.status === "success" || s.status === "error")

  // Auto-redirect to home after import completes
  useEffect(() => {
    if (allSuccessOrError) {
      const timer = setTimeout(handleDone, 1000)
      return () => clearTimeout(timer)
    }
  }, [allSuccessOrError, handleDone])

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetState() }}>
      <DialogTrigger render={<Button variant="default" size="lg" className="gap-2 font-semibold"><DownloadIcon className="size-4" />Import Session</Button>} />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Session</DialogTitle>
          <DialogDescription>
            {step === "input" && `Import session data from local files or ${BAY_NAME}`}
            {step === "browse" && "Browse directories and select a file to import"}
            {step === "select" && "Select sessions to import"}
            {step === "cannbay" && (cannbayParadigm == null ? "选择范式目录（数据仓顶层目录）" : "选择该范式下的会话导入")}
            {step === "importing" && `Importing ${importStatuses.filter(s => s.status === "success" || s.status === "error").length}/${importStatuses.length} sessions...`}
          </DialogDescription>
        </DialogHeader>

        {step === "input" && (
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Source Type</label>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant={sourceType === "claude-jsonl" ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSourceType("claude-jsonl"); setError(null) }}
                >
                  JSONL (Claude / Proxy)
                </Button>
                <Button
                  variant={sourceType === "opencode-db" || sourceType === BRAND_SOURCE_TYPE ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSourceType("opencode-db"); setError(null) }}
                >
                  SQLite (auto)
                </Button>
                <Button
                  variant={sourceType === "cannbay" ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSourceType("cannbay"); handleOpenCannbay() }}
                >
                  <GlobeIcon className="size-3.5 mr-1" />
                  {BAY_NAME}
                </Button>
              </div>
            </div>
            {sourceType !== "cannbay" && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">File Path</label>
              <div className="flex gap-2">
                <Input
                  placeholder={sourceType === "claude-jsonl" ? "/path/to/session.jsonl(.gz) or /path/to/sessions-dir" : "/path/to/sessions.db"}
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBrowseFromInput}
                  className="gap-1.5 shrink-0"
                  disabled={sessionsLoading}
                >
                  <FolderIcon className="size-3.5" />
                  Browse
                </Button>
              </div>
              {quickDirs.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-xs text-muted-foreground">快捷路径:</span>
                  {quickDirs.map(q => (
                    <Button
                      key={q.path}
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={() => handleQuickJump(q.path)}
                      title={q.path}
                    >
                      <FolderIcon className="size-3 text-blue-500" />
                      {q.label}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs gap-1"
                    onClick={() => handleQuickJump("~")}
                    title="~"
                  >
                    <FolderIcon className="size-3 text-muted-foreground" />
                    主目录
                  </Button>
                </div>
              )}
              <div className="mt-2 text-xs text-muted-foreground space-y-1">
                {(sourceType === "opencode-db" || sourceType === BRAND_SOURCE_TYPE) && (
                  <>
                    <p>opencode: ~/.local/share/opencode/sessions.db</p>
                    <p>{BRAND_NAME} 导出: {BRAND_SLUG}_session_xxx.db（导入时按库 schema 自动识别）</p>
                  </>
                )}
                {sourceType === "claude-jsonl" && (
                  <>
                    <p>Claude 原生: ~/.claude/projects/&lt;hash&gt;/&lt;id&gt;.jsonl</p>
                    <p>cpx proxy 捕获: ~/.cannbot-insight/proxy/cpx-&lt;session-id&gt;.jsonl.gz（明文 .jsonl 与压缩 .jsonl.gz 均可，cpx- 前缀自动剥）</p>
                    <p>Or point to a directory to scan all .jsonl / .jsonl.gz files</p>
                  </>
                )}
                <p className="text-blue-500 dark:text-blue-400">Click Browse to explore directories and select files interactively</p>
              </div>
            </div>
            )}
            {sourceType === "cannbay" && !cannbayLoading && cannbayParadigms.length === 0 && !error && (
              <div className="text-sm text-muted-foreground py-4 text-center">
                <GlobeIcon className="size-5 mx-auto mb-2 text-blue-500" />
                <p>从 {BAY_NAME} 数据仓选择范式目录，导入该范式下的会话</p>
                <p className="text-xs mt-1">范式目录 = 数据仓顶层目录；其他用户上传的会话按范式归类</p>
              </div>
            )}
            {sourceType === "cannbay" && cannbayLoading && (
              <div className="flex items-center gap-2 py-4 justify-center">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Fetching sessions from {BAY_NAME}...</span>
              </div>
            )}
            {sourceType !== "cannbay" && sessionsLoading && (
              <div className="flex items-center gap-2 py-4 justify-center">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Loading sessions...</span>
              </div>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "browse" && (
          <div className="space-y-3 overflow-hidden">
            <div className="flex items-center gap-2 text-sm font-medium bg-muted/50 px-3 py-2 rounded-md">
              <FolderIcon className="size-4 text-blue-500 shrink-0" />
              <span className="flex-1 min-w-0 truncate">{currentDir}</span>
            </div>
            {parentDir && (
              <Button variant="ghost" size="sm" onClick={handleGoUp} className="gap-1.5">
                <ArrowUpIcon className="size-3.5" />
                Parent directory
              </Button>
            )}
            {browseLoading ? (
              <div className="flex items-center gap-2 py-4">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Loading directory...</span>
              </div>
            ) : (
              <div className="max-h-[320px] overflow-y-auto overflow-x-hidden border rounded-lg">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]"></TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="w-[150px]">
                        <span
                          role="button"
                          className="inline-flex items-center gap-0.5 cursor-pointer select-none hover:text-foreground"
                          title={dirSortAsc ? "按修改时间升序（点击改为降序）" : "按修改时间降序（点击改为升序）"}
                          onClick={() => setDirSortAsc(v => !v)}
                        >
                          Modified
                          {dirSortAsc
                            ? <ChevronUpIcon className="size-3.5" />
                            : <ChevronDownIcon className="size-3.5" />}
                        </span>
                      </TableHead>
                      <TableHead className="w-[80px]">Size</TableHead>
                      <TableHead className="w-[100px]">Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dirEntries.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                          Empty directory
                        </TableCell>
                      </TableRow>
                    )}
                    {sortDirEntries(dirEntries, dirSortAsc).map(entry => (
                      <TableRow
                        key={entry.fullPath}
                        className="cursor-pointer hover:bg-primary/5"
                        onClick={() => handleDirEntryClick(entry)}
                      >
                        <TableCell>
                          {entry.isDir
                            ? <FolderIcon className="size-4 text-blue-500" />
                            : entry.isImportableFile
                              ? <FileIcon className="size-4 text-emerald-500" />
                              : <FileIcon className="size-4 text-muted-foreground" />
                          }
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex items-center gap-1">
                            <span className={`flex-1 min-w-0 truncate${entry.isImportableFile ? " font-medium text-emerald-600 dark:text-emerald-400" : ""}`} title={entry.name}>
                              {entry.name}
                            </span>
                            {entry.isDir && <ChevronRightIcon className="size-3.5 text-muted-foreground shrink-0" />}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                          {entry.mtime ? formatTime(new Date(entry.mtime).toISOString()) : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {entry.isDir ? "" : formatSize(entry.size)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {entry.isDir ? (
                            <span className="text-blue-500 dark:text-blue-400">Directory</span>
                          ) : entry.isImportableFile ? (
                            <span className="text-emerald-500 dark:text-emerald-400">
                              {entry.importableType === BRAND_SOURCE_TYPE ? BRAND_NAME : entry.importableType === "opencode-db" ? "SQLite DB" : "JSONL"}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{entry.name.includes('.') ? entry.name.split('.').pop()! : "File"}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setStep("input"); setError(null) }}>
                Back
              </Button>
              <span className="text-xs text-muted-foreground">
                {dirEntries.filter(e => e.isImportableFile).length} importable files found
              </span>
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "select" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search by keyword or session ID..."
                value={sessionFilter}
                onChange={(e) => setSessionFilter(e.target.value)}
                className="flex-1"
              />
              <SearchIcon className="size-4 text-muted-foreground shrink-0" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <Checkbox
                checked={filteredSessions.length > 0 && filteredSessions.every(s => selectedIds.has(s.id))}
                onCheckedChange={toggleAll}
              />
              <span className="text-sm text-muted-foreground">
                {sessionQuery ? `${filteredSessions.length} of ${sessions.length} shown` : `Select all (${sessions.length} sessions)`}
              </span>
            </div>
            <div className="max-h-[320px] overflow-y-auto border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]"></TableHead>
                    <TableHead>Start Time</TableHead>
                    <TableHead>End Time</TableHead>
                    <TableHead className="max-w-[200px]">First Query</TableHead>
                    <TableHead>Turns</TableHead>
                    <TableHead>Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSessions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-4">
                        {sessionQuery ? "No sessions match your search" : "No sessions found"}
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredSessions.map(s => (
                    <TableRow key={s.id} className={selectedIds.has(s.id) ? "bg-primary/5" : ""}>
                      <TableCell>
                        <Checkbox checked={selectedIds.has(s.id)} onCheckedChange={() => toggleSelection(s.id)} />
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatTime(s.createdAt)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{s.endedAt ? formatTime(s.endedAt) : "—"}</TableCell>
                      <TableCell className="max-w-[200px] text-xs">
                        <span className="block truncate" title={s.firstQuery ?? ""}>
                          {s.firstQuery ?? "(empty)"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{s.turnCount}</TableCell>
                      <TableCell className="text-xs tabular-nums">{s.totalTokens != null ? formatTokens(s.totalTokens) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {selectedIds.size === 0 && (
              <p className="text-sm text-muted-foreground">Select at least one session to import</p>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "cannbay" && cannbayParadigm == null && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">当前远端：{cannbayScope}</p>
            <div className="grid grid-cols-3 gap-2 max-h-[320px] overflow-y-auto">
              {cannbaySessions.some(s => !s.paradigm) && (
                <Button variant="outline" size="sm" className="justify-between h-auto py-2" onClick={() => pickCannbayParadigm("__none__")}>
                  <span className="truncate">未标注</span>
                  <span className="text-xs text-muted-foreground shrink-0 ml-1">{cannbaySessions.filter(s => !s.paradigm).length}</span>
                </Button>
              )}
              {cannbayParadigms.map(p => (
                <Button key={p} variant="outline" size="sm" className="justify-between h-auto py-2" onClick={() => pickCannbayParadigm(p)}>
                  <span className="truncate" title={p}>{p}</span>
                  <span className="text-xs text-muted-foreground shrink-0 ml-1">
                    {cannbaySessions.some(s => s.isBaseline && s.paradigm === p) ? '基准✓ ' : ''}
                    {cannbaySessions.filter(s => s.paradigm === p).length}
                  </span>
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">范式目录 = 数据仓顶层目录（注册表）；选中后展示该范式下的会话</p>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "cannbay" && cannbayParadigm != null && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              当前远端：{cannbayScope}
              {cannbayParadigms.length > 0 && (
                <> · 范式目录 <span className="font-medium text-foreground">{cannbayParadigm === "__none__" ? "未标注（存量区）" : cannbayParadigm}</span></>
              )}
            </p>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search by query, user, commit message, or task ID..."
                value={cannbayFilter}
                onChange={(e) => setCannbayFilter(e.target.value)}
                className="flex-1"
              />
              <SearchIcon className="size-4 text-muted-foreground shrink-0" />
            </div>
            {(() => {
              const q = cannbayFilter.toLowerCase()
              const scoped = cannbaySessions.filter(s => (s.paradigm ?? "__none__") === cannbayParadigm)
              const filtered = scoped
                .filter(s =>
                  !q || s.description?.toLowerCase().includes(q)
                  || (s.submitter?.toLowerCase().includes(q) ?? false)
                  || s.sid.toLowerCase().includes(q)
                  || (s.framework?.toLowerCase().includes(q) ?? false)
                )
                .slice()
                // baseline 会话（该范式评分基准）置顶，其余按提交时间倒序
                .sort((a, b) => Number(b.isBaseline === true) - Number(a.isBaseline === true) || (b.commitTime || "").localeCompare(a.commitTime || ""))
              const allFilteredSelected = filtered.length > 0 && filtered.every(s => cannbaySelected.has(cannbayEntryKey(s)))
              return (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <Checkbox checked={allFilteredSelected} onCheckedChange={() => {
                      // 键与行选择一致（cannbayEntryKey）：同 sid 双记录两条目各自独立勾选
                      if (allFilteredSelected) {
                        setCannbaySelected(prev => {
                          const next = new Set(prev)
                          for (const s of filtered) next.delete(cannbayEntryKey(s))
                          return next
                        })
                      } else {
                        setCannbaySelected(prev => {
                          const next = new Set(prev)
                          for (const s of filtered) next.add(cannbayEntryKey(s))
                          return next
                        })
                      }
                    }} />
                    <span className="text-sm text-muted-foreground">
                      {q ? `${filtered.length} of ${scoped.length} shown` : `${scoped.length} sessions`}
                    </span>
                  </div>
                  <div className="max-h-[320px] overflow-y-auto border rounded-lg">
                    <Table className="table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[36px] px-2"></TableHead>
                          <TableHead className="w-[170px] px-2">First Query</TableHead>
                          <TableHead className="w-[120px] px-2">Type</TableHead>
                          <TableHead className="w-[64px] px-2">算子生成</TableHead>
                          <TableHead className="w-[90px] px-2">用户名</TableHead>
                          <TableHead className="w-[110px] px-2">时间</TableHead>
                          <TableHead className="px-2">提交信息</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filtered.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={7} className="text-center text-muted-foreground py-4">
                              {q ? "No sessions match your search" : "该范式下暂无会话"}
                            </TableCell>
                          </TableRow>
                        )}
                        {filtered.map(s => (
                          <TableRow key={cannbayEntryKey(s)} className={cannbaySelected.has(cannbayEntryKey(s)) ? "bg-primary/5" : ""}>
                            <TableCell className="px-2 w-[36px]">
                              <Checkbox checked={cannbaySelected.has(cannbayEntryKey(s))} onCheckedChange={() => toggleCannbaySelection(cannbayEntryKey(s))} />
                            </TableCell>
                            <TableCell className="px-2 text-xs py-2 align-middle">
                              <span className="block truncate" title={s.description || s.sid}>
                                {s.isBaseline && <Badge variant="purple" className="px-1 text-[10px] mr-1">baseline</Badge>}
                                {s.description || <span className="text-muted-foreground">{s.sid}</span>}
                              </span>
                            </TableCell>
                            <TableCell className="px-2 text-xs py-2 align-middle">
                              {/* 同 sid 双记录：捕获条目走既有 proxy/框架徽标；原生条目
                                  靠同 sid 两条目并排即可区分，不加额外徽标 */}
                              {/* proxy 徽标：producer=cpx（cpx 捕获定义性声明）或
                                  ccVersion 带 -proxy 后缀（合成 meta 回传 DB version 场景）。
                                  text-[10px] px-1 紧凑徽标：两个并排不超 table-fixed 列宽 */}
                              <span className="inline-flex items-center gap-0.5">
                                {s.framework === "opencode" ? (
                                  <Badge variant="blue" className="px-1 text-[10px]">OpenCode</Badge>
                                ) : s.framework === "cannbot" ? (
                                  <Badge variant="green" className="px-1 text-[10px]">CANNBot</Badge>
                                ) : s.framework === "claude-code" ? (
                                  <Badge variant="orange" className="px-1 text-[10px]">Claude</Badge>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                                {(s.producer === "cpx" || isProxyVersion(s.ccVersion ?? null)) && (
                                  <Badge variant="yellow" className="px-1 text-[10px]">proxy</Badge>
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="px-2 text-xs py-2 align-middle">
                              {/* 算子生成结果标注（上传时勾选，cc-session-meta 可选字段） */}
                              {s.opGen === 'success' ? (
                                <Badge variant="green" className="px-1 text-[10px]">成功</Badge>
                              ) : s.opGen === 'failure' ? (
                                <Badge variant="red" className="px-1 text-[10px]">失败</Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="px-2 text-xs py-2 align-middle">
                              <span className="block truncate" title={s.submitter ?? ""}>
                                {s.submitter || "—"}
                              </span>
                            </TableCell>
                            <TableCell className="px-2 text-xs whitespace-nowrap py-2 align-middle">
                              {s.commitTime ? formatTime(s.commitTime) : "—"}
                            </TableCell>
                            <TableCell className="px-2 text-xs py-2 align-middle">
                              <span className="block truncate" title={s.sid}>
                                {s.fileCount} files · {s.sid}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )
            })()}
            {cannbaySelected.size === 0 && (
              <p className="text-sm text-muted-foreground">Select at least one session to import</p>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "importing" && (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            <div className="flex items-center gap-2 text-xs text-muted-foreground pb-1 border-b">
              <LoaderIcon className="size-3.5 animate-spin" />
              <span>
                Progress: {importStatuses.filter(s => s.status === "success" || s.status === "error").length}/{importStatuses.length}
              </span>
            </div>
            {importStatuses.map(s => {
              const session = previewOf(sessions, s)
              const label = session?.firstQuery ?? s.sessionId
              return (
                <div key={s.key} className="flex items-center gap-2 text-sm border-b pb-1.5 last:border-0">
                  <span className="flex-1 truncate">
                    {label}
                    {s.recording && <span className="text-muted-foreground"> ·{s.recording === "native" ? "native" : "capture"}</span>}
                  </span>
                  {s.status === "pending" && <span className="text-muted-foreground">Waiting</span>}
                  {s.status === "importing" && (
                    <span className="text-blue-600 dark:text-blue-400 flex items-center gap-1">
                      <LoaderIcon className="size-3 animate-spin" />
                      Importing...
                    </span>
                  )}
                  {s.status === "success" && (
                    <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                      {/* 方案一：捕获行 framework 带 -proxy 后缀——剥后缀归一进
                          白名单（同 ImportHistory），proxy 徽标仍走 version */}
                      {(() => {
                        const agentFw = agentFrameworkOf(s.framework ?? null)
                        if (agentFw === "cannbot") return <Badge variant="green">CANNBot</Badge>
                        if (agentFw === "opencode") return <Badge variant="blue">OpenCode</Badge>
                        if (agentFw === "claude-code") return <Badge variant="orange">Claude</Badge>
                        return null
                      })()}
                      {isProxyVersion(s.version ?? null) && <Badge variant="yellow">proxy</Badge>}
                      {s.message}
                    </span>
                  )}
                  {s.status === "error" && <span className="text-red-600 dark:text-red-400">{s.message}</span>}
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter>
          {step === "input" && sourceType !== "cannbay" && (
            <Button onClick={handleLoadSessions} disabled={!filePath.trim() || sessionsLoading}>
              {sessionsLoading ? (
                <span className="flex items-center gap-1.5">
                  <LoaderIcon className="size-4 animate-spin" />
                  Loading...
                </span>
              ) : (
                sourceType === "claude-jsonl" && (filePath.trim().endsWith(".jsonl") || filePath.trim().endsWith(".jsonl.gz")) ? "Import" : "Load Sessions"
              )}
            </Button>
          )}
          {step === "input" && sourceType === "cannbay" && (
            <Button onClick={handleOpenCannbay} disabled={cannbayLoading}>
              {cannbayLoading ? "Fetching..." : `Fetch from ${BAY_NAME}`}
            </Button>
          )}
          {step === "select" && (
            <>
              <Button variant="outline" onClick={() => { setStep("input"); setError(null) }}>
                Back
              </Button>
              <Button onClick={handleImportSelected} disabled={selectedIds.size === 0}>
                Import {selectedIds.size > 0 ? `${selectedIds.size} Selected` : ""}
              </Button>
            </>
          )}
          {step === "cannbay" && cannbayParadigm == null && (
            <Button variant="outline" onClick={() => { setStep("input"); setSourceType("cannbay"); setError(null) }}>
              Back
            </Button>
          )}
          {step === "cannbay" && cannbayParadigm != null && (
            <>
              {cannbayParadigms.length > 0 ? (
                <Button variant="outline" onClick={() => { setCannbayParadigm(null); setCannbayFilter(""); setCannbaySelected(new Set()); }}>
                  范式选择
                </Button>
              ) : (
                <Button variant="outline" onClick={() => { setStep("input"); setSourceType("cannbay"); setError(null) }}>
                  Back
                </Button>
              )}
              <Button onClick={handleImportCannbay} disabled={cannbaySelected.size === 0}>
                Import {cannbaySelected.size > 0 ? `${cannbaySelected.size} Selected` : ""}
              </Button>
            </>
          )}
          {step === "importing" && allSuccessOrError && (
            <Button onClick={handleDone}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
