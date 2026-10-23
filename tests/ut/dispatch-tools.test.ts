// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 派发工具注册表（dispatch-tools）单测：spec 匹配矩阵、参数键解析（含大小写
// 归一——reuseDispatch 插件的 sessionID 驼峰键）、结果侧提取器三形态、
// Turn 名字回填语义（??= / 首派发优先 / 无直连不回填）。
// 夹具数据形态取自真机湖数据（ses_ecb797cb：102 个 subagent 派发，
// args {agent, description, prompt, sessionID}）与 opencode 内置 task
// 派发（args {description, subagent_type, prompt, subagent_session_id, ...}）。

import { describe, it, expect } from 'vitest';
import {
  dispatchSpecOf,
  resolveDispatchToolCall,
  backfillTurnNamesFromDispatches,
} from '../../src/lib/ingest/dispatch-tools.ts';
import type { ToolCallRow, TurnRow } from '../../src/lib/ingest/turn-split.ts';

function tc(toolName: string, args: Record<string, unknown> | null, resultJson: string | null = null): ToolCallRow {
  return {
    id: `tcrow_${Math.random().toString(36).slice(2, 8)}`,
    turnId: 'turn_main_1',
    toolCallId: `call_${Math.random().toString(36).slice(2, 10)}`,
    toolName,
    argsJson: args === null ? null : JSON.stringify(args),
    resultJson,
    state: 'ok',
    errorType: null,
    errorMessage: null,
    startedAt: '2026-10-12T08:00:00.000Z',
    completedAt: '2026-10-12T08:05:00.000Z',
    durationMs: 300000,
    dispatchBridgeId: null,
    isSkillRelated: false,
  };
}

function subTurn(subagentSessionId: string, opts: { subagentName?: string | null; agentName?: string | null } = {}): TurnRow {
  return {
    id: `t_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'ses_main',
    turnIndex: 0,
    role: 'assistant',
    content: 'subagent answer',
    contentJson: null,
    contentSummary: null,
    inputMessagesJson: null,
    inputMessagesCount: 0,
    inputMessagesTokens: 0,
    contextWindowPct: null,
    agentName: opts.agentName ?? null,
    subagentName: opts.subagentName ?? null,
    subagentSessionId,
    subagentType: null,
    totalTokens: 100,
    inputTokens: 80,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    createdAt_ts: '2026-10-12T08:00:10.000Z',
    completedAt: '2026-10-12T08:01:00.000Z',
    latencyMs: 1000,
    ttftMs: null,
    model: null,
    modelId: null,
    providerId: null,
    temperature: null,
    maxTokens: null,
    finishReason: 'stop',
    isSubagent: true,
    parentExecutionId: null,
  };
}

describe('dispatchSpecOf：工具名匹配矩阵', () => {
  it('精确名（小写归一）：task / Agent 大小写不敏感 / spawn_agent', () => {
    expect(dispatchSpecOf('task')?.names).toContain('task');
    expect(dispatchSpecOf('Agent')?.names).toContain('agent');
    expect(dispatchSpecOf('AGENT')?.names).toContain('agent');
    expect(dispatchSpecOf('spawn_agent')?.names).toContain('spawn_agent');
  });

  it('自定义派发族：subagent 精确 + 包含式（run_subagent / dispatch-subagent）', () => {
    expect(dispatchSpecOf('subagent')?.names).toContain('subagent');
    expect(dispatchSpecOf('run_subagent')?.nameIncludes).toContain('subagent');
    expect(dispatchSpecOf('dispatch-subagent')?.nameIncludes).toContain('subagent');
  });

  it('非派发工具 → null（read/bash/grep/Agent_team 等不含 subagent 片段的）', () => {
    expect(dispatchSpecOf('read')).toBeNull();
    expect(dispatchSpecOf('bash')).toBeNull();
    expect(dispatchSpecOf('grep')).toBeNull();
    expect(dispatchSpecOf('skill')).toBeNull();
  });

  it('精确匹配优先于包含式：task 不被 subagent_task 之外的 spec 抢走', () => {
    // 'task' 精确命中 task spec；'subagent_task' 不含 'subagent'？——含！
    // 包含式归 subagent spec（自定义族优先于无 exact 的歧义名）
    expect(dispatchSpecOf('task')?.names).toEqual(['task']);
    expect(dispatchSpecOf('subagent_task')?.nameIncludes).toContain('subagent');
  });
});

describe('resolveDispatchToolCall：参数键解析', () => {
  it('reuseDispatch 插件形态（真机湖数据）：args {agent, description, prompt, sessionID}', () => {
    const rec = resolveDispatchToolCall(tc('subagent', {
      agent: 'acme-ops-architect',
      description: 'P1 需求分析 confusion_mul_grad',
      prompt: '请分析 P1 需求……',
      sessionID: 'ses_f3abc001',
    }))!;
    expect(rec).not.toBeNull();
    expect(rec.argSessionId).toBe('ses_f3abc001');   // 驼峰 sessionID 键（大小写归一命中）
    expect(rec.agentType).toBe('acme-ops-architect');
    expect(rec.displayName).toBe('P1 需求分析 confusion_mul_grad');
    expect(rec.content).toBe('P1 需求分析 confusion_mul_grad');
  });

  it('opencode 内置 task 形态：args {description, subagent_type, prompt, subagent_session_id, summary}', () => {
    const rec = resolveDispatchToolCall(tc('task', {
      description: 'R门控 ⑪ 汇总',
      subagent_type: 'design-step-reviewer',
      prompt: '汇总各步骤结论……',
      subagent_session_id: 'ses_f3e03d250',
      subagent_model: 'glm-4.7',
      summary: 'summary 文本',
    }))!;
    expect(rec.argSessionId).toBe('ses_f3e03d250');
    expect(rec.agentType).toBe('design-step-reviewer');
    expect(rec.displayName).toBe('R门控 ⑪ 汇总');
    expect(rec.content).toBe('summary 文本');        // content 键序：summary 优先
  });

  it('claude Agent（proxy）形态：name/subagent_name + mode', () => {
    const rec = resolveDispatchToolCall(tc('Agent', {
      description: 'Code review the diff',
      prompt: 'review …',
      subagent_type: 'code-reviewer',
    }))!;
    expect(rec.agentType).toBe('code-reviewer');
    expect(rec.displayName).toBe('Code review the diff');
    expect(rec.spec.linkViaToolUseMeta).toBe(true);
    // mode 键 fallback
    const recMode = resolveDispatchToolCall(tc('Agent', { description: 'd', prompt: 'p', mode: 'plan' }))!;
    expect(recMode.agentType).toBe('plan');
  });

  it('spawn_agent：message/items 双形态 prompt + 结果 JSON agent_id/nickname', () => {
    const recMsg = resolveDispatchToolCall(tc('spawn_agent', { message: 'fix the build' }, '{"agent_id":"ses_sp1","nickname":"fork-1"}'))!;
    expect(recMsg.content).toBe('fix the build');
    expect(recMsg.resultSessionId).toBe('ses_sp1');
    expect(recMsg.resultNickname).toBe('fork-1');

    const recItems = resolveDispatchToolCall(tc('spawn_agent', {
      items: [{ type: 'text', text: '分析构建日志' }],
    }, '{"agent_id":"ses_sp2","nickname":"fork-2"}'))!;
    expect(recItems.content).toBe('分析构建日志');
    expect(recItems.resultSessionId).toBe('ses_sp2');
  });

  it('结果侧子会话 id 提取器三形态：task_id 文本 / <task id> XML / JSON agent_id', () => {
    // opencode task 真机结果形态：<task id="ses_..." state="completed">
    const recXml = resolveDispatchToolCall(tc('task', { description: 'd', prompt: 'p' },
      '<task id="ses_xml001" state="completed">\n<task_result>\n全部自检通过\n</task_result>\n</task>'))!;
    expect(recXml.resultSessionId).toBe('ses_xml001');

    // claude 文本协议：task_id: ses_xxx
    const recText = resolveDispatchToolCall(tc('task', { description: 'd', prompt: 'p' }, 'task_id: ses_txt002\nResult: done'))!;
    expect(recText.resultSessionId).toBe('ses_txt002');
  });

  it('subagent 族的任意文本结果不参与 task_id 提取（防误锚：子代理答案文本可能含协议字样）', () => {
    const rec = resolveDispatchToolCall(tc('subagent', {
      agent: 'a', description: 'd', prompt: 'p', sessionID: 'ses_direct',
    }, '分析结论：task_id: ses_wrong_target 应忽略'))!;
    // 直连键优先；无直连键时也不从任意文本里猜
    expect(rec.argSessionId).toBe('ses_direct');
    const recNoLink = resolveDispatchToolCall(tc('subagent', {
      agent: 'a', description: 'd', prompt: 'p',
    }, '结论文本 task_id: ses_wrong_target'))!;
    expect(recNoLink.resultSessionId).toBeNull();
  });

  it('创建型派发（无 sessionID 参数）→ 结果协议提取：后台型 (sessionID: ses_x)', () => {
    // 真机形态：The subagent is working in the background (sessionID: ses_xxx).
    const rec = resolveDispatchToolCall(tc('subagent', {
      agent: 'design-step-reviewer',
      description: 'R⑪ 门控审核',
      prompt: '对设计流水线第 ⑪ 步产物执行独立对抗审核。',
      background: true,
    }, '[{"type":"text","text":"The subagent is working in the background (sessionID: ses_ec89cada0ffe). You will be notified automatically when it finishes."}]'))!;
    expect(rec.argSessionId).toBeNull();
    expect(rec.resultSessionId).toBe('ses_ec89cada0ffe');
    expect(rec.displayName).toBe('R⑪ 门控审核');
    expect(rec.agentType).toBe('design-step-reviewer');
  });

  it('创建型派发 → 结果协议提取：阻塞型 <subagent sessionID="…">（嵌套 JSON 转义）', () => {
    // 真机形态：content 是 JSON 数组文本形态，内层引号带转义——解析一层后匹配
    const rec = resolveDispatchToolCall(tc('subagent', {
      agent: 'acme-ops-architect',
      description: 'P1 需求分析',
      prompt: '请分析 P1 需求……',
    }, '[{"type":"text","text":"<subagent sessionID=\\"ses_ecb7711a2ffe\\" state=\\"completed\\">\\n**状态**: ✅通过"}]'))!;
    expect(rec.resultSessionId).toBe('ses_ecb7711a2ffe');
    // 非嵌套（纯文本）形态同样命中
    const recPlain = resolveDispatchToolCall(tc('subagent', { agent: 'a', description: 'd', prompt: 'p' },
      '<subagent sessionID="ses_plain001" state="completed">产出完成'))!;
    expect(recPlain.resultSessionId).toBe('ses_plain001');
  });

  it('非派发工具 / 坏 JSON args → null / 空对象', () => {
    expect(resolveDispatchToolCall(tc('read', { path: '/x' }))).toBeNull();
    const bad = tc('subagent', null);
    expect(resolveDispatchToolCall({ ...bad, argsJson: '{not-json' })).not.toBeNull(); // 坏 args 仍是派发工具，字段全 null
    const rec = resolveDispatchToolCall({ ...bad, argsJson: '{not-json' })!;
    expect(rec.argSessionId).toBeNull();
    expect(rec.displayName).toBeNull();
  });

  it('参数值为非字符串（数字/对象）不误当名字', () => {
    const rec = resolveDispatchToolCall(tc('subagent', { agent: 42, description: { nested: true }, sessionID: 'ses_x' }))!;
    expect(rec.agentType).toBeNull();
    expect(rec.displayName).toBeNull();
    expect(rec.argSessionId).toBe('ses_x');
  });
});

describe('backfillTurnNamesFromDispatches：Turn 名字回填', () => {
  it('空缺回填：subagentName=description、agentName=agent 身份（真机场景）', () => {
    const turns = [
      subTurn('ses_sub001'),
      subTurn('ses_sub001'),
      subTurn('ses_sub002'),
    ];
    backfillTurnNamesFromDispatches(turns, [
      tc('subagent', { agent: 'acme-ops-architect', description: 'P1 需求分析', prompt: 'p', sessionID: 'ses_sub001' }),
      tc('subagent', { agent: 'design-step-reviewer', description: 'R门控审核', prompt: 'p', sessionID: 'ses_sub002' }),
    ]);
    expect(turns[0]!.subagentName).toBe('P1 需求分析');
    expect(turns[0]!.agentName).toBe('acme-ops-architect');
    expect(turns[1]!.subagentName).toBe('P1 需求分析');
    expect(turns[2]!.subagentName).toBe('R门控审核');
    expect(turns[2]!.agentName).toBe('design-step-reviewer');
  });

  it('复用续跑（同子会话多次派发）：取首个派发的名字（会话的创建派发）', () => {
    const turns = [subTurn('ses_sub003')];
    backfillTurnNamesFromDispatches(turns, [
      tc('subagent', { agent: 'arch', description: '首轮：P1 需求分析', sessionID: 'ses_sub003' }),
      tc('subagent', { agent: 'arch', description: '复用：P1 返工 r1', sessionID: 'ses_sub003' }),
    ]);
    expect(turns[0]!.subagentName).toBe('首轮：P1 需求分析');
  });

  it('??= 语义：来源侧已有名字不覆盖（meta/标题路径产出的值优先）', () => {
    const turns = [subTurn('ses_sub004', { subagentName: 'meta 里的名字', agentName: 'msgData.agent' })];
    backfillTurnNamesFromDispatches(turns, [
      tc('subagent', { agent: 'arch', description: '派发描述', sessionID: 'ses_sub004' }),
    ]);
    expect(turns[0]!.subagentName).toBe('meta 里的名字');
    expect(turns[0]!.agentName).toBe('msgData.agent');
  });

  it('无直连（无 sessionID 参数且结果无可提取 id）→ 不回填（不做时间邻近猜测）', () => {
    const turns = [subTurn('ses_sub005')];
    backfillTurnNamesFromDispatches(turns, [
      tc('subagent', { agent: 'arch', description: 'd', prompt: 'p' }),           // 无 sessionID
      tc('subagent', { agent: 'arch', description: 'd', prompt: 'p' }, '任意结论文本'), // 结果也无协议 id
    ]);
    expect(turns[0]!.subagentName).toBeNull();
    expect(turns[0]!.agentName).toBeNull();
  });

  it('主会话 turn（subagentSessionId=null）不受影响；无派发时零开销返回', () => {
    const main = subTurn('ses_main_x');
    main.subagentSessionId = null;
    backfillTurnNamesFromDispatches([main], [tc('subagent', { agent: 'a', description: 'd', sessionID: 'ses_other' })]);
    expect(main.subagentName).toBeNull();

    const t2 = [subTurn('ses_sub006')];
    backfillTurnNamesFromDispatches(t2, [tc('read', { path: '/x' })]); // 非派发工具
    expect(t2[0]!.subagentName).toBeNull();
  });

  it('spawn_agent 结果 id 直连同样可回填（nickname 作展示名）', () => {
    const turns = [subTurn('ses_sp9')];
    backfillTurnNamesFromDispatches(turns, [
      tc('spawn_agent', { message: 'do it' }, '{"agent_id":"ses_sp9","nickname":"fork-9"}'),
    ]);
    expect(turns[0]!.subagentName).toBe('fork-9');
  });

  it('创建型派发（无参数直连）经结果协议 id 回填（真机 52 个无名会话的修复路径）', () => {
    const turns = [subTurn('ses_bg001'), subTurn('ses_blk002')];
    backfillTurnNamesFromDispatches(turns, [
      tc('subagent', { agent: 'reviewer', description: '后台审核', prompt: 'p', background: true },
        '[{"type":"text","text":"The subagent is working in the background (sessionID: ses_bg001)."}]'),
      tc('subagent', { agent: 'architect', description: 'P1 需求分析', prompt: 'p' },
        '[{"type":"text","text":"<subagent sessionID=\\"ses_blk002\\" state=\\"completed\\">完成"}]'),
    ]);
    expect(turns[0]!.subagentName).toBe('后台审核');
    expect(turns[0]!.agentName).toBe('reviewer');
    expect(turns[1]!.subagentName).toBe('P1 需求分析');
    expect(turns[1]!.agentName).toBe('architect');
  });
});
