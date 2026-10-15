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

// DSH 原生会话没有独立的导入入口，并入了「JSONL」这个通用 tab。所以当用户
// 在 JSONL tab 下把路径指向 DSH 原生会话时，服务端要自己把它认出来、改成
// dsh-native（和 sqlite-detect 的「SQLite 单一入口按内容分流」是同一思路），
// 否则会被当成 claude 的 .jsonl 文件解析。
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
