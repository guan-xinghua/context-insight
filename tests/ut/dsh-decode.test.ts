// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeDshLog, decodeDshLogFile, DshLogError } from '@/lib/ingest/dsh-bridge/core';

const FIXTURE_DIR = path.resolve(__dirname, './data/dsh/multi-frame');
const MULTI_PATH = path.join(FIXTURE_DIR, 'session.v4.jsonl.zstd');
const SINGLE_PATH = path.join(FIXTURE_DIR, 'session.single-frame.jsonl.zstd');
const PLAIN_PATH = path.join(FIXTURE_DIR, 'session.v4.jsonl');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function frameOffsets(buf: Buffer): number[] {
  const offsets: number[] = [];
  let i = buf.indexOf(ZSTD_MAGIC);
  while (i !== -1) { offsets.push(i); i = buf.indexOf(ZSTD_MAGIC, i + ZSTD_MAGIC.length); }
  return offsets;
}

const HEADER = '{"type":"session","version":4,"id":"session-x","createdAt":1790000000000}';
const eventLine = (seq: number): string => `{"type":"user/message","seq":${seq},"time":${1790000000000 + seq},"data":{}}`;
const plain = (lines: string[]): Buffer => Buffer.from(lines.map(l => `${l}\n`).join(''), 'utf8');

// fixture：1 行会话头 + 6 个事件
const FIXTURE_EVENTS = 6;

describe('DSH 解码：多帧拼接 zstd（DSH 真实写入形态）', () => {
  it('fixture 本身必须是多帧，否则本组用例测不到"只解第一帧"的缺陷', () => {
    expect(frameOffsets(fs.readFileSync(MULTI_PATH)).length).toBeGreaterThan(1);
    expect(frameOffsets(fs.readFileSync(SINGLE_PATH)).length).toBe(1);
  });

  it('多帧文件解出全部帧，而不是只解第一帧', () => {
    const result = decodeDshLogFile(MULTI_PATH);
    expect(result.header.version).toBe(4);
    expect(result.header.id).toBe('session-00000000-0000-4000-8000-000000000001');
    expect(result.events).toHaveLength(FIXTURE_EVENTS);
    expect(result.warnings).toEqual([]);
  });

  it('多帧 / 单帧 / 明文三种形态结果一致', () => {
    const multi = decodeDshLogFile(MULTI_PATH);
    const single = decodeDshLogFile(SINGLE_PATH);
    const plaintext = decodeDshLogFile(PLAIN_PATH);
    expect(single.events).toEqual(multi.events);
    expect(plaintext.events).toEqual(multi.events);
    expect(single.header).toEqual(multi.header);
  });

  it('明文（非 zstd）直读', () => {
    expect(decodeDshLog(plain([HEADER, eventLine(0)])).events).toHaveLength(1);
  });
});

describe('DSH 解码：尾部截断（会话正在写入）', () => {
  it('末帧不完整 → 保留到最后一个完整帧，并留下 warning', () => {
    const buf = fs.readFileSync(MULTI_PATH);
    const offsets = frameOffsets(buf);
    const truncated = buf.subarray(0, offsets[offsets.length - 1] + 5);

    const result = decodeDshLog(truncated);
    expect(result.events).toEqual(decodeDshLog(buf).events.slice(0, FIXTURE_EVENTS - 1));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('保留到最后一个完整帧');
  });

  it('截断位置在末帧内部任意处都只丢那一帧（保留结果一致）', () => {
    const buf = fs.readFileSync(MULTI_PATH);
    const offsets = frameOffsets(buf);
    const last = offsets[offsets.length - 1];
    const baseline = decodeDshLog(buf).events.slice(0, FIXTURE_EVENTS - 1);
    for (const extra of [5, 20, 40, 60]) {
      const result = decodeDshLog(buf.subarray(0, last + extra));
      expect(result.events).toEqual(baseline);
    }
  });

  it('只剩第 1 个完整帧 → 只有会话头，无事件', () => {
    const buf = fs.readFileSync(MULTI_PATH);
    const result = decodeDshLog(buf.subarray(0, frameOffsets(buf)[1]));
    expect(result.events).toHaveLength(0);
    expect(result.header.id).toBeDefined();
    expect(result.warnings).toEqual([]);
  });

  it('没有任何完整帧 → 抛 DshLogError', () => {
    expect(() => decodeDshLog(Buffer.from(ZSTD_MAGIC))).toThrow(DshLogError);
    expect(() => decodeDshLog(Buffer.from(ZSTD_MAGIC))).toThrow(/截断/);
  });
});

describe('DSH 解码：坏输入不得静默成功', () => {
  it('zstd magic + 垃圾字节 → 抛 DshLogError', () => {
    const garbage = Buffer.concat([ZSTD_MAGIC, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])]);
    expect(() => decodeDshLog(garbage)).toThrow(DshLogError);
  });

  it('空输入 → 抛 DshLogError', () => {
    expect(() => decodeDshLog(Buffer.alloc(0))).toThrow(/缺少 session 头/);
  });

  it('首行不是 session 头 → 抛 DshLogError', () => {
    expect(() => decodeDshLog(plain([eventLine(0)]))).toThrow(/首行必须是 session/);
  });

  it('版本门禁：v3 拒绝并提示版本', () => {
    const v3 = HEADER.replace('"version":4', '"version":3');
    expect(() => decodeDshLog(plain([v3]))).toThrow(/不支持的 DSH 会话版本/);
  });
});

describe('DSH 解码：行级容错', () => {
  it('单行 JSON 非法 → 跳过并 warning（不影响其余行）', () => {
    const result = decodeDshLog(plain([HEADER, eventLine(0), '{ 坏行', eventLine(1)]));
    expect(result.events).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('跳过 1 条非法');
  });

  it('事件缺字段（无 seq）→ 计为非法行', () => {
    const result = decodeDshLog(plain([HEADER, '{"type":"user/message","time":1,"data":{}}']));
    expect(result.events).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it('非法行比例过高 → 抛 DshLogError（判定为损坏而非容错）', () => {
    expect(() => decodeDshLog(plain([HEADER, eventLine(0), '{ 坏行 1', '{ 坏行 2']))).toThrow(/非法行比例过高/);
  });
});
