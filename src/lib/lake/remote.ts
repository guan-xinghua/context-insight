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
// URL > env 分离对 > 请求体表单 > lake-auth.json 已存凭据）；pull 凭据
// 同链消费（clone/fetch 走一次性 helper），但 env 通道仅默认仓生效——env
// 令牌不得外送到请求方任意自定义地址。
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { LakeRemoteInput } from '@/lib/lake-config';
import { parseUrlCreds, getStoredCredentials, type PushAuth } from './auth';
import { readServerLakeConfig } from './server-config';
import { normalizeHost, tokenOwner } from './platform';
import { runGitWithAuth } from './mirror';

export { parseUrlCreds } from './auth';
export type { PushAuth } from './auth';

// 默认仓概念已退役（二合一彻底统一）：地址必须由用户显式配置（设置页 /
// unconfigured 引导弹窗），env 不再作为远端地址回落——resolveLakeRemote
// 无地址即 fail-fast 指引配置


// LFS 模式（惰性读）：.jsonl.7z/.jsonl.gz 以 LFS 指针出仓，实体进 LFS 存储——数据量
// 不再计入 git 仓配额。三层决议（与 cpx 对齐）：env LAKE_LFS 显式 1/true/on
// 或 0/false/off > 请求体 config.lfs > 默认开（数据仓平台侧启用 LFS 后容量出配额
// 是湖的常态诉求；env 置 0/false/off 一次性回退 blob 模式）。
function envLfs(): boolean | undefined {
  const v = process.env.LAKE_LFS?.toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return undefined;
}

export interface LakeRemote {
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
  /**
   * 凭据来源为持久单源（lake-auth.json，resolveLakeRemote 独有）：镜像层
   * syncMirrorCredentials 据此把凭据固化进镜像仓级配置（partial clone 的
   * promisor 懒取认证）。编辑态表单值（resolveAdhocRemote）不固化——瞬态
   * 凭据不得持久化进镜像缓存。缺省 false。
   */
  storedAuth?: boolean;
  branch: string;
  /** 上传缺省目录（无 category 时的落盘位）。'' = 仓库根（默认——根级
   *  <sid>/；'sessions' 存量区默认已退役）。列表/导入恒多根全仓扫描。 */
  rootDir: string;
  cacheDir: string;
  /** LFS 模式：.jsonl.7z/.jsonl.gz 走 LFS 指针（env LAKE_LFS 显式值 > config.lfs > 默认开） */
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
    normalizeHost(u);
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

export function embedCredentials(url: string, input?: LakeRemoteInput): string {
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

// 缺省目录 = 仓库根（'sessions' 存量区默认已退役——私仓耦合遗产，无目录
// 上传落根级 <sid>/）。显式配置 directory 时为其归一化形态
export function normalizeDirectory(directory?: string): string {
  return normalizeDirPrefix(directory);
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
  // path.resolve 归一为绝对路径：LAKE_CACHE_DIR 若为相对值（客户现场
  // 配过 "tmp/lake-cache"），git clone 的目标参数会以 execSync cwd 为
  // 基准二次解析落到 <cache>/tmp/lake-cache/… 双重路径，而 Node fs 按
  // 进程 cwd 解析单层路径 → rename ENOENT（镜像初始化必失败）。
  // LAKE_VIEWER_CACHE_DIR：原 viewer 独立镜像入口（双栈时代测试隔离用），
  // P2 统一后保留为最前优先级兼容层——存量 env/测试脚本零改动
  return path.resolve(
    process.env.LAKE_VIEWER_CACHE_DIR
      ?? process.env.LAKE_CACHE_DIR
      ?? path.join(process.cwd(), 'tmp', 'lake-cache'),
  );
}

/** 唯一配置源解析（单源架构）：远端地址/分支/目录只从服务端 lake-config.json
 *  来（设置页保存落盘——全机生效：Web/Viewer/CLI/cpx 同机共读同一份）。
 *  无请求体回落、无 env 钉死通道（旧私仓世界形态，已退役；CI/脚本直接写
 *  lake-config.json + lake-auth.json——文件即接口）。凭据一律从 lake-auth.json
 *  按地址解析（表单凭据只在编辑态探测 resolveAdhocRemote 里生效）。未配置
 *  fail-fast。 */
export function resolveLakeRemote(): LakeRemote {
  const cfg = readServerLakeConfig();
  if (!cfg) {
    throw new Error('未配置数据仓地址：请在「设置 → 数据之湖」配置远端地址');
  }
  const credlessPull = normalizeGitAddress(cfg.address);
  const branch = cfg.branch ? validateBranch(cfg.branch) : 'main';
  // 镜像缓存按远端 URL+分支哈希隔离：迁址后旧镜像 origin 仍指旧仓——fetch
  // 照样成功，列表/上传会静默读写错误的仓库。哈希后新址自然新镜像
  const cacheDir = path.join(
    defaultCacheDir(),
    createHash('sha1').update(`${credlessPull}|${branch}`).digest('hex').slice(0, 12),
  );
  const pushAuth = getStoredCredentials(credlessPull);
  return {
    pullUrl: credlessPull,
    pushUrl: credlessPull,
    pushAuth,
    pullAuth: pushAuth,
    branch,
    rootDir: normalizeDirectory(cfg.directory),
    cacheDir,
    lfs: envLfs() ?? cfg.lfs ?? true,
    // 持久单源标记：凭据（含"已存为空"）来自 lake-auth.json——镜像层据此把
    // 凭据固化进镜像仓级配置（syncMirrorCredentials）。null 与 true 并存是
    // 语义而非矛盾：单源查过且无凭据 → 镜像侧卸载自持凭据
    storedAuth: true,
  };
}

/** 编辑态探测解析（设置页测试连接/浏览分支/浏览目录）：拿用户正在输入的
 *  显式值——地址必填、无服务端回落（探测的就是未保存的编辑值），表单凭据
 *  即时参与验证（表单空 = 测服务端已存凭据）。只用于探测类动作
 *  （action=test/branches/dirs）；数据动作（list/upload/import）一律
 *  resolveLakeRemote() 单源，忽略请求体 config。 */
export function resolveAdhocRemote(input?: LakeRemoteInput): LakeRemote {
  const address = input?.address?.trim();
  if (!address) {
    throw new Error('缺少远端地址');
  }
  const credlessPull = normalizeGitAddress(address);
  const branchInput = input?.branch?.trim();
  const branch = branchInput ? validateBranch(branchInput) : 'main';
  const cacheDir = path.join(
    defaultCacheDir(),
    createHash('sha1').update(`${credlessPull}|${branch}`).digest('hex').slice(0, 12),
  );
  // 表单凭据：token/password 即时验证（embedCredentials 仅 http 形态内嵌，
  // requestAuth 全形态生效——本地路径远端测试连接/推身份仍可用）
  const pullUrl = embedCredentials(credlessPull, input);
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
  const pushUrl = parseUrlCreds(pullUrl).credless;
  const pushAuth = requestAuth ?? getStoredCredentials(credlessPull);
  // 表单值不落盘：编辑态瞬态凭据（试连即弃）不得固化进镜像缓存——storedAuth
  // 缺省 false，镜像层 syncMirrorCredentials 对 adhoc 远端零动作
  const pullAuth = parseUrlCreds(pullUrl).auth ? null : pushAuth;
  return {
    pullUrl,
    pushUrl,
    pushAuth,
    pullAuth,
    branch,
    rootDir: normalizeDirectory(input?.directory),
    cacheDir,
    lfs: envLfs() ?? input?.lfs ?? true,
  };
}

export function defaultLakeRemote(): LakeRemote {
  return resolveLakeRemote();
}

// execSync 失败的 err.message/stderr 含完整命令行（带凭据 URL）——出路由
// 边界前必须过这里：带凭据 URL → 无凭据地址，裸凭据值 → ***
export function redactRemoteSecrets(
  message: string,
  remote: LakeRemote | null | undefined,
  secrets: (string | undefined)[],
): string {
  let m = message;
  if (!remote) return m;
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


// 测试连接的结论文案（纯决策，供 UT 锁矩阵）：owner 来自 gitcode api/v5/user
// 反查——gitcode 上 owner=null 意味着令牌没能通过 /user（无效/过期/查询失败），
// 只能诚实报「凭据未能验证」，不得声称「凭据已验证」（公开仓匿名可通，ls-remote
// 成功不构成对凭据的任何证明）。account 只认用户实际输入——'oauth2' 是
// token 模式无账户时的系统兜底占位（requestAuth/LakeTokenDialog 两路同款），
// 不是「所填账户」，不得参与属主不一致判定（否则误报「与所填账户 oauth2
// 不一致」）
export function credentialTestMessage(opts: {
  owner: string | null;
  account: string;
  authMode?: LakeRemoteInput['authMode'];
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

export async function testLakeRemote(input?: LakeRemoteInput): Promise<{ success: boolean; message: string }> {
  // 选了认证方式但没填凭据 → 直接失败（公共仓匿名可通，但用户要验证的是凭据；
  // 私有仓上传/克隆都需凭据，漏配会在真实操作时才爆）
  if (input?.authMode === 'token' && !input.token?.trim()) {
    return { success: false, message: '已选择令牌认证但未填写令牌，请填写后再测试' };
  }
  if (input?.authMode === 'password' && !(input.account?.trim() && input.password?.trim())) {
    return { success: false, message: '已选择账户密码认证但账户/密码未填写完整，请填写后再测试' };
  }
  const remote = resolveAdhocRemote(input);
  try {
    // ls-remote 与 push/pull 同通道：凭据经一次性 credential helper 供给
    // pushAuth（表单 > lake-auth.json），URL 一律无凭据——表单为空的常态下
    // 测的正是服务端已存凭据；私有仓匿名 ls-remote 必 401，
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
    const owner = await tokenOwner(remote.pullUrl, secret);
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
// 凭据与 clone/fetch 同通道消费（表单内嵌 > pullAuth=lake-auth.json 已存
// 凭据，一次性 helper 供给）——不依赖调用方记得传 includeCreds：设置页分支
// 下拉默认剥表单凭据，私有仓匿名 ls-remote 恒 401，分支列表将永远拉不出来。
// 忽略 input.branch/directory —— 分支与列表无关，且用户可能正在改这个字段
export function listRemoteBranches(input?: LakeRemoteInput): string[] {
  const { address, authMode, account, password, token } = input ?? {};
  const remote = resolveAdhocRemote({ address, authMode, account, password, token });
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
