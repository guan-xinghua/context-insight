// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据仓推送凭据引导配置（纯逻辑层，供 LakeTokenDialog 与两个触发方共用；
// 组件组合由 typecheck + 手动验，同 skill-audit-view 模式）：
//   resolveRemoteAddress   当前生效远端地址（localStorage 地址 > 默认仓）
//   findStoredAuthEntry    服务端已存凭据匹配（与后端 normalizeAuthKey 同语义：
//                          剥凭据/去尾斜杠/host 小写/.git 后缀互认）
//   isCredentialErrorCode  凭据类错误码判定（触发弹窗的依据）
//   credentialPromptCopy   触发语境文案（未配置/令牌无效/无写权限）

import { loadLakeConfig, type LakeConfig } from '@/lib/lake-config'
import { BAY_NAME } from '@/lib/branding'

export type LakeTokenReason = 'unconfigured' | 'no-credentials' | 'auth-failed' | 'forbidden'

/** GET /api/settings/lake-auth 的远端条目（令牌只回脱敏尾段） */
export interface StoredRemoteInfo {
  url: string
  username: string
  tokenMasked: string
  verifiedAt?: string
}

/** 当前生效远端地址：设置页地址（自定义远端）> 默认仓地址；去尾斜杠。 */
export function resolveRemoteAddress(config: LakeConfig | null = loadLakeConfig()): string {
  // 默认仓退役：地址只从用户配置来（localStorage lake-config），env 不再回落
  const a = (config?.address ?? '').trim()
  return a.replace(/\/+$/, '')
}

/** URL 键归一（与后端 lake/auth.ts normalizeAuthKey 同语义，客户端轻量版）。 */
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

/** 未配置判定（Import 点数据仓源的预检——客户端零往返）：设置页地址与
 *  env 均空 = 未配置（与服务端 resolveLakeRemote fail-fast 同输入同结论）。
 *  部署机 env 已配时用户无感——弹窗只在真的需要输入时出现。 */
export function isUnconfiguredRemote(config: LakeConfig | null = loadLakeConfig()): boolean {
  return resolveRemoteAddress(config) === ''
}

/** 服务端配置状态（lake-config.json——单源架构的唯一配置源，设置页保存
 *  落盘，全机生效）。未配置预检（Import/上传弹窗）：未配 → 弹引导（保存后
 *  自动重试）；已配 → 请求不带 config，服务端单源解析。 */
export async function serverLakeConfigStatus(): Promise<{ configured: boolean; address: string; branch: string }> {
  try {
    const res = await fetch('/api/settings/lake-config')
    if (!res.ok) return { configured: false, address: '', branch: 'main' }
    const data = await res.json() as { configured?: boolean; address?: string; branch?: string }
    return {
      configured: data.configured === true,
      address: (data.address ?? '').trim(),
      branch: (data.branch ?? '').trim() || 'main',
    }
  } catch {
    return { configured: false, address: '', branch: 'main' }
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
export function isCredentialErrorCode(code: unknown): code is LakeTokenReason {
  return code === 'no-credentials' || code === 'auth-failed' || code === 'forbidden'
}

/** 'unconfigured' 不是服务端错误码（客户端预检判定），错误码映射不认它 */

/** 触发语境文案：title 进弹窗标题，description 进副标题。 */
export function credentialPromptCopy(reason: LakeTokenReason): { title: string; description: string } {
  switch (reason) {
    case 'unconfigured':
      return {
        title: '连接数据仓',
        description: `尚未配置数据仓地址。填写远端地址与推送凭据即可连接（保存在本机，cpx 命令行同机共享；高级选项可在「设置 → 数据之湖」调整）。`,
      }
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
