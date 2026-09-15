// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分 LLM 过程日志（cc-judge-round）IT：并发按 subagent 布局存放（交错单流会把
// request/response 配对打乱）、形状锁（cannbay 规范：信封 + x_cannbay 声明式分发）、
// 重试链留痕、主流/子代理流可被 claude-jsonl 管线导入且结果与调用一一对应、
// runner 端到端落盘、日志失败绝不阻断评分、用户目录迁移。

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service';
import { runScorecard } from '../../src/lib/scoring/core/runner';
import { TrackedLlmClient } from '../../src/lib/scoring/core/llm';
import { FileScorecardStore } from '../../src/lib/scoring/core/store';
import { JudgeJournal, JUDGE_SYSTEM_USER_SPLIT } from '../../src/lib/scoring/core/judge-log';
import { CANNBOT_HOME, migrateLegacyDir } from '../../src/lib/scoring/core/store';
import { userDefinitionsDir } from '../../src/lib/scoring/user/loader';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-log-it-'));
const LOG_DIR = path.join(TMP, 'score-judge-logs');
process.env.SCORING_JUDGE_LOG_DIR = LOG_DIR;
process.env.SCORING_BASELINE_DIR = path.join(TMP, 'baselines');   // 隔离：不读真实 ~/.cannbot-insight/baselines
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');     // 隔离：不读真实 ~/.cannbot-insight/scoring-profiles
const store = new FileScorecardStore(path.join(TMP, 'scorecards'));

const provider = { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'judge-model' };
const meta = { dimensionId: 'D1', itemId: 'D1.goalCoverage', itemName: '目标覆盖对账' };

const okJson = (content: string, extra: Record<string, unknown> = {}) =>
  ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop', ...extra }], usage: { prompt_tokens: 11, completion_tokens: 7 } }) }) as unknown as Response;
const emptyJson = () =>
  ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) }) as unknown as Response;
const timeoutError = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };

/** 该 session 下最新 run 目录：score-judge-logs/<sid>/<ts>-<runId>/ */
function latestRunDir(dir: string, sessionId: string): string {
  const sessDir = path.join(dir, sessionId);
  const runs = fs.readdirSync(sessDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  return path.join(sessDir, runs.at(-1)!);
}
/** run 目录下的子代理流目录：<runDir>/<stem>/subagents/ */
function subagentsDirOf(mainFile: string): string {
  const stem = path.basename(mainFile, '.jsonl');
  return path.join(path.dirname(mainFile), stem, 'subagents');
}
interface JournalLine {
  type: string;
  message: { content: string | Array<{ type?: string; content?: string; input?: Record<string, unknown> }>; [key: string]: unknown };
  x_cannbay?: { schema?: string; version?: number; data?: Record<string, unknown> };
}
function readJsonl(file: string): JournalLine[] {
  return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l) as JournalLine);
}

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ['judge-log-import', 'sess-judge-runner', 'judge-run-import-e2e'] } } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('评分产物迁用户目录（一次性迁移）', () => {
  it('旧目录有数据 → 整体搬到目标（含子目录），旧目录清空', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-legacy-'));
    const legacy = path.join(root, 'legacy', 'scorecards');
    const target = path.join(root, 'home', 'scorecards');
    fs.mkdirSync(path.join(legacy, 'archive', 'sess-1'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'a.json'), '{}');
    fs.writeFileSync(path.join(legacy, 'archive', 'sess-1', 'b.json'), '{}');
    expect(migrateLegacyDir(legacy, target)).toBe('moved');
    expect(fs.existsSync(path.join(target, 'a.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'archive', 'sess-1', 'b.json'))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });
  it('目标已有数据不覆盖（防重复迁移踩数据）；无旧目录直接跳过', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-legacy-'));
    const legacy = path.join(root, 'legacy');
    const target = path.join(root, 'home');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'old.json'), '{}');
    fs.writeFileSync(path.join(target, 'new.json'), '{}');
    expect(migrateLegacyDir(legacy, target)).toBe('skipped-target-exists');
    expect(fs.existsSync(path.join(legacy, 'old.json'))).toBe(true);
    expect(migrateLegacyDir(path.join(root, 'nope'), target)).toBe('skipped-no-legacy');
  });
  it('默认根在用户目录（~/.cannbot-insight），与 cpx 捕获文件同址', () => {
    expect(CANNBOT_HOME).toBe(path.join(os.homedir(), '.cannbot-insight'));
  });
  it('D7 用户定义目录：默认用户目录，SCORING_USER_DEF_DIR 覆盖', () => {
    const prev = process.env.SCORING_USER_DEF_DIR;
    try {
      delete process.env.SCORING_USER_DEF_DIR;
      expect(userDefinitionsDir()).toBe(path.join(CANNBOT_HOME, 'user-definitions'));
      process.env.SCORING_USER_DEF_DIR = '/tmp/user-def-override';
      expect(userDefinitionsDir()).toBe('/tmp/user-def-override');
    } finally {
      if (prev === undefined) delete process.env.SCORING_USER_DEF_DIR;
      else process.env.SCORING_USER_DEF_DIR = prev;
    }
  });
});

describe('judge 过程日志：并发子代理布局 + 重试链留痕', () => {
  it('空正文 → 超时：主流只有 run 头；两个 attempt 全在子代理流里顺序配对，扩展块符合 cc-judge-round 声明', async () => {
    const responses: Array<() => Response> = [() => emptyJson(), timeoutError];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!()));
    const journal = JudgeJournal.create('sess-judge', { model: 'judge-model', concurrency: 3, scorerVersion: 'test', withSemantic: true });
    expect(journal).not.toBeNull();
    const client = new TrackedLlmClient(provider, journal!, 'sess-judge');
    await expect(client.complete('你是评审员', '评一下 D1.goalCoverage', meta)).rejects.toThrow(/超时/);

    const main = readJsonl(journal!.file);
    // run 头 + 惰性派发行（首次真实调用才写 Agent tool_use；失败重试不重复写）
    expect(main).toHaveLength(2);
    expect(String(main[0].message.content)).toBe(`评分运行 ${journal!.runId} 开始 · 模型 judge-model · 并发 3 · 评分器 test · 语义评审开`);
    expect(main[0].x_cannbay!.data).toMatchObject({ kind: 'judge-run-header', phase: 'header', model: 'judge-model', concurrency: 3 });
    const mainDispatch = main[1];
    expect(mainDispatch.type).toBe('assistant');
    expect((mainDispatch.message.content as Array<{ type?: string }>)[0]?.type).toBe('tool_use');
    expect(path.dirname(journal!.file)).toBe(latestRunDir(LOG_DIR, 'sess-judge'));

    const subFile = path.join(subagentsDirOf(journal!.file), 'D1.goalCoverage.jsonl');
    const lines = readJsonl(subFile);
    expect(lines).toHaveLength(4);
    const [req1, res1, , res2] = lines;
    expect(req1.message.content).toBe(`你是评审员${JUDGE_SYSTEM_USER_SPLIT}评一下 D1.goalCoverage`);
    for (const [res, attempt, maxTokens] of [[res1, 1, 4096], [res2, 2, 8192]] as const) {
      expect(res.type).toBe('assistant');
      expect(res.message.model).toBe('judge-model');
      expect(String(res.message.content).startsWith('[judge-error]')).toBe(true);
      expect(res.x_cannbay!.schema).toBe('cc-judge-round');
      expect(res.x_cannbay!.version).toBe(1);
      expect(res.x_cannbay!.data).toMatchObject({ runId: journal!.runId, sessionId: 'sess-judge', dimensionId: 'D1', itemId: 'D1.goalCoverage', itemName: '目标覆盖对账', attempt, maxTokens });
    }
    expect(res1.x_cannbay!.data!.retryReason).toBe('empty-content');
    expect(res2.x_cannbay!.data!.retryReason).toBe('timeout');
    expect(res2.x_cannbay!.data!.status).toBeUndefined();

    // cc-subagent-meta 同值双写（规范 §4.5）
    const metaJson = JSON.parse(fs.readFileSync(subFile.replace(/\.jsonl$/, '.meta.json'), 'utf-8'));
    expect(metaJson.x_cannbay).toMatchObject({ schema: 'cc-subagent-meta', version: 1, data: { name: '目标覆盖对账', agentType: 'scoring-judge', subagentSessionId: 'D1.goalCoverage' } });
    expect(metaJson.toolUseId).toBe(metaJson.x_cannbay.data.toolUseId);
  });

  it('成功路径：content 原文、usage 进信封、token 只记成功那次', async () => {
    const journal = JudgeJournal.create('sess-judge', { model: 'judge-model', concurrency: 3, scorerVersion: 'test', withSemantic: true });
    const client = new TrackedLlmClient(provider, journal!, 'sess-judge');
    vi.stubGlobal('fetch', vi.fn(async () => okJson('{"score": 8, "reason": "ok", "evidence": []}')));
    const r = await client.complete('sys', 'user', meta);
    expect(r.promptTokens).toBe(11);
    const res = readJsonl(path.join(subagentsDirOf(journal!.file), 'D1.goalCoverage.jsonl')).at(-1)!;
    expect(res.message.content).toBe('{"score": 8, "reason": "ok", "evidence": []}');
    expect(res.message.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
    expect(res.x_cannbay!.data).toMatchObject({ attempt: 1, maxTokens: 4096, status: 200, stopReason: 'stop' });
    expect(res.x_cannbay!.data!.contentChars).toBe(String(res.message.content).length);
    expect(res.x_cannbay!.data!.error).toBeUndefined();
  });
});

describe('judge 过程日志：insight 可导入（主流 + 子代理流一起挂上）', () => {
  it('导入主流 → 子代理轮次自动并入（subagentSessionId=子项 id），结果与调用一一对应', async () => {
    const journal = JudgeJournal.create('sess-judge', { model: 'judge-model', concurrency: 3, scorerVersion: 'test', withSemantic: true });
    const client = new TrackedLlmClient(provider, journal!, 'sess-judge');
    vi.stubGlobal('fetch', vi.fn(async () => okJson('{"score": 8, "reason": "ok", "evidence": []}')));
    await client.complete('sys', 'user', meta);
    journal!.result(meta, { status: 'ok', score: 0.8, value: '8', note: 'ok' });

    await importSession(journal!.file, 'judge-log-import', prisma, journal!.file, 'claude-jsonl');
    const session = await prisma.session.findFirst({ where: { taskId: 'judge-log-import' } });
    expect(session).not.toBeNull();
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    // 派发是 Agent tool_use → 建出 InteractionBridge（AgentCallGraph/编排视图的驱动数据——
    // 没有桥，子代理在页面上就是一堆散轮，"按 subagent 组织"无从谈起）
    const bridge = await prisma.interactionBridge.findFirst({ where: { sessionId: session!.id } });
    expect(bridge).not.toBeNull();
    expect(bridge!.subagentSessionId).toBe('D1.goalCoverage');
    expect(bridge!.subagentName).toBe('目标覆盖对账');
    // 结果行（tool_result）回到主流：轮次内容或 Agent 调用的 resultJson 里能对上这次的结论
    const agentCalls = await prisma.toolCall.findMany({ where: { turn: { sessionId: session!.id }, toolName: 'Agent' } });
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const trace = turns.filter(t => t.subagentSessionId == null).map(t => t.content ?? '').join('\n')
      + agentCalls.map(c => c.resultJson ?? '').join('');
    expect(trace).toContain('"kind":"judge-item-result"');
    expect(trace).toContain('"score":0.8');
    // 子代理轮次：D1.goalCoverage 流的 request→response 严格相邻配对（并发交错问题已解）
    const sub = turns.filter(t => t.subagentSessionId === 'D1.goalCoverage').sort((a, b) => a.turnIndex - b.turnIndex);
    expect(sub).toHaveLength(2);
    expect(sub[0].role).toBe('user');
    expect(sub[1].role).toBe('assistant');
    expect(sub[1].model).toBe('judge-model');
    expect(sub[1].totalTokens).toBeGreaterThan(0);
  });
});

// ── runner 端到端：fixture 会话 → runScorecard(provider + fetch stub) → 日志 + 卡 ──

interface Line { type: string; message: Record<string, unknown>; timestamp: string }
const BASE = '2026-09-01T10:00:00.000Z';
let ts = 0;
const stamp = () => new Date(new Date(BASE).getTime() + ts++ * 1000).toISOString();
const userText = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text }, timestamp: stamp() });
function toolUse(id: string, name: string, input: Record<string, unknown>): Line {
  return { type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], model: 'test-model', usage: { input_tokens: 100, output_tokens: 20 } }, timestamp: stamp() };
}
const toolResult = (id: string, content: string): Line => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, timestamp: stamp() });

const RUN_SID = 'sess-judge-runner';
async function importRunnerFixture() {
  const file = path.join(TMP, 'runner-fixture.jsonl');
  fs.writeFileSync(file, [
    userText('实现 alpha 功能并跑测试'),
    toolUse('t01', 'Write', { file_path: '/src/alpha.ts', content: 'export const alpha = 2' }),
    toolResult('t01', 'ok'),
    toolUse('t02', 'Bash', { command: 'npm test' }),
    toolResult('t02', 'Tests  6 passed | 0 failed'),
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  await prisma.session.deleteMany({ where: { taskId: RUN_SID } });
  await importSession(file, RUN_SID, prisma, file, 'claude-jsonl');
}

/** 与 scoring-v2-it 同款 dispatch：按 user 尾部要求返回各形状合法输出，默认打分 */
function stubJudgeFetch() {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.at(-1)!.content;
    const pick = (s: string) => okJson(s);
    if (user.includes('验收清单') || user.includes('红线声明')) return pick('{"items":[]}');
    if (user.includes('用户消息分类')) return pick('{"messages":[]}');
    if (user.includes('目标覆盖')) return pick('{"goals":[{"goal":"实现 alpha","status":"covered","evidence":[]}]}');
    if (user.includes('授权与规避')) return pick('{"ops":[],"evasion":{"found":false}}');
    return pick('{"score": 8, "reason": "ok", "evidence": []}');
  }));
}

describe('judge 过程日志：runner 端到端', () => {
  it('真实 provider 路径：主流叙事（派发/结果/footer）+ 每子项一个子代理流，导入后全部挂上', async () => {
    await importRunnerFixture();
    stubJudgeFetch();
    const card = await runScorecard(RUN_SID, prisma, { store, withSemantic: true, provider, llmConcurrency: 2 });
    expect(card!.status).toBe('completed');
    expect(card!.meta!.judgeLogFile).toBeTruthy();
    expect(fs.existsSync(card!.meta!.judgeLogFile!)).toBe(true);

    const subDir = subagentsDirOf(card!.meta!.judgeLogFile!);
    const subFiles = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
    expect(subFiles.length).toBeGreaterThanOrEqual(6);   // D1.goalCoverage + D3×5 … 每个真实调用子项一个流

    const main = readJsonl(card!.meta!.judgeLogFile!);
    expect(String(main[0].message.content)).toContain('评分运行');
    expect(main[0].x_cannbay!.data).toMatchObject({ kind: 'judge-run-header', model: 'judge-model', concurrency: 2 });
    const footerLine = main.at(-1)!;
    expect(String(footerLine.message.content)).toContain('评分运行');
    expect(footerLine.message.content).not.toContain('{');   // 人话，不是裸 JSON
    expect(footerLine.x_cannbay!.data).toMatchObject({ kind: 'judge-run-footer', judgeCalls: card!.judgeCost!.calls });
    // 主流对 LLM 层子项记派发 + 结果；真实发起了调用的子项才有子代理流；结果 status 与卡上一致
    const results = main.filter(l => l.type === 'user' && Array.isArray(l.message.content) && l.message.content[0]?.type === 'tool_result')
      .map(l => JSON.parse(String((l.message.content as Array<{ content?: string }>)[0]?.content)));
    const dispatches = main.filter(l => l.type === 'assistant' && Array.isArray(l.message.content) && l.message.content[0]?.type === 'tool_use');
    expect(dispatches.length).toBe(results.length);
    // 弃权子项（D1.acceptance 无验收清单，LLM 一次没调）：不派发、不建子代理流（无 0 turns 空卡），
    // 结果走普通 user 行留痕
    const dispatchedSids = dispatches.map(l => ((l.message.content as Array<{ input?: { subagent_session_id?: string } }>)[0]?.input)?.subagent_session_id);
    expect(dispatchedSids).not.toContain('D1.acceptance');
    expect(fs.existsSync(path.join(subDir, 'D1.acceptance.jsonl'))).toBe(false);
    const aborted = main.filter(l => l.type === 'user' && typeof l.message.content === 'string' && l.message.content.includes('"itemId":"D1.acceptance"'));
    expect(aborted).toHaveLength(1);
    expect(JSON.parse(aborted[0].message.content as string)).toMatchObject({ kind: 'judge-item-result', itemId: 'D1.acceptance', status: 'not-applicable' });
    expect(results.length).toBeGreaterThanOrEqual(subFiles.length);
    const resultIds = new Set(results.map(r => r.itemId));
    for (const f of subFiles) expect(resultIds.has(f.replace(/\.jsonl$/, ''))).toBe(true);
    for (const r of results) {
      const onCard = card!.dimensions.flatMap(d => d.items).find(i => i.itemId === r.itemId);
      expect(onCard).toBeTruthy();
      expect(r.status).toBe(onCard!.status);
    }

    // 导入：子代理轮次按 subagentSessionId 分组，组内 user→assistant 相邻
    await importSession(card!.meta!.judgeLogFile!, 'judge-run-import-e2e', prisma, card!.meta!.judgeLogFile!, 'claude-jsonl');
    const session = await prisma.session.findFirst({ where: { taskId: 'judge-run-import-e2e' } });
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    const groups = new Map<string, typeof turns>();
    for (const t of turns) {
      const key = t.subagentSessionId ?? '';
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    for (const [sid, list] of groups) {
      if (!sid) continue;
      const sorted = [...list].sort((a, b) => a.turnIndex - b.turnIndex);
      for (let i = 0; i < sorted.length; i += 2) {
        expect(sorted[i].role).toBe('user');
        expect(sorted[i + 1]?.role).toBe('assistant');
      }
    }
    expect(groups.size).toBe(subFiles.length + 1);   // + 主流自身
  });

  it('日志目录不可写：journal 为 null，评分照常完成（日志绝不阻断）', async () => {
    // 用"普通文件当父目录"制造 ENOTDIR：确定性失败，不依赖 /proc 挂载行为
    const notADir = path.join(TMP, 'not-a-dir');
    fs.writeFileSync(notADir, 'x');
    process.env.SCORING_JUDGE_LOG_DIR = notADir;
    try {
      await importRunnerFixture();
      stubJudgeFetch();
      const card = await runScorecard(RUN_SID, prisma, { store, withSemantic: true, provider });
      expect(card!.status).toBe('completed');
      expect(card!.meta!.judgeLogFile).toBeUndefined();
    } finally {
      process.env.SCORING_JUDGE_LOG_DIR = LOG_DIR;
    }
  });
});
