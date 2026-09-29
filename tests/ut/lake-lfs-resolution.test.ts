// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// insight LFS 三层决议链 IT（与 cpx lfs-resolution 对齐）：env 显式 on/off >
// 请求体 config.lfs > 默认开。LFS 默认开后 blob 断言类测试必须钉
// LAKE_LFS=0（本文件外已有 12 处），此文件锁决议语义本身。
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { resolveAdhocRemote } from '../../src/lib/lake/remote';

const SAVED = process.env.LAKE_LFS;
// 默认仓已退役：决议链测试经 input 显式带地址（夹具零真实地址）
const ADDR = 'https://example.com/resolution-lake.git';
afterEach(() => {
  if (SAVED === undefined) delete process.env.LAKE_LFS;
  else process.env.LAKE_LFS = SAVED;
});


describe('insight LFS 决议链（env > config > 默认开）', () => {
  it('env 未设 + 无 config → 默认开', () => {
    delete process.env.LAKE_LFS;
    expect(resolveAdhocRemote({ address: ADDR }).lfs).toBe(true);
  });

  it('env 显式 on 形态（1/true/on）→ 开（压过 config=false）', () => {
    for (const v of ['1', 'true', 'on', 'TRUE', 'On']) {
      process.env.LAKE_LFS = v;
      expect(resolveAdhocRemote({ address: ADDR, lfs: false }).lfs, `env=${v}`).toBe(true);
    }
  });

  it('env 显式 off 形态（0/false/off）→ 关（压过 config=true）', () => {
    for (const v of ['0', 'false', 'off', 'FALSE', 'Off']) {
      process.env.LAKE_LFS = v;
      expect(resolveAdhocRemote({ address: ADDR, lfs: true }).lfs, `env=${v}`).toBe(false);
    }
  });

  it('env 未设 → config.lfs 生效（true/false 双态）', () => {
    delete process.env.LAKE_LFS;
    expect(resolveAdhocRemote({ address: ADDR, lfs: false }).lfs).toBe(false);
    expect(resolveAdhocRemote({ address: ADDR, lfs: true }).lfs).toBe(true);
  });
});
