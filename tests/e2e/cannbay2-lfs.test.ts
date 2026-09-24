// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbay2 LFS 模式 IT（与 cpx tests/cannbay-lfs.test.ts 对位）：remote.lfs
// 显式构造（不走 env，隔离干净），file:// 本地 bare + git-lfs standalone
// 传输。镜像层闭环验证：
//   ① uploadFolder：.jsonl.gz 出仓为 LFS 指针、实体落 bare.git/lfs/objects、
//      .gitattributes 保留 filter=lfs 行（缺行自动补）、meta.json 普通 blob
//   ② materializeSession：指针经 cat-file --filters（smudge 按需取实体）
//      恢复真实 gzip 字节——LFS 仓导入闭环
//   ③ listSessions：meta.json 是普通 blob，type 列照常可读
//   ④ 幂等 unchanged（指针级）
//   ⑤ 注入面回归锁：repoPath 含 shell 元字符（引号/分号/空格）的文件名
//      （ls-tree -z 原始输出，除 NUL 外任意字节都可能）物化不得执行注入
//      命令——cat-file 必须走 spawnSync argv 形式，不得内插 shell 字符串
//   ⑥ 工作树 .gitattributes 过期回归锁：默认模式上传剔除过 lfs 行的副本
//      留在镜像工作树，LFS 导入前必须按"缺声明"判定刷新（不是仅看文件
//      存在）——否则 --filters 不做 smudge，指针文本被当 gzip 落盘
// 客户机无 git-lfs 时整组跳过（LFS 模式的硬前置）。

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { hasGitLfs } from '../../src/lib/cannbay2/mirror';
import type { Cannbay2Remote } from '../../src/lib/cannbay2/remote';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay2-lfsmode-it-'));
const BARE = path.join(TMP, 'remote.git');
const BARE_URL = `file://${BARE}`;
const SEED = path.join(TMP, 'seed');
const STAGING = path.join(TMP, 'staging');
const CACHE = path.join(TMP, 'cache');

const SID = 'ses_lfsmode01ffeetestAA';
// 注入探针文件名：内插进双引号 shell 字符串时 `"; touch <PWN_NAME>; "` 会截断
// 命令并执行 touch（旧实现 execSync 的 cwd=镜像目录，文件落在镜像根）——
// argv 形式下只是普通文件名。文件名不能带 /（会被当目录分隔符），哨兵用相对名
const PWN_NAME = 'pwned-by-injection';
const EVIL_NAME = `evil"; touch ${PWN_NAME}; ".jsonl.gz`;
const EVIL_GZ = zlib.gzipSync('{"type":"user","message":{"role":"user","content":"sub"}}\n');

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

function buildRemote(): Cannbay2Remote {
  return {
    pullUrl: BARE_URL,
    pushUrl: BARE_URL,
    pushAuth: null,
    pullAuth: null,
    branch: 'main',
    rootDir: 'sessions',
    cacheDir: CACHE,
    paradigmRoots: true,
    lfs: true,
  };
}

// ── seed：带 *.gz lfs 声明的 .gitattributes + others/ 范式目录 ──
execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
execSync(`git clone --quiet "${BARE_URL}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, '.gitattributes'), '*.gz filter=lfs diff=lfs merge=lfs -text\n');
fs.mkdirSync(path.join(SEED, 'others'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'others', '.gitkeep'), '');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

// ── staging：sessions/<sid>/<sid>.jsonl.gz + meta.json（镜像层接口约定） ──
const SESSION_LINES = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'lfs mode fixture' }, timestamp: '2026-09-15T03:00:00.000Z' }),
  JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-09-15T03:00:05.000Z' }),
].join('\n') + '\n';
const MAIN_GZ = zlib.gzipSync(SESSION_LINES);
fs.mkdirSync(path.join(STAGING, 'sessions', SID), { recursive: true });
fs.writeFileSync(path.join(STAGING, 'sessions', SID, `${SID}.jsonl.gz`), MAIN_GZ);
fs.writeFileSync(path.join(STAGING, 'sessions', SID, `${SID}.meta.json`), JSON.stringify({
  x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'claude-code', ccVersion: '9.9.9', sid: SID } },
}));
// subagents/ 下放注入探针文件（随 ① 的 uploadFolder 出仓为 LFS 指针）
fs.mkdirSync(path.join(STAGING, 'sessions', SID, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(STAGING, 'sessions', SID, 'subagents', EVIL_NAME), EVIL_GZ);

const { uploadFolder, materializeSession, listSessions } = await import('../../src/lib/cannbay2/mirror');

function blobBuffer(repoPath: string): Buffer {
  const oid = git(`git rev-parse main:${repoPath}`, BARE).trim();
  return execSync(`git cat-file -p ${oid}`, { cwd: BARE, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }) as Buffer;
}

function lfsObjectPath(oidHex: string): string {
  return path.join(BARE, 'lfs', 'objects', oidHex.slice(0, 2), oidHex.slice(2, 4), oidHex);
}

const DESC = '提交人: 王五\n内容描述: lfs mode it';

describe.skipIf(!hasGitLfs())('cannbay2 LFS 模式（file:// bare + standalone 传输）', () => {
  it('① uploadFolder：指针出仓 + 实体落 LFS 存储 + .gitattributes 保留', async () => {
    const r = await uploadFolder(STAGING, SID, DESC, buildRemote(), 'others');
    expect(r.folder).toBe(`others/${SID}/`);
    expect(r.gitattributesFixed).toBe(false);

    const pointer = blobBuffer(`others/${SID}/${SID}.jsonl.gz`).toString('utf8');
    const oidHex = createHash('sha256').update(MAIN_GZ).digest('hex');
    expect(pointer.startsWith('version https://git-lfs.github.com/spec/v1')).toBe(true);
    expect(pointer).toContain(`oid sha256:${oidHex}`);
    expect(pointer).toContain(`size ${MAIN_GZ.length}`);
    expect(fs.existsSync(lfsObjectPath(oidHex))).toBe(true);
    expect(fs.readFileSync(lfsObjectPath(oidHex)).equals(MAIN_GZ)).toBe(true);

    const meta = blobBuffer(`others/${SID}/${SID}.meta.json`).toString('utf8');
    expect(meta).toContain('"framework":"claude-code"');
    expect(meta).not.toContain('git-lfs');

    expect(blobBuffer('.gitattributes').toString('utf8')).toContain('*.gz filter=lfs');
  });

  it('② materializeSession：指针 → 真实 gzip 字节（--filters smudge）', () => {
    const mainJsonl = materializeSession(SID, buildRemote());
    expect(path.basename(mainJsonl)).toBe(`${SID}.jsonl.gz`);
    expect(fs.readFileSync(mainJsonl).equals(MAIN_GZ)).toBe(true);
  });

  it('③ listSessions：meta.json 普通 blob，type 列照常', () => {
    const sessions = listSessions(buildRemote());
    const entry = sessions.find(s => s.sid === SID);
    expect(entry).toBeTruthy();
    expect(entry!.framework).toBe('claude-code');
    expect(entry!.ccVersion).toBe('9.9.9');
    expect(entry!.paradigm).toBe('others');
  });

  it('④ 幂等：重复上传同内容 → 指针级 unchanged', async () => {
    const commitsBefore = git('git rev-list --count main', BARE).trim();
    const r = await uploadFolder(STAGING, SID, DESC, buildRemote(), 'others');
    expect(r.unchanged).toBe(true);
    expect(git('git rev-list --count main', BARE).trim()).toBe(commitsBefore);
  });

  it('⑤ 注入面：repoPath 含 shell 元字符（引号/分号/空格）物化不执行注入命令', () => {
    const mainJsonl = materializeSession(SID, buildRemote());
    // 主件照常恢复（怪名文件在同树中，不拖垮整仓物化）
    expect(fs.readFileSync(mainJsonl).equals(MAIN_GZ)).toBe(true);
    // 探针文件字节级恢复（subagents/ 前缀重排到 <sid>/subagents/）
    const matSub = path.join(path.dirname(mainJsonl), SID, 'subagents', EVIL_NAME);
    expect(fs.existsSync(matSub)).toBe(true);
    expect(fs.readFileSync(matSub).equals(EVIL_GZ)).toBe(true);
    // 关键断言：注入命令未被执行——旧实现内插 shell 字符串，touch 的相对
    // 哨兵名会落在 execSync 的 cwd（镜像根 = materialized/<sid> 的上两级）
    const mirrorRoot = path.resolve(path.dirname(mainJsonl), '..', '..');
    expect(fs.existsSync(path.join(mirrorRoot, PWN_NAME))).toBe(false);
  });

  it('⑥ 工作树 .gitattributes 过期（默认模式上传剔除过 lfs 行）：导入前刷新，指针不被当 gzip 落盘', () => {
    // 复现序列：同一镜像默认模式 uploadFolder 把剔除 filter=lfs 的
    // .gitattributes 写回工作树（LFS 免疫操作）→ 远端（cpx 侧）切回 LFS 模式
    // 上传加回声明 → 本机 LFS 导入读到的还是过期副本
    const gaPath = path.join(CACHE, '.gitattributes');
    expect(fs.readFileSync(gaPath, 'utf8')).toContain('*.gz filter=lfs'); // 前置：当前副本带声明
    const stripped = fs.readFileSync(gaPath, 'utf8').split('\n').filter(l => !l.includes('filter=lfs')).join('\n');
    fs.writeFileSync(gaPath, stripped);
    expect(fs.readFileSync(gaPath, 'utf8')).not.toContain('filter=lfs'); // 前置：副本已过期

    const mainJsonl = materializeSession(SID, buildRemote());
    // 工作树副本已从 origin/main 刷新（声明回归）
    expect(fs.readFileSync(gaPath, 'utf8')).toContain('*.gz filter=lfs');
    // 实体照常恢复——不是指针文本（指针 gunzip 必炸且字节不等）
    expect(fs.readFileSync(mainJsonl).equals(MAIN_GZ)).toBe(true);
  });
});
