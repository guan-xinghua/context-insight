// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// browse-directory `~` 展开 IT：Import Session 快捷路径按钮（cpx proxy 捕获
// ~/.cannbot-insight/proxy / Claude 原生 ~/.claude/projects / opencode 数据
// ~/.local/share/opencode / 主目录 ~）把 `~` 路径原样发给本路由 —— 服务端按
// 当前用户主目录展开（path.resolve 不识别 `~`，客户端不知道服务端 home）。
// 用临时目录夹具验证：`~`/`~/x` 展开、绝对路径行为不变、不存在路径 404
// 带展开后的真实路径。真实 home 不落地任何夹具（只读其存在性）。

import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POST } from '@/app/api/ingest/browse-directory/route';

function req(dirPath: string): NextRequest {
  return new NextRequest('http://localhost/api/ingest/browse-directory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dirPath }),
  });
}

// 在真实 home 下造一个临时夹具目录（夹具名随机防并发；afterAll 清理）
const FIXTURE = `.insight-browse-it-${process.pid}-${Date.now().toString(36)}`;

describe('POST /api/ingest/browse-directory — `~` 展开', () => {
  it('`~` → 真实主目录列表（快捷"主目录"按钮路径）', async () => {
    const res = await POST(req('~'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isDirectory).toBe(true);
    expect(data.currentPath).toBe(os.homedir());
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('`~/<fixture>` → 展开后列出内容（夹具内 .jsonl 标记可导入）', async () => {
    const dir = path.join(os.homedir(), FIXTURE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capture.jsonl'), '{"type":"user"}\n');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    try {
      const res = await POST(req(`~/${FIXTURE}`));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentPath).toBe(dir);
      expect(data.parentPath).toBe(os.homedir());
      const names = (data.entries ?? []).map((e: { name: string }) => e.name);
      expect(names).toContain('sub');
      const jsonl = (data.entries ?? []).find((e: { name: string }) => e.name === 'capture.jsonl');
      expect(jsonl.isImportableFile).toBe(true);
      expect(jsonl.importableType).toBe('claude-jsonl');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('绝对路径行为不变（回归）；`~` 不存在的子路径 → 404 报展开后的真实路径', async () => {
    const abs = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-browse-it-'));
    try {
      const res = await POST(req(abs));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentPath).toBe(abs);
    } finally {
      fs.rmSync(abs, { recursive: true, force: true });
    }

    const missing = await POST(req(`~/${FIXTURE}-no-such`));
    expect(missing.status).toBe(404);
    const errData = await missing.json();
    expect(errData.error).toContain(path.join(os.homedir(), `${FIXTURE}-no-such`));
  });
});
