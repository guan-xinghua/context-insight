"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { ArrowLeftIcon } from "lucide-react"
import { BRAND_NAME, BAY_NAME } from "@/lib/branding"
import { VERSION_DISPLAY } from "@/lib/version"
import { AIProviderConfigPanel } from "@/components/observe/AIProviderConfigPanel"
import {
  loadLakeConfig,
  clearLakeConfig,
  planCredentialAction,
  type LakeConfig,
  type LakeAuthMode,
} from "@/lib/lake-config"

export default function SettingsPage() {
  const [address, setAddress] = useState("")
  const [authMode, setAuthMode] = useState<LakeAuthMode>("none")
  const [account, setAccount] = useState("")
  const [password, setPassword] = useState("")
  const [token, setToken] = useState("")
  const [branch, setBranch] = useState("")
  const [directory, setDirectory] = useState("")
  const [savedFlag, setSavedFlag] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [authStatus, setAuthStatus] = useState<{ username: string; tokenMasked: string; verifiedAt?: string } | null>(null)
  const [authHint, setAuthHint] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browsePrefix, setBrowsePrefix] = useState("")
  const [browseDirs, setBrowseDirs] = useState<string[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchList, setBranchList] = useState<string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)

  useEffect(() => {
    // 渲染期零读 localStorage（hydration 契约，同 v1.84 AIProviderConfigPanel）。
    // 单源架构：服务端 lake-config.json 为准（全机生效）；未配置时用 legacy
    // localStorage 值预填表单（存量用户保存一次即完成迁移）。凭据形态字段
    // （authMode/账号/令牌）不落服务端配置文件，从 legacy 预填或空
    void (async () => {
      const legacy = loadLakeConfig()
      try {
        const res = await fetch("/api/settings/lake-config")
        const data = await res.json() as { configured?: boolean; address?: string; branch?: string; directory?: string }
        if (data.configured && data.address) {
          setAddress(data.address)
          setBranch(data.branch?.trim() || "main")
          setDirectory(data.directory ?? "")
          setSavedFlag(true)
        } else if (legacy) {
          setAddress(legacy.address)
          setBranch(legacy.branch)
          setDirectory(legacy.directory)
        } else {
          setBranch("main")
        }
      } catch {
        if (legacy) {
          setAddress(legacy.address)
          setBranch(legacy.branch)
          setDirectory(legacy.directory)
        } else {
          setBranch("main")
        }
      }
      if (legacy) {
        setAuthMode(legacy.authMode)
        setAccount(legacy.account)
        setPassword(legacy.password)
        setToken(legacy.token)
      }
      setHydrated(true)
    })()
  }, [])

  // 服务端凭据状态（lake-auth.json）：按当前地址展示已配置的令牌脱敏信息
  useEffect(() => {
    if (!hydrated) return
    let active = true
    fetch("/api/settings/lake-auth")
      .then(r => r.json())
      .then((data: { remotes?: Array<{ url: string; username: string; tokenMasked: string; verifiedAt?: string }> }) => {
        if (!active) return
        const key = address.trim().replace(/\/+$/, "")
        const hit = data.remotes?.find(r => r.url === key || r.url === `${key}.git` || r.url.replace(/\.git$/, "") === key.replace(/\.git$/, ""))
        setAuthStatus(hit ?? null)
      })
      .catch(() => { /* 状态读取失败不阻塞页面 */ })
    return () => { active = false }
  }, [hydrated, address])

  const config: LakeConfig = {
    address: address.trim(),
    authMode,
    account,
    password,
    token,
    branch,
    directory,
  }

  function dirty() {
    setSavedFlag(false)
    setTestResult(null)
    setAuthHint(null)
  }

  // 保存（单源架构）：远端偏好（地址/分支/目录）落服务端 lake-config.json
  // ——全机生效（导入/上传/Viewer/CLI 共读同一份）；legacy localStorage 同步
  // 清除（防旧值在服务端配置清空后复活）。凭据（用户名+令牌/密码）落服务端
  // lake-auth.json（与 cpx 同机共享）。凭据操作走 planCredentialAction 决策：
  // 匿名模式清除该地址凭据；token/password 模式输入留空 = 保留现有
  async function handleSave() {
    setSavedFlag(true)
    const remoteUrl = address.trim().replace(/\/+$/, "")
    try {
      const cfgRes = await fetch("/api/settings/lake-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: remoteUrl, branch: branch.trim() || "main", directory: directory.trim() }),
      })
      if (!cfgRes.ok) throw new Error(String((await cfgRes.json()).error ?? "远端偏好保存失败"))
      clearLakeConfig()
      const action = planCredentialAction(config)
      if (action === "save-token") {
        const res = await fetch("/api/settings/lake-auth", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: remoteUrl, username: account.trim() || "oauth2", token: token.trim() }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(String(data.error ?? "凭据保存失败"))
        setAuthStatus({ username: account.trim() || "oauth2", tokenMasked: String(data.tokenMasked ?? "****"), verifiedAt: data.verifiedAt ?? undefined })
        setAuthHint(data.reachable === false ? "已保存，但地址探测未通过（私有仓/网络问题可忽略，令牌有效性由首次上传确认）" : "凭据已保存到本机服务端（cpx 与 insight 共用）")
      } else if (action === "save-password") {
        const res = await fetch("/api/settings/lake-auth", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: remoteUrl, username: account.trim(), token: password.trim() }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(String(data.error ?? "凭据保存失败"))
        setAuthStatus({ username: account.trim(), tokenMasked: String(data.tokenMasked ?? "****"), verifiedAt: data.verifiedAt ?? undefined })
        setAuthHint(data.reachable === false ? "已保存，但地址探测未通过（私有仓/网络问题可忽略，令牌有效性由首次上传确认）" : "凭据已保存到本机服务端（cpx 与 insight 共用）")
      } else if (action === "clear") {
        await fetch("/api/settings/lake-auth", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: remoteUrl }),
        })
        setAuthStatus(null)
        setAuthHint("匿名模式：已清除该地址的服务端凭据")
      } else {
        setAuthHint("令牌/密码留空：已保留该地址的服务端凭据（输入新值可更换；切到匿名模式可清除）")
      }
    } catch (e) {
      setAuthHint(`凭据保存失败：${e instanceof Error ? e.message : "网络错误"}`)
    }
  }

  async function handleClear() {
    clearLakeConfig()
    const remoteUrl = address.trim().replace(/\/+$/, "")
    fetch("/api/settings/lake-config", { method: "DELETE" }).catch(() => { /* best-effort */ })
    fetch("/api/settings/lake-auth", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: remoteUrl }),
    }).catch(() => { /* best-effort */ })
    setAddress("")
    setAuthMode("none")
    setAccount("")
    setPassword("")
    setToken("")
    setBranch("main")
    setDirectory("")
    setSavedFlag(false)
    setTestResult(null)
    setAuthStatus(null)
    setAuthHint(null)
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      // 测试的是用户正在输入的值（编辑态探测——含表单凭据即时验证；
      // 表单凭据空则测服务端已存凭据）
      const res = await fetch("/api/ingest/lake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          config: {
            address: address.trim(),
            authMode,
            account: account.trim(),
            password,
            token,
            branch: branch.trim() || "main",
            directory: directory.trim(),
          },
        }),
      })
      const data = await res.json()
      setTestResult({
        success: Boolean(data.success),
        message: String(data.message ?? data.error ?? "测试失败"),
      })
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : "网络错误" })
    } finally {
      setTesting(false)
    }
  }

  async function fetchDirs(prefix: string) {
    setBrowseLoading(true)
    setBrowseError(null)
    try {
      const res = await fetch("/api/ingest/lake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "dirs",
          prefix,
          config: { address: address.trim(), branch: branch.trim() || "main", directory: directory.trim() },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(String(data.error ?? "获取目录失败"))
      setBrowseDirs(Array.isArray(data.dirs) ? data.dirs : [])
      setBrowsePrefix(prefix)
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : "网络错误")
    } finally {
      setBrowseLoading(false)
    }
  }

  function handleBrowse() {
    setBrowseOpen(true)
    fetchDirs("")
  }

  function closeBrowse() {
    setBrowseOpen(false)
    setBrowseDirs([])
    setBrowsePrefix("")
    setBrowseError(null)
  }

  async function handlePickBranch() {
    setBranchOpen(true)
    setBranchLoading(true)
    setBranchError(null)
    try {
      const res = await fetch("/api/ingest/lake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "branches",
          config: { address: address.trim(), branch: branch.trim() || "main", directory: directory.trim() },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(String(data.error ?? "获取分支失败"))
      setBranchList(Array.isArray(data.branches) ? data.branches : [])
    } catch (e) {
      setBranchError(e instanceof Error ? e.message : "网络错误")
    } finally {
      setBranchLoading(false)
    }
  }

  function closeBranch() {
    setBranchOpen(false)
    setBranchList([])
    setBranchError(null)
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex w-full max-w-3xl flex-col gap-6 px-6 py-8 mx-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">设置</h1>
            <span className="text-xs text-muted-foreground">{BRAND_NAME} {VERSION_DISPLAY}</span>
          </div>
          <Link href="/" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent/30 transition-colors">
            <ArrowLeftIcon className="size-4" />
            返回
          </Link>
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold">LLM API 配置</h2>
          <p className="text-xs text-muted-foreground">
            用于 Audit 一键审计报告与 AI workflow 阶段划分。仅支持 OpenAI 兼容端点（如 /compatible-mode/v1）。配置存于浏览器本地，两 tab 共享。
          </p>
        </div>
        <AIProviderConfigPanel compact />

        <div className="h-px bg-border" />

        <div className="space-y-2">
          <h2 className="text-sm font-semibold">{BAY_NAME} 数据之湖</h2>
          <p className="text-xs text-muted-foreground">
            会话归档仓的连接配置：地址、认证（推送凭据）、分支与目录。留空使用默认值；配置后列表 / 导入 / 上传均按此远端执行。上传需要推送凭据（保存后 cpx 命令行同机可用）。
          </p>
        </div>
        <Card>
          <CardContent className="py-3 space-y-3">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16 shrink-0">地址</span>
                <Input
                  value={address}
                  onChange={(e) => {
                    setAddress(e.target.value)
                    dirty()
                    if (browseOpen) closeBrowse()
                    if (branchOpen) closeBranch()
                  }}
                  className="h-7 text-xs flex-1"
                  placeholder="https://example.com/your-lake.git"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16 shrink-0">认证方式</span>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant={authMode === "token" ? "default" : "outline"} className="h-6 px-2 text-xs" disabled={!hydrated} onClick={() => { setAuthMode("token"); dirty() }}>令牌</Button>
                  <Button size="sm" variant={authMode === "password" ? "default" : "outline"} className="h-6 px-2 text-xs" disabled={!hydrated} onClick={() => { setAuthMode("password"); dirty() }}>账户密码</Button>
                  <Button size="sm" variant={authMode === "none" ? "default" : "outline"} className="h-6 px-2 text-xs" disabled={!hydrated} onClick={() => { setAuthMode("none"); dirty() }}>匿名</Button>
                </div>
              </div>
              {authMode === "password" ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-16 shrink-0">账户</span>
                    <Input value={account} onChange={(e) => { setAccount(e.target.value); dirty() }} className="h-7 text-xs" placeholder="用户名" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-16 shrink-0">密码</span>
                    <Input type="password" value={password} onChange={(e) => { setPassword(e.target.value); dirty() }} className="h-7 text-xs" placeholder="••••••" />
                  </div>
                  <p className="text-xs text-muted-foreground pl-[72px]">注意：gitcode 已移除 git 密码认证（仅支持私人访问令牌），密码方式仅适用于仍支持密码认证的远端。</p>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-16 shrink-0">令牌</span>
                  <Input type="password" value={token} onChange={(e) => { setToken(e.target.value); dirty() }} className="h-7 text-xs" placeholder={authStatus ? `已配置 ${authStatus.tokenMasked}（输入新值可更换）` : "推送凭据（作为 git 凭据，账户可留空）"} />
                </div>
              )}
              {authStatus && (
                <p className="text-xs text-green-700 pl-[72px]">
                  ✓ 服务端已配置：{authStatus.username} / {authStatus.tokenMasked}{authStatus.verifiedAt ? `（连接验证于 ${new Date(authStatus.verifiedAt).toLocaleString()}）` : ""}
                </p>
              )}
              {authHint && <p className="text-xs text-muted-foreground pl-[72px]">{authHint}</p>}
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0" />
                <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={handleTest} disabled={testing || !hydrated}>
                  {testing ? "测试中…" : "测试连接"}
                </Button>
                {testResult && (
                  <span className={`text-xs break-all ${testResult.success ? "text-green-600" : "text-red-600"}`}>
                    {testResult.success ? "✓ " : "✗ "}{testResult.message}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16 shrink-0">分支</span>
                <Input value={branch} onChange={(e) => { setBranch(e.target.value); dirty(); if (browseOpen) closeBrowse() }} className="h-7 text-xs" placeholder="main（默认）" />
                <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={handlePickBranch} disabled={!hydrated}>选择</Button>
              </div>
              {branchOpen && (
                <div className="ml-[72px] rounded-md border p-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">选择分支</span>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={closeBranch}>关闭</Button>
                  </div>
                  {branchLoading && <p className="text-xs text-muted-foreground">加载中…</p>}
                  {branchError && <p className="text-xs text-red-600 break-all">{branchError}</p>}
                  {!branchLoading && !branchError && branchList.length === 0 && <p className="text-xs text-muted-foreground">远端没有可列出的分支</p>}
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => { setBranch("main"); dirty(); closeBranch() }}>main（默认）</Button>
                    {branchList.map(b => (
                      <Button
                        key={b}
                        size="sm"
                        variant={b === branch.trim() ? "default" : "secondary"}
                        className="h-6 px-2 text-xs"
                        onClick={() => { setBranch(b); dirty(); closeBranch(); if (browseOpen) closeBrowse() }}
                      >
                        {b}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">仅列出受支持的分支名（不含 <code>/</code>）。</p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16 shrink-0">目录</span>
                <Input value={directory} onChange={(e) => { setDirectory(e.target.value); dirty() }} className="h-7 text-xs" placeholder="留空 = 根目录" />
                <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={handleBrowse} disabled={!hydrated}>浏览</Button>
              </div>
              {browseOpen && (
                <div className="ml-[72px] rounded-md border p-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">选择目录 <span className="text-muted-foreground">@{branch.trim() || "main"} /{browsePrefix}</span></span>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={closeBrowse}>关闭</Button>
                  </div>
                  {browsePrefix && (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => fetchDirs(browsePrefix.split("/").slice(0, -1).join("/"))}>← 上一级</Button>
                  )}
                  {browseLoading && <p className="text-xs text-muted-foreground">加载中…（首次浏览需拉取仓库元数据）</p>}
                  {browseError && <p className="text-xs text-red-600 break-all">{browseError}</p>}
                  {!browseLoading && !browseError && browseDirs.length === 0 && <p className="text-xs text-muted-foreground">该目录下没有子目录</p>}
                  <div className="flex flex-wrap gap-1">
                    {browseDirs.map(d => (
                      <Button key={d} size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => fetchDirs(d)}>
                        {d.slice(browsePrefix ? browsePrefix.length + 1 : 0)}/
                      </Button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => { setDirectory(browsePrefix); dirty(); closeBrowse() }}
                    >
                      选定 /{browsePrefix || ""}
                    </Button>
                    {browsePrefix && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => { setDirectory(""); dirty(); closeBrowse() }}>
                        选定根目录
                      </Button>
                    )}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground pl-[72px]">上传缺省目录（无范式目录时的落盘位）：留空 = 仓库根（<code>&lt;sid&gt;/</code> 根级），可点「浏览」从仓库中选择。</p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" className="text-xs" onClick={handleSave} disabled={!hydrated || !address.trim()}>
                保存配置
              </Button>
              <Button size="sm" variant="ghost" className="text-xs" onClick={handleClear} disabled={!hydrated}>
                恢复默认值
              </Button>
              {savedFlag && <span className="text-xs text-green-600">✓ 已保存</span>}
            </div>
              <p className="text-xs text-muted-foreground">凭据保存在本机服务端（~/.cannbot-insight/lake-auth.json，权限 0600），cpx 与 insight 上传/下载共用同一份；地址/分支/目录偏好同时存浏览器本地与服务端（~/.cannbot-insight/lake-config.json）——viewer 与跨浏览器共享同一配置。数据仓默认需凭据推送（需仓主将你的账号加为协作者）。</p>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
