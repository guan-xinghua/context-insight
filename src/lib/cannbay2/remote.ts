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
// push 凭据经 auth.ts 解析链，绝不内置（env 完整
// URL > env 分离对 > 请求体表单 > cannbay-auth.json 已存凭据）；pull 凭据
// 同链消费（clone/fetch 走一次性 helper），但 env 通道仅默认仓生效——env
// 令牌不得外送到请求方任意自定义地址。
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CannbayRemoteInput } from '@/lib/cannbay-config';
import { parseUrlCreds, getStoredCredentials, type PushAuth } from './auth';
import { runGitWithAuth } from './mirror';

export { parseUrlCreds } from './auth';
export type { PushAuth } from './auth';

// env 全部惰性读（调用时刻解析）：历史实现在模块顶层读死，vitest worker 跨
// 测试文件共享模块缓存会把 env 钉死在首个加载者，运行中的服务也无法热切换
export function envPullUrl(): string {
  return process.env.CANNBAY2_REMOTE_URL
    ?? 'https://example.com/cannbay-lake.git';
}
export function envBranch(): string {
  return process.env.CANNBAY2_BRANCH ?? 'main';
}

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

export interface Cannbay2Remote {
  pullUrl: string;
  /** 无凭据 push 地址：凭据走 credential helper（pushAuth），绝不内嵌 URL */
  pushUrl: string;
  pushAuth: PushAuth | null;
  /**
   * Pull credentials for private remotes: applied to clone/fetch via a
   * one-shot credential helper (same 401-challenge channel as push; hosting
   * gateways reject URLs with embedded proactive Basic auth). Null = pull
   * anonymously (public repos / local test bare).
   */
  pullAuth: PushAuth | null;
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

// 地址元字符黑名单（导出单一真身）：凡要进入 shell/git 命令的地址输入面
// （normalizeGitAddress、凭据 API PUT）共用同一份校验
export const FORBIDDEN_ADDRESS_CHARS = /["'`$;&|\n\r]/;

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
    // 非 ASCII 段放行（语料仓月份目录 "7月"）：shell 元字符与路径语义
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
  const credlessPull = hasAddress ? normalizeGitAddress(input!.address!) : envPullUrl();
  const branchInput = input?.branch?.trim();
  // env 分支属于 env 远端：body 带自定义地址时不得串用，回落 main
  const branch = branchInput
    ? validateBranch(branchInput)
    : hasAddress ? 'main' : envBranch();
  // 镜像缓存一律按远端 URL+分支哈希隔离（与 cpx 对齐）：默认远端历史上不
  // 哈希（固定缓存根），默认仓迁址后旧镜像 origin 仍指旧仓——fetch 照样
  // 成功，列表/上传会静默读写错误的仓库（2026-09-22 迁址实测：主页仍显示
  // 旧仓 113 会话）。哈希后新址自然新镜像，旧镜像孤儿化无害
  const cacheDir = path.join(
    defaultCacheDir(),
    createHash('sha1').update(`${credlessPull}|${branch}`).digest('hex').slice(0, 12),
  );
  // push 凭据归属：默认仓与自定义远端统一走同一条链——
  // ① env CANNBAY2_PUSH_URL（完整凭据 URL 覆写，仅默认仓；CI/测试通道）
  // ② env CANNBAY2_USERNAME + CANNBAY2_TOKEN（分离对，仅默认仓）
  // ③ 请求体表单凭据（设置页即时测试 / 自定义远端随请求）
  // ④ cannbay-auth.json（服务端凭据存储；cbi auth / 设置页保存写同一份）
  // 凭据经 parseUrlCreds 提取走 credential helper，pushUrl 本体无凭据
  // （平台拒请求直带密码的内嵌 URL）。
  const pullUrl = embedCredentials(credlessPull, input);
  // 表单凭据直接从 input 提取（不经 pullUrl 内嵌往返：本地路径远端无法内嵌，
  // 但测试连接/推身份仍须生效——embedCredentials 的 http 限定只约束传输形态）
  const requestAuth: PushAuth | null = (() => {
    if (input?.authMode === 'token') {
      const t = input.token?.trim();
      return t ? { username: input.account?.trim() || 'oauth2', password: t } : null;
    }
    if (input?.authMode === 'password') {
      const a = input.account?.trim();
      const p = input.password?.trim();
      return a && p ? { username: a, password: p } : null;
    }
    return null;
  })();
  let pushUrl: string;
  let pushAuth: PushAuth | null;
  if (hasAddress) {
    pushUrl = parseUrlCreds(pullUrl).credless;
    pushAuth = requestAuth ?? getStoredCredentials(credlessPull);
  } else {
    const pushOverride = process.env.CANNBAY2_PUSH_URL?.trim();
    if (pushOverride) {
      const parsed = parseUrlCreds(pushOverride.replace(/\/+$/, ''));
      pushUrl = parsed.credless;
      pushAuth = parsed.auth;
    } else {
      pushUrl = parseUrlCreds(pullUrl).credless;
      const envU = process.env.CANNBAY2_USERNAME?.trim();
      const envT = process.env.CANNBAY2_TOKEN?.trim();
      pushAuth = envU && envT ? { username: envU, password: envT } : (requestAuth ?? getStoredCredentials(credlessPull));
    }
  }
  // pull 凭据与 push 同一条解析链（默认仓）：env 完整 URL > env 分离对 >
  // 表单 > cannbay-auth.json——否则 env 配置的私有默认仓（CANNBAY2_REMOTE_URL
  // + CANNBAY2_USERNAME/TOKEN）test 走 pushAuth 能过、clone/fetch 却匿名 401，
  // list/import/upload 全挂在 ensureMirror 克隆段且无恢复路径（凭据明明在 env
  // 里却被引导去「配置凭据」）。与 lake/remote.ts resolveLakeRemote 对齐
  // （pullAuth = push 链）。自定义地址不吃 env 凭据（env 令牌不得外送到请求方
  // 任意地址，作用域与 push 侧一致）；表单凭据已内嵌 pullUrl 时为 null（不双重供给）。
  const pullAuth = parseUrlCreds(pullUrl).auth
    ? null
    : hasAddress ? getStoredCredentials(credlessPull) : pushAuth;
  return {
    pullUrl,
    pushUrl,
    pushAuth,
    pullAuth,
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

// 令牌式认证下 git http 只校验凭据（密码位），用户名被服务端忽略 —— "改错用户名
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

// 测试连接的结论文案（纯决策，供 UT 锁矩阵）：owner 来自 gitcode api/v5/user
// 反查——gitcode 上 owner=null 意味着令牌没能通过 /user（无效/过期/查询失败），
// 只能诚实报「凭据未能验证」，不得声称「凭据已验证」（公开仓匿名可通，ls-remote
// 成功不构成对凭据的任何证明）。account 只认用户实际输入——'oauth2' 是
// token 模式无账户时的系统兜底占位（requestAuth/CannbayTokenDialog 两路同款），
// 不是「所填账户」，不得参与属主不一致判定（否则误报「与所填账户 oauth2
// 不一致」）
export function credentialTestMessage(opts: {
  owner: string | null;
  account: string;
  authMode?: CannbayRemoteInput['authMode'];
  isGitcode: boolean;
}): string {
  const { owner, authMode, isGitcode } = opts;
  const account = opts.account?.trim()?.toLowerCase() === 'oauth2' ? '' : (opts.account?.trim() ?? '');
  if (!isGitcode) {
    // 平台公开仓实测忽略 basic auth（错误账密照样成功）—— 不能声称"凭据已验证"
    return '连接成功（地址可访问；已配置凭据，公开仓远端通常不校验凭据，凭牌有效性由首次上传确认）';
  }
  if (owner && account && owner.toLowerCase() !== account.toLowerCase()) {
    return `连接成功（凭据已验证）—— 注意：凭据属于用户 ${owner}，与所填账户 ${account} 不一致（git 认证不校验用户名）`;
  }
  if (owner && authMode === 'password') {
    return `连接成功（凭据已验证，属于用户 ${owner}）—— gitcode 已移除密码认证，密码位实为令牌，建议改用「令牌」方式`;
  }
  if (owner) return `连接成功（凭据已验证，令牌属于用户 ${owner}）`;
  return '连接成功（凭据未能验证——无法确认令牌属主，令牌可能无效或已过期，有效性由首次上传确认）';
}

export async function testCannbay2Remote(input?: CannbayRemoteInput): Promise<{ success: boolean; message: string }> {
  // 选了认证方式但没填凭据 → 直接失败（公共仓匿名可通，但用户要验证的是凭据；
  // 私有仓上传/克隆都需凭据，漏配会在真实操作时才爆）
  if (input?.authMode === 'token' && !input.token?.trim()) {
    return { success: false, message: '已选择令牌认证但未填写令牌，请填写后再测试' };
  }
  if (input?.authMode === 'password' && !(input.account?.trim() && input.password?.trim())) {
    return { success: false, message: '已选择账户密码认证但账户/密码未填写完整，请填写后再测试' };
  }
  const remote = resolveCannbay2Remote(input);
  try {
    // ls-remote 与 push/pull 同通道：凭据经一次性 credential helper 供给
    // pushAuth（解析链终态 = 表单 > env > cannbay-auth.json），URL 一律无凭据
    // ——表单为空的常态下测的正是服务端已存凭据；私有仓匿名 ls-remote 必 401，
    // 不带凭据会把有效存量凭据误报「连接失败」
    runGitWithAuth(
      `git ls-remote "${parseUrlCreds(remote.pullUrl).credless}" HEAD`,
      process.cwd(),
      remote.pushAuth,
      20_000,
    );
    const pushAuth = remote.pushAuth;
    if (!pushAuth) return { success: true, message: '连接成功（匿名访问，未配置凭据）' };
    const secret = pushAuth.password;
    const owner = await gitcodeTokenOwner(remote.pullUrl, secret);
    const isGitcode = /^https?:\/\/[^/@]*gitcode\.com\//i.test(stripUrlCreds(remote.pullUrl));
    return {
      success: true,
      // 不一致判定只用用户实际填写的账户：pushAuth.username 在 token 模式
      // 无账户时是 'oauth2' 系统兜底（非用户输入），拿它比对会误报
      // 「与所填账户 oauth2 不一致」
      message: credentialTestMessage({ owner, account: input?.account?.trim() ?? '', authMode: input?.authMode, isGitcode }),
    };
  } catch (err) {
    const withStderr = err instanceof Error
      ? `${err.message}\n${String((err as { stderr?: Buffer }).stderr ?? '')}`
      : String(err);
    return {
      success: false,
      message: redactRemoteSecrets(withStderr, remote, [input?.account, input?.password, input?.token, remote.pushAuth?.password]).slice(0, 500),
    };
  }
}

// 分支选择：ls-remote --heads 直接问远端要引用（无需镜像克隆）。
// 凭据与 clone/fetch 同通道消费（表单内嵌 > pullAuth=cannbay-auth.json 已存
// 凭据，一次性 helper 供给）——不依赖调用方记得传 includeCreds：设置页分支
// 下拉默认剥表单凭据，私有仓匿名 ls-remote 恒 401，分支列表将永远拉不出来。
// 忽略 input.branch/directory —— 分支与列表无关，且用户可能正在改这个字段
export function listRemoteBranches(input?: CannbayRemoteInput): string[] {
  const { address, authMode, account, password, token } = input ?? {};
  const remote = resolveCannbay2Remote({ address, authMode, account, password, token });
  try {
    const { credless, auth } = parseUrlCreds(remote.pullUrl);
    const out = runGitWithAuth(`git ls-remote --heads "${credless}"`, process.cwd(), auth ?? remote.pullAuth, 20_000).toString();
    return out.split('\n')
      .map(l => { const m = l.match(/^[0-9a-f]+\trefs\/heads\/(.+)$/); return m ? m[1].trim() : ''; })
      .filter(name => /^[\w.-]+$/.test(name))
      .sort();
  } catch (err) {
    const withStderr = err instanceof Error
      ? `${err.message}\n${String((err as { stderr?: Buffer }).stderr ?? '')}`
      : String(err);
    throw new Error(redactRemoteSecrets(withStderr, remote, [account, password, token, remote.pullAuth?.password]).slice(0, 500));
  }
}
