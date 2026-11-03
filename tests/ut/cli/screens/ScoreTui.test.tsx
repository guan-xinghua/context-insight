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

  it('无初始会话：会话清单 → 定位目标行 → Enter 进入工具选择', { timeout: 30_000 }, async () => {
    const tui = renderTui(<ScoreTui saveDir={path.join(TMP, 'save')} />);
    const plain = () => tui.getPlainText();

    await vi.waitFor(() => expect(plain()).toContain('选择会话'), { timeout: 15_000 });
    await vi.waitFor(() => expect(plain()).toContain(SID), { timeout: 15_000 });
    expect(plain()).toContain('Task ID');

    // ↓↓ 移动光标（清单按 startTime 倒序，移动只是确认交互生效：选中行变化）
    tui.pressDown();
    await vi.waitFor(() => expect(plain()).toContain('❯'), { timeout: 5_000 });
    tui.pressUp();

    tui.unmount();
  });
});
