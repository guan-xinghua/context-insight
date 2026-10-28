'use client'
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据仓上传弹窗（共享组件）：主页列表行与 会话页标题栏 两处入口共用同一
// 弹窗（范式目录 / 提交人 / 内容描述 / 任务结果必选 / baseline）。受控
// 组件——open/onOpenChange 由调用方管理，上传开始与结果经 onUploadStart /
// onResult 回调交还调用方呈现（列表行状态图标 / 会话页 toast）。
// 弹窗标题用 BAY_NAME（@/lib/branding）——context 双名发布时 Bay 显示名随品牌翻转。

import { useEffect, useState } from 'react'

import { BAY_NAME } from '@/lib/branding'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LakeTokenDialog } from '@/components/LakeTokenDialog'
import {
  findStoredAuthEntry,
  isCredentialErrorCode,
  serverLakeConfigStatus,
  type LakeTokenReason,
  type StoredRemoteInfo,
} from '@/lib/lake-token-prompt'

export interface UploadLakeTarget {
  taskId: string
  query?: string | null
  framework?: string | null
  model?: string | null
  startTime?: string | null
  endTime?: string | null
  sourcePath?: string | null
  user?: string | null
}

interface UploadToLakeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: UploadLakeTarget | null
  onUploadStart?: () => void
  onResult?: (result: { ok: boolean; message?: string }) => void
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const minute = String(d.getMinutes()).padStart(2, '0')
    return `${month}/${day} ${hour}:${minute}`
  } catch {
    return String(iso)
  }
}

// 提交信息组装：提交人（独立输入框唯一事实源）+ 内容描述（选填，空则省略
// 该行）+ 溯源上下文（日志路径/备注，自动附加）。后端网关从首行「提交人:」提取。
function buildUploadDescription(target: UploadLakeTarget, submitter: string, contentDesc: string): string {
  const model = target.model ?? ''
  const timeRange = `${formatTime(target.startTime)} → ${formatTime(target.endTime)}`
  const framework = target.framework ?? ''
  const sourcePath = target.sourcePath ?? ''
  const context = `日志路径:${sourcePath ? ' ' + sourcePath : ' taskId ' + target.taskId + ', 框架 ' + framework}
备注: 模型 ${model}, 时间 ${timeRange}`
  const descLine = contentDesc.trim() ? `内容描述: ${contentDesc.trim()}\n` : ''
  return `提交人: ${submitter.trim()}
${descLine}${context}`
}

export function UploadToLakeDialog({ open, onOpenChange, target, onUploadStart, onResult }: UploadToLakeDialogProps) {
  const [uploadContentDesc, setUploadContentDesc] = useState('')
  const [uploadSubmitter, setUploadSubmitter] = useState('')
  const [uploadSubmitterTouched, setUploadSubmitterTouched] = useState(false)
  const [uploadCategory, setUploadCategory] = useState('')
  const [uploadBaseline, setUploadBaseline] = useState(false)
  // 任务结果标注（随会话 meta 入仓，数据仓列表"任务结果"列展示）：
  // Web UI 必选（成功/失败，未选禁用上传）；'' 仅作初始未选态。数据层仍允许
  // 缺省（CLI 上传/历史数据 → 列表显示 —）
  const [uploadOpGen, setUploadOpGen] = useState<'' | 'success' | 'failure'>('')
  // 同步上传原生会话（仅捕获行显示）：勾选即预检（native-preview 只读探测），
  // 上传时随捕获行一起落 <sid>.native/（codex 原生 sid 不同，以响应为准）
  const [withNative, setWithNative] = useState(false)
  const [nativePreview, setNativePreview] = useState<{ loading: boolean; found?: boolean; origin?: 'db' | 'disk'; reason?: string } | null>(null)
  const [paradigmDirs, setParadigmDirs] = useState<string[]>([])
  const [paradigmLoading, setParadigmLoading] = useState(false)
  const [paradigmError, setParadigmError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  // 凭据引导弹窗：默认仓上传必然需要凭据——打开即检（未配置主动弹出），
  // 凭据类失败（凭据无效/无写权限）反应弹出；保存一次全机生效
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [tokenReason, setTokenReason] = useState<LakeTokenReason>('no-credentials')

  // 打开即重置 + 预填（描述=首问，提交人=会话用户）——render-phase prop 变化
  // 模式（https://react.dev/learn/you-might-not-need-an-effect），替代在
  // effect 里同步 setState（react-hooks 规则禁止，会触发级联渲染）
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open && target) {
      setUploadContentDesc((target.query ?? '').trim())
      setUploadSubmitter((target.user ?? '').trim())
      setUploadSubmitterTouched(false)
      setUploadCategory('')
      setUploadBaseline(false)
      setUploadOpGen('')
      setWithNative(false)
      setNativePreview(null)
      setParadigmDirs([])
      setParadigmError(null)
      setParadigmLoading(true)
    }
  }

  // 打开 → 拉范式目录 + 会话清单（单源：服务端配置远端；根级会话目录不进注册表）
  useEffect(() => {
    if (!open) return
    let active = true
    fetch('/api/ingest/lake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return
        if (!ok) throw new Error(data.error ?? 'Failed to list paradigm dirs')
        // 全仓顶层目录即范式注册表（sessions/ 存量区特判已退役）；根级
        // 会话目录（缺省上传位）按会话清单剔除
        const rootFolders = new Set(((data.sessions ?? []) as Array<{ sid: string; paradigm: string | null; recording?: string }>).filter(s => !s.paradigm).map(s => s.sid + (s.recording === 'native' ? '.native' : '')))
        const dirs = ((data.dirs ?? []) as string[]).filter(d => !rootFolders.has(d))
        setParadigmDirs(dirs)
        if (dirs.length === 0) setParadigmError('数据仓暂无范式目录：请先在数据仓新建顶层目录')
      })
      .catch(() => { if (active) setParadigmError('范式目录列表加载失败，请重试') })
      .finally(() => { if (active) setParadigmLoading(false) })
    return () => { active = false }
  }, [open])

  // 打开 → 凭据预检：服务端配置远端的已存凭据缺失直接弹引导（免去填完表单
  // 才在提交时撞 no-credentials）；已配置则静默
  useEffect(() => {
    if (!open) return
    let active = true
    void (async () => {
      try {
        const st = await serverLakeConfigStatus()
        if (!active) return
        if (!st.configured) return // 地址预检在提交时拦（unconfigured 语境）
        const res = await fetch('/api/settings/lake-auth')
        const data = await res.json() as { remotes?: StoredRemoteInfo[] }
        if (!active) return
        if (!findStoredAuthEntry(data.remotes ?? [], st.address)) {
          setTokenReason('no-credentials')
          setTokenDialogOpen(true)
        }
      } catch { /* 状态读取失败不阻塞上传弹窗 */ }
    })()
    return () => { active = false }
  }, [open])

  // 勾选「同步上传原生会话」→ 只读预检（DB 直查 + 本机磁盘发现），结果即时
  // 呈现：找到（已导入/本机文件）或未找到（白话原因），用户上传前心里有数
  function handleToggleNative(checked: boolean) {
    setWithNative(checked)
    setNativePreview(null)
    if (!checked || !target) return
    setNativePreview({ loading: true })
    fetch('/api/ingest/lake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'native-preview', taskId: target.taskId, framework: target.framework ?? undefined }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        const r = data?.resolution as { status?: string; origin?: 'db' | 'disk'; reason?: string } | undefined
        if (!ok || !r || r.status !== 'found') {
          setNativePreview({ loading: false, found: false, reason: r?.reason ?? (ok ? '未找到原生会话' : String(data.error ?? '预检失败')) })
          return
        }
        setNativePreview({ loading: false, found: true, origin: r.origin })
      })
      .catch(() => setNativePreview({ loading: false, found: false, reason: '预检失败：网络错误' }))
  }

  async function handleUpload() {
    if (!target) return
    // 未配置预检（与 LocalFileImport 同款）：服务端 lake-config.json 未配 →
    // 弹引导；已配则请求不带 config（服务端单源解析）
    const server = await serverLakeConfigStatus()
    if (!server.configured) {
      setTokenReason('unconfigured')
      setTokenDialogOpen(true)
      return
    }
    setUploading(true)
    onUploadStart?.()
    try {
      const res = await fetch('/api/ingest/lake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upload',
          taskId: target.taskId,
          // 同 sid 双行（方案一）消歧：不带 framework 裸 taskId 会上传另一行
          framework: target.framework ?? undefined,
          description: buildUploadDescription(target, uploadSubmitter, uploadContentDesc),
          ...(uploadCategory ? { category: uploadCategory, ...(uploadBaseline ? { baseline: true } : {}) } : {}),
          ...(uploadOpGen ? { opGen: uploadOpGen } : {}),
          ...(withNative ? { withNative: true } : {}),
        }),
      })
      const data = await res.json()
      // 凭据类错误（无凭据/鉴权失败/无权限）：弹引导配置弹窗（免绕道设置页），
      // 文案仍随结果回调给调用方展示
      let message = res.ok ? undefined : String(data.error ?? 'Upload failed')
      if (!res.ok && isCredentialErrorCode(data.code)) {
        message = `${message} —— 请在弹窗中配置凭据后重试`
        setTokenReason(data.code)
        setTokenDialogOpen(true)
      }
      // 原生会话同步结果独立呈现（捕获行已上传成功，原生结果不影响 ok）
      if (res.ok && withNative) {
        const native = data?.native as { status?: string; reason?: string } | undefined
        if (native?.status === 'uploaded') message = '原生会话已同步上传'
        else if (native?.status === 'not-found') message = `捕获已上传；原生会话未找到：${native.reason ?? '未知原因'}`
        else if (native?.status === 'failed') message = `捕获已上传；原生会话上传失败：${native.reason ?? '未知原因'}`
      }
      onResult?.({ ok: res.ok, message })
      if (res.ok) onOpenChange(false)
    } catch {
      onResult?.({ ok: false, message: 'Upload failed: network error' })
    } finally {
      setUploading(false)
    }
  }

  const isProxyTarget = (target?.framework ?? '').endsWith('-proxy')

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v || !uploading) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传到 {BAY_NAME}</DialogTitle>
          <DialogDescription>会话经数据治理后上传至数据仓，可随时重新导入</DialogDescription>
        </DialogHeader>
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
            任务结果 <span className="text-red-500">*</span>
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
        {isProxyTarget && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Checkbox
                checked={withNative}
                onCheckedChange={(v) => handleToggleNative(v === true)}
                disabled={uploading}
                className="cursor-pointer"
              />
              <span className="text-xs text-muted-foreground">
                同步上传本机原生会话（同一场对话的原生记录，一并入仓便于对照）
              </span>
            </label>
            {nativePreview && (
              <p className={'text-xs ' + (nativePreview.loading ? 'text-muted-foreground' : nativePreview.found ? 'text-emerald-600' : 'text-amber-600')}>
                {nativePreview.loading
                  ? '正在查找本机原生会话…'
                  : nativePreview.found
                    ? `已找到原生会话${nativePreview.origin === 'disk' ? '（本机文件，上传时自动导入）' : '（已导入）'}`
                    : `未找到原生会话：${nativePreview.reason ?? '本机没有对应记录'}`}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>取消</Button>
          <Button
            variant="default"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={handleUpload}
            disabled={uploading || !uploadSubmitter.trim() || uploadOpGen === '' || (!uploadCategory || paradigmDirs.length === 0)}
          >
            {uploading ? '上传中...' : '确认上传'}
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* 令牌引导弹窗（叠加在上传弹窗之上；保存成功自动收起，表单保留可重试） */}
      <LakeTokenDialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen} reason={tokenReason} onSaved={() => { if (tokenReason === 'unconfigured') { setTokenDialogOpen(false); handleUpload() } }} />
    </Dialog>
  )
}
