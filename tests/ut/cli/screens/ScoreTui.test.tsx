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
  await prisma.session.deleteMany({ where: { taskId: { in: [SID, `${SID}-a`, `${SID}-b`, `${SID}-p`] } } }).catch(() => {});
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
    fs.rmSync(path.join(TMP, 'save'), { recursive: true, force: true });
    const tui = renderTui(<ScoreTui saveDir={path.join(TMP, 'save')} workdir={path.join(TMP, 'work')} />);
    const plain = () => tui.getPlainText();

    // 双栏结构与左栏分区
    await vi.waitFor(() => expect(plain()).toContain('本机库已导入会话'), { timeout: 20_000 });
    for (const label of ['从目录选择', 'Agent 工具', 'claude', '运行', '预览']) {
      expect(plain()).toContain(label);
    }
    expect(plain()).toContain('Insight Score');
    expect(plain()).toContain('[o] 评分页面');

    // 勾选目标会话（光标移到该行 → Enter）
    expect(await moveCursorTo(tui, plain, SID)).toBe(true);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('[x]'), { timeout: 5_000 });
    // 右栏预览同步
    await vi.waitFor(() => expect(plain()).toContain('已选 1 个'), { timeout: 5_000 });

    // 运行行 → Enter 开跑（焦点自动去右栏）
    expect(await moveCursorTo(tui, plain, '开始评分')).toBe(true);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('⏳'), { timeout: 20_000 });
    // 完成：①队列显示已完成，②有结果行（评分卡③为手动载入）
    await vi.waitFor(() => expect(plain()).toContain('队列已完成'), { timeout: 150_000 });
    await vi.waitFor(() => expect(plain()).toContain('1/1'), { timeout: 10_000 }); // ②列表头（成功/总分）
    // 默认落盘：完成即写 <taskId>.score.jsonl（未按 [b] 先存在）
    await vi.waitFor(() => expect(fs.existsSync(path.join(TMP, 'save', `${SID}.score.jsonl`))).toBe(true), { timeout: 10_000 });
    // ②中 Enter 载入③评分卡（帧渲染在测试环境有伪影，评分卡内容走文件断言）
    tui.pressEnter();
    await new Promise(r => setTimeout(r, 100));

    // [b] 保存事件流 → 从文件断言评分卡内容（mate 子项、维度）
    tui.pressKey('b');
    const savedFile = path.join(TMP, 'save', `${SID}.score.jsonl`);
    await vi.waitFor(() => expect(fs.existsSync(savedFile)).toBe(true), { timeout: 10_000 });
    const evLines = fs.readFileSync(savedFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(evLines[0].type).toBe('meta');
    expect(evLines.some(e => e.type === 'progress')).toBe(true);
    const done = evLines.find(e => e.type === 'done') as { card: { dimensions: Array<{ dimensionId: string; items: Array<{ itemId: string; note?: string }> }> } };
    expect(done).toBeTruthy();
    const items = done.card.dimensions.flatMap(d => d.items);
    expect(items.find(i => i.itemId === 'D3.correctness')?.note).toBe('tui-correct');
    expect(done.card.dimensions.some(d => d.dimensionId === 'D1')).toBe(true);

    // [o] 跳转 URL 回显（SCORE_TUI_NO_OPEN=1 不 spawn）
    tui.pressKey('o');
    await vi.waitFor(() => expect(plain()).toContain('127.0.0.1'), { timeout: 5_000 });

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
    await vi.waitFor(() => expect(plain()).toContain('路径:'), { timeout: 5_000 });
    for (const ch of dir) tui.pressKey(ch);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('sid-a'), { timeout: 30_000 });
    expect(plain()).toContain('sid-b');

    // [t] 全选 → 运行行 → Enter（a/A 均为 WASD 左栏）
    tui.pressKey('t');
    await vi.waitFor(() => expect(plain()).toContain('已选 2'), { timeout: 5_000 });
    expect(await moveCursorTo(tui, plain, '开始评分')).toBe(true);
    tui.pressEnter();
    await vi.waitFor(() => expect(plain()).toContain('队列已完成'), { timeout: 200_000 });
    await new Promise(r => setTimeout(r, 200));
    // 批量默认落盘：每个会话各自写 <taskId>.score.jsonl（含卡可回载）
    await vi.waitFor(() => expect(fs.existsSync(path.join(TMP, 'save', `${SID}-a.score.jsonl`))).toBe(true), { timeout: 10_000 });
    expect(fs.existsSync(path.join(TMP, 'save', `${SID}-b.score.jsonl`))).toBe(true);
    // [b] 批量事件流：两个会话的 meta/done 各就位（帧断言在测试环境有伪影，走文件）
    tui.pressKey('b');
    const batchFile = path.join(TMP, 'save', 'score-batch.jsonl');
    await vi.waitFor(() => expect(fs.existsSync(batchFile)).toBe(true), { timeout: 10_000 });
    const evs = fs.readFileSync(batchFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(evs.filter(e => e.type === 'meta').length).toBe(2);
    expect(evs.filter(e => e.type === 'done').length).toBe(2);
    expect((evs.filter(e => e.type === 'done') as Array<{ card: unknown }>).filter(e => e.card).length).toBe(2);

    tui.unmount();
    await prisma.session.deleteMany({ where: { taskId: { in: [`${SID}-a`, `${SID}-b`] } } });
  });

  it('结果持久化：完成即默认落盘 → 重开 TUI 回载历史（↺ 行 → Enter 评分卡 → [o] 带 framework）', { timeout: 240_000 }, async () => {
    const sid = `${SID}-p`;
    const saveP = path.join(TMP, 'save-p');
    fs.rmSync(saveP, { recursive: true, force: true });
    const fixture = path.join(TMP, `${sid}.jsonl`);
    fs.writeFileSync(fixture, LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
    await importSession(fixture, sid, prisma, fixture, 'claude-jsonl');

    // 第一次：评分 → 自动落盘
    const t1 = renderTui(<ScoreTui saveDir={saveP} workdir={path.join(TMP, 'work3')} />);
    const p1 = () => t1.getPlainText();
    await vi.waitFor(() => expect(p1()).toContain('本机库已导入会话'), { timeout: 20_000 });
    expect(await moveCursorTo(t1, p1, sid)).toBe(true);
    t1.pressEnter();
    await new Promise(r => setTimeout(r, 300));
    expect(await moveCursorTo(t1, p1, '开始评分')).toBe(true);
    t1.pressEnter();
    await vi.waitFor(() => expect(p1()).toContain('队列已完成'), { timeout: 200_000 });
    await vi.waitFor(() => expect(fs.existsSync(path.join(saveP, `${sid}.score.jsonl`))).toBe(true), { timeout: 10_000 });
    t1.unmount();

    // 第二次打开：②已完成直接可见 ↺ 历史行（idle 态也呈现三段式）
    const t2 = renderTui(<ScoreTui saveDir={saveP} workdir={path.join(TMP, 'work4')} />);
    const p2 = () => t2.getPlainText();
    await vi.waitFor(() => expect(p2().split('\n').some(l => l.includes('↺') && l.includes(sid))).toBe(true), { timeout: 10_000 });
    expect(p2()).toContain('已完成（1/1）');
    // 聚焦右栏 → Enter 载入评分卡 → 总分行可见
    t2.pressKey('d');
    await new Promise(r => setTimeout(r, 100));
    t2.pressEnter();
    await vi.waitFor(() => expect(p2()).toContain('总分'), { timeout: 10_000 });
    // [o] 跳转 URL：framework 取自落盘 meta
    t2.pressKey('o');
    await vi.waitFor(() => expect(p2()).toContain('framework='), { timeout: 5_000 });

    t2.unmount();
    await prisma.session.deleteMany({ where: { taskId: sid } });
  });
});
