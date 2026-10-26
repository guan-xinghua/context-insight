// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 自锚桥回归（真机 2.1.309 后台 Agent 现场）：claude 异步子代理终局以
// SubagentHandback 交付报告——工具名含 "subagent" 被包含式族误识为派发，
// 且其 resultJson 为空 → 走时间邻近回退 → 匹配到调用者自己的会话，产出
// 「派发端 = 子代理自身 turn」的自锚桥：时间线只把泳道挂主链根 turn，自锚
// 桥永不渲染，还以「有桥」抑制无桥兜底 → 子代理 turns 整组不可见（能搜到、
// 看不到）。两层防护：dispatch-tools 排除回传方向；bridge-builder 时间邻近
// 回退跳过调用者自己的会话。
import { describe, it, expect, beforeEach } from 'vitest';
import { buildBridges, resetIdCounter } from '../../src/lib/ingest/bridge-builder.ts';
import { splitIntoTurns, resetIdCounter as resetTurnIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { normalize } from '../../src/lib/ingest/normalize.ts';
import type { RawInteraction } from '../../src/lib/shared/types.ts';
import type { TurnRow, ToolCallRow } from '../../src/lib/ingest/turn-split.ts';

const T0 = 1791800000000;

function ts(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

const usage = { total: 300, input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.003, inputMessagesTokens: 200 };

// 后台 Agent 会话的最小形态：主链异步派发（回执无子会话 id）+ 子代理终局
// SubagentHandback（结果为空——回执在捕获截断/延迟场景下缺失）
function handbackInteractions(): RawInteraction[] {
  const main: RawInteraction[] = [
    {
      role: 'user', content: '跑个后台任务', timestamp: ts(0),
      timeInfo: { created: T0 }, agent: 'build', subagent_name: null,
      subagent_session_id: null, subagent_type: null, tool_calls: null, usage: null,
      model: 'glm-5.3', modelID: null, providerID: null, latency: null, finish_reason: null,
    },
    {
      role: 'assistant', content: '后台派发', timestamp: ts(1000),
      timeInfo: { created: T0 + 1000, completed: T0 + 2000 }, agent: 'build', subagent_name: null,
      subagent_session_id: null, subagent_type: null,
      tool_calls: [{
        toolCallId: 'call_agent_async_1', toolName: 'Agent',
        argsJson: JSON.stringify({ description: '后台任务', prompt: '执行后台任务' }),
        resultJson: 'Async agent launched successfully. agentId: a123.',
        state: 'ok',
      }],
      usage, model: 'glm-5.3', modelID: null, providerID: null, latency: 1000, finish_reason: 'tool-calls',
    },
  ];
  const sub: RawInteraction[] = [
    {
      role: 'subagent', content: '子代理工作中', timestamp: ts(5000),
      timeInfo: { created: T0 + 5000, completed: T0 + 8000 }, agent: null, subagent_name: null,
      subagent_session_id: 'ses_async_001', subagent_type: null, tool_calls: null, usage,
      model: 'glm-5.3', modelID: null, providerID: null, latency: 3000, finish_reason: 'stop',
    },
    {
      role: 'subagent', content: '交付报告', timestamp: ts(10_000),
      timeInfo: { created: T0 + 10_000, completed: T0 + 11_000 }, agent: null, subagent_name: null,
      subagent_session_id: 'ses_async_001', subagent_type: null,
      tool_calls: [{
        toolCallId: 'call_handback_1', toolName: 'SubagentHandback',
        argsJson: JSON.stringify({ message: '后台任务完成报告' }),
        resultJson: '',
        state: 'ok',
      }],
      usage, model: 'glm-5.3', modelID: null, providerID: null, latency: 1000, finish_reason: 'tool-calls',
    },
  ];
  return [...main, ...sub];
}

// 防护第二层（命名不在排除表内的派发族调用）：子代理在自己 turn 里发起
// 'subagent' 调用（结果未到）——时间邻近不得匹配回它自己的会话
function nestedNoResultInteractions(): RawInteraction[] {
  return [
    {
      role: 'subagent', content: '想委派但结果未回', timestamp: ts(0),
      timeInfo: { created: T0, completed: T0 + 1000 }, agent: null, subagent_name: null,
      subagent_session_id: 'ses_self_guard', subagent_type: null,
      tool_calls: [{
        toolCallId: 'call_nest_1', toolName: 'subagent',
        argsJson: JSON.stringify({ description: '嵌套尝试', prompt: '做点事' }),
        resultJson: '',
        state: 'ok',
      }],
      usage, model: 'glm-5.3', modelID: null, providerID: null, latency: 1000, finish_reason: 'tool-calls',
    },
    {
      role: 'subagent', content: '后续轮', timestamp: ts(5000),
      timeInfo: { created: T0 + 5000, completed: T0 + 8000 }, agent: null, subagent_name: null,
      subagent_session_id: 'ses_self_guard', subagent_type: null, tool_calls: null, usage,
      model: 'glm-5.3', modelID: null, providerID: null, latency: 3000, finish_reason: 'stop',
    },
  ];
}

function splitOf(interactions: RawInteraction[]): { turns: TurnRow[]; toolCalls: ToolCallRow[] } {
  const normalized = normalize(interactions, 'claude-jsonl');
  resetTurnIdCounter();
  resetIdCounter();
  const split = splitIntoTurns(normalized, 'ses_handback_it');
  return { turns: split.turns, toolCalls: split.toolCalls };
}

describe('bridge-builder：后台子代理回传不自锚', () => {
  let turns: TurnRow[];
  let toolCalls: ToolCallRow[];

  it('SubagentHandback 不产生桥（不误识为派发 → 无时间邻近自匹配）', () => {
    ({ turns, toolCalls } = splitOf(handbackInteractions()));
    const bridges = buildBridges(handbackInteractions(), toolCalls, turns, 'ses_handback_it', 'exec_root');
    // 主链 Agent 异步派发：回执有文本但无子会话 id → 失败派发跳过；
    // SubagentHandback 已被排除 → 全场无桥（子代理 turns 交由时间线兜底）
    expect(bridges).toHaveLength(0);
  });

  it('时间邻近回退跳过调用者自己的会话：嵌套无结果调用不自锚', () => {
    ({ turns, toolCalls } = splitOf(nestedNoResultInteractions()));
    const bridges = buildBridges(nestedNoResultInteractions(), toolCalls, turns, 'ses_handback_it', 'exec_root');
    // 结果未到 → 保留 dispatched 桥（sid null），绝不锚回 ses_self_guard
    const selfBridges = bridges.filter(b => b.subagentSessionId === 'ses_self_guard');
    expect(selfBridges).toHaveLength(0);
    expect(bridges.every(b => b.subagentSessionId === null)).toBe(true);
  });
});
