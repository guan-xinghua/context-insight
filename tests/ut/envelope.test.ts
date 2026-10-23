// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 信封键单一真身 IT：x_lake 单轨读写（旧键 x_cannbay 已退役——携带旧键的
// 存量数据按无信封处理）、形态校验；+ 源级哨兵——insight/src 内（envelope
// 模块自身除外）不得再出现 'x_lake'/'x_cannbay' 引号字面量（新内联点 =
// 漏改 + 哨兵无法借单一真身判定的复燃；旧键字面量复现 = 退役轨回潮）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvelope, envelopeFields, ENVELOPE_KEY, type Envelope } from '../../src/lib/shared/envelope.ts';

const ENV: Envelope = { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx' } };

describe('readEnvelope 单轨读', () => {
  it('x_lake 命中、空/无键 → undefined', () => {
    expect(readEnvelope({ [ENVELOPE_KEY]: ENV })).toBe(ENV);
    expect(readEnvelope({})).toBeUndefined();
    expect(readEnvelope(null)).toBeUndefined();
  });
  it('旧键 x_cannbay 已退役：携带旧键的数据按无信封处理', () => {
    expect(readEnvelope({ x_cannbay: ENV })).toBeUndefined();
  });
  it('形态不合法（缺 schema/version/data）→ undefined 按无信封处理', () => {
    expect(readEnvelope({ [ENVELOPE_KEY]: { version: 1, data: {} } })).toBeUndefined();
    expect(readEnvelope({ [ENVELOPE_KEY]: { schema: 's', data: {} } })).toBeUndefined();
    expect(readEnvelope({ [ENVELOPE_KEY]: { schema: 's', version: 1 } })).toBeUndefined();
    expect(readEnvelope({ [ENVELOPE_KEY]: 'nope' })).toBeUndefined();
  });
});

describe('envelopeFields 单轨写', () => {
  it('信封对象只挂 x_lake（旧键不写）', () => {
    expect(envelopeFields(ENV)).toEqual({ x_lake: ENV });
    expect('x_cannbay' in envelopeFields(ENV)).toBe(false);
  });
});

describe('源级哨兵：信封键字面量单一真身（envelope 模块外零内联）', () => {
  it("insight/src 内无 'x_lake'/'x_cannbay' 引号字面量（防内联复燃 / 旧轨回潮）", () => {
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
