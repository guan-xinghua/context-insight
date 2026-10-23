// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 任务结果标注（opGen）round-trip IT：上传时勾选"任务成功/失败" →
// 写入 staging 的 cc-session-meta（可选字段，spec §4.4 不升版本）随仓上传 →
// lake 列表「任务结果」列读回（success/failure/null=未标注）。
// 本地 bare 仓（partial clone 全链路）+ 真实 prisma 会话 + 走 lake 路由
// （action: upload / list），覆盖：标注成功、标注失败、不标注（缺省 null）、
// 非法值按未标注处理（route 网关拦截）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { seedLakeConfig, switchLakeConfig } from '../helpers/lake-env';

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-opgen-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const FIXTURES = path.join(TMP, 'fixtures');

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# opgen IT\n');
// 范式目录（默认仓上传必选其一）
fs.mkdirSync(path.join(SEED, 'others'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'others', '.gitkeep'), '');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

seedLakeConfig(TMP, { address: BARE });
process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = path.join(TMP, 'cache');

// 标注会话 A（成功）/ B（失败）的 fixture：wire 捕获形态 jsonl（直传源文件，
// 落裸 <sid>/ 主位——同 sid 双记录 IT 后原生 claude 行会上传到 <sid>.native/）
const SID_OK = 'opgen-it-ok-0001';
const SID_FAIL = 'opgen-it-fail-0002';
fs.mkdirSync(FIXTURES, { recursive: true });
for (const [sid, firstLine] of [[SID_OK, '生成成功场景'], [SID_FAIL, '生成失败场景']] as const) {
  fs.writeFileSync(path.join(FIXTURES, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: firstLine }, timestamp: '2026-09-02T03:00:00.000Z', source: 'claude-proxy', x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } }),
    JSON.stringify({ type: 'assistant', message: { id: `msg_${sid}`, role: 'assistant', content: [{ type: 'text', text: '完成' }], model: 'test-model', usage: { input_tokens: 100, output_tokens: 20 } }, timestamp: '2026-09-02T03:00:05.000Z' }),
  ].join('\n') + '\n');
}

const prisma = new PrismaClient();
const lake = await import('../../src/lib/lake');
const mirror = await import('../../src/lib/lake/mirror');
const route = await import('../../src/app/api/ingest/lake/route');

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/ingest/lake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function uploadViaRoute(taskId: string, opGen?: string) {
  const res = await route.POST(makeRequest({
    action: 'upload',
    taskId,
    description: `提交人: 测试者\n内容描述: opgen IT`,
    category: 'others',
    ...(opGen != null ? { opGen } : {}),
  }));
  return { ok: res.ok, data: await res.json() };
}

async function listViaRoute() {
  const res = await route.POST(makeRequest({ action: 'list' }));
  const data = await res.json();
  return (data.sessions ?? []) as Array<{ sid: string; opGen: 'success' | 'failure' | null }>;
}

beforeAll(async () => {
  for (const sid of [SID_OK, SID_FAIL]) {
    await prisma.session.deleteMany({ where: { taskId: sid } });
    await prisma.session.create({ data: { taskId: sid, framework: 'claude-code-proxy', version: 'claude-proxy', sourcePath: path.join(FIXTURES, `${sid}.jsonl`) } });
  }
});

afterAll(async () => {
  for (const sid of [SID_OK, SID_FAIL]) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('lake 任务结果标注（opGen）round-trip', () => {
  it('上传勾选 成功/失败 → 仓内 meta 携带 opGen → 列表读回对应标注', async () => {
    const up1 = await uploadViaRoute(SID_OK, 'success');
    expect(up1.ok, JSON.stringify(up1.data)).toBe(true);
    const up2 = await uploadViaRoute(SID_FAIL, 'failure');
    expect(up2.ok, JSON.stringify(up2.data)).toBe(true);

    // 仓内 meta 事实源：x_lake.data.opGen（明文 meta，直接从镜像 cat）——
    // 镜像在按远端哈希的缓存子目录（lakeCacheDir 取解析后的真实路径）
    const cache = mirror.lakeCacheDir();
    for (const [sid, want] of [[SID_OK, 'success'], [SID_FAIL, 'failure']] as const) {
      const metaRaw = execSync(`git cat-file -p HEAD:others/${sid}/${sid}.meta.json`, { cwd: cache, encoding: 'utf-8' });
      const meta = JSON.parse(metaRaw);
      expect((meta.x_lake).schema).toBe('cc-session-meta');
      expect((meta.x_lake).version).toBe(1);
      expect((meta.x_lake).data.opGen).toBe(want);
    }

    // 列表读回（route → listSessions → readSessionMetas）
    const sessions = await listViaRoute();
    expect(sessions.find(s => s.sid === SID_OK)?.opGen).toBe('success');
    expect(sessions.find(s => s.sid === SID_FAIL)?.opGen).toBe('failure');
  });

  it('不标注（缺省）→ 列表 opGen 为 null；非法值被 route 网关拦为未标注', async () => {
    // 缺省：不传 opGen
    const SID3 = 'opgen-it-plain-0003';
    await prisma.session.deleteMany({ where: { taskId: SID3 } });
    fs.writeFileSync(path.join(FIXTURES, `${SID3}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: '未标注场景' }, timestamp: '2026-09-02T04:00:00.000Z', source: 'claude-proxy', x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } }) + '\n');
    await prisma.session.create({ data: { taskId: SID3, framework: 'claude-code-proxy', version: 'claude-proxy', sourcePath: path.join(FIXTURES, `${SID3}.jsonl`) } });
    try {
      const up = await uploadViaRoute(SID3);
      expect(up.ok, JSON.stringify(up.data)).toBe(true);
      let sessions = await listViaRoute();
      expect(sessions.find(s => s.sid === SID3)?.opGen ?? null).toBeNull();

      // 非法值：route 只认 success/failure，其余按未标注（不写入 meta）
      const up2 = await uploadViaRoute(SID3, 'yes');
      expect(up2.ok, JSON.stringify(up2.data)).toBe(true);
      sessions = await listViaRoute();
      expect(sessions.find(s => s.sid === SID3)?.opGen ?? null).toBeNull();
      const metaRaw = execSync(`git cat-file -p HEAD:others/${SID3}/${SID3}.meta.json`, { cwd: mirror.lakeCacheDir(), encoding: 'utf-8' });
      expect(JSON.parse(metaRaw).x_lake.data.opGen).toBeUndefined();
    } finally {
      try { await prisma.session.deleteMany({ where: { taskId: SID3 } }); } catch { /* ignore */ }
    }
  });
});
