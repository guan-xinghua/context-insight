// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 子代理块派发正序 IT：源侧发现序与派发序相反时（opencode 双表 union /
// 目录序实测为建会话倒序），并入主流后块序 = 块内最早交互时刻升序——
// 全局 turnIndex 符合「先派发先编号」。块内序列不动（上下文内位次是
// 合并/刷新的稳定身份键）；异步（先派发后开跑）按实际开跑序；无时间戳
// 块排尾部稳定兜底。
import { describe, it, expect } from 'vitest';
import { appendSubagentBlocksOrdered } from '../../src/lib/ingest/data-service.ts';
import { splitIntoTurns, resetIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { normalize } from '../../src/lib/ingest/normalize.ts';
import type { RawInteraction } from '../../src/lib/shared/types.ts';

const T0 = 1772275201000; // 2026-03-01T00:00:01Z

function mainAt(createdMs: number): RawInteraction {
  return {
    role: 'user', content: '编排。', timestamp: new Date(createdMs).toISOString(),
    timeInfo: { created: createdMs }, agent: 'build',
    subagent_name: null, subagent_session_id: null, subagent_type: null, tool_calls: null,
    usage: { total: 100, input: 80, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001, inputMessagesTokens: 80 },
    model: 'glm-5.2', modelID: null, providerID: null, latency: 500, finish_reason: 'stop',
  };
}

function subAt(createdMs: number, sid: string): RawInteraction {
  return {
    role: 'subagent', content: `产物 ${sid}。`, timestamp: new Date(createdMs).toISOString(),
    timeInfo: { created: createdMs, completed: createdMs + 3000 }, agent: null,
    subagent_name: null, subagent_session_id: sid, subagent_type: null, tool_calls: null,
    usage: { total: 200, input: 100, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.002, inputMessagesTokens: 100 },
    model: 'glm-5.2', modelID: null, providerID: null, latency: 3000, finish_reason: 'stop',
  };
}

function turnOrderOf(interactions: RawInteraction[], sessionId: string) {
  const normalized = normalize(interactions, 'opencode-db');
  resetIdCounter();
  const { turns } = splitIntoTurns(normalized, sessionId);
  return turns.map(t => ({ sid: t.subagentSessionId ?? 'MAIN', ts: t.createdAt_ts }));
}

describe('appendSubagentBlocksOrdered：子代理块派发正序', () => {
  it('发现序倒挂 → 并入后按最早交互时刻升序（先派发先编号）', () => {
    const main = [mainAt(T0), mainAt(T0 + 60_000)];
    // 发现序：晚派发的 sub-late 在前（复现现场倒序），早派发的 sub-early 在后
    const subInteractions = [
      subAt(T0 + 30_000, 'sub-late'), subAt(T0 + 35_000, 'sub-late'),
      subAt(T0 + 10_000, 'sub-early'), subAt(T0 + 15_000, 'sub-early'),
    ];
    const all = [...main];
    appendSubagentBlocksOrdered(all, subInteractions);
    const order = turnOrderOf(all, 'session-block-order');
    const sids = order.map(o => o.sid);
    // 主时间线最前，子代理块按首条时刻升序
    expect(sids).toEqual(['MAIN', 'MAIN', 'sub-early', 'sub-early', 'sub-late', 'sub-late']);
    // 编号与时间同向：早块的全局序先于晚块
    const earlyFirst = order.findIndex(o => o.sid === 'sub-early');
    const lateFirst = order.findIndex(o => o.sid === 'sub-late');
    expect(earlyFirst).toBeLessThan(lateFirst);
  });

  it('块内序列不动（上下文内位次 = 合并/刷新稳定身份键）', () => {
    const block = [subAt(T0 + 10_000, 'sub-a'), subAt(T0 + 50_000, 'sub-a'), subAt(T0 + 20_000, 'sub-b')];
    const all: RawInteraction[] = [];
    appendSubagentBlocksOrdered(all, block);
    const aTs = all.filter(r => r.subagent_session_id === 'sub-a').map(r => r.timeInfo!.created);
    expect(aTs).toEqual([T0 + 10_000, T0 + 50_000]); // 块内保持源序，不按时间重排
  });

  it('异步形态：先派发后开跑的子代理按实际开跑时刻排（确定性，不与主时间线耦合）', () => {
    // dispatch(A)@T0 → dispatch(B)@T0+5s（异步立即开跑）→ A 实际 @T0+20s 才开跑
    const subInteractions = [
      subAt(T0 + 20_000, 'sub-a-slow-start'),   // 先派发、后开跑
      subAt(T0 + 5_000, 'sub-b-quick-start'),   // 后派发、先开跑
    ];
    const all: RawInteraction[] = [];
    appendSubagentBlocksOrdered(all, subInteractions);
    expect(all.map(r => r.subagent_session_id)).toEqual(['sub-b-quick-start', 'sub-a-slow-start']);
  });

  it('无时间戳块排尾部（稳定排序保发现序）', () => {
    const noTs = { ...subAt(0, 'sub-nots'), timeInfo: null as unknown as undefined };
    const subInteractions = [
      { ...noTs, subagent_session_id: 'sub-nots' },
      subAt(T0 + 5_000, 'sub-ts'),
    ];
    const all: RawInteraction[] = [];
    appendSubagentBlocksOrdered(all, subInteractions as RawInteraction[]);
    expect(all.map(r => r.subagent_session_id)).toEqual(['sub-ts', 'sub-nots']);
  });
});
