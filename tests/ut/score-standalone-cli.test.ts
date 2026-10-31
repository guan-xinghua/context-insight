// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS OR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 独立 mate 评分 CLI IT：jsonl 夹具 → importSession 入库 → PATH 上放假 claude
// （回固定 items JSON）→ ctxi score 全流程 → NDJSON 事件流与落盘断言。
// 验证「不依赖服务进程、不依赖 LLM API」的独立执行路径。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service';
import { scoreCommand } from '../../src/cli/commands/score';

const prisma = new PrismaClient();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'score-cli-it-'));
const SID = 'score-cli-it-sid';

interface Line { type: string; message: Record<string, unknown>; timestamp: string; [k: string]: unknown }

const BASE = '2026-10-31T10:00:00.000Z';
let ts = 0;
const stamp = () => new Date(new Date(BASE).getTime() + ts++ * 1000).toISOString();

const userText = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text }, timestamp: stamp() });
function toolUse(id: string, name: string, input: Record<string, unknown>): Line {
  return {
    type: 'assistant',
    message: {
      id: `msg_${id}`, role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    timestamp: stamp(),
  };
}
const toolResult = (id: string, content: string): Line => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  timestamp: stamp(),
});

const LINES: Line[] = [
  userText('给 utils 加一个加法函数并跑测试验证'),
  toolUse('t01', 'Read', { file_path: '/repo/src/utils.ts' }), toolResult('t01', '1\t// utils'),
  toolUse('t02', 'Edit', { file_path: '/repo/src/utils.ts', old_string: 'a', new_string: 'export const add = (a,b) => a+b' }), toolResult('t02', 'ok'),
  toolUse('t03', 'Bash', { command: 'npm test' }), toolResult('t03', 'Tests 10 passed | 0 failed'),
];

// 假 claude：对任何 prompt 回一份带顶层 items 的评审 JSON（单维运行按 parsed.items 取）
const FAKE_REVIEW = {
  summary: 'fake mate review',
  items: [
    { itemId: 'D1.goalCoverage', verdict: 'partial', score: 0.6, note: 'fake-goal' },
    { itemId: 'D1.acceptance', verdict: 'clean', score: 1, note: 'fake-accept' },
    { itemId: 'D2.redlines', verdict: 'clean', note: 'fake-redline' },
    { itemId: 'D3.correctness', verdict: 'partial', score: 0.9, note: 'fake-correct' },
    { itemId: 'D5.proficiency', verdict: 'clean', score: 0.8, note: 'fake-prof' },
    { itemId: 'D6.classification', verdict: 'clean', note: 'fake-class' },
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
  const script = path.join(fakeBin, 'claude');
  fs.writeFileSync(script, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(FAKE_REVIEW)}\nEOF\n`, 'utf-8');
  fs.chmodSync(script, 0o755);
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

function readNdjson(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}

describe('ctxi score（独立 mate 评分 CLI）', () => {
  it('全流程：规则层 + fake mate 合卡 → NDJSON 事件流（meta/progress/done）+ 落盘', async () => {
    const out = path.join(TMP, 'out.jsonl');
    const cmd = scoreCommand();
    await cmd.parseAsync(['--session', SID, '--tool', 'claude', '--out', out,
      '--workdir', path.join(TMP, 'work'), '--concurrency', '2'], { from: 'user' });

    expect(process.exitCode ?? 0).toBe(0);
    const events = readNdjson(out);
    const types = events.map(e => String(e.type));

    expect(types[0]).toBe('meta');
    expect(events[0].taskId).toBe(SID);
    expect(events[0].tool).toBe('claude');
    expect(events[0].scorerVersion).toBeTruthy();
    // 进度事件：每维一条（默认口径 5 个 mate 维度）
    expect(types.filter(t => t === 'progress').length).toBeGreaterThanOrEqual(5);
    expect(types[types.length - 1]).toBe('done');

    // mate 项合并进卡（fake 分数体现）；规则层项同卡共存
    const card = events[events.length - 1].card as {
      dimensions: Array<{ id: string; items: Array<{ itemId: string; score?: number | null; verdict?: string | null; note?: string | null }> }>;
    };
    const items = card.dimensions.flatMap(d => d.items);
    const correctness = items.find(i => i.itemId === 'D3.correctness');
    expect(correctness?.note).toBe('fake-correct');
    const goal = items.find(i => i.itemId === 'D1.goalCoverage');
    expect(goal?.note).toBe('fake-goal');

    // 卡落盘（默认行为；--no-store 用例另行验证不落盘）
    const stored = fs.readdirSync(path.join(TMP, 'scorecards'));
    expect(stored.some(f => f.endsWith('.json'))).toBe(true);

    // 物料切片临时目录用完即清（运行叶子目录全清；保留的 taskId 父目录必须为空）
    const workRoot = path.join(TMP, 'work');
    const workEntries = fs.existsSync(workRoot) ? fs.readdirSync(workRoot) : [];
    for (const e of workEntries) {
      expect(fs.readdirSync(path.join(workRoot, e)).length).toBe(0);
    }
  }, 120_000);

  it('会话不存在 → error 事件 + 退出码 1，不写半截产物', async () => {
    const out = path.join(TMP, 'err.jsonl');
    const cmd = scoreCommand();
    await cmd.parseAsync(['--session', 'no-such-session', '--tool', 'claude', '--out', out], { from: 'user' });
    expect(process.exitCode).toBe(1);
    const events = readNdjson(out);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('error');
    expect(String(events[0].message)).toContain('no-such-session');
    process.exitCode = undefined;
  });

  it('--no-store：不落评分卡库', async () => {
    const storeDir = path.join(TMP, 'scorecards');
    const before = fs.readdirSync(storeDir).length;
    const cmd = scoreCommand();
    await cmd.parseAsync(['--session', SID, '--tool', 'claude',
      '--out', path.join(TMP, 'out2.jsonl'), '--workdir', path.join(TMP, 'work'), '--no-store'], { from: 'user' });
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readdirSync(storeDir).length).toBe(before);
  }, 120_000);
});
