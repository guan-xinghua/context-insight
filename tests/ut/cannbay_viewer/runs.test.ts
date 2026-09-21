// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 运行聚合层 IT：本地 bare 数据湖 × 真测试库（进程内取数，无 HTTP mock）→
// 混合口径 join / 筛选 / baseline delta。评分卡走 SCORING_DATA_DIR 隔离缓存
// （scorecardStore 单例惰性建目录，env 在首个测试前生效即可）。env 必须在
// src 模块导入前设置（lake remote 的 env 常量在 import 时求值）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Scorecard } from '../../../src/lib/scoring';
import { makeBareLake } from './helpers/makeLake';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-viewer-runs-'));
process.env.CANNBAY2_REMOTE_URL = path.join(TMP, 'lake.git');
process.env.CANNBAY2_LFS = '0';
process.env.CANNBAY_VIEWER_CACHE_DIR = path.join(TMP, 'cache');
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');

const seededIds: string[] = [];
const prisma = new PrismaClient();

// 测试库内已导入的三个 sid（taskId 即数据仓 sid）；指标与旧 fake insight 夹具同值。
// mix-zed0001：混格式排序专用（库内 startTime 序列化为 UTC '.000Z'）
const DB_SEED = [
  { taskId: 'ele-aaaa1111', startTime: '2026-08-01T10:05:00+08:00', endTime: '2026-08-01T10:35:00+08:00', totalTokens: 120_000, framework: 'claude-code', version: '1.2.3', model: 'test-model-a' },
  { taskId: 'ele-base9999', startTime: '2026-08-20T09:00:00+08:00', endTime: '2026-08-20T09:30:00+08:00', totalTokens: 80_000, framework: 'opencode', version: '0.9.1' },
  { taskId: 'con-bbbb2222', startTime: '2026-09-01T14:00:00+08:00', endTime: '2026-09-01T14:10:00+08:00', totalTokens: 99_000, framework: 'codex', version: '2.0.0' },
  { taskId: 'mix-zed0001', startTime: '2026-08-01T10:05:00+08:00', endTime: '2026-08-01T10:20:00+08:00', totalTokens: 1_000, framework: 'claude-code', version: '1.2.3' },
  // 双记录两行同 taskId（framework 消歧）：capture 行与 native 行指标各异
  { taskId: 'dual2-bbbb2222', startTime: '2026-09-13T09:00:00+08:00', endTime: '2026-09-13T09:20:00+08:00', totalTokens: 111_000, framework: 'claude-code-proxy', version: '1.0.0', model: 'cap-model' },
  { taskId: 'dual2-bbbb2222', startTime: '2026-09-13T10:00:00+08:00', endTime: '2026-09-13T10:40:00+08:00', totalTokens: 222_000, framework: 'opencode', version: '1.18.30', model: 'nat-model' },
  // 存量漂移：lake meta framework 与本地导入行 DB framework 不一致（单行）
  { taskId: 'fb-cccc3333', startTime: '2026-09-13T11:00:00+08:00', endTime: '2026-09-13T11:10:00+08:00', totalTokens: 3_000, framework: 'claude-code-proxy', version: '1.2.3', model: 'fb-model' },
  // 半导：lake 双记录、DB 仅 native 一行——capture 行必须保持未导入
  { taskId: 'half-dddd4444', startTime: '2026-09-13T12:00:00+08:00', endTime: '2026-09-13T12:30:00+08:00', totalTokens: 9_000, framework: 'opencode', version: '1.18.30', model: 'half-model' },
  // 活跃口径夹具：墙钟 60min，turns 两簇各 10min（中间 40min 空档）→ 活跃 20min
  { taskId: 'act-eeee5555', startTime: '2026-09-14T09:00:00+08:00', endTime: '2026-09-14T10:00:00+08:00', totalTokens: 6_000, framework: 'claude-code-proxy', version: '1.0.0-claude-proxy', model: 'act-model' },
];

beforeAll(async () => {
  makeBareLake(path.join(TMP, 'lake.git'), [
    {
      time: '2026-08-01T10:00:00+08:00',
      message: 'ele first run',
      sessions: [
        { sid: 'ele-aaaa1111', paradigm: 'elementwise', framework: 'claude-code', ccVersion: '1.2.3', opGen: 'success' },
        { sid: 'legacy-0000', paradigm: '', legacy: true, framework: 'opencode', ccVersion: '0.9.0' },
      ],
    },
    {
      time: '2026-09-01T10:00:00+08:00',
      message: '提交人: li4 内容描述: baseline + new runs 批次 备注: 无',
      sessions: [
        { sid: 'ele-base9999', paradigm: 'elementwise', baseline: true, framework: 'opencode', ccVersion: '0.9.1', producer: 'insight-export' },
        // cccc 不进 DB，但 meta 带上传时刻指标快照（spec §4.4）→ 未导入行也有精确指标
        { sid: 'ele-cccc3333', paradigm: 'elementwise', framework: 'claude-code', ccVersion: '1.2.3', startTime: '2026-09-01T11:20:00+08:00', endTime: '2026-09-01T11:50:00+08:00', totalTokens: 45_000, model: 'glm-4.7' },
        { sid: 'con-bbbb2222', paradigm: 'contraction', framework: 'codex', ccVersion: '2.0.0', workflow: 'wf-v3', opGen: 'failure' },
      ],
    },
    {
      time: '2026-09-10T10:00:00+08:00',
      message: '提交人: wang5 内容描述: 新范式先传 baseline 备注: 无',
      sessions: [
        { sid: 'gemm-base01', paradigm: 'gemm', baseline: true, framework: 'opencode', ccVersion: '0.9.1' },
      ],
    },
    {
      time: '2026-09-11T10:00:00+08:00',
      message: '提交人: zhao6 内容描述: 混格式排序夹具 备注: 无',
      sessions: [
        // 同日两条：库内 UTC '…02:05:00.000Z'（=10:05+08）vs meta '+08:00' 09:30
        // （=01:30Z，更早）——字符串比较会把 '+08' 行错排在前，epoch 比较不会
        { sid: 'mix-zed0001', paradigm: 'mixfmt', framework: 'claude-code', ccVersion: '1.2.3' },
        { sid: 'mix-plus001', paradigm: 'mixfmt', framework: 'claude-code', ccVersion: '1.2.3', startTime: '2026-08-01T09:30:00+08:00', endTime: '2026-08-01T09:40:00+08:00', totalTokens: 2_000 },
      ],
    },
    {
      time: '2026-09-12T10:00:00+08:00',
      message: '提交人: heweidong 内容描述: 同 sid 双记录上传 备注: 无',
      sessions: [
        // 同 sid 双记录：裸目录（捕获）与 .native/（原生）两个条目
        { sid: 'dual-aaaa1111', paradigm: 'dualrec', framework: 'claude-code-proxy', ccVersion: '1.0.0' },
        { sid: 'dual-aaaa1111', paradigm: 'dualrec', recording: 'native', framework: 'opencode', ccVersion: '1.18.30', startTime: '2026-09-12T09:00:00+08:00', endTime: '2026-09-12T09:40:00+08:00', totalTokens: 8_000, model: 'glm-5.3-flash' },
      ],
    },
    {
      time: '2026-09-13T10:00:00+08:00',
      message: '提交人: qi8 内容描述: 双记录 DB 消歧夹具 备注: 无',
      sessions: [
        // 两条记录都已导入（DB_SEED 两行）——消歧后各行各显各的指标
        { sid: 'dual2-bbbb2222', paradigm: 'dualdb', framework: 'claude-code-proxy', ccVersion: '1.0.0' },
        { sid: 'dual2-bbbb2222', paradigm: 'dualdb', recording: 'native', framework: 'opencode', ccVersion: '1.18.30' },
        // 单行存量漂移：lake 记 claude-code，本地导入行判为 claude-code-proxy
        { sid: 'fb-cccc3333', paradigm: 'dualdb', framework: 'claude-code', ccVersion: '1.2.3' },
        // 半导：DB 只有 native 一行（见 DB_SEED）
        { sid: 'half-dddd4444', paradigm: 'dualdb', framework: 'claude-code-proxy', ccVersion: '1.0.0' },
        { sid: 'half-dddd4444', paradigm: 'dualdb', recording: 'native', framework: 'opencode', ccVersion: '1.18.30' },
      ],
    },
    {
      time: '2026-09-14T10:00:00+08:00',
      message: '提交人: ji9 内容描述: 活跃耗时口径夹具 备注: 无',
      sessions: [
        // 已导入（DB_SEED）：turns 两簇各 10min → 耗时列显示活跃 20min（非墙钟 60min）
        { sid: 'act-eeee5555', paradigm: 'activetime', framework: 'claude-code-proxy', ccVersion: '1.0.0' },
        // 未导入：meta 快照带 activeMs=25min（优先于派生墙钟 durationMs=30min）
        { sid: 'act-ffff6666', paradigm: 'activetime', framework: 'claude-code', ccVersion: '1.2.3', startTime: '2026-09-14T09:00:00+08:00', endTime: '2026-09-14T09:30:00+08:00', activeMs: 25 * 60_000, totalTokens: 5_000 },
      ],
    },
  ]);

  // 测试库 seed：全会话独立清理（并行套件共享 dev.db，只动自己的 taskId）
  await prisma.session.deleteMany({ where: { taskId: { in: DB_SEED.map(s => s.taskId) } } });
  const { scorecardStore } = await import('../../../src/lib/scoring');
  for (const s of DB_SEED) {
    const row = await prisma.session.create({
      data: {
        taskId: s.taskId,
        framework: s.framework,
        version: s.version,
        startTime: new Date(s.startTime),
        endTime: new Date(s.endTime),
        totalTokens: s.totalTokens,
        model: s.model,
      },
      select: { id: true },
    });
    seededIds.push(row.id);
    // 活跃口径夹具的 turns：两簇各 10min（assistant 区间 [t−10min, t] 展开），
    // 中间 40min 空档 >5min 阈值切段
    if (s.taskId === 'act-eeee5555') {
      await prisma.turn.createMany({
        data: [
          { sessionId: row.id, turnIndex: 0, role: 'user', createdAt_ts: new Date('2026-09-14T09:00:00+08:00') },
          { sessionId: row.id, turnIndex: 1, role: 'assistant', createdAt_ts: new Date('2026-09-14T09:10:00+08:00'), latencyMs: 10 * 60_000 },
          { sessionId: row.id, turnIndex: 2, role: 'user', createdAt_ts: new Date('2026-09-14T09:50:00+08:00') },
          { sessionId: row.id, turnIndex: 3, role: 'assistant', createdAt_ts: new Date('2026-09-14T10:00:00+08:00'), latencyMs: 10 * 60_000 },
        ],
      });
    }
    // 评分卡缓存 seed（与旧 tests/data fixture 同值：high 82.5 / baseline 70 / low 61.2）
    const dims: Scorecard['dimensions'] = s.taskId === 'ele-aaaa1111'
      ? [
        { dimensionId: 'd1', name: '完成度', english: 'completion', role: 'weighted', status: 'scored' as const, score: 0.9, items: [] },
        { dimensionId: 'd2', name: '可信度', english: 'trust', role: 'veto' as const, status: 'scored' as const, score: null, verdict: 'clean', items: [] },
        { dimensionId: 'd3', name: '质量', english: 'quality', role: 'weighted' as const, status: 'scored' as const, score: 0.8, items: [] },
      ]
      : s.taskId === 'ele-base9999'
        ? [{ dimensionId: 'd1', name: '完成度', english: 'completion', role: 'weighted' as const, status: 'scored' as const, score: 0.7, items: [] }]
        : [
          { dimensionId: 'd1', name: '完成度', english: 'completion', role: 'weighted' as const, status: 'scored' as const, score: 0.6, items: [] },
          { dimensionId: 'd3', name: '质量', english: 'quality', role: 'weighted' as const, status: 'scored' as const, score: 0.62, items: [] },
        ];
    const total = s.taskId === 'ele-aaaa1111' ? 82.5 : s.taskId === 'ele-base9999' ? 70 : 61.2;
    const card: Scorecard = {
      schemaVersion: 'workflow-scorecard@2',
      sessionId: row.id,
      taskType: 'operator',
      computedAt: '2026-09-10T08:00:00Z',
      status: 'completed',
      framework: { totalScore: total, veto: null, coverage: 1, weightsUsed: {} },
      dimensions: dims,
      judgeCost: null,
    };
    await scorecardStore().put(card);
  }
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: DB_SEED.map(s => s.taskId) } } });
  await prisma.$disconnect();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('listParadigms', () => {
  it('范式汇总：运行数（不含 baseline）/ baseline 标记 / 排序', async () => {
    const { listParadigms } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const items = await listParadigms();
    const names = items.map(p => p.name);
    expect(names).toContain('elementwise');
    expect(names).toContain('contraction');
    expect(names).not.toContain('sessions');
    const ele = items.find(p => p.name === 'elementwise');
    expect(ele?.runCount).toBe(2);
    expect(ele?.hasBaseline).toBe(true);
    const con = items.find(p => p.name === 'contraction');
    expect(con?.runCount).toBe(1);
    expect(con?.hasBaseline).toBe(false);
    // 回归：只含 baseline 的范式（新范式首个上传）也要显示 ◆ 标记
    const gemm = items.find(p => p.name === 'gemm');
    expect(gemm?.runCount).toBe(0);
    expect(gemm?.hasBaseline).toBe(true);
  });
});

describe('listRuns（混合口径 join）', () => {
  it('elementwise：已导入行指标来自本地库，未导入行降级，baseline 行在列', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'elementwise' });
    expect(r.insightReachable).toBe(true);
    expect(r.baselineSid).toBe('ele-base9999');
    expect(r.total).toBe(3);
    const bySid = new Map(r.items.map(x => [x.sid, x]));

    const aaaa = bySid.get('ele-aaaa1111');
    expect(aaaa?.imported).toBe(true);
    expect(aaaa?.durationMs).toBe(30 * 60_000);
    expect(aaaa?.totalTokens).toBe(120_000);
    expect(aaaa?.startTimeApprox).toBe(false);
    expect(aaaa?.model).toBe('test-model-a'); // 已导入取 DB Session.model
    expect(aaaa?.insightUrl).toBe('/session/ele-aaaa1111?framework=claude-code');
    // 首个 commit 无「内容描述」标签 → null；第二个 commit 带 标签 → 解析出描述/作者
    expect(aaaa?.description).toBeNull();
    expect(aaaa?.author).toBeNull();

    const cccc = bySid.get('ele-cccc3333');
    expect(cccc?.imported).toBe(false);
    // meta 指标快照：未导入也有精确耗时/Token/开始时间/模型（无 ≈）
    expect(cccc?.durationMs).toBe(30 * 60_000);
    expect(cccc?.totalTokens).toBe(45_000);
    expect(cccc?.model).toBe('glm-4.7');
    expect(cccc?.startTime).toBe('2026-09-01T11:20:00+08:00');
    expect(cccc?.startTimeApprox).toBe(false);
    expect(cccc?.totalScore).toBeNull();
    expect(cccc?.description).toBe('baseline + new runs 批次');
    expect(cccc?.author).toBe('li4');

    const baseRow = bySid.get('ele-base9999');
    expect(baseRow?.isBaseline).toBe(true);
  });

  it('质量分 + vs baseline delta（评分卡缓存 seed 数据驱动）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'elementwise' });
    const aaaa = r.items.find(x => x.sid === 'ele-aaaa1111');
    expect(aaaa?.totalScore).toBe(82.5);
    expect(aaaa?.baselineDelta).toBe(12.5);
    expect(aaaa?.dimensions.length).toBeGreaterThan(0);
    expect(aaaa?.dimensions[0]?.score).toBe(90);
  });

  it('无 baseline 范式：delta 为空但分数照常', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'contraction' });
    expect(r.baselineSid).toBeNull();
    const con = r.items.find(x => x.sid === 'con-bbbb2222');
    expect(con?.totalScore).toBe(61.2);
    expect(con?.baselineDelta).toBeNull();
    expect(con?.workflow).toBe('wf-v3');
  });

  it('筛选：opGen / scored / imported / q / framework', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const all = await listRuns({ paradigm: 'elementwise' });
    expect(all.facets.frameworks).toEqual(['claude-code', 'opencode']);

    expect((await listRuns({ paradigm: 'elementwise', opGen: 'success' })).items.map(x => x.sid)).toEqual(['ele-aaaa1111']);
    expect((await listRuns({ paradigm: 'elementwise', scored: false })).items.map(x => x.sid)).toEqual(['ele-cccc3333']);
    expect((await listRuns({ paradigm: 'elementwise', imported: false })).items.map(x => x.sid)).toEqual(['ele-cccc3333']);
    expect((await listRuns({ paradigm: 'elementwise', q: 'cccc' })).items.map(x => x.sid)).toEqual(['ele-cccc3333']);
    expect((await listRuns({ paradigm: 'elementwise', framework: ['opencode'] })).items.map(x => x.sid)).toEqual(['ele-base9999']);
  });

  it('时间范围筛选（本地库 startTime 口径）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'elementwise', from: '2026-08-15', to: '2026-09-15' });
    expect(r.items.map(x => x.sid).sort()).toEqual(['ele-base9999', 'ele-cccc3333']);
  });

  it('时间范围筛选：时区口径不漂移（UTC Z 凌晨的运行归对本地的天）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    // 测试库 startTime 落库为 UTC：2026-08-01T02:05Z = 北京时间 08-01 10:05
    const r = await listRuns({ paradigm: 'elementwise', from: '2026-09-16', to: '2026-09-16' });
    expect(r.items.map(x => x.sid)).toEqual([]);
    // 08-01 当天（北京 10:05）命中
    const day = await listRuns({ paradigm: 'elementwise', from: '2026-08-01', to: '2026-08-01' });
    expect(day.items.map(x => x.sid)).toEqual(['ele-aaaa1111']);
  });

  it('时间范围筛选：tz 参数显式定时区（与服务器本地时区无关，review #190172825）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    // 同一时刻 2026-08-01T02:05Z：+08 用户眼里是 08-01 10:05；-05 用户眼里是
    // 07-31 22:05——两种时区各自「当天」都命中、对方「当天」不命中
    const plus8 = await listRuns({ paradigm: 'elementwise', from: '2026-08-01', to: '2026-08-01', tz: '+08:00' });
    expect(plus8.items.map(x => x.sid)).toEqual(['ele-aaaa1111']);
    const minus5 = await listRuns({ paradigm: 'elementwise', from: '2026-07-31', to: '2026-07-31', tz: '-05:00' });
    expect(minus5.items.map(x => x.sid)).toEqual(['ele-aaaa1111']);
    const wrongDay = await listRuns({ paradigm: 'elementwise', from: '2026-08-01', to: '2026-08-01', tz: '-05:00' });
    expect(wrongDay.items.map(x => x.sid)).toEqual([]);
  });
});

describe('listRuns（混格式开始时间排序）', () => {
  it('UTC "Z" 与 "+08:00" 混排按 epoch 比较（字符串比较会错序）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'mixfmt' });
    // mix-zed0001（库内 → '2026-08-01T02:05:00.000Z' = 10:05+08）新于
    // mix-plus001（meta '09:30+08:00' = 01:30Z）；字符串比较 'T09…' > 'T02…'
    // 会把 plus 排前——回归防护
    expect(r.items.map(x => x.sid)).toEqual(['mix-zed0001', 'mix-plus001']);
  });
});

describe('listRuns（同 sid 双记录）', () => {
  it('native 位：sid 无后缀、meta 字段全量、开始时间取快照（回归：meta 读不出导致 工具未知/时间为上传时刻）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'dualrec' });
    expect(r.total).toBe(2);

    const nat = r.items.find(x => x.recording === 'native');
    expect(nat?.sid).toBe('dual-aaaa1111');
    expect(nat?.framework).toBe('opencode');
    expect(nat?.ccVersion).toBe('1.18.30');
    expect(nat?.model).toBe('glm-5.3-flash');
    expect(nat?.startTime).toBe('2026-09-12T09:00:00+08:00');
    expect(nat?.startTimeApprox).toBe(false);
    expect(nat?.durationMs).toBe(40 * 60_000);
    expect(nat?.totalTokens).toBe(8_000);
    expect(nat?.description).toBe('同 sid 双记录上传');
    expect(nat?.author).toBe('heweidong');

    const cap = r.items.find(x => x.recording === 'capture');
    expect(cap?.sid).toBe('dual-aaaa1111');
    expect(cap?.framework).toBe('claude-code-proxy');
  });
});

describe('listRuns（同 sid 双记录 DB 消歧）', () => {
  it('两行都已导入：按 framework 各取本行指标/模型/URL，不再串行（review 回归）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'dualdb' });

    const nat = r.items.find(x => x.sid === 'dual2-bbbb2222' && x.recording === 'native');
    expect(nat?.imported).toBe(true);
    expect(nat?.model).toBe('nat-model');
    expect(nat?.totalTokens).toBe(222_000);
    expect(nat?.durationMs).toBe(40 * 60_000);
    expect(nat?.insightUrl).toBe('/session/dual2-bbbb2222?framework=opencode');

    const cap = r.items.find(x => x.sid === 'dual2-bbbb2222' && x.recording === 'capture');
    expect(cap?.imported).toBe(true);
    expect(cap?.model).toBe('cap-model');
    expect(cap?.totalTokens).toBe(111_000);
    expect(cap?.insightUrl).toBe('/session/dual2-bbbb2222?framework=claude-code-proxy');
  });

  it('只导 native：capture 行不被单行回落误标为已导入（review 回归）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'dualdb' });
    const nat = r.items.find(x => x.sid === 'half-dddd4444' && x.recording === 'native');
    expect(nat?.imported).toBe(true);
    expect(nat?.model).toBe('half-model');
    const cap = r.items.find(x => x.sid === 'half-dddd4444' && x.recording === 'capture');
    // 此前：另一条导入 → 本条错标已导入 + 借显他行指标 + 直达 URL 查无会话
    expect(cap?.imported).toBe(false);
  });

  it('单行存量漂移：lake framework 与 DB 行不一致仍命中（兼容回归）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'dualdb' });
    const fb = r.items.find(x => x.sid === 'fb-cccc3333');
    expect(fb?.imported).toBe(true);
    expect(fb?.model).toBe('fb-model');
    expect(fb?.totalTokens).toBe(3_000);
  });
});

describe('insightSessionUrl', () => {
  it('站内相对路径：sid 编码、framework 缺省无参', async () => {
    const { insightSessionUrl } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    expect(insightSessionUrl('abc 123', 'claude-code'))
      .toBe('/session/abc%20123?framework=claude-code');
    expect(insightSessionUrl('xyz', null)).toBe('/session/xyz');
  });
});

describe('listRuns（耗时列活跃口径）', () => {
  it('已导入行按 turns 聚类现算活跃时长（非墙钟）；未导入行优先 meta activeMs 快照', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'activetime' });
    expect(r.total).toBe(2);
    const bySid = new Map(r.items.map(x => [x.sid, x]));

    // 已导入：墙钟 60min（09:00→10:00），turns 两簇各 10min（中间 40min 空档
    // >5min 阈值切段）→ 耗时列显示活跃 20min，wallMs 保留墙钟 60min
    const eeee = bySid.get('act-eeee5555');
    expect(eeee?.imported).toBe(true);
    expect(eeee?.durationMs).toBe(20 * 60_000);
    expect(eeee?.activeKnown).toBe(true);
    expect(eeee?.wallMs).toBe(60 * 60_000);

    // 未导入：meta 快照 activeMs=25min 优先于派生墙钟 durationMs=30min（wallMs）
    const ffff = bySid.get('act-ffff6666');
    expect(ffff?.imported).toBe(false);
    expect(ffff?.durationMs).toBe(25 * 60_000);
    expect(ffff?.activeKnown).toBe(true);
    expect(ffff?.wallMs).toBe(30 * 60_000);
  });

  it('已导入但无 turns（存量夹具）→ 活跃不可算：activeKnown=false，durationMs 回落墙钟（渲染 — / wall）', async () => {
    const { listRuns } = await import('../../../src/app/cannbay_viewer/_lib/runs');
    const r = await listRuns({ paradigm: 'elementwise' });
    const aaaa = r.items.find(x => x.sid === 'ele-aaaa1111');
    expect(aaaa?.imported).toBe(true);
    expect(aaaa?.durationMs).toBe(30 * 60_000);
    expect(aaaa?.activeKnown).toBe(false);
    expect(aaaa?.wallMs).toBe(30 * 60_000);
  });
});
