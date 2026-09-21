// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// insight compression.ts 结构 IT：ensure7z 大文件路径回归锁（与 cpx
// writer-compression.test.ts 的 ensure7z 用例 parity——受控双实现同构锁定）。
// 旧实现 writeFileSync(plain, readCaptureText(filePath)) 把整文件走一遍
// UTF-8 字符串：明文/解压后 >512MB（V8 单字符串上限 0x1FFFFFE8）直接
// RangeError——claude-jsonl.ts 记录的 631MB wire 捕获（3.5 天会话）就是
// 这个量级，旧 gzip 路径全程 Buffer 能处理，字符串中转是回归。触发面：
// stageSessionFiles 对明文 sourcePath（native claude 大会话 / cpx 未压缩
// 残留）与存量 .gz 迁移都调 ensure7z。锁法：spy writeFileSync，三形态
// 转换的落盘写只允许 Buffer（.gz 解压落盘），明文路径零写（7za 子进程直压）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensure7z, readCaptureText } from '../../src/lib/compression.ts';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-7z-ensure-'));

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

describe('ensure7z 大文件路径（零字符串中转）', () => {
  it('明文/.gz → .7z 全程 Buffer 落盘（无字符串写回）；.7z 幂等；内容往返不变', () => {
    const gz = path.join(tmpRoot, 's1.jsonl.gz');
    fs.writeFileSync(gz, zlib.gzipSync('a\nb\n'));
    const plain = path.join(tmpRoot, 's2.jsonl');
    fs.writeFileSync(plain, 'c\nd\n');
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      expect(ensure7z(gz)).toBe(path.join(tmpRoot, 's1.jsonl.7z'));
      expect(ensure7z(plain)).toBe(path.join(tmpRoot, 's2.jsonl.7z'));
      expect(ensure7z(path.join(tmpRoot, 's2.jsonl.7z'))).toBe(path.join(tmpRoot, 's2.jsonl.7z'));
      // 仅 .gz 路径 decompressToPlain 的 Buffer 落盘一次；任何字符串写回（旧实现）在此现形
      expect(spy.mock.calls).toHaveLength(1);
      for (const [, data] of spy.mock.calls) expect(typeof data).not.toBe('string');
    } finally {
      spy.mockRestore();
    }
    expect(readCaptureText(path.join(tmpRoot, 's1.jsonl.7z'))).toBe('a\nb\n');
    expect(readCaptureText(path.join(tmpRoot, 's2.jsonl.7z'))).toBe('c\nd\n');
  });
});
