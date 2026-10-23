// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 设置页·数据之湖远端偏好 API IT（/api/settings/lake-config）：
//   ① GET 未配置 → configured:false 空串（不抛）
//   ② PUT 持久化 + 归一化落盘：branch 去空白、directory 去首尾斜杠——存储层
//      即干净形态（消费方 resolveLakeRemote 不必各自归一；回归锁：修复前
//      原始输入原样落盘）
//   ③ PUT 校验：缺地址/地址元字符/非法分支/非法目录 → 400（错误指向字段）
//   ④ DELETE 清除后 GET 回到未配置态
// 隔离：CONTEXT_PROXY_DIR 重定向到临时目录（server-config 路径随之前缀）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-config-route-it-'));
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ['CONTEXT_PROXY_DIR']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CONTEXT_PROXY_DIR = path.join(TMP, 'proxy');
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const route = await import('../../src/app/api/settings/lake-config/route');
const { readServerLakeConfig, writeServerLakeConfig, serverConfigPath } = await import('../../src/lib/lake/server-config');

function put(body: unknown): Promise<Response> {
  return route.PUT(new NextRequest('http://localhost/api/settings/lake-config', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

describe('设置页·数据之湖远端偏好 API', () => {
  it('① GET 未配置 → configured:false、字段空串', async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ configured: false, address: '', branch: '', directory: '' });
  });

  it('② PUT 持久化 + 归一化落盘（branch 去空白、directory 去首尾斜杠）→ GET 读回归一形态', async () => {
    const res = await put({
      address: ' https://example.com/lake.git ',
      branch: ' main ',
      directory: '/trace/2026-08/',
    });
    expect(res.status).toBe(200);
    const cfg = readServerLakeConfig();
    expect(cfg).toMatchObject({
      address: 'https://example.com/lake.git',
      branch: 'main',
      directory: 'trace/2026-08',
    });
    const res2 = await route.GET();
    expect(await res2.json()).toMatchObject({
      configured: true,
      address: 'https://example.com/lake.git',
      branch: 'main',
      directory: 'trace/2026-08',
    });
  });

  it('③ PUT 校验拒绝：缺地址 / 地址元字符 / 非法分支 / 非法目录 → 400', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ address: 'https://example.com/x.git;rm -rf /' })).status).toBe(400);
    expect((await put({ address: 'https://example.com/x.git', branch: 'main;cmd' })).status).toBe(400);
    expect((await put({ address: 'https://example.com/x.git', directory: 'trace\\9月' })).status).toBe(400);
    // 拒绝后存储保持上一次的合法值（不被半截请求污染）
    expect(readServerLakeConfig()?.address).toBe('https://example.com/lake.git');
  });

  it('④ DELETE 清除 → GET 回到未配置态', async () => {
    const res = await route.DELETE();
    expect(res.status).toBe(200);
    expect(readServerLakeConfig()).toBeNull();
    expect(fs.existsSync(serverConfigPath())).toBe(false);
    const res2 = await route.GET();
    expect((await res2.json()).configured).toBe(false);
  });
});

describe('writeServerLakeConfig 脏输入显式抛错（导出函数防线）', () => {
  // 路由层已拦空地址，但这是导出函数——未来任何调用方传脏 address 必须拿到
  // 可感知的失败，而非旧兜底「写一个只剩空 address 的文件、静默丢
  // branch/directory/lfs」。负向验证：旧实现（?? { address: cfg.address.trim() }）
  // 在此两形态下均不抛且落脏文件——必红
  it('address 空/非字符串 → 抛错且不落盘', () => {
    for (const bad of [
      { address: '', branch: 'main', lfs: true },
      { address: '   ', branch: 'main' },
      { address: undefined, branch: 'main' },
      { address: 123, branch: 'main' },
    ] as never[]) {
      expect(() => writeServerLakeConfig(bad)).toThrow(/invalid config/);
    }
    expect(fs.existsSync(serverConfigPath())).toBe(false);
  });

  it('合法输入写归一化形态（trim 落盘、可选字段保留）', () => {
    writeServerLakeConfig({ address: '  https://example.com/lake.git  ', branch: '  main  ', directory: '/corpus/', lfs: false });
    const cfg = readServerLakeConfig();
    expect(cfg).toEqual({ address: 'https://example.com/lake.git', branch: 'main', directory: '/corpus/', lfs: false });
  });
});
