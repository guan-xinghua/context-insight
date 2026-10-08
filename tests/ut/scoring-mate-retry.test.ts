// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Mate 保底重试（最多两次）：输出解析不出 JSON 时自动再评一次。
// mock 掉 spawn（不起真 agent）与物料导出（不碰 DB），只验证重试编排本身。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a), spawnSync: vi.fn() }));
vi.mock('../../src/lib/scoring/mate-agent/material', () => ({
  exportMaterial: vi.fn(async () => ({ dir: '/tmp/fake-mate' })),
  safeId: (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80),
}));

/** 假 agent 进程：同步吐 stdout，下一拍 close(0) */
function fakeChild(stdoutText: string) {
  return {
    stdout: { on: (_ev: string, cb: (d: Buffer) => void) => { if (stdoutText) cb(Buffer.from(stdoutText)); } },
    stderr: { on: () => {} },
    on: (ev: string, cb: (...a: unknown[]) => void) => { if (ev === 'close') setTimeout(() => cb(0), 1); },
    kill: () => {},
  };
}

const GOOD = '{"dimensionId":"D6","items":[{"itemId":"D6.classification","value":0}]}';

describe('runMateAgentDimension 保底重试（最多两次）', () => {
  let logDir: string;

  beforeEach(() => {
    spawnMock.mockReset();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-retry-test-'));
    process.env.MATE_AGENT_LOG_DIR = logDir;
  });

  afterEach(() => {
    delete process.env.MATE_AGENT_LOG_DIR;
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('首次输出无 JSON → 自动重评一次成功：两次调用、无失败', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild('这是分析正文，但没有 JSON 对象'))
      .mockReturnValueOnce(fakeChild(`结论如上。\n${GOOD}`));
    const { runMateAgentDimension } = await import('../../src/lib/scoring/mate-agent/runner');
    const r = await runMateAgentDimension('retry-t1', null as never, 'D6', { tool: 'claude', timeoutMs: 1000 });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    // 重试 prompt 带强化指令与上次输出结尾
    const retryArgs = String(spawnMock.mock.calls[1][1][1]);
    expect(retryArgs).toContain('本次是重试');
    expect(retryArgs).toContain('这是分析正文');
    expect(r.parseError).toBeNull();
    expect(r.items).toHaveLength(1);
    expect(r.items![0].itemId).toBe('D6.classification');
  });

  it('首次成功不重试：只调用一次', async () => {
    spawnMock.mockReturnValueOnce(fakeChild(GOOD));
    const { runMateAgentDimension } = await import('../../src/lib/scoring/mate-agent/runner');
    const r = await runMateAgentDimension('retry-t2', null as never, 'D6', { tool: 'claude', timeoutMs: 1000 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(r.parseError).toBeNull();
  });

  it('两次都失败：封顶不再重试，失败提示含「重试后仍失败」并留痕', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild('纯文字回复一'))
      .mockReturnValueOnce(fakeChild('纯文字回复二'));
    const { runMateAgentDimension } = await import('../../src/lib/scoring/mate-agent/runner');
    const r = await runMateAgentDimension('retry-t3', null as never, 'D6', { tool: 'claude', timeoutMs: 1000 });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(r.items).toBeNull();
    expect(r.parseError).toContain('重试后仍失败');
    expect(r.parseError).toContain(logDir);
    const logFile = r.parseError!.match(/见 (.+)）$/)?.[1];
    expect(logFile).toBeTruthy();
    expect(fs.readFileSync(logFile!, 'utf-8')).toContain('纯文字回复一');
    expect(fs.readFileSync(logFile!, 'utf-8')).toContain('─── 重试输出 ───');
    expect(fs.readFileSync(logFile!, 'utf-8')).toContain('纯文字回复二');
  });
});
