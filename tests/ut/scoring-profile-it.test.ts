// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分配置 profile 端到端 IT：profile 路由 CRUD + 激活切换 → runScorecard 卡上体现
// （快速免评审：LLM 子项消失、覆盖度上升、framework.profile 快照；算子开发：weightsUsed 归一）；
// 自定义项经真实 profile 文件 → loadRegistry → 评分器出分；导入回路；删激活项回落默认。

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { importSession } from '../../src/lib/ingest/data-service';
import { runScorecard } from '../../src/lib/scoring/core/runner';
import { loadRegistry } from '../../src/lib/scoring/registry';
import { FileScorecardStore } from '../../src/lib/scoring/core/store';
import type { AssembledInput, LlmClient } from '../../src/lib/scoring/core/assembler/types';

const prisma = new PrismaClient();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-profile-it-'));
process.env.SCORING_DATA_DIR = path.join(TMP, 'api-store');
process.env.SCORING_BASELINE_DIR = path.join(TMP, 'baselines');
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');
process.env.SCORING_USER_DEF_DIR = path.join(TMP, 'user-defs');
const store = new FileScorecardStore(path.join(TMP, 'scorecards'));

const SID = 'scoring-profile-it';

interface Line { type: string; message: Record<string, unknown>; timestamp: string; [k: string]: unknown }

const BASE = '2026-09-08T10:00:00.000Z';
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
  userText('给 utils 加个函数并跑测试'),
  toolUse('t01', 'Read', { file_path: '/repo/src/utils.ts' }), toolResult('t01', '1\t// utils'),
  toolUse('t02', 'Edit', { file_path: '/repo/src/utils.ts', old_string: 'a', new_string: 'b' }), toolResult('t02', 'ok'),
  toolUse('t03', 'Bash', { command: 'npm test' }), toolResult('t03', 'Tests 10 passed | 0 failed'),
];

const writeFixture = (): string => {
  const file = path.join(TMP, `${SID}.jsonl`);
  fs.writeFileSync(file, LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
};

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const route = await import('../../src/app/api/observe/scoring/profiles/route');

const PUT = (profile: unknown) => route.PUT(new NextRequest('http://localhost/api/observe/scoring/profiles', {
  method: 'PUT', body: JSON.stringify({ profile }),
}));
const ACTIVATE = (activeId: string | null) => route.POST(new NextRequest('http://localhost/api/observe/scoring/profiles', {
  method: 'POST', body: JSON.stringify({ activeId }),
}));

describe('路由 CRUD 与校验', () => {

  it('GET 默认：空列表 + activeId null + 无警示', async () => {
    const res = await route.GET();
    const data = await res.json() as { profiles?: unknown[]; activeId?: string | null; warnings?: string[] };
    expect(res.status).toBe(200);
    expect(data.profiles).toEqual([]);
    expect(data.activeId).toBeNull();
    expect(data.warnings).toEqual([]);
  });

  it('PUT 非法 profile 400（勾除 D1 固定项 / 负权重 / D4 自定义缺权重）', async () => {
    expect((await PUT({ schema: 'scoring-profile', version: 1, id: 'bad1', name: '坏1', excludedItems: ['D1.verifiedRun'] })).status).toBe(400);
    expect((await PUT({ schema: 'scoring-profile', version: 1, id: 'bad2', name: '坏2', dimensionWeights: { D2: -1 } })).status).toBe(400);
    expect((await PUT({
      schema: 'scoring-profile', version: 1, id: 'bad3', name: '坏3',
      customItems: [{ id: 'D4.my', targetDimension: 'D4', name: 'my', kind: 'rule', rule: { signal: 'turns', compare: 'lte', threshold: 30 } }],
    })).status).toBe(400);
  });

  it('PUT 合法 → 200 落盘；激活未知 id 400；激活 preset:quick → 200；导入回路（导出形 JSON 直接 PUT）', async () => {
    const saved = await PUT({ schema: 'scoring-profile', version: 1, id: 'strict', name: '严格口径', note: 'IT', dimensionWeights: { D3: 0.45 } });
    expect(saved.status).toBe(200);
    expect(fs.existsSync(path.join(TMP, 'profiles', 'strict.json'))).toBe(true);

    expect((await ACTIVATE('no-such')).status).toBe(400);
    const activated = await ACTIVATE('preset:quick');
    expect(activated.status).toBe(200);

    const exported = JSON.parse(fs.readFileSync(path.join(TMP, 'profiles', 'strict.json'), 'utf-8')) as Record<string, unknown>;
    const imported = await PUT({ ...exported, id: 'strict-copy', name: '严格口径（导入）' });
    expect(imported.status).toBe(200);
    const list = await (await route.GET()).json() as { profiles: Array<{ id: string }> };
    expect(list.profiles.map(p => p.id)).toContain('strict-copy');
  });
});

describe('激活 quick → runScorecard 体现', () => {

  it('默认口径先跑一张基线卡（profile null）', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID } });
    await importSession(writeFixture(), SID, prisma, writeFixture(), 'claude-jsonl');
    await ACTIVATE(null);
    const card = await runScorecard(SID, prisma, { store });
    expect(card!.framework.profile).toBeNull();
    expect(card!.dimensions.flatMap(d => d.items.map(i => i.itemId))).toContain('D3.correctness');
    (globalThis as Record<string, unknown>).__coverageDefault = card!.framework.coverage;
  });

  it('quick：LLM 子项消失、覆盖度上升、卡上记口径快照', async () => {
    await ACTIVATE('preset:quick');
    const card = await runScorecard(SID, prisma, { store });
    expect(card!.framework.profile).toEqual({ id: 'preset:quick', name: '快速免评审' });
    const ids = card!.dimensions.flatMap(d => d.items.map(i => i.itemId));
    expect(ids).not.toContain('D3.correctness');
    expect(ids).not.toContain('D6.classification');
    expect(ids).not.toContain('D2.redlines');
    expect(ids).toContain('D3.testResults');
    expect(card!.framework.coverage).toBeGreaterThan((globalThis as Record<string, unknown>).__coverageDefault as number);
  });

  it('算子开发模板：weightsUsed 按覆盖值归一（D3 45%）', async () => {
    await ACTIVATE('preset:operator');
    const card = await runScorecard(SID, prisma, { store });
    expect(card!.framework.profile).toEqual({ id: 'preset:operator', name: '算子开发' });
    expect(card!.framework.weightsUsed['D3']).toBeCloseTo(0.45, 2);
  });

  it('删激活的用户配置回落默认；删模板 400', async () => {
    await ACTIVATE('strict');
    let card = await runScorecard(SID, prisma, { store });
    expect(card!.framework.profile).toEqual({ id: 'strict', name: '严格口径' });

    expect((await route.DELETE(new NextRequest('http://localhost/api/observe/scoring/profiles?id=preset:quick'))).status).toBe(400);
    const removed = await route.DELETE(new NextRequest('http://localhost/api/observe/scoring/profiles?id=strict'));
    expect(removed.status).toBe(200);
    const after = await removed.json() as { activeId: string | null };
    expect(after.activeId).toBeNull();

    card = await runScorecard(SID, prisma, { store });
    expect(card!.framework.profile).toBeNull();
  });
});

describe('自定义项：真实 profile 文件 → loadRegistry → 评分器出分', () => {

  it('D3 LLM 自定义项进卡并出分；D6 规则自定义项标只展示', async () => {
    await PUT({
      schema: 'scoring-profile', version: 1, id: 'with-custom', name: '带自定义项',
      customItems: [
        {
          id: 'D3.doc-sync', targetDimension: 'D3', name: '文档同步', kind: 'llm',
          bands: [
            { range: '0-2', label: '严重缺陷', description: '文档与代码完全脱节且未提及' },
            { range: '9-10', label: '优秀', description: '改代码的同时主动更新了相关文档' },
          ],
        },
        {
          id: 'D6.turns-cap', targetDimension: 'D6', name: '轮次上限', kind: 'rule',
          rule: { signal: 'turns', compare: 'lte', threshold: 100 },
        },
      ],
    });
    await ACTIVATE('with-custom');

    const registry = await loadRegistry();
    expect(registry.profile).toEqual({ id: 'with-custom', name: '带自定义项' });
    const d3 = registry.defs.find(d => d.id === 'D3')!;
    expect(d3.items.map(i => i.id)).toContain('D3.doc-sync');
    const d6 = registry.defs.find(d => d.id === 'D6')!;
    expect(d6.items.find(i => i.id === 'D6.turns-cap')!.diagnostic).toBe(true);

    const stubLlm: LlmClient = {
      model: 'stub',
      complete: async () => ({ content: '{"reason":"按档位判","score":9,"evidence":[]}', promptTokens: 10, completionTokens: 5 }),
    };
    const def = d3.items.find(i => i.id === 'D3.doc-sync')!;
    const scorer = registry.scorerOf.get('D3.doc-sync')!;
    const r = await scorer.run({
      input: { trajectoryDigest: '#0 👤 "task"', turns: [{ turnIndex: 0 }] } as unknown as AssembledInput,
      def, llm: stubLlm, samples: 1,
    });
    expect(r.status).toBe('ok');
    expect(r.score).toBe(1);
    expect(r.formula).toContain('10/10');
    expect(r.formula).toContain('原始 9');

    const ruleResult = await registry.scorerOf.get('D6.turns-cap')!.run({
      input: { trajectoryDigest: '', turns: [{ turnIndex: 0 }], toolCalls: [], measures: { totalTokens: 1, toolTimeMs: 0, llmTimeMs: 0, inputTokens: 1 } } as unknown as AssembledInput,
      def: d6.items.find(i => i.id === 'D6.turns-cap')!, samples: 1,
    });
    expect(ruleResult.status).toBe('ok');
    expect(ruleResult.verdict).toBe('pass');
  });
});
