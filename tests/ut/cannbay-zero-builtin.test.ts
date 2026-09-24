// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 零内置凭据防回潮锁（跨包扫描，自 cpx 侧迁移而来）：cpx 与 insight 全量
// 源码不得出现密文常量或内嵌凭据 URL——凭据一律走服务端存储与解析链。
// 嵌入凭据正则为 host 无关形态（不绑定任何托管平台域名）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = [
  path.resolve(__dirname, '../../../cpx/src'),
  path.resolve(__dirname, '../../src'),
];

describe('跨包源码零内置凭据（防回潮锁）', () => {
  it('cpx/insight 源码不得出现密文常量或内嵌凭据 URL', () => {
    const encodedConst = /CANNBAY2_PUSH_URL_ENCODED|CANNBAY_PUSH_URL\s*=/;
    const base64Blob = /=\s*['"][A-Za-z0-9+/]{60,}={0,2}['"]/;
    // Host-agnostic: any user:pass@ URL on any host is forbidden.
    const embeddedCreds = /https?:\/\/[^/'"\s]+:[^'"\s@]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const [name, re] of [['encoded-const', encodedConst], ['base64-blob', base64Blob], ['embedded-creds', embeddedCreds]] as const) {
          if (re.test(src)) offenders.push(`${path.relative(path.resolve(__dirname, '../../..'), full)}: ${name}`);
        }
      }
    };
    for (const r of ROOTS) walk(r);
    expect(offenders, `检出内置凭据残留（凭据必须走服务端存储与解析链，绝不回源码）:\n${offenders.join('\n')}`).toEqual([]);
  });
});
