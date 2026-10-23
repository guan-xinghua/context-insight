// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake-bundle IT（run 级上传：数据源 = insight，与会话上传同款「导入后
// 上传」链路）：本地导入 bundle → run-store 落盘（manifest）
// → uploadLakeBundle(prisma, runId)（staging + 治理）→ push → 列表 →
// lake 导入 job 闭环；治理熔断、manifest 深度清洗、原子整体替换、DB 导出
// 兜底、缺行成员容忍、大小限、会话列表隔离、路由三 action。env 必须在
// lake 模块加载前设置。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { seedLakeConfig } from '../helpers/lake-env';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-bundle-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');
const HOME = path.join(TMP, 'home');           // CONTEXT_INSIGHT_HOME：run-store 隔离
const FIXTURES = path.join(TMP, 'fixtures');
const RUNS_ROOT = path.join(HOME, 'runs');

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# lake bundle test\n');
// 含 *.jsonl/*.gz LFS 行：bundle 上传同款剔除防线（remote.lfs=false）
fs.writeFileSync(path.join(SEED, '.gitattributes'), '*.jsonl filter=lfs diff=lfs merge=lfs -text\n*.gz filter=lfs diff=lfs merge=lfs -text\n');
fs.mkdirSync(path.join(SEED, 'others'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'others', '.gitkeep'), '');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

seedLakeConfig(TMP, { address: BARE });
process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = CACHE;
process.env.CONTEXT_INSIGHT_HOME = HOME;

// 结构校验权威随包分发：本地组装 bundle 也带 workflow.schema.json（与真实导出件同源）
const SCHEMA_TEXT = fs.readFileSync(path.resolve(__dirname, '../ut/data/run/workflow-bundle.v1.schema.json'), 'utf-8');

// ── fixture 构造 ──────────────────────────────────────────────────────

const RUN_ID = 'bndit01';
const RUN_ID_KEY = 'bndit02';

function sessionJsonl(sid: string, text: string): string {
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `bundle 会话 ${sid}：${text}` }, timestamp: '2026-10-10T03:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: `msg_${sid}`, role: 'assistant', content: [{ type: 'text', text: `完成 ${sid}` }], model: 'test-model', usage: { input_tokens: 100, output_tokens: 20 } }, timestamp: '2026-10-10T03:00:05.000Z' }),
  ].join('\n') + '\n';
}

function sessionMeta(sid: string): string {
  return JSON.stringify({ x_lake: { schema: 'cc-session-meta', version: 1, data: { producer: 'insight-export', framework: 'opencode', ccVersion: '1.19.0', sid } } });
}

interface MemberSeed { id: string; kind: 'session' | 'process'; name: string; sessionId?: string; location?: string | null; output?: { text: string } }

function manifestJson(runId: string, members: MemberSeed[], relations: Array<{ from: string; to: string }>, name = 'lake bundle IT'): string {
  return JSON.stringify({
    schema: 'context.workflow-bundle',
    version: 1,
    id: runId,
    kind: 'workflow',
    name,
    startedAt: null,
    finishedAt: null,
    data: {
      exportDataComplete: true,
      members: members.map(m => ({
        id: m.id, kind: m.kind, name: m.name, startedAt: null, finishedAt: null,
        ...(m.kind === 'session' ? { sessionId: m.sessionId ?? null, location: m.location ?? null } : {}),
        ...(m.output ? { output: m.output } : {}),
      })),
      relations: relations.map(r => ({ from: r.from, to: r.to, annotation: { type: 'depends_on' } })),
    },
  }, null, 1);
}

/** 组装一个本地 bundle 目录。sessionIds = 会话正文集合；stray 控制杂散文件。 */
function buildBundle(dir: string, runId: string, opts: { manifestName?: string; members?: MemberSeed[]; sids: string[]; stray?: boolean; manifestOverride?: string }): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const members = opts.members ?? [
    ...opts.sids.map(sid => ({ id: sid, kind: 'session' as const, name: `${sid} 执行`, sessionId: sid, location: `sessions/${sid}` })),
    { id: 'M1', kind: 'process' as const, name: '打包', output: { text: 'done' } },
  ];
  // 关系端点从实际成员推导（session 成员 → 最后一个 process 成员）
  const processId = [...members].reverse().find(m => m.kind === 'process')?.id;
  const relations = processId != null
    ? members.filter(m => m.kind === 'session').map(m => ({ from: m.id, to: processId }))
    : [];
  fs.writeFileSync(path.join(dir, opts.manifestName ?? 'workflow.json'), opts.manifestOverride ?? manifestJson(runId, members, relations));
  fs.writeFileSync(path.join(dir, 'workflow.schema.json'), SCHEMA_TEXT);
  for (const sid of opts.sids) {
    fs.mkdirSync(path.join(dir, 'sessions', sid), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', sid, `${sid}.jsonl`), sessionJsonl(sid, '正文'));
    fs.writeFileSync(path.join(dir, 'sessions', sid, `${sid}.meta.json`), sessionMeta(sid));
  }
  if (opts.stray) {
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
    fs.writeFileSync(path.join(dir, 'sessions', opts.sids[0], '.DS_Store'), 'junk');
  }
}

const prisma = new PrismaClient();

// env 已设，动态加载 lake/bundle 链与路由
const lake = await import('../../src/lib/lake');
const bundle = await import('../../src/lib/lake/bundle');
const governance = await import('../../src/lib/lake/governance');
const importService = await import('../../src/lib/run/import-service');
const route = await import('../../src/app/api/ingest/lake/route');

const treeFiles = (): string[] => git('git ls-tree -r --name-only main', BARE).split('\n').filter(Boolean);

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/ingest/lake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForJob(jobId: string, timeoutMs = 30_000): Promise<NonNullable<ReturnType<typeof importService.getImportJob>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = importService.getImportJob(jobId);
    if (state && (state.step === 'done' || state.step === 'error')) return state;
    if (Date.now() > deadline) throw new Error(`import job ${jobId} timeout (step=${state?.step})`);
    await new Promise(r => setTimeout(r, 100));
  }
}

/** 本地导入 bundle（run 级上传的数据源准备）。 */
async function importLocalBundle(dir: string): Promise<void> {
  const validation = importService.validateBundleDir(dir);
  expect(validation.ok).toBe(true);
  const jobId = importService.createImportJob(dir, validation.manifest!, { prisma, root: RUNS_ROOT });
  const state = await waitForJob(jobId);
  expect(state.step).toBe('done');
  expect(state.error).toBeNull();
}

beforeAll(async () => {
  // 直接 vitest（绕过 pretest 重建库）重跑时清掉上次导入的夹具行
  await prisma.session.deleteMany({ where: { taskId: { in: ['S1', 'S2', 'SK1'] } } });
  buildBundle(path.join(FIXTURES, RUN_ID), RUN_ID, {
    sids: ['S1'],
    stray: true,
  });
  await importLocalBundle(path.join(FIXTURES, RUN_ID));
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ['S1', 'S2', 'SK1'] } } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('run 本地导入（上传数据源 = insight）', () => {
  it('导入 job 完成：run-store 落盘 + 会话入库（framework 恢复）', async () => {
    const runsRoot = await import('../../src/lib/run/run-store');
    const stored = runsRoot.readRun(RUN_ID, RUNS_ROOT);
    expect(stored).toBeTruthy();
    expect(stored!.manifest.id).toBe(RUN_ID);

    const row = await prisma.session.findFirst({ where: { taskId: 'S1' } });
    expect(row).toBeTruthy();
    expect(row!.framework).toBe('opencode');
  });
});

describe('bundle 上传（run → 数据仓）', () => {
  it('upload：manifest 落盘件出仓 + 成员会话装配（7z）+ meta 合成 + LFS 行剔除 + 杂散文件挡在仓外', async () => {
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 张三\n内容描述: bundle IT 上传');
    expect(result.runId).toBe(RUN_ID);
    expect(result.unchanged).toBe(false);
    expect(result.folder).toBe(`opsbot-bundle/${RUN_ID}/`);
    expect(result.sessionCount).toBe(1);
    expect(result.missingSessions).toEqual([]);

    const files = treeFiles();
    const prefix = `opsbot-bundle/${RUN_ID}/`;
    expect(files).toContain(`${prefix}workflow.json`);
    expect(files).toContain(`${prefix}workflow.schema.json`);
    // schema 随包权威进仓：与测试同源文本逐字一致
    expect(git(`git show main:${prefix}workflow.schema.json`, BARE)).toBe(SCHEMA_TEXT);
    expect(files).toContain(`${prefix}bundle.meta.json`);
    expect(files).toContain(`${prefix}sessions/S1/S1.jsonl.7z`);
    expect(files).toContain(`${prefix}sessions/S1/S1.meta.json`);
    // 杂散文件（.DS_Store，源目录里有）不进仓——staging 按 manifest 装配
    expect(files.some(f => f.includes('.DS_Store'))).toBe(false);
    // .gitattributes 的 filter=lfs 行被剔除（seed 带 *.jsonl/*.gz）
    const ga = git('git show main:.gitattributes', BARE);
    expect(ga).not.toContain('filter=lfs');
  });

  it('bundle.meta.json：cc-bundle-meta 信封 + 提交人/规模快照（形状校验 + 未知键透传）', () => {
    const raw = git(`git show main:opsbot-bundle/${RUN_ID}/bundle.meta.json`, BARE);
    const parsed = JSON.parse(raw);
    expect(parsed.x_lake.schema).toBe('cc-bundle-meta');
    expect(parsed.x_lake.version).toBe(1);
    expect(parsed.x_lake.data.runId).toBe(RUN_ID);
    expect(parsed.x_lake.data.submitter).toBe('张三');
    expect(parsed.x_lake.data.description).toBe('bundle IT 上传');
    expect(parsed.x_lake.data.sessionCount).toBe(1);
  });

  it('bundle-list：锚定目录 + meta/manifest 汇总；imported 标记（本地导入后即 true）', () => {
    const items = bundle.listLakeBundles(undefined, RUNS_ROOT);
    const entry = items.find(e => e.runId === RUN_ID);
    expect(entry).toBeTruthy();
    expect(entry!.name).toBe('lake bundle IT');
    expect(entry!.exportDataComplete).toBe(true);
    expect(entry!.memberCount).toBe(2);
    expect(entry!.sessionCount).toBe(1);
    expect(entry!.submitter).toBe('张三');
    expect(entry!.imported).toBe(true);
  });

  it('会话列表隔离：bundle 成员会话不进 lake 会话列表；专区不能作为会话上传目录', async () => {
    const { sessions } = lake.listLakeOverview();
    expect(sessions.some(s => s.sid === 'S1')).toBe(false);
    await expect(
      lake.uploadLakeSession(prisma, 'S1', '提交人: 张三\n内容描述: x', undefined, 'opsbot-bundle'),
    ).rejects.toThrow(/专区/);
  });

  it('未导入的 run 上传 → 明确报错（数据源是已导入 run）', async () => {
    await expect(
      bundle.uploadLakeBundle(prisma, 'no-such-run', '提交人: 张三\n内容描述: x'),
    ).rejects.toThrow(/未导入/);
  });
});

describe('bundle 导入：物化 → 解压 → run 导入 job → Run 工作台可见', () => {
  it('bundle-import：job 完成（既有会话幂等）、物化目录自清理', async () => {
    const handle = bundle.importLakeBundle(RUN_ID, { prisma, root: RUNS_ROOT });
    expect(handle.state.runId).toBe(RUN_ID);
    const state = await waitForJob(handle.jobId);
    expect(state.step).toBe('done');
    expect(state.error).toBeNull();
    // S1 已在本地导入时入库 → 幂等走 existing
    expect(state.existing).toBe(1);

    // 列表 imported 维持
    expect(bundle.listLakeBundles(undefined, RUNS_ROOT).find(e => e.runId === RUN_ID)!.imported).toBe(true);

    // 物化 tmp 目录由 job 终态自清理（.finally 在 done 后落定）——只查本
    // runId 前缀：并行 worker 里其它测试文件的物化目录不该被误伤
    await new Promise(r => setTimeout(r, 300));
    const leftovers = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(`lake-bundle-import-${RUN_ID}-`));
    expect(leftovers).toEqual([]);
  });

  it('路由 action：bundle-list / bundle-import（4xx 校验）/ bundle-upload（runId 通道）', async () => {
    const listRes = await route.POST(makeRequest({ action: 'bundle-list' }));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.items.some((e: { runId: string }) => e.runId === RUN_ID)).toBe(true);
    // 目录清单与会话范式注册表同源（导入弹窗目录选择阶段数据）——含 bundle 专区
    expect(Array.isArray(listBody.dirs)).toBe(true);
    expect(listBody.dirs).toContain('opsbot-bundle');

    expect((await route.POST(makeRequest({ action: 'bundle-import' }))).status).toBe(400); // 缺 runId
    expect((await route.POST(makeRequest({ action: 'bundle-upload' }))).status).toBe(400); // 缺 runId
    expect((await route.POST(makeRequest({ action: 'nope' }))).status).toBe(400);

    const upRes = await route.POST(makeRequest({
      action: 'bundle-upload',
      runId: RUN_ID,
      description: '提交人: 李四\n内容描述: 路由通道上传',
    }));
    expect(upRes.status).toBe(200);
    const upBody = await upRes.json();
    expect(upBody.runId).toBe(RUN_ID);
    expect(upBody.sessionCount).toBe(1);
    expect(upBody.missingSessions).toEqual([]);
  });
});

describe('bundle 治理：jsonl 全量清洗 + manifest 深度清洗 + 复检熔断', () => {
  it('manifest output.text 含厂商 key：深度清洗后上传，仓内件已掩码', async () => {
    buildBundle(path.join(FIXTURES, RUN_ID_KEY), RUN_ID_KEY, {
      sids: ['SK1'],
      members: [
        { id: 'SK1', kind: 'session', name: '执行', sessionId: 'SK1', location: 'sessions/SK1' },
        { id: 'M9', kind: 'process', name: '打包', output: { text: 'key 是 sk-ant-api03-AAAA1111BBBB2222CCCC3333DDDD4444EEEE5' } },
      ],
    });
    await importLocalBundle(path.join(FIXTURES, RUN_ID_KEY));
    await bundle.uploadLakeBundle(prisma, RUN_ID_KEY, '提交人: 张三\n内容描述: key 清洗');
    const raw = git(`git show main:opsbot-bundle/${RUN_ID_KEY}/workflow.json`, BARE);
    expect(raw).not.toContain('AAAA1111BBBB');
    expect(raw).toContain('…');
    // bundle 无附加报告件：导入→上传→列举全链路不阻断，会话规模以仓内 sessions/ 目录为权威源
    const entry = bundle.listLakeBundles(undefined, RUNS_ROOT).find(e => e.runId === RUN_ID_KEY)!;
    expect(entry.sessionCount).toBe(1);
  });

  it('复检残留 → 熔断拒绝上传，远端不推进', async () => {
    const before = git('git rev-parse main', BARE).trim();
    const spy = vi.spyOn(governance, 'governText').mockReturnValue({ output: '', residue: ['S1.jsonl: sk-ant-RESIDUE…'] });
    try {
      await expect(
        bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 张三\n内容描述: breaker'),
      ).rejects.toThrow(/熔断/);
    } finally {
      spy.mockRestore();
    }
    expect(git('git rev-parse main', BARE).trim()).toBe(before);
  });

  it('bundle 总量上限（压缩后字节）→ 熔断', async () => {
    const original = bundle.MAX_BUNDLE_BYTES.value;
    bundle.MAX_BUNDLE_BYTES.value = 1;
    try {
      await expect(
        bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 张三\n内容描述: size'),
      ).rejects.toThrow(/总量上限/);
    } finally {
      bundle.MAX_BUNDLE_BYTES.value = original;
    }
  });
});

describe('run 重导入 + 原子整体替换 + insight 数据源韧性', () => {
  it('v2 重导入（manifest.json 命名 + 换会话集合）→ 上传替换 v1', async () => {
    buildBundle(path.join(FIXTURES, `${RUN_ID}-v2`), RUN_ID, {
      manifestName: 'manifest.json', // 源命名差异化 → run 目录统一 manifest.json → 仓内统一 workflow.json
      sids: ['S2'],
    });
    await importLocalBundle(path.join(FIXTURES, `${RUN_ID}-v2`));
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 王五\n内容描述: 整体替换');
    expect(result.unchanged).toBe(false);

    const files = treeFiles();
    const prefix = `opsbot-bundle/${RUN_ID}/`;
    expect(files).toContain(`${prefix}workflow.json`);      // 源 manifest.json 仓内统一命名
    expect(files).toContain(`${prefix}sessions/S2/S2.jsonl.7z`);
    expect(files.some(f => f.startsWith(`${prefix}sessions/S1/`))).toBe(false); // 旧会话整体消失

    const entry = bundle.listLakeBundles(undefined, RUNS_ROOT).find(e => e.runId === RUN_ID)!;
    expect(entry.sessionCount).toBe(1);
    expect(entry.submitter).toBe('王五'); // meta 快照随重传刷新
  });

  it('源目录删除 → DB 导出兜底：仍可整包上传', async () => {
    fs.rmSync(path.join(FIXTURES, `${RUN_ID}-v2`), { recursive: true, force: true });
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 赵六\n内容描述: DB 导出兜底');
    expect(result.runId).toBe(RUN_ID);
    expect(result.sessionCount).toBe(1);
    expect(result.missingSessions).toEqual([]);

    const files = treeFiles();
    const prefix = `opsbot-bundle/${RUN_ID}/`;
    expect(files).toContain(`${prefix}sessions/S2/S2.jsonl.7z`); // DB 导出重建正文
    expect(files).toContain(`${prefix}bundle.meta.json`);
  });

  it('成员会话不在 insight（已删除）→ missingSessions 提示 + 包内缺正文，不阻断', async () => {
    await prisma.session.deleteMany({ where: { taskId: 'S2' } });
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 钱七\n内容描述: 缺行容忍');
    expect(result.sessionCount).toBe(0);
    expect(result.missingSessions).toEqual(['S2']);
    expect(result.warnings[0]).toMatch(/S2/);

    const files = treeFiles();
    expect(files.some(f => f.startsWith(`opsbot-bundle/${RUN_ID}/sessions/`))).toBe(false);
    // manifest/meta 仍在——包结构完整，只是缺该成员正文
    expect(files).toContain(`opsbot-bundle/${RUN_ID}/workflow.json`);
  });
});
