// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import { decompress, Decompress, ZstdErrorCode } from 'fzstd';
import type { DecodeDshLogResult, DshEvent, DshSessionHeader } from './types';

// DSH 会话日志是【多帧拼接】的 zstd（每次 append 压一个新帧追加到尾部），
// 而不是单个 zstd 流：实测样本 2.2MB 内含 1257 帧。
// fzstd.decompress() 原生跨帧续解，所以正常路径无需手动切帧；
// 只有"会话正在写入 / 文件被截断"导致末尾帧不完整时，才改走流式解压保留完整帧。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 非法行比例上限：超过即判定为损坏文件（而非内容级容错）。 */
const INVALID_LINE_RATIO_LIMIT = 0.01;

export class DshLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshLogError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

/** 压缩形态判定：前 4 字节为 zstd magic（每帧开头都带）即视为压缩件，否则按明文 .jsonl 处理。
 *  仅前缀嗅探、不校验完整性——损坏由后续解压抛错兜住；不足 4 字节必然返回 false。
 *  magic 里的 0xB5 / 0xFD 不是合法 UTF-8 起始字节，故合法文本不会被误判成压缩件。 */
function isZstd(buffer: Buffer): boolean {
  return buffer.length >= ZSTD_MAGIC.length && buffer.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC);
}

/** 解压（多帧透明）。fzstd 跨帧续解，正常路径一次调用即可。 */
function inflate(buffer: Buffer, warnings: string[]): Buffer {
  try {
    return Buffer.from(decompress(buffer));
  } catch (error) {
    // 只有 UnexpectedEOF 才是"会话正在写"（末尾帧不完整）；其余一律是损坏，fail-closed。
    if (errorCode(error) !== ZstdErrorCode.UnexpectedEOF) {
      throw new DshLogError(`DSH 日志解压失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const salvaged = recoverCompleteFrames(buffer);
    if (salvaged === null) {
      throw new DshLogError('DSH 日志尾部截断且无法恢复：连第 1 个完整帧都没有');
    }
    warnings.push('DSH 日志尾部不完整：已保留到最后一个完整帧（会话可能正在写入）');
    return salvaged;
  }
}

/** 丢弃不完整的末尾帧：改走流式解压，它在抛出 UnexpectedEOF 之前已把
 *  完整的那些帧全部吐出来，因此无需自己扫描帧边界。
 *  实测：2,272,186 字节 / 1257 帧的真实文件砍掉末帧，这里精确保留 7,702,534
 *  字节（= 完整内容减去末帧的 70 字节）。 */
function recoverCompleteFrames(buffer: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  const stream = new Decompress(chunk => { parts.push(Buffer.from(chunk)); });
  try {
    stream.push(buffer, true);
    return Buffer.concat(parts);
  } catch {
    return parts.length > 0 ? Buffer.concat(parts) : null;
  }
}

// 按 0x0a 逐行切片（0x0a 不会出现在 UTF-8 多字节序列内，切片安全），
// 保持物理行号以便错误信息定位；不整文件转成一个字符串。
function splitLines(buffer: Buffer): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i <= buffer.length; i++) {
    if (i < buffer.length && buffer[i] !== 0x0a) continue;
    let end = i;
    if (end > start && buffer[end - 1] === 0x0d) end--;
    lines.push(buffer.toString('utf-8', start, end));
    start = i + 1;
  }
  return lines;
}

function parseHeader(value: unknown): DshSessionHeader {
  if (!isRecord(value)) throw new DshLogError('DSH 日志首行不是 JSON 对象');
  if (value.type !== 'session') throw new DshLogError('DSH 日志首行必须是 session');
  if (value.version !== 4) {
    throw new DshLogError(`不支持的 DSH 会话版本：${String(value.version)}（仅支持 v4，请升级本工具）`);
  }
  if (typeof value.id !== 'string' || value.id.length === 0) throw new DshLogError('DSH 会话头缺少 id');
  if (typeof value.createdAt !== 'number') throw new DshLogError('DSH 会话头缺少 createdAt');
  return value as unknown as DshSessionHeader;
}

function parseEvent(value: unknown, lineNumber: number): DshEvent {
  if (!isRecord(value)) throw new DshLogError(`第 ${lineNumber} 行不是 JSON 对象`);
  if (typeof value.type !== 'string') throw new DshLogError(`第 ${lineNumber} 行缺少 type`);
  if (typeof value.seq !== 'number') throw new DshLogError(`第 ${lineNumber} 行缺少 seq`);
  if (typeof value.time !== 'number') throw new DshLogError(`第 ${lineNumber} 行缺少 time`);
  if (!('data' in value)) throw new DshLogError(`第 ${lineNumber} 行缺少 data`);
  return value as unknown as DshEvent;
}

/** DSH 会话日志 → 会话头 + 事件流。入参为文件字节，本函数不做任何文件 IO。 */
export function decodeDshLog(buffer: Buffer): DecodeDshLogResult {
  const warnings: string[] = [];
  const body = isZstd(buffer) ? inflate(buffer, warnings) : buffer;
  const lines = splitLines(body);

  let header: DshSessionHeader | null = null;
  const events: DshEvent[] = [];
  let parsedLines = 0;
  let invalidLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    parsedLines++;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      invalidLines++;
      continue;
    }
    if (header === null) {
      header = parseHeader(value);
      continue;
    }
    try {
      events.push(parseEvent(value, i + 1));
    } catch {
      invalidLines++;
    }
  }

  if (header === null) throw new DshLogError('DSH 日志为空或缺少 session 头');
  if (invalidLines > 1 && parsedLines > 0 && invalidLines / parsedLines > INVALID_LINE_RATIO_LIMIT) {
    throw new DshLogError(`DSH 日志非法行比例过高：${invalidLines}/${parsedLines}`);
  }
  if (invalidLines > 0) warnings.push(`跳过 ${invalidLines} 条非法 DSH 日志行`);

  return { header, events, warnings };
}

/** 文件形态入口（本模块唯一的文件 IO）：读盘 + decodeDshLog。 */
export function decodeDshLogFile(filePath: string): DecodeDshLogResult {
  return decodeDshLog(fs.readFileSync(filePath));
}
