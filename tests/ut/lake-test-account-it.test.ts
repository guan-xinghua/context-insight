// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 测试连接属主文案回归锁（PR #38 审查意见）：token 模式不带账户是常态——
// 前端 lakeRemoteInput 只上送 {authMode,token}（account 不随请求），
// CannbayTokenDialog 保存同样 username||'oauth2'，requestAuth.username 亦
// 兜底 'oauth2'。旧接线把 pushAuth.username 传给 credentialTestMessage 的
// account，gitcode 上令牌有效时误报「与所填账户 oauth2 不一致」——用户
// 从没填过 oauth2，那是系统占位符。锁三态：
//   ① token 不带账户 → 「凭据已验证，令牌属于用户 X」，绝不出现「不一致」/oauth2
//   ② 实填账户 ≠ 令牌属主 → 不一致提示照常（对真实输入保持诚实）
//   ③ 纯函数层 account='oauth2' → 视为未填（防未来接线回退）
// ls-remote 传输通道由 lake-lsremote-auth-it 以真实 401 网关另锁，
// 这里 mock runGitWithAuth 断开网络，只锁文案接线；fetch stub 供
// api/v5/user 属主反查。
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../src/lib/lake/mirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/lake/mirror')>();
  return { ...actual, runGitWithAuth: vi.fn(() => Buffer.from('')) };
});

import { testLakeRemote, credentialTestMessage } from '../../src/lib/lake/remote';

const GITCODE = 'https://gitcode.com/cann/cannbot-sentry.git';

describe('test 连接属主文案：oauth2 兜底占位不参与「所填账户」不一致判定', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('① token 不带账户（常态）→ 令牌属主如实相告，绝不误报「与所填账户 oauth2 不一致」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'wang-zhiyue2' }), { status: 200 })));
    const r = await testLakeRemote({ address: GITCODE, authMode: 'token', token: 'tk' });
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/凭据已验证，令牌属于用户 wang-zhiyue2/);
    expect(r.message).not.toMatch(/不一致/);
    expect(r.message).not.toContain('oauth2');
  });

  it('② 实填账户与属主不一致 → 提示照常（对真实输入保持诚实）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'wang-zhiyue2' }), { status: 200 })));
    const r = await testLakeRemote({ address: GITCODE, authMode: 'token', account: 'someone-else', token: 'tk' });
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/不一致/);
    expect(r.message).toContain('someone-else');
    expect(r.message).toContain('wang-zhiyue2');
  });

  it('③ 纯函数层：account=oauth2（大小写/空白变体）→ 视为未填（接线回退防线）', () => {
    for (const placeholder of ['oauth2', ' OAuth2 ', 'OAUTH2']) {
      const m = credentialTestMessage({ owner: 'wang-zhiyue2', account: placeholder, authMode: 'token', isGitcode: true });
      expect(m).toMatch(/凭据已验证，令牌属于用户 wang-zhiyue2/);
      expect(m).not.toMatch(/不一致/);
    }
  });
});
