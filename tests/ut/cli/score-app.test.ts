// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Insight Score TUI IT（pi-tui 版，契约测试：render/handleInput 直调，零渲染替身）
// jsonl 夹具入库 + PATH 假 claude → 左栏勾选 → 运行 → 右栏评分卡 → [o]/[b]；目录批量；重开回载；
// Agent 工具可选；分数列对齐。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../../src/lib/ingest/data-service';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ScoreApp } from '../../../src/cli/tui/score/app';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'score-app-it-'));
const SID = 'score-app-it-sid';

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
  fs.writeFileSync(path.join(fakeBin, 'opencode'), '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.chmodSync(path.join(fakeBin, 'opencode'), 0o755);
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

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
function mkApp(saveDir: string, workdir: string): ScoreApp {
  const app = new ScoreApp({
    cols: () => 160,
    rows: () => 40,
    requestRender: () => {},
    onQuit: () => {},
    props: { saveDir, workdir },
  });
  app.init();
  return app;
}
const plainOf = (app: ScoreApp) => strip(app.render(160).join('\n'));
const down = (app: ScoreApp) => app.handleInput('\x1b[B');

/** 光标移到左栏某行（按 ❯ 落位）*/
async function moveCursorTo(app: ScoreApp, rowText: string, maxSteps = 30): Promise<boolean> {
  for (let i = 0; i < maxSteps; i++) {
    if (plainOf(app).split('\n').some(l => l.includes('❯') && l.includes(rowText))) return true;
    down(app);
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

describe('Insight Score TUI（pi-tui 契约）', () => {
  it('双栏结构 + 全流程：勾选 → 运行 → 评分卡 → [b]/[o]，Agent 工具可选', { timeout: 180_000 }, async () => {
    fs.rmSync(path.join(TMP, 'save'), { recursive: true, force: true });
    const app = mkApp(path.join(TMP, 'save'), path.join(TMP, 'work'));
    await vi.waitFor(() => expect(plainOf(app)).toContain('本机库已导入会话'), { timeout: 20_000 });
    const p0 = plainOf(app);
    for (const label of ['从目录选择', 'claude', 'opencode', '运行', '预览']) expect(p0).toContain(label);
    expect(p0).toContain('Insight Score');

    // Agent 工具可选（用户报障修复点）：↓ 到 opencode 行 → Enter → ● 切换
    expect(await moveCursorTo(app, 'opencode')).toBe(true);
    app.handleInput('\r');
    const pTool = plainOf(app);
    expect(pTool.split('\n').some(l => l.includes('● opencode'))).toBe(true);
    expect(pTool.split('\n').some(l => l.includes('○ claude'))).toBe(true);
    app.handleInput('\x1b[A'); // ↑ 回 claude 行 → Enter 切回（后续评分走假 claude）
    app.handleInput('\r');
    expect(plainOf(app).split('\n').some(l => l.includes('● claude'))).toBe(true);

    // 勾选目标会话 → 运行（W 跳回会话区，向下走到夹具行——库内可能有他序会话）
    app.handleInput('w');
    expect(await moveCursorTo(app, SID)).toBe(true);
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('[x]'), { timeout: 5_000 });
    expect(await moveCursorTo(app, '开始评分')).toBe(true);
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('⏳'), { timeout: 20_000 });
    await vi.waitFor(() => expect(plainOf(app)).toContain('队列已完成'), { timeout: 150_000 });
    await vi.waitFor(() => expect(plainOf(app)).toContain('已完成（1/1）'), { timeout: 10_000 });

    // 默认落盘：未按 [b] 先存在
    await vi.waitFor(() => expect(fs.existsSync(path.join(TMP, 'save', `${SID}.score.jsonl`))).toBe(true), { timeout: 10_000 });

    // ② Enter 载入③评分卡 → [o] 跳转回显
    app.handleInput('d');
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('总分'), { timeout: 5_000 });
    app.handleInput('o');
    await vi.waitFor(() => expect(plainOf(app)).toContain('127.0.0.1'), { timeout: 5_000 });

    // [b] 保存事件流 → 文件断言评分卡内容（mate 子项、维度）
    app.handleInput('b');
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

    // 帧契约：行数/行宽恒定，框成对
    const lines = app.render(160);
    expect(lines.length).toBeLessThanOrEqual(40);
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(160);
    }
    const joins = strip(lines.join('\n'));
    expect((joins.match(/╭/g) ?? []).length).toBe((joins.match(/╰/g) ?? []).length);
  });

  it('目录批量：切目录来源 → 手输路径 → 扫描 → 全选 → 批量汇总（逐会话落盘）', { timeout: 240_000 }, async () => {
    const dir = path.join(TMP, 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    for (const sid of [`${SID}-a`, `${SID}-b`]) {
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
    }
    const app = mkApp(path.join(TMP, 'save'), path.join(TMP, 'work2'));
    await vi.waitFor(() => expect(plainOf(app)).toContain('本机库已导入会话'), { timeout: 20_000 });

    // 切到目录来源（首行=本机库 → ↓ 到从目录选择 → Enter）
    down(app);
    await vi.waitFor(() => expect(plainOf(app).split('\n').some(l => l.includes('❯') && l.includes('从目录选择'))), { timeout: 5_000 });
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('手动输入路径'), { timeout: 5_000 });

    // 手动输入项 → Enter 输入模式 → 键入路径 → Enter 扫描
    expect(await moveCursorTo(app, '手动输入路径')).toBe(true);
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('路径:'), { timeout: 5_000 });
    for (const ch of dir) app.handleInput(ch);
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('sid-a'), { timeout: 30_000 });
    expect(plainOf(app)).toContain('sid-b');

    // [t] 全选 → 运行
    app.handleInput('t');
    await vi.waitFor(() => expect(plainOf(app)).toContain('已选 2'), { timeout: 5_000 });
    expect(await moveCursorTo(app, '开始评分')).toBe(true);
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('队列已完成'), { timeout: 200_000 });
    await new Promise(r => setTimeout(r, 200));
    // 批量默认落盘：每会话各一份（含卡可回载）
    await vi.waitFor(() => expect(fs.existsSync(path.join(TMP, 'save', `${SID}-a.score.jsonl`))).toBe(true), { timeout: 10_000 });
    expect(fs.existsSync(path.join(TMP, 'save', `${SID}-b.score.jsonl`))).toBe(true);

    // [b] 批量事件流
    app.handleInput('b');
    const batchFile = path.join(TMP, 'save', 'score-batch.jsonl');
    await vi.waitFor(() => expect(fs.existsSync(batchFile)).toBe(true), { timeout: 10_000 });
    const evs = fs.readFileSync(batchFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(evs.filter(e => e.type === 'meta').length).toBe(2);
    expect(evs.filter(e => e.type === 'done').length).toBe(2);
    expect(evs.filter(e => e.type === 'done' && e.card).length).toBe(2);
  });

  it('结果持久化：重开回载（↺ 行 → Enter 评分卡 → [o] 带 framework）', { timeout: 240_000 }, async () => {
    const sid = `${SID}-p`;
    const saveP = path.join(TMP, 'save-p');
    fs.rmSync(saveP, { recursive: true, force: true });
    const fixture = path.join(TMP, `${sid}.jsonl`);
    fs.writeFileSync(fixture, LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
    await importSession(fixture, sid, prisma, fixture, 'claude-jsonl');

    const t1 = mkApp(saveP, path.join(TMP, 'work3'));
    await vi.waitFor(() => expect(plainOf(t1)).toContain('本机库已导入会话'), { timeout: 20_000 });
    expect(await moveCursorTo(t1, sid)).toBe(true);
    t1.handleInput('\r');
    await new Promise(r => setTimeout(r, 200));
    expect(await moveCursorTo(t1, '开始评分')).toBe(true);
    t1.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(t1)).toContain('队列已完成'), { timeout: 200_000 });
    await vi.waitFor(() => expect(fs.existsSync(path.join(saveP, `${sid}.score.jsonl`))).toBe(true), { timeout: 10_000 });

    // 第二次打开：↺ 历史行直接可见（idle 也呈现三段式）
    const t2 = mkApp(saveP, path.join(TMP, 'work4'));
    await vi.waitFor(() => expect(plainOf(t2).split('\n').some(l => l.includes('↺') && l.includes(sid))).toBe(true), { timeout: 10_000 });
    expect(plainOf(t2)).toContain('已完成（1/1）');
    t2.handleInput('d');
    t2.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(t2)).toContain('总分'), { timeout: 5_000 });
    t2.handleInput('o');
    await vi.waitFor(() => expect(plainOf(t2)).toContain('framework='), { timeout: 5_000 });

    await prisma.session.deleteMany({ where: { taskId: sid } });
  });

  it('分数列对齐：总分/维度/②列表的分数右对齐在同一列', { timeout: 60_000 }, async () => {
    const saveP = path.join(TMP, 'save-p');
    const app = mkApp(saveP, path.join(TMP, 'work5'));
    await vi.waitFor(() => expect(plainOf(app).split('\n').some(l => l.includes('↺'))), { timeout: 10_000 });
    app.handleInput('d');
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('总分'), { timeout: 5_000 });
    const lines = plainOf(app).split('\n');
    // 评分卡行（总分 + 维度 D*）：分数区右锚定 → 最后一个 ░ 后同列
    const cardLines = lines.filter(l => /│\s*(总分|D\d)/.test(l) && l.includes('█'));
    expect(cardLines.length).toBeGreaterThanOrEqual(2);
    // 单元格列（终端真实列）：CJK 头宽度不同时字符列会差 1，单元格列才是对齐口径
    const barEndCell = (l: string): number => {
      let col = 0, last = -1;
      for (const ch of l) { if (ch === '█' || ch === '░') last = col; col += visibleWidth(ch); }
      return last;
    };
    const cols = cardLines.map(barEndCell);
    expect(new Set(cols).size).toBe(1);
    // ②已完成行：分数紧跟 10 格条 → 同口径存在
    const listLines = lines.filter(l => /[✓↺▤]/.test(l) && l.includes('░'));
    expect(listLines.length).toBeGreaterThanOrEqual(1);
  });
});
