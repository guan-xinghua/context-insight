// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 信封双名单一真身 IT：x_lake 优先 / x_cannbay 兜底的读优先级、形态校验、
// 双名写；+ 源级哨兵——insight/src 内（envelope 模块自身除外）不得再出现
// 'x_lake'/'x_cannbay' 引号字面量（新内联点 = 退役旧键时漏改 + 哨兵无法借
// 单一真身判定的复燃，PR #49 审查意见正是死模块 + 内联散落的脱节）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvelope, envelopeFields, ENVELOPE_KEY, ENVELOPE_KEY_LEGACY, type Envelope } from '../../src/lib/shared/envelope.ts';

const ENV: Envelope = { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx' } };

describe('readEnvelope 双名读优先级', () => {
  it('新键优先、旧键兜底、双无 → undefined', () => {
    expect(readEnvelope({ [ENVELOPE_KEY]: ENV })).toBe(ENV);
    expect(readEnvelope({ [ENVELOPE_KEY_LEGACY]: ENV })).toBe(ENV);
    expect(readEnvelope({})).toBeUndefined();
    expect(readEnvelope(null)).toBeUndefined();
  });
  it('两键并存取新键（退役旧键的迁移语义）', () => {
    const old = { schema: 'x', version: 9, data: {} };
    expect(readEnvelope({ [ENVELOPE_KEY]: ENV, [ENVELOPE_KEY_LEGACY]: old })).toBe(ENV);
  });
  it('形态不合法（缺 schema/version/data）→ undefined 按无信封处理', () => {
    expect(readEnvelope({ [ENVELOPE_KEY]: { version: 1, data: {} } })).toBeUndefined();
    expect(readEnvelope({ [ENVELOPE_KEY]: { schema: 's', data: {} } })).toBeUndefined();
    expect(readEnvelope({ [ENVELOPE_KEY]: { schema: 's', version: 1 } })).toBeUndefined();
    expect(readEnvelope({ [ENVELOPE_KEY]: 'nope' })).toBeUndefined();
  });
});

describe('envelopeFields 双名写', () => {
  it('同一信封对象挂两个键（老版本读方不丢）', () => {
    expect(envelopeFields(ENV)).toEqual({ x_lake: ENV, x_cannbay: ENV });
    expect(envelopeFields(ENV)[ENVELOPE_KEY]).toBe(envelopeFields(ENV)[ENVELOPE_KEY_LEGACY]);
  });
});

describe('源级哨兵：信封键字面量单一真身（envelope 模块外零内联）', () => {
  it("insight/src 内无 'x_lake'/'x_cannbay' 引号字面量（防内联复燃，退役旧键单点改）", () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
        if (p.endsWith(path.join('shared', 'envelope.ts'))) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/['"]x_(?:lake|cannbay)['"]/.test(src)) offenders.push(path.relative(srcRoot, p));
      }
    };
    walk(srcRoot);
    expect(offenders, `信封键内联字面量复燃（应走 shared/envelope readEnvelope/envelopeFields）: ${offenders.join(', ')}`).toEqual([]);
  });
});
