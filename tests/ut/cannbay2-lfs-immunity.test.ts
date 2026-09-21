// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// LFS 免疫 IT：模拟客户现场最恶劣组合——
//   远端：.gitattributes 带 *.gz filter=lfs + 历史里已有孤儿指针 blob
//         （atomgit "project lfs not enabled"，对象永不可取）
//   本机：gitconfig 挂着 lfs filter（process/smudge/clean=失败命令 + required=true，
//         等效装了 git-lfs；且客户实测 git lfs uninstall 清不掉 system/XDG 级配置）
// 断言：镜像操作（checkout/add/push）全程免疫——新会话上传成功且远端是真实
// gzip；被指针污染的会话重传后远端自愈（同路径覆盖为真实 gzip）。
// 免疫来源：mirror.runGit per-command filter 中和 + push --no-verify +
// uploadFolder 的 .gitattributes strip（三层配套）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCaptureText } from '../../src/lib/compression.ts';
import { importSession } from '../../src/lib/ingest/data-service';

// ── 本地 bare 远端：带 lfs 行的 .gitattributes + 孤儿指针会话 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay2-lfs-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');
const FIXTURES = path.join(TMP, 'fixtures');

const NEW_SID = 'ses_lfsnew01ffeetestAA';
const POISON_SID = 'ses_lfspois001ffeetestAA';
const POINTER_BLOB = [
  'version https://git-lfs.github.com/spec/v1',
  'oid sha256:1111111111111111111111111111111111111111111111111111111111111111',
  'size 313227',
].join('\n') + '\n';

function git(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, '.gitattributes'), '*.7z filter=lfs diff=lfs merge=lfs -text\n*.gz filter=lfs diff=lfs merge=lfs -text\n');
fs.mkdirSync(path.join(SEED, 'others'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'others', '.gitkeep'), '');
// 孤儿指针会话（同路径将被重传自愈）
fs.mkdirSync(path.join(SEED, 'others', POISON_SID, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'others', POISON_SID, `${POISON_SID}.jsonl.7z`), POINTER_BLOB);
fs.writeFileSync(path.join(SEED, 'others', POISON_SID, 'subagents', 'sub-poison.jsonl.7z'), POINTER_BLOB);
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
// --no-verify：装了 git-lfs 的机器上新克隆自带 lfs pre-push 钩子，seed 推
// 的是故意放的孤儿指针（LFS 对象 1111… 本就不存在），钩子必拒——跳过钩子
// 保证 seed 与机器 git-lfs 状态无关（生产代码的免疫另有三层防线，不靠这里）
git('git push --no-verify -q origin main', SEED);

process.env.CANNBAY2_REMOTE_URL = BARE;
process.env.CANNBAY2_LFS = '0';
process.env.CANNBAY2_PUSH_URL = BARE;
process.env.CANNBAY2_CACHE_DIR = CACHE;

// ── 真实会话 fixture（两份，content 相同、sid 不同）──
const FIXTURE_LINES = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'lfs immunity fixture' }, timestamp: '2026-09-03T03:00:00.000Z', source: 'claude-proxy', x_cannbay: { schema: 'it-wire-evidence', version: 1, data: {} } }),
  JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-09-03T03:00:05.000Z' }),
].join('\n') + '\n';

fs.mkdirSync(FIXTURES, { recursive: true });
for (const sid of [NEW_SID, POISON_SID]) {
  fs.writeFileSync(path.join(FIXTURES, `${sid}.jsonl`), FIXTURE_LINES);
}

const prisma = new PrismaClient();
const cannbay2 = await import('../../src/lib/cannbay2');

// ── 恶意 lfs 配置：等效"装了 git-lfs 且远端 LFS 不可用"——filter 一旦被
// 调用即失败（false 命令 exit 1）+ required=true → git fatal ──
const HOSTILE: Record<string, string> = {
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'filter.lfs.process', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'filter.lfs.smudge', GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'filter.lfs.clean', GIT_CONFIG_VALUE_2: 'false',
  GIT_CONFIG_KEY_3: 'filter.lfs.required', GIT_CONFIG_VALUE_3: 'true',
};
const savedEnv: Record<string, string | undefined> = {};
function setHostile() {
  for (const [k, v] of Object.entries(HOSTILE)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}
function clearHostile() {
  for (const k of Object.keys(HOSTILE)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

beforeAll(async () => {
  for (const sid of [NEW_SID, POISON_SID]) {
    await importSession(path.join(FIXTURES, `${sid}.jsonl`), sid, prisma, path.join(FIXTURES, `${sid}.jsonl`), 'claude-jsonl');
  }
});

afterAll(async () => {
  clearHostile();
  // 模块级设的 CANNBAY2_* 指向本文件 TMP（已删）——vitest worker 复用时会把
  // env 带给同 worker 的下一个测试文件（其模块级赋值只在自己的模块加载时
  // 生效，晚于本文件的残留）→ 指向死目录导致其镜像操作随机失败。清键防泄。
  delete process.env.CANNBAY2_REMOTE_URL;
  delete process.env.CANNBAY2_PUSH_URL;
  delete process.env.CANNBAY2_CACHE_DIR;
  await prisma.session.deleteMany({ where: { taskId: { in: [NEW_SID, POISON_SID] } } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function remoteShow(rel: string): Buffer {
  return execSync(`git show "main:${rel}"`, { cwd: BARE, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
}

describe('cannbay2 LFS 免疫：恶意 filter 配置 + 远端孤儿指针', () => {
  it('对照面：不中和时 checkout 必炸（验证 hostile 配置真的有牙）', () => {
    // 裸 git（不过 runGit 的 per-command 中和）在 hostile 配置下 checkout
    // 指针路径 → smudge false + required=true → fatal。这证明免疫不是环境巧合。
    const probe = fs.mkdtempSync(path.join(TMP, 'probe-'));
    execSync(`git clone --quiet --filter=blob:none --no-checkout "${BARE}" "${probe}"`, { stdio: 'pipe' });
    setHostile();
    try {
      expect(() => {
        execSync(`git sparse-checkout init --no-cone && git sparse-checkout set "/others/${POISON_SID}/**" && git checkout -B main origin/main`,
          { cwd: probe, stdio: 'pipe', shell: '/bin/bash', timeout: 60_000 });
      }).toThrow();
    } finally {
      clearHostile();
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });

  it('新会话上传：checkout/add/push 全程免疫，远端落真实 gzip + .gitattributes 剔除 lfs 行', async () => {
    setHostile();
    try {
      const result = await cannbay2.uploadCannbay2Session(prisma, NEW_SID, '提交人: 测试 内容描述: lfs immunity', undefined, 'others');
      expect(result.unchanged).toBe(false);

      const blob = remoteShow(`others/${NEW_SID}/${NEW_SID}.jsonl.7z`);
      // 7z magic（不是指针文本）：37 7A BC AF 27 1C
      expect(blob.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe(true);
      const tmp = path.join(os.tmpdir(), `lfs-imm-7z-${NEW_SID}.7z`);
      fs.writeFileSync(tmp, blob);
      expect(readCaptureText(tmp)).toContain('lfs immunity fixture');

      const ga = remoteShow('.gitattributes').toString('utf8');
      expect(ga).not.toContain('filter=lfs');
    } finally {
      clearHostile();
    }
  });

  it('污染自愈：重传被指针占据的会话 → 远端同路径覆盖为真实 gzip', async () => {
    // 对照：污染确实存在（seed 后远端是指针）
    expect(remoteShow(`others/${POISON_SID}/${POISON_SID}.jsonl.7z`).toString('utf8')).toContain('git-lfs');

    setHostile();
    try {
      const result = await cannbay2.uploadCannbay2Session(prisma, POISON_SID, '提交人: 测试 内容描述: heal poisoned session', undefined, 'others');
      expect(result.unchanged).toBe(false);

      const healed = remoteShow(`others/${POISON_SID}/${POISON_SID}.jsonl.7z`);
      expect(healed.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe(true);
      const tmp = path.join(os.tmpdir(), `lfs-imm-healed-${POISON_SID}.7z`);
      fs.writeFileSync(tmp, healed);
      expect(readCaptureText(tmp)).toContain('lfs immunity fixture');
    } finally {
      clearHostile();
    }
  });
});
