// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 原生会话同步上传 IT（uploadLakeSessionWithNative 组合层 + 路由接线）：
//   ① 磁盘发现：捕获行 + 本机 claude 原生日志（未导入）→ 上传时自动导入并
//      同步落 <sid>.native/（同 sid 双记录）
//   ② 路由级：native-preview 只读预检（origin=db）+ withNative 上传双落位
//   ③ codex：时间窗 + 首问锚点命中的 rollout 以自己的 uuid 落 <uuid>.native/
//   ④ 未找到：原生 not-found 不阻断捕获上传（结果独立上报）
//   ⑤ 回归：不带 withNative 的上传行为不变（无 native 键）
// env 必须在模块加载前设置（同 lake-remote-it 纪律）。
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { seedLakeConfig } from '../helpers/lake-env';
import { materializeV1Fixture } from '../helpers/materialize-v1-fixture';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-native-it-'));
const BARE = path.join(TMP, 'remote.git');
const CACHE = path.join(TMP, 'cache');
const FIXTURES = path.join(TMP, 'fixtures');
const CLAUDE_ROOT = path.join(TMP, 'claude-projects');
const CODEX_ROOT = path.join(TMP, 'codex-sessions');

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
{
  const seed = path.join(TMP, 'seed');
  execSync(`git clone --quiet "${BARE}" "${seed}"`, { stdio: 'pipe' });
  fs.writeFileSync(path.join(seed, 'README.md'), '# native sync it\n');
  fs.mkdirSync(path.join(seed, 'others'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'others', '.gitkeep'), '');
  git('git add .', seed);
  git('git -c user.name=seed -c user.email=seed@t commit -q -m init', seed);
  git('git push -q origin main', seed);
}

process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = CACHE;
seedLakeConfig(TMP, { address: BARE });

const SID_DISK = 'cc-native-it-disk';
const SID_DB = 'cc-native-it-db';
const SID_MISS = 'cc-native-it-miss';
const SID_PLAIN = 'cc-native-it-plain';
const CODEX_SID = 'cc-native-it-codex';
const CODEX_UUID = 'aaaa0dec-uuid-it-0001';
const ANCHOR = 'codex 原生对位锚点问题';
const CANNBOT_SID = 'ses_2051a32a4ffevX0jGBWVDDEqCk';

const NOW = new Date();
const T0 = new Date(NOW.getTime() - 60_000).toISOString();
const T1 = new Date(NOW.getTime() - 30_000).toISOString();

function captureLines(firstUser: string, source: string): string {
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: firstUser }, timestamp: T0, source, x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_nat_1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: T1 }),
  ].join('\n') + '\n';
}

function nativeLines(firstUser: string): string {
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: firstUser }, timestamp: T0 }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_natn_1', role: 'assistant', content: [{ type: 'text', text: 'native done' }], model: 'test-model', usage: { input_tokens: 12, output_tokens: 3 } }, timestamp: T1 }),
  ].join('\n') + '\n';
}

function writeFixture(rel: string, content: string): string {
  const p = path.join(FIXTURES, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// 捕获 fixture（导入后 framework = *-proxy）
const CAP_DISK = writeFixture(`${SID_DISK}.jsonl`, captureLines('磁盘发现场景首问', 'claude-proxy'));
const CAP_DB = writeFixture(`${SID_DB}.jsonl`, captureLines('路由级场景首问', 'claude-proxy'));
const NATIVE_DB = writeFixture(`${SID_DB}-native.jsonl`, nativeLines('路由级场景首问'));
const CAP_MISS = writeFixture(`${SID_MISS}.jsonl`, captureLines('未找到场景首问', 'claude-proxy'));
const CAP_PLAIN = writeFixture(`${SID_PLAIN}.jsonl`, captureLines('回归场景首问', 'claude-proxy'));
const CAP_CODEX = writeFixture(`${CODEX_SID}.jsonl`, captureLines(ANCHOR, 'codex-proxy'));
const CAP_CANNBOT = writeFixture(`${CANNBOT_SID}.jsonl`, captureLines('cannbot 原生对位首问', 'cannbot-proxy'));
const OPENCODE_NATIVE_DB = materializeV1Fixture('lake-native-cannbot');

// 磁盘 claude 原生日志（未导入——上传时组合层自动导入）
fs.mkdirSync(path.join(CLAUDE_ROOT, 'proj-slug'), { recursive: true });
fs.writeFileSync(path.join(CLAUDE_ROOT, 'proj-slug', `${SID_DISK}.jsonl`), nativeLines('磁盘发现场景首问'));

// codex rollout：首问 = 锚点，mtime = 现在（捕获时间窗内）
fs.mkdirSync(path.join(CODEX_ROOT, '2026', '10', '24'), { recursive: true });
fs.writeFileSync(
  path.join(CODEX_ROOT, '2026', '10', '24', `rollout-2026-10-24T01-00-00-${CODEX_UUID}.jsonl`),
  [
    JSON.stringify({ timestamp: T0, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: ANCHOR }] } }),
    JSON.stringify({ timestamp: T1, type: 'token_usage_record', payload: { usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join('\n') + '\n',
);

function emptyRoots() {
  return {
    claude: path.join(TMP, 'no-claude'),
    codex: path.join(TMP, 'no-codex'),
    dsh: path.join(TMP, 'no-dsh'),
    opencode: [path.join(TMP, 'no-opencode')],
  };
}

function diskRoots() {
  return { claude: CLAUDE_ROOT, codex: CODEX_ROOT, dsh: path.join(TMP, 'no-dsh'), opencode: [path.join(TMP, 'no-opencode')] };
}

function cannbotNativeRoots() {
  return { claude: path.join(TMP, 'no-claude'), codex: path.join(TMP, 'no-codex'), dsh: path.join(TMP, 'no-dsh'), opencode: [path.dirname(OPENCODE_NATIVE_DB)] };
}

const prisma = new PrismaClient();

// env 已设，动态加载 lake 链 + 路由
const lake = await import('../../src/lib/lake');
const route = await import('../../src/app/api/ingest/lake/route');

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/lake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ALL_SIDS = [SID_DISK, SID_DB, SID_MISS, SID_PLAIN, CODEX_SID, CODEX_UUID, CANNBOT_SID];

afterAll(async () => {
  for (const sid of ALL_SIDS) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(path.dirname(OPENCODE_NATIVE_DB), { recursive: true, force: true });
});

const DESC = '提交人: 测试者\n内容描述: 原生同步上传 IT';

describe('原生会话同步上传（组合层）', () => {
  it('① 磁盘发现：claude 原生日志自动导入并同步落 <sid>.native/，lake 双记录可见', async () => {
    await importSession(CAP_DISK, SID_DISK, prisma, CAP_DISK, 'claude-jsonl');
    // 前置：原生行未导入（磁盘发现路径，非 DB 直查）
    expect(await prisma.session.findFirst({ where: { taskId: SID_DISK, framework: 'claude-code' } })).toBeNull();

    const up = await lake.uploadLakeSessionWithNative(prisma, SID_DISK, {
      description: DESC, category: 'others', framework: 'claude-code-proxy', withNative: true, nativeRoots: diskRoots(),
    });
    expect(up.sid).toBe(SID_DISK);
    expect(up.native?.status).toBe('uploaded');
    expect(up.native?.sid).toBe(SID_DISK);
    expect(up.native?.folder).toContain(`${SID_DISK}.native`);

    // 磁盘命中的原生会话已导入建行
    const nativeRow = await prisma.session.findFirst({ where: { taskId: SID_DISK, framework: 'claude-code' } });
    expect(nativeRow).not.toBeNull();

    const overview = lake.listLakeOverview();
    const recordings = overview.sessions.filter(s => s.sid === SID_DISK).map(s => s.recording).sort();
    expect(recordings).toEqual(['capture', 'native']);
  });

  it('② 路由级：native-preview 只读预检（origin=db）+ withNative 上传双落位', async () => {
    await importSession(CAP_DB, SID_DB, prisma, CAP_DB, 'claude-jsonl');
    await importSession(NATIVE_DB, SID_DB, prisma, NATIVE_DB, 'claude-jsonl');

    const prev = await route.POST(makeRequest({ action: 'native-preview', taskId: SID_DB, framework: 'claude-code-proxy' }));
    expect(prev.status).toBe(200);
    const prevData = await prev.json();
    expect(prevData.resolution).toMatchObject({ status: 'found', origin: 'db', sid: SID_DB, framework: 'claude-code' });

    const res = await route.POST(makeRequest({
      action: 'upload', taskId: SID_DB, framework: 'claude-code-proxy', description: DESC, category: 'others', withNative: true,
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sid).toBe(SID_DB);
    expect(data.native).toMatchObject({ status: 'uploaded', sid: SID_DB });

    const overview = lake.listLakeOverview();
    const recordings = overview.sessions.filter(s => s.sid === SID_DB).map(s => s.recording).sort();
    expect(recordings).toEqual(['capture', 'native']);
  });

  it('③ codex：rollout 以自己的 uuid 落 <uuid>.native/（原生 sid ≠ 捕获 sid）', async () => {
    await importSession(CAP_CODEX, CODEX_SID, prisma, CAP_CODEX, 'claude-jsonl');
    const capRow = await prisma.session.findFirst({ where: { taskId: CODEX_SID } });
    expect(capRow?.framework).toBe('codex-proxy');

    const up = await lake.uploadLakeSessionWithNative(prisma, CODEX_SID, {
      description: DESC, category: 'others', framework: 'codex-proxy', withNative: true, nativeRoots: diskRoots(),
    });
    expect(up.native?.status).toBe('uploaded');
    expect(up.native?.sid).toBe(CODEX_UUID);
    expect(up.native?.sid).not.toBe(CODEX_SID);
    expect(up.native?.folder).toContain(`${CODEX_UUID}.native`);

    const overview = lake.listLakeOverview();
    expect(overview.sessions.some(s => s.sid === CODEX_SID && s.recording === 'capture')).toBe(true);
    expect(overview.sessions.some(s => s.sid === CODEX_UUID && s.recording === 'native')).toBe(true);
  });

  it('④ 未找到：原生 not-found 不阻断捕获上传（独立上报原因）', async () => {
    await importSession(CAP_MISS, SID_MISS, prisma, CAP_MISS, 'claude-jsonl');
    const up = await lake.uploadLakeSessionWithNative(prisma, SID_MISS, {
      description: DESC, category: 'others', framework: 'claude-code-proxy', withNative: true, nativeRoots: emptyRoots(),
    });
    expect(up.sid).toBe(SID_MISS);
    expect(up.unchanged).toBe(false);
    expect(up.native?.status).toBe('not-found');
    expect(up.native?.reason).toContain('未找到');

    const overview = lake.listLakeOverview();
    expect(overview.sessions.some(s => s.sid === SID_MISS && s.recording === 'capture')).toBe(true);
    expect(overview.sessions.some(s => s.sid === SID_MISS && s.recording === 'native')).toBe(false);
  });

  it('⑤ 回归：不带 withNative 的上传无原生动作（DB 有原生行也不动）', async () => {
    await importSession(CAP_PLAIN, SID_PLAIN, prisma, CAP_PLAIN, 'claude-jsonl');
    const up = await lake.uploadLakeSessionWithNative(prisma, SID_PLAIN, {
      description: DESC, category: 'others', framework: 'claude-code-proxy', nativeRoots: diskRoots(),
    });
    expect(up.sid).toBe(SID_PLAIN);
    expect(up.native).toBeUndefined();

    const overview = lake.listLakeOverview();
    expect(overview.sessions.some(s => s.sid === SID_PLAIN)).toBe(true);
    expect(overview.sessions.some(s => s.sid === SID_PLAIN && s.recording === 'native')).toBe(false);
  });

  it('⑥ 框架字典序消歧：cannbot-proxy 捕获经 opencode-db 导入 opencode 原生行（同 sid 双行），按行 id 回读 framework 落 <sid>.native/', async () => {
    await importSession(CAP_CANNBOT, CANNBOT_SID, prisma, CAP_CANNBOT, 'claude-jsonl');
    const capRow = await prisma.session.findFirst({ where: { taskId: CANNBOT_SID, framework: 'cannbot-proxy' } });
    expect(capRow).not.toBeNull();

    const up = await lake.uploadLakeSessionWithNative(prisma, CANNBOT_SID, {
      description: DESC, category: 'others', framework: 'cannbot-proxy', withNative: true, nativeRoots: cannbotNativeRoots(),
    });
    expect(up.sid).toBe(CANNBOT_SID);
    expect(up.native?.status).toBe('uploaded');
    expect(up.native?.sid).toBe(CANNBOT_SID);
    // 若裸 taskId 回查取错行（cannbot-proxy < opencode 排前），会重复上传捕获目录，落盘缺 .native 后缀
    expect(up.native?.folder).toContain(`${CANNBOT_SID}.native`);

    const nativeRow = await prisma.session.findFirst({ where: { taskId: CANNBOT_SID, framework: 'opencode' } });
    expect(nativeRow).not.toBeNull();

    const overview = lake.listLakeOverview();
    const recordings = overview.sessions.filter(s => s.sid === CANNBOT_SID).map(s => s.recording).sort();
    expect(recordings).toEqual(['capture', 'native']);
  });
});
