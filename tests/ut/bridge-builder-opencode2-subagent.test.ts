// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 2.x 原生派发方言 IT（1.x 是 task，2.x 换成 subagent 工具；现场：
// ses_ecb797cb BN3DTrainingUpdateGrad 设计流水线 102 次派发全盲——0 桥 +
// 0 dispatch SkillEvent + subagentName null，Perf SUBAGENT 全 unknown）。
// 方言三特征：工具名 subagent、类型字段叫 agent（非 subagent_type）、
// result 嵌 <subagent sessionID="..." state="..."> 文本协议。锁三层：
// ①bridge（subagentType=agent 值 / dispatchContent=description / sessionID
// result 锚定）②dispatch SkillEvent（skillName=agent 值）③与 1.x task
// 方言共存不互扰。
import { describe, it, expect, beforeAll } from 'vitest';
import { buildBridges, resetIdCounter } from '../../src/lib/ingest/bridge-builder.ts';
import { splitIntoTurns, resetIdCounter as resetTurnIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { normalize } from '../../src/lib/ingest/normalize.ts';
import type { RawInteraction } from '../../src/lib/shared/types.ts';
import type { InteractionBridgeRow } from '../../src/lib/ingest/bridge-builder.ts';

const SUB2_ID = 'ses_opencode2-sub-target';
const SUB1_ID = 'ses_opencode1-task-target';
const SUB2_BG_ID = 'ses_opencode2-bg-target';
const SUB118_ID = 'ses_opencode118-task-target';
const RESULT_2X = JSON.stringify([{ type: 'text', text: '<subagent sessionID="' + SUB2_ID + '" state="completed">\nP1 审核完成，报告已写入 reviews/P1_review.md。\n' }]);

function dispatchToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>, resultJson: string | null) {
  return { toolCallId, toolName, argsJson: JSON.stringify(args), resultJson, state: 'completed' };
}

function mainInteraction(toolCalls: RawInteraction['tool_calls']): RawInteraction {
  return {
    role: 'user',
    content: '执行设计流水线预备阶段。',
    timestamp: '2026-03-01T00:00:01.000Z',
    timeInfo: { created: 1772275201000 },
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

function subagentInteraction(sid: string, createdMs: number): RawInteraction {
  return {
    role: 'subagent',
    content: '子代理完成任务，产出报告。',
    timestamp: new Date(createdMs).toISOString(),
    timeInfo: { created: createdMs, completed: createdMs + 3000 },
    agent: null,
    // 原生 opencode 2.x：title 不带 @(...) 标记 → subagent_name 落 null
    //（Perf unknown 的另一半根因；步骤由桥 dispatchContent 补）
    subagent_name: null,
    subagent_session_id: sid,
    subagent_type: null,
    tool_calls: null,
    usage: { total: 200, input: 100, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.002, inputMessagesTokens: 100 },
    model: 'glm-5.2',
    modelID: null,
    providerID: null,
    latency: 3000,
    finish_reason: 'stop',
  };
}

let bridges: InteractionBridgeRow[];
let skillEvents: ReturnType<typeof splitIntoTurns>['skillEvents'];

beforeAll(() => {
  resetIdCounter();
  resetTurnIdCounter();
  const interactions: RawInteraction[] = [
    mainInteraction([
      // 2.x 方言：类型在 args.agent，步骤在 args.description
      dispatchToolCall('call-2x-1', 'subagent',
        { agent: 'design-step-reviewer', description: 'P1 门控审核', prompt: '对设计流水线预备阶段 P1 产物执行独立对抗审核。' },
        RESULT_2X),
      // 1.x 方言共存：task + subagent_type（回归：不被 2.x 分支互扰）
      dispatchToolCall('call-1x-1', 'task',
        { subagent_type: 'acme-ops-architect', description: 'P1 需求分析', prompt: '执行需求分析任务。' },
        'task_id: ' + SUB1_ID),
      // 2.x 后台异步形态：sessionID 在括号文本里（现场 83/102 次派发走此
      // 形态，提不出 id 曾被失败派发守卫误杀——0 桥）
      dispatchToolCall('call-2x-bg-1', 'subagent',
        { agent: 'design-kernel-coder', description: '⑨ group kernel(返工r1)', prompt: '执行设计流水线第 ⑨ 步。' },
        JSON.stringify([{ type: 'text', text: 'The subagent is working in the background (sessionID: ' + SUB2_BG_ID + '). You will be notified automatically when it finishes.\nDO NOT sleep, poll for progress.' }])),
      // 1.18 task 方言：XML 标签字段叫 id（非 sessionID/task_id）
      dispatchToolCall('call-118-1', 'task',
        { subagent_type: 'acme-ops-architect', description: 'P1 需求分析', prompt: '执行需求分析任务。' },
        JSON.stringify([{ type: 'text', text: '<task id="' + SUB118_ID + '" state="completed">\n<task_result>\n需求分析完成，产物已落盘。\n</task_result>\n</task>' }])),
    ]),
    subagentInteraction(SUB2_ID, 1772275202000),
    subagentInteraction(SUB1_ID, 1772275203000),
    subagentInteraction(SUB2_BG_ID, 1772275204000),
    // opencode 1.18 task 方言：result 是 <task id="..." state="completed">
    subagentInteraction(SUB118_ID, 1772275205000),
  ];
  const normalized = normalize(interactions, 'opencode-db');
  const splitResult = splitIntoTurns(normalized, 'session-oc2-subagent');
  bridges = buildBridges(normalized, splitResult.toolCalls, splitResult.turns, 'session-oc2-subagent', 'root-exec-001');
  skillEvents = splitResult.skillEvents;
});

describe('turn-split：args.agent 结构化值守卫', () => {
  it('agent 键为对象时不炸、skillName 恒为字符串', () => {
    resetIdCounter();
    resetTurnIdCounter();
    const interactions: RawInteraction[] = [
      mainInteraction([
        dispatchToolCall('call-obj-agent', 'subagent',
          { agent: { name: 'ops', model: 'x' }, description: '结构化 agent 值', prompt: '执行任务。' },
          JSON.stringify([{ type: 'text', text: '<subagent sessionID="ses-obj-agent" state="completed">\n完成\n' }])),
      ]),
      subagentInteraction('ses-obj-agent', 1772275202000),
    ];
    const normalized = normalize(interactions, 'opencode-db');
    const split = splitIntoTurns(normalized, 'session-obj-agent');
    const bs = buildBridges(normalized, split.toolCalls, split.turns, 'session-obj-agent', 'root-obj');
    expect(bs).toHaveLength(1);
    for (const ev of split.skillEvents) {
      expect(typeof ev.skillName).toBe('string');
    }
  });
});

describe('bridge-builder: opencode 2.x subagent 派发方言', () => {
  it('识别为派发并从 result <subagent sessionID=...> 精确锚定子会话', () => {
    expect(bridges).toHaveLength(4);
    const b = bridges.find(x => x.subagentSessionId === SUB2_ID);
    expect(b).toBeDefined();
    expect(b!.status).toBe('completed');
  });

  it('subagentType 取 args.agent（非 subagent_type），dispatchStep 源 dispatchContent 取 args.description', () => {
    const b = bridges.find(x => x.subagentSessionId === SUB2_ID)!;
    expect(b!.subagentType).toBe('design-step-reviewer');
    expect(b!.dispatchContent).toBe('P1 门控审核');
  });

  it('dispatch SkillEvent：skillName 取 args.agent 值', () => {
    const ev = skillEvents.find(e => e.skillName === 'design-step-reviewer');
    expect(ev).toBeDefined();
    expect(ev!.eventType).toBe('dispatch');
    expect(ev!.success).toBe(true);
  });

  it('后台异步形态：括号文本 (sessionID: ...) 同样锚定（现场 83/102 派发走此形态）', () => {
    const b = bridges.find(x => x.subagentSessionId === SUB2_BG_ID)!;
    expect(b).toBeDefined();
    expect(b!.subagentType).toBe('design-kernel-coder');
    expect(b!.dispatchContent).toBe('⑨ group kernel(返工r1)');
  });

  it('1.18 task 方言：<task id="..."> 锚定（现场 92/94 派发此形态曾全跳）', () => {
    const b = bridges.find(x => x.subagentSessionId === SUB118_ID)!;
    expect(b).toBeDefined();
    expect(b!.subagentType).toBe('acme-ops-architect');
    expect(b!.dispatchContent).toBe('P1 需求分析');
  });

  it('1.x task 方言共存不互扰（subagent_type 优先级不变）', () => {
    const b = bridges.find(x => x.subagentSessionId === SUB1_ID)!;
    expect(b!.subagentType).toBe('acme-ops-architect');
    expect(b!.dispatchContent).toBe('P1 需求分析');
    expect(skillEvents.some(e => e.skillName === 'acme-ops-architect')).toBe(true);
  });
});
