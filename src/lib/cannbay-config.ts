// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { BRAND_SLUG } from "@/lib/branding"

export const CANNBAY_CONFIG_STORAGE_KEY = `${BRAND_SLUG}-cannbay-config`

export type CannbayAuthMode = "none" | "password" | "token"

// 地址输入框默认值；等于该值时请求不带地址 → 后端 env / 内置默认接管。
// 默认地址为占位示例；实际部署通过 env / 设置页配置真实数据仓
export const DEFAULT_CANNBAY_ADDRESS = "https://example.com/cannbay-lake.git"

export interface CannbayRemoteInput {
  address?: string
  authMode?: CannbayAuthMode
  account?: string
  password?: string
  token?: string
  branch?: string
  directory?: string
  /** LFS 模式（数据仓须启用 LFS）：.jsonl.7z/.jsonl.gz 走 LFS 指针出仓，容量脱离 git 仓配额 */
  lfs?: boolean
}

export interface CannbayConfig extends CannbayRemoteInput {
  address: string
  authMode: CannbayAuthMode
  account: string
  password: string
  token: string
  branch: string
  directory: string
}

export function migrateCannbayConfig(raw: unknown): CannbayConfig | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  let address = str(r.address).trim()
  // 旧版预设形状（default/trace_corpus）与空地址一律回落默认地址
  if (!address) address = DEFAULT_CANNBAY_ADDRESS
  const validMode = (v: string): CannbayAuthMode | null =>
    v === "none" || v === "password" || v === "token" ? (v as CannbayAuthMode) : null
  const authMode: CannbayAuthMode =
    validMode(str(r.authMode))
    ?? (r.authMode === undefined ? (str(r.account) || str(r.password) ? "password" : "none") : "none")
  return {
    address,
    authMode,
    account: str(r.account),
    password: str(r.password),
    token: str(r.token),
    branch: str(r.branch).trim() || 'main',
    directory: str(r.directory).trim(),
  }
}

export function loadCannbayConfig(): CannbayConfig | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(CANNBAY_CONFIG_STORAGE_KEY)
    if (!raw) return null
    return migrateCannbayConfig(JSON.parse(raw))
  } catch {
    return null
  }
}

// 是否默认仓（无自定义地址）：只有默认仓启用范式目录多根模式（上传必选
// category、导入按范式浏览）；自定义数据湖远端维持 directory 单根机制，
// 后端 resolveCannbay2Remote 同款判定（hasAddress → paradigmRoots=false）
export function isDefaultCannbayRemote(config: CannbayConfig | null): boolean {
  return !config || !config.address.trim() || config.address.trim() === DEFAULT_CANNBAY_ADDRESS
}

// localStorage 只存 UI 偏好（地址/认证方式/分支/目录）——凭据走服务端存储
// （cannbay-auth.json，设置页保存时落盘，cpx 与 insight 同机共享）。旧版
// 落在本地的凭据字段不再持久化（migrateCannbayConfig 仍读旧值供表单预填，
// 用户重新保存即完成迁移）
export function saveCannbayConfig(config: CannbayConfig): void {
  if (typeof window === "undefined") return
  localStorage.setItem(CANNBAY_CONFIG_STORAGE_KEY, JSON.stringify({
    address: config.address,
    authMode: config.authMode,
    branch: config.branch,
    directory: config.directory,
  }))
}

export function clearCannbayConfig(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(CANNBAY_CONFIG_STORAGE_KEY)
}

// 保存时的服务端凭据操作决策（设置页 handleSave 消费）：填了令牌/密码 →
// 保存；显式匿名 → 清除该地址已存凭据；认证模式停在 token/password 但输入
// 留空 → 保留现有（令牌框 placeholder「已配置 xxx（输入新值可更换）」的
// 空值语义是"不动"而非"删除"——留空保存误删已存凭据，下次上传会撞
// no-credentials 引导重配）
export type CredentialAction = "save-token" | "save-password" | "clear" | "keep"

export function planCredentialAction(config: CannbayConfig): CredentialAction {
  if (config.authMode === "token" && config.token.trim()) return "save-token"
  if (config.authMode === "password" && config.account.trim() && config.password.trim()) return "save-password"
  if (config.authMode === "none") return "clear"
  return "keep"
}

// 请求体构造：默认不带凭据（服务端从 cannbay-auth.json 按地址解析——上传/
// 列表/导入统一凭据源）；仅 test/branches 即时验证场景带表单凭据
// （includeCreds: true —— 测试的是用户正在输入的值，不是已存的值）
export function cannbayRemoteInput(
  config: CannbayConfig | null,
  opts?: { includeCreds?: boolean },
): { config?: CannbayRemoteInput } {
  if (!config) return {}
  const has = (v?: string): boolean => !!v?.trim()
  const creds: CannbayRemoteInput =
    config.authMode === 'token'
      ? { authMode: 'token', token: config.token }
      : config.authMode === 'password'
        ? { authMode: 'password', account: config.account, password: config.password }
        : { authMode: 'none' }
  const anyCred = [creds.account, creds.password, creds.token].some(v => has(v))
  // 分支默认 main：等于 main（或空）→ 不带分支，后端默认语义保留
  const branch = config.branch.trim();
  const isDefaultBranch = !branch || branch === 'main';
  // 地址为默认值（或空）→ 不带地址：后端 env / 内置默认接管（含 env 缓存目录语义）
  const isDefault = !has(config.address) || config.address.trim() === DEFAULT_CANNBAY_ADDRESS
  const withCreds = opts?.includeCreds && anyCred ? creds : { authMode: 'none' as const }
  if (isDefault) {
    // 无可传信息（默认地址 + 默认分支 + 无目录 + 未带表单凭据）→ 完全省略
    // config，后端 env/内置默认接管
    if (isDefaultBranch && !has(config.directory) && !(opts?.includeCreds && anyCred)) return {}
    return { config: { ...withCreds, ...(isDefaultBranch ? {} : { branch }), directory: config.directory } }
  }
  return {
    config: {
      address: config.address.trim(),
      ...withCreds,
      ...(isDefaultBranch ? {} : { branch }),
      directory: config.directory,
    },
  }
}
