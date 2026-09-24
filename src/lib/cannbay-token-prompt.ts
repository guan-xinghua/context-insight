// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据仓推送凭据引导配置（纯逻辑层，供 CannbayTokenDialog 与两个触发方共用；
// 组件组合由 typecheck + 手动验，同 skill-audit-view 模式）：
//   resolveRemoteAddress   当前生效远端地址（localStorage 地址 > 默认仓）
//   findStoredAuthEntry    服务端已存凭据匹配（与后端 normalizeAuthKey 同语义：
//                          剥凭据/去尾斜杠/host 小写/.git 后缀互认）
//   isCredentialErrorCode  凭据类错误码判定（触发弹窗的依据）
//   credentialPromptCopy   触发语境文案（未配置/令牌无效/无写权限）

import { DEFAULT_CANNBAY_ADDRESS, loadCannbayConfig, type CannbayConfig } from '@/lib/cannbay-config'
import { BAY_NAME } from '@/lib/branding'

export type CannbayTokenReason = 'no-credentials' | 'auth-failed' | 'forbidden'

/** GET /api/settings/cannbay-auth 的远端条目（令牌只回脱敏尾段） */
export interface StoredRemoteInfo {
  url: string
  username: string
  tokenMasked: string
  verifiedAt?: string
}

/** 当前生效远端地址：设置页地址（自定义远端）> 默认仓地址；去尾斜杠。 */
export function resolveRemoteAddress(config: CannbayConfig | null = loadCannbayConfig()): string {
  const a = (config?.address ?? '').trim() || DEFAULT_CANNBAY_ADDRESS
  return a.replace(/\/+$/, '')
}

/** URL 键归一（与后端 cannbay2/auth.ts normalizeAuthKey 同语义，客户端轻量版）。 */
function normalizeAuthKeyClient(url: string): string {
  const credless = url.replace(/^(https?:\/\/)[^/@]+@/i, '$1').trim().replace(/\/+$/, '')
  try {
    const u = new URL(credless)
    u.username = ''
    u.password = ''
    u.host = u.host.toLowerCase()
    return u.toString().replace(/\/+$/, '')
  } catch {
    return credless
  }
}

/** 已存凭据匹配（.git 后缀双向互认——设置页手输地址与解析层规范地址可差一个后缀）。 */
export function findStoredAuthEntry(remotes: StoredRemoteInfo[], address: string): StoredRemoteInfo | null {
  const key = normalizeAuthKeyClient(address)
  const candidates = key.endsWith('.git') ? [key, key.slice(0, -4)] : [key, `${key}.git`]
  for (const k of candidates) {
    const hit = remotes.find(r => normalizeAuthKeyClient(r.url) === k)
    if (hit) return hit
  }
  return null
}

/** 凭据类错误码（路由结构化 code）：命中即弹引导配置。quota/unknown 不弹——
 *  那不是换令牌能解决的问题。 */
export function isCredentialErrorCode(code: unknown): code is CannbayTokenReason {
  return code === 'no-credentials' || code === 'auth-failed' || code === 'forbidden'
}

/** 触发语境文案：title 进弹窗标题，description 进副标题。 */
export function credentialPromptCopy(reason: CannbayTokenReason): { title: string; description: string } {
  switch (reason) {
    case 'auth-failed':
      return {
        title: '令牌无效或已过期',
        description: `数据仓拒绝了当前保存的令牌。输入新令牌替换后重试上传即可。`,
      }
    case 'forbidden':
      return {
        title: '令牌无推送权限',
        description: '当前令牌有效但没有该数据仓的写权限——请让仓主将你的账号添加为协作者，或换用有权限的令牌。',
      }
    case 'no-credentials':
    default:
      return {
        title: '配置数据仓推送凭据',
        description: `上传到 ${BAY_NAME} 需要推送凭据。凭据保存在本机服务端，配置一次即可（cpx 命令行同机共享）。`,
      }
  }
}
