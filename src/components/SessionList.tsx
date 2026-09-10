// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { BRAND_NAME, BRAND_SOURCE_TYPE } from '@/lib/branding'
import { isProxyVersion } from '@/lib/shared/session-format'
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { UploadToCannbayDialog, type UploadCannbayTarget } from '@/components/UploadToCannbayDialog';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UploadIcon, LoaderIcon, CheckIcon, XIcon, TrashIcon, DownloadIcon, CheckCircleIcon, SearchIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from 'lucide-react';
import { toast } from 'sonner';

interface SessionListItem {
  sessionId: string;
  taskId: string;
  query: string | null;
  framework: string | null;
  version?: string | null;
  startTime: string;
  importedAt: string;
  endTime: string | null;
  totalTokens: number;
  totalCost: number;
  totalLatencyMs: number;
  totalToolCallCount: number;
  totalSkillLoadCount: number;
  totalSubagentCount: number;
  model: string | null;
  user: string | null;
  sourcePath: string | null;
}

interface SessionListProps {
  /** SSR 首屏初始数据（此后翻页/搜索走客户端 /api/observe/data，无整页刷新） */
  items: SessionListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** 初始搜索词（直接打开 /?q= 链接时由 SSR 提供） */
  q?: string;
  /** 未过滤的会话总数（搜索时显示 N of M） */
  totalCount?: number;
}

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';
type ExportStatus = 'idle' | 'exporting' | 'done' | 'error';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}


// 数字页码窗口：1 … c-1 c c+1 … last（当前页恒在，两端恒在，中间留 1 页上下文）
function pageWindow(current: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const out: Array<number | '…'> = [1]
  const from = Math.max(2, current - 1)
  const to = Math.min(totalPages - 1, current + 1)
  if (from > 2) out.push('…')
  for (let p = from; p <= to; p++) out.push(p)
  if (to < totalPages - 1) out.push('…')
  out.push(totalPages)
  return out
}

export function SessionList({ items: initialItems, total: initialTotal, page: initialPage, pageSize, q: initialQ = '', totalCount: initialTotalCount }: SessionListProps) {
  const router = useRouter()
  // 客户端自取数：翻页/搜索 GET /api/observe/data 局部更新（无整页刷新），
  // SSR 初始值供首屏；URL 经 history.replaceState 同步（可分享、不触发导航）
  const [items, setItems] = useState(initialItems)
  const [total, setTotal] = useState(initialTotal)
  const [allCount, setAllCount] = useState(initialTotalCount ?? initialTotal)
  const [page, setPage] = useState(initialPage)
  const [q, setQ] = useState(initialQ)
  const [searchInput, setSearchInput] = useState(initialQ)
  const [loading, setLoading] = useState(false)
  const reqSeq = useRef(0)

  async function fetchSessions(nextPage: number, nextQ: string) {
    const seq = ++reqSeq.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) })
      if (nextQ) params.set('q', nextQ)
      const res = await fetch(`/api/observe/data?${params}`)
      const data = await res.json()
      if (seq !== reqSeq.current || !res.ok) return
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
      if (data.totalCount != null) setAllCount(data.totalCount)
      else setAllCount(data.total ?? 0)
      setPage(nextPage)
      setQ(nextQ)
      const url = new URL(window.location.href)
      if (nextQ) url.searchParams.set('q', nextQ)
      else url.searchParams.delete('q')
      if (nextPage > 1) url.searchParams.set('page', String(nextPage))
      else url.searchParams.delete('page')
      window.history.replaceState(null, '', url.toString())
    } catch {
      /* 网络错误：保留当前数据 */
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }

  // 输入防抖自动搜索（400ms 无操作触发；回车/按钮立即）
  useEffect(() => {
    const v = searchInput.trim()
    if (v === q) return
    const t = setTimeout(() => { fetchSessions(1, v) }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  function submitSearch() {
    fetchSessions(1, searchInput.trim())
  }

  const totalPages = Math.ceil(total / pageSize);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;
  const [deleteMode, setDeleteMode] = useState<'all' | 'selected' | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [uploadStatus, setUploadStatus] = useState<Record<string, UploadStatus>>({})
  const [exportStatus, setExportStatus] = useState<Record<string, ExportStatus>>({})
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // 上传弹窗（共享组件）：目标会话 + 开关；上传结果经回调回填行内状态图标
  const [uploadTarget, setUploadTarget] = useState<UploadCannbayTarget | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)

  function openUploadDialog(item: SessionListItem) {
    setUploadTarget({
      taskId: item.taskId,
      query: item.query,
      framework: item.framework,
      model: item.model,
      startTime: item.startTime,
      endTime: item.endTime,
      sourcePath: item.sourcePath,
      user: item.user,
    })
    setUploadOpen(true)
  }

  function handleToggle(sessionId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  async function handleDeleteAll() {
    try {
      const res = await fetch('/api/ingest/delete-session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteAll: true }),
      })
      if (res.ok) window.location.reload()
    } catch {}
  }

  async function handleDeleteSelected() {
    const entries = selectedArr
      .map(id => items.find(i => i.sessionId === id))
      .filter((i): i is SessionListItem => i != null)
      .map(i => ({ taskId: i.taskId, framework: i.framework ?? 'unknown' }))
    if (entries.length === 0) return
    try {
      const res = await fetch('/api/ingest/delete-session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions: entries }),
      })
      if (res.ok) window.location.reload()
    } catch {}
  }

  async function handleDeleteOne(item: SessionListItem) {
    try {
      const res = await fetch('/api/ingest/delete-session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.taskId, framework: item.framework ?? 'unknown' }),
      })
      if (res.ok) window.location.reload()
    } catch {}
  }

  async function handleExport(item: SessionListItem) {
    const key = item.sessionId
    setExportStatus(prev => ({ ...prev, [key]: 'exporting' }))
    try {
      const res = await fetch('/api/ingest/export-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.taskId }),
      })
      if (!res.ok) {
        const err = await res.json()
        setExportStatus(prev => ({ ...prev, [key]: 'error' }))
        toast.error('Export failed', { description: err.error ?? 'Unknown error' })
        return
      }
      const blob = await res.blob()
      const defaultName = `cannbot_session_${item.taskId}.db`
      const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName?: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ name: string; createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker
      if (typeof picker === 'function') {
        try {
          const handle = await picker({
            suggestedName: defaultName,
            types: [{ description: 'SQLite Database', accept: { 'application/x-sqlite3': ['.db'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          setExportStatus(prev => ({ ...prev, [key]: 'done' }))
          toast.success('Database exported', {
            description: `Saved to ${handle.name}.`,
            icon: <CheckCircleIcon className="size-4" />,
            duration: 5000,
          })
          return
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            setExportStatus(prev => ({ ...prev, [key]: 'idle' }))
            return
          }
        }
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = defaultName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      setExportStatus(prev => ({ ...prev, [key]: 'done' }))
      toast.success('Database exported', {
        description: `${defaultName} has been downloaded.`,
        icon: <CheckCircleIcon className="size-4" />,
        duration: 5000,
      })
    } catch {
      setExportStatus(prev => ({ ...prev, [key]: 'error' }))
      toast.error('Export failed', { description: 'Network error' })
    }
  }

  const selectedArr = Array.from(selectedIds)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">
            Sessions ({total})
            {q && allCount !== total && (
              <span className="text-sm font-normal text-muted-foreground ml-1">of {allCount}</span>
            )}
          </h2>
          <div className="flex items-center gap-1.5">
            <Input
              placeholder="Search keyword or session ID"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSearch() }}
              className="w-52 sm:w-64"
            />
            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              onClick={submitSearch}
              disabled={loading}
              title="Search"
            >
              {loading ? <LoaderIcon className="size-3.5 animate-spin" /> : <SearchIcon className="size-3.5" />}
            </Button>
            {q && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-muted-foreground"
                onClick={() => { setSearchInput(''); fetchSessions(1, '') }}
                title="Clear"
              >
                <XIcon className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {selectedIds.size === 0 && "Select 2 to compare, or any number to delete"}
            {selectedIds.size === 1 && "1 selected"}
            {selectedIds.size === 2 && "2 selected — Compare ready"}
            {selectedIds.size > 2 && `${selectedIds.size} selected`}
          </span>
          {selectedIds.size === 2 && (
            <Button
              variant="default"
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => {
                router.push(`/compare?ids=${selectedArr[0]},${selectedArr[1]}`)
              }}
            >
              Compare Selected
            </Button>
          )}
          {selectedIds.size >= 1 && (
            <Button
              variant="destructive"
              size="sm"
              className="gap-1"
              onClick={() => setDeleteMode('selected')}
            >
              <TrashIcon className="size-3.5" />
              Delete Selected ({selectedIds.size})
            </Button>
          )}
          {total > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive gap-1"
              onClick={() => setDeleteMode('all')}
            >
              <TrashIcon className="size-3.5" />
              Delete All
            </Button>
          )}
        </div>
      </div>

      {uploadError && (
        <span className="text-xs text-red-500">{uploadError}</span>
      )}

      <Dialog open={deleteMode !== null} onOpenChange={(open) => { if (!open) setDeleteMode(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleteMode === 'all' ? 'Delete All Sessions' : `Delete ${selectedIds.size} Session${selectedIds.size > 1 ? 's' : ''}`}
            </DialogTitle>
            <DialogDescription className="text-base">
              {deleteMode === 'all'
                ? `将从 Insight 数据库中移除全部 ${total} 个 session 的分析数据。原始会话文件不受影响，可随时重新导入。`
                : `将从 Insight 数据库中移除选中的 ${selectedIds.size} 个 session 的分析数据。原始会话文件不受影响，可随时重新导入。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteMode(null)}>取消</Button>
            <Button variant="destructive" onClick={() => {
              const mode = deleteMode
              setDeleteMode(null)
              if (mode === 'all') handleDeleteAll()
              else if (mode === 'selected') handleDeleteSelected()
            }}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmDeleteId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteId(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Session</DialogTitle>
            <DialogDescription className="text-base">
              将从 Insight 数据库中移除该 session 的分析数据。原始会话文件不受影响，可随时重新导入。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>取消</Button>
            <Button variant="destructive" onClick={() => {
              const item = items.find(i => i.sessionId === confirmDeleteId)
              setConfirmDeleteId(null)
              if (item) handleDeleteOne(item)
            }}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UploadToCannbayDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        target={uploadTarget}
        onUploadStart={() => {
          const item = items.find(i => uploadTarget && i.taskId === uploadTarget.taskId)
          if (item) setUploadStatus(prev => ({ ...prev, [item.sessionId]: 'uploading' }))
          setUploadError(null)
        }}
        onResult={({ ok, message }) => {
          const item = items.find(i => uploadTarget && i.taskId === uploadTarget.taskId)
          if (item) setUploadStatus(prev => ({ ...prev, [item.sessionId]: ok ? 'done' : 'error' }))
          if (!ok && message) setUploadError(message)
        }}
      />
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs w-16"></TableHead>
              <TableHead className="text-xs">Query</TableHead>
              <TableHead className="text-xs">Type</TableHead>
              <TableHead className="text-xs whitespace-nowrap">Start → End</TableHead>
              <TableHead className="text-xs whitespace-nowrap">Import Time</TableHead>
              <TableHead className="text-xs text-left whitespace-nowrap">Model</TableHead>
              <TableHead className="text-xs">Tokens</TableHead>
              <TableHead className="text-xs">Cost</TableHead>
              <TableHead className="text-xs">Duration</TableHead>
              <TableHead className="text-xs w-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  No sessions found. Import a session to get started.
                </TableCell>
              </TableRow>
            )}
            {items.map((item) => {
              const uStatus = uploadStatus[item.sessionId] ?? 'idle'
              const eStatus = exportStatus[item.sessionId] ?? 'idle'
              return (
                <TableRow key={item.sessionId} className={selectedIds.has(item.sessionId) ? 'bg-blue-500/10' : ''}>
                  <TableCell className="w-8 px-2">
                    <Checkbox
                      checked={selectedIds.has(item.sessionId)}
                      onCheckedChange={() => handleToggle(item.sessionId)}
                    />
                  </TableCell>
                  <TableCell className="max-w-[300px] truncate text-xs">
                    <Link
                      href={`/session/${item.taskId}?framework=${item.framework ?? 'unknown'}`}
                      className="text-primary hover:underline"
                    >
                      {item.query ?? item.taskId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">
                    {item.framework === 'opencode' || item.framework === 'claude-code' || item.framework === 'cannbot' ? (
                      <span className="inline-flex items-center gap-1">
                        {item.framework === 'opencode'
                          ? <Badge variant="blue">OpenCode</Badge>
                          : item.framework === 'cannbot'
                            ? <Badge variant="green">CANNBot</Badge>
                            : <Badge variant="orange">Claude</Badge>}
                        {isProxyVersion(item.version) && (
                          <Badge variant="yellow">proxy</Badge>
                        )}
                      </span>
                    ) : item.framework === BRAND_SOURCE_TYPE ? (
                      <Badge variant="purple">{BRAND_NAME}</Badge>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatTime(item.startTime)} → {formatTime(item.endTime)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{formatTime(item.importedAt)}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap pl-0">{item.model ?? '—'}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatTokens(item.totalTokens)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatCost(item.totalCost)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatDuration(item.totalLatencyMs)}</TableCell>
                  <TableCell className="px-2">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-red-600"
                        onClick={() => setConfirmDeleteId(item.sessionId)}
                        title="Delete session"
                      >
                        <TrashIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-6"
                        onClick={() => handleExport(item)}
                        disabled={eStatus === 'exporting'}
                        title="Export DB"
                      >
                        {eStatus === 'idle' && <DownloadIcon className="size-3.5" />}
                        {eStatus === 'exporting' && <LoaderIcon className="size-3.5 animate-spin" />}
                        {eStatus === 'done' && <CheckCircleIcon className="size-3.5 text-green-600" />}
                        {eStatus === 'error' && <XIcon className="size-3.5 text-red-500" />}
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-6"
                        onClick={() => openUploadDialog(item)}
                        disabled={uStatus === 'uploading'}
                        title="Upload to CANNBay"
                      >
                        {uStatus === 'idle' && <UploadIcon className="size-3.5" />}
                        {uStatus === 'uploading' && <LoaderIcon className="size-3.5 animate-spin" />}
                        {uStatus === 'done' && <CheckIcon className="size-3.5 text-green-600" />}
                        {uStatus === 'error' && <XIcon className="size-3.5 text-red-500" />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {(totalPages > 1 || total > 0) && (
        <div className="flex items-center justify-between gap-3 mt-4 flex-wrap">
          <p className="text-xs text-muted-foreground">
            {q ? `${total} of ${allCount} sessions` : `${total} sessions`}
            {totalPages > 1 && ` · 第 ${page} / ${totalPages} 页`}
            {loading && <LoaderIcon className="inline size-3 ml-1.5 animate-spin align-[-2px]" />}
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="size-7" disabled={!hasPrev || loading} onClick={() => fetchSessions(1, q)} title="第一页">
                <ChevronsLeftIcon className="size-3.5" />
              </Button>
              <Button variant="outline" size="icon" className="size-7" disabled={!hasPrev || loading} onClick={() => fetchSessions(page - 1, q)} title="上一页">
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              {pageWindow(page, totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground select-none">…</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === page ? 'default' : 'outline'}
                    size="icon"
                    className={`size-7 text-xs tabular-nums ${p === page ? 'font-semibold' : ''}`}
                    disabled={loading}
                    onClick={() => { if (p !== page) fetchSessions(p, q) }}
                  >
                    {p}
                  </Button>
                )
              )}
              <Button variant="outline" size="icon" className="size-7" disabled={!hasNext || loading} onClick={() => fetchSessions(page + 1, q)} title="下一页">
                <ChevronRightIcon className="size-3.5" />
              </Button>
              <Button variant="outline" size="icon" className="size-7" disabled={!hasNext || loading} onClick={() => fetchSessions(totalPages, q)} title="最后一页">
                <ChevronsRightIcon className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
