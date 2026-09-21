// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 远端解析层：请求体 config > env > 硬编码默认。分支/目录会拼进 shell git
// 命令，与 sid 同款白名单校验；凭据只进 URL（encodeURIComponent），错误
// 消息出边界前必须 redactRemoteSecrets（execSync 失败会携带完整命令行）。
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CannbayRemoteInput } from '@/lib/cannbay-config';

export const CANNBAY2_PULL_URL = process.env.CANNBAY2_REMOTE_URL
  ?? 'https://atomgit.com/duanbingzhe/cannbay3.git';
// 密文常量（与 v1 upload-session/route.ts 同方式），解码 = https://<user>:<token>@atomgit.com/…
// 它是 push 凭据源（auth 提取），不再内嵌进 push URL：atomgit 已拒"请求直带
// 密码"式鉴权，凭据只经 credential helper 的 401 挑战-应答通道供给（见
// mirror.ts pushMirror）。
const CANNBAY2_PUSH_URL_ENCODED = 'aHR0cHM6Ly9kdWFuYmluZ3poZTpvU1I1aTF3WXZ5dlZpUmdMbXdna3NDeG5AYXRvbWdpdC5jb20vZHVhbmJpbmd6aGUvY2FubmJheTMuZ2l0';
export const CANNBAY2_PUSH_URL = process.env.CANNBAY2_PUSH_URL
  ?? Buffer.from(CANNBAY2_PUSH_URL_ENCODED, 'base64').toString();
export const CANNBAY2_BRANCH = process.env.CANNBAY2_BRANCH ?? 'main';

// LFS 模式（惰性读）：.jsonl.7z/.jsonl.gz 以 LFS 指针出仓，实体进 LFS 存储——数据量
// 不再计入 git 仓配额。三层决议（与 cpx 对齐）：env CANNBAY2_LFS 显式 1/true/on
// 或 0/false/off > 请求体 config.lfs > 默认开（数据仓平台侧启用 LFS 后容量出配额
// 是湖的常态诉求；env 置 0/false/off 一次性回退 blob 模式）。
function envLfs(): boolean | undefined {
  const v = process.env.CANNBAY2_LFS?.toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return undefined;
}

export interface PushAuth {
  username: string;
  password: string;
}

/** https URL 内嵌凭据拆分：`scheme://user:pass@rest` → 无凭据 URL + auth 对；
 * 无凭据（本地路径 / 匿名 URL）原样返回、auth=null。 */
export function parseUrlCreds(url: string): { credless: string; auth: PushAuth | null } {
  const m = url.match(/^(https?:\/\/)([^/@:\s]+):([^@\s]+)@/i);
  if (!m) return { credless: url, auth: null };
  return {
    credless: url.slice(0, m[1].length) + url.slice(m[0].length),
    auth: { username: decodeURIComponent(m[2]), password: decodeURIComponent(m[3]) },
  };
}

export interface Cannbay2Remote {
  pullUrl: string;
  /** 无凭据 push 地址：凭据走 credential helper（pushAuth），绝不内嵌 URL */
  pushUrl: string;
  /** push 凭据（内置共享令牌 / 自定义地址的表单凭据）；null = 匿名推 */
  pushAuth: PushAuth | null;
  branch: string;
  rootDir: string;
  cacheDir: string;
  /**
   * 范式目录多根模式（仅默认仓，无自定义地址）：sessions/ 为存量区 + 全部
   * 顶层目录即范式注册表（<paradigm>/<sid>/）。自定义远端维持 rootDir 单根。
   * 新增范式 = 在数据仓新建顶层目录，insight 零范式知识。
   */
  paradigmRoots: boolean;
  /** LFS 模式：.jsonl.7z/.jsonl.gz 走 LFS 指针（env CANNBAY2_LFS 显式值 > config.lfs > 默认开） */
  lfs?: boolean;
}

const FORBIDDEN_ADDRESS_CHARS = /["'`$;&|\n\r]/;

// ai.gitcode.com 不提供 git http 服务（302 首页），仅该主机归一为 gitcode.com
export function normalizeGitAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) throw new Error('无效的数据湖地址');
  if (FORBIDDEN_ADDRESS_CHARS.test(trimmed)) throw new Error('数据湖地址含非法字符');
  if (/^https?:\/\//i.test(trimmed)) {
    // 先解析后去尾斜杠：'https://' 预先剥斜杠会退化成合法的 'https:'
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      throw new Error(`无效的数据湖地址: "${trimmed.slice(0, 80)}"`);
    }
    if (u.host === 'ai.gitcode.com') u.host = 'gitcode.com';
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/+$/, '');
  }
  return trimmed.replace(/\/+$/, '');
}

function stripUrlCreds(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
}

export { stripUrlCreds };

export function embedCredentials(url: string, input?: CannbayRemoteInput): string {
  if (!input || !/^https?:\/\//i.test(url)) return url;
  let user = '';
  let pass = '';
  if (input.authMode === 'token') {
    const token = input.token?.trim();
    if (!token) return url;
    user = input.account?.trim() || 'oauth2';
    pass = token;
  } else {
    const account = input.account?.trim();
    const password = input.password?.trim();
    if (!account || !password) return url;
    user = account;
    pass = password;
  }
  return stripUrlCreds(url).replace(
    /^(https?:\/\/)/i,
    `$1${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`,
  );
}

export function validateBranch(branch: string): string {
  const b = branch.trim();
  if (!/^[\w.-]+$/.test(b)) throw new Error(`无效分支名: "${branch.slice(0, 40)}"`);
  return b;
}

export function normalizeDirectory(directory?: string): string {
  const d = normalizeDirPrefix(directory);
  return d || 'sessions';
}

// 浏览前缀：与 normalizeDirectory 同规则，但空串 = 仓库根（浏览起点）
export function normalizeDirPrefix(prefix?: string): string {
  const d = (prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!d) return '';
  if (d.length > 200 || d.includes('\\')) throw new Error(`无效目录: "${d.slice(0, 60)}"`);
  const segments = d.split('/');
  if (segments.length > 16) throw new Error('目录层级过深（最多 16 段）');
  for (const seg of segments) {
    // 非 ASCII 段放行（trace_corpus 月份目录 "7月"）：shell 元字符与路径语义
    // 字符（空白 ;|&$`"' *?[] \ /）全在 ASCII 区，白名单只约束 ASCII 段即可
    // 保住注入面 —— tsconfig target ES2017，不能用 \p{..} Unicode property escape
    if (!/^[\w\u0080-\uFFFF.-]+$/.test(seg) || seg === '.' || seg === '..') {
      throw new Error(`无效目录: "${d.slice(0, 60)}"`);
    }
  }
  return segments.join('/');
}

// 白名单段含 `.`（正则元字符）：拼 ls-tree/log 正则前必须转义，否则目录
// `v1.2` 会错配 `v1x2`
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultCacheDir(): string {
  // path.resolve 归一为绝对路径：CANNBAY2_CACHE_DIR 若为相对值（客户现场
  // 配过 "tmp/cannbay2-cache"），git clone 的目标参数会以 execSync cwd 为
  // 基准二次解析落到 <cache>/tmp/cannbay2-cache/… 双重路径，而 Node fs 按
  // 进程 cwd 解析单层路径 → rename ENOENT（镜像初始化必失败）。
  return path.resolve(
    process.env.CANNBAY2_CACHE_DIR
      ?? path.join(process.cwd(), 'tmp', 'cannbay2-cache'),
  );
}

export function resolveCannbay2Remote(input?: CannbayRemoteInput): Cannbay2Remote {
  const hasAddress = !!input?.address?.trim();
  const credlessPull = hasAddress ? normalizeGitAddress(input!.address!) : CANNBAY2_PULL_URL;
  const branchInput = input?.branch?.trim();
  // env 分支属于 env 远端：body 带自定义地址时不得串用，回落 main
  const branch = branchInput
    ? validateBranch(branchInput)
    : hasAddress ? 'main' : CANNBAY2_BRANCH;
  const cacheDir = hasAddress || branchInput
    ? path.join(
      defaultCacheDir(),
      createHash('sha1').update(`${credlessPull}|${branch}`).digest('hex').slice(0, 12),
    )
    : defaultCacheDir();
  // push 凭据归属：默认仓（未配自定义地址）push 一律用内置共享令牌，用户
  // 在设置页配置的数据之湖凭据只对自定义地址生效。否则 embedCredentials 会
  // 剥掉内置凭据换成用户身份 → atomgit CH.00905403 "not allowed to push"：
  // 客户令牌鉴权通过但对共享仓无写权限（拉取/列表仍带用户凭据，私有数据湖
  // 场景不受影响）。凭据经 parseUrlCreds 提取走 credential helper，pushUrl
  // 本体无凭据（atomgit 拒请求直带密码的内嵌 URL）。
  const { credless: pushUrl, auth: pushAuth } = parseUrlCreds(
    hasAddress ? embedCredentials(credlessPull, input) : CANNBAY2_PUSH_URL,
  );
  return {
    pullUrl: embedCredentials(credlessPull, input),
    pushUrl,
    pushAuth,
    branch,
    rootDir: normalizeDirectory(input?.directory),
    cacheDir,
    paradigmRoots: !hasAddress,
    lfs: envLfs() ?? input?.lfs ?? true,
  };
}

export function defaultCannbay2Remote(): Cannbay2Remote {
  return resolveCannbay2Remote(undefined);
}

// execSync 失败的 err.message/stderr 含完整命令行（带凭据 URL）——出路由
// 边界前必须过这里：带凭据 URL → 无凭据地址，裸凭据值 → ***
export function redactRemoteSecrets(
  message: string,
  remote: Cannbay2Remote,
  secrets: (string | undefined)[],
): string {
  let m = message;
  for (const url of [remote.pullUrl, remote.pushUrl]) {
    if (url) m = m.split(url).join(stripUrlCreds(url));
  }
  for (const s of secrets) {
    const v = s?.trim();
    if (v && v.length >= 4) m = m.split(v).join('***');
  }
  return m;
}

// PAT 认证下 git http 只校验令牌（密码位），用户名被服务端忽略 —— "改错用户名
// 仍成功"属正常。gitcode 可经 api/v5/user 反查令牌真实属主（端点实测存在，
// 401 = token 无效），用于测试连接时明示令牌属于谁、与所填账户是否一致
export async function gitcodeTokenOwner(pullUrl: string, secret: string): Promise<string | null> {
  if (!secret) return null;
  try {
    const u = new URL(pullUrl);
    if (u.host !== 'gitcode.com') return null;
    const res = await fetch(`https://gitcode.com/api/v5/user?access_token=${encodeURIComponent(secret)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as Record<string, unknown>;
    if (typeof j.login === 'string' && j.login) return j.login;
    if (typeof j.username === 'string' && j.username) return j.username;
    return null;
  } catch {
    return null;
  }
}

export async function testCannbay2Remote(input?: CannbayRemoteInput): Promise<{ success: boolean; message: string }> {
  // 选了认证方式但没填凭据 → 直接失败（公共仓匿名可通，但用户要验证的是凭据；
  // gitcode 私有仓上传/克隆都认 PAT，漏配会在真实操作时才爆）
  if (input?.authMode === 'token' && !input.token?.trim()) {
    return { success: false, message: '已选择令牌认证但未填写令牌，请填写后再测试' };
  }
  if (input?.authMode === 'password' && !(input.account?.trim() && input.password?.trim())) {
    return { success: false, message: '已选择账户密码认证但账户/密码未填写完整，请填写后再测试' };
  }
  const remote = resolveCannbay2Remote(input);
  try {
    execSync(`git ls-remote "${remote.pullUrl}" HEAD`, { stdio: 'pipe', timeout: 20_000 });
    // 无效凭据会被服务端 401（gitcode 实测），带凭据成功 = 凭据真实可用
    const hasCreds = /^https?:\/\//i.test(remote.pullUrl) && remote.pullUrl !== stripUrlCreds(remote.pullUrl);
    if (!hasCreds) return { success: true, message: '连接成功（匿名访问，未验证凭据）' };
    const secret = (input?.authMode === 'password' ? input?.password : input?.token)?.trim() ?? '';
    const owner = await gitcodeTokenOwner(remote.pullUrl, secret);
    const account = input?.account?.trim() ?? '';
    const isGitcode = /^https?:\/\/[^/@]*gitcode\.com\//i.test(stripUrlCreds(remote.pullUrl));
    if (!isGitcode) {
      // atomgit 公开仓实测忽略 basic auth（错误账密照样成功）—— 不能声称"凭据已验证"
      return { success: true, message: '连接成功（地址可访问；凭据已随请求发送，但公开仓远端通常不校验凭据）' };
    }
    if (owner && account && owner.toLowerCase() !== account.toLowerCase()) {
      return { success: true, message: `连接成功（凭据已验证）—— 注意：凭据属于用户 ${owner}，与所填账户 ${account} 不一致（git 认证不校验用户名）` };
    }
    if (owner && input?.authMode === 'password') {
      return { success: true, message: `连接成功（凭据已验证，属于用户 ${owner}）—— gitcode 已移除密码认证，密码位实为令牌，建议改用「令牌」方式` };
    }
    return { success: true, message: owner ? `连接成功（凭据已验证，令牌属于用户 ${owner}）` : '连接成功（凭据已验证）' };
  } catch (err) {
    const withStderr = err instanceof Error
      ? `${err.message}\n${String((err as { stderr?: Buffer }).stderr ?? '')}`
      : String(err);
    return {
      success: false,
      message: redactRemoteSecrets(withStderr, remote, [input?.account, input?.password, input?.token]).slice(0, 500),
    };
  }
}

// 分支选择：ls-remote --heads 直接问远端要引用（无需镜像克隆）。
// 忽略 input.branch/directory —— 分支与列表无关，且用户可能正在改这个字段
export function listRemoteBranches(input?: CannbayRemoteInput): string[] {
  const { address, authMode, account, password, token } = input ?? {};
  const remote = resolveCannbay2Remote({ address, authMode, account, password, token });
  try {
    const out = execSync(`git ls-remote --heads "${remote.pullUrl}"`, { stdio: 'pipe', timeout: 20_000 }).toString();
    return out.split('\n')
      .map(l => { const m = l.match(/^[0-9a-f]+\trefs\/heads\/(.+)$/); return m ? m[1].trim() : ''; })
      .filter(name => /^[\w.-]+$/.test(name))
      .sort();
  } catch (err) {
    const withStderr = err instanceof Error
      ? `${err.message}\n${String((err as { stderr?: Buffer }).stderr ?? '')}`
      : String(err);
    throw new Error(redactRemoteSecrets(withStderr, remote, [account, password, token]).slice(0, 500));
  }
}
