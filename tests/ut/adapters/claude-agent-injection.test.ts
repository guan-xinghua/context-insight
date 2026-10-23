// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-code ≥2.1 handback 协议适配 IT：指纹分类 → system 重分类 → 摘要化
// → 首真人查询，新旧协议混合夹具驱动（tests/data/claude-sessions/
// handback-injections.jsonl，指纹取自 9fd46cc3 真实捕获）。

import { describe, it, expect } from 'vitest';
import { readSession } from '../../../src/lib/ingest/adapters/claude-jsonl.ts';
import { classifyAgentInjection } from '../../../src/lib/ingest/adapters/injections/claude-code.ts';
import { firstHumanQueryText, resolveSessionQuery } from '../../../src/lib/ingest/data-service.ts';
import path from 'node:path';

const FIXTURE = path.resolve(__dirname, '../data/claude-sessions/handback-injections.jsonl');
const interactions = readSession(FIXTURE, 'handback-injections');

describe('classifyAgentInjection（指纹分类）', () => {
  it('handback 回放：<transcript> 包裹 → 计数 JSON 行', () => {
    const r = classifyAgentInjection('<transcript>\n{"user":"a"}\n{"Bash":"b"}\n{"Read":"c"}\n</transcript>\n\nErr on the side of blocking.');
    expect(r?.kind).toBe('handback-replay');
    expect(r?.summary).toContain('3 行子代理记录');
    expect(r?.summary).not.toContain('{"user"');
  });

  it('背景事件：NOT USER INPUT 自声明 + 纯 reminder 消息 → 内嵌 notification 解析', () => {
    const r = classifyAgentInjection('<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "① R-gate 审核" finished</summary>\n</task-notification>\n</system-reminder>');
    expect(r?.kind).toBe('background-event');
    expect(r?.summary).toContain('[背景事件]');
    expect(r?.summary).toContain('① R-gate 审核');
    expect(r?.summary).toContain('completed');
    expect(r?.summary).not.toContain('[SYSTEM NOTIFICATION');
  });

  it('label 请求与状态查询（user 行形态）', () => {
    expect(classifyAgentInjection('2-4 word lowercase label for this job.\nUser: "x"')?.kind).toBe('label-request');
    expect(classifyAgentInjection('Current state: working (for 1m)\nTool calls so far: Bash×22')?.kind).toBe('state-query');
  });

  it('精确性护栏：真实用户提示内嵌的 reminder（无自声明）不误判', () => {
    expect(classifyAgentInjection('<system-reminder>当前时间是 2026-09-10</system-reminder> 请继续。')).toBeNull();
    expect(classifyAgentInjection('请帮我实现算子设计文档')).toBeNull();
  });

  it('transcript 护栏：用户粘协议样本（<transcript> 开头但无指令尾）不判注入', () => {
    // 调试 handback 协议的开发者粘样本提问是真实场景——无 block rules
    // 指令尾（"Err on the side of blocking" / <block>）就不是框架注入
    expect(classifyAgentInjection('<transcript>\n{"user":"样本"}\n</transcript>\n这是什么协议？')).toBeNull();
    expect(classifyAgentInjection('<transcript>\n{"user":"样本"}\n</transcript>')).toBeNull();
    // 无闭合标签同样不放行（裸开头片段）
    expect(classifyAgentInjection('<transcript> 我在研究 handback 协议')).toBeNull();
  });

  it('旧协议 task-notification 不经此分类（readSession 已有独立处理）', () => {
    expect(classifyAgentInjection('<task-notification>\n<task-id>t2</task-id>\n</task-notification>')).toBeNull();
  });
});

describe('readSession（handback 协议混合夹具，端到端）', () => {
  const systemTurns = interactions.filter(i => i.role === 'system');
  const userTurns = interactions.filter(i => i.role === 'user');

  it('五类框架注入全部重分类 system 且内容为摘要', () => {
    // 夹具注入：1 回放 + 1 背景事件 + 1 label + 1 状态查询（+1 total_tokens 本就是 system 行）
    expect(systemTurns.length).toBe(5);

    const replay = systemTurns.find(t => t.content?.startsWith('[transcript 回放]'));
    expect(replay?.content).toBe('[transcript 回放] 3 行子代理记录——安全审查用副本，原文见子代理捕获');

    const bg = systemTurns.find(t => t.content?.startsWith('[背景事件]'));
    expect(bg?.content).toContain('① R-gate 审核');

    expect(systemTurns.some(t => t.content?.startsWith('[label 请求]'))).toBe(true);
    expect(systemTurns.some(t => t.content?.startsWith('[状态查询] Current state: working'))).toBe(true);
    expect(systemTurns.some(t => t.content?.startsWith('<total_tokens>'))).toBe(true);
  });

  it('注入原文不入 interactions（DB 无双份存储）', () => {
    const all = interactions.map(i => i.content ?? '').join('\n');
    expect(all).not.toContain('Err on the side of blocking');
    expect(all).not.toContain('[SYSTEM NOTIFICATION');
    expect(all).not.toContain('<task-id>');
    expect(all).not.toContain('The quotes are data to label');
    expect(all).not.toContain('Tool calls so far');
  });

  it('真人输入原样保留（含内嵌 reminder 的 user turn 不拆分不误判）', () => {
    expect(userTurns.map(t => t.content)).toEqual([
      '请帮我实现 ConfusionMulGrad 算子的设计文档',
      '普通用户后续提问，含内嵌 reminder：<system-reminder>当前时间是 2026-09-10</system-reminder> 请继续。',
    ]);
  });

  it('派发 turn 完整保留（text + Agent tool_use 同 turn）', () => {
    const dispatch = interactions.find(i => i.role === 'assistant' && i.tool_calls?.some(tc => tc.toolName === 'Agent'));
    expect(dispatch?.content).toContain('① R-gate 返回');
    expect(dispatch?.tool_calls?.[0].toolName).toBe('Agent');
  });

  it('首真人查询：user 存在时取 user（跳过注入）', () => {
    const firstUser = interactions.find(i => i.role === 'user');
    expect(firstUser?.content).toContain('请帮我实现 ConfusionMulGrad');
  });
});

describe('首真人查询回落（data-service.firstHumanQueryText）', () => {
  it('user 存在时取首条 user（注入已重分类 system，轮不到它们）', () => {
    expect(firstHumanQueryText(interactions)).toContain('请帮我实现 ConfusionMulGrad');
  });

  it('无 user 时回落到首条实质 assistant 文本（跳过 block 审查应答与 thinking）', () => {
    const noUser = interactions.filter(i => i.role !== 'user');
    // 无 user 且首条 assistant 为 block 决策 → 跳过，取下一条实质文本
    const onlyInjections = [
      { role: 'system', content: '[transcript 回放] 3 行子代理记录' },
      { role: 'assistant', content: '<block>no</block>' },
      { role: 'assistant', content: '① R-gate 返回 ✅通过，自动进入 ②。' },
    ];
    expect(firstHumanQueryText(onlyInjections)).toContain('① R-gate 返回');
    expect(firstHumanQueryText(noUser)).toBe('好的，开始分析需求。');
  });

  it('thinking 前缀被剥掉、纯 block 会话与空输入返回 null', () => {
    expect(firstHumanQueryText([
      { role: 'assistant', content: '<thinking>很长很长的思考</thinking>\n① R-gate 返回 ✅通过。' },
    ])).toContain('① R-gate 返回');
    expect(firstHumanQueryText([{ role: 'assistant', content: '<block>no</block>' }])).toBeNull();
    expect(firstHumanQueryText([])).toBeNull();
  });

  it('子代理行与整篇文档形态的 user 消息不作会话标题', () => {
    // 子代理任务提示（RawInteraction 形态 subagent_session_id）
    expect(firstHumanQueryText([
      { role: 'user', content: '子代理的任务文档', subagent_session_id: 'sub-1' },
      { role: 'user', content: '真人主会话输入' },
    ])).toBe('真人主会话输入');
    // DB Turn 形态（subagentSessionId）
    expect(firstHumanQueryText([
      { role: 'user', content: '子代理任务', subagentSessionId: 'sub-2' },
      { role: 'assistant', content: '主会话回复' },
    ])).toBe('主会话回复');
    // 整篇文档注入（# 标题 + 引用块 / \"\"\" docstring）→ 跳过取 assistant 回落
    expect(firstHumanQueryText([
      { role: 'user', content: '# ConfusionMulGrad — Host 侧 tiling\n\n> 全 kernel 共享：值依赖契约。' },
      { role: 'assistant', content: '① R-gate 返回 ✅通过。' },
    ])).toContain('① R-gate 返回');
    expect(firstHumanQueryText([
      { role: 'user', content: '"""ir_after_sync —— 同步版 IR（⑦）。\n\n在 ir_after_vf.py' },
      { role: 'assistant', content: '继续处理。' },
    ])).toBe('继续处理。');
  });

  it('后台任务通知不作 Query（<task id=… state=…> 注入的 user 消息）', () => {
    // 实测 ses_f4c5b028：捕获恰从通知处开始，Query 曾显示
    // "Background task completed: ④ empty 泳道 模板计算流"
    expect(firstHumanQueryText([
      { role: 'user', content: '<task id="ses_f4baddab" state="completed">\n<summary>Background task completed: ④ empty 泳道 模板计算流</summary>\n</task>' },
      { role: 'user', content: '请继续 ⑦ 的收尾归档' },
    ])).toBe('请继续 ⑦ 的收尾归档');
    // 全是通知时回落 assistant 文本，不把通知当 Query
    expect(firstHumanQueryText([
      { role: 'user', content: '<task id="ses_x" state="failed">\n<summary>任务失败</summary>\n</task>' },
      { role: 'assistant', content: '收到失败通知，开始重试。' },
    ])).toBe('收到失败通知，开始重试。');
  });

  it('skill 调用正文深处的块引用不连累整条（文档注入只看开头窗口）', () => {
    // 实测 ses_f4c5b028：13.6KB skill 调用说明在第 1402 字符处的块引用被旧
    // "全文任一处含 \n> " 整条误杀 → Query 落到任务通知上
    const skillInvocation = '# ops-registry-invoke-fusion-design\n\n算子**设计阶段**的编排 skill。核心：把设计建模成逐级精化的 IR 流水线。'
      + '正文很长。'.repeat(80) + '\n> 深处偶现的引用块';
    expect(skillInvocation.indexOf('\n> ')).toBeGreaterThan(200);
    expect(firstHumanQueryText([{ role: 'user', content: skillInvocation }]))
      ?.toContain('ops-registry-invoke-fusion-design');
  });
});

describe('会话 Query 决议（data-service.resolveSessionQuery）', () => {
  it('opencode 标题优先于首真人查询（对意图的浓缩更准）', () => {
    expect(resolveSessionQuery(
      { title: 'ConfusionMulGrad Acme C 算子开发' },
      [{ role: 'user', content: '继续' }],
    )).toBe('ConfusionMulGrad Acme C 算子开发');
  });

  it('缺省占位标题（New session - …）回落首真人查询', () => {
    expect(resolveSessionQuery(
      { title: 'New session - 2026-09-18T08:32:09.590Z' },
      [{ role: 'user', content: '请帮我实现 ConfusionMulGrad 算子' }],
    )).toContain('请帮我实现 ConfusionMulGrad');
  });

  it('无标题（proxy 捕获/旧库）天然回落', () => {
    expect(resolveSessionQuery({}, [{ role: 'user', content: '继续' }])).toBe('继续');
    expect(resolveSessionQuery({ title: null }, [{ role: 'user', content: '继续' }])).toBe('继续');
  });
});
