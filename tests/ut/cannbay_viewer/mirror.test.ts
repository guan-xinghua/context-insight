// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据湖镜像层 IT：本地 bare 仓（spec §2 布局）→ 范式注册表 / 运行清单 /
// meta 消费（含 workflow 预留字段前向兼容）。env 在模块导入前设置
//（remote.ts 的 env 常量在 import 时求值）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBareLake } from './helpers/makeLake';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-viewer-lake-'));
process.env.CANNBAY2_REMOTE_URL = path.join(TMP, 'lake.git');
process.env.CANNBAY2_LFS = '0';
process.env.CANNBAY_VIEWER_CACHE_DIR = path.join(TMP, 'cache');

beforeAll(() => {
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
      message: 'baseline + contraction',
      sessions: [
        { sid: 'ele-base9999', paradigm: 'elementwise', baseline: true, framework: 'opencode', ccVersion: '0.9.1', producer: 'insight-export' },
        // 带上传时刻指标快照（spec §4.4 可选字段）的新代会话
        { sid: 'con-bbbb2222', paradigm: 'contraction', framework: 'codex', ccVersion: '2.0.0', workflow: 'wf-v3', opGen: 'failure', startTime: '2026-09-01T14:00:00+08:00', endTime: '2026-09-01T14:10:00+08:00', totalTokens: 99_000 },
        // 原生会话双记录位（<sid>.native/ 目录，目录内文件用真实 sid 命名）
        { sid: 'nat-eeee4444', paradigm: 'contraction', recording: 'native', framework: 'opencode', ccVersion: '1.18.30', startTime: '2026-09-02T09:00:00+08:00', endTime: '2026-09-02T09:30:00+08:00', totalTokens: 5_000, model: 'glm-5.3-flash' },
      ],
    },
  ]);
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('lake mirror（本地 bare 仓）', () => {
  it('listParadigmDirs：目录即范式注册表，排除存量区 sessions/', async () => {
    const { listParadigmDirs } = await import('../../../src/app/cannbay_viewer/_lib/lake/mirror');
    expect(await listParadigmDirs()).toEqual(['contraction', 'elementwise']);
  });

  it('listSessions：范式归属 / baseline 位 / meta 字段全量消费', async () => {
    const { listSessions } = await import('../../../src/app/cannbay_viewer/_lib/lake/mirror');
    const sessions = await listSessions();
    const bySid = new Map(sessions.map(s => [s.sid, s]));

    const aaaa = bySid.get('ele-aaaa1111');
    expect(aaaa?.paradigm).toBe('elementwise');
    expect(aaaa?.isBaseline).toBe(false);
    expect(aaaa?.recording).toBe('capture');
    expect(aaaa?.framework).toBe('claude-code');
    expect(aaaa?.ccVersion).toBe('1.2.3');
    expect(aaaa?.opGen).toBe('success');
    expect(aaaa?.workflow).toBeNull();
    expect(aaaa?.fileCount).toBeGreaterThan(0);
    // 旧代 meta（无指标快照字段）→ null 降级
    expect(aaaa?.startTime).toBeNull();
    expect(aaaa?.durationMs).toBeNull();
    expect(aaaa?.totalTokens).toBeNull();

    const base = bySid.get('ele-base9999');
    expect(base?.paradigm).toBe('elementwise');
    expect(base?.isBaseline).toBe(true);
    expect(base?.producer).toBe('insight-export');

    const con = bySid.get('con-bbbb2222');
    expect(con?.paradigm).toBe('contraction');
    expect(con?.framework).toBe('codex');
    expect(con?.workflow).toBe('wf-v3');
    expect(con?.opGen).toBe('failure');
    // 指标快照（spec §4.4）：meta 带则解析
    expect(con?.startTime).toBe('2026-09-01T14:00:00+08:00');
    expect(con?.durationMs).toBe(10 * 60_000);
    expect(con?.totalTokens).toBe(99_000);

    const legacy = bySid.get('legacy-0000');
    expect(legacy?.paradigm).toBe('sessions');

    // .native 位：sid 还原真实值（无后缀）、meta 从带后缀目录读出全量字段
    // （回归：meta 正则此前只认 <sid>/<sid>.meta.json，native 目录全空）
    const nat = bySid.get('nat-eeee4444');
    expect(nat?.paradigm).toBe('contraction');
    expect(nat?.recording).toBe('native');
    expect(nat?.framework).toBe('opencode');
    expect(nat?.ccVersion).toBe('1.18.30');
    expect(nat?.model).toBe('glm-5.3-flash');
    expect(nat?.startTime).toBe('2026-09-02T09:00:00+08:00');
    expect(nat?.durationMs).toBe(30 * 60_000);
    expect(nat?.totalTokens).toBe(5_000);
  });

  it('parseSessionFolder / sessionFolderName：目录名 ↔ 记录类互推', async () => {
    const m = await import('../../../src/app/cannbay_viewer/_lib/lake/mirror');
    expect(m.parseSessionFolder('ses_abc123')).toEqual({ sid: 'ses_abc123', recording: 'capture' });
    expect(m.parseSessionFolder('ses_abc123.native')).toEqual({ sid: 'ses_abc123', recording: 'native' });
    expect(m.sessionFolderName('ses_abc123', 'native')).toBe('ses_abc123.native');
    expect(m.sessionFolderName('ses_abc123')).toBe('ses_abc123');
  });

  it('listSessions：按 commit 时间新→旧排序', async () => {
    const { listSessions } = await import('../../../src/app/cannbay_viewer/_lib/lake/mirror');
    const sessions = await listSessions();
    expect(sessions[0]?.commitTime).not.toBe('');
    const times = sessions.map(s => s.commitTime);
    const sorted = [...times].sort((a, b) => b.localeCompare(a));
    expect(times).toEqual(sorted);
    const con = sessions.find(s => s.sid === 'con-bbbb2222');
    const ele = sessions.find(s => s.sid === 'ele-aaaa1111');
    expect(con != null && ele != null && con.commitTime > ele.commitTime).toBe(true);
  });

  it('ensureMirrorAsync：全新缓存走异步克隆，完成后进度回 idle 且镜像可用', async () => {
    process.env.CANNBAY_VIEWER_CACHE_DIR = path.join(TMP, 'cache-async');
    try {
      const mirror = await import('../../../src/app/cannbay_viewer/_lib/lake/mirror');
      const dir = await mirror.ensureMirrorAsync();
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
      expect(mirror.lakeProgress().phase).toBe('idle');
      expect(await mirror.listParadigmDirs()).toEqual(['contraction', 'elementwise']);
    } finally {
      process.env.CANNBAY_VIEWER_CACHE_DIR = path.join(TMP, 'cache');
    }
  });

  it('GET lake-status：返回进度快照', async () => {
    const { GET } = await import('../../../src/app/cannbay_viewer/api/lake-status/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json() as Record<string, unknown>;
    expect(j).toHaveProperty('phase');
    expect(j).toHaveProperty('elapsedMs');
  });
});

describe('push 鉴权解析（401 挑战式，绝不内嵌 URL）', () => {
  it('带凭据 env → pushUrl 无凭据 + pushAuth 剥出', async () => {
    const { resolveLakeRemote, parseUrlCreds } = await import('../../../src/app/cannbay_viewer/_lib/lake/remote');
    const saved = process.env.CANNBAY2_PUSH_URL;
    try {
      process.env.CANNBAY2_PUSH_URL = 'https://user%40x:p%40ss@example.com/a/b.git';
      const r = resolveLakeRemote();
      expect(r.pushUrl).toBe('https://example.com/a/b.git');
      expect(r.pushAuth).toEqual({ username: 'user@x', password: 'p@ss' });
    } finally {
      if (saved === undefined) delete process.env.CANNBAY2_PUSH_URL;
      else process.env.CANNBAY2_PUSH_URL = saved;
    }
    // 无凭据（本地 bare 测试形态）→ 匿名推
    expect(parseUrlCreds('/tmp/x.git')).toEqual({ credless: '/tmp/x.git', auth: null });
  });

  it('normalizeGitAddress：ai.gitcode.com 别名 host 改写为 gitcode.com', async () => {
    const { normalizeGitAddress } = await import('../../../src/app/cannbay_viewer/_lib/lake/remote');
    expect(normalizeGitAddress('https://ai.gitcode.com/user/lake.git'))
      .toBe('https://gitcode.com/user/lake.git');
  });
});

describe('parseSubmitInfo（提交信息字段解析）', () => {
  it('半角/全角冒号均可解析（与 cannbay2 parseCommitSubject 同口径）', async () => {
    const { parseSubmitInfo } = await import('../../../src/app/cannbay_viewer/_lib/lake/notes');
    const half = parseSubmitInfo('提交人: zhang3 内容描述: 首跑 备注: 无 框架: claude-code');
    expect(half).toEqual({ author: 'zhang3', description: '首跑', remark: '无' });
    const full = parseSubmitInfo('提交人：李四 内容描述：全角冒号上传 备注：v2 框架：opencode');
    expect(full).toEqual({ author: '李四', description: '全角冒号上传', remark: 'v2' });
  });
});
