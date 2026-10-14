// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function isPathInside(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(root, candidate);
  return t === r || t.startsWith(r + path.sep);
}

// 词法归一后再解析符号链接：path.resolve 折叠 `..` 但不解 symlink，白名单可被
// 根内指向根外的链接（如 pnpm 工程 node_modules/.pnpm → 全局 store）绕过；反向
// 也会误伤 macOS /tmp↔/private/tmp 这类互为别名的路径。realpath 对尚不存在的
// 路径抛错时，递归归一最近存在的祖先再拼回不存在尾段——保证两侧对称：根若带
// 符号链接前缀（macOS /var/folders → /private/var/folders），不存在的根内深层
// 路径仍能命中并放行；简单回退词法形式会与已 realpath 的根永不相等，误判 403
// 冒充 404（真实影响：白名单根含符号链接前缀时，不存在路径被拒 + x.jsonl↔
// .7z/.gz 别名形态击穿）。本判定先于存在性校验，回退不改变下游 404 语义。
function canonicalizePath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(canonicalizePath(parent), path.basename(resolved));
  }
}

// 可选导入路径白名单（默认不启用，本地自用任意位置可导入的功能不受影响）：
// 环境变量 CANNBOT_INSIGHT_IMPORT_ROOTS（逗号分隔，支持 ~）设置后，
// import-file / import-file/sessions / browse-directory 三个接收文件路径的路由
// 只放行白名单根内的路径（合规收紧叙事：安全报告 0000021/0000036 的纵深选项）。
// 数据主目录（~/.cannbot-insight，cpx 捕获落点）恒在允许范围——否则管理员只配
// 项目目录时，cpx 捕获退出的机会主义自动导入会静默 403。
export function importRootsFromEnv(): string[] | null {
  const raw = process.env.CANNBOT_INSIGHT_IMPORT_ROOTS;
  if (raw == null || raw.trim() === '') return null;
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(expandHome);
}

function importDataHome(): string {
  return path.resolve(expandHome(process.env.CANNBOT_INSIGHT_HOME ?? '~/.cannbot-insight'));
}

export type ImportPathDecision =
  | { ok: true }
  | { ok: false; roots: string[] };

export function checkImportablePath(candidate: string): ImportPathDecision {
  const roots = importRootsFromEnv();
  if (roots == null) return { ok: true };
  // 两侧（请求路径、恒放行的数据主目录、白名单根）都做 symlink 归一再比较，
  // 封死根内符号链接逃逸，同时消除别名路径（如 /tmp↔/private/tmp）的误伤。
  const target = canonicalizePath(expandHome(candidate));
  if (isPathInside(canonicalizePath(importDataHome()), target)) return { ok: true };
  for (const root of roots) {
    if (isPathInside(canonicalizePath(root), target)) return { ok: true };
  }
  return { ok: false, roots: roots.map(r => path.resolve(r)) };
}
