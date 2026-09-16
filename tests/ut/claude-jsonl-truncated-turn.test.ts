// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 撞 max_tokens 截断的空 assistant 轮保留 IT（客户现场：并发 subagent
// ses_f5f5585f3ffe…vbYQjB 最后一轮 stopReason=length、content=[]、32000t
// output——修复前 buildAssistantInteraction 整组 return null，截断事实连同
// usage 一起消失，时间线上一轮 read 后"突然结束"、token 统计少算 32000）。
// 数据驱动：现场尾部三行的脱敏形态写入 tmpdir jsonl → readSession 全管线。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession } from '../../src/lib/ingest/adapters/claude-jsonl';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jsonl-trunc-'));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeFixture(name: string, lines: unknown[]): string {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('claude-jsonl：截断空轮保留（stopReason=length + content=[]）', () => {
  it('尾部截断行成 turn：content null、finish_reason=length、usage 32000 不丢', () => {
    const file = writeFixture('trunc.jsonl', [
      { type: 'user', message: { role: 'user', content: '执行任务' }, timestamp: '2026-09-14T16:05:22.163Z', source: 'opencode-proxy' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '先读文件' }, { type: 'tool_use', id: 'call_a', name: 'read', input: { filePath: '/tmp/a.md' } }], model: 'glm-5.3', usage: { input_tokens: 65203, output_tokens: 66, cache_read_input_tokens: 60864 } }, timestamp: '2026-09-14T16:06:09.163Z', source: 'opencode-proxy', stopReason: 'tool_calls' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'file body' }] }, timestamp: '2026-09-14T16:06:09.350Z', source: 'opencode-proxy' },
      // 现场截断行：content=[]、output 烧满 32000、stopReason=length
      { type: 'assistant', message: { role: 'assistant', content: [], model: 'glm-5.3', usage: { input_tokens: 74186, output_tokens: 32000, cache_read_input_tokens: 65152 } }, timestamp: '2026-09-14T16:14:31.829Z', source: 'opencode-proxy', stopReason: 'length', duration_ms: 502479 },
    ]);

    const interactions = readSession(file, 'trunc-test');
    const last = interactions[interactions.length - 1];
    expect(last).toBeTruthy();
    expect(last.role).toBe('assistant');
    expect(last.finish_reason).toBe('length');
    expect(last.usage?.output).toBe(32000);
    expect(last.usage?.input).toBe(74186);
    expect(last.content).toBeNull();
  });

  it('真正的空行（无 usage 无 finishReason）仍丢弃', () => {
    const file = writeFixture('empty.jsonl', [
      { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-09-14T16:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [], model: 'm' }, timestamp: '2026-09-14T16:00:01.000Z' },
    ]);
    const interactions = readSession(file, 'empty-test');
    expect(interactions.filter(i => i.role === 'assistant')).toHaveLength(0);
  });

  it('正常 text 轮不受影响（回归对照）', () => {
    const file = writeFixture('normal.jsonl', [
      { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-09-14T16:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'm', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: '2026-09-14T16:00:01.000Z', source: 'opencode-proxy', stopReason: 'end_turn' },
    ]);
    const interactions = readSession(file, 'normal-test');
    const a = interactions.find(i => i.role === 'assistant');
    expect(a?.content).toBe('done');
    expect(a?.finish_reason).toBe('end_turn');
  });
});
