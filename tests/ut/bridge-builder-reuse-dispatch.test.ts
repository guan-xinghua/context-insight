// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 自定义派发工具（reuseDispatch 形态）的建桥回归锁：真机湖数据 ses_ecb797cb
// 的 102 个 `subagent` 派发全在旧白名单外 → bridge 全零、泳道问号。本用例锁：
//   1. subagent 工具被注册表识别，sessionID 直连 → 桥建立，名字/身份入位
//   2. 复用续跑（同 sessionID 二次派发）→ 两条桥（旧 usedSessionIds 只约束
//      时间邻近回退，不约束直连）
//   3. meta/标题全断（子会话交互零名字）时，桥名从派发参数直取
// 夹具形态取自湖往返件（args {agent, description, prompt, sessionID}；子会话
// 交互 subagent_name/agent 全 null——湖数据实况）。

import { describe, it, expect, beforeEach } from 'vitest';
import { buildBridges, resetIdCounter } from '../../src/lib/ingest/bridge-builder.ts';
import { splitIntoTurns, resetIdCounter as resetTurnIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { normalize } from '../../src/lib/ingest/normalize.ts';
import type { RawInteraction } from '../../src/lib/shared/types.ts';
import type { TurnRow, ToolCallRow } from '../../src/lib/ingest/turn-split.ts';

const T0 = 1791800000000; // 2026-10-12T08:53:20Z 附近

function ts(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

// 主会话：user → assistant(subagent 派发×2，同一 sessionID 复用) → user → assistant(subagent 派发，另一会话)
function reuseDispatchInteractions(): RawInteraction[] {
  const dispatch = (callId: string, args: Record<string, unknown>, result: string): RawInteraction['tool_calls'] => [{
    toolCallId: callId,
    toolName: 'subagent',
    argsJson: JSON.stringify(args),
    resultJson: result,
    state: 'ok',
  }];
  const main: RawInteraction[] = [
    {
      role: 'user', content: '开始 P1 流程', timestamp: ts(0),
      timeInfo: { created: T0 }, agent: 'build', subagent_name: null,
      subagent_session_id: null, subagent_type: null, tool_calls: null, usage: null,
      model: 'glm-5.3', modelID: null, providerID: null, latency: null, finish_reason: null,
    },
    {
      role: 'assistant', content: '先做需求分析', timestamp: ts(1000),
      timeInfo: { created: T0 + 1000, completed: T0 + 2000 }, agent: 'build', subagent_name: null,
      subagent_session_id: null, subagent_type: null,
      tool_calls: dispatch('call_sub_001', {
        agent: 'ascendc-ops-architect',
        description: 'P1 需求分析 confusion_mul_grad',
        prompt: '请分析 P1 需求……',
        sessionID: 'ses_reuse_001',
      }, '<subagent>需求分析完成，产出已落盘</subagent>'),
      usage: { total: 500, input: 400, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.005, inputMessagesTokens: 400 },
      model: 'glm-5.3', modelID: null, providerID: null, latency: 1000, finish_reason: 'tool-calls',
    },
    {
      role: 'user', content: '返工 r1', timestamp: ts(60_000),
      timeInfo: { created: T0 + 60_000 }, agent: 'build', subagent_name: null,
      subagent_session_id: null, subagent_type: null, tool_calls: null, usage: null,
      model: 'glm-5.3', modelID: null, providerID: null, latency: null, finish_reason: null,
    },
    {
      role: 'assistant', content: '复用同一子会话返工', timestamp: ts(61_000),
      timeInfo: { created: T0 + 61_000, completed: T0 + 62_000 }, agent: 'build', subagent_name: null,
      subagent_session_id: null, subagent_type: null,
      tool_calls: dispatch('call_sub_002', {
        agent: 'ascendc-ops-architect',
        description: 'P1 返工 r1 需求分析',
        prompt: '在你上一轮产物基线上修改……',
        sessionID: 'ses_reuse_001',   // 复用：同一子会话二次派发
      }, '<subagent>r1 修改完成</subagent>'),
      usage: { total: 500, input: 400, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.005, inputMessagesTokens: 400 },
      model: 'glm-5.3', modelID: null, providerID: null, latency: 1000, finish_reason: 'tool-calls',
    },
    {
      role: 'assistant', content: '另起审核', timestamp: ts(120_000),
      timeInfo: { created: T0 + 120_000, completed: T0 + 121_000 }, agent: 'build', subagent_name: null,
      subagent_session_id: null, subagent_type: null,
      tool_calls: dispatch('call_sub_003', {
        agent: 'design-step-reviewer',
        description: 'R门控 P1 需求分析审核',
        prompt: '审核 P1 产物……',
        sessionID: 'ses_reuse_002',
      }, '<subagent>审核通过</subagent>'),
      usage: { total: 500, input: 400, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.005, inputMessagesTokens: 400 },
      model: 'glm-5.3', modelID: null, providerID: null, latency: 1000, finish_reason: 'tool-calls',
    },
    {
      // 创建型派发（真机 71/102 形态）：args 无 sessionID，新会话 id 在结果
      // 协议文本里（后台型 (sessionID: …)）
      role: 'assistant', content: '后台派发汇总', timestamp: ts(180_000),
      timeInfo: { created: T0 + 180_000, completed: T0 + 181_000 }, agent: 'build', subagent_name: null,
      subagent_session_id: null, subagent_type: null,
      tool_calls: dispatch('call_sub_004', {
        agent: 'design-merger',
        description: '⑩ 合并产物',
        prompt: '合并各步骤产物……',
        background: true,
      }, '[{"type":"text","text":"The subagent is working in the background (sessionID: ses_reuse_003). You will be notified automatically when it finishes."}]'),
      usage: { total: 500, input: 400, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.005, inputMessagesTokens: 400 },
      model: 'glm-5.3', modelID: null, providerID: null, latency: 1000, finish_reason: 'tool-calls',
    },
  ];
  // 子会话交互：湖数据实况——名字/身份全 null（meta 断链），仅 subagent_session_id 打标
  const sub = (sid: string, offsetMs: number): RawInteraction[] => [
    {
      role: 'subagent', content: `${sid} 第一轮产出`, timestamp: ts(offsetMs),
      timeInfo: { created: T0 + offsetMs, completed: T0 + offsetMs + 3000 }, agent: null, subagent_name: null,
      subagent_session_id: sid, subagent_type: null, tool_calls: null,
      usage: { total: 300, input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.003, inputMessagesTokens: 200 },
      model: 'glm-5.3', modelID: null, providerID: null, latency: 3000, finish_reason: 'stop',
    },
    {
      role: 'subagent', content: `${sid} 第二轮产出`, timestamp: ts(offsetMs + 10_000),
      timeInfo: { created: T0 + offsetMs + 10_000, completed: T0 + offsetMs + 13_000 }, agent: null, subagent_name: null,
      subagent_session_id: sid, subagent_type: null, tool_calls: null,
      usage: { total: 300, input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.003, inputMessagesTokens: 200 },
      model: 'glm-5.3', modelID: null, providerID: null, latency: 3000, finish_reason: 'stop',
    },
  ];
  return [...main, ...sub('ses_reuse_001', 5000), ...sub('ses_reuse_002', 125_000), ...sub('ses_reuse_003', 185_000)];
}

describe('bridge-builder：reuseDispatch 自定义派发形态', () => {
  let turns: TurnRow[];
  let toolCalls: ToolCallRow[];

  beforeEach(() => {
    const normalized = normalize(reuseDispatchInteractions(), 'claude-jsonl');
    resetTurnIdCounter();
    resetIdCounter();
    const split = splitIntoTurns(normalized, 'ses_ecb797cb0ffe');
    turns = split.turns;
    toolCalls = split.toolCalls;
  });

  it('subagent 派发被识别：四条派发 → 四条桥，名字/身份从派发参数直取', () => {
    const bridges = buildBridges(reuseDispatchInteractions(), toolCalls, turns, 'ses_ecb797cb0ffe', 'exec_root');
    expect(bridges).toHaveLength(4);

    const rowOf = (wireId: string) => toolCalls.find(tc => tc.toolCallId === wireId)!;
    const first = bridges.find(b => b.dispatchToolCallId === rowOf('call_sub_001').id)!;
    expect(first).toBeDefined();
    expect(first.subagentSessionId).toBe('ses_reuse_001');       // sessionID 直连
    expect(first.subagentName).toBe('P1 需求分析 confusion_mul_grad');
    expect(first.subagentType).toBe('ascendc-ops-architect');
    expect(first.dispatchContent).toBe('P1 需求分析 confusion_mul_grad');
    expect(first.status).toBe('completed');
    expect(first.responseTurnId).not.toBeNull();                  // 锚到子会话末轮

    const review = bridges.find(b => b.dispatchToolCallId === rowOf('call_sub_003').id)!;
    expect(review.subagentSessionId).toBe('ses_reuse_002');
    expect(review.subagentName).toBe('R门控 P1 需求分析审核');
    expect(review.subagentType).toBe('design-step-reviewer');

    // 创建型：无参数直连，结果协议 (sessionID: …) 提取
    const created = bridges.find(b => b.dispatchToolCallId === rowOf('call_sub_004').id)!;
    expect(created.subagentSessionId).toBe('ses_reuse_003');
    expect(created.subagentName).toBe('⑩ 合并产物');
    expect(created.subagentType).toBe('design-merger');
  });

  it('复用续跑：同一 sessionID 的二次派发也建桥（直连不受 usedSessionIds 约束）', () => {
    const bridges = buildBridges(reuseDispatchInteractions(), toolCalls, turns, 'ses_ecb797cb0ffe', 'exec_root');
    const rowOf = (wireId: string) => toolCalls.find(tc => tc.toolCallId === wireId)!;
    const reuse = bridges.find(b => b.dispatchToolCallId === rowOf('call_sub_002').id)!;
    expect(reuse).toBeDefined();
    expect(reuse.subagentSessionId).toBe('ses_reuse_001');
    expect(reuse.subagentName).toBe('P1 返工 r1 需求分析');
    // 同一子会话的两条桥都锚定同一 subagentSessionId
    const toSame = bridges.filter(b => b.subagentSessionId === 'ses_reuse_001');
    expect(toSame).toHaveLength(2);
  });

  it('meta/标题全断时桥名仍就位（名字不依赖 lastTurn 回退）', () => {
    const bridges = buildBridges(reuseDispatchInteractions(), toolCalls, turns, 'ses_ecb797cb0ffe', 'exec_root');
    // 子会话交互全 null 名字——桥名必须来自派发参数本身
    for (const b of bridges) {
      expect(b.subagentName).not.toBeNull();
      expect(b.subagentType).not.toBeNull();
    }
  });
});
