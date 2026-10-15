// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import path from 'node:path';
import { isDshSessionLogName } from './dsh-bridge/native';
import { decodeDshLogFile, DshLogError } from './dsh-bridge/core';

// DSH 原生会话没有独立的导入入口，并入了「JSONL (auto)」这个通用伞形源。
// 本模块是 DSH 的路径/内容级识别单点：isDshSessionPath 供目录级判定，
// detectContent 是 SourceDescriptor 探测能力（registry.resolveSource 的
// 族内探测与纠偏依据）——文件名不是 DSH 固定代际名时明确不认领，
// 否则按解码器同一语义校验内容。
//
// 判定：路径本身是 DSH 会话日志文件；或者是个目录，里面（含子目录）有这种
// 文件。找到第一份就返回，不扫全树。
const MAX_DEPTH = 4;

function containsDshLog(dir: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && isDshSessionLogName(e.name)) return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && containsDshLog(path.join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

/** 这个路径是不是 DSH 原生会话（文件本身，或目录里含 session.v4.jsonl[.zstd]）。 */
export function isDshSessionPath(target: string): boolean {
  if (!target) return false;
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return false;
  }
  if (st.isFile()) return isDshSessionLogName(path.basename(target));
  if (st.isDirectory()) return containsDshLog(target, 0);
  return false;
}

/** 内容级识别（SourceDescriptor.detectContent 能力，registry.resolveSource
 * 的探测依据）：
 * - 目录 → 含 DSH 日志即认领（族内纠偏：调用方声明 claude-jsonl 但指向 DSH
 *   会话目录时纠到 dsh-native）
 * - 文件 → 文件名不是 DSH 固定代际名 = 明确不认领（false）；是则按解码器
 *   同一语义校验（首行 session 头 + v4），读得动但解不出 = false（让族内
 *   兄弟继续探测，误命名的 claude 件可被纠偏），IO 读不出 = null（无法判定，
 *   解析层信任声明值） */
export function detectContent(filePath: string): boolean | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (st.isDirectory()) return isDshSessionPath(filePath);
  if (!isDshSessionLogName(path.basename(filePath))) return false;
  try {
    decodeDshLogFile(filePath);
    return true;
  } catch (e) {
    return e instanceof DshLogError ? false : null;
  }
}
