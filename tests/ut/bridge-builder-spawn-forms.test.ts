// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// bridge-builder spawn 双形态 IT（0.162 真机 wire，dumpC 全量核实）：
// 模型从工具错误中学习——先试 message+items 双参（被拒）、再试
// reasoning_effort（被拒），最终 fork_context+items 一次成功。两个读侧
// 缺陷（真机 10 次 spawn 产出 10 条桥：4 条误锚 + 2 条 0-turn 幽灵 lane）：
//   ①parseTaskArgs 只认 message → items 形态成功派发的桥 dispatchContent
//     恒空，内容锚定失效退化为时间邻近（曾把失败重试误锚到无关子代理）
//   ②失败派发也建桥 → 子代理从未存在却占 lane（结果非空但无任何子会话
//     id = 工具以错误文本作答；wire 上 codex function_call_output 无
//     is_error 标志，state=completed 不能作判据）
import { describe, it, expect, beforeAll } from 'vitest';
import { buildBridges, resetIdCounter } from '../../src/lib/ingest/bridge-builder.ts';
import { splitIntoTurns, resetIdCounter as resetTurnIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { normalize } from '../../src/lib/ingest/normalize.ts';
import type { RawInteraction } from '../../src/lib/shared/types.ts';
import type { InteractionBridgeRow } from '../../src/lib/ingest/bridge-builder.ts';

const TASK_ARCH = '你是审计项目的「架构分析员」，负责阶段一架构分析。工作目录：/workspace/demo。';
const TASK_REVIEW = '你是审计项目的「复核员」，负责阶段五交叉复核。工作目录：/workspace/demo。';
const AGENT_ID_ARCH = '01aa-bb01-arch';
const AGENT_ID_REVIEW = '01aa-bb02-review';

function spawnToolCall(toolCallId: string, args: Record<string, unknown>, resultJson: string | null) {
  return { toolCallId, toolName: 'spawn_agent', argsJson: JSON.stringify(args), resultJson, state: 'completed' };
}

function mainInteraction(toolCalls: RawInteraction['tool_calls']): RawInteraction {
  return {
    role: 'user',
    content: '请派发子代理完成分析。',
    timestamp: '2026-01-01T00:00:01.000Z',
    timeInfo: { created: 1735689601000 },
    agent: 'build',
    subagent_name: null,
    subagent_session_id: null,
    subagent_type: null,
    tool_calls: toolCalls,
    usage: { total: 500, input: 400, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.005, inputMessagesTokens: 400 },
    model: 'deepseek-v4-pro',
    modelID: null,
    providerID: null,
    latency: 1000,
    finish_reason: 'tool-calls',
  };
}

function subagentInteraction(sid: string, name: string, createdMs: number): RawInteraction {
  return {
    role: 'subagent',
    content: name + ' 完成任务，产出报告。',
    timestamp: new Date(createdMs).toISOString(),
    timeInfo: { created: createdMs, completed: createdMs + 3000 },
    agent: name,
    subagent_name: name,
    subagent_session_id: sid,
    subagent_type: null,
    tool_calls: null,
    usage: { total: 200, input: 100, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.002, inputMessagesTokens: 100 },
    model: 'deepseek-v4-pro',
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
  // 真机 0.162 失败重试链形状：双参失败 → reasoning 失败 ×2 → message 成功
  // （0.161 回归）→ items 成功 → 结果未到（running）
  const interactions: RawInteraction[] = [
    mainInteraction([
      spawnToolCall('call-fail-1', { message: TASK_ARCH, items: [{ type: 'text', text: TASK_ARCH }], fork_context: 'root' }, 'Provide either message or items, but not both'),
      spawnToolCall('call-fail-2', { items: [{ type: 'text', text: TASK_REVIEW }], fork_context: 'root', reasoning_effort: 'high' }, 'Reasoning effort `high` is not supported for model `deepseek-v4-pro`'),
      spawnToolCall('call-fail-3', { items: [{ type: 'text', text: TASK_ARCH }], fork_context: 'root', reasoning_effort: 'high' }, 'Reasoning effort `high` is not supported for model `deepseek-v4-pro`'),
      spawnToolCall('call-ok-1', { message: TASK_ARCH, fork_context: 'root' }, `{"agent_id":"${AGENT_ID_ARCH}","nickname":"Raman"}`),
      spawnToolCall('call-ok-2', { items: [{ type: 'text', text: TASK_REVIEW }], fork_context: 'root' }, `{"agent_id":"${AGENT_ID_REVIEW}","nickname":"Aristotle"}`),
    ]),
    subagentInteraction(AGENT_ID_ARCH, 'Raman', 1735689602000),
    subagentInteraction(AGENT_ID_REVIEW, 'Aristotle', 1735689603000),
    // running 用例用「当前时刻 - 1 分钟」——dispatched/timeout 的分界是
    // 距 now 的 30 分钟阈值，固定旧时间戳会落入 timeout
    mainInteraction([spawnToolCall('call-run-1', { items: [{ type: 'text', text: '你是资料整理员。' }], fork_context: 'root' }, null)]),
  ].map((it, i) => (i === 3 ? { ...it, timestamp: new Date(Date.now() - 60_000).toISOString(), timeInfo: { created: Date.now() - 60_000 } } : it));
  const normalized = normalize(interactions, 'opencode-db');
  const splitResult = splitIntoTurns(normalized, 'session-spawn-forms');
  bridges = buildBridges(normalized, splitResult.toolCalls, splitResult.turns, 'session-spawn-forms', 'root-exec-001');
});

describe('bridge-builder: spawn 双形态与失败派发（0.162 真机链）', () => {
  it('失败派发不建桥：双参错误 ×1 + reasoning 错误 ×2 共 3 条失败尝试全部跳过（无幽灵 lane）', () => {
    expect(bridges).toHaveLength(3); // 2 成功 + 1 running，失败全跳
  });

  it('失败派发不进时间邻近回退：不会被误锚到任何子代理', () => {
    const anchored = bridges.map((b) => b.subagentSessionId);
    // 只有成功与 running 的桥，失败尝试既无桥也无误锚
    expect(anchored.filter(Boolean)).toHaveLength(2);
  });

  it('message 形态成功（0.161 回归）：dispatchContent 取 message，nickname 从输出带出', () => {
    const b = bridges.find((x) => x.subagentSessionId === AGENT_ID_ARCH);
    expect(b).toBeDefined();
    expect(b!.dispatchContent).toBe(TASK_ARCH);
    expect(b!.subagentName).toBe('Raman');
    expect(b!.status).toBe('completed');
  });

  it('items 形态成功（0.162）：dispatchContent 从 items 纯文本项提取，不再恒空', () => {
    const b = bridges.find((x) => x.subagentSessionId === AGENT_ID_REVIEW);
    expect(b).toBeDefined();
    expect(b!.dispatchContent).toBe(TASK_REVIEW);
    expect(b!.subagentName).toBe('Aristotle');
  });

  it('结果未到（running）：保留 dispatched 桥——live 导入语义不回归', () => {
    const running = bridges.filter((b) => b.subagentSessionId === null);
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe('dispatched');
    expect(running[0].dispatchContent).toBe('你是资料整理员。');
  });
});
