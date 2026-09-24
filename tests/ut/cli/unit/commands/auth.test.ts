// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// `cbi auth` 命令 IT：交互流程（注入 prompts/probe）、非交互三件套、
// --status 脱敏清单、--clear、非 TTY 拒绝与令牌空输入取消。隔离：
// CANNBOT_PROXY_DIR 重定向到临时目录（凭据文件跟随），env 快照恢复。
// 夹具一律 example.com（安全规范）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuthAction } from '@/cli/commands/auth';
import { getStoredCredentials, listStoredRemotes } from '@/lib/cannbay2/auth';
import { DEFAULT_CANNBAY_ADDRESS } from '@/lib/cannbay-config';

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbi-auth-it-'));
  for (const k of ['CANNBOT_PROXY_DIR', 'CANNBAY2_PUSH_URL', 'CANNBAY2_USERNAME', 'CANNBAY2_TOKEN']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CANNBOT_PROXY_DIR = path.join(home, 'proxy');
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('cbi auth 交互流程', () => {
  it('默认远端回车 → 用户名 → 凭据静默输入 → 保存 + 探测通过落 verifiedAt', async () => {
    const answers = ['', 'wangwu', 'cli-credential-998877'];
    const mutedQueries: string[] = [];
    const code = await runAuthAction({}, {
      isTTY: true,
      question: async () => answers.shift() ?? '',
      questionMuted: async (q) => { mutedQueries.push(q); return answers.shift() ?? ''; },
      probe: async () => ({ ok: true, message: '地址可达' }),
    });
    expect(code).toBe(0);
    expect(mutedQueries.join()).toContain('不回显');
    // 回车落默认仓（断言经 DEFAULT_CANNBAY_ADDRESS 常量引用，夹具零真实地址）
    expect(getStoredCredentials(DEFAULT_CANNBAY_ADDRESS))
      .toEqual({ username: 'wangwu', password: 'cli-credential-998877' });
    const hit = listStoredRemotes().find(r => r.url === DEFAULT_CANNBAY_ADDRESS.replace(/\/+$/, ''));
    expect(hit?.verifiedAt).toBeTruthy();
  });

  it('令牌空输入 → 取消（未写任何配置），退出 1', async () => {
    const code = await runAuthAction({}, {
      isTTY: true,
      question: async () => 'someone',
      questionMuted: async () => '',
    });
    expect(code).toBe(1);
  });

  it('非 TTY 无 flag → 指引退出 2', async () => {
    const errs: string[] = [];
    expect(await runAuthAction({}, { isTTY: false, log: m => errs.push(m) })).toBe(2);
    expect(errs.join('\n')).toContain('--remote');
  });
});

describe('cbi auth 非交互与子操作', () => {
  it('--remote/--username/--token 三件套：探测失败仍保存但不落 verifiedAt', async () => {
    const code = await runAuthAction(
      { remote: 'https://example.com/org/repo.git', username: 'u1', token: 't1-987654321' },
      { probe: async () => ({ ok: false, message: 'git ls-remote 失败' }) },
    );
    expect(code).toBe(0);
    expect(getStoredCredentials('https://example.com/org/repo.git')).toEqual({ username: 'u1', password: 't1-987654321' });
    expect(listStoredRemotes().find(r => r.url.includes('org/repo'))?.verifiedAt).toBeUndefined();
  });

  it('三件套缺项 → 退出 2', async () => {
    expect(await runAuthAction({ remote: 'https://example.com/a/b.git', username: 'u' }, {})).toBe(2);
  });

  it('--status 脱敏清单（不回明文）；--clear 清除', async () => {
    const outs: string[] = [];
    expect(await runAuthAction({ status: true }, { out: m => outs.push(m) })).toBe(0);
    const text = outs.join('\n');
    expect(text).toContain('凭据文件');
    expect(text).not.toContain('cli-credential-998877');
    expect(text).not.toContain('t1-987654321');
    expect(await runAuthAction({ clear: true }, {})).toBe(0);
    expect(listStoredRemotes()).toEqual([]);
  });
});
