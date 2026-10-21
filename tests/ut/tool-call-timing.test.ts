// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// IT：工具真实起止时间戳全链采集（ToolCallInfo → ToolCallRow → DB 列）。
// 背景：ToolCall.startedAt/completedAt 此前是所属轮时间的复制品、durationMs 恒
// 0——工具时间在折叠 tool_result 时被丢弃，TPS/TPOT 的「区间减工具时长」算法
// 无从谈起。双源验证 + 无时间源降级（不劣于现状）：
//   claude-jsonl：tool_use 行 ts = startedAt，tool_result 行 ts = completedAt
//   opencode v1 ：part.time_created / 终态 time_updated；非终态 completedAt=null
//   降级        ：源不带时间 → 维持复制轮时间 + durationMs=0 的既有行为

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readSession as readClaudeSession } from '../../src/lib/ingest/adapters/claude-jsonl.ts';
import { readSession as readOpencodeSession } from '@/lib/ingest/adapters/opencode-db';
import { splitIntoTurns, resetIdCounter } from '../../src/lib/ingest/turn-split.ts';
import type { RawInteraction } from '../../src/lib/shared/types';

const FIXTURE_DIR = path.resolve(__dirname, './data');

// ── claude-jsonl：tool_use/tool_result 行时间戳 ──

describe('claude-jsonl 工具时间戳采集', () => {
  let interactions: RawInteraction[];
  let split: ReturnType<typeof splitIntoTurns>;

  beforeAll(() => {
    resetIdCounter();
    interactions = readClaudeSession(
      path.join(FIXTURE_DIR, 'claude-sessions/tool-timing-session.jsonl'),
      'tool-timing-session',
    );
    split = splitIntoTurns(interactions, 'session-tool-timing-claude');
  });

  it('adapter 层：startedAt=tool_use 行时刻，completedAt=tool_result 行时刻', () => {
    const tc = interactions.flatMap(i => i.tool_calls ?? []).find(t => t.toolCallId === 'call_tt_1')!;
    expect(tc).toBeDefined();
    expect(tc.startedAt).toBe(Date.parse('2026-10-20T03:00:02.000Z'));
    expect(tc.completedAt).toBe(Date.parse('2026-10-20T03:00:07.000Z'));
  });

  it('turn-split 层：durationMs=真实执行 5000ms，起止为真实时刻', () => {
    const row = split.toolCalls.find(t => t.toolCallId === 'call_tt_1')!;
    expect(row).toBeDefined();
    expect(row.durationMs).toBe(5000);
    expect(row.startedAt).toBe('2026-10-20T03:00:02.000Z');
    expect(row.completedAt).toBe('2026-10-20T03:00:07.000Z');
  });

  it('轮时延=请求边界推导（非组内行跨度）：用户消息/工具结果为界', () => {
    // 组1：assistant@03:00:02，边界=用户消息@03:00:00 → latency 2000ms
    const t1 = split.turns.find(t => t.content?.includes('执行工具'))!;
    expect(t1.latencyMs).toBe(2000);
    // 组2：assistant@03:00:12，边界=工具结果@03:00:07 → latency 5000ms
    const t2 = split.turns.find(t => t.content === '完成')!;
    expect(t2.latencyMs).toBe(5000);
  });
});

// ── opencode v1：part.time_created / 终态 time_updated ──

describe('opencode v1 工具时间戳采集', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-tool-timing-'));
  const DB_FILE = path.join(TMP, 'opencode.db');
  let interactions: RawInteraction[];
  let split: ReturnType<typeof splitIntoTurns>;

  beforeAll(() => {
    const sql = fs.readFileSync(path.join(FIXTURE_DIR, 'opencode-tool-timing.sql'), 'utf8');
    const db = new Database(DB_FILE);
    db.exec(sql);
    db.close();
    resetIdCounter();
    interactions = readOpencodeSession(DB_FILE, 'ses_tooltim01ffeTimingAa');
    split = splitIntoTurns(interactions, 'session-tool-timing-opencode');
  });

  it('completed 工具：startedAt=time_created，completedAt=time_updated（4000ms）', () => {
    const tc = interactions.flatMap(i => i.tool_calls ?? []).find(t => t.toolCallId === 'call_tt_op1')!;
    expect(tc).toBeDefined();
    expect(tc.startedAt).toBe(1792000006000);
    expect(tc.completedAt).toBe(1792000010000);
    const row = split.toolCalls.find(t => t.toolCallId === 'call_tt_op1')!;
    expect(row.durationMs).toBe(4000);
  });

  it('running 非终态工具：completedAt 降级 null，durationMs=0（time_updated 非完成时刻）', () => {
    const tc = interactions.flatMap(i => i.tool_calls ?? []).find(t => t.toolCallId === 'call_tt_op2')!;
    expect(tc).toBeDefined();
    expect(tc.startedAt).toBe(1792000011000);
    expect(tc.completedAt).toBeNull();
    const row = split.toolCalls.find(t => t.toolCallId === 'call_tt_op2')!;
    expect(row.durationMs).toBe(0);
  });
});

// ── 降级：源不带时间（如 opencode v2 / 旧导出件）→ 维持既有行为 ──

describe('无时间源降级', () => {
  it('ToolCallInfo 无时间字段 → 复制所属轮时间、durationMs=0（现状不劣化）', () => {
    resetIdCounter();
    const interactions: RawInteraction[] = [
      {
        role: 'assistant', content: 'text', timestamp: '2026-10-20T04:00:00.000Z',
        timeInfo: { created: Date.parse('2026-10-20T04:00:00.000Z'), completed: Date.parse('2026-10-20T04:00:05.000Z') },
        agent: null, subagent_name: null, subagent_session_id: null, subagent_type: null,
        tool_calls: [{ toolCallId: 'c1', toolName: 'Bash', argsJson: null, resultJson: null, state: 'ok' }],
        usage: null, model: null, modelID: null, providerID: null, latency: null, finish_reason: null,
      },
    ];
    const split = splitIntoTurns(interactions, 'session-tool-timing-degrade');
    const row = split.toolCalls[0];
    expect(row.durationMs).toBe(0);
    expect(row.startedAt).toBe('2026-10-20T04:00:00.000Z');
    expect(row.completedAt).toBe('2026-10-20T04:00:05.000Z');
  });
});
