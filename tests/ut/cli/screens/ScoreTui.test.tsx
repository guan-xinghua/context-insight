// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ScoreTui IT：jsonl 夹具入库 + PATH 假 claude → 选会话 → 选工具 → 实时进度 →
// 评分卡展示 → s 落 jsonl。ink-testing-library 真实驱动按键与渲染帧。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../../../src/lib/ingest/data-service';
import { ScoreTui } from '../../../../src/cli/tui/screens/ScoreTui';
import { renderTui } from '../../helpers/render-tui';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'score-tui-it-'));
const SID = 'score-tui-it-sid';

interface Line { type: string; message: Record<string, unknown>; timestamp: string; [k: string]: unknown }
const BASE = '2026-11-03T10:00:00.000Z';
let ts = 0;
const stamp = () => new Date(new Date(BASE).getTime() + ts++ * 1000).toISOString();
const userText = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text }, timestamp: stamp() });
const toolUse = (id: string, name: string, input: Record<string, unknown>): Line => ({
  type: 'assistant',
  message: {
    id: `msg_${id}`, role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    model: 'test-model',
    usage: { input_tokens: 100, output_tokens: 20 },
  },
  timestamp: stamp(),
});
const toolResult = (id: string, content: string): Line => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, timestamp: stamp() });

const LINES: Line[] = [
  userText('给 utils 加一个乘法函数并跑测试验证'),
  toolUse('t01', 'Read', { file_path: '/repo/src/utils.ts' }), toolResult('t01', '1\t// utils'),
  toolUse('t02', 'Edit', { file_path: '/repo/src/utils.ts', old_string: 'a', new_string: 'export const mul = (a,b) => a*b' }), toolResult('t02', 'ok'),
  toolUse('t03', 'Bash', { command: 'npm test' }), toolResult('t03', 'Tests 8 passed | 0 failed'),
];

const FAKE_REVIEW = {
  summary: 'fake tui review',
  items: [
    { itemId: 'D1.goalCoverage', verdict: 'partial', score: 0.7, note: 'tui-goal' },
    { itemId: 'D3.correctness', verdict: 'partial', score: 0.9, note: 'tui-correct' },
    { itemId: 'D6.classification', verdict: 'clean', note: 'tui-class' },
  ],
};

const OLD_ENV: Record<string, string | undefined> = {};
const SET_ENV: Record<string, string> = {
  SCORING_PROFILE_DIR: path.join(TMP, 'profiles'),
  SCORING_USER_DEF_DIR: path.join(TMP, 'user-defs'),
  SCORING_DATA_DIR: path.join(TMP, 'scorecards'),
  MATE_AGENT_LOG_DIR: path.join(TMP, 'mate-logs'),
};
const OLD_PATH = process.env.PATH;

beforeAll(() => {
  for (const [k, v] of Object.entries(SET_ENV)) { OLD_ENV[k] = process.env[k]; process.env[k] = v; }
  const fakeBin = path.join(TMP, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(FAKE_REVIEW)}\nEOF\n`, 'utf-8');
  fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
  process.env.PATH = `${fakeBin}:${OLD_PATH}`;
  const fixture = path.join(TMP, `${SID}.jsonl`);
  fs.writeFileSync(fixture, LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
  return importSession(fixture, SID, prisma, fixture, 'claude-jsonl');
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  await prisma.$disconnect();
  for (const [k, v] of Object.entries(OLD_ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  process.env.PATH = OLD_PATH;
  process.exitCode = undefined;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('ScoreTui（独立 mate 评分 TUI）', () => {
  it('初始会话直跑：进度 → 评分卡展示 → s 落 jsonl', { timeout: 120_000 }, async () => {
    const tui = renderTui(
      <ScoreTui initialSession={{ taskId: SID, framework: 'claude-code' }}
        workdir={path.join(TMP, 'work')} saveDir={path.join(TMP, 'save')} />,
    );
    const plain = () => tui.getPlainText();

    // 进度阶段可见
    await vi.waitFor(() => expect(plain()).toContain('评分中'), { timeout: 60_000 });
    // 完成 → 评分卡视图
    await vi.waitFor(() => expect(plain()).toContain('评分结果'), { timeout: 90_000 });
    await vi.waitFor(() => expect(plain()).toContain('总分'), { timeout: 10_000 });
    expect(plain()).toContain('█');
    expect(plain()).toContain('D3');
    expect(plain()).toContain('tui-correct');
    expect(plain()).toContain('[s] 保存 jsonl');

    // s 落 jsonl（事件流完整：meta/progress/done）
    tui.pressKey('s');
    await vi.waitFor(() => expect(plain()).toContain('已保存'), { timeout: 10_000 });
    const saved = fs.readdirSync(path.join(TMP, 'save'));
    expect(saved.length).toBe(1);
    const events = fs.readFileSync(path.join(TMP, 'save', saved[0]), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(events[0].type).toBe('meta');
    expect(events.some(e => e.type === 'progress')).toBe(true);
    expect(events[events.length - 1].type).toBe('done');

    tui.unmount();
  });

  it('无初始会话：来源菜单 → 本机库清单渲染与光标交互', { timeout: 30_000 }, async () => {
    const tui = renderTui(<ScoreTui saveDir={path.join(TMP, 'save')} />);
    const plain = () => tui.getPlainText();

    await vi.waitFor(() => expect(plain()).toContain('选择会话来源'), { timeout: 15_000 });
    expect(plain()).toContain('从目录选择');
    tui.pressEnter(); // 本机库
    await vi.waitFor(() => expect(plain()).toContain('选择会话'), { timeout: 15_000 });
    await vi.waitFor(() => expect(plain()).toContain(SID), { timeout: 15_000 });
    expect(plain()).toContain('Task ID');

    tui.pressDown();
    await vi.waitFor(() => expect(plain()).toContain('❯'), { timeout: 5_000 });
    tui.pressUp();

    // [/] 过滤：按关键字收敛到目标会话
    tui.pressKey('/');
    await vi.waitFor(() => expect(plain()).toContain('过滤:'), { timeout: 5_000 });
    for (const ch of SID) tui.pressKey(ch);
    await vi.waitFor(() => expect(plain()).toContain('1/'), { timeout: 5_000 });
    tui.pressEscape(); // 清除过滤（TextInput onEscape）
    await vi.waitFor(() => expect(plain()).not.toContain('过滤:'), { timeout: 5_000 });

    tui.unmount();
  });

  it('目录流：手输路径 → 扫描 → 全选批量 → 工具 → 汇总 + 详情 + 保存', { timeout: 180_000 }, async () => {
    // 夹具目录：两个独立会话文件
    const dir = path.join(TMP, 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    for (const sid of [`${SID}-a`, `${SID}-b`]) {
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
    }

    const tui = renderTui(<ScoreTui saveDir={path.join(TMP, 'save')} workdir={path.join(TMP, 'work2')} />);
    const plain = () => tui.getPlainText();

    // 来源 → 目录（按键间等一帧：连续写 stdin 会落在同一次渲染前，闭包里是旧状态）
    await vi.waitFor(() => expect(plain()).toContain('选择会话来源'), { timeout: 15_000 });
    tui.pressDown();
    await vi.waitFor(() => expect(plain()).toContain('❯ 从目录选择'), { timeout: 5_000 });
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('选择目录'), { timeout: 15_000 });

    // 首项即「手动输入路径」：Enter 进入输入模式，键入路径后 Enter 扫描
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('/path/to/sessions'), { timeout: 5_000 });
    for (const ch of dir) tui.pressKey(ch);
    tui.pressEnter();

    // 扫描结果：两个会话可见，[a] 全选
    await vi.waitFor(() => expect(plain()).toContain('目录内会话'), { timeout: 30_000 });
    await vi.waitFor(() => expect(plain()).toContain(`${SID}-a`), { timeout: 15_000 });
    expect(plain()).toContain(`${SID}-b`);
    tui.pressKey('a');
    await vi.waitFor(() => expect(plain()).toContain('已选 2 个'), { timeout: 5_000 });

    // Enter → 工具（批量提示）→ Enter 开跑
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('批量 2 个会话'), { timeout: 10_000 });
    tui.pressEnter();

    // 跑完 → 汇总（2 行），进详情再返回
    await vi.waitFor(() => expect(plain()).toContain('批量评分完成'), { timeout: 150_000 });
    expect(plain()).toContain(`${SID}-a`);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('评分结果'), { timeout: 10_000 });
    tui.pressEscape();

    // s 保存批量事件流（score-batch.jsonl，含两个会话的 meta）
    await vi.waitFor(() => expect(plain()).toContain('批量评分完成'), { timeout: 5_000 });
    tui.pressKey('s');
    await vi.waitFor(() => expect(plain()).toContain('已保存'), { timeout: 10_000 });
    const savedFile = path.join(TMP, 'save', 'score-batch.jsonl');
    expect(fs.existsSync(savedFile)).toBe(true);
    const evLines = fs.readFileSync(savedFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(evLines.filter(e => e.type === 'meta').length).toBe(2);

    // 清理批量导入的会话
    tui.unmount();
    await prisma.session.deleteMany({ where: { taskId: { in: [`${SID}-a`, `${SID}-b`] } } });
  });
});
