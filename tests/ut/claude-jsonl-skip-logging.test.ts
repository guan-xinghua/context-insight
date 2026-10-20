// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 跳过行告警 IT：未知行类型静默丢弃是「插队消息丢失」类事故的最早信号
//（2.1.3xx 的 queued_command 溜进 attachment 就是这么发生的）。未知类型
// 跳过必须 warn（含类型分布），已知元数据类型跳过 info 不告警。
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sink = vi.hoisted(() => ({
  warn: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
  info: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: (msg: string, fields?: Record<string, unknown>) => { sink.info.push({ msg, fields }); },
    warn: (msg: string, fields?: Record<string, unknown>) => { sink.warn.push({ msg, fields }); },
    error: () => {},
    debug: () => {},
  }),
}));

import { readSession } from '../../src/lib/ingest/adapters/claude-jsonl';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jsonl-skiplog-'));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeFixture(name: string, lines: unknown[]): string {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function base(): unknown[] {
  return [
    { type: 'user', message: { role: 'user', content: '任务' }, timestamp: '2026-10-19T12:00:00.000Z' },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '完成' }], model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: '2026-10-19T12:00:02.000Z' },
  ];
}

describe('claude-jsonl 跳过行分级告警', () => {
  it('未知类型跳过 → warn（含类型分布与 unknown 清单）', () => {
    sink.warn.length = 0; sink.info.length = 0;
    const file = writeFixture('unknown.jsonl', [
      ...base(),
      { type: 'future-new-thing', timestamp: '2026-10-19T12:00:03.000Z', payload: { may: 'carry semantics' } },
      { type: 'ai-title', timestamp: '2026-10-19T12:00:04.000Z', title: '标题' },
    ]);
    readSession(file, 'skip-unknown');
    expect(sink.warn).toHaveLength(1);
    expect(sink.warn[0]!.fields?.unknown).toBe('future-new-thing');
    const dist = JSON.parse(sink.warn[0]!.fields?.dist as string) as Record<string, number>;
    expect(dist['future-new-thing']).toBe(1);
    expect(dist['ai-title']).toBe(1);
  });

  it('仅已知元数据类型跳过 → info 不告警', () => {
    sink.warn.length = 0; sink.info.length = 0;
    const file = writeFixture('known.jsonl', [
      ...base(),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-19T12:00:03.000Z', content: '排队' },
      { type: 'queue-operation', operation: 'remove', timestamp: '2026-10-19T12:00:04.000Z', content: '排队' },
      { type: 'api-request-blob', timestamp: '2026-10-19T12:00:05.000Z', hash: 'h' },
      { type: 'attachment', uuid: 'x1', attachment: { type: 'environment' }, timestamp: '2026-10-19T12:00:06.000Z' },
      // 语义已由他处消费的载体行：tool_result-only user（并入 assistant 的
      // tool_calls）与无 message 的 assistant 记账行——不告警（真机 2.1.303
      // 每个繁忙会话都有，误报会造成告警疲劳）
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'done' }] }, timestamp: '2026-10-19T12:00:07.000Z' },
      { type: 'assistant', timestamp: '2026-10-19T12:00:08.000Z' },
    ]);
    readSession(file, 'skip-known');
    expect(sink.warn).toHaveLength(0);
    expect(sink.info).toHaveLength(1);
    const dist = JSON.parse(sink.info[0]!.fields?.dist as string) as Record<string, number>;
    expect(dist['queue-operation']).toBe(2);
    expect(dist['api-request-blob']).toBe(1);
    expect(dist['attachment/environment']).toBe(1);
    expect(dist['user']).toBe(1);
  });

  it('未知 attachment 子类型 → warn（queued_command 事故的复发形态）', () => {
    sink.warn.length = 0; sink.info.length = 0;
    const file = writeFixture('unknown-sub.jsonl', [
      ...base(),
      { type: 'attachment', uuid: 'y1', attachment: { type: 'future-user-carrying-subtype', prompt: '语义载荷' }, timestamp: '2026-10-19T12:00:03.000Z' },
    ]);
    readSession(file, 'skip-unknown-sub');
    expect(sink.warn).toHaveLength(1);
    expect(sink.warn[0]!.fields?.unknown).toBe('attachment/future-user-carrying-subtype');
  });

  it('门控丢弃的 queued_command → warn（真实用户被误标时不可无声）', () => {
    sink.warn.length = 0; sink.info.length = 0;
    const file = writeFixture('gated.jsonl', [
      ...base(),
      { type: 'attachment', uuid: 'g1', attachment: { type: 'queued_command', prompt: '可能被误标的真实提问', humanTurn: false, origin: { kind: 'human' } }, timestamp: '2026-10-19T12:00:03.000Z' },
    ]);
    readSession(file, 'skip-gated');
    expect(sink.warn).toHaveLength(1);
    expect(sink.warn[0]!.fields?.unknown).toContain('attachment/queued_command!gated');
    const dist = JSON.parse(sink.warn[0]!.fields?.dist as string) as Record<string, number>;
    expect(dist['attachment/queued_command!gated']).toBe(1);
  });

  it('吸收进分组的 tool_result 载体行不产生幻影 assistant 跳过计数', () => {
    sink.warn.length = 0; sink.info.length = 0;
    const file = writeFixture('interleaved.jsonl', [
      { type: 'user', message: { role: 'user', content: '任务' }, timestamp: '2026-10-19T12:00:00.000Z' },
      // 同 message.id 的 assistant 分组，中间穿插 tool_result-only user 行：
      // 旧连续下标映射会把第二行 assistant 挤出分组映射 → 误计 assistant 跳过
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'bash', input: { command: 'ls' } }], model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: '2026-10-19T12:00:01.000Z' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'out' }] }, timestamp: '2026-10-19T12:00:02.000Z' },
      { type: 'assistant', uuid: 'a2', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '完成' }], model: 'glm-5.2', usage: { input_tokens: 12, output_tokens: 3 } }, timestamp: '2026-10-19T12:00:03.000Z' },
    ]);
    const interactions = readSession(file, 'skip-interleaved');
    // 内容合入一组、不丢
    const asst = interactions.filter(i => i.role === 'assistant');
    expect(asst).toHaveLength(1);
    expect((asst[0]!.content ?? '')).toContain('完成');
    // 无幻影：assistant 不出现在跳过分布里
    const info = sink.info.find(e => e.msg.includes('已知元数据'));
    const dist = info ? JSON.parse(info.fields?.dist as string) as Record<string, number> : {};
    expect(dist['assistant']).toBeUndefined();
  });

  it('无跳过行 → 不出日志', () => {
    sink.warn.length = 0; sink.info.length = 0;
    const file = writeFixture('clean.jsonl', base());
    readSession(file, 'skip-clean');
    expect(sink.warn).toHaveLength(0);
    expect(sink.info).toHaveLength(0);
  });
});
