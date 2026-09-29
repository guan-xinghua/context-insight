// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OR MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake 嵌套 directory baseline 定位 IT：自定义 directory 含 '/'（嵌套
// rootDir，如 custom/deep）时 <rootDir>/baseline/<sid>/ 的三段定位——修复前
// locateSessionLocations 嵌套兜底对 baseline 段命中的会话硬记
// baseline:false，locationPath 解析成 <rootDir>/<sid>/：materializeSession
// 报 Session folder not found in lake，uploadFolder 的 staleLocs 清理也指向
// 错误路径。普通嵌套位 <rootDir>/<sid>/ 为既有正确行为，一并锁定防回归。
// env 必须在 lake 模块加载前设置（mirror.ts 模块顶层读取 env）。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { seedLakeConfig } from '../helpers/lake-env';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-nested-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# nested baseline it\n');

const SID_BASELINE = 'cc-nested-it-b';
const SID_PLAIN = 'cc-nested-it-p';

function placeSession(sid: string, baseline: boolean, marker: string): void {
  const dir = path.join(SEED, 'custom', 'deep', ...(baseline ? ['baseline'] : []), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: marker }, timestamp: '2026-09-29T03:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: `m_${sid}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-09-29T03:00:05.000Z' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, `${sid}.meta.json`), JSON.stringify({
    x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'claude-code', ccVersion: '9.9.9', sid } },
  }));
}
placeSession(SID_BASELINE, true, '嵌套 baseline 会话内容');
placeSession(SID_PLAIN, false, '嵌套普通位会话内容');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m "nested baseline structure"', SEED);
git('git push -q origin main', SEED);

seedLakeConfig(TMP, { address: BARE, directory: 'custom/deep' });
process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = CACHE;

const mirror = await import('../../src/lib/lake/mirror');

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('嵌套 directory（rootDir 含 /）的 baseline 三段定位', () => {
  it('materializeSession 定位 <rootDir>/baseline/<sid>/（修复前解析成 <rootDir>/<sid>/ 报 not found）', () => {
    const mainJsonl = mirror.materializeSession(SID_BASELINE);
    expect(fs.readFileSync(mainJsonl, 'utf8')).toContain('嵌套 baseline 会话内容');
  });

  it('普通嵌套位 <rootDir>/<sid>/ 定位不受影响（既有行为）', () => {
    const mainJsonl = mirror.materializeSession(SID_PLAIN);
    expect(fs.readFileSync(mainJsonl, 'utf8')).toContain('嵌套普通位会话内容');
  });
});
