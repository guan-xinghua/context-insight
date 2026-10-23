// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 自定义派发工具（reuseDispatch 形态）全链路 IT：fixture 复刻真机湖数据形态
// （主会话 `subagent` 工具派发，args {agent, description, prompt, sessionID}；
// 子会话目录无 meta → 名字/身份全断）→ importSession 全链路 → 断言：
//   1. Turn.subagentName/agentName 从派发参数回填落库（ Turns 页签 badge 就位）
//   2. InteractionBridge 建桥且名字/身份入位（复用续跑同 sessionID 双桥）
//   3. Execution 名字继承（时间线/泳道标签）
//   4. merge 路径的存量行补丁：名字被抹空后重导入 → null→值 落库恢复

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { importSession } from '@/lib/ingest/data-service';

const SID = 'ses-reuse-it-main';
const SUB1 = 'ses-reuse-it-sub1';
const SUB2 = 'ses-reuse-it-sub2';
const SUB3 = 'ses-reuse-it-sub3';
const SUB4 = 'ses-reuse-it-sub4';

let TMP = '';
let mainFile = '';

function writeFixture(): void {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-dispatch-it-'));
  mainFile = path.join(TMP, `${SID}.jsonl`);

  const mainLines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '开始 P1 流程' }, timestamp: '2026-10-12T08:00:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', id: 'm1',
        content: [
          { type: 'text', text: '先做需求分析' },
          { type: 'tool_use', id: 'tu1', name: 'subagent', input: {
            agent: 'acme-ops-architect',
            description: 'P1 需求分析 confusion_mul_grad',
            prompt: '请分析 P1 需求……',
            sessionID: SUB1,
          } },
        ],
        model: 'glm-5.3', usage: { input_tokens: 400, output_tokens: 100 },
      },
      timestamp: '2026-10-12T08:00:05.000Z',
    }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '需求分析完成' }] }, timestamp: '2026-10-12T08:05:00.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '返工 r1' }, timestamp: '2026-10-12T08:06:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', id: 'm2',
        content: [
          { type: 'text', text: '复用同一子会话返工' },
          { type: 'tool_use', id: 'tu2', name: 'subagent', input: {
            agent: 'acme-ops-architect',
            description: 'P1 返工 r1 需求分析',
            prompt: '在你上一轮产物基线上修改……',
            sessionID: SUB1,   // 复用：同一子会话二次派发
          } },
        ],
        model: 'glm-5.3', usage: { input_tokens: 500, output_tokens: 120 },
      },
      timestamp: '2026-10-12T08:06:05.000Z',
    }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'r1 修改完成' }] }, timestamp: '2026-10-12T08:11:00.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '另起审核' }, timestamp: '2026-10-12T08:12:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', id: 'm3',
        content: [
          { type: 'text', text: '派发审核' },
          { type: 'tool_use', id: 'tu3', name: 'subagent', input: {
            agent: 'design-step-reviewer',
            description: 'R门控 P1 需求分析审核',
            prompt: '审核 P1 产物……',
            sessionID: SUB2,
          } },
        ],
        model: 'glm-5.3', usage: { input_tokens: 300, output_tokens: 80 },
      },
      timestamp: '2026-10-12T08:12:05.000Z',
    }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: '审核通过' }] }, timestamp: '2026-10-12T08:16:00.000Z' }),
    // 创建型派发（真机 71/102 形态：args 无 sessionID，id 在结果协议里）——后台型
    JSON.stringify({ type: 'user', message: { role: 'user', content: '做汇总' }, timestamp: '2026-10-12T08:17:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', id: 'm5',
        content: [
          { type: 'text', text: '后台派发汇总' },
          { type: 'tool_use', id: 'tu4', name: 'subagent', input: {
            agent: 'design-merger',
            description: '⑩ 合并产物',
            prompt: '合并各步骤产物……',
            background: true,
          } },
        ],
        model: 'glm-5.3', usage: { input_tokens: 300, output_tokens: 60 },
      },
      timestamp: '2026-10-12T08:17:05.000Z',
    }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu4', content: '[{"type":"text","text":"The subagent is working in the background (sessionID: ses-reuse-it-sub3). You will be notified automatically when it finishes."}]' }] }, timestamp: '2026-10-12T08:17:06.000Z' }),
    // 创建型——阻塞型（结果为嵌套 JSON 字符串 + <subagent sessionID=…> 协议）
    JSON.stringify({ type: 'user', message: { role: 'user', content: '另做规格生成' }, timestamp: '2026-10-12T08:18:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', id: 'm6',
        content: [
          { type: 'text', text: '派发规格生成' },
          { type: 'tool_use', id: 'tu5', name: 'subagent', input: {
            agent: 'spec-writer',
            description: 'P2 spec 生成',
            prompt: '生成 spec.yaml……',
          } },
        ],
        model: 'glm-5.3', usage: { input_tokens: 280, output_tokens: 50 },
      },
      timestamp: '2026-10-12T08:18:05.000Z',
    }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu5', content: '[{"type":"text","text":"<subagent sessionID=\\"ses-reuse-it-sub4\\" state=\\"completed\\">\\nspec.yaml 已生成"}]' }] }, timestamp: '2026-10-12T08:22:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', id: 'm7', content: [{ type: 'text', text: '流程完成' }], model: 'glm-5.3', usage: { input_tokens: 100, output_tokens: 20 } }, timestamp: '2026-10-12T08:23:00.000Z' }),
  ];
  fs.writeFileSync(mainFile, mainLines.join('\n') + '\n');

  // 子会话：无 meta.json（真机湖数据实况——meta 断链），仅目录布局可发现
  const subDir = path.join(TMP, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, `${SUB1}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '请分析 P1 需求' }, timestamp: '2026-10-12T08:00:06.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', id: 's1a', content: [{ type: 'text', text: '需求分析第一轮产出' }], model: 'glm-5.3', usage: { input_tokens: 200, output_tokens: 100 } }, timestamp: '2026-10-12T08:04:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', id: 's1b', content: [{ type: 'text', text: 'r1 返工产出' }], model: 'glm-5.3', usage: { input_tokens: 220, output_tokens: 110 } }, timestamp: '2026-10-12T08:10:00.000Z' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(subDir, `${SUB2}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '审核 P1 产物' }, timestamp: '2026-10-12T08:12:06.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', id: 's2a', content: [{ type: 'text', text: '审核通过' }], model: 'glm-5.3', usage: { input_tokens: 150, output_tokens: 60 } }, timestamp: '2026-10-12T08:15:00.000Z' }),
  ].join('\n') + '\n');
  // 创建型派发的两个目标（无 meta，仅目录布局发现）
  fs.writeFileSync(path.join(subDir, 'ses-reuse-it-sub3.jsonl'), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'You are a subagent spawned by another session.\n\n合并各步骤产物……' }, timestamp: '2026-10-12T08:17:06.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', id: 's3a', content: [{ type: 'text', text: '合并完成' }], model: 'glm-5.3', usage: { input_tokens: 180, output_tokens: 70 } }, timestamp: '2026-10-12T08:20:00.000Z' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(subDir, 'ses-reuse-it-sub4.jsonl'), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'You are a subagent spawned by another session.\n\n生成 spec.yaml……' }, timestamp: '2026-10-12T08:18:06.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', id: 's4a', content: [{ type: 'text', text: 'spec.yaml 已生成' }], model: 'glm-5.3', usage: { input_tokens: 160, output_tokens: 55 } }, timestamp: '2026-10-12T08:21:00.000Z' }),
  ].join('\n') + '\n');
}

beforeAll(async () => {
  writeFixture();
  await prisma.session.deleteMany({ where: { taskId: SID } });
  const res = await importSession(mainFile, SID, prisma, mainFile, 'claude-jsonl');
  expect(res.imported).toBe(true);
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

describe('reuseDispatch 全链路：Turn/bridge/Execution 名字就位', () => {
  it('Turn.subagentName/agentName 从派发参数回填（子会话无 meta 的湖数据形态）', async () => {
    const sub1Turns = await prisma.turn.findMany({
      where: { subagentSessionId: SUB1 },
      orderBy: { turnIndex: 'asc' },
    });
    expect(sub1Turns.length).toBeGreaterThan(0);
    for (const t of sub1Turns) {
      expect(t.subagentName).toBe('P1 需求分析 confusion_mul_grad'); // 首个派发的描述
      expect(t.agentName).toBe('acme-ops-architect');
    }
    const sub2Turns = await prisma.turn.findMany({ where: { subagentSessionId: SUB2 } });
    expect(sub2Turns.length).toBeGreaterThan(0);
    for (const t of sub2Turns) {
      expect(t.subagentName).toBe('R门控 P1 需求分析审核');
      expect(t.agentName).toBe('design-step-reviewer');
    }
    // 创建型派发（无参数直连，结果协议提取）的两个目标
    const sub3Turns = await prisma.turn.findMany({ where: { subagentSessionId: SUB3 } });
    expect(sub3Turns.length).toBeGreaterThan(0);
    for (const t of sub3Turns) {
      expect(t.subagentName).toBe('⑩ 合并产物');
      expect(t.agentName).toBe('design-merger');
    }
    const sub4Turns = await prisma.turn.findMany({ where: { subagentSessionId: SUB4 } });
    expect(sub4Turns.length).toBeGreaterThan(0);
    for (const t of sub4Turns) {
      expect(t.subagentName).toBe('P2 spec 生成');
      expect(t.agentName).toBe('spec-writer');
    }
  });

  it('InteractionBridge：五条派发五条桥，复用续跑同 sessionID 双桥', async () => {
    const session = await prisma.session.findFirstOrThrow({ where: { taskId: SID } });
    const bridges = await prisma.interactionBridge.findMany({ where: { sessionId: session.id } });
    expect(bridges).toHaveLength(5);
    const names = bridges.map(b => b.subagentName).sort();
    expect(names).toEqual([
      'P1 返工 r1 需求分析',
      'P1 需求分析 confusion_mul_grad',
      'P2 spec 生成',
      'R门控 P1 需求分析审核',
      '⑩ 合并产物',
    ].sort());
    const reuseBridges = bridges.filter(b => b.subagentSessionId === SUB1);
    expect(reuseBridges).toHaveLength(2);
    expect(bridges.every(b => b.subagentType != null)).toBe(true);
  });

  it('Execution：子代理执行的名字/身份继承（时间线/泳道数据源）', async () => {
    const session = await prisma.session.findFirstOrThrow({ where: { taskId: SID } });
    const execs = await prisma.execution.findMany({ where: { sessionId: session.id, isSubagent: true } });
    expect(execs.length).toBeGreaterThan(0);
    const arch = execs.find(e => e.agentSessionId === SUB1);
    expect(arch?.agentName).toBe('acme-ops-architect');
    expect(arch?.subagentName).toBe('P1 需求分析 confusion_mul_grad');
  });
});

describe('reuseDispatch merge 路径：存量行名字补丁', () => {
  it('名字抹空后重导入 → null→值 落库恢复（persistTurnNameBackfill）', async () => {
    // 模拟历史湖数据：导入成功但名字列全空（回填能力上线前的存量行）
    await prisma.turn.updateMany({
      where: { subagentSessionId: { in: [SUB1, SUB2, SUB3, SUB4] } },
      data: { subagentName: null, agentName: null },
    });
    const nulled = await prisma.turn.count({
      where: { subagentSessionId: SUB1, subagentName: null, agentName: null },
    });
    expect(nulled).toBeGreaterThan(0);

    // 重导入：dedup → merge 路径 → persistTurnNameBackfill 补存量行
    const res = await importSession(mainFile, SID, prisma, mainFile, 'claude-jsonl');
    expect(res.imported).toBe(false); // merge，不新建

    const restored1 = await prisma.turn.findMany({ where: { subagentSessionId: SUB1 } });
    expect(restored1.length).toBeGreaterThan(0);
    for (const t of restored1) {
      expect(t.subagentName).toBe('P1 需求分析 confusion_mul_grad');
      expect(t.agentName).toBe('acme-ops-architect');
    }
    const restored2 = await prisma.turn.findMany({ where: { subagentSessionId: SUB2 } });
    for (const t of restored2) {
      expect(t.subagentName).toBe('R门控 P1 需求分析审核');
      expect(t.agentName).toBe('design-step-reviewer');
    }
    const restored3 = await prisma.turn.findMany({ where: { subagentSessionId: SUB3 } });
    for (const t of restored3) {
      expect(t.subagentName).toBe('⑩ 合并产物');
      expect(t.agentName).toBe('design-merger');
    }
    const restored4 = await prisma.turn.findMany({ where: { subagentSessionId: SUB4 } });
    for (const t of restored4) {
      expect(t.subagentName).toBe('P2 spec 生成');
      expect(t.agentName).toBe('spec-writer');
    }
  });
});
