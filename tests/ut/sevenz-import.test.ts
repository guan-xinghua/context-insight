// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 7z at rest 导入 IT：cpx 新代际产物 .jsonl.7z 直接导入；sourcePath 指向明文
// 但盘上只有 .7z 的互找；存量 .jsonl.gz 永续可读。与 cpx 侧 writer-compression
// / lake-upload（⑧ gz→7z 迁移）共同覆盖双端三形态。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { compressCaptureFile } from '../../src/lib/compression.ts';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-7z-it-'));
const SID_7Z = 'cc-import-7z-0001';
const SID_PLAIN_REF = 'cc-import-7z-0002';
const SID_GZ = 'cc-import-gz-0001';

function fixtureLines(q: string): string {
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: q }] }, timestamp: '2026-09-05T05:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 8, output_tokens: 2 } }, timestamp: '2026-09-05T05:00:04.000Z' }),
  ].join('\n') + '\n';
}

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [SID_7Z, SID_PLAIN_REF, SID_GZ] } } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('7z at rest 导入（三形态读侧）', () => {
  it('① .jsonl.7z 直接导入：turns 落库、sourcePath 定型压缩态', async () => {
    const plain = path.join(TMP, `cpx-${SID_7Z}.jsonl`);
    fs.writeFileSync(plain, fixtureLines('seven-z import q'));
    const z = compressCaptureFile(plain);
    expect(z.endsWith('.jsonl.7z')).toBe(true);

    const res = await importSession(z, SID_7Z, prisma, z, 'claude-jsonl');
    expect(res.imported).toBe(true);
    const row = await prisma.session.findFirst({ where: { taskId: SID_7Z }, include: { turns: true } });
    expect(row).not.toBeNull();
    expect(row!.turns.length).toBe(2);
    expect(row!.sourcePath!.endsWith(`${SID_7Z}.jsonl.7z`)).toBe(true);
  });

  it('② sourcePath 指明文但盘上是 .7z（cpx 退出压缩形态）互找导入', async () => {
    const plain = path.join(TMP, `cpx-${SID_PLAIN_REF}.jsonl`);
    fs.writeFileSync(plain, fixtureLines('plain ref seven z'));
    const z = compressCaptureFile(plain);
    // sourcePath 用明文形态（cpx 传入的是退出前路径形态）
    const res = await importSession(z.replace(/\.7z$/, ''), SID_PLAIN_REF, prisma, z.replace(/\.7z$/, ''), 'claude-jsonl');
    expect(res.imported).toBe(true);
    const row = await prisma.session.findFirst({ where: { taskId: SID_PLAIN_REF } });
    expect(row).not.toBeNull();
  });

  it('③ 存量 .jsonl.gz 永续可读：照常导入', async () => {
    const gz = path.join(TMP, `cpx-${SID_GZ}.jsonl.gz`);
    fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(fixtureLines('legacy gz import q'))));
    const res = await importSession(gz, SID_GZ, prisma, gz, 'claude-jsonl');
    expect(res.imported).toBe(true);
    const row = await prisma.session.findFirst({ where: { taskId: SID_GZ }, include: { turns: true } });
    expect(row).not.toBeNull();
    expect(row!.turns.length).toBe(2);
  });
});
