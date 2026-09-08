// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 单会话基线 IT：基线 = 一个样例会话（同类任务各一），不是语料分布。
// 设基线 API（度量提取与评分同一组函数）→ 另一会话评分按比值打分；
// 未设基线 = 无法评判（缺什么说什么）；unknown 任务类型拒绝设基线。

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { importSession } from '../src/lib/ingest/data-service';
import { runScorecard } from '../src/lib/scoring/core/runner';
import { FileScorecardStore } from '../src/lib/scoring/core/store';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-baseline-'));
process.env.SCORING_BASELINE_DIR = path.join(TMP, 'baselines');
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');
const store = new FileScorecardStore(path.join(TMP, 'store'));

interface Line { type: string; message: Record<string, unknown>; timestamp: string }
const BASE = '2026-09-01T10:00:00.000Z';
let ts = 0;
const stamp = () => new Date(new Date(BASE).getTime() + ts++ * 1000).toISOString();
const userText = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text }, timestamp: stamp() });
function toolUse(id: string, name: string, input: Record<string, unknown>, usage = { input_tokens: 100, output_tokens: 20 }): Line {
  return { type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], model: 'test-model', usage }, timestamp: stamp() };
}
const toolResult = (id: string, content: string): Line => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, timestamp: stamp() });

const SID_BASE = 'baseline-base-session';    // 写 /src 文件 → general
const SID_NEW = 'baseline-new-session';
const SID_UNKNOWN = 'baseline-unknown-session';   // 只跑命令不写文件 → unknown

function fixtureFile(name: string, lines: Line[]): string {
  const file = path.join(TMP, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

async function importFixture(taskId: string, file: string) {
  await prisma.session.deleteMany({ where: { taskId } });
  await importSession(file, taskId, prisma, file, 'claude-jsonl');
}

async function postBaseline(taskId: string) {
  const { POST } = await import('../src/app/api/observe/session/scorecard/baseline/route');
  return POST(new NextRequest('http://localhost/api/observe/session/scorecard/baseline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  }));
}

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [SID_BASE, SID_NEW, SID_UNKNOWN] } } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('单会话基线（基线 = 一个样例会话）', () => {
  it('设为基线：general 会话 → 写 baselines/<taskType>.json，度量与评分同源', async () => {
    await importFixture(SID_BASE, fixtureFile(SID_BASE, [
      userText('实现 alpha 功能'),
      toolUse('t01', 'Write', { file_path: '/src/alpha.ts', content: 'export const alpha = 1' }),
      toolResult('t01', 'ok'),
      toolUse('t02', 'Write', { file_path: '/src/beta.ts', content: 'export const beta = 1' }),
      toolResult('t02', 'ok'),
    ]));
    const res = await postBaseline(SID_BASE);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.taskType).toBe('general');
    expect(data.metrics).toBeUndefined();
    expect(data.metricsCount).toBeGreaterThanOrEqual(1);
    const file = JSON.parse(fs.readFileSync(path.join(process.env.SCORING_BASELINE_DIR!, 'general.json'), 'utf-8'));
    expect(file.schema).toBe('workflow-session-baseline');
    expect(file.metrics['D4.tokens'].value).toBeGreaterThan(0);
    // D4.turns（轮次比值）随基线导出：非子代理轮数（含收尾工具结果轮）= 3
    expect(file.metrics['D4.turns']).toEqual({ value: 3, unit: '轮' });
    // 概要随基线导出：模型/框架版本（不参与度量，对比时参考）
    expect(file.context.models).toContain('test-model');
  });

  it('新会话评分：D4.tokens 与基线会话比比值（本次更省 → 比值<1 → 高分）', async () => {
    // 基线写了 2 轮（每轮 in100/out20），新会话只写 1 轮 → 本次 token ≈ 基线一半
    await importFixture(SID_NEW, fixtureFile(SID_NEW, [
      userText('实现 alpha 功能精简版'),
      toolUse('t11', 'Write', { file_path: '/src/alpha.ts', content: 'export const alpha = 2' }),
      toolResult('t11', 'ok'),
    ]));
    const card = await runScorecard(SID_NEW, prisma, { store });
    expect(card!.status).toBe('completed');
    const tokens = card!.dimensions.flatMap(d => d.items).find(i => i.itemId === 'D4.tokens')!;
    expect(tokens.status).toBe('ok');
    expect(tokens.baselineScore).toBe(1);            // 比值 0.5 → (2−0.5)/1.25 截断 1.0
    expect(tokens.formula).toContain('基线会话');
    expect(tokens.formula).toContain('比值 0.50');
    expect(tokens.note).toContain('优于基线');
    // D4.turns 同套机制：基线 3 轮 vs 本次 2 轮 → 比值 0.67 → 截断 1.0（公式带轮数展示）
    const turns = card!.dimensions.flatMap(d => d.items).find(i => i.itemId === 'D4.turns')!;
    expect(turns.status).toBe('ok');
    expect(turns.baselineScore).toBe(1);
    expect(turns.formula).toContain('3 轮');
    expect(turns.formula).toContain('2 轮');
    expect(turns.formula).toContain('比值 0.67');
  });

  it('清掉基线 → D4 按默认 80 计（持平档，公式明标默认）', async () => {
    fs.rmSync(path.join(process.env.SCORING_BASELINE_DIR!, 'general.json'));
    const card = await runScorecard(SID_NEW, prisma, { store });
    const tokens = card!.dimensions.flatMap(d => d.items).find(i => i.itemId === 'D4.tokens')!;
    expect(tokens.status).toBe('ok');
    expect(tokens.baselineScore).toBe(0.8);
    expect(tokens.formula).toContain('默认 80');
    const turns = card!.dimensions.flatMap(d => d.items).find(i => i.itemId === 'D4.turns')!;
    expect(turns.baselineScore).toBe(0.8);
  });

  it('unknown 任务类型（没写文件）：拒绝设基线', async () => {
    await importFixture(SID_UNKNOWN, fixtureFile(SID_UNKNOWN, [
      userText('查一下状态'),
      toolUse('t21', 'Bash', { command: 'git status' }),
      toolResult('t21', 'ok'),
    ]));
    const res = await postBaseline(SID_UNKNOWN);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('任务类型未知');
  });
});
