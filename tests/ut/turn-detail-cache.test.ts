// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// Turn 详情读侧缓存 IT（零 DB、纯文件系统——不向用户库写任何种子数据）：
//   ① readFullContext 缓存命中语义：同文件两次调用返回一致（缓存路径 =
//      纯函数路径），文件变更（mtime+size 键控）后新值生效——此处失效
//      逻辑损坏会静默显示过期 systemPrompt，是最危险的回归面
//   ② .gz 形态同款（捕获在盘上的常态）
//   ③ LRU 基元：容量逐出 + TTL 过期

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readFullContext, __clearFullContextCaches } from '@/lib/ingest/adapters/claude-jsonl-full-context';
import { LruCache } from '@/lib/lru-cache';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-cache-it-'));

function writeCapture(file: string, systemPrompt: string): void {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '任务' } }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'ok' },
      x_cannbay: { schema: 'cc-wire-round', version: 1, data: { system: systemPrompt, tools: [{ name: 'Read', description: 'read' }] } },
    }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const t = new Date();
  fs.utimesSync(file, t, t);
}

afterEach(() => {
  __clearFullContextCaches();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readFullContext 读侧缓存', () => {
  it('① 明文形态：两次调用一致；文件变更后新 systemPrompt 生效（stat 失效）', () => {
    const file = path.join(tmpRoot, 'plain.jsonl');
    writeCapture(file, 'SYSTEM-V1');
    const first = readFullContext(file);
    expect(first?.systemPrompt).toBe('SYSTEM-V1');
    expect(readFullContext(file)).toEqual(first); // 缓存命中 = 纯函数语义
    writeCapture(file, 'SYSTEM-V2-CHANGED');
    expect(readFullContext(file)?.systemPrompt).toBe('SYSTEM-V2-CHANGED');
  });

  it('② 压缩形态（盘上常态）同款失效语义', () => {
    const gz = path.join(tmpRoot, 'cap.jsonl.gz');
    const mk = (p: string) => zlib.gzipSync(
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' }, x_cannbay: { schema: 'cc-wire-round', version: 1, data: { system: p, tools: [{ name: 'Read', description: 'read' }] } } }) + '\n');
    fs.writeFileSync(gz, mk('GZ-V1'));
    const t1 = new Date(); fs.utimesSync(gz, t1, t1);
    expect(readFullContext(gz)?.systemPrompt).toBe('GZ-V1');
    expect(readFullContext(gz)?.systemPrompt).toBe('GZ-V1');
    fs.writeFileSync(gz, mk('GZ-V2'));
    // 等长内容 → gzip 产物同 size，失效全靠 mtimeMs；两次 utimes(new Date())
    // 在快机器上可能落在同一毫秒（键不变 → 命中旧缓存），必须确定性推进时间
    const t2 = new Date(Date.now() + 5000); fs.utimesSync(gz, t2, t2);
    expect(readFullContext(gz)?.systemPrompt).toBe('GZ-V2');
  });
});

describe('LruCache 基元', () => {
  it('③ 容量逐出 + TTL 过期', async () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    const t = new LruCache<string, number>(4, 10);
    t.set('k', 42);
    expect(t.get('k')).toBe(42);
    await new Promise(r => setTimeout(r, 20));
    expect(t.get('k')).toBeUndefined();
  });
});
