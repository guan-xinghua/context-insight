// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 镜像初始化竞态回归 IT（客户现场：git clone "destination path already
// exists and is not an empty directory"）。根因：模块级 writeLock 不跨进程
// （next dev 多 worker / CLI 自动拉起第二后端 / TUI+Web 并存），多进程在
// 同一 cacheDir 并发首拉；P2 在 P1 半成品目录上 fetch 失败 → rmSync 删掉
// P1 在写的克隆 → 再 clone 撞非空目录。修复 = 跨进程文件锁 + 锁内双检 +
// 临时目录克隆后原子 rename。覆盖：
//   ① 多进程并发首拉全部成功（真回归：4 个 tsx 子进程同 cacheDir 竞争）
//   ② 损坏残留（目录非空但无 .git）自愈
//   ③ 半成品 .git（fetch 必败）经 tmp+rename 重建
//   ④ 陈旧锁（>15min，进程崩溃残留）击穿后正常工作
//   ⑤ 成功后无 .lock / .tmp-* 残骸
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureMirror } from '../../src/lib/lake/mirror';
import type { LakeRemote } from '../../src/lib/lake/remote';
import { seedLakeConfig } from '../helpers/lake-env';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-mirror-init-'));
// 单源种子：默认远端解析（子进程 : undefined 分支）走服务端配置——
// CANNBOT_PROXY_DIR 经 spawn env 的 ...process.env 传递给子进程
seedLakeConfig(TMP, { address: path.join(TMP, 'remote.git') });
const BARE = path.join(TMP, 'remote.git');
// 第二个可 fetch 的 bare（stale-origin 回归锁需要"错误但活着"的远端——
// 空仓 fetch 不存在的分支会失败，必须有一个 main 可拉）
const BARE_ALT = path.join(TMP, 'remote-alt.git');
const SEED = path.join(TMP, 'seed');
const REPO_ROOT = path.resolve(__dirname, '../..');
const CHILD_SCRIPT = path.join(REPO_ROOT, 'tmp', 'mirror-init-child.ts');

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

function makeRemote(cacheDir: string): LakeRemote {
  return { pullUrl: BARE, pushUrl: BARE, pushAuth: null,
    pullAuth: null, branch: 'main', rootDir: 'sessions', cacheDir };
}

beforeAll(() => {
  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', BARE);
  git('git config uploadpack.allowAnySHA1InWant true', BARE);
  execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
  fs.writeFileSync(path.join(SEED, 'README.md'), '# mirror-init race test\n');
  git('git add .', SEED);
  git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
  git('git push -q origin main', SEED);
  // ALT 仓：同一 seed 内容推一份（与 BARE 内容等价但地址不同——stale-origin
  // 锁只关心地址一致性，不关心内容）
  execSync(`git init --bare -b main "${BARE_ALT}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', BARE_ALT);
  git(`git push -q "${BARE_ALT}" main`, SEED);
  fs.mkdirSync(path.dirname(CHILD_SCRIPT), { recursive: true });
  fs.writeFileSync(CHILD_SCRIPT, [
    "import { ensureMirror } from '../src/lib/lake/mirror';",
    '// MIRROR_INIT_CACHE_DIR：显式钉 cacheDir（并发竞速用例——默认远端的',
    '// cacheDir 已按远端 URL 哈希，不钉住则各子进程路径断言失效）；缺省走',
    '// 默认远端解析（相对 env 路径解析用例需要走完整链）。',
    'const explicit = process.env.MIRROR_INIT_CACHE_DIR;',
    'console.log(ensureMirror(explicit ? {',
    '  pullUrl: process.env.LAKE_REMOTE_URL!,',
    '  pushUrl: process.env.LAKE_PUSH_URL!,',
    '  pushAuth: null,',
    "  branch: 'main',",
    "  rootDir: 'sessions',",
    '  cacheDir: explicit,',
    '  pullAuth: null,',
    '} : undefined));',
    '',
  ].join('\n'));
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(CHILD_SCRIPT, { force: true }); } catch { /* best-effort */ }
});

function assertValidMirror(dir: string): void {
  expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
  const rev = execSync('git rev-parse origin/main', { cwd: dir, encoding: 'utf-8' });
  expect(rev.trim()).toMatch(/^[0-9a-f]{40}$/);
}

function residueOf(parent: string): string[] {
  try {
    return fs.readdirSync(parent).filter(n => n.endsWith('.lock') || n.includes('.tmp-'));
  } catch { return []; }
}

describe('lake mirror init race', () => {
  it('multi-process concurrent first clone: all succeed, no residue (customer regression)', async () => {
    const cacheRoot = fs.mkdtempSync(path.join(TMP, 'concurrent-'));
    // 预置损坏镜像（.git 存在但 fetch 必败）：4 个子进程全部直接进重建路径。
    // 修复前 = 4 进程同时 rmSync + clone 同一目录 → "destination path already
    // exists"；修复后 = 文件锁串行 + 锁内双检 + tmp/rename 原子换入。
    fs.mkdirSync(path.join(cacheRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, '.git', 'HEAD'), 'garbage-not-a-ref');
    const children: ChildProcess[] = [];
    const results = Array.from({ length: 4 }, () => ({ code: null as number | null, out: '', err: '' }));
    for (let i = 0; i < 4; i++) {
      const child = spawn('node_modules/.bin/tsx', [CHILD_SCRIPT], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          // explicit 分支（MIRROR_INIT_CACHE_DIR）直接读 env 构造 remote 字面量
          LAKE_REMOTE_URL: BARE,
          LAKE_PUSH_URL: BARE,
          LAKE_CACHE_DIR: cacheRoot,
          // 并发竞速用例显式钉 cacheDir：4 子进程在同一目录竞争（默认远端
          // 的 cacheDir 已按远端哈希，不钉则预置的损坏镜像与路径断言全落空）
          MIRROR_INIT_CACHE_DIR: cacheRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', d => { results[i].out += d.toString(); });
      child.stderr?.on('data', d => { results[i].err += d.toString(); });
      children.push(child);
    }
    const codes = await Promise.all(children.map((c, i) => new Promise<number | null>(resolve => {
      c.on('exit', code => { results[i].code = code; resolve(code); });
    })));
    // 4 进程同一 cacheDir 并发首拉：修复后全部成功（修复前部分进程撞
    // "destination path already exists and is not an empty directory"）
    expect(codes.every(c => c === 0)).toBe(true);
    for (const r of results) {
      expect(r.out.trim()).toBe(cacheRoot);
      expect(r.err).not.toContain('already exists');
    }
    assertValidMirror(cacheRoot);
    expect(residueOf(path.dirname(cacheRoot)).filter(n => n.startsWith(path.basename(cacheRoot)))).toEqual([]);
  }, 120_000);

  it('recovers from a non-empty leftover dir without .git', () => {
    const dir = path.join(TMP, 'junk-dir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'garbage.txt'), 'partial');
    expect(() => ensureMirror(makeRemote(dir))).not.toThrow();
    assertValidMirror(dir);
  });

  it('rebuilds a half-cloned .git (fetch fails) via temp-dir + atomic rename', () => {
    const dir = path.join(TMP, 'broken-git');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'garbage-not-a-ref');
    expect(() => ensureMirror(makeRemote(dir))).not.toThrow();
    assertValidMirror(dir);
    expect(residueOf(path.dirname(dir))).toEqual([]);
  });

  it('breaks a stale init lock left by a crashed process', () => {
    const dir = path.join(TMP, 'stale-lock');
    fs.mkdirSync(path.dirname(`${dir}.lock`), { recursive: true });
    fs.writeFileSync(`${dir}.lock`, String(process.pid));
    const old = new Date(Date.now() - 16 * 60_000);
    fs.utimesSync(`${dir}.lock`, old, old);
    expect(() => ensureMirror(makeRemote(dir))).not.toThrow();
    assertValidMirror(dir);
    expect(fs.existsSync(`${dir}.lock`)).toBe(false);
  });

  it('leaves no lock or tmp residue on success', () => {
    const dir = path.join(TMP, 'clean');
    ensureMirror(makeRemote(dir));
    ensureMirror(makeRemote(dir));
    assertValidMirror(dir);
    expect(residueOf(path.dirname(dir))).toEqual([]);
  });

  it('relative LAKE_CACHE_DIR resolves once, no doubled clone target (customer ENOENT regression)', async () => {
    // 客户现场：env 配了相对 "tmp/lake-cache" → git clone 目标参数以
    // execSync cwd 二次解析落到 <cache>/tmp/lake-cache/… 双重路径，Node
    // rename 按单层路径找源 → ENOENT。修复 = cacheDir 一律 path.resolve。
    const work = fs.mkdtempSync(path.join(TMP, 'relcwd-'));
    // tsx 必须绝对路径：子进程 cwd 是独立的 work 目录，相对路径找不到可执行文件
    const child = spawn(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [CHILD_SCRIPT], {
      cwd: work,
      env: {
        ...process.env,
        LAKE_CACHE_DIR: 'rel-cache',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', d => { out += d.toString(); });
    child.stderr?.on('data', d => { err += d.toString(); });
    const code = await new Promise<number | null>(resolve => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(err).not.toContain('ENOENT');
    // ensureMirror 返回绝对路径：相对 env 单次解析为 <cwd>/rel-cache，镜像
    // 落在其按远端哈希的子目录（默认远端 cacheDir 已哈希化）
    const dir = out.trim();
    expect(path.isAbsolute(dir)).toBe(true);
    const hashDir = createHash('sha1').update(`${BARE}|main`).digest('hex').slice(0, 12);
    expect(dir).toBe(path.join(work, 'rel-cache', hashDir));
    assertValidMirror(dir);
    // 双重路径残骸不存在（修复前 git 把克隆落到了 rel-cache/rel-cache/）
    expect(fs.existsSync(path.join(work, 'rel-cache', 'rel-cache'))).toBe(false);
  }, 120_000);

  it('stale-origin mirror（fetch 得通但指向别的仓）不再被信任，直接重建——默认仓迁址回归锁', () => {
    // 2026-09-22 事故：默认仓迁址后旧镜像 origin 仍指旧仓——旧仓活着，
    // fetch 照样成功，tryFetchMirror 旧实现只在 fetch 失败时才校验 origin
    // → 列表/上传静默读写旧仓（主页显示旧仓 113 会话）。修复 = fetch 之前
    // 先验 origin 一致性；配合 cacheDir 按远端哈希，默认远端天然新目录
    const dir = path.join(TMP, 'stale-origin');
    const remote = makeRemote(dir);
    ensureMirror(remote);
    // 模拟迁址残留：origin 改到另一个"活着且可 fetch"的仓
    git(`git remote set-url origin ${BARE_ALT}`, dir);
    expect(ensureMirror(remote)).toBe(path.resolve(dir));
    // 重建后 origin 回到期望远端，且引用可解析
    expect(execSync('git remote get-url origin', { cwd: dir, encoding: 'utf-8' }).trim()).toBe(BARE);
    assertValidMirror(dir);
  });

  it('transient fetch failure (ref lock contention) keeps mirror — config-level damage still heals', () => {
    const dir = path.join(TMP, 'transient');
    const remote = makeRemote(dir);
    ensureMirror(remote);
    // 瞬态：模拟另一进程上传时的 refs 锁竞争（origin 完好，fetch 暂时失败）
    // → 保留镜像不重建，锁释放后恢复
    const refLock = path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    fs.mkdirSync(path.dirname(refLock), { recursive: true });
    fs.writeFileSync(refLock, '');
    expect(ensureMirror(remote)).toBe(path.resolve(dir));
    expect(fs.existsSync(path.join(dir, '.git', 'config'))).toBe(true);
    fs.rmSync(refLock);
    expect(ensureMirror(remote)).toBe(path.resolve(dir));
    assertValidMirror(dir);

    // 配置级损坏：origin 被改坏（地址与期望不符）→ fetch 失败且不自愈误判 → 重建
    const broken = path.join(TMP, 'nonexistent.git');
    git(`git remote set-url origin ${broken}`, dir);
    expect(ensureMirror(remote)).toBe(path.resolve(dir));
    expect(execSync('git remote get-url origin', { cwd: dir, encoding: 'utf-8' }).trim()).toBe(BARE);
    assertValidMirror(dir);
  });
});
