// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbay2 读路径性能修复 IT：blob 批量预取 + 列表/目录合并读取。
// 背景（atomgit 实测）：partial clone 懒取 = 每个缺失 blob 一次独立 HTTPS
// 协商（~1s/个）——列表 2817 个 meta 中 2370 缺失时 readSessionMetas 被
// 120s 超时截断、type 列残缺；物化 167 缺失 blob 逐个懒取 ~80-95s。修复 =
// 一轮 git fetch <oids> 批量拉齐（实测 1601 个 9.3s vs 懒取 ~28min）+
// listOverview 让导入对话框的范式下拉+会话表共享单轮 mirror fetch（原先
// dirs/list 两路各 fetch 一次）。覆盖：
//   ① prefetchBlobs：真 partial clone 上批量拉齐缺失 blob（本地对象清单验证
//      ——不用 cat-file -e，它自己会触发懒取造成假阳性）；非法/远端不存在的
//      oid 静默跳过不炸（回退懒取路径）
//   ② listSessions：250 会话 meta（跨 FETCH_OID_CHUNK=200 分块）framework/
//      producer/opGen 全量回填，提交人从 commit subject 解析
//   ③ materializeSession：主 .jsonl.gz + 300 子代理（跨 128/批）逐字节一致
//      （gzip 二进制安全：Buffer 直写不经 utf8 往返），布局重排正确
//   ④ listOverview：sessions + topDirs 单轮 fetch 合并返回，topDirs 与
//      listRemoteDirs('') 同源（含存量区 sessions/、含范式目录）；自定义
//      单根远端 topDirs 恒 []
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { ensureMirror, listSessions, listOverview, listRemoteDirs, materializeSession, prefetchBlobs, localObjectOids } from '../../src/lib/cannbay2/mirror';
import type { Cannbay2Remote } from '../../src/lib/cannbay2/remote';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay2-prefetch-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

function makeRemote(cacheDir: string, paradigmRoots = true): Cannbay2Remote {
  // as 断言：pushAuth/lfs 字段按 remote.ts 代际可选（不写 → 对任意代际类型合法）
  return { pullUrl: BARE, pushUrl: BARE, branch: 'main', rootDir: 'sessions', cacheDir, paradigmRoots } as Cannbay2Remote;
}

function metaJson(sid: string, data?: Record<string, unknown>): string {
  return JSON.stringify({
    x_cannbay: {
      schema: 'cc-session-meta',
      version: 1,
      data: { producer: 'cpx', framework: 'opencode', ccVersion: '1.2.3', opGen: 'success', sid, ...data },
    },
  }, null, 2) + '\n';
}

function jsonlLine(text: string): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-15T00:00:00Z' }) + '\n'));
}

function seedCommit(message: string): void {
  git('git add .', SEED);
  git(`git -c user.name=seeder -c user.email=s@t commit -q -m "${message}"`, SEED);
  git('git push -q origin main', SEED);
}

function seedSession(sid: string, files: Record<string, string | Buffer>): void {
  const dir = path.join(SEED, 'sessions', sid);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  seedCommit(`提交人: seeder 内容描述: session ${sid}`);
}

beforeAll(() => {
  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', BARE);
  git('git config uploadpack.allowAnySHA1InWant true', BARE);
  execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
  fs.writeFileSync(path.join(SEED, 'README.md'), '# prefetch test\n');
  seedCommit('init');
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function newCache(paradigmRoots = true): { cacheDir: string; remote: Cannbay2Remote } {
  const cacheDir = fs.mkdtempSync(path.join(TMP, 'cache-'));
  return { cacheDir, remote: makeRemote(cacheDir, paradigmRoots) };
}

/** bare 仓内 sessions/<sid>/ 下全部 blob oid（经镜像 ls-tree）。 */
function sessionBlobOids(dir: string, sid: string): string[] {
  const out = execSync(`git ls-tree -r origin/main -- sessions/${sid}/`, { cwd: dir, encoding: 'utf-8' });
  return out.split('\n').map(l => l.match(/blob ([0-9a-f]{40})\t/)?.[1]).filter((o): o is string => !!o);
}

describe('cannbay2 blob 批量预取 + 合并列表（读路径性能）', () => {
  it('prefetchBlobs：真 partial clone 上批量拉齐；非法 oid 过滤、不存在 oid 不炸', () => {
    const sid = 'ses_prefetch_a';
    seedSession(sid, {
      [`${sid}.jsonl.gz`]: jsonlLine('prefetch target'),
      [`${sid}.meta.json`]: metaJson(sid),
      'subagents/sub-a.jsonl.gz': jsonlLine('sub a'),
    });
    const { remote } = newCache();
    const dir = ensureMirror(remote);
    const oids = sessionBlobOids(dir, sid);
    expect(oids.length).toBe(3);
    for (const oid of oids) expect(localObjectOids(dir).has(oid)).toBe(false);
    // 非法 oid（非 40 hex）被白名单过滤；远端不存在的 40-hex fetch 失败被吞
    //（fetch 按 want 原子：坏 oid 所在块整体失败 → 该块回退逐对象懒取，不炸）
    const bogus = 'deadbeef'.repeat(5);
    expect(() => prefetchBlobs(dir, ['not-an-oid', bogus])).not.toThrow();
    expect(localObjectOids(dir).has(bogus)).toBe(false);
    prefetchBlobs(dir, oids);
    const local = localObjectOids(dir);
    for (const oid of oids) expect(local.has(oid)).toBe(true);
  });

  it('listSessions：250 会话 meta 跨分块全量回填（framework/producer/opGen/submitter）', () => {
    for (let i = 0; i < 250; i++) {
      const sid = `ses_bulk_${String(i).padStart(3, '0')}`;
      fs.mkdirSync(path.join(SEED, 'sessions', sid), { recursive: true });
      fs.writeFileSync(path.join(SEED, 'sessions', sid, `${sid}.meta.json`), metaJson(sid, i === 0 ? { opGen: 'failure' } : {}));
    }
    seedCommit('提交人: seeder 内容描述: bulk metas');
    const { remote } = newCache();
    const sessions = listSessions(remote);
    const bulk = sessions.filter(s => s.sid.startsWith('ses_bulk_'));
    expect(bulk.length).toBe(250);
    for (const s of bulk) {
      expect(s.framework).toBe('opencode');
      expect(s.producer).toBe('cpx');
      expect(s.ccVersion).toBe('1.2.3');
      expect(s.opGen).toBe(s.sid.endsWith('_000') ? 'failure' : 'success');
      expect(s.submitter).toBe('seeder');
    }
  }, 120_000);

  it('materializeSession：gzip 二进制安全 + 300 子代理跨批物化逐字节一致', () => {
    const sid = 'ses_big_batch';
    const files: Record<string, string | Buffer> = {
      [`${sid}.jsonl.gz`]: jsonlLine('main binary payload'),
      [`${sid}.meta.json`]: metaJson(sid),
    };
    for (let i = 0; i < 300; i++) files[`subagents/sub-${String(i).padStart(3, '0')}.jsonl.gz`] = jsonlLine(`sub payload ${i}`);
    seedSession(sid, files);
    const { remote } = newCache();
    const mainJsonl = materializeSession(sid, remote);
    expect(mainJsonl).toBe(path.join(remote.cacheDir, 'materialized', `${sid}.jsonl.gz`));
    const seedDir = path.join(SEED, 'sessions', sid);
    expect(fs.readFileSync(mainJsonl)).toEqual(fs.readFileSync(path.join(seedDir, `${sid}.jsonl.gz`)));
    expect(fs.readFileSync(path.join(remote.cacheDir, 'materialized', `${sid}.meta.json`)))
      .toEqual(fs.readFileSync(path.join(seedDir, `${sid}.meta.json`)));
    for (let i = 0; i < 300; i++) {
      const name = `sub-${String(i).padStart(3, '0')}.jsonl.gz`;
      const got = fs.readFileSync(path.join(remote.cacheDir, 'materialized', sid, 'subagents', name));
      expect(got).toEqual(fs.readFileSync(path.join(seedDir, 'subagents', name)));
    }
  }, 120_000);

  it('listOverview：sessions + topDirs 单轮 fetch 合并返回，topDirs 与 listRemoteDirs 同源', () => {
    const { remote } = newCache();
    const overview = listOverview(remote);
    expect(overview.sessions.length).toBeGreaterThan(250);
    expect(overview.topDirs).toContain('sessions');
    expect(overview.topDirs).toEqual(listRemoteDirs(remote));
    // 同 mirror 的两份数据引用一致（免第二轮 fetch）：再取一次列表，会话集合相同
    expect(listSessions(remote).map(s => s.sid).sort()).toEqual(overview.sessions.map(s => s.sid).sort());
  });

  it('listOverview：自定义单根远端 topDirs 恒 []，sessions 照常返回', () => {
    const { remote } = newCache(false);
    const overview = listOverview(remote);
    expect(overview.topDirs).toEqual([]);
    expect(overview.sessions.length).toBeGreaterThan(0);
    expect(overview.sessions.every(s => s.paradigm === null)).toBe(true);
  });
});
