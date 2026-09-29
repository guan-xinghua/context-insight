'use client'
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据仓推送凭据引导配置弹窗：未配置（默认仓上传弹窗打开即检）或凭据类失败
// （令牌无效 / 无写权限）时弹出，免绕道设置页。保存走
// PUT /api/settings/lake-auth（服务端 lake-auth.json，一次配置 cpx /
// insight 同机共享）。reason 决定文案语境；保存成功给出脱敏回执并自动收起。
// 动效：入场 fade + zoom(96%) + 上滑（expo-out 缓动）、图标弹性入场（带
// prefers-reduced-motion 降级）、成功态弹性弹出。

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LinkIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from 'lucide-react'
import {
  credentialPromptCopy,
  findStoredAuthEntry,
  serverLakeConfigStatus,
  type LakeTokenReason,
  type StoredRemoteInfo,
} from '@/lib/lake-token-prompt'

interface LakeTokenDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 触发语境：no-credentials（未配置）/ auth-failed（令牌无效）/ forbidden（无写权限） */
  reason?: LakeTokenReason
  /** 保存成功回调（调用方可刷新自身凭据状态） */
  onSaved?: (info: { username: string; tokenMasked: string; verifiedAt?: string | null }) => void
}

interface SavedReceipt {
  username: string
  tokenMasked: string
  verifiedAt?: string | null
  reachable: boolean
}

export function LakeTokenDialog({ open, onOpenChange, reason = 'no-credentials', onSaved }: LakeTokenDialogProps) {
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  // unconfigured 语境：地址可编辑（保存写入服务端 lake-config.json——全机
  // 生效，与设置页同源）。其余语境地址只读展示（服务端配置的当前远端）
  const [addrInput, setAddrInput] = useState('')
  const [serverAddress, setServerAddress] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existing, setExisting] = useState<StoredRemoteInfo | null>(null)
  const [saved, setSaved] = useState<SavedReceipt | null>(null)

  const editableAddr = reason === 'unconfigured'
  const address = editableAddr ? addrInput.trim() : serverAddress
  const copy = credentialPromptCopy(reason)

  // render-phase 打开沿检测（表单重置——effect 内同步 setState 触发级联渲染）
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setToken('')
      setError(null)
      setSaved(null)
      setShowToken(false)
      setAddrInput('')
    }
  }

  // 服务端配置地址（只读语境展示 + 凭据匹配键）；unconfigured 语境顺带探测
  // （保存后的重试由调用方触发，此处仅展示）
  useEffect(() => {
    if (!open) return
    let active = true
    serverLakeConfigStatus().then(st => { if (active) setServerAddress(st.address) })
    fetch('/api/settings/lake-auth')
      .then(r => r.json())
      .then((data: { remotes?: StoredRemoteInfo[] }) => {
        if (!active) return
        const hit = address ? findStoredAuthEntry(data.remotes ?? [], address) : null
        setExisting(hit)
        if (hit?.username) setUsername(hit.username)
      })
      .catch(() => { if (active) setExisting(null) })
    return () => { active = false }
  }, [open, address])

  async function handleSave() {
    if (editableAddr && !address) {
      setError('请填写数据仓地址（https://…/your-lake.git 或本地裸仓路径）')
      return
    }
    if (editableAddr) {
      // 地址落服务端 lake-config.json（全机生效——与设置页同源），
      // 下次 list/upload/viewer 自动生效。失败必须 setError 显式反馈：
      // handleSave 由 onClick/Enter 直接调用（不 await），throw 落在
      // try/catch 之外只会变 unhandled rejection——弹窗零反馈（地址含
      // 非法字符被 PUT 400 拒时用户只看到按钮点了没反应）
      try {
        const cfgRes = await fetch('/api/settings/lake-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: address.replace(/\/+$/, '') }),
        })
        // 非 JSON 错误响应（网关 502 HTML 等）json() 裸抛 → 落兜底文案
        const errBody = await cfgRes.json().catch(() => null) as { error?: string } | null
        if (!cfgRes.ok) throw new Error(String(errBody?.error ?? '地址保存失败'))
      } catch (e) {
        setError(e instanceof Error ? e.message : '网络错误')
        return
      }
    }
    const u = username.trim() || 'oauth2'
    const t = token.trim()
    if (!t || saving || saved) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/lake-auth', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: address, username: u, token: t }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(String(data.error ?? '保存失败'))
      const receipt: SavedReceipt = {
        username: u,
        tokenMasked: String(data.tokenMasked ?? '****'),
        verifiedAt: data.verifiedAt ?? null,
        reachable: data.reachable !== false,
      }
      setSaved(receipt)
      onSaved?.({ username: receipt.username, tokenMasked: receipt.tokenMasked, verifiedAt: receipt.verifiedAt })
      setTimeout(() => onOpenChange(false), 1100)
    } catch (e) {
      setError(e instanceof Error ? e.message : '网络错误')
    } finally {
      setSaving(false)
    }
  }

  const busy = saving || saved != null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent
        showCloseButton={!busy}
        className="gap-0 overflow-hidden p-0 duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] data-open:zoom-in-[0.96] data-open:slide-in-from-bottom-4 data-closed:duration-150 sm:max-w-[26rem]"
      >
        {saved ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <span className="token-dialog-success-pop grid size-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/25 dark:text-emerald-400">
              <CheckCircle2Icon className="size-6" />
            </span>
            <div className="space-y-1">
              <p className="text-sm font-medium">令牌已保存</p>
              <p className="text-xs text-muted-foreground">
                {saved.username} · {saved.tokenMasked}
                {saved.verifiedAt ? ' · 连接验证通过' : ''}
              </p>
              {!saved.reachable && (
                <p className="text-xs text-muted-foreground">地址探测未通过（令牌已保存，上传时以数据仓实际响应为准）</p>
              )}
              <p className="pt-1 text-xs text-muted-foreground">即将关闭，重试上传即可</p>
            </div>
          </div>
        ) : (
          <>
            <DialogHeader className="items-start gap-3 space-y-0 p-5 pb-0 sm:flex-row sm:items-center">
              <span
                className={
                  'token-dialog-icon-pop grid size-11 shrink-0 place-items-center rounded-xl ring-1 ' +
                  (reason === 'forbidden'
                    ? 'bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-400'
                    : reason === 'auth-failed'
                      ? 'bg-destructive/10 text-destructive ring-destructive/20'
                      : 'bg-primary/10 text-foreground/80 ring-foreground/10')
                }
              >
                {reason === 'forbidden' ? <ShieldAlertIcon className="size-5" /> : reason === 'unconfigured' ? <LinkIcon className="size-5" /> : <KeyRoundIcon className="size-5" />}
              </span>
              <div className="min-w-0 space-y-1.5">
                <DialogTitle>{copy.title}</DialogTitle>
                <DialogDescription>{copy.description}</DialogDescription>
              </div>
            </DialogHeader>

            <div className="space-y-4 p-5">
              {editableAddr ? (
                <div className="space-y-1.5">
                  <label htmlFor="cb-token-addr" className="text-xs font-medium text-foreground/80">数据仓地址</label>
                  <Input
                    id="cb-token-addr"
                    value={addrInput}
                    onChange={(e) => setAddrInput(e.target.value)}
                    placeholder="https://example.com/your-lake.git"
                    className="h-8 font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    地址保存到本机服务端（全机生效：导入/上传/Viewer 共用），高级选项见「设置 → 数据之湖」。
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
                  <span className="shrink-0 text-xs text-muted-foreground">远端</span>
                  <span className="truncate font-mono text-xs text-foreground/80" title={address}>{address}</span>
                </div>
              )}
              {existing && (
                <p className="text-xs text-muted-foreground">
                  已配置 {existing.username} · {existing.tokenMasked} —— 输入新令牌将替换
                </p>
              )}
              <div className="space-y-1.5">
                <label htmlFor="cb-token-user" className="text-xs font-medium text-foreground/80">用户名</label>
                <Input
                  id="cb-token-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="托管平台用户名（留空默认 oauth2）"
                  className="h-8 text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="cb-token-secret" className="text-xs font-medium text-foreground/80">推送凭据</label>
                <div className="relative">
                  <Input
                    id="cb-token-secret"
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
                    placeholder={existing ? '输入新令牌替换已配置值' : '在托管平台「个人设置 → 访问令牌」创建'}
                    className="h-8 pr-9 font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    aria-label={showToken ? '隐藏令牌' : '显示令牌'}
                    onClick={() => setShowToken(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showToken ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  令牌保存在本机服务端（权限 0600），cpx 命令行同机可用；默认仓需仓主将你的账号添加为协作者后方可推送。
                </p>
              </div>
              {error && (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="break-all">{error}</span>
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t bg-muted/40 p-4">
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)} disabled={busy}>
                取消
              </Button>
              <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={busy || !token.trim() || (editableAddr && !address)}>
                {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                {saving ? '验证并保存…' : editableAddr ? '连接数据仓' : '保存令牌'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
