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

// 地址输入框默认值；等于该值时请求不带地址 → 后端 env / 内置默认接管
export const DEFAULT_CANNBAY_ADDRESS = "https://atomgit.com/duanbingzhe/cannbay3.git"

export interface CannbayRemoteInput {
  address?: string
  authMode?: CannbayAuthMode
  account?: string
  password?: string
  token?: string
  branch?: string
  directory?: string
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
  // 旧版预设形状：default → 默认地址；trace_corpus → 语料仓地址
  const preset = str(r.addressPreset)
  if (preset === "trace_corpus" && !address) address = "https://ai.gitcode.com/cann_corpus/trace_corpus"
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

export function saveCannbayConfig(config: CannbayConfig): void {
  if (typeof window === "undefined") return
  localStorage.setItem(CANNBAY_CONFIG_STORAGE_KEY, JSON.stringify(config))
}

export function clearCannbayConfig(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(CANNBAY_CONFIG_STORAGE_KEY)
}

export function cannbayRemoteInput(config: CannbayConfig | null): { config?: CannbayRemoteInput } {
  if (!config) return {}
  const has = (v?: string): boolean => !!v?.trim()
  // 按认证方式裁剪：不携带无关字段（切换方式后隐藏输入框的历史值不得泄进请求）
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
  if (isDefault) {
    if (!anyCred && isDefaultBranch && !has(config.directory)) return {}
    return { config: { ...creds, ...(isDefaultBranch ? {} : { branch }), directory: config.directory } }
  }
  return {
    config: {
      address: config.address.trim(),
      ...creds,
      ...(isDefaultBranch ? {} : { branch }),
      directory: config.directory,
    },
  }
}
