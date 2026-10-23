// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基准测试填报端到端 IT：算子 fixture 导入 → 填报 API → scorecard 重算 →
// D3「基准测试评分」子项按填报值折算（未填默认 80 持平档、非算子不适用、边界 clamp）。

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service';
import { NextRequest } from 'next/server';
import { runScorecard } from '../../src/lib/scoring/core/runner';
import { FileScorecardStore } from '../../src/lib/scoring/core/store';
import { benchToScore10 } from '../../src/lib/scoring/core/bench-report/session-bench-report';

const prisma = new PrismaClient();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-benchreport-'));
process.env.SCORING_DATA_DIR = path.join(TMP, 'api-store');
process.env.SCORING_BASELINE_DIR = path.join(TMP, 'baselines');
process.env.SCORING_BENCH_REPORT_DIR = path.join(TMP, 'bench-reports');
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');
const store = new FileScorecardStore(path.join(TMP, 'scorecards'));

const SID_OP = 'opbench-operator';
const SID_GENERAL = 'opbench-general';

interface Line { type: string; message: Record<string, unknown>; timestamp: string; [k: string]: unknown }

const BASE = '2026-09-07T10:00:00.000Z';
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

// 算子任务：写入 ops/ 目录（task-classifier 路径启发 → operator）
const OP_LINES: Line[] = [
  userText('实现 Add 算子'),
  toolUse('t01', 'Read', { file_path: '/repo/ops/add/op_add.cc' }), toolResult('t01', '1\t// add'),
  toolUse('t02', 'Write', { file_path: '/repo/ops/add/op_add.cc', content: 'extern "C" int add(int a, int b) { return a + b; }' }), toolResult('t02', 'ok'),
  toolUse('t03', 'Bash', { command: 'pytest tests/' }), toolResult('t03', '3 passed'),
];

// 普通任务：写入普通路径（→ general）
const GENERAL_LINES: Line[] = [
  userText('改一下 README'),
  toolUse('t11', 'Write', { file_path: '/repo/docs/guide.md', content: '# guide' }), toolResult('t11', 'ok'),
];

const writeFixture = (name: string, lines: Line[]): string => {
  const file = path.join(TMP, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
};

async function importFixture(taskId: string, file: string) {
  await prisma.session.deleteMany({ where: { taskId } });
  await importSession(file, taskId, prisma, file, 'claude-jsonl');
}

const d3Item = (card: NonNullable<Awaited<ReturnType<typeof runScorecard>>>, itemId: string) =>
  card.dimensions.find(d => d.dimensionId === 'D3')!.items.find(i => i.itemId === itemId)!;

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [SID_OP, SID_GENERAL] } } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('折算：百分制 → 0-10（连续，不吸档）', () => {
  it('87 → 8.7；0 → 0；100 → 10；越界 clamp', () => {
    expect(benchToScore10(87)).toBe(8.7);
    expect(benchToScore10(0)).toBe(0);
    expect(benchToScore10(100)).toBe(10);
    expect(benchToScore10(150)).toBe(10);
    expect(benchToScore10(-5)).toBe(0);
  });
});

const route = await import('../../src/app/api/observe/session/scorecard/bench-report/route');

describe('端到端：填报 → 重算 → D3 基准测试评分', { timeout: 60_000 }, () => {

  it('算子任务未填报：默认持平分 0.8 并明标', async () => {
    await importFixture(SID_OP, writeFixture(SID_OP, OP_LINES));
    const card = await runScorecard(SID_OP, prisma, { store });
    expect(card!.taskType).toBe('operator');
    const item = d3Item(card!, 'D3.benchScore');
    expect(item.status).toBe('ok');
    expect(item.score).toBe(0.8);
    expect(item.formula).toContain('默认 80');
    expect(item.note).toContain('未填报');
  });

  it('非算子任务：不适用（无法评判）', async () => {
    await importFixture(SID_GENERAL, writeFixture(SID_GENERAL, GENERAL_LINES));
    const card = await runScorecard(SID_GENERAL, prisma, { store });
    expect(card!.taskType).toBe('general');
    const item = d3Item(card!, 'D3.benchScore');
    expect(item.status).toBe('not-applicable');
    expect(item.note).toContain('非算子类任务');
  });

  it('API：非法 score 400；合法写入后重算体现填报值', async () => {
    const bad = await route.POST(new NextRequest('http://localhost/api/observe/session/scorecard/bench-report', {
      method: 'POST',
      body: JSON.stringify({ taskId: SID_OP, score: 120 }),
    }));
    expect(bad.status).toBe(400);

    const missing = await route.POST(new NextRequest('http://localhost/api/observe/session/scorecard/bench-report', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'no-such', score: 90 }),
    }));
    expect(missing.status).toBe(404);

    const saved = await route.POST(new NextRequest('http://localhost/api/observe/session/scorecard/bench-report', {
      method: 'POST',
      body: JSON.stringify({ taskId: SID_OP, score: 87, note: 'Add / leaderboard' }),
    }));
    expect(saved.status).toBe(200);

    const get = await route.GET(new NextRequest(`http://localhost/api/observe/session/scorecard/bench-report?taskId=${SID_OP}`));
    const data = await get.json() as { score: number | null; note: string | null };
    expect(data.score).toBe(87);
    expect(data.note).toBe('Add / leaderboard');

    const card = await runScorecard(SID_OP, prisma, { store });
    const item = d3Item(card!, 'D3.benchScore');
    expect(item.status).toBe('ok');
    expect(item.value).toBe(8.7);
    expect(item.score).toBe(0.87);
    expect(item.formula).toContain('87/100');
    expect(item.formula).toContain('8.7/10');
    expect(item.note).toBe('Add / leaderboard');
  });

  it('旧目录旧 schema 存量填报：GET 读兜底命中，保存即落新目录（无感迁移）', async () => {
    // 模拟升级现场：新目录无文件，旧目录（op-benchmarks/，旧 schema）有存量填报。
    // 填报文件按 Prisma Session.id 命名（与 taskId 不同），先解析真实 id
    const sess = await prisma.session.findFirst({ where: { taskId: SID_OP }, select: { id: true } });
    const sid = sess!.id;
    fs.rmSync(path.join(process.env.SCORING_BENCH_REPORT_DIR!, `${sid}.json`), { force: true });
    const legacyDir = path.join(process.env.SCORING_DATA_DIR!, 'op-benchmarks');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, `${sid}.json`), JSON.stringify({
      schema: 'workflow-session-op-bench', version: 1, sessionId: sid, score: 90, note: '存量填报', filledAt: '2026-09-01T00:00:00.000Z',
    }));

    const legacy = await route.GET(new NextRequest(`http://localhost/api/observe/session/scorecard/bench-report?taskId=${SID_OP}`));
    const legacyData = await legacy.json() as { score: number | null; note: string | null };
    expect(legacyData.score).toBe(90);
    expect(legacyData.note).toBe('存量填报');

    // 保存 → 写新目录新 schema；旧文件原地保留（版本回滚不丢填报）
    const saved = await route.POST(new NextRequest('http://localhost/api/observe/session/scorecard/bench-report', {
      method: 'POST',
      body: JSON.stringify({ taskId: SID_OP, score: 93 }),
    }));
    expect(saved.status).toBe(200);
    const newFile = path.join(process.env.SCORING_BENCH_REPORT_DIR!, `${sid}.json`);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(newFile, 'utf-8')).schema).toBe('workflow-session-bench-report');
    expect(fs.existsSync(path.join(legacyDir, `${sid}.json`))).toBe(true);

    const card = await runScorecard(SID_OP, prisma, { store });
    const item = d3Item(card!, 'D3.benchScore');
    expect(item.value).toBe(9.3);
  });

  it('旧 LLM 算子三项不再存在；基准测试评分不占 LLM 层', async () => {
    const card = await runScorecard(SID_OP, prisma, { store });
    const d3 = card!.dimensions.find(d => d.dimensionId === 'D3')!;
    expect(d3.items.map(i => i.itemId)).not.toContain('D3.opBoundary');
    expect(d3.items.map(i => i.itemId)).not.toContain('D3.opPrecision');
    expect(d3.items.map(i => i.itemId)).not.toContain('D3.opMemory');
    expect(d3.items.map(i => i.itemId)).toContain('D3.benchScore');
  });
});
