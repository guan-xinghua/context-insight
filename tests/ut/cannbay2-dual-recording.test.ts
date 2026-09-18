// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 同 sid 双记录·cannbay 侧 IT：同一 sid 的 wire 捕获与原生 claude 会话两份记录
// 在仓内并存（捕获=裸 <sid>/，原生=<sid>.native/，目录内文件用真实 sid）：
//   ① 双行上传 → 仓内两个目录并存（不互踩）
//   ② listOverview → 两条目（同 sid、recording 字段区分）
//   ③ 分别导入（带 recording）→ insight 侧两行（claude-code-proxy / claude-code）
//   ④ 同记录类重传 → 只替换自己目录，另一记录类原封不动
//   ⑥ 存量迁移：旧世界非 proxy 上传的裸 <sid>/（insight 导出件）在原生行
//      重传时自动迁移（裸目录清除、.native/ 落位）；cpx 捕获裸目录不动
// env 必须在 cannbay2 模块加载前设置（mirror.ts 在模块顶层读取 env）。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { importSession } from '../../src/lib/ingest/data-service.ts';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay2-dual-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');
const FIXTURES = path.join(TMP, 'fixtures');
const PARADIGM = 'dual-it';

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# dual recording it\n');
fs.mkdirSync(path.join(SEED, PARADIGM), { recursive: true });
fs.writeFileSync(path.join(SEED, PARADIGM, '.gitkeep'), '');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

process.env.CANNBAY2_REMOTE_URL = BARE;
process.env.CANNBAY2_PUSH_URL = BARE;
process.env.CANNBAY2_CACHE_DIR = CACHE;

const prisma = new PrismaClient();

const mirror = await import('../../src/lib/cannbay2/mirror');
const route = await import('../../src/app/api/ingest/cannbay2/route');

const SID = 'cc-dual-rec-it-0001';

// wire 捕获形态：行级 source 标记 + x_cannbay wire 证据（分类器规则 2）
function writeCaptureFixture(): string {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const f = path.join(FIXTURES, `${SID}.jsonl`);
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'wire-q1' }, source: 'claude-proxy', x_cannbay: { schema: 'it-wire-evidence', version: 1, data: {} } }),
    JSON.stringify({ type: 'assistant', message: { id: 'm_cap', role: 'assistant', content: [{ type: 'text', text: 'wire-a1' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-09-17T03:00:05.000Z', source: 'claude-proxy', x_cannbay: { schema: 'it-wire-evidence', version: 1, data: {} } }),
  ].join('\n') + '\n');
  return f;
}

// 原生 claude 会话形态：无 source/x_cannbay
function writeNativeFixture(sid = SID): string {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const f = path.join(FIXTURES, `${sid}.native-src.jsonl`);
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'native-q1' }, timestamp: '2026-09-17T03:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: 'm_nat', role: 'assistant', content: [{ type: 'text', text: 'native-a1' }], model: 'test-model', usage: { input_tokens: 8, output_tokens: 3 } }, timestamp: '2026-09-17T03:00:04.000Z' }),
  ].join('\n') + '\n');
  return f;
}

// 旧世界裸目录播种：直接在 SEED 克隆里以裸 <sid>/ 位置推送（复刻本 PR 之前的
// 上传形态），meta 按归属参数化——
//   insight-export/insight-upload（无 proxy 信号）= 存量原生；
//   cpx = 捕获；
//   insight-upload + ccVersion 带 marker = 早期捕获行形态（framework 无
//   -proxy 后缀 + version 带 marker——合成/DB 导出 meta 原样抄行值，ccVersion
//   是该形态下唯一的 proxy 信号）
function seedLegacyBareDir(sid: string, meta: { producer: 'insight-export' | 'insight-upload' | 'cpx'; ccVersion?: string }): void {
  const dir = path.join(SEED, PARADIGM, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `legacy-${sid}` }, timestamp: '2026-09-16T03:00:00.000Z' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, `${sid}.meta.json`), JSON.stringify({
    x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: meta.producer, framework: 'claude-code', ccVersion: meta.ccVersion, sid } },
  }));
  // mirror 侧上传（①-④）推进过远端，SEED 先 rebase 再推
  git('git pull --rebase -q origin main', SEED);
  git('git add .', SEED);
  git(`git -c user.name=legacy -c user.email=legacy@t commit -q -m "legacy ${sid}"`, SEED);
  git('git push -q origin main', SEED);
}

function bareTree(spec: string): string {
  return git(`git ls-tree -r --name-only main -- ${spec}`, BARE);
}

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/ingest/cannbay2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function uploadRow(framework: string) {
  const res = await route.POST(makeRequest({
    action: 'upload', taskId: SID, framework,
    description: '提交人: 测试者\n内容描述: 双记录 IT',
    category: PARADIGM,
  }));
  const data = await res.json();
  if (!res.ok) throw new Error(`upload failed: ${JSON.stringify(data)}`);
  return data as { folder: string; unchanged: boolean };
}

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('同 sid 双记录·cannbay 侧（sid × 记录类 全仓唯一）', () => {
  it('前置：insight 双行（捕获 + 原生）导入', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID } });
    const cap = writeCaptureFixture();
    await importSession(cap, SID, prisma, cap, 'claude-jsonl');
    const nat = writeNativeFixture();
    await importSession(nat, SID, prisma, nat, 'claude-jsonl');
    const rows = await prisma.session.findMany({ where: { taskId: SID } });
    expect(rows.map(r => r.framework).sort()).toEqual(['claude-code', 'claude-code-proxy']);
  });

  it('① 双行上传 → 仓内 <sid>/ 与 <sid>.native/ 并存（不互踩）', async () => {
    const capUp = await uploadRow('claude-code-proxy');
    expect(capUp.folder).toBe(`${PARADIGM}/${SID}/`);
    const natUp = await uploadRow('claude-code');
    expect(natUp.folder).toBe(`${PARADIGM}/${SID}.native/`);

    const tree = bareTree(`${PARADIGM}/`);
    expect(tree).toContain(`${PARADIGM}/${SID}/${SID}.jsonl`);
    expect(tree).toContain(`${PARADIGM}/${SID}.native/${SID}.jsonl`);
    expect(tree).toContain(`${PARADIGM}/${SID}/${SID}.meta.json`);
    expect(tree).toContain(`${PARADIGM}/${SID}.native/${SID}.meta.json`);
  });

  it('② listOverview → 两条目：同 sid、recording 区分、meta 各读各的', () => {
    const { sessions } = mirror.listOverview();
    const mine = sessions.filter(s => s.sid === SID);
    expect(mine.length).toBe(2);
    const cap = mine.find(s => s.recording === 'capture')!;
    const nat = mine.find(s => s.recording === 'native')!;
    expect(cap).toBeTruthy();
    expect(nat).toBeTruthy();
    // 目录内 meta 各读各的：捕获目录伴生/合成 meta 的 producer=cpx 或框架带 -proxy
    expect(cap.framework === 'claude-code' || cap.producer === 'cpx' || cap.producer === 'insight-upload').toBe(true);
    expect(nat.framework).toBe('claude-code');
  });

  it('③ 分别导入（带 recording）→ insight 两行各自落位 + 物化路径互不覆盖', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID } });
    const capRes = await route.POST(makeRequest({ action: 'import', sid: SID, recording: 'capture' }));
    expect(capRes.status).toBe(200);
    const natRes = await route.POST(makeRequest({ action: 'import', sid: SID, recording: 'native' }));
    expect(natRes.status).toBe(200);
    const rows = await prisma.session.findMany({ where: { taskId: SID } });
    expect(rows.map(r => r.framework).sort()).toEqual(['claude-code', 'claude-code-proxy']);
    // 内容各归各位：捕获行首问 wire-q1，原生行首问 native-q1
    const byFw = new Map(rows.map(r => [r.framework, r]));
    expect(byFw.get('claude-code-proxy')!.query).toContain('wire-q1');
    expect(byFw.get('claude-code')!.query).toContain('native-q1');
    // 物化路径按记录类分离（sid 平铺会让第二份物化覆盖第一份——e2e 现场）：
    // 捕获 = materialized/<sid>.jsonl，原生 = materialized/<sid>.native.jsonl，
    // 且各自文件内容归属正确（读盘验证，防 refresh 读到别人的源）
    const capSrc = byFw.get('claude-code-proxy')!.sourcePath!;
    const natSrc = byFw.get('claude-code')!.sourcePath!;
    expect(capSrc).not.toBe(natSrc);
    expect(capSrc.endsWith(`${SID}.jsonl`) || capSrc.endsWith(`${SID}.jsonl.gz`)).toBe(true);
    expect(natSrc.endsWith(`${SID}.native.jsonl`) || natSrc.endsWith(`${SID}.native.jsonl.gz`)).toBe(true);
    const readText = (p: string): string => p.endsWith('.gz')
      ? zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')
      : fs.readFileSync(p, 'utf8');
    expect(readText(capSrc)).toContain('wire-q1');
    expect(readText(natSrc)).toContain('native-q1');
  });

  it('④ 同记录类重传只替换自己目录，另一记录类原封不动', async () => {
    const natUp = await uploadRow('claude-code');
    expect(natUp.unchanged).toBe(true); // 同内容重传幂等
    const treeBefore = bareTree(`${PARADIGM}/${SID}/`);
    // 原生重传后，捕获目录不变
    await uploadRow('claude-code');
    expect(bareTree(`${PARADIGM}/${SID}/`)).toBe(treeBefore);
    expect(bareTree(`${PARADIGM}/${SID}.native/`)).toContain(`${SID}.jsonl`);
  });

  it('⑤ 目录名推导/还原纯单元', () => {
    expect(mirror.sessionFolderOf('abc', 'capture')).toBe('abc');
    expect(mirror.sessionFolderOf('abc', 'native')).toBe('abc.native');
    expect(mirror.parseSessionFolder('abc')).toEqual({ sid: 'abc', recording: 'capture' });
    expect(mirror.parseSessionFolder('abc.native')).toEqual({ sid: 'abc', recording: 'native' });
  });

  it('⑦ 注入面：恶意顶层目录名（shell 元字符/换行）不进入定位与 shell 命令', async () => {
    // ls-tree 原始输出的 root（范式目录名）不受 validateCategory 约束——
    // 旧仓/手工推送可出现含 ;$` 与换行的目录名。root 段级白名单丢弃非法
    // loc（保守不动），含 \n 的文件路径不再能按行伪造定位行
    const EVIL_ROOT = 'evil;rm -rf /$(`touch pwn`)root';
    const SID_X = 'cc-dual-evil-0005';
    const dir = path.join(SEED, EVIL_ROOT, SID_X);
    fs.mkdirSync(dir, { recursive: true });
    // 恶意 root + 恶意文件名（含换行，模拟 `evil-root/<sid>/` 形态的伪造行）
    fs.writeFileSync(path.join(dir, `${SID_X}.jsonl`), 'x\n');
    fs.writeFileSync(path.join(dir, `${SID_X}.meta.json`), JSON.stringify({
      x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'insight-export', framework: 'claude-code', sid: SID_X } },
    }));
    git('git pull --rebase -q origin main', SEED);
    git('git add .', SEED);
    git(`git -c user.name=evil -c user.email=evil@t commit -q -m "evil root"`, SEED);
    git('git push -q origin main', SEED);

    // 原生行上传（会走 staleLocs/bareDirHoldsNativeRecording 的 meta 读取）
    // 不执行注入（哨兵文件不出现）、不抛异常——非法 root 的 loc 被过滤
    const nat = writeNativeFixture(SID_X);
    await importSession(nat, SID_X, prisma, nat, 'claude-jsonl');
    const res = await route.POST(makeRequest({
      action: 'upload', taskId: SID_X, framework: 'claude-code',
      description: '提交人: 测试者\n内容描述: 注入面 IT',
      category: PARADIGM,
    }));
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(CACHE, 'pwn'))).toBe(false);
    // 物化（import 路径）同样不触发注入
    const mat = mirror.materializeSession(SID_X, undefined, 'native');
    expect(mat).toBeTruthy();
  });

  it('⑥ 存量迁移：insight 导出件裸目录在原生重传时清除；捕获形态裸目录（cpx / 早期捕获行）不动', async () => {
    // 旧世界形态：非 proxy 上传落裸 <sid>/（彼时只有裸位）。
    // A. insight 导出件（producer=insight-export 且无任何 proxy 信号）= 存量
    //    原生 → 原生行重传时自动迁移（裸目录清除、.native/ 落位，同 commit
    //    完成）；不迁移则 list 同 sid 双条目、旧原生内容错标 capture 且永远
    //    无法被重传替换（staleLocs 按记录类定位看不到裸目录）
    // B. cpx 捕获（producer=cpx）= 位置正确 → 原生重传绝不触碰
    // C. 早期捕获行（framework 无 -proxy 后缀 + ccVersion 带 marker——合成
    //    /DB 导出 meta 原样抄行值，producer=insight-upload）= 捕获 → 不动。
    //    判定若只看 producer/framework 漏 ccVersion 信号，会把它误判为存量
    //    原生进 staleLocs 删除——wire 捕获记录被毁（数据丢失）
    const SID_L = 'cc-dual-legacy-0002';
    const SID_C = 'cc-dual-legacy-0003';
    const SID_E = 'cc-dual-legacy-0004';
    try {
      seedLegacyBareDir(SID_L, { producer: 'insight-export' });
      seedLegacyBareDir(SID_C, { producer: 'cpx' });
      seedLegacyBareDir(SID_E, { producer: 'insight-upload', ccVersion: '1.2.3-claude-proxy' });
      expect(bareTree(`${PARADIGM}/${SID_L}/`)).toContain(`${SID_L}.jsonl`);
      expect(bareTree(`${PARADIGM}/${SID_C}/`)).toContain(`${SID_C}.jsonl`);
      expect(bareTree(`${PARADIGM}/${SID_E}/`)).toContain(`${SID_E}.jsonl`);

      // 各自的原生行入库并上传（framework=claude-code → 落 .native/）
      for (const s of [SID_L, SID_C, SID_E]) {
        const nat = writeNativeFixture(s);
        await importSession(nat, s, prisma, nat, 'claude-jsonl');
        const res = await route.POST(makeRequest({
          action: 'upload', taskId: s, framework: 'claude-code',
          description: '提交人: 测试者\n内容描述: 存量迁移 IT',
          category: PARADIGM,
        }));
        expect(res.status).toBe(200);
      }

      // A：insight 导出件裸目录已迁移（清除），.native/ 落位
      expect(bareTree(`${PARADIGM}/${SID_L}/`)).not.toContain(`${SID_L}.jsonl`);
      expect(bareTree(`${PARADIGM}/${SID_L}.native/`)).toContain(`${SID_L}.jsonl`);
      // B：cpx 捕获裸目录原封不动，.native/ 并存
      expect(bareTree(`${PARADIGM}/${SID_C}/`)).toContain(`${SID_C}.jsonl`);
      expect(bareTree(`${PARADIGM}/${SID_C}.native/`)).toContain(`${SID_C}.jsonl`);
      // C：早期捕获行裸目录（ccVersion 带 marker）原封不动，.native/ 并存
      expect(bareTree(`${PARADIGM}/${SID_E}/`)).toContain(`${SID_E}.jsonl`);
      expect(bareTree(`${PARADIGM}/${SID_E}.native/`)).toContain(`${SID_E}.jsonl`);
    } finally {
      await prisma.session.deleteMany({ where: { taskId: { in: [SID_L, SID_C, SID_E] } } }).catch(() => {});
    }
  });
});
