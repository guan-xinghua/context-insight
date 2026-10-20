// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Ctrl+X Ctrl+C 插队消息保留 IT（现场 b85a63cf，claude-code 2.1.303）：用户
// 在运行中插队提问，落盘为 queue-operation（记账，无 uuid）+ attachment/
// queued_command（delivery，用户原文在 attachment.prompt）——修复前
// attachment 整类被当非断行元数据丢弃，时间线上用户提问与其回答之间的
// 插入点消失（「丢失了一个 ctrl+x ctrl+c 插入的用户命令」）。修复后
// queued_command 断开 assistant 分组并升格为 user interaction。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession } from '../../src/lib/ingest/adapters/claude-jsonl';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jsonl-queued-'));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeFixture(name: string, lines: unknown[]): string {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const T0 = '2026-10-19T12:20:00.000Z';
const TQ = '2026-10-19T12:21:07.619Z';
const T1 = '2026-10-19T12:21:12.639Z';

function fixture(): string {
  return writeFixture('queued.jsonl', [
    { type: 'user', message: { role: 'user', content: '构建工程' }, timestamp: T0 },
    // 运行中的 assistant 分组（同 message.id 的两行，中间穿插 tool_result）
    { type: 'assistant', uuid: 'a1', parentUuid: 'u0', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: '开始安装依赖' }], model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 20 } }, timestamp: '2026-10-19T12:20:10.000Z' },
    { type: 'user', uuid: 'a2', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'done' }] }, timestamp: '2026-10-19T12:21:05.000Z' },
    { type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'bash', input: { command: 'install' } }], model: 'glm-5.2', usage: { input_tokens: 120, output_tokens: 10 } }, timestamp: '2026-10-19T12:21:06.000Z' },
    // 插队记账行（无 uuid，非会话链）——不得产出任何 interaction
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-19T12:21:07.623Z', content: '为啥需要rust' },
    // delivery 行：用户原文在 attachment.prompt
    {
      type: 'attachment', uuid: 'a4', parentUuid: 'a3',
      attachment: { type: 'queued_command', prompt: '为啥需要rust', source_uuid: 'cmd-1', delivery_id: 'dlv-1', commandMode: 'prompt', origin: { kind: 'human' }, timestamp: TQ, humanTurn: true },
      timestamp: TQ,
      rendered: [{ content: '<system-reminder>\nThe user sent a new message while you were working:\n为啥需要rust\n</system-reminder>' }],
      renderedRole: 'system',
    },
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-10-19T12:21:09.757Z', content: '为啥需要rust', reason: 'absorbed_mid_turn', commandUuid: 'cmd-1', deliveryId: 'dlv-1' },
    // 同 message.id 的续答（wire 上作为运行中 turn 的注入块送出）
    { type: 'assistant', uuid: 'a5', parentUuid: 'a4', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'The user asks why Rust is needed' }, { type: 'text', text: '好问题，我来查一下具体原因。' }], model: 'glm-5.2', usage: { input_tokens: 200, output_tokens: 80 } }, timestamp: T1 },
  ]);
}

describe('claude-jsonl：插队消息（attachment/queued_command）升格 user 轮', () => {
  it('插队提问成为 user interaction，位置在插入点（前 assistant 与续答之间）', () => {
    const interactions = readSession(fixture(), 'queued-test');
    const idx = interactions.findIndex(i => i.role === 'user' && i.content === '为啥需要rust');
    expect(idx).toBeGreaterThan(0);
    expect(interactions[idx - 1].role).toBe('assistant');
    expect(interactions[idx + 1].role).toBe('assistant');
    expect((interactions[idx + 1].content ?? '').includes('好问题')).toBe(true);
  });

  it('同 message.id 的运行中分组被插队消息断开（续答独立成 interaction）', () => {
    const interactions = readSession(fixture(), 'queued-test2');
    const before = interactions.find(i => i.role === 'assistant' && (i.content ?? '').includes('开始安装依赖'))!;
    const after = interactions.find(i => i.role === 'assistant' && (i.content ?? '').includes('好问题'))!;
    expect(before).not.toBe(after);
  });

  it('非人类注入的 queued_command（hook/MCP 注入、humanTurn=false）不冒充用户轮', () => {
    const file = writeFixture('nonhuman.jsonl', [
      { type: 'user', message: { role: 'user', content: '任务' }, timestamp: '2026-10-19T12:00:00.000Z' },
      { type: 'attachment', uuid: 'c1', attachment: { type: 'queued_command', prompt: '钩子注入', humanTurn: false, origin: { kind: 'human' } }, timestamp: '2026-10-19T12:00:01.000Z' },
      { type: 'attachment', uuid: 'c2', attachment: { type: 'queued_command', prompt: 'MCP 注入', humanTurn: true, origin: { kind: 'mcp' } }, timestamp: '2026-10-19T12:00:02.000Z' },
      { type: 'assistant', uuid: 'c3', message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: '响应' }], model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: '2026-10-19T12:00:03.000Z' },
    ]);
    const interactions = readSession(file, 'nonhuman-test');
    expect(interactions.some(i => i.role === 'user' && i.content === '钩子注入')).toBe(false);
    expect(interactions.some(i => i.role === 'user' && i.content === 'MCP 注入')).toBe(false);
  });

  it('queue-operation 记账行不产出 interaction；非 queued_command 的 attachment 仍为元数据', () => {
    const file = writeFixture('ops.jsonl', [
      { type: 'user', message: { role: 'user', content: '任务' }, timestamp: '2026-10-19T12:00:00.000Z' },
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-19T12:00:01.000Z', content: '排队文本' },
      { type: 'assistant', uuid: 'b1', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: '干活' }], model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: '2026-10-19T12:00:02.000Z' },
      { type: 'attachment', uuid: 'b2', parentUuid: 'b1', attachment: { type: 'file-attachment', prompt: '不是插队' }, timestamp: '2026-10-19T12:00:03.000Z' },
      { type: 'assistant', uuid: 'b3', parentUuid: 'b2', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: '继续' }], model: 'glm-5.2', usage: { input_tokens: 12, output_tokens: 3 } }, timestamp: '2026-10-19T12:00:04.000Z' },
    ]);
    const interactions = readSession(file, 'ops-test');
    expect(interactions.some(i => i.content === '排队文本')).toBe(false);
    expect(interactions.some(i => i.content === '不是插队')).toBe(false);
    // file-attachment 不断组：两行同 id 的 assistant 仍是一组
    const texts = interactions.filter(i => i.role === 'assistant').map(i => i.content ?? '');
    expect(texts.some(t => t.includes('干活') && t.includes('继续'))).toBe(true);
  });
});
