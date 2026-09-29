// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据仓令牌引导配置·纯逻辑层 UT：地址解析（localStorage 地址 > 默认仓）、
// 已存凭据匹配（与后端 normalizeAuthKey 同语义：剥凭据/去尾斜杠/host 小写/
// .git 互认）、凭据类错误码判定（quota/unknown 不弹——换令牌解决不了）、
// 触发语境文案三态。组件组合（弹窗动效/表单交互）由 typecheck + 手动验
// （同 skill-audit-view 模式）；服务端 PUT/GET 已有 lake-auth-it 锁定。
import { describe, it, expect } from 'vitest'
import {
  credentialPromptCopy,
  findStoredAuthEntry,
  isCredentialErrorCode,
  resolveRemoteAddress,
  type StoredRemoteInfo,
} from '@/lib/lake-token-prompt'

const remotes: StoredRemoteInfo[] = [
  { url: 'https://example.com/lake.git', username: 'zhangsan', tokenMasked: 'at-…ABCD', verifiedAt: '2026-09-22T00:00:00.000Z' },
  { url: 'https://example.com/corpus-archive', username: 'oauth2', tokenMasked: 'gli…EFGH' },
]

describe('resolveRemoteAddress：当前生效远端', () => {
  it('null 配置 → 空串（默认仓退役：地址只从用户配置来，env 不再回落）', () => {
    expect(resolveRemoteAddress(null)).toBe('')
  })
  it('自定义地址优先；空白/尾斜杠归一', () => {
    expect(resolveRemoteAddress({ address: ' https://example.com/a/b.git/ ', authMode: 'none', account: '', password: '', token: '', branch: '', directory: '' } as never))
      .toBe('https://example.com/a/b.git')
  })
})

describe('findStoredAuthEntry：已存凭据匹配（后端键归一同语义）', () => {
  it('精确命中 → 返回条目', () => {
    const hit = findStoredAuthEntry(remotes, 'https://example.com/lake.git')
    expect(hit?.username).toBe('zhangsan')
    expect(hit?.tokenMasked).toBe('at-…ABCD')
  })
  it('.git 后缀互认（手输地址与存储键可差一个后缀）', () => {
    expect(findStoredAuthEntry(remotes, 'https://example.com/lake')?.username).toBe('zhangsan')
    const noGitStore: StoredRemoteInfo[] = [{ url: 'https://example.com/lake', username: 'u', tokenMasked: '***' }]
    expect(findStoredAuthEntry(noGitStore, 'https://example.com/lake.git')?.username).toBe('u')
  })
  it('尾斜杠 / host 大小写 / 内嵌凭据不影响匹配；未配置 → null', () => {
    expect(findStoredAuthEntry(remotes, 'https://example.com/lake.git/')?.username).toBe('zhangsan')
    expect(findStoredAuthEntry(remotes, 'https://user:pass@example.com/lake.git')?.username).toBe('zhangsan')
    expect(findStoredAuthEntry(remotes, 'https://example.com/other/repo.git')).toBeNull()
    expect(findStoredAuthEntry([], 'https://example.com/lake.git')).toBeNull()
  })
})

describe('isCredentialErrorCode：凭据类错误码判定', () => {
  it('三种凭据码命中；quota/unknown/空不命中（换令牌解决不了的不弹）', () => {
    for (const c of ['no-credentials', 'auth-failed', 'forbidden'] as const) {
      expect(isCredentialErrorCode(c)).toBe(true)
    }
    for (const c of ['quota', 'unknown', undefined, null, '']) {
      expect(isCredentialErrorCode(c)).toBe(false)
    }
  })
})

describe('credentialPromptCopy：触发语境文案', () => {
  it('三态各有标题与指引；未配置态说明一次配置与服务端存储', () => {
    const nc = credentialPromptCopy('no-credentials')
    expect(nc.title).toContain('配置')
    expect(nc.description).toContain('一次')
    expect(credentialPromptCopy('auth-failed').title).toContain('无效')
    expect(credentialPromptCopy('auth-failed').description).toContain('替换')
    expect(credentialPromptCopy('forbidden').title).toContain('权限')
    expect(credentialPromptCopy('forbidden').description).toContain('协作者')
  })
})
