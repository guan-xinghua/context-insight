// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 捕获行读取 V8 上限 IT：parseJsonlLines 旧实现把整个捕获 gunzip 成单个 JS
// 字符串——plaintext 超 V8 上限（0x1FFFFFE8 ≈ 512MiB）必炸 RangeError，且
// 外层 catch { return [] } 把崩溃吞成「空文件」：导入链路走占位路径返回
// imported:true 假成功（现场：631MB wire 捕获 3.5 天会话，库中只剩 0 turns
// 空壳行）。新实现 Buffer 逐行切片解码，读取/解压/单行超限错误一律上抛；
// 单行 JSON 解析失败仍跳过（内容级容错，行为不变）。
// 超限重载用例（>512MiB 明文）由 RUN_HEAVY_CAPTURE_IT=1 显式开启，默认跳过。
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { parseJsonlLines, listSessions } from '@/lib/ingest/adapters/claude-jsonl'

const TMP = path.join(os.tmpdir(), `capture-read-it-${process.pid}`)
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function writeCapture(name: string, lines: string[], gzip = false): string {
  const plain = path.join(TMP, name.replace(/\.gz$/, ''))
  fs.writeFileSync(plain, lines.join('\n') + (lines.length > 0 ? '\n' : ''))
  if (!gzip) return plain
  const gz = `${plain}.gz`
  fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(plain)))
  fs.unlinkSync(plain)
  return gz
}

describe('parseJsonlLines — Buffer 逐行读取', () => {
  it('明文/gz/双形态互找：行内容逐字节一致（含 CJK 多字节与 CRLF）', () => {
    const lines = [
      '{"type":"user","message":{"role":"user","content":"中文多字节内容 — 测试"},"timestamp":"2026-09-20T12:00:00.000Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":"回复"}}',
    ]
    const plain = writeCapture('a.jsonl', lines)
    const gz = writeCapture('b.jsonl.gz', lines, true)

    const fromPlain = parseJsonlLines(plain)
    const fromGz = parseJsonlLines(gz)
    expect(fromGz).toEqual(fromPlain)
    expect(fromPlain.length).toBe(2)
    expect(fromPlain[0].message?.content).toBe('中文多字节内容 — 测试')

    fs.renameSync(gz, path.join(TMP, 'c.jsonl.gz'))
    const missingPlain = path.join(TMP, 'c.jsonl')
    expect(parseJsonlLines(missingPlain)).toEqual(fromPlain)
  })

  it('CRLF 行尾与无尾换行：trim 语义与旧 split 实现一致', () => {
    const p = path.join(TMP, 'crlf.jsonl')
    fs.writeFileSync(p, '{"type":"user","message":{"role":"user","content":"a"}}\r\n{"type":"user","message":{"role":"user","content":"b"}}')
    const r = parseJsonlLines(p)
    expect(r.length).toBe(2)
    expect(r[1].message?.content).toBe('b')
  })

  it('空文件 → []（占位路径语义保留）；// 注释与空行跳过；坏行跳过好行保留', () => {
    expect(parseJsonlLines(writeCapture('empty.jsonl', []))).toEqual([])
    const p = path.join(TMP, 'mixed.jsonl')
    fs.writeFileSync(p, [
      '// leading comment',
      '',
      '{"type":"user","message":{"role":"user","content":"good"}}',
      '{ not json',
      '   ',
      '{"type":"user","message":{"role":"user","content":"good2"}}',
    ].join('\n'))
    const r = parseJsonlLines(p)
    expect(r.length).toBe(2)
    expect(r.map(l => l.message?.content)).toEqual(['good', 'good2'])
  })

  it('损坏的 .gz → 上抛（不再吞成空文件假成功）', () => {
    const p = path.join(TMP, 'corrupt.jsonl.gz')
    fs.writeFileSync(p, Buffer.from('this is not gzip at all'))
    expect(() => parseJsonlLines(p)).toThrow()
  })

  it('文件不存在且无对偶形态 → 上抛 ENOENT', () => {
    expect(() => parseJsonlLines(path.join(TMP, 'no-such.jsonl'))).toThrow(/ENOENT/)
  })

  it('listSessions 目录含损坏件 → 逐件降级跳过，其余正常列出', () => {
    const dir = path.join(TMP, 'dir-list')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'good.jsonl'), '{"type":"user","message":{"role":"user","content":"q"},"timestamp":"2026-09-20T12:00:00.000Z"}\n')
    fs.writeFileSync(path.join(dir, 'bad.jsonl.gz'), Buffer.from('garbage'))
    const items = listSessions(dir)
    expect(items.length).toBe(1)
    expect(items[0].id).toBe('good')
  })
})

const HEAVY = !!process.env.RUN_HEAVY_CAPTURE_IT

describe.skipIf(!HEAVY)('parseJsonlLines — 超 V8 上限重载（RUN_HEAVY_CAPTURE_IT=1）', () => {
  it('整文件 >512MiB 明文（gz 后极小）：逐行解码不再爆 "Invalid string length"', () => {
    const pad = 'x'.repeat(180 * 1024 * 1024)
    const lines = [
      `{"type":"user","message":{"role":"user","content":"${pad}"}}`,
      `{"type":"assistant","message":{"role":"assistant","content":"${pad.slice(0, 1024)}"}}`,
      `{"type":"user","message":{"role":"user","content":"${pad}"}}`,
    ]
    const plain = path.join(TMP, 'heavy.jsonl')
    fs.writeFileSync(plain, lines.join('\n') + '\n')
    const gz = `${plain}.gz`
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(plain)))
    fs.unlinkSync(plain)
    // 旧实现在 gunzipSync(buf).toString('utf-8') 处必炸（540MB > 512MiB）
    const r = parseJsonlLines(gz)
    expect(r.length).toBe(3)
    expect(r[0].message?.content?.length).toBe(180 * 1024 * 1024)
  }, 120_000)

  it('单行 >512MiB（巨型 tool_result 形态）：RangeError 上抛可见，不吞成空', () => {
    // 夹具不能先在 JS 里拼出 >512MiB 字符串（自己就爆）——分块写盘
    const plain = path.join(TMP, 'heavy-line.jsonl')
    const fd = fs.openSync(plain, 'w')
    fs.writeSync(fd, '{"type":"user","message":{"role":"user","content":"')
    const chunk = Buffer.alloc(64 * 1024 * 1024, 0x79)
    for (let i = 0; i < 9; i++) fs.writeSync(fd, chunk)
    fs.writeSync(fd, '"}}\n')
    fs.closeSync(fd)
    expect(() => parseJsonlLines(plain)).toThrow(/string longer|Invalid string length|RangeError/)
  }, 120_000)
})
