// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 同子代理会话复用（首发 + 返工重入）的派发窗配对 IT。现场 ses_ecb797cb：
// turn10 派发「P1 需求分析」17:12 → 17:24 完成；turn19 派发「P1 返工 r1」
// 17:33（复用同一会话）。旧 subagentTiming 取会话全局 max(end) → 两条桥的
// response 都锚到会话最后一条 turn（17:40）→ 泳道/turns 页两窗互相包含，
// 读成「没执行完就返工」。修复后每次派发只认自己窗口 [dispatch_i,
// dispatch_{i+1}) 内的 turn：首发 response=首发段末，返工 response=返工段末。
import { describe, it, expect, beforeAll } from 'vitest';
import { buildBridges, resetIdCounter } from '../../src/lib/ingest/bridge-builder.ts';
import { splitIntoTurns, resetIdCounter as resetTurnIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { normalize } from '../../src/lib/ingest/normalize.ts';
import type { RawInteraction } from '../../src/lib/shared/types.ts';
import type { InteractionBridgeRow } from '../../src/lib/ingest/bridge-builder.ts';

const SUB_REUSE = 'ses-reuse-p1';
const T0 = 1772275201000; // 2026-03-01T00:00:01Z，与同族用例同基
const REWORK_AT = T0 + 1_200_000; // 20 分钟后返工

function mainAt(createdMs: number, toolCalls: RawInteraction['tool_calls']): RawInteraction {
  return {
    role: 'user',
    content: '编排。',
    timestamp: new Date(createdMs).toISOString(),
    timeInfo: { created: createdMs },
    agent: 'build',
    subagent_name: null,
    subagent_session_id: null,
    subagent_type: null,
    tool_calls: toolCalls,
    usage: { total: 500, input: 400, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.005, inputMessagesTokens: 400 },
    model: 'glm-5.2',
    modelID: null,
    providerID: null,
    latency: 1000,
    finish_reason: 'tool-calls',
  };
}

function subAt(createdMs: number, sid: string, tokens: number): RawInteraction {
  return {
    role: 'subagent',
    content: '阶段产物。',
    timestamp: new Date(createdMs).toISOString(),
    timeInfo: { created: createdMs, completed: createdMs + 3000 },
    agent: null,
    subagent_name: null,
    subagent_session_id: sid,
    subagent_type: null,
    tool_calls: null,
    usage: { total: tokens, input: 100, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.002, inputMessagesTokens: 100 },
    model: 'glm-5.2',
    modelID: null,
    providerID: null,
    latency: 3000,
    finish_reason: 'stop',
  };
}

let bridges: InteractionBridgeRow[];

beforeAll(() => {
  resetIdCounter();
  resetTurnIdCounter();
  const interactions: RawInteraction[] = [
    // 首发派发（17:12 等价时刻）
    mainAt(T0, [{
      toolCallId: 'call-first', toolName: 'task',
      argsJson: JSON.stringify({ subagent_type: 'acme-ops-architect', description: 'P1 需求分析', prompt: '执行需求分析。' }),
      resultJson: 'task_id: ' + SUB_REUSE, state: 'completed',
    }]),
    // 返工派发（+20min，复用同一会话）
    mainAt(REWORK_AT, [{
      toolCallId: 'call-rework', toolName: 'task',
      argsJson: JSON.stringify({ subagent_type: 'acme-ops-architect', description: 'P1 返工 r1', prompt: '按审核意见返工。' }),
      resultJson: 'task_id: ' + SUB_REUSE, state: 'completed',
    }]),
    // 子代理会话两段 turn：首发段 2 条（T0+10s / T0+10min），返工段 2 条（+20min10s / +25min）
    subAt(T0 + 10_000, SUB_REUSE, 200),
    subAt(T0 + 600_000, SUB_REUSE, 300),
    subAt(REWORK_AT + 10_000, SUB_REUSE, 150),
    subAt(REWORK_AT + 300_000, SUB_REUSE, 250),
  ];
  const normalized = normalize(interactions, 'opencode-db');
  const split = splitIntoTurns(normalized, 'session-reuse-window');
  bridges = buildBridges(normalized, split.toolCalls, split.turns, 'session-reuse-window', 'root-exec-r');
});

describe('bridge-builder: 复用会话的派发窗配对', () => {
  it('两条桥各自锚定自己窗口的完成（首发 response 早于返工 dispatch，不再互相包含）', () => {
    expect(bridges).toHaveLength(2);
    const first = bridges.find(b => b.dispatchContent === 'P1 需求分析')!;
    const rework = bridges.find(b => b.dispatchContent === 'P1 返工 r1')!;
    expect(first).toBeDefined();
    expect(rework).toBeDefined();

    const firstResp = new Date(first.responseTimestamp!).getTime();
    const reworkDisp = new Date(rework.dispatchTimestamp!).getTime();
    expect(firstResp).toBe(T0 + 603_000); // 首发段末条 turn 的完成时刻
    expect(firstResp).toBeLessThan(reworkDisp); // 串行：完成在前，返工在后
    expect(new Date(rework.responseTimestamp!).getTime()).toBe(REWORK_AT + 303_000); // 返工段末条
  });

  it('空窗回退不吞下窗：后台「先派发、turn 后到」时首发桥宁空勿污', () => {
    resetIdCounter();
    resetTurnIdCounter();
    // P1 t0 派发、返工 t1 派发，子会话 turn 全部晚于 t1——P1 窗口 [t0,t1) 为空
    const interactions: RawInteraction[] = [
      mainAt(T0, [{
        toolCallId: 'call-empty-a', toolName: 'task',
        argsJson: JSON.stringify({ subagent_type: 'acme-ops-architect', description: 'P1 空窗首发' }),
        resultJson: 'task_id: ' + SUB_REUSE, state: 'completed',
      }]),
      mainAt(REWORK_AT, [{
        toolCallId: 'call-empty-b', toolName: 'task',
        argsJson: JSON.stringify({ subagent_type: 'acme-ops-architect', description: 'P1 空窗返工' }),
        resultJson: 'task_id: ' + SUB_REUSE, state: 'completed',
      }]),
      subAt(REWORK_AT + 60_000, SUB_REUSE, 300),
      subAt(REWORK_AT + 120_000, SUB_REUSE, 400),
    ];
    const normalized = normalize(interactions, 'opencode-db');
    const split = splitIntoTurns(normalized, 'session-empty-window');
    const bs = buildBridges(normalized, split.toolCalls, split.turns, 'session-empty-window', 'root-exec-e');

    const first = bs.find(b => b.dispatchContent === 'P1 空窗首发')!;
    const rework = bs.find(b => b.dispatchContent === 'P1 空窗返工')!;
    expect(first).toBeDefined();
    expect(rework).toBeDefined();
    // 旧回退（吞 ≥t0 尾巴）会让首发桥吃掉返工段 700 token
    expect(first.subagentTokens).toBe(0);
    expect(rework.subagentTokens).toBe(700);
  });

  it('responseTurnId / tokens 按窗口拆分（两桥不再共用会话末条）', () => {
    const first = bridges.find(b => b.dispatchContent === 'P1 需求分析')!;
    const rework = bridges.find(b => b.dispatchContent === 'P1 返工 r1')!;
    expect(first.responseTurnId).not.toBe(rework.responseTurnId);
    expect(first.subagentTokens).toBe(500); // 200 + 300
    expect(rework.subagentTokens).toBe(400); // 150 + 250
  });
});

// meta 直连形态（claude proxy Agent）下 meta 映射值 ≠ resultSessionId：
// 派发时刻表必须按与 matchedSessionId 同序的三段解析预键，否则查空时刻表
// → 复用窗口退化无界、两窗重新互相包含（PR #126 审查意见）
describe('bridge-builder: meta 直连 ≠ result 会话 id 的窗口配对', () => {
  it('meta 映射优先时，时刻表按 meta 值键控，首发/返工窗口仍正确拆分', () => {
    resetIdCounter();
    resetTurnIdCounter();
    const interactions: RawInteraction[] = [
      mainAt(T0, [{
        toolCallId: 'call-meta-1', toolName: 'Agent',
        argsJson: JSON.stringify({ description: 'P1 meta 首发', prompt: '执行。' }),
        resultJson: 'task_id: ses-other-1', state: 'completed',
      }]),
      mainAt(REWORK_AT, [{
        toolCallId: 'call-meta-2', toolName: 'Agent',
        argsJson: JSON.stringify({ description: 'P1 meta 返工', prompt: '返工。' }),
        resultJson: 'task_id: ses-other-2', state: 'completed',
      }]),
      // 子代理 turn 挂在 meta 指向的 sub-meta（与 result 的 ses-other-* 不同）
      subAt(T0 + 10_000, 'sub-meta', 200),
      subAt(T0 + 600_000, 'sub-meta', 300),
      subAt(REWORK_AT + 10_000, 'sub-meta', 150),
      subAt(REWORK_AT + 300_000, 'sub-meta', 250),
    ];
    const normalized = normalize(interactions, 'opencode-db');
    const split = splitIntoTurns(normalized, 'session-meta-window');
    const toolUseIdToSubagentSessionId = new Map([
      ['call-meta-1', 'sub-meta'],
      ['call-meta-2', 'sub-meta'],
    ]);
    const bs = buildBridges(normalized, split.toolCalls, split.turns, 'session-meta-window', 'root-exec-m', toolUseIdToSubagentSessionId);

    const first = bs.find(b => b.dispatchContent === 'P1 meta 首发')!;
    const rework = bs.find(b => b.dispatchContent === 'P1 meta 返工')!;
    expect(first).toBeDefined();
    expect(rework).toBeDefined();
    expect(first.subagentSessionId).toBe('sub-meta'); // meta 优先于 result
    // 窗口拆分成立：首发 response 锚自己窗口末条，早于返工派发
    const firstResp = new Date(first.responseTimestamp!).getTime();
    expect(firstResp).toBe(T0 + 603_000);
    expect(firstResp).toBeLessThan(new Date(rework.dispatchTimestamp!).getTime());
    expect(new Date(rework.responseTimestamp!).getTime()).toBe(REWORK_AT + 303_000);
    expect(first.subagentTokens).toBe(500);
    expect(rework.subagentTokens).toBe(400);
  });
});
