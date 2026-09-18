// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 命令注入修复 IT（0000155/0000164 + import-from-cannbay 同型）：runGit 走
// execFileSync 数组传参后，镜像仓里带 shell 元字符（$(...) / " ; ; "）的
// 文件名在归档轮转（git log / git rm / git push）全程不得被 shell 解释——
// marker 文件不落地、git 操作照常成功、归档分支持有原文件。
// 回归口径：旧 execSync 字符串模式下 `git rm --quiet "$(touch marker).db"`
// 中的命令替换会执行，marker 落地 → 本用例失败。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotateArchiveIfNeeded } from '@/app/api/ingest/upload-session/route';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

let work: string;
let origin: string;
let clone: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-inject-it-'));
  origin = path.join(work, 'origin.git');
  git(['init', '--bare', '-b', 'master', origin], work);
  clone = path.join(work, 'clone');
  git(['clone', origin, clone], work);
  git(['config', 'user.email', 'it@test.local'], clone);
  git(['config', 'user.name', 'it'], clone);
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function commitBatch(files: string[], message: string): void {
  for (const f of files) fs.writeFileSync(path.join(clone, f), 'x');
  git(['add', '.'], clone);
  git(['commit', '-m', message], clone);
}

describe('upload-session · runGit metachar filename immunity (real git)', () => {
  it('`$(touch${IFS}marker).db` rotates off master without executing the substitution', () => {
    const evil = `$(touch\${IFS}pwned-marker).db`;
    const marker = path.join(clone, 'pwned-marker');
    commitBatch([evil], 'oldest batch');
    commitBatch(Array.from({ length: 20 }, (_, i) => `s${i}.db`), 'newer batch');

    const branch = rotateArchiveIfNeeded(clone, Date.now(), origin);

    expect(branch).toMatch(/^archive-\d{4}-\d{2}$/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(clone, evil))).toBe(false);
    expect(() => git(['show', `${branch}:${evil}`], clone)).not.toThrow();
    expect(fs.existsSync(path.join(clone, 's0.db'))).toBe(true);
  });

  it('`";touch marker;" style quote-breakout filename is inert', () => {
    const evil = `";touch pwned-marker2;".db`;
    const marker = path.join(clone, 'pwned-marker2');
    commitBatch([evil], 'oldest batch');
    commitBatch(Array.from({ length: 20 }, (_, i) => `s${i}.db`), 'newer batch');

    const branch = rotateArchiveIfNeeded(clone, Date.now(), origin);

    expect(branch).toMatch(/^archive-\d{4}-\d{2}$/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(() => git(['show', `${branch}:${evil}`], clone)).not.toThrow();
  });
});
