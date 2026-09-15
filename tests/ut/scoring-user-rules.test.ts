// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D7 规则判定维度 IT：信号 × 比较的手算用例（命令/文件写入/关键词/验证通过/阈值）、
// 信号测不到 = 无法评判、校验负例、旧 LLM 维度兼容、注册表混排装配（规则零 LLM 出分）、
// 试算 API（规则即时出；LLM 维度无 provider 拒绝、有 provider 真调）。

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import type { AssembledInput, ScoreToolCall, LlmClient } from '../../src/lib/scoring/core/assembler/types';
import { UserRuleScorer, validateRuleSpec } from '../../src/lib/scoring/user/rule-scorer';
import { isValidUserDimension, saveUserGroup } from '../../src/lib/scoring/user/loader';
import { loadRegistry } from '../../src/lib/scoring/registry';
import { importSession } from '../../src/lib/ingest/data-service';
import { runScorecard } from '../../src/lib/scoring/core/runner';
import { FileScorecardStore } from '../../src/lib/scoring/core/store';
import type { ScoreItemSchema } from '../../src/lib/scoring/core/schema';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'user-rules-'));
process.env.SCORING_USER_DEF_DIR = path.join(TMP, 'defs');
process.env.SCORING_BASELINE_DIR = path.join(TMP, 'baselines');
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');
const store = new FileScorecardStore(path.join(TMP, 'store'));

const prisma = new PrismaClient();

const def = (name: string): ScoreItemSchema => ({ id: `D7.${name}`, dimension: 'D7', name, scorerKind: 'rule' });

function input(partial: Partial<AssembledInput>): AssembledInput {
  return {
    trajectoryDigest: '', memoryDigest: '', userMessages: [], toolCalls: [], turns: [],
    measures: { totalTokens: 0, toolTimeMs: 0, llmTimeMs: 0, inputTokens: 0 },
    taskType: 'general', workflowDecl: null, finishReason: 'normal', interrupts: [],
    wire: null, redactionEvents: [], executions: [],
    ...partial,
  };
}

const tc = (toolName: string, argsJson: Record<string, unknown> | null, turnIndex = 1): ScoreToolCall => ({
  id: `${toolName}-${turnIndex}`, toolName, argsJson: argsJson ? JSON.stringify(argsJson) : null,
  resultJson: null, state: 'completed', errorType: null, errorMessage: null, durationMs: 0,
  turnIndex, isSubagent: false, agentName: null, seq: turnIndex,
});

const ruleDim = { id: 'ran-tests', name: '跑了测试', kind: 'rule' as const, rule: { signal: 'command', filter: 'npm test|vitest', compare: 'exists' as const } };

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: 'rules-it-session' } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('规则信号 × 比较（手算）', () => {
  it('command exists：npm test 命中 2 次 → 通过，公式带 §N 证据', async () => {
    const r = await new UserRuleScorer(def('ran-tests'), ruleDim.rule).run({
      input: input({ toolCalls: [
        tc('Bash', { command: 'npm test' }, 3),
        tc('Bash', { command: 'vitest run tests/x.test.ts' }, 7),
        tc('Bash', { command: 'git status' }, 9),
      ] }),
      def: def('ran-tests'),
    });
    expect(r.status).toBe('ok');
    expect(r.verdict).toBe('pass');
    expect(r.formula).toContain('命中 2 次');
    expect(r.formula).toContain('§3');
    expect(r.formula).toContain('§7');
    expect(r.evidence).toHaveLength(2);
  });

  it('absent：rm -rf 一次都没出现 → 通过（防越界类规则）', async () => {
    const r = await new UserRuleScorer(def('no-rmrf'), { signal: 'command', filter: 'rm\\s+-rf', compare: 'absent' }).run({
      input: input({ toolCalls: [tc('Bash', { command: 'npm test' }, 3)] }),
      def: def('no-rmrf'),
    });
    expect(r.verdict).toBe('pass');
    const bad = await new UserRuleScorer(def('no-rmrf'), { signal: 'command', filter: 'rm\\s+-rf', compare: 'absent' }).run({
      input: input({ toolCalls: [tc('Bash', { command: 'rm -rf /tmp/x' }, 4)] }),
      def: def('no-rmrf'),
    });
    expect(bad.verdict).toBe('fail');
    expect(bad.score).toBe(0);
  });

  it('file_write 过滤 docs/ + gte 阈值', async () => {
    const r = await new UserRuleScorer(def('doc-sync'), { signal: 'file_write', filter: 'docs/|^README', compare: 'gte', threshold: 1 }).run({
      input: input({ toolCalls: [
        tc('Write', { file_path: '/repo/docs/a.md', content: 'x' }, 2),
        tc('Write', { file_path: '/repo/src/a.ts', content: 'x' }, 3),
      ] }),
      def: def('doc-sync'),
    });
    expect(r.verdict).toBe('pass');
    expect(r.formula).toContain('写入命中 1 处');
  });

  it('keyword：含关键词的轮次计数 + evidence 轮次', async () => {
    const r = await new UserRuleScorer(def('kw'), { signal: 'keyword', filter: 'TODO|待办', compare: 'gte', threshold: 2 }).run({
      input: input({ turns: [
        { id: 't1', turnIndex: 1, role: 'user', agentName: null, isSubagent: false, subagentSessionId: null, contentSummary: '把 TODO 清了', content: null, totalTokens: 0, inputTokens: 0, inputMessagesTokens: 0, latencyMs: 0, createdAtISO: null, createdAtTsISO: null, model: null },
        { id: 't2', turnIndex: 4, role: 'assistant', agentName: null, isSubagent: false, subagentSessionId: null, contentSummary: '这里留了个 TODO', content: null, totalTokens: 0, inputTokens: 0, inputMessagesTokens: 0, latencyMs: 0, createdAtISO: null, createdAtTsISO: null, model: null },
      ] }),
      def: def('kw'),
    });
    expect(r.verdict).toBe('pass');
    expect(r.evidence.map(e => e.turnIndex)).toEqual([1, 4]);
  });

  it('test_pass：白名单验证输出解析 → 通过数；无验证运行 → 无法评判', async () => {
    const withTests = input({ toolCalls: [
      tc('Write', { file_path: '/src/a.ts', content: 'x' }, 1),
      tc('Bash', { command: 'npm test' }, 2),
    ] });
    // findLastVerifiedRun 读 resultJson 的输出文本
    withTests.toolCalls[1].resultJson = 'Tests  6 passed | 0 failed';
    const ok = await new UserRuleScorer(def('tests-pass'), { signal: 'test_pass', compare: 'gte', threshold: 1 }).run({ input: withTests, def: def('tests-pass') });
    expect(ok.verdict).toBe('pass');
    expect(ok.formula).toContain('通过 6 条');

    const noRun = await new UserRuleScorer(def('tests-pass'), { signal: 'test_pass', compare: 'gte', threshold: 1 }).run({
      input: input({ toolCalls: [tc('Bash', { command: 'git status' }, 1)] }),
      def: def('tests-pass'),
    });
    expect(noRun.status).toBe('not-applicable');
    expect(noRun.note).toContain('无法评判');
  });
});

describe('校验与兼容', () => {
  it('validateRuleSpec：坏正则 / 缺阈值 / 未知信号拒绝', () => {
    expect(validateRuleSpec({ signal: 'command', compare: 'exists' })).toBe(true);
    expect(validateRuleSpec({ signal: 'command', filter: '([unclosed', compare: 'exists' })).toBe(false);
    expect(validateRuleSpec({ signal: 'command', compare: 'gte' })).toBe(false);          // 缺阈值
    expect(validateRuleSpec({ signal: 'nope', compare: 'exists' })).toBe(false);           // 未知信号
    expect(validateRuleSpec({ signal: 'command', filter: 'x'.repeat(201), compare: 'exists' })).toBe(false);
  });

  it('isValidUserDimension：规则型查规则；无 kind 的旧 LLM 定义仍合法（向后兼容）', () => {
    expect(isValidUserDimension(ruleDim)).toBe(true);
    expect(isValidUserDimension({ id: 'old-llm', name: '旧版', bands: [
      { range: '9-10', label: '优', description: '主动做好且留痕' },
      { range: '0-2', label: '差', description: '完全没做或脱节' },
    ] })).toBe(true);
    expect(isValidUserDimension({ id: 'bad-rule', name: '坏', kind: 'rule', rule: { signal: 'x', compare: 'y' } })).toBe(false);
  });

  it('注册表混排：同组规则维 + LLM 维都装配；规则维无 LLM 也出分，LLM 维无 LLM 时无法评判', async () => {
    await saveUserGroup({
      id: 'mixed', name: '混排组', dimensions: [
        ruleDim,
        { id: 'doc-fresh', name: '文档更新及时性', kind: 'llm', bands: [
          { range: '9-10', label: '优秀', description: '主动做好且留痕' },
          { range: '0-2', label: '严重缺陷', description: '完全没做或脱节' },
        ] },
      ],
    });
    const reg = await loadRegistry();
    expect(reg.defs.some(d => d.id === 'D7:ran-tests')).toBe(true);
    expect(reg.scorerOf.has('D7.ran-tests')).toBe(true);

    const ruleResult = await reg.scorerOf.get('D7.ran-tests')!.run({
      input: input({ toolCalls: [tc('Bash', { command: 'npm test' }, 3)] }),
      def: def('ran-tests'),
    });
    expect(ruleResult.verdict).toBe('pass');   // 零 LLM

    const llmStub: LlmClient = { model: 'stub', complete: async () => ({ content: '{"score": 8, "reason": "ok", "evidence": []}', promptTokens: 1, completionTokens: 1 }) };
    const llmResult = await reg.scorerOf.get('D7.doc-fresh')!.run({
      input: input({ trajectoryDigest: '轨迹摘要' }),
      def: { id: 'D7.doc-fresh', dimension: 'D7', name: '文档更新及时性', scorerKind: 'llm' },
      llm: llmStub,
    });
    expect(llmResult.status).toBe('ok');
  });
});

// ── 试算 API + 端到端 ──

interface Line { type: string; message: Record<string, unknown>; timestamp: string }
const BASE = '2026-09-02T10:00:00.000Z';
let ts = 0;
const stamp = () => new Date(new Date(BASE).getTime() + ts++ * 1000).toISOString();
const userText = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text }, timestamp: stamp() });
function toolUse(id: string, name: string, payload: Record<string, unknown>): Line {
  return { type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: payload }], model: 'test-model', usage: { input_tokens: 100, output_tokens: 20 } }, timestamp: stamp() };
}
const toolResult = (id: string, content: string): Line => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, timestamp: stamp() });

const SID = 'rules-it-session';

async function importFixture() {
  const file = path.join(TMP, 'fixture.jsonl');
  fs.writeFileSync(file, [
    userText('实现 alpha 功能并跑测试'),
    toolUse('t01', 'Write', { file_path: '/src/alpha.ts', content: 'export const alpha = 2' }),
    toolResult('t01', 'ok'),
    toolUse('t02', 'Bash', { command: 'npm test' }),
    toolResult('t02', 'Tests  6 passed | 0 failed'),
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  await prisma.session.deleteMany({ where: { taskId: SID } });
  await importSession(file, SID, prisma, file, 'claude-jsonl');
}

async function postTry(body: unknown) {
  const { POST } = await import('../../src/app/api/observe/scoring/user-definitions/try/route');
  return POST(new NextRequest('http://localhost/api/observe/scoring/user-definitions/try', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('试算 API 与端到端', () => {
  it('规则维度试算：即时出判定 + 证据轮次（零 LLM）', async () => {
    await importFixture();
    const res = await postTry({ taskId: SID, dimension: ruleDim });
    expect(res.status).toBe(200);
    const data = await res.json() as { result: { verdict: string; formula: string } };
    expect(data.result.verdict).toBe('pass');
    expect(data.result.formula).toContain('npm test');
  });

  it('LLM 维度试算：无 provider 拒绝（400），带 provider 真调出分', async () => {
    await importFixture();
    const dim = { id: 'doc-fresh', name: '文档更新及时性', kind: 'llm', bands: [
      { range: '9-10', label: '优秀', description: '主动做好且留痕' },
      { range: '0-2', label: '严重缺陷', description: '完全没做或脱节' },
    ] };
    const noProvider = await postTry({ taskId: SID, dimension: dim });
    expect(noProvider.status).toBe(400);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"score": 8, "reason": "ok", "evidence": []}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    }) as unknown as Response));
    const withProvider = await postTry({ taskId: SID, dimension: dim, provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' } });
    expect(withProvider.status).toBe(200);
    const data = await withProvider.json() as { result: { status: string; score: number } };
    expect(data.result.status).toBe('ok');
    expect(data.result.score).toBe(0.8);
  });

  it('评分卡端到端：规则维零 LLM 出现在 D7（确定性层即出，不必开语义评审）', async () => {
    await importFixture();
    const card = await runScorecard(SID, prisma, { store });
    expect(card!.status).toBe('completed');
    const rule = card!.dimensions.find(d => d.dimensionId.startsWith('D7'))!.items.find(i => i.itemId === 'D7.ran-tests')!;
    expect(rule.verdict).toBe('pass');
    expect(rule.formula).toContain('通过');
  });
});
