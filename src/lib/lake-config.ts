// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { BRAND_SLUG } from "@/lib/branding"

export const LAKE_CONFIG_STORAGE_KEY = `${BRAND_SLUG}-lake-config`

// 上一版 saveCannbayConfig（cannbay-config.ts，平台化改名前）写入的存量键：
// 新键 miss 时回落读（升级用户表单预填/凭据匹配键的现实来源——当前代码
// 不再写 localStorage，升级机器上只有这个键），清除时一并移除防残留复活
const LEGACY_LAKE_CONFIG_STORAGE_KEY = `${BRAND_SLUG}-cannbay-config`

export type LakeAuthMode = "none" | "password" | "token"

// 无占位默认地址：空串 = 未自定义 → 请求不带地址，后端 env 接管；后端也未
// 配置则 fail-fast 指引（lib/lake/remote.ts resolveLakeRemote）——绝不静默
// 指向示例地址

export interface LakeRemoteInput {
  address?: string
  authMode?: LakeAuthMode
  account?: string
  password?: string
  token?: string
  branch?: string
  directory?: string
  /** LFS 模式（数据仓须启用 LFS）：.jsonl.7z/.jsonl.gz 走 LFS 指针出仓，容量脱离 git 仓配额 */
  lfs?: boolean
}

export interface LakeConfig extends LakeRemoteInput {
  address: string
  authMode: LakeAuthMode
  account: string
  password: string
  token: string
  branch: string
  directory: string
}

export function migrateLakeConfig(raw: unknown): LakeConfig | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  // 空地址 = 未自定义（后端 env 接管）；旧版预设形状已随平台化退役
  const address = str(r.address).trim()
  const validMode = (v: string): LakeAuthMode | null =>
    v === "none" || v === "password" || v === "token" ? (v as LakeAuthMode) : null
  const authMode: LakeAuthMode =
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

export function loadLakeConfig(): LakeConfig | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(LAKE_CONFIG_STORAGE_KEY) ?? localStorage.getItem(LEGACY_LAKE_CONFIG_STORAGE_KEY)
    if (!raw) return null
    return migrateLakeConfig(JSON.parse(raw))
  } catch {
    return null
  }
}

// 默认仓概念已退役（二合一彻底统一）：地址必须由用户显式配置，
// 范式目录多根模式恒开（全仓顶层目录即注册表）。directory 仅作上传缺省目录

// 单源架构：远端偏好（地址/分支/目录）的唯一存储是服务端 lake-config.json
// （设置页保存/清除，全机生效）。localStorage 仅作 legacy 预填源（loadLakeConfig
// 供设置页把存量值带进表单——新键 miss 回落旧键 cannbay-config，保存一次即
// 迁移完成；clearLakeConfig 在保存/清除时清掉新旧两键防复活）
export function clearLakeConfig(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(LAKE_CONFIG_STORAGE_KEY)
  localStorage.removeItem(LEGACY_LAKE_CONFIG_STORAGE_KEY)
}

// 保存时的服务端凭据操作决策（设置页 handleSave 消费）：填了令牌/密码 →
// 保存；显式匿名 → 清除该地址已存凭据；认证模式停在 token/password 但输入
// 留空 → 保留现有（令牌框 placeholder「已配置 xxx（输入新值可更换）」的
// 空值语义是"不动"而非"删除"——留空保存误删已存凭据，下次上传会撞
// no-credentials 引导重配）
export type CredentialAction = "save-token" | "save-password" | "clear" | "keep"

export function planCredentialAction(config: LakeConfig): CredentialAction {
  if (config.authMode === "token" && config.token.trim()) return "save-token"
  if (config.authMode === "password" && config.account.trim() && config.password.trim()) return "save-password"
  if (config.authMode === "none") return "clear"
  return "keep"
}
