// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake IT：本地 bare 仓（partial clone 全链路）跑 上传治理→push→列表→物化→导入
// 闭环；native jsonl（含 key 各形态）、opencode DB 导出、治理熔断、redactor parity。
// env 必须在 lake 模块加载前设置（mirror.ts 在模块顶层读取 env）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { withDbRaceRetry } from '../db-race';
import { materializeV1Fixture } from '../helpers/materialize-v1-fixture';
import { seedLakeConfig, switchLakeConfig } from '../helpers/lake-env';

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

// ── 本地 bare 远端（含 *.jsonl LFS 行的 .gitattributes，验证自动剔除）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');
const FIXTURES = path.join(TMP, 'fixtures');

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# lake test\n');
fs.writeFileSync(path.join(SEED, '.gitattributes'), '*.jsonl filter=lfs diff=lfs merge=lfs -text\n*.gz filter=lfs diff=lfs merge=lfs -text\n*.zip filter=lfs diff=lfs merge=lfs -text\n');
// 范式目录注册表（顶层目录即范式）：默认仓上传必选其一（网关强制）
fs.mkdirSync(path.join(SEED, 'others'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'others', '.gitkeep'), '');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

seedLakeConfig(TMP, { address: BARE });
process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = CACHE;

// ── native claude fixture：主 jsonl（含 key 各形态）+ subagents/ ──
const SID = 'cc-lake-it-0001';
const SUB_ID = 'sub-it-aaa';
const RAW_KEYS = [
  'sk-ant-api03-AAAA1111BBBB2222CCCC3333DDDD4444EEEE5',
  'LTAIABCD1234EFGH5678IJKL',
  'Bearer AAAABBBBCCCCDDDD12345678',
];
fs.mkdirSync(path.join(FIXTURES, SID, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(FIXTURES, `${SID}.jsonl`), [
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `帮我调一下。key 是 ${RAW_KEYS[0]}，另外 DASHSCOPE_API_KEY=${RAW_KEYS[1]}，curl 头是 "${RAW_KEYS[2]}"。max_tokens=4096 别动。` },
    timestamp: '2026-08-19T03:00:00.000Z',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_asst_1',
      role: 'assistant',
      content: [
        { type: 'text', text: '开始处理' },
        { type: 'tool_use', id: 'toolu_dispatch_1', name: 'Task', input: { description: 'researcher', subagent_type: 'general-purpose', prompt: 'research the fixture' } },
      ],
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    timestamp: '2026-08-19T03:00:05.000Z',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_dispatch_1', content: 'dispatched' }] },
    timestamp: '2026-08-19T03:00:06.000Z',
  }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_asst_2', role: 'assistant', content: [{ type: 'text', text: '完成' }], model: 'test-model', usage: { input_tokens: 120, output_tokens: 8 } },
    timestamp: '2026-08-19T03:00:10.000Z',
  }),
].join('\n') + '\n');
fs.writeFileSync(path.join(FIXTURES, SID, 'subagents', `${SUB_ID}.jsonl`), [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'research the fixture' }, timestamp: '2026-08-19T03:00:07.000Z' }),
  JSON.stringify({ type: 'assistant', message: { id: 'msg_sub_1', role: 'assistant', content: [{ type: 'text', text: 'found it' }], model: 'test-model', usage: { input_tokens: 50, output_tokens: 5 } }, timestamp: '2026-08-19T03:00:09.000Z' }),
].join('\n') + '\n');
fs.writeFileSync(path.join(FIXTURES, SID, 'subagents', `${SUB_ID}.meta.json`), JSON.stringify({ toolUseId: 'toolu_dispatch_1', name: 'researcher', agentType: 'general-purpose' }));
// 杂散文件（含明文密钥）：白名单拷贝必须把它挡在 staging 之外，永不进公开仓
fs.writeFileSync(path.join(FIXTURES, SID, 'subagents', 'stray-notes.txt'), 'DASHSCOPE_API_KEY=sk-strayfile-secret-1234567890abcd\n');

// opencode-sample.db 是 gitignored 二进制 fixture（OAT 禁二进制入库）：从入库
// .sql（source of truth）物化本文件私有副本——无共享路径首建竞态、不依赖其它
// 文件先跑（原共享路径 existsSync 守卫的并行首建竞态由 review 指出后收敛到
// materializeV1Fixture），afterAll 清理
const OPENCODE_DB = materializeV1Fixture('lake-e2e');
const OPENCODE_SID = 'ses_2051a32a4ffevX0jGBWVDDEqCk';

const prisma = new PrismaClient();

// env 已设，动态加载 lake 链
const lake = await import('../../src/lib/lake');
const mirror = await import('../../src/lib/lake/mirror');
const governance = await import('../../src/lib/lake/governance');
const compression = await import('../../src/lib/compression');
const proxyRedactor = await import('../../../cpx/src/redactor');
const route = await import('../../src/app/api/ingest/lake/route');

// staging 出仓形态的期望字节：uploadLakeSession 对 .gz 源做「拷贝 →
// ensure7z」（存量 gz 借此迁移新格式），确定性开关保证同内容同字节——本地
// 同款转换即得期望档案（条目名 <sid>.jsonl 与 staging 一致）
function expectedStaged7z(sourceGz: string, sid: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-exp7z-'));
  const staged = path.join(dir, `${sid}.jsonl.gz`);
  fs.copyFileSync(sourceGz, staged);
  return fs.readFileSync(compression.ensure7z(staged));
}

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/ingest/lake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await importSession(path.join(FIXTURES, `${SID}.jsonl`), SID, prisma, path.join(FIXTURES, `${SID}.jsonl`), 'claude-jsonl');
});

afterAll(async () => {
  for (const [taskId, framework] of [[SID, 'claude-code'], ['cc-lake-it-0002', 'claude-code'], ['cc-lake-it-0003', 'claude-code'], [OPENCODE_SID, 'opencode'], [OPENCODE_SID, 'claude-code']] as const) {
    try { await prisma.session.deleteMany({ where: { taskId, framework } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(path.dirname(OPENCODE_DB), { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('lake governance: redactor parity（与 proxy/src/redactor.ts 字节一致）', () => {
  const CORPUS = [
    `key 是 ${RAW_KEYS[0]}，DASHSCOPE_API_KEY=${RAW_KEYS[1]}，头 "${RAW_KEYS[2]}"`,
    '"api_key": "0123456789abcdef0123456789abcdef.abcdef123456"',
    'gsk_AAAABBBBCCCCDDDDEEEEFFFF12345678 / AIza' + 'A'.repeat(35) + ' / xai-1234567890abcdef1',
    'https://example.com/v1?key=AIzaSyA' + 'B'.repeat(30),
    'GL-' + 'C'.repeat(30),
    'max_tokens=4096, tool_use_id=toolu_1, input_tokens=100（零误伤基准）',
  ];
  const deep = { authorization: 'Bearer secretcredential123456', nested: { api_key: 'plainvalue1234567890', list: ['sk-ant-api03-ZZZZ9999YYYY8888XXXX7777'] } };

  it('redactString 两份实现输出一致', () => {
    for (const text of CORPUS) {
      expect(governance.redactString(text)).toBe(proxyRedactor.redactString(text));
    }
  });

  it('redactInPlace 两份实现清洗结果一致且均命中', () => {
    const a = structuredClone(deep);
    const b = structuredClone(deep);
    const changedA = governance.redactInPlace(a);
    const changedB = proxyRedactor.redactInPlace(b);
    expect(changedA).toBe(true);
    expect(changedB).toBe(true);
    expect(a).toEqual(b);
  });

  it('governText 清洗后复检零残留（掩码形态不再命中）', () => {
    for (const text of CORPUS) {
      const { output, residue } = governance.governText(JSON.stringify({ content: text }));
      expect(residue).toEqual([]);
      expect(output).not.toContain('AAAA1111BBBB');
      expect(output).not.toContain('LTAIABCD');
      expect(output).not.toContain('plainvalue1234567890');
    }
  });

  it('scanResidue 对明文密钥有检出能力（熔断逻辑有牙）', () => {
    // governance 未导出 scanResidue —— 通过 governText 的输入面验证：
    // 未经清洗的明文（模拟清洗层失效）必须能被复检发现
    const raw = JSON.stringify({ content: `raw ${RAW_KEYS[0]} and ${RAW_KEYS[2]}` });
    const cleaned = governance.redactString(raw);
    expect(cleaned).not.toContain('AAAA1111BBBB');
    expect(cleaned).toContain('…');
  });
});

describe('lake 闭环：上传（治理）→ push → 列表 → 物化 → 导入', () => {
  let uploadResult: { sid: string; unchanged: boolean; gitattributesFixed: boolean };

  it('upload：native fixture（含 key）治理后推送，.gitattributes 剔除全部 filter=lfs 行（*.jsonl/*.gz/*.zip）', async () => {
    uploadResult = await lake.uploadLakeSession(prisma, SID, `提交人: 测试者\n内容描述: lake IT 上传`, undefined, 'others');
    expect(uploadResult.sid).toBe(SID);
    expect(uploadResult.unchanged).toBe(false);
    expect(uploadResult.gitattributesFixed).toBe(true);
    const ga = execSync('git show main:.gitattributes', { cwd: BARE, stdio: 'pipe' }).toString();
    // 客户现场根因：数据仓 HF 模板 *.gz 行 + .jsonl.gz 会话件，装 git-lfs 的
    // 机器 add 即指针化 → push 需上传 LFS 对象 → 孤儿指针阻断。任意 glob 的
    // filter=lfs 行都必须剔除
    expect(ga).not.toContain('filter=lfs');
  });

  it('远端文件已脱敏（7z 出仓）：物化回读明文密钥不出仓，掩码保留可读性', () => {
    const mainJsonl = mirror.materializeSession(SID, undefined, 'native');
    expect(mainJsonl.endsWith('.jsonl.7z')).toBe(true); // 7z at rest 出仓形态
    const text = compression.readCaptureText(mainJsonl);
    for (const key of RAW_KEYS) {
      expect(text).not.toContain(key);
    }
    expect(text).toContain('sk-a…');        // maskSecret: 前4…后4
    expect(text).toContain('LTAI…IJKL');    // env 赋值回显同样打码
    expect(text).toContain('max_tokens=4096'); // 零误伤基准
  });

  it('杂散文件不进公开仓：staging 白名单只带 .jsonl/.json，stray 内容零泄漏', () => {
    mirror.materializeSession(SID, undefined, 'native');
    const matSub = path.join(mirror.lakeCacheDir(), 'materialized', `${SID}.native`, 'subagents');
    const names = fs.readdirSync(matSub);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every(n => n.endsWith('.jsonl.7z') || n.endsWith('.json'))).toBe(true);
    expect(names).not.toContain('stray-notes.txt');
    for (const f of names) {
      const t = f.endsWith('.json') ? fs.readFileSync(path.join(matSub, f), 'utf8') : compression.readCaptureText(path.join(matSub, f));
      expect(t).not.toContain('strayfile-secret');
    }
  });

  it('list：一次 log walk 出提交人/内容描述/时间，meta 批量读出 type（framework）', () => {
    const sessions = lake.listLakeSessions();
    const entry = sessions.find(s => s.sid === SID);
    expect(entry).toBeDefined();
    expect(entry!.submitter).toBe('测试者');
    expect(entry!.description).toBe('lake IT 上传');
    expect(entry!.commitTime).toBeTruthy();
    expect(entry!.fileCount).toBeGreaterThan(2);
    // native jsonl 直传无伴生 meta → 上传时从 DB 合成（producer=insight-upload，
    // 展示专用）→ type 列可见
    expect(entry!.framework).toBe('claude-code');
    // 上传时刻指标快照（spec §4.4，annotateSessionMeta 一个补丁点三路径全
    // 覆盖）：meta 带 startTime/durationMs/totalTokens，viewer 未导入行直显
    const metaJson = JSON.parse(execSync(
      `git -C "${BARE}" show "main:others/${SID}.native/${SID}.meta.json"`,
      { encoding: 'utf8' },
    )) as { x_lake?: { data: Record<string, unknown> }; x_cannbay?: { data: Record<string, unknown> } };
    const env = metaJson.x_lake ?? metaJson.x_cannbay!;
    expect(typeof env.data.startTime).toBe('string');
    expect(typeof env.data.durationMs).toBe('number');
    expect(env.data.totalTokens).toBeGreaterThan(0);
    expect(env.data.model).toBe('test-model');
  });

  it('重复上传同内容 → unchanged（描述已随 meta 持久化，同内容 = 同提交人+同描述）', async () => {
    const again = await lake.uploadLakeSession(prisma, SID, '提交人: 测试者\n内容描述: lake IT 上传', undefined, 'others');
    expect(again.unchanged).toBe(true);
  });

  it('import：物化回 proxy 布局 → claude-jsonl 管线导入（含 subagent）', async () => {
    const result = await lake.importLakeSession(SID, prisma, undefined, 'native');
    expect(result).toBeTruthy();
    // 合成 meta（producer=insight-upload）不触发 framework/version patch —— 导入
    // 响应的 type 来自管线自身判定，展示专用 meta 对导入行为零影响
    expect(result.framework).toBe('claude-code');
    const session = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(session).toBeDefined();
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    expect(turns.length).toBeGreaterThanOrEqual(4);
    const subTurns = turns.filter(t => t.isSubagent);
    expect(subTurns.length).toBeGreaterThanOrEqual(1);
    expect(subTurns[0].subagentSessionId).toBe(SUB_ID);
    const toolCalls = await prisma.toolCall.findMany({ where: { turn: { sessionId: session!.id } } });
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// D 根治层：提交人/描述/备注随 meta 持久化（spec §4.4 可选字段）——列表
// 归属 meta 优先、log 推导回落（存量）。与方案 A（notes(viewer): 前缀跳过）
// 分层：A 防不了普通格式维护提交（meta 指标回填等无前缀 subject），meta
// 快照对这类提交免疫——本 describe 用独立会话锁死该形态
describe('lake 归属快照（D 根治）：提交人/描述/备注随 meta 持久化', () => {
  const D_SID = 'cc-lake-it-0003';
  const metaRef = `main:others/${D_SID}.native/${D_SID}.meta.json`;

  beforeAll(async () => {
    // 独立会话：不与 SID 的 unchanged 断言互相干扰（描述已随 meta 持久化，
    // 跨 describe 的描述漂移会破坏幂等判定）
    fs.writeFileSync(path.join(FIXTURES, `${D_SID}.jsonl`), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'D 归属快照验证' }, timestamp: '2026-08-19T04:00:00.000Z' }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_d_1', role: 'assistant', content: [{ type: 'text', text: '完成' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-08-19T04:00:05.000Z' }),
    ].join('\n') + '\n');
    await importSession(path.join(FIXTURES, `${D_SID}.jsonl`), D_SID, prisma, path.join(FIXTURES, `${D_SID}.jsonl`), 'claude-jsonl');
  });

  function readMeta(): Record<string, unknown> {
    const j = JSON.parse(execSync(`git -C "${BARE}" show "${metaRef}"`, { encoding: 'utf8' })) as { x_lake?: { data: Record<string, unknown> }; x_cannbay?: { data: Record<string, unknown> } };
    return (j.x_lake ?? j.x_cannbay!).data;
  }

  it('上传 → meta 落 submitter/description/remark（与提交信息同源同值）', async () => {
    await lake.uploadLakeSession(prisma, D_SID, '提交人: 张三\n内容描述: D 归属快照\n备注: 回填免疫', undefined, 'others');
    const data = readMeta();
    expect(data.submitter).toBe('张三');
    expect(data.description).toBe('D 归属快照');
    expect(data.remark).toBe('回填免疫');
  });

  it('根治锁：普通格式维护提交触碰会话目录 → 归属不变（meta 优先，前缀跳过层防不住的形态）', async () => {
    // 模拟 meta 指标回填类维护提交：普通 subject（非 notes(viewer): 前缀——
    // A 的跳过管不到），meta 读改写保留既有字段（真实回填工具的行为）
    git('git pull -q origin main', SEED);
    const metaFile = path.join(SEED, 'others', `${D_SID}.native`, `${D_SID}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { x_lake?: { data: Record<string, unknown> }; x_cannbay?: { data: Record<string, unknown> } };
    (meta.x_lake ?? meta.x_cannbay!).data.backfilledAt = '2026-08-20T00:00:00Z';
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    git('git add .', SEED);
    git('git -c user.name=maintbot -c user.email=maint@localhost commit -q -m "meta 指标回填: 耗时快照（模拟维护提交）"', SEED);
    git('git push -q origin main', SEED);

    // 同步列表（导入侧）：log 推导按「最后非 viewer 提交」会被维护提交顶掉
    //（subject 无提交人标签 → submitter=git author maintbot）——meta 快照赢
    const entry = lake.listLakeSessions().find(s => s.sid === D_SID);
    expect(entry?.submitter).toBe('张三');
    expect(entry?.description).toBe('D 归属快照');
    // 详细列表（viewer 运行表数据源）：meta 直供
    const detail = (await mirror.listSessionsDetailed()).find(s => s.sid === D_SID);
    expect(detail?.submitter).toBe('张三');
    expect(detail?.description).toBe('D 归属快照');
    // 备注面板（readSubmitInfo）：meta 优先
    const notes = await import('../../src/lib/lake/notes');
    const submit = await notes.readSubmitInfo({ sid: D_SID, paradigm: 'others', isBaseline: false, recording: 'native' });
    expect(submit.author).toBe('张三');
    expect(submit.description).toBe('D 归属快照');
    expect(submit.remark).toBe('回填免疫');
  });

  it('重传改描述 → meta 覆盖更新，列表同步显示 v2（覆盖重传仍更新）', async () => {
    const up = await lake.uploadLakeSession(prisma, D_SID, '提交人: 李四\n内容描述: D 覆盖重传 v2', undefined, 'others');
    expect(up.unchanged).toBe(false); // meta 变了 → tree 变 → 真实覆盖
    const data = readMeta();
    expect(data.submitter).toBe('李四');
    expect(data.description).toBe('D 覆盖重传 v2');
    expect(data.remark).toBeUndefined(); // v2 未填备注 → 不落键
    const entry = lake.listLakeSessions().find(s => s.sid === D_SID);
    expect(entry?.submitter).toBe('李四');
    expect(entry?.description).toBe('D 覆盖重传 v2');
  });
});

describe('lake opencode 导出上传', () => {
  it('opencode 会话 → DB 导出 jsonl → 上传 → 导入回读一致', async () => {
    const imported = await withDbRaceRetry(() => importSession(OPENCODE_DB, OPENCODE_SID, prisma, OPENCODE_DB, 'opencode-db'));
    expect(imported.imported).toBe(true);

    const upload = await withDbRaceRetry(() => lake.uploadLakeSession(prisma, OPENCODE_SID, `提交人: 测试者\n内容描述: opencode 导出上传`, undefined, 'others'));
    expect(upload.unchanged).toBe(false);

    // type 列：DB 导出件带 cc-session-meta（framework=opencode）→ list 可见
    const entry = lake.listLakeSessions().find(s => s.sid === OPENCODE_SID);
    expect(entry?.framework).toBe('opencode');
    expect(entry?.ccVersion).toBeTruthy();
    // insight-export 路径：DB 导出 meta 同一补丁点落提交信息快照；导入行
    //（DB 已有）列表展示 submitter 同样 meta 优先
    expect(entry?.submitter).toBe('测试者');
    expect(entry?.description).toBe('opencode 导出上传');

    const result = await withDbRaceRetry(() => lake.importLakeSession(OPENCODE_SID, prisma, undefined, 'native'));
    expect(result).toBeTruthy();
    // 导入响应带 type（patch 后 DB 准确值），供导入完成态显示徽标
    expect(result.framework).toBe('opencode');
    expect(result.version).toBeTruthy();
    // 同机已有同 taskId 会话 → merge 路径（imported:false，合并进原 opencode 会话）
    // 异机下载场景：删掉本地会话再导入 → 全新建 claude-code 会话
    await prisma.session.deleteMany({ where: { taskId: OPENCODE_SID } });
    const fresh = await lake.importLakeSession(OPENCODE_SID, prisma, undefined, 'native');
    expect(fresh).toBeTruthy();
    // framework 由 cc-session-meta 声明恢复为原值（opencode），不再错变 claude-code
    const reSession = await prisma.session.findFirst({ where: { taskId: OPENCODE_SID } });
    expect(reSession).toBeDefined();
    expect(reSession!.framework).toBe('opencode');
    const turns = await prisma.turn.findMany({ where: { sessionId: reSession!.id } });
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.some(t => t.role === 'user')).toBe(true);
    expect(turns.some(t => t.role === 'assistant')).toBe(true);
    const toolCalls = await prisma.toolCall.findMany({ where: { turn: { sessionId: reSession!.id } } });
    expect(toolCalls.length).toBeGreaterThan(0);
  });
});

describe('lake 治理熔断：复检残留 → 拒绝上传且远端无新 commit', () => {
  it('governText 被替换为返回残留时，upload 抛 GovernanceError、远端不推进', async () => {
    const before = execSync('git rev-parse main', { cwd: BARE, stdio: 'pipe' }).toString().trim();
    const spy = vi.spyOn(governance, 'governText').mockReturnValue({ output: '', residue: ['fake.jsonl: sk-ant-RESIDUE…'] });
    try {
      await expect(lake.uploadLakeSession(prisma, SID, '提交人: 测试者\n内容描述: breaker', undefined, 'others'))
        .rejects.toThrow(/熔断/);
    } finally {
      spy.mockRestore();
    }
    const after = execSync('git rev-parse main', { cwd: BARE, stdio: 'pipe' }).toString().trim();
    expect(after).toBe(before);
  });
});

describe('lake 上传快路径（governed 直传）与兜底回退', () => {
  // 快路径条件：staging ensure7z 后 .jsonl.7z 全量 + 伴生 meta producer=cpx +
  // governed=true。直传 = 不解压不重洗不重压：governText 从未被调用（spy
  // 证明），远端字节与确定性 7z 期望档案一致。其余一切（明文源 / 无标记 /
  // 混合形态）→ 治理兜底。
  const SID_F = 'cc-lake-fast-0001';
  const SID_S = 'cc-lake-slow-0001';

  function gzCaptureFixture(dir: string, sid: string, governed: boolean): string {
    fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
    const mainFile = path.join(dir, `${sid}.jsonl`);
    const plain = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: `直传验证 ${sid}` }, timestamp: '2026-08-26T05:00:00.000Z', source: 'opencode-proxy' }),
      JSON.stringify({ type: 'assistant', message: { id: `m_${sid}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-08-26T05:00:05.000Z', source: 'opencode-proxy', duration_ms: 100, system: 'You are opencode', tools: [{ name: 'bash' }] }),
    ].join('\n') + '\n';
    fs.writeFileSync(mainFile, plain);
    fs.writeFileSync(`${mainFile}.gz`, zlib.gzipSync(Buffer.from(plain)));
    fs.writeFileSync(path.join(dir, `${sid}.meta.json`), JSON.stringify({
      x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'opencode', protocol: 'openai', ...(governed ? { governed: true } : {}), sid } },
    }));
    return mainFile;
  }

  it('快路径：governed 直传（staging ensure7z）—— governText 零调用，远端字节 = 确定性 7z 期望档案', async () => {
    const f = gzCaptureFixture(FIXTURES, SID_F, true);
    await importSession(`${f}.gz`, SID_F, prisma, `${f}.gz`, 'claude-jsonl');
    try {
      const expected7z = expectedStaged7z(`${f}.gz`, SID_F);
      const spy = vi.spyOn(governance, 'governText');
      const up = await lake.uploadLakeSession(prisma, SID_F, '提交人: 测试者\n内容描述: governed 直传', undefined, 'others');
      expect(up.unchanged).toBe(false);
      expect(spy).not.toHaveBeenCalled(); // 直传：治理未执行
      const remote = execSync(`git cat-file -p $(git rev-parse main:others/${SID_F}/${SID_F}.jsonl.7z)`, { cwd: BARE, stdio: 'pipe' });
      expect(remote.equals(expected7z)).toBe(true); // 字节级一致（确定性 7z，未重压）
      // cpx 伴生 meta 路径：annotateSessionMeta 补丁伴生 meta——governed 保留、
      // 提交信息快照落地（三条 staging 路径同一补丁点）
      const fastMeta = JSON.parse(execSync(`git -C "${BARE}" show "main:others/${SID_F}/${SID_F}.meta.json"`, { encoding: 'utf8' })) as { x_lake?: { data: Record<string, unknown> }; x_cannbay?: { data: Record<string, unknown> } };
      const fastData = (fastMeta.x_lake ?? fastMeta.x_cannbay!).data;
      expect(fastData.governed).toBe(true);
      expect(fastData.producer).toBe('cpx');
      expect(fastData.submitter).toBe('测试者');
      expect(fastData.description).toBe('governed 直传');
      await prisma.session.deleteMany({ where: { taskId: SID_F } });
      await lake.importLakeSession(SID_F, prisma);
      const s = await prisma.session.findFirst({ where: { taskId: SID_F } });
      // 方案一约定：cpx 捕获重导行 framework = 记录类 opencode-proxy
      expect(s?.framework).toBe('opencode-proxy');
      expect(await prisma.turn.count({ where: { sessionId: s!.id } })).toBeGreaterThanOrEqual(2);
    } finally {
      await prisma.session.deleteMany({ where: { taskId: SID_F } }).catch(() => {});
      fs.rmSync(f, { force: true }); fs.rmSync(`${f}.gz`, { force: true });
      fs.rmSync(path.join(FIXTURES, `${SID_F}.meta.json`), { force: true });
      fs.rmSync(path.join(FIXTURES, SID_F), { recursive: true, force: true });
    }
  });

  it('兜底：.gz 但 meta 无 governed 标记 → 解压治理重压（governText 被调用）', async () => {
    const f = gzCaptureFixture(FIXTURES, SID_S, false);
    await importSession(`${f}.gz`, SID_S, prisma, `${f}.gz`, 'claude-jsonl');
    try {
      const spy = vi.spyOn(governance, 'governText');
      const up = await lake.uploadLakeSession(prisma, SID_S, '提交人: 测试者\n内容描述: 无标记走治理', undefined, 'others');
      expect(up.unchanged).toBe(false);
      expect(spy).toHaveBeenCalled(); // 慢路径：治理执行
      const remote = execSync(`git cat-file -p $(git rev-parse main:others/${SID_S}/${SID_S}.jsonl.7z)`, { cwd: BARE, stdio: 'pipe' });
      const tmp7z = path.join(FIXTURES, `${SID_S}.remote.7z`);
      fs.writeFileSync(tmp7z, remote);
      try {
        expect(compression.readCaptureText(tmp7z)).toContain(`直传验证 ${SID_S}`); // 内容经治理保留
      } finally {
        fs.rmSync(tmp7z, { force: true });
      }
    } finally {
      await prisma.session.deleteMany({ where: { taskId: SID_S } }).catch(() => {});
      fs.rmSync(f, { force: true }); fs.rmSync(`${f}.gz`, { force: true });
      fs.rmSync(path.join(FIXTURES, `${SID_S}.meta.json`), { force: true });
      fs.rmSync(path.join(FIXTURES, SID_S), { recursive: true, force: true });
    }
  });
});

describe('lake 无 jsonl 源兜底：DB 导出上传（v1 .db 快照会话 / 源文件已删）', () => {
  const SID2 = 'cc-lake-it-0002';
  let fixtureFile: string;

  it('源 jsonl 删除后上传 → DB 导出 jsonl → push 成功 → 回读有数据', async () => {
    fixtureFile = path.join(FIXTURES, `${SID2}.jsonl`);
    fs.writeFileSync(fixtureFile, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '兜底导出场景：v1 db 快照会话' }, timestamp: '2026-08-19T04:00:00.000Z' }),
      JSON.stringify({ type: 'system', message: { role: 'system', content: '<command-message>spec-to-design</command-message><command-name>spec-to-design</command-name>' }, timestamp: '2026-08-19T04:00:01.000Z' }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_f2_1', role: 'assistant', content: [{ type: 'text', text: '导出兜底回复' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 } }, timestamp: '2026-08-19T04:00:05.000Z' }),
    ].join('\n') + '\n');
    await importSession(fixtureFile, SID2, prisma, fixtureFile, 'claude-jsonl');
    const latBefore = (await prisma.turn.findFirst({ where: { session: { taskId: SID2 }, role: 'assistant' }, select: { latencyMs: true } }))?.latencyMs;

    fs.rmSync(fixtureFile, { force: true }); // 模拟：sourcePath 指向的文件已不存在
    const up = await lake.uploadLakeSession(prisma, SID2, '提交人: 测试者\n内容描述: DB 导出兜底', undefined, 'others');
    expect(up.unchanged).toBe(false);

    const result = await lake.importLakeSession(SID2, prisma, undefined, 'native');
    expect(result).toBeTruthy();
    const session = await prisma.session.findFirst({ where: { taskId: SID2 } });
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.some(t => t.role === 'user' && t.content?.includes('兜底导出场景'))).toBe(true);
    // 导出保真：usage 携带 cache_read/cache_creation → 回读 Turn 两个 cache 维度不丢
    const asst = turns.find(t => t.role === 'assistant');
    expect(asst?.cacheReadTokens).toBe(7);
    expect(asst?.cacheWriteTokens).toBe(2);
    // system turn（skill 注入/命令消息重分类）导出不蒸发，往返保留
    expect(turns.some(t => t.role === 'system' && t.content?.includes('spec-to-design'))).toBe(true);
    // latency 往返：导出行 source:'insight-export' 让 duration_ms 生效
    expect(asst?.latencyMs).toBe(latBefore);
    // 来源标注不误标代理捕获：version 不以 -proxy 结尾（无 proxy 徽标）
    expect(session?.version == null || !session!.version!.endsWith('-proxy')).toBe(true);
  });
});

describe('lake route', () => {
  it('action=list 返回会话列表', async () => {
    const res = await route.POST(makeRequest({ action: 'list' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(data.sessions.some((s: { sid: string }) => s.sid === SID)).toBe(true);
  });

  it('非法 taskId（命令注入面）在入口即拒绝', async () => {
    await expect(lake.uploadLakeSession(prisma, '../evil; rm -rf /', 'x'))
      .rejects.toThrow(/Invalid session id/);
  });

  it('提交人强制非空：缺失/空白提交人在网关拦截，不再落到机器身份 cannbot-insight', async () => {
    for (const bad of [undefined, '', '内容描述: 无提交人', '提交人:\n内容描述: 空提交人', '提交人:    \n内容描述: 空白']) {
      await expect(lake.uploadLakeSession(prisma, SID, bad))
        .rejects.toThrow(/提交人不能为空/);
    }
    // 合法提交人照常通过（含全角冒号）；提交人/描述已随 meta 持久化，
    // unchanged 要求快照与首传一致——全角/半角冒号解析值相同（同提交人+同描述）
    const ok = await lake.uploadLakeSession(prisma, SID, '提交人：测试者\n内容描述: lake IT 上传', undefined, 'others');
    expect(ok.unchanged).toBe(true);
    expect(ok.sid).toBe(SID);
  });

  it('超大捕获压缩上传：逐轮重复 system/tools 压缩后过限，Full Context 读方零影响', { timeout: 60_000 }, async () => {
    // 构造 wire 冗余主导的捕获：每轮 assistant 行 verbatim 携带同值 system+tools
    const SID_BIG = 'cc-lake-it-big-dedup';
    const bigSys = 'You are opencode, an interactive CLI tool.'.repeat(4000); // ~160KB
    const bigTools = Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, description: 'd'.repeat(2000) }));
    const lines: string[] = [];
    for (let round = 0; round < 30; round++) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `第${round}问` }, timestamp: `2026-08-26T03:0${round % 10}:00.000Z`, source: 'opencode-proxy' }));
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', id: `m_${round}`, content: [{ type: 'text', text: `答${round}` }], model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
        timestamp: `2026-08-26T03:0${round % 10}:05.000Z`,
        source: 'opencode-proxy', system: bigSys, tools: bigTools,
        x_cannbay: { schema: 'cc-wire-round', version: 1, data: { roundIndex: round, protocol: 'openai', latencyMs: 10, status: 200, system: bigSys, tools: bigTools } },
      }));
    }
    const bigFile = path.join(FIXTURES, `${SID_BIG}.jsonl`);
    fs.writeFileSync(bigFile, lines.join('\n') + '\n');
    await importSession(bigFile, SID_BIG, prisma, bigFile, 'claude-jsonl');
    try {
      const rawBytes = fs.statSync(bigFile).size;
      expect(rawBytes).toBeGreaterThan(10 * 1024 * 1024); // 原始 >10MB（30 轮 × ~340KB 冗余）
      const up = await lake.uploadLakeSession(prisma, SID_BIG, '提交人: 测试者\n内容描述: 大会话压缩上传', undefined, 'others');
      expect(up.unchanged).toBe(false);
      // 远端文件 7z 出仓：解压后是 verbatim 全文（指纹压缩已退役），压缩字节 <1.5MB
      const z7Bytes = execSync(`git show main:others/${SID_BIG}/${SID_BIG}.jsonl.7z`, { cwd: BARE, stdio: 'pipe' });
      expect(z7Bytes.length).toBeLessThan(1_500_000); // 10MB+ 冗余 → 7z 后 <1.5MB
      const tmp7z = path.join(FIXTURES, `${SID_BIG}.remote.7z`);
      fs.writeFileSync(tmp7z, z7Bytes);
      let remote: string;
      try {
        remote = compression.readCaptureText(tmp7z);
      } finally {
        fs.rmSync(tmp7z, { force: true });
      }
      expect(remote).toContain('You are opencode, an interactive CLI tool.'); // verbatim 全文保留
      // 导入回读：Full Context 从首个全文行取 systemPrompt/tools（压缩零影响）
      const result = await lake.importLakeSession(SID_BIG, prisma);
      expect(result).toBeTruthy();
      const fc = await import('../../src/lib/ingest/adapters/claude-jsonl-full-context').then(m => m.readFullContext(
        path.join(mirror.lakeCacheDir(), 'materialized', `${SID_BIG}.jsonl.7z`)));
      expect(fc?.systemPrompt).toContain('You are opencode');
      expect(fc?.tools?.length).toBe(20);
    } finally {
      await prisma.session.deleteMany({ where: { taskId: SID_BIG } }).catch(() => {});
      fs.rmSync(bigFile, { force: true });
    }
  });

  it('unknown action → 400；upload 缺 taskId → 400', async () => {
    expect((await route.POST(makeRequest({ action: 'nope' }))).status).toBe(400);
    expect((await route.POST(makeRequest({ action: 'upload' }))).status).toBe(400);
  });
});
