// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据湖远端解析（vendor 自 insight cannbay2/remote.ts 的只读子集，决策
// §10-2 先冗余后收敛）：env > 硬编码默认。镜像目录默认与 insight cannbay2
// 共用（见 defaultCacheDir），env 口径一致。唯一写路径 = 实验记录追加
// （notes）；push 凭据不再内置（共享令牌已出源）——统一走 cannbay2/auth
// 解析链（env 完整 URL > env 分离对 > cannbay-auth.json 已存凭据，与
// insight/cpx 同一份存储）。分支/目录会拼进 shell git 命令，白名单校验与
// insight 同款；错误消息出边界前必须 redact（execSync 失败携带完整命令行）。
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseUrlCreds, resolvePushAuth } from '@/lib/cannbay2/auth';

export { parseUrlCreds } from '@/lib/cannbay2/auth';

export const CANNBAY2_PULL_URL = process.env.CANNBAY2_REMOTE_URL
  ?? 'https://example.com/cannbay-lake.git';
export const CANNBAY2_BRANCH = process.env.CANNBAY2_BRANCH ?? 'main';

export interface LakeRemote {
  pullUrl: string;
  /** 无凭据 push 地址：凭据走 credential helper（pushAuth），绝不内嵌 URL */
  pushUrl: string;
  /** push 凭据（env URL / env 分离对 / 已存凭据解析而来）；null = 匿名推 */
  pushAuth: PushAuth | null;
  /**
   * Pull credentials for private remotes: applied to clone/fetch via a
   * one-shot credential helper (same 401-challenge channel as push). Null =
   * pull anonymously.
   */
  pullAuth: PushAuth | null;
  branch: string;
  cacheDir: string;
}

const FORBIDDEN_ADDRESS_CHARS = /["'`$;&|\n\r]/;

export function stripUrlCreds(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
}

export function normalizeGitAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) throw new Error('无效的数据湖地址');
  if (FORBIDDEN_ADDRESS_CHARS.test(trimmed)) throw new Error('数据湖地址含非法字符');
  if (/^https?:\/\//i.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      throw new Error(`无效的数据湖地址: "${trimmed.slice(0, 80)}"`);
    }
    // 别名 host 不服务 git http（与 cannbay2 同款改写）：不改写则 clone 失败；
    // 共用镜像场景下还会因 origin 不匹配被判"镜像不可用"触发破坏性重克隆
    if (u.host === 'ai.gitcode.com') u.host = 'gitcode.com';
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/+$/, '');
  }
  return trimmed.replace(/\/+$/, '');
}

export function validateBranch(branch: string): string {
  const b = branch.trim();
  if (!/^[\w.-]+$/.test(b)) throw new Error(`无效分支名: "${branch.slice(0, 40)}"`);
  return b;
}

// 白名单段含 `.`（正则元字符）：拼 ls-tree/log 正则前必须转义
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultCacheDir(): string {
  // path.resolve 归一为绝对路径（相对 env 值按进程 cwd 单次解析，与 git 目标
  // 参数一致）。默认与 insight cannbay2 共用同一镜像目录——viewer 并入单进程
  // 后「两进程并发 fetch 同一 cacheDir」的隔离理由不再成立，且两侧初始化锁
  // 同名同语义（<dir>.lock + wx + 15min 击穿）、克隆均持锁走 tmp+rename，
  // 冷启动互斥成立；session 大文件因此只落一处（cannbay2 按需物化）。
  // CANNBAY_VIEWER_CACHE_DIR 仍可强制独立镜像（测试隔离用）。
  return path.resolve(
    process.env.CANNBAY_VIEWER_CACHE_DIR
      ?? process.env.CANNBAY2_CACHE_DIR
      ?? path.join(process.cwd(), 'tmp', 'cannbay2-cache'),
  );
}

// push 地址校验（允许带凭据形态进解析，但不能直接当 URL 用——见 pushMirror 注释）
function normalizePushUrl(address: string): string {
  const trimmed = address.trim();
  if (FORBIDDEN_ADDRESS_CHARS.test(trimmed)) throw new Error('数据湖 push 地址含非法字符');
  return trimmed.replace(/\/+$/, '');
}

/** push 凭据（env 完整 URL 内嵌凭据 / env 分离对 / cannbay-auth.json）；
 *  null = 匿名推（本地 bare 等） */
export interface PushAuth { username: string; password: string }

export function resolveLakeRemote(): LakeRemote {
  const pullUrl = normalizeGitAddress(CANNBAY2_PULL_URL);
  // push 目标：env CANNBAY2_PUSH_URL 覆写（credless 部分）> pull 地址；
  // 凭据经 cannbay2/auth 解析链（测试用 env 覆写本地 bare 同一条路）
  const pushOverride = process.env.CANNBAY2_PUSH_URL?.trim();
  const { credless, auth } = pushOverride
    ? parseUrlCreds(normalizePushUrl(pushOverride))
    : { credless: pullUrl, auth: resolvePushAuth(pullUrl) };
  const branch = validateBranch(CANNBAY2_BRANCH);
  // 镜像目录按远端 URL+分支哈希（与 insight cannbay2 同公式 → 默认仓共用
  // 同一镜像，大文件只落一处）：历史不哈希直用缓存根，默认仓迁址后旧镜像
  // origin 仍指旧仓、fetch 照样成功——列表会静默读错误仓库（2026-09-22
  // 迁址实测），且与 insight 修复后的哈希目录分叉
  const cacheDir = path.join(
    defaultCacheDir(),
    createHash('sha1').update(`${pullUrl}|${branch}`).digest('hex').slice(0, 12),
  );
  return {
    pullUrl,
    pushUrl: credless,
    pushAuth: auth,
    pullAuth: pushOverride ? resolvePushAuth(pullUrl) : auth,
    branch,
    cacheDir,
  };
}

// execSync 失败的 err.message/stderr 含完整命令行（带凭据 URL）——出路由
// 边界前必须过这里
export function redactLakeSecrets(message: string, remote: LakeRemote): string {
  return message
    .split(remote.pullUrl).join(stripUrlCreds(remote.pullUrl))
    .split(remote.pushUrl).join(stripUrlCreds(remote.pushUrl))
    .replace(/https:\/\/[^/\s"']+@/g, 'https://<creds>@');
}
