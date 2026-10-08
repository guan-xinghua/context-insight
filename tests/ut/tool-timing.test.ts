// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工具执行时间推导（wire 轮间隙）：主链+子代理捕获 → 区间/本地/派发分拆，
// 以及 Perf 侧 wireToolDurations 的格式门控。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveToolTiming, wireToolDurations } from '../../src/lib/tool-timing';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-timing-'));
const T = 1_700_000_000_000;   // 基准时刻
const ts = (offsetMs: number) => new Date(T + offsetMs).toISOString();
const w = (obj: unknown) => JSON.stringify(obj);

beforeAll(() => {
  // 主链：t1+t2 同批（均分 4000 间隙）、t3 派发、t4 无结果（不计）
  fs.writeFileSync(path.join(TMP, 'cpx-s1.jsonl'), [
    w({ type: 'user', timestamp: ts(0), message: { role: 'user', content: '任务' } }),
    w({
      type: 'assistant', timestamp: ts(10000), duration_ms: 5000,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        { type: 'tool_use', id: 't2', name: 'Read', input: {} },
      ] },
    }),
    w({
      type: 'user', timestamp: ts(14000),
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1' }, { type: 'tool_result', tool_use_id: 't2' },
      ] },
    }),
    w({
      type: 'assistant', timestamp: ts(20000), duration_ms: 3000,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Task', input: {} }] },
    }),
    w({
      type: 'user', timestamp: ts(120000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3' }] },
    }),
    w({
      type: 'assistant', timestamp: ts(121000), duration_ms: 1000,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'Edit', input: {} }] },
    }),
  ].join('\n') + '\n');
  // 子代理：t5 本地工具
  fs.mkdirSync(path.join(TMP, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 's1', 'subagents', 'subA.jsonl'), [
    w({
      type: 'assistant', timestamp: ts(30000), duration_ms: 2000,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't5', name: 'Bash', input: {} }] },
    }),
    w({
      type: 'user', timestamp: ts(33000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't5' }] },
    }),
  ].join('\n') + '\n');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('deriveToolTiming（wire 轮间隙）', () => {
  const main = path.join(TMP, 'cpx-s1.jsonl');

  it('主链+子代理各自推导：同批均分、派发分拆、末轮无结果不计', () => {
    const r = deriveToolTiming(main, 's1')!;
    expect(r).not.toBeNull();
    expect(r.chains).toBe(2);
    const byId = new Map(r.intervals.map(i => [i.toolUseId, i]));
    // 同批 t1/t2 均分 4000ms → 各 2000，串行衔接
    const t1 = byId.get('t1')!, t2 = byId.get('t2')!;
    expect(t1.kind).toBe('local');
    expect(t1.startMs).toBe(T + 10000);
    expect(t1.endMs).toBe(T + 12000);
    expect(t2.startMs).toBe(T + 12000);
    expect(t2.endMs).toBe(T + 14000);
    // 派发：Task 窗口 = subagent 整段执行，不计工具时长
    const t3 = byId.get('t3')!;
    expect(t3.kind).toBe('dispatch');
    expect(t3.endMs - t3.startMs).toBe(100000);
    // 子代理链本地工具
    const t5 = byId.get('t5')!;
    expect(t5.chainSid).toBe('subA');
    expect(t5.endMs - t5.startMs).toBe(3000);
    // 末轮 t4 无 tool_result → 不出区间
    expect(byId.has('t4')).toBe(false);
    expect(r.localToolMs).toBe(2000 + 2000 + 3000);
    expect(r.dispatchWallMs).toBe(100000);
    expect(r.llmMs).toBe(5000 + 3000 + 1000 + 2000);
  });

  it('捕获缺失 → null（调用方走各自兜底）', () => {
    expect(deriveToolTiming(path.join(TMP, 'nope.jsonl'), 's1')).toBeNull();
  });
});

describe('wireToolDurations（Perf 侧门控）', () => {
  it('claude 格式（含 -proxy 变体）出映射，原生 opencode 返回 null', () => {
    const main = path.join(TMP, 'cpx-s1.jsonl');
    const okMap = wireToolDurations(main, 's1', 'opencode-proxy', '1.0-opencode-proxy');
    expect(okMap).not.toBeNull();
    expect(okMap!.get('t1')).toBe(2000);
    expect(okMap!.get('t3')).toBe(100000);
    expect(wireToolDurations(main, 's1', 'opencode', null)).toBeNull();
    expect(wireToolDurations(null, 's1', 'opencode-proxy', null)).toBeNull();
  });
});
