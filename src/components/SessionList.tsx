// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

import { useState } from 'react'
import Link from 'next/link'
import { BRAND_NAME, BRAND_SOURCE_TYPE } from '@/lib/branding'
import { loadCannbayConfig, cannbayRemoteInput, isDefaultCannbayRemote } from '@/lib/cannbay-config'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UploadIcon, LoaderIcon, CheckIcon, XIcon, TrashIcon, DownloadIcon, CheckCircleIcon } from 'lucide-react';
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
  items: SessionListItem[];
  total: number;
  page: number;
  pageSize: number;
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

function buildUploadContext(item: SessionListItem): string {
  const model = item.model ?? ''
  const timeRange = `${formatTime(item.startTime)} → ${formatTime(item.endTime)}`
  const framework = item.framework ?? ''
  const sourcePath = item.sourcePath ?? ''
  return `日志路径:${sourcePath ? ' ' + sourcePath : ' taskId ' + item.taskId + ', 框架 ' + framework}
备注: 模型 ${model}, 时间 ${timeRange}`
}

// 范式目录下拉仅对默认仓启用（自定义数据湖地址走 directory 机制，网关同样拦截）
function isDefaultRemote(): boolean {
  return isDefaultCannbayRemote(loadCannbayConfig())
}

// 提交信息组装：提交人（独立输入框唯一事实源）+ 内容描述（选填，空则省略
// 该行）+ 溯源上下文（日志路径/备注，自动附加）。后端网关从首行「提交人:」提取。
function buildUploadDescription(item: SessionListItem, submitter: string, contentDesc: string): string {
  const descLine = contentDesc.trim() ? `内容描述: ${contentDesc.trim()}\n` : '';
  return `提交人: ${submitter.trim()}
${descLine}${buildUploadContext(item)}`
}

export function SessionList({ items, total, page, pageSize }: SessionListProps) {
  const router = useRouter()
  const totalPages = Math.ceil(total / pageSize);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;
  const [deleteMode, setDeleteMode] = useState<'all' | 'selected' | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [uploadStatus, setUploadStatus] = useState<Record<string, UploadStatus>>({})
  const [exportStatus, setExportStatus] = useState<Record<string, ExportStatus>>({})
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [uploadDialogItem, setUploadDialogItem] = useState<SessionListItem | null>(null)
  const [uploadContentDesc, setUploadContentDesc] = useState('')
  const [uploadSubmitter, setUploadSubmitter] = useState('')
  const [uploadSubmitterTouched, setUploadSubmitterTouched] = useState(false)
  // 范式目录（数据仓顶层目录即注册表）：下拉数据源 = action:dirs 动态拉取
  const [uploadCategory, setUploadCategory] = useState('')
  const [uploadBaseline, setUploadBaseline] = useState(false)
  // 算子生成结果标注（随会话 meta 入仓，CANNBay 列表"算子生成"列展示）：
  // Web UI 必选（成功/失败，未选禁用上传）；'' 仅作初始未选态。数据层仍允许
  // 缺省（CLI 上传/历史数据 → 列表显示 —）
  const [uploadOpGen, setUploadOpGen] = useState<'' | 'success' | 'failure'>('')
  const [paradigmDirs, setParadigmDirs] = useState<string[]>([])
  const [paradigmLoading, setParadigmLoading] = useState(false)
  const [paradigmError, setParadigmError] = useState<string | null>(null)

  async function openUploadDialog(item: SessionListItem) {
    setUploadContentDesc((item.query ?? '').trim())
    setUploadSubmitter((item.user ?? '').trim())
    setUploadSubmitterTouched(false)
    setUploadCategory('')
    setUploadBaseline(false)
    setUploadOpGen('')
    setParadigmDirs([])
    setParadigmError(null)
    setUploadDialogItem(item)
    if (!isDefaultRemote()) return
    setParadigmLoading(true)
    try {
      const res = await fetch('/api/ingest/cannbay2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dirs', ...cannbayRemoteInput(loadCannbayConfig()) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to list paradigm dirs')
      const dirs = (data.dirs ?? []).filter((d: string) => d !== 'sessions')
      setParadigmDirs(dirs)
      if (dirs.length === 0) setParadigmError('数据仓暂无范式目录：请先在数据仓顶层新建范式目录')
    } catch {
      setParadigmError('范式目录列表加载失败，请重试')
    } finally {
      setParadigmLoading(false)
    }
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

  async function handleUpload(item: SessionListItem) {
    const key = item.sessionId
    setUploadStatus(prev => ({ ...prev, [key]: 'uploading' }))
    setUploadError(null)
    setUploadDialogItem(null)
    try {
      const res = await fetch('/api/ingest/cannbay2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upload',
          taskId: item.taskId,
          description: buildUploadDescription(item, uploadSubmitter, uploadContentDesc),
          ...(uploadCategory ? { category: uploadCategory, ...(uploadBaseline ? { baseline: true } : {}) } : {}),
          ...(uploadOpGen ? { opGen: uploadOpGen } : {}),
          ...cannbayRemoteInput(loadCannbayConfig()),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setUploadStatus(prev => ({ ...prev, [key]: 'error' }))
        setUploadError(data.error ?? 'Upload failed')
        return
      }
      setUploadStatus(prev => ({ ...prev, [key]: 'done' }))
    } catch {
      setUploadStatus(prev => ({ ...prev, [key]: 'error' }))
      setUploadError('Upload failed: network error')
    }
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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sessions ({total})</h2>
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
      <Dialog open={uploadDialogItem !== null} onOpenChange={(open) => { if (!open) setUploadDialogItem(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>上传到 CANNBay</DialogTitle>
            <DialogDescription>会话经数据治理后上传至数据仓，可随时重新导入</DialogDescription>
          </DialogHeader>
          {isDefaultRemote() && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                范式目录 <span className="text-red-500">*</span>
              </label>
              <select
                className="w-full text-sm px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring/30"
                value={uploadCategory}
                onChange={(e) => setUploadCategory(e.target.value)}
                disabled={paradigmLoading}
              >
                <option value="" disabled>
                  {paradigmLoading ? '加载范式目录中…' : '请选择范式目录'}
                </option>
                {paradigmDirs.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              {paradigmError && <p className="text-xs text-red-500">{paradigmError}</p>}
              <label
                className={
                  uploadCategory
                    ? 'flex items-center gap-2 pt-0.5 cursor-pointer select-none transition-opacity'
                    : 'flex items-center gap-2 pt-0.5 select-none opacity-60'
                }
              >
                <Checkbox
                  checked={uploadBaseline}
                  onCheckedChange={(v) => setUploadBaseline(v === true)}
                  disabled={!uploadCategory}
                  className="cursor-pointer"
                />
                <span className="text-xs text-muted-foreground">
                  设为该范式 baseline 会话（<code>{uploadCategory}/baseline/</code>，原 baseline 移回普通目录）
                </span>
              </label>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              提交人 <span className="text-red-500">*</span>
            </label>
            <input
              className="w-full text-sm px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring/30"
              placeholder="必填：真实姓名或账号"
              value={uploadSubmitter}
              onChange={(e) => { setUploadSubmitter(e.target.value); setUploadSubmitterTouched(true); }}
            />
            {uploadSubmitterTouched && !uploadSubmitter.trim() && (
              <p className="text-xs text-red-500">提交人不能为空</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">内容描述</label>
            <textarea
              className="w-full min-h-[120px] max-h-64 text-sm px-3 py-2 border rounded-md bg-background resize-y overflow-y-auto focus:outline-none focus:ring-2 focus:ring-ring/30"
              placeholder="选填，预填会话首问，可修改"
              value={uploadContentDesc}
              onChange={(e) => setUploadContentDesc(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium shrink-0">
              算子生成结果 <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-1 rounded-lg border bg-muted/40 p-1">
              {([
                { v: 'success' as const, label: '成功' },
                { v: 'failure' as const, label: '失败' },
              ]).map(o => {
                const active = uploadOpGen === o.v
                return (
                  <Button
                    key={o.v}
                    variant="ghost"
                    size="sm"
                    className={
                      o.v === 'success'
                        ? 'h-6 px-3 text-xs' + (active ? ' bg-emerald-600 hover:bg-emerald-600 text-white' : ' text-muted-foreground')
                        : 'h-6 px-3 text-xs' + (active ? ' bg-red-600 hover:bg-red-600 text-white' : ' text-muted-foreground')
                    }
                    onClick={() => setUploadOpGen(active ? '' : o.v)}
                  >
                    {o.label}
                  </Button>
                )
              })}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialogItem(null)}>取消</Button>
            <Button
              variant="default"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => { if (uploadDialogItem) handleUpload(uploadDialogItem) }}
              disabled={!uploadSubmitter.trim() || uploadOpGen === '' || (isDefaultRemote() && (!uploadCategory || paradigmDirs.length === 0))}
            >
              确认上传
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} ({total} sessions)
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev}
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.set('page', String(page - 1));
                window.location.href = url.toString();
              }}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext}
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.set('page', String(page + 1));
                window.location.href = url.toString();
              }}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
