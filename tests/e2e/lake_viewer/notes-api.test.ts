// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// notes 路由 e2e：本地 bare 湖 + 真测试库评分卡（进程内 getScorecard：库内会话
// × SCORING_DATA_DIR 缓存）→ POST note/scorecard/opgen（plumbing push 到 bare）
// → GET 读回类型化记录 → 提交信息解析。push 必须指向本地 bare（env 覆写）——
// 默认 pushUrl 带真实共享凭据，漏设会把测试记录推到线上数据湖。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { makeBareLake } from '../../ut/lake_viewer/helpers/makeLake';
import type { Scorecard } from '../../../src/lib/scoring';
import { seedLakeConfig, switchLakeConfig } from '../../helpers/lake-env';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-viewer-notes-'));
const BARE = path.join(TMP, 'lake.git');
seedLakeConfig(TMP, { address: BARE });
process.env.LAKE_VIEWER_CACHE_DIR = path.join(TMP, 'cache');
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');

const prisma = new PrismaClient();

beforeAll(async () => {
  makeBareLake(BARE, [
    {
      time: '2026-09-01T10:00:00+08:00',
      message: '提交人: zhang3 内容描述: 冒烟会话首跑 日志路径: /tmp/ses_x.jsonl.gz 备注: 空跑验证 框架: claude-code 时间: 2026-09-01 09:55',
      sessions: [
        { sid: 'ele-note0001', paradigm: 'elementwise', framework: 'claude-code', ccVersion: '1.2.3' },
        { sid: 'ele-base0009', paradigm: 'elementwise', baseline: true, framework: 'opencode' },
      ],
    },
  ]);

  // 库内只有 ele-note0001（带 87 分卡）；ele-base0009 不在库 → 无评分卡 → 409 路径
  await prisma.session.deleteMany({ where: { taskId: { in: ['ele-note0001', 'ele-base0009'] } } });
  const row = await prisma.session.create({
    data: {
      taskId: 'ele-note0001',
      framework: 'claude-code',
      version: '1.2.3',
      startTime: new Date('2026-09-01T09:55:00+08:00'),
      endTime: new Date('2026-09-01T10:25:00+08:00'),
      totalTokens: 60_000,
    },
    select: { id: true },
  });
  const card: Scorecard = {
    schemaVersion: 'workflow-scorecard@2',
    sessionId: row.id,
    taskType: 'operator',
    computedAt: '2026-09-16T09:00:00+08:00',
    status: 'completed',
    framework: { totalScore: 87, veto: null, coverage: 1, weightsUsed: {} },
    dimensions: [
      { dimensionId: 'correctness', name: '正确性', english: 'correctness', role: 'weighted', status: 'scored', score: 0.9, items: [] },
      { dimensionId: 'efficiency', name: '效率', english: 'efficiency', role: 'weighted', status: 'scored', score: 0.84, items: [] },
      { dimensionId: 'completeness', name: '完整性', english: 'completeness', role: 'weighted', status: 'scored', score: 0.87, items: [] },
      { dimensionId: 'robustness', name: '健壮性', english: 'robustness', role: 'weighted', status: 'scored', score: 0.8, items: [] },
      { dimensionId: 'readability', name: '可读性', english: 'readability', role: 'weighted', status: 'scored', score: 0.92, items: [] },
      { dimensionId: 'maintainability', name: '可维护性', english: 'maintainability', role: 'weighted', status: 'scored', score: 0.89, items: [] },
    ],
    judgeCost: null,
  };
  const { scorecardStore } = await import('../../../src/lib/scoring');
  await scorecardStore().put(card);
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ['ele-note0001', 'ele-base0009'] } } });
  await prisma.$disconnect();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const postReq = (body: string) => new Request('http://viewer.test/lake_viewer/api/runs/x/notes', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
const ctx = (sid: string) => ({ params: Promise.resolve({ sid }) });

function bareTree(): string {
  return execSync(`git -C "${BARE}" ls-tree -r --name-only main`).toString('utf8');
}

interface ApiRecord { ts: string; type: string; text?: string; totalScore?: number | null; dimensions?: Array<{ name: string; score: number | null }> }

describe('notes api（本地 bare 湖 + 真测试库评分卡）', () => {
  it('POST note → 湖里出现 <sid>.notes.jsonl；GET 读回记录并解析提交信息', async () => {
    const { GET, POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    const res = await POST(postReq(JSON.stringify({ kind: 'note', text: '首轮 87 分，loss 收敛' })), ctx('ele-note0001'));
    expect(res.status).toBe(200);
    const { records } = await res.json() as { records: ApiRecord[] };
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe('note');
    expect(records[0]?.text).toBe('首轮 87 分，loss 收敛');

    expect(bareTree()).toContain('elementwise/ele-note0001/ele-note0001.notes.jsonl');

    const get = await GET(new Request('http://viewer.test/'), ctx('ele-note0001'));
    const data = await get.json() as {
      records: ApiRecord[];
      submit: { author: string | null; description: string | null; remark: string | null };
    };
    expect(data.records).toHaveLength(1);
    expect(data.submit.author).toBe('zhang3');
    expect(data.submit.description).toBe('冒烟会话首跑');
    expect(data.submit.remark).toBe('空跑验证');
  });

  it('POST scorecard → 6 维评分快照入湖并可读回', async () => {
    const { GET, POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    const res = await POST(postReq(JSON.stringify({ kind: 'scorecard' })), ctx('ele-note0001'));
    expect(res.status).toBe(200);
    const { records } = await res.json() as { records: ApiRecord[] };
    expect(records).toHaveLength(2);
    const card = records[1];
    expect(card?.type).toBe('scorecard');
    expect(card?.totalScore).toBe(87);
    expect(card?.dimensions).toHaveLength(6);

    const get = await GET(new Request('http://viewer.test/'), ctx('ele-note0001'));
    const data = await get.json() as { records: ApiRecord[] };
    expect(data.records.filter(r => r.type === 'scorecard')).toHaveLength(1);
  });

  it('POST scorecard 覆盖语义：再次上传替换旧快照（记录流只留最新一份，note 不动）', async () => {
    const { GET, POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    // 第一次上传（上面用例已传过一份），改卡后再传 → scorecard 仍只 1 条且为新值
    const { scorecardStore } = await import('../../../src/lib/scoring');
    const { prisma } = await import('../../../src/lib/db');
    const session = await prisma.session.findFirst({ where: { taskId: 'ele-note0001' }, select: { id: true } });
    const stored = await scorecardStore().get(session!.id);
    await scorecardStore().put({ ...stored!, framework: { ...stored!.framework, totalScore: 0.42 } });
    const res = await POST(postReq(JSON.stringify({ kind: 'scorecard' })), ctx('ele-note0001'));
    expect(res.status).toBe(200);
    const { records } = await res.json() as { records: ApiRecord[] };
    const cards = records.filter(r => r.type === 'scorecard');
    expect(cards).toHaveLength(1);                       // 旧的被覆盖，不堆积
    expect(cards[0]?.totalScore).toBe(0.42);
    expect(records.some(r => r.type === 'note')).toBe(true);   // note 记录不受影响
  });

  it('baseline 会话记录落到 baseline/ 路径', async () => {
    const { POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    const res = await POST(postReq(JSON.stringify({ kind: 'note', text: '基准备注' })), ctx('ele-base0009'));
    expect(res.status).toBe(200);
    expect(bareTree()).toContain('elementwise/baseline/ele-base0009/ele-base0009.notes.jsonl');
  });

  it('opgen：修正算子生成标注（meta.json 落湖），清除后字段移除', async () => {
    const { POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    const metaRef = 'main:elementwise/ele-note0001/ele-note0001.meta.json';
    const metaJson = () => JSON.parse(execSync(`git -C "${BARE}" show "${metaRef}"`).toString('utf8')) as { x_cannbay: { data: Record<string, unknown> } };

    expect(metaJson().x_cannbay.data.opGen).toBeUndefined(); // 夹具未标注

    const ok = await POST(postReq(JSON.stringify({ kind: 'opgen', value: 'success' })), ctx('ele-note0001'));
    expect(ok.status).toBe(200);
    expect(metaJson().x_cannbay.data.opGen).toBe('success');
    // envelope 其余字段不被破坏
    expect(metaJson().x_cannbay.data.framework).toBe('claude-code');

    const clear = await POST(postReq(JSON.stringify({ kind: 'opgen', value: null })), ctx('ele-note0001'));
    expect(clear.status).toBe(200);
    expect(metaJson().x_cannbay.data.opGen).toBeUndefined();

    const bad = await POST(postReq(JSON.stringify({ kind: 'opgen', value: 'maybe' })), ctx('ele-note0001'));
    expect(bad.status).toBe(400);
  });

  it('回归防护：viewer 自身提交（note/opgen）不顶掉描述与作者', async () => {
    const { listRuns } = await import('../../../src/app/lake_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'elementwise' });
    const row = r.items.find(x => x.sid === 'ele-note0001');
    // 此前已追加过 note / scorecard / opgen 提交（notes(viewer): …），描述/作者仍取原始上传 commit
    expect(row?.description).toBe('冒烟会话首跑');
    expect(row?.author).toBe('zhang3');
  });

  it('归属取首传 commit：外部维护提交（普通提交人格式，非 viewer 前缀）不顶掉描述与作者', async () => {
    // 模拟 meta 指标回填类维护提交：普通「提交人: … 内容描述: …」subject 触碰
    // 会话目录——归属若按「最后触碰」取，会被这类维护信息顶掉（回填事故实测）
    const work = path.join(TMP, 'maint-clone');
    fs.rmSync(work, { recursive: true, force: true });
    execSync(`git clone --quiet "${BARE}" "${work}"`, { stdio: 'pipe' });
    const metaPath = path.join(work, 'elementwise', 'ele-note0001', 'ele-note0001.meta.json');
    fs.writeFileSync(metaPath, `${fs.readFileSync(metaPath, 'utf8')}\n`);
    execSync('git add elementwise/ele-note0001', { cwd: work, stdio: 'pipe' });
    execSync('git -c user.name=maint -c user.email=maint@localhost commit -m "提交人: 维护者 内容描述: meta 指标回填（模拟维护提交）"', { cwd: work, stdio: 'pipe' });
    execSync('git push --quiet origin main', { cwd: work, stdio: 'pipe' });
    fs.rmSync(work, { recursive: true, force: true });

    const { listRuns, invalidateCaches } = await import('../../../src/app/lake_viewer/_lib/runs');
    invalidateCaches();
    const r = await listRuns({ paradigm: 'elementwise' });
    const row = r.items.find(x => x.sid === 'ele-note0001');
    expect(row?.description).toBe('冒烟会话首跑');
    expect(row?.author).toBe('zhang3');

    // NotesDialog 的「提交信息（上传时填写）」面板同口径：readSubmitInfo 也取
    // 首传，不被维护提交顶掉（与列表列一致）
    const { GET: getNotes } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    const notes = await (await getNotes(new Request('http://viewer.test/'), ctx('ele-note0001'))).json() as {
      submit: { author: string | null; description: string | null };
    };
    expect(notes.submit.author).toBe('zhang3');
    expect(notes.submit.description).toBe('冒烟会话首跑');
  });

  it('paradigm target：基线/期望配置落湖（<范式>/<范式>.jsonl）并可读回', async () => {
    const { GET, POST } = await import('../../../src/app/lake_viewer/api/paradigms/[name]/target/route');
    const postReq = (body: string) => new Request('http://viewer.test/lake_viewer/api/paradigms/x/target', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

    const empty = await GET(new Request('http://viewer.test/'), ctx('elementwise'));
    expect((await empty.json() as { target: unknown }).target).toBeNull();

    const save = await POST(postReq(JSON.stringify({ baselineMs: 5_400_000, expectedMs: 1_800_000 })), ctx('elementwise'));
    expect(save.status).toBe(200);
    expect(bareTree()).toContain('elementwise/elementwise.jsonl');
    expect(await (await GET(new Request('http://viewer.test/'), ctx('elementwise'))).json() as { target: { baselineMs: number; expectedMs: number } }).toMatchObject({
      target: { baselineMs: 5_400_000, expectedMs: 1_800_000 },
    });

    const badName = await GET(new Request('http://viewer.test/'), ctx('a/b'));
    expect(badName.status).toBe(400);
    const badValue = await POST(postReq(JSON.stringify({ baselineMs: -1 })), ctx('elementwise'));
    expect(badValue.status).toBe(400);
  });

  it('target 防误清空：畸形 body / 两键俱缺 → 400，不吞成全 null 覆盖', async () => {
    const { GET, POST } = await import('../../../src/app/lake_viewer/api/paradigms/[name]/target/route');
    const postReq = (body: string) => new Request('http://viewer.test/lake_viewer/api/paradigms/x/target', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

    const before = await (await GET(new Request('http://viewer.test/'), ctx('elementwise'))).json() as { target: { baselineMs: number } };

    const badJson = await POST(postReq('{not json'), ctx('elementwise'));
    expect(badJson.status).toBe(400);
    const noKeys = await POST(postReq(JSON.stringify({ unrelated: 1 })), ctx('elementwise'));
    expect(noKeys.status).toBe(400);
    // 键存在但值类型错误（字符串/布尔）也 400：静默收敛成 null 同样会追加全
    // null 记录抹掉参考线（review #190172787）
    const strVal = await POST(postReq(JSON.stringify({ baselineMs: '5400000' })), ctx('elementwise'));
    expect(strVal.status).toBe(400);
    const boolVal = await POST(postReq(JSON.stringify({ expectedMs: true })), ctx('elementwise'));
    expect(boolVal.status).toBe(400);

    // 被拒后既有目标原样保留（末条生效的追加式存储未被污染）
    const after = await (await GET(new Request('http://viewer.test/'), ctx('elementwise'))).json() as { target: { baselineMs: number } };
    expect(after.target.baselineMs).toBe(before.target.baselineMs);

    // 显式带键的 null 是合法清除语义
    const explicitNull = await POST(postReq(JSON.stringify({ baselineMs: null, expectedMs: 120_000 })), ctx('elementwise'));
    expect(explicitNull.status).toBe(200);
  });

  it('并发写入恢复：外部客户端 push 后再写记录（fetch 换父提交重试）', async () => {
    const { POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    // 外部客户端向 bare 推一笔新提交：viewer 镜像的 origin/main 落后（非 FF）
    const ext = path.join(TMP, 'ext-clone');
    execSync(`git clone --quiet "${BARE}" "${ext}"`, { stdio: 'pipe' });
    fs.writeFileSync(path.join(ext, `external-${Date.now()}.stamp`), 'external write');
    execSync('git add .', { cwd: ext, stdio: 'pipe' });
    execSync('git -c user.name=ext -c user.email=ext@t commit -q -m "external: advance main"', { cwd: ext, stdio: 'pipe' });
    execSync('git push -q origin main', { cwd: ext, stdio: 'pipe' });
    fs.rmSync(ext, { recursive: true, force: true });

    // 旧实现：重试用同一 stale 父提交 → 三连拒 → 502；修复后 fetch 换父提交成功
    const res = await POST(postReq(JSON.stringify({ kind: 'note', text: '并发写入后的恢复记录' })), ctx('ele-note0001'));
    expect(res.status).toBe(200);
    const { records } = await res.json() as { records: ApiRecord[] };
    expect(records.some(r => r.text === '并发写入后的恢复记录')).toBe(true);
  });

  it('空文本 400 / 未知 sid 404 / 无评分卡 409', async () => {
    const { GET, POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    const empty = await POST(postReq(JSON.stringify({ kind: 'note', text: '   ' })), ctx('ele-note0001'));
    expect(empty.status).toBe(400);
    const unknown = await GET(new Request('http://viewer.test/'), ctx('no-such-sid'));
    expect(unknown.status).toBe(404);
    // ele-base0009 不在测试库 → 无评分卡
    const noCard = await POST(postReq(JSON.stringify({ kind: 'scorecard' })), ctx('ele-base0009'));
    expect(noCard.status).toBe(409);
  });

  it('edit：按 ts+原文定位改写文本，保留原 ts；原文失配 409', async () => {
    const { GET, POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    const before = await (await GET(new Request('http://viewer.test/'), ctx('ele-note0001'))).json() as { records: ApiRecord[] };
    const target = before.records.find(r => r.type === 'note' && r.text === '首轮 87 分，loss 收敛');
    expect(target).toBeTruthy();

    const res = await POST(postReq(JSON.stringify({ kind: 'edit', ts: target?.ts, text: target?.text, newText: '首轮 87 分（修订：含 warmup）' })), ctx('ele-note0001'));
    expect(res.status).toBe(200);
    const { records } = await res.json() as { records: ApiRecord[] };
    const edited = records.find(r => r.ts === target?.ts);
    expect(edited?.text).toBe('首轮 87 分（修订：含 warmup）');
    // 行数不变（改写非追加），评分卡记录仍在
    expect(records.filter(r => r.type === 'note')).toHaveLength(before.records.filter(r => r.type === 'note').length);
    expect(records.filter(r => r.type === 'scorecard')).toHaveLength(1);

    // 原文已被改掉 → 再按旧文本编辑失配 409
    const stale = await POST(postReq(JSON.stringify({ kind: 'edit', ts: target?.ts, text: target?.text, newText: 'x' })), ctx('ele-note0001'));
    expect(stale.status).toBe(409);
  });

  it('存量裸目录（单记录位）带 recording 参数：回落现存捕获位不 404，评分卡照常入湖', async () => {
    const { GET, POST } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
    // ele-note0001 是存量裸目录会话（DB 行 framework=claude-code 无 -proxy），
    // 客户端按框架推断会带 recording=native——仓内只有捕获位，应回落到它而
    // 不是 404；评分卡取数也不按 capture→-proxy 启发式把已评分会话误判 409
    //（回归：2026-10 review ②，存量数据写入评分快照永久 409/404）
    const get = await GET(new Request('http://viewer.test/?recording=native'), ctx('ele-note0001'));
    expect(get.status).toBe(200);

    const post = await POST(new Request('http://viewer.test/lake_viewer/api/runs/x/notes?recording=native', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'scorecard' }),
    }), ctx('ele-note0001'));
    expect(post.status).toBe(200);
    const { records } = await post.json() as { records: ApiRecord[] };
    expect(records.filter(r => r.type === 'scorecard')).toHaveLength(1);
    // 不钉具体分值：前面的「覆盖语义」用例已把卡改写为 0.42，本用例回归点是
    // 状态码（404/409 不再发生）与快照入湖成功
    expect(typeof records.filter(r => r.type === 'scorecard')[0]?.totalScore).toBe('number');
  });
});

describe('归属取当前位置首传（跨位置迁移）', () => {
  it('cpx 自动上传 others/ → 人工范式上传 → 维护提交：作者=放进范式的人，不被 bot/维护顶掉', async () => {
    // 独立 bare + 镜像：others/ 首传（cann-robot 自动上传）→ 迁入 elementwise/
    //（zhang3）→ 普通格式维护提交触碰（回填形态）——归属必须落在 zhang3
    const BARE2 = path.join(TMP, 'lake-mig.git');
    makeBareLake(BARE2, [
      {
        time: '2026-09-10T10:00:00+08:00',
        message: '提交人: cann-robot 日志路径: /tmp/cpx-ele-mig0001.jsonl 备注: 框架 opencode',
        sessions: [{ sid: 'ele-mig0001', paradigm: 'others', framework: 'opencode' }],
      },
      {
        time: '2026-09-11T10:00:00+08:00',
        message: '提交人: zhang3 内容描述: 范式上传',
        rmDirs: ['others/ele-mig0001'],
        sessions: [{ sid: 'ele-mig0001', paradigm: 'elementwise', framework: 'opencode' }],
      },
      {
        time: '2026-09-12T10:00:00+08:00',
        message: '提交人: 维护者 内容描述: meta 指标回填（模拟维护提交）',
        sessions: [{ sid: 'ele-mig0001', paradigm: 'elementwise', framework: 'opencode' }],
      },
    ]);
    // 换湖走服务端 lake-config.json（单源；env 地址通道已退役，翻 env 不生效）。
    // config 与镜像 cacheDir 都是模块加载时求值：换湖必须 resetModules 后再
    // 导入，且给新湖独立 cacheDir（沿用旧镜像会拿着旧湖的克隆不重 fetch）
    const prevCache = process.env.LAKE_VIEWER_CACHE_DIR;
    process.env.LAKE_VIEWER_CACHE_DIR = path.join(TMP, 'cache-mig');
    switchLakeConfig({ address: BARE2 });
    try {
      vi.resetModules();
      const { listRuns } = await import('../../../src/app/lake_viewer/_lib/runs');
      const r = await listRuns({ paradigm: 'elementwise' });
      const row = r.items.find(x => x.sid === 'ele-mig0001');
      expect(row?.author).toBe('zhang3');
      expect(row?.description).toBe('范式上传');
      // GET /notes 的提交信息面板同口径：readSubmitInfo 按 sessionDir（当前
      // 位置）限定 log，others/ 时代的 cann-robot 更老也不参与
      const { GET: getNotes } = await import('../../../src/app/lake_viewer/api/runs/[sid]/notes/route');
      const notes = await (await getNotes(new Request('http://viewer.test/'), { params: Promise.resolve({ sid: 'ele-mig0001' }) })).json() as {
        submit: { author: string | null; description: string | null };
      };
      expect(notes.submit.author).toBe('zhang3');
      expect(notes.submit.description).toBe('范式上传');
    } finally {
      switchLakeConfig({ address: BARE });
      process.env.LAKE_VIEWER_CACHE_DIR = prevCache;
      vi.resetModules();
    }
  });
});
