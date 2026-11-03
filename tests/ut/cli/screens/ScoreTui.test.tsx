// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Insight Score TUI IT（左配置/右输出统一双栏）：jsonl 夹具入库 + PATH 假 claude
// → 左栏勾选会话 → 运行 → 右栏评分卡 → [o] 跳转 URL / [s] 落盘；目录批量流。
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
  SCORE_TUI_NO_OPEN: '1',
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
  await prisma.session.deleteMany({ where: { taskId: { in: [SID, `${SID}-a`, `${SID}-b`] } } }).catch(() => {});
  await prisma.$disconnect();
  for (const [k, v] of Object.entries(OLD_ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  process.env.PATH = OLD_PATH;
  process.exitCode = undefined;
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 移动光标到左栏某行（按帧等 ❯ 落位，规避同 tick 闭包旧状态） */
async function moveCursorTo(tui: ReturnType<typeof renderTui>, plain: () => string, rowText: string, maxSteps = 30) {
  for (let i = 0; i < maxSteps; i++) {
    const lines = plain().split('\n');
    if (lines.some(l => l.includes('❯') && l.includes(rowText))) return true;
    tui.pressDown();
    await new Promise(r => setTimeout(r, 30));
  }
  return false;
}

describe('Insight Score TUI（左配置 / 右输出）', () => {
  it('双栏常驻：左栏分区齐备，右栏待运行预览；勾选 → 运行 → 右栏评分卡 → [o]/[s]', { timeout: 180_000 }, async () => {
    const tui = renderTui(<ScoreTui saveDir={path.join(TMP, 'save')} workdir={path.join(TMP, 'work')} />);
    const plain = () => tui.getPlainText();

    // 双栏结构与左栏分区
    await vi.waitFor(() => expect(plain()).toContain('本机库已导入会话'), { timeout: 20_000 });
    for (const label of ['从目录选择', 'Agent 工具', 'claude', '运行', '待运行']) {
      expect(plain()).toContain(label);
    }
    expect(plain()).toContain('Insight 会话独立评分');
    expect(plain()).toContain('[o] 评分页面');

    // 勾选目标会话（光标移到该行 → Enter）
    expect(await moveCursorTo(tui, plain, SID)).toBe(true);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('[x]'), { timeout: 5_000 });
    // 右栏预览同步
    await vi.waitFor(() => expect(plain()).toContain('已选 1 个'), { timeout: 5_000 });

    // 运行行 → Enter 开跑
    expect(await moveCursorTo(tui, plain, '开始评分')).toBe(true);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('评分中'), { timeout: 20_000 });
    // 完成 → 右栏评分卡（定高窗口：W/S 滚动到中下部看子项备注）
    await vi.waitFor(() => expect(plain()).toContain('总分'), { timeout: 150_000 });
    expect(plain()).toContain('D1');
    let sawNote = false;
    for (let i = 0; i < 24 && !sawNote; i++) {
      if (plain().includes('tui-correct')) { sawNote = true; break; }
      tui.pressKey('s'); // 右栏焦点：s = 下滚
      await new Promise(r => setTimeout(r, 30));
    }
    expect(sawNote).toBe(true);

    // [o] 跳转 URL（SCORE_TUI_NO_OPEN=1 只回显不 spawn）
    tui.pressKey('o');
    await vi.waitFor(() => expect(plain()).toContain('/scoring/'), { timeout: 5_000 });
    expect(plain()).toContain('127.0.0.1');

    // [b] 保存事件流（s/S 均为 WASD 下移）
    tui.pressKey('b');
    await vi.waitFor(() => expect(plain()).toContain('jsonl：'), { timeout: 5_000 });
    const saved = fs.readdirSync(path.join(TMP, 'save'));
    expect(saved.some(f => f.endsWith('.score.jsonl'))).toBe(true);

    tui.unmount();
  });

  it('目录批量：切目录来源 → 手输路径 → 扫描 → 全选 → 运行 → 批量汇总', { timeout: 240_000 }, async () => {
    const dir = path.join(TMP, 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    for (const sid of [`${SID}-a`, `${SID}-b`]) {
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
    }

    const tui = renderTui(<ScoreTui saveDir={path.join(TMP, 'save')} workdir={path.join(TMP, 'work2')} />);
    const plain = () => tui.getPlainText();

    await vi.waitFor(() => expect(plain()).toContain('从目录选择'), { timeout: 20_000 });
    // 切到目录来源（光标在第一行=本机库，↓ 到从目录选择 → Enter）
    tui.pressDown();
    await vi.waitFor(() => expect(plain().split('\n').some(l => l.includes('❯') && l.includes('从目录选择'))), { timeout: 5_000 });
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('手动输入路径'), { timeout: 5_000 });

    // 手动输入项（目录分区首行）→ Enter 输入模式 → 键入路径 → Enter 扫描
    expect(await moveCursorTo(tui, plain, '手动输入路径')).toBe(true);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('路径（Enter 扫描）'), { timeout: 5_000 });
    for (const ch of dir) tui.pressKey(ch);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain(`${SID}-a`), { timeout: 30_000 });
    expect(plain()).toContain(`${SID}-b`);

    // [t] 全选 → 运行行 → Enter（a/A 均为 WASD 左栏）
    tui.pressKey('t');
    await vi.waitFor(() => expect(plain()).toContain('已选 2'), { timeout: 5_000 });
    expect(await moveCursorTo(tui, plain, '开始评分')).toBe(true);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('批量完成'), { timeout: 200_000 });
    expect(plain()).toContain('2/2 成功');

    tui.unmount();
    await prisma.session.deleteMany({ where: { taskId: { in: [`${SID}-a`, `${SID}-b`] } } });
  });
});
