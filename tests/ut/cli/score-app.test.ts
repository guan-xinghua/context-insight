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
  await prisma.session.deleteMany({ where: { taskId: { in: [SID, `${SID}-a`, `${SID}-b`, `${SID}-p`, `${SID}-x1`, `${SID}-x2`] } } }).catch(() => {});
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

/** 光标移到左栏某行（按 ❯ 落位；会话行的 id 在其下挂详情行，一并匹配。
 * 详情行规则仅对会话行生效（含 [ ]/[x]），避免工具区相邻行误匹配）*/
async function moveCursorTo(app: ScoreApp, rowText: string, maxSteps = 30): Promise<boolean> {
  // 只匹配左栏片段（测试渲染 160 列，左栏 ≤56 + 间隔 = 前 57 列）：整行是左右拼栏，
  // 光标行的右半边可能恰好出现目标文本（①待办列表/概览 id），整行匹配会假命中
  const LEFT = 57;
  for (let i = 0; i < maxSteps; i++) {
    const lines = plainOf(app).split('\n');
    for (let j = 0; j < lines.length; j++) {
      const cur = lines[j]?.slice(0, LEFT) ?? '';
      if (!cur.includes('❯')) continue;
      if (cur.includes(rowText)) return true;
      if (/\[[ x]\]/.test(cur) && (lines[j + 1] ?? '').slice(0, LEFT).includes(rowText)) return true;
    }
    down(app);
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

describe('Insight Score TUI（pi-tui 契约）', () => {
  it('双栏结构 + 全流程：勾选 → 运行 → 评分卡 → 自动落盘/[o]，Agent 工具可选', { timeout: 180_000 }, async () => {
    fs.rmSync(path.join(TMP, 'save'), { recursive: true, force: true });
    const app = mkApp(path.join(TMP, 'save'), path.join(TMP, 'work'));
    await vi.waitFor(() => expect(plainOf(app)).toContain('本机库已导入会话'), { timeout: 20_000 });
    const p0 = plainOf(app);
    for (const label of ['从目录选择', 'claude', 'opencode', '运行', '预览']) expect(p0).toContain(label);
    expect(p0).toContain('Insight Score');

    // Agent 工具可选（用户报障修复点）：↓ 到 opencode 行 → Enter → ● 切换
    expect(await moveCursorTo(app, '○ opencode')).toBe(true); // 带 ○ 前缀定位工具行（会话详情行的来源名不含 ○）
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

    // 自动落盘文件即事件流（mate 子项、维度）；状态行回显路径
    const savedFile = path.join(TMP, 'save', `${SID}.score.jsonl`);
    await vi.waitFor(() => expect(fs.existsSync(savedFile)).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(plainOf(app)).toContain('jsonl：'), { timeout: 5_000 });
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
    // 行主标签 = 首问；扫描发现两个夹具会话（共享同一条首问文本）
    await vi.waitFor(() => expect(plainOf(app)).toContain('会话 2/2'), { timeout: 30_000 });
    expect(plainOf(app).split('\n').filter(l => l.includes('乘法函数')).length).toBe(2);

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

    // 每会话独立事件流（meta+done+card 各就位；无批量聚合文件——自动落盘即唯一出口）
    expect(fs.existsSync(path.join(TMP, 'save', 'score-batch.jsonl'))).toBe(false);
    for (const sid of [`${SID}-a`, `${SID}-b`]) {
      const evs = fs.readFileSync(path.join(TMP, 'save', `${sid}.score.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(evs.filter(e => e.type === 'meta').length).toBe(1);
      expect(evs.filter(e => e.type === 'done' && e.card).length).toBe(1);
    }
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
    const cardLines = lines.filter(l => /│\s*(总分|D\d)/.test(l) && l.includes('▎'));
    expect(cardLines.length).toBeGreaterThanOrEqual(2);
    // 单元格列（终端真实列）：CJK 头宽度不同时字符列会差 1，单元格列才是对齐口径
    const barEndCell = (l: string): number => {
      let col = 0, last = -1;
      for (const ch of l) { if (ch === '▎' || ch === '┊') last = col; col += visibleWidth(ch); }
      return last;
    };
    const cols = cardLines.map(barEndCell);
    expect(new Set(cols).size).toBe(1);
    // ②已完成行：分数紧跟 10 格条 → 同口径存在
    const listLines = lines.filter(l => /[✓↺▤]/.test(l) && l.includes('┊'));
    expect(listLines.length).toBeGreaterThanOrEqual(1);
  });

  it('[O] 浏览器命令缺失不崩（wslview ENOENT 等）：异步 error 被吞、URL 仍回显', { timeout: 60_000 }, async () => {
    const saveP = path.join(TMP, 'save-p');
    const oldBrowser = process.env.SCORE_TUI_BROWSER;
    const oldNoOpen = process.env.SCORE_TUI_NO_OPEN;
    process.env.SCORE_TUI_BROWSER = '/nonexistent-browser-cmd'; // 强制全候选落空
    delete process.env.SCORE_TUI_NO_OPEN;
    try {
      const app = mkApp(saveP, path.join(TMP, 'work-o'));
      await vi.waitFor(() => expect(plainOf(app).split('\n').some(l => l.includes('↺'))), { timeout: 10_000 });
      app.handleInput('o');
      await new Promise(r => setTimeout(r, 400)); // 异步 ENOENT 事件窗口——此前未挂 handler 直接炸进程
      expect(plainOf(app)).toContain('127.0.0.1');
      expect(plainOf(app)).toContain('framework='); // 回载行的 framework 进 URL
      app.handleInput('q'); // 组件仍存活
    } finally {
      if (oldBrowser === undefined) delete process.env.SCORE_TUI_BROWSER; else process.env.SCORE_TUI_BROWSER = oldBrowser;
      if (oldNoOpen !== undefined) process.env.SCORE_TUI_NO_OPEN = oldNoOpen;
    }
  });

  it('窄终端不越框：任意宽度零超宽、零断裂 SGR（截断不落在色码内部）', { timeout: 60_000 }, async () => {
    const saveP = path.join(TMP, 'save-p');
    const app = mkApp(saveP, path.join(TMP, 'work6'));
    await vi.waitFor(() => expect(plainOf(app).split('\n').some(l => l.includes('↺'))), { timeout: 10_000 });
    app.handleInput('d');
    app.handleInput('\r');
    await vi.waitFor(() => expect(plainOf(app)).toContain('总分'), { timeout: 5_000 });
    // 断裂 SGR：截断切进 \x1b[..m 序列 → 终端把后续字符当 CSI 参数吞掉 → 排版崩
    for (const w of [60, 70, 80, 90, 100, 120, 160]) {
      for (const l of app.render(w)) {
        expect(visibleWidth(l)).toBeLessThanOrEqual(w);
        expect(l).not.toMatch(/\x1b\[[0-9;]*$/);
      }
    }
    // 窄宽下分数列仍对齐（条宽自适应收缩，分数列固定）
    const cellCol = (l: string): number => {
      let col = 0, last = -1;
      for (const ch of strip(l)) { if (ch === '▎' || ch === '┊') last = col; col += visibleWidth(ch); }
      return last;
    };
    for (const w of [90, 120]) {
      const cols = new Set(app.render(w)
        .filter(l => /(总分|D\d)/.test(strip(l)) && strip(l).includes('▎'))
        .map(cellCol));
      expect(cols.size).toBe(1);
    }
  });

  it('运行中：③概览可查（排队中标记）+ [X] 取消排队', { timeout: 240_000 }, async () => {
    // 慢速假 claude：拉出可操作窗口
    const fakeBin = path.join(TMP, 'bin');
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\nsleep 1.5\ncat <<'EOF'\n${JSON.stringify(FAKE_REVIEW)}\nEOF\n`, 'utf-8');
    try {
      for (const sid of [`${SID}-x1`, `${SID}-x2`]) {
        const fx = path.join(TMP, `${sid}.jsonl`);
        fs.writeFileSync(fx, LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
        await importSession(fx, sid, prisma, fx, 'claude-jsonl');
      }
      const app = mkApp(path.join(TMP, 'save-x'), path.join(TMP, 'workx'));
      await vi.waitFor(() => expect(plainOf(app)).toContain('本机库已导入会话'), { timeout: 20_000 });
      await vi.waitFor(() => expect(plainOf(app)).not.toContain('加载中'), { timeout: 20_000 }); // 会话装载完成（标签是静态的，不能只等它）
      // 过滤到两个夹具 → 全选 → 清过滤 → 运行
      app.handleInput('/');
      for (const ch of 'sid-x') app.handleInput(ch);
      app.handleInput('\r'); // Enter 退出过滤模式（保留文本；Esc 会清空）
      app.handleInput('t');
      await vi.waitFor(() => expect(plainOf(app)).toContain('已选 2'), { timeout: 5_000 });
      expect(await moveCursorTo(app, '开始评分')).toBe(true);
      app.handleInput('\r');
      await vi.waitFor(() => expect(plainOf(app)).toContain('⏳'), { timeout: 20_000 });
      // 回左栏浏览第二个排队会话 → ③概览 + 排队中标记（W×2 跳回会话区——启动后光标在运行行）
      app.handleInput('a');
      app.handleInput('w'); app.handleInput('w');
      expect(await moveCursorTo(app, 'sid-x2')).toBe(true);
      await vi.waitFor(() => expect(plainOf(app)).toContain('概览（光标会话）'), { timeout: 5_000 });
      expect(plainOf(app)).toContain('排队中');
      expect(plainOf(app)).toContain('[X] 取消');
      // 取消 x2 → 只评 x1
      app.handleInput('x');
      await vi.waitFor(() => expect(plainOf(app)).toContain('队列已完成'), { timeout: 60_000 });
      await vi.waitFor(() => expect(plainOf(app)).toContain('已完成（1/1）'), { timeout: 10_000 });
      expect(fs.existsSync(path.join(TMP, 'save-x', `${SID}-x1.score.jsonl`))).toBe(true);
      await vi.waitFor(() => expect(fs.existsSync(path.join(TMP, 'save-x', `${SID}-x2.score.jsonl`))).toBe(false), { timeout: 3_000 });
      await prisma.session.deleteMany({ where: { taskId: { in: [`${SID}-x1`, `${SID}-x2`] } } });
    } finally {
      // 恢复快速假 claude
      fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(FAKE_REVIEW)}\nEOF\n`, 'utf-8');
    }
  });
});
