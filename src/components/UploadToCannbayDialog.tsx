'use client'
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据仓上传弹窗（共享组件）：主页列表行与 会话页标题栏 两处入口共用同一
// 弹窗（范式目录 / 提交人 / 内容描述 / 算子生成结果必选 / baseline）。受控
// 组件——open/onOpenChange 由调用方管理，上传开始与结果经 onUploadStart /
// onResult 回调交还调用方呈现（列表行状态图标 / 会话页 toast）。
// 弹窗标题用 BAY_NAME（@/lib/branding）——context 双名发布时 Bay 显示名随品牌翻转。

import { useEffect, useState } from 'react'
import { loadCannbayConfig, cannbayRemoteInput, isDefaultCannbayRemote } from '@/lib/cannbay-config'
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

export interface UploadCannbayTarget {
  taskId: string
  query?: string | null
  framework?: string | null
  model?: string | null
  startTime?: string | null
  endTime?: string | null
  sourcePath?: string | null
  user?: string | null
}

interface UploadToCannbayDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: UploadCannbayTarget | null
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
function buildUploadDescription(target: UploadCannbayTarget, submitter: string, contentDesc: string): string {
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

// 范式目录下拉仅对默认仓启用（自定义数据湖地址走 directory 机制，网关同样拦截）
function isDefaultRemote(): boolean {
  return isDefaultCannbayRemote(loadCannbayConfig())
}

export function UploadToCannbayDialog({ open, onOpenChange, target, onUploadStart, onResult }: UploadToCannbayDialogProps) {
  const [uploadContentDesc, setUploadContentDesc] = useState('')
  const [uploadSubmitter, setUploadSubmitter] = useState('')
  const [uploadSubmitterTouched, setUploadSubmitterTouched] = useState(false)
  const [uploadCategory, setUploadCategory] = useState('')
  const [uploadBaseline, setUploadBaseline] = useState(false)
  // 算子生成结果标注（随会话 meta 入仓，数据仓列表"算子生成"列展示）：
  // Web UI 必选（成功/失败，未选禁用上传）；'' 仅作初始未选态。数据层仍允许
  // 缺省（CLI 上传/历史数据 → 列表显示 —）
  const [uploadOpGen, setUploadOpGen] = useState<'' | 'success' | 'failure'>('')
  const [paradigmDirs, setParadigmDirs] = useState<string[]>([])
  const [paradigmLoading, setParadigmLoading] = useState(false)
  const [paradigmError, setParadigmError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  // 打开即重置 + 预填（描述=首问，提交人=会话用户）——render-phase prop 变化
  // 模式（https://react.dev/learn/you-might-not-need-an-effect），替代在
  // effect 里同步 setState（react-hooks 规则禁止，会触发级联渲染）
  const [wasOpen, setWasOpen] = useState(false)
  const defaultRemote = isDefaultRemote()
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open && target) {
      setUploadContentDesc((target.query ?? '').trim())
      setUploadSubmitter((target.user ?? '').trim())
      setUploadSubmitterTouched(false)
      setUploadCategory('')
      setUploadBaseline(false)
      setUploadOpGen('')
      setParadigmDirs([])
      setParadigmError(null)
      setParadigmLoading(defaultRemote)
    }
  }

  // 打开且默认仓 → 拉范式目录（异步回调内 setState，非同步）
  useEffect(() => {
    if (!open || !defaultRemote) return
    let active = true
    fetch('/api/ingest/cannbay2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dirs', ...cannbayRemoteInput(loadCannbayConfig()) }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return
        if (!ok) throw new Error(data.error ?? 'Failed to list paradigm dirs')
        const dirs = (data.dirs ?? []).filter((d: string) => d !== 'sessions')
        setParadigmDirs(dirs)
        if (dirs.length === 0) setParadigmError('数据仓暂无范式目录：请先在数据仓新建顶层目录')
      })
      .catch(() => { if (active) setParadigmError('范式目录列表加载失败，请重试') })
      .finally(() => { if (active) setParadigmLoading(false) })
    return () => { active = false }
  }, [open, defaultRemote])

  async function handleUpload() {
    if (!target) return
    setUploading(true)
    onUploadStart?.()
    try {
      const res = await fetch('/api/ingest/cannbay2', {
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
          ...cannbayRemoteInput(loadCannbayConfig()),
        }),
      })
      const data = await res.json()
      onResult?.({ ok: res.ok, message: res.ok ? undefined : (data.error ?? 'Upload failed') })
      if (res.ok) onOpenChange(false)
    } catch {
      onResult?.({ ok: false, message: 'Upload failed: network error' })
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v || !uploading) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传到 {BAY_NAME}</DialogTitle>
          <DialogDescription>会话经数据治理后上传至数据仓，可随时重新导入</DialogDescription>
        </DialogHeader>
        {defaultRemote && (
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>取消</Button>
          <Button
            variant="default"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={handleUpload}
            disabled={uploading || !uploadSubmitter.trim() || uploadOpGen === '' || (isDefaultRemote() && (!uploadCategory || paradigmDirs.length === 0))}
          >
            {uploading ? '上传中...' : '确认上传'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
