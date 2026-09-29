// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Push-credential management (insight side): user-configured credentials
// stored in ~/.cannbot-insight/lake-auth.json (0600 + atomic writes;
// 旧名 cannbay-auth.json 读兜底——存量凭据无感迁移，见 authFilePath 注释)。
//
// 凭据解析（单源架构）：lake-auth.json 按远端 URL 键控的服务端存储
// （insight 设置页 / cbi auth 两个入口写同一份）。旧 env 凭据通道
// （LAKE_PUSH_URL / LAKE_USERNAME + LAKE_TOKEN，私仓世界 CI 形态）已退役
// ——CI/脚本直接写 lake-auth.json（文件即接口）。全空 → null；https 远端
// push 前由 requirePushCredentials fail-fast（指引配置入口，而不是让 git
// 在 401/终端提示上挂死）。

import fs from 'node:fs';
import { PLATFORM_AUTH_FAILED_CODES, PLATFORM_FORBIDDEN_CODES } from './platform';
import os from 'node:os';
import path from 'node:path';

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

// 凭据存储文件：与 proxy 捕获目录同根（CANNBOT_PROXY_DIR 重定向优先——测试/
// 多实例隔离；'.cannbot-insight' 引号字面量是 pack-context 品牌翻转点，与
// lfs-setup.ts 同款纪律）。读首选 lake-auth.json；旧名文件（历史版本产物）
// 读兜底——存量凭据无感迁移：读旧写新，首次保存即落新文件，旧文件原地保留
// （避免版本回滚丢凭据）。新文件存在即为权威（用户主动清空不复活旧凭据）。
export function authFilePath(): string {
  return path.join(
    path.dirname(process.env.CANNBOT_PROXY_DIR ?? path.join(os.homedir(), '.cannbot-insight', 'proxy')),
    'lake-auth.json',
  );
}

function legacyAuthFilePath(): string {
  return path.join(
    path.dirname(process.env.CANNBOT_PROXY_DIR ?? path.join(os.homedir(), '.cannbot-insight', 'proxy')),
    'cannbay-auth.json',
  );
}

interface StoredEntry {
  username: string;
  token: string;
  verifiedAt?: string;
}

interface AuthFileShape {
  remotes: Record<string, StoredEntry>;
}

// 损坏/缺文件 → 空表（凭据未配置），绝不抛——解析链消费方按 null 走 fail-fast。
// 新名文件存在即权威；不存在则读旧名兜底（存量迁移，见 authFilePath 注释）
function readAuthFile(): AuthFileShape {
  for (const file of [authFilePath(), legacyAuthFilePath()]) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && typeof (raw as { remotes?: unknown }).remotes === 'object') {
        return { remotes: (raw as AuthFileShape).remotes };
      }
    } catch { /* 无/坏文件 → 试下一个候选 */ }
    if (file === authFilePath() && fs.existsSync(file)) {
      // 新名文件存在但内容非法/空 remotes 形状：以空表视作权威，不再读旧名
      // （用户清空操作不因旧文件残留而复活）
      return { remotes: {} };
    }
  }
  return { remotes: {} };
}

// 原子写（tmp+rename）+ 0600：凭据文件权限纪律与 gh config / .npmrc 同级。
// rename 生效后文件权限继承 tmp 件；整文件重写的读改写竞态（cbi auth 与
// insight 设置页同时写）按 last-writer-wins 收敛——两个入口都是人工低频操作
function writeAuthFile(data: AuthFileShape): void {
  const file = authFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/** 远端 URL 键归一：剥内嵌凭据、去尾斜杠、host 小写。本地路径原样返回。 */
export function normalizeAuthKey(url: string): string {
  const credless = url.replace(/^(https?:\/\/)[^/@]+@/i, '$1').trim().replace(/\/+$/, '');
  try {
    const u = new URL(credless);
    u.username = '';
    u.password = '';
    u.host = u.host.toLowerCase();
    return u.toString().replace(/\/+$/, '');
  } catch {
    return credless;
  }
}

function entryToAuth(e: unknown): PushAuth | null {
  if (e && typeof e === 'object' && typeof (e as StoredEntry).username === 'string'
    && typeof (e as StoredEntry).token === 'string' && (e as StoredEntry).token) {
    return { username: (e as StoredEntry).username, password: (e as StoredEntry).token };
  }
  return null;
}

/** 查远端凭据：键控查找（带/不带 .git 双候选互认——设置页手输地址与解析层
 * 规范地址可能差一个 .git 后缀，不该因此读不到已存凭据）。 */
export function getStoredCredentials(remoteUrl: string): PushAuth | null {
  const remotes = readAuthFile().remotes;
  const key = normalizeAuthKey(remoteUrl);
  const candidates = key.endsWith('.git')
    ? [key, key.slice(0, -'.git'.length)]
    : [key, `${key}.git`];
  for (const k of candidates) {
    const auth = entryToAuth(remotes[k]);
    if (auth) return auth;
  }
  return null;
}

export function setStoredCredentials(
  remoteUrl: string, username: string, token: string, verifiedAt?: string,
): void {
  if (!username.trim() || !token.trim()) throw new Error('用户名与推送凭据均不能为空');
  const data = readAuthFile();
  const entry: StoredEntry = { username: username.trim(), token: token.trim() };
  if (verifiedAt) entry.verifiedAt = verifiedAt;
  data.remotes[normalizeAuthKey(remoteUrl)] = entry;
  writeAuthFile(data);
}

/** 清除指定远端凭据；缺省清全部。返回是否有删除发生。 */
export function clearStoredCredentials(remoteUrl?: string): boolean {
  const data = readAuthFile();
  if (remoteUrl === undefined) {
    const had = Object.keys(data.remotes).length > 0;
    if (had) writeAuthFile({ remotes: {} });
    return had;
  }
  const key = normalizeAuthKey(remoteUrl);
  const candidates = key.endsWith('.git')
    ? [key, key.slice(0, -'.git'.length)]
    : [key, `${key}.git`];
  let had = false;
  for (const k of candidates) {
    if (data.remotes[k]) { delete data.remotes[k]; had = true; }
  }
  if (had) writeAuthFile(data);
  return had;
}

/** 凭据脱敏展示（状态面/日志面专用）：保留头 3 尾 4，过短全掩码。 */
export function maskToken(token: string): string {
  const t = token.trim();
  if (t.length <= 8) return '****';
  return `${t.slice(0, 3)}…${t.slice(-4)}`;
}

export interface StoredRemoteInfo {
  url: string;
  username: string;
  tokenMasked: string;
  verifiedAt?: string;
}

/** 已配置远端清单（脱敏）——设置页状态展示 / cbi auth --status 共用。 */
export function listStoredRemotes(): StoredRemoteInfo[] {
  const remotes = readAuthFile().remotes;
  return Object.entries(remotes)
    .map(([url, e]) => ({
      url,
      username: typeof e?.username === 'string' ? e.username : '',
      tokenMasked: typeof e?.token === 'string' ? maskToken(e.token) : '****',
      verifiedAt: typeof e?.verifiedAt === 'string' ? e.verifiedAt : undefined,
    }))
    .filter(e => e.username || e.tokenMasked !== '****');
}

/** https 远端 push 前置检查：无凭据 fail-fast 并给出全部配置入口——绝不放行
 * 到 git push（匿名 https 推送只会在 401/终端用户名提示上挂死，错误形态对
 * 用户毫无指引）。本地路径（file:// / 绝对路径）不检查：测试 bare 仓匿名推
 * 是合法形态。 */
export function requirePushCredentials(pushUrl: string, pushAuth: PushAuth | null): void {
  if (pushAuth) return;
  if (!/^https?:\/\//i.test(pushUrl)) return;
  throw new MissingPushCredentialsError(pushUrl);
}

export class MissingPushCredentialsError extends Error {
  constructor(remoteUrl: string) {
    super(
      `未配置数据仓推送凭据：${remoteUrl}\n` +
      '配置方式（任选其一，cpx 与 insight 同机共享同一份凭据）：\n' +
      '  1. insight Web UI「设置 → 数据之湖」填写推送凭据\n' +
      '  2. 命令行运行 cbi auth 交互式配置（insight CLI：npm 安装后 cbi 直接可用）\n' +
      '  3. 直接写 ~/.cannbot-insight/lake-auth.json（CI/脚本场景——文件即接口）',
    );
    this.name = 'MissingPushCredentialsError';
  }
}

export type LakeErrorCode = 'no-credentials' | 'auth-failed' | 'forbidden' | 'quota' | 'unknown';

/** 上传错误分类（路由结构化 code / cpx CLI 引导文案共用）：无凭据 > 配额 >
 * 无推送权限 > 鉴权失败 > 未知。stderr 一并参与匹配——git 的致命信息走
 * stderr（execSync 异常携带），message 只有命令行。
 * 托管平台错误码区分：CH.00905401 = 凭据无效/密码式认证被拒（auth-failed），
 * CH.00905403 = 凭据有效但对仓无写权限（forbidden）——真机实测文本两者
 * 都含 "Authentication failed"/"Access denied" 字样，必须按码精确分诊。 */
export function classifyLakeError(err: unknown): LakeErrorCode {
  if (err instanceof MissingPushCredentialsError) return 'no-credentials';
  const msg = err instanceof Error
    ? `${err.message}\n${String((err as { stderr?: Buffer }).stderr ?? '')}`
    : String(err);
  if (/quota|exceeds?\s+(the\s+)?(maximum|limit|size)|batch response:.*413|\b413\b/i.test(msg)) return 'quota';
  if (new RegExp(`not allowed to push|forbidden|${PLATFORM_FORBIDDEN_CODES.source}|\\b403\\b`, 'i').test(msg)) return 'forbidden';
  if (new RegExp(`authentication failed|access denied|could not read username|terminal prompts disabled|invalid (username|token|password)|${PLATFORM_AUTH_FAILED_CODES.source}|\\b401\\b`, 'i').test(msg)) return 'auth-failed';
  return 'unknown';
}
