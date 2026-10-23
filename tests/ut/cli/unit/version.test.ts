// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// CLI 版本旗标（npm 全局安装后的用户直觉输入）：
//   -v / --version 输出 `Context-Insight v<x.y.z>`（与 cpx 的 `cpx v0.1.x (路径)`
//   风格对齐）；版本串单一真身在 version.ts，这里锁绑定与组装不漂移。
//   bin/context-insight.mjs 的透传名单须放行 -v——否则 `ctxi -v` 掉进
//   "无参数 → 启动 Web UI" 分支（名单断言防回归）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createProgram } from '@/cli/index';
import { VERSION, VERSION_DISPLAY } from '@/lib/version';
import { BRAND_NAME } from '@/lib/branding';

describe('CLI 版本旗标', () => {
  it('-v 与 --version 绑定在同一 version 选项上', () => {
    const program = createProgram();
    const versionOption = program.options.find(o => o.long === '--version');
    expect(versionOption).toBeDefined();
    expect(versionOption!.short).toBe('-v');
    expect(versionOption!.flags).toBe('-v, --version');
  });

  it('版本输出带品牌前缀且与 version.ts 单源一致', () => {
    const program = createProgram();
    expect(program.version()).toBe(`${BRAND_NAME} ${VERSION_DISPLAY}`);
    expect(program.version()).toContain(VERSION);
  });

  it('bin 透传名单放行 -v（否则 ctxi -v 误启 Web UI）', () => {
    const bin = fs.readFileSync(
      path.resolve(__dirname, '../../../../bin/context-insight.mjs'), 'utf8',
    );
    const m = bin.match(/const CLI_COMMANDS = new Set\(\[([\s\S]*?)\]\)/);
    expect(m).toBeDefined();
    for (const flag of ["'-v'", "'--version'", "'-V'"]) {
      expect(m![1]).toContain(flag);
    }
  });
});
