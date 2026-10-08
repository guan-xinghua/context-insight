// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 日志采用率哨兵（防回潮锁）：每个 API 路由必须二选一——
//   ① import withRouteLog（统一包装：错误/软5xx 自动落盘）
//   ② 自带 catch 内调用 logError/logWarn/logInfo/logDebug（结构性特殊路由）
// 新路由若退回「catch 折进 JSON 响应体、服务端零痕迹」的原始形态，本哨兵红。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PKG = path.resolve(__dirname, '../..');
const APP = path.join(PKG, 'src', 'app');
const routes = execSync(`find ${APP} -name route.ts`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

describe('日志采用率哨兵：所有 route.ts 必须有错误日志通道', () => {
  it('每个路由要么包 withRouteLog，要么 catch 内有显式 logger 调用', () => {
    expect(routes.length).toBeGreaterThan(40);
    const violations: string[] = [];
    for (const file of routes) {
      const src = fs.readFileSync(file, 'utf8');
      const wrapped = /withRouteLog/.test(src);
      const manualLog = /log(Error|Warn|Info|Debug|Line)\s*\(/.test(src);
      if (!wrapped && !manualLog) violations.push(path.relative(PKG, file));
    }
    expect(violations, `无错误日志通道的路由：\n${violations.join('\n')}`).toEqual([]);
  });
});
