// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// displayVersion 单一口径 IT：-proxy / -<agent>-proxy 后缀剥离（proxy 与否由
// isProxyVersion 徽标表达）。曾出现三处正则分叉（opencode 剥得掉、codex/
// cannbot 剥不掉），收敛到 session-format 共享助手。
import { describe, it, expect } from 'vitest';
import { displayVersion, isProxyVersion } from '../../src/lib/shared/session-format.ts';

describe('displayVersion：proxy 后缀剥离统一口径', () => {
  it('各 agent 后缀都剥得掉', () => {
    expect(displayVersion('1.18.19-opencode-proxy')).toBe('1.18.19');
    expect(displayVersion('2.1.273-claude-proxy')).toBe('2.1.273');
    expect(displayVersion('0.162.0-codex-proxy')).toBe('0.162.0');
    expect(displayVersion('cpx-0.1.9-cannbot-proxy')).toBe('cpx-0.1.9');
    expect(displayVersion('cpx-0.1.9-proxy')).toBe('cpx-0.1.9');
  });

  it('裸版本与空值原样/置空；proxy 判定不受影响', () => {
    expect(displayVersion('2.0.28')).toBe('2.0.28');
    expect(displayVersion(null)).toBeNull();
    expect(displayVersion('')).toBeNull();
    expect(isProxyVersion('0.162.0-codex-proxy')).toBe(true);
    expect(isProxyVersion('2.0.28')).toBe(false);
  });
});
