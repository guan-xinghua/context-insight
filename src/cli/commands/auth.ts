// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Data-lake credential setup (CLI half of the guided token dialog). Writes the
// shared server-side credential store that the web settings page, the upload
// flow and the pre-upload check all read from — one configuration covers every
// entry point on this machine. Pure local-file operations plus an optional
// reachability probe (git ls-remote); no backend HTTP required.

import { Command } from 'commander';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import {
  authFilePath, clearStoredCredentials, getStoredCredentials,
  listStoredRemotes, maskToken, setStoredCredentials,
} from '@/lib/lake/auth';
import { readServerLakeConfig } from '@/lib/lake/server-config';
import { formatSuccess, formatWarning } from '../utils/colors';

export interface AuthDeps {
  isTTY?: boolean;
  /** Prompt injection for tests; defaults to stdin/stdout readline. */
  question?: (q: string) => Promise<string>;
  /** Muted prompt injection (credential input); defaults to a no-echo readline. */
  questionMuted?: (q: string) => Promise<string>;
  /** Reachability probe injection; defaults to `git ls-remote` (anonymous). */
  probe?: (url: string) => Promise<{ ok: boolean; message: string }>;
  log?: (msg: string) => void;
  out?: (msg: string) => void;
}

function defaultUsername(): string {
  try {
    const r = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8', timeout: 5000 });
    const name = r.status === 0 ? (r.stdout ?? '').trim() : '';
    if (name) return name;
  } catch { /* git missing: fall through */ }
  return '';
}

// No-echo prompt: readline echoes keystrokes by writing them back to its
// output stream — wrapping the output in a Writable that only forwards the
// prompt text and newlines keeps the credential off the terminal (Ctrl-C goes
// through close → empty answer → treated as cancel).
function mutedQuestion(prompt: string): Promise<string> {
  return new Promise(resolve => {
    let answered = false;
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: true,
      output: new Writable({
        write(chunk, _enc, cb) {
          const s = typeof chunk === 'string' ? chunk : chunk.toString();
          if (s === prompt || s === '\n' || s === '\r\n' || s === '\r') process.stdout.write(s);
          cb();
        },
      }),
    });
    rl.question(prompt, ans => { answered = true; rl.close(); resolve(ans.trim()); });
    rl.on('close', () => { if (!answered) resolve(''); });
  });
}

// Reachability probe only: public repos never challenge anonymous access, so
// this proves the address resolves — real credential validation happens on the
// first push (401 challenge-response). stderr is redacted before display.
async function probeRemote(url: string): Promise<{ ok: boolean; message: string }> {
  const r = spawnSync('git', ['ls-remote', url, 'HEAD'], { encoding: 'utf8', stdio: 'pipe', timeout: 20_000 });
  if (r.status === 0) return { ok: true, message: '地址可达' };
  const detail = (r.stderr || r.error?.message || `exit ${r.status ?? 'null'}`).toString().trim().slice(0, 200);
  return { ok: false, message: detail.replace(/https:\/\/[^/\s"']+@/g, 'https://<creds>@') };
}

async function saveCredentials(
  url: string, username: string, token: string,
  out: (m: string) => void, deps: AuthDeps,
): Promise<number> {
  const probe = deps.probe ?? probeRemote;
  let probeResult: { ok: boolean; message: string };
  try {
    probeResult = await probe(url);
  } catch (e) {
    probeResult = { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  // verifiedAt is only recorded when the probe passes (honest semantics:
  // "connection verified at", never a claim about the credential itself).
  setStoredCredentials(url, username, token, probeResult.ok ? new Date().toISOString() : undefined);
  out(`已保存 → ${authFilePath()}`);
  out(`  远端: ${url}  用户名: ${username}  凭据: ${maskToken(token)}`);
  if (probeResult.ok) {
    out('  连接验证: 通过（公开仓不挑战匿名访问，凭据有效性由首次上传确认）');
  } else {
    out(`  连接验证: 失败（${probeResult.message}）—— 凭据已保存；地址不可达时上传仍会失败，请检查地址拼写`);
  }
  return 0;
}

export interface AuthOptions {
  status?: boolean;
  clear?: boolean;
  remote?: string;
  username?: string;
  token?: string;
  url?: string;
}

export async function runAuthAction(opts: AuthOptions, deps: AuthDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const out = deps.out ?? ((m: string) => console.log(m));
  const isTTY = deps.isTTY ?? !!(process.stdin.isTTY && process.stdout.isTTY);

  if (opts.status) {
    const remotes = listStoredRemotes();
    out(`凭据文件 : ${authFilePath()}`);
    if (remotes.length === 0) {
      out('尚未配置任何远端凭据 —— 运行 ctxi auth 开始配置');
      return 0;
    }
    for (const r of remotes) {
      out(`  ${r.url}`);
      out(`    用户名: ${r.username}  凭据: ${r.tokenMasked}  连接验证: ${r.verifiedAt ?? '未验证'}`);
    }
    return 0;
  }

  if (opts.clear) {
    const url = opts.url;
    const had = clearStoredCredentials(url);
    out(had
      ? `已清除${url ? ` ${url} 的` : '全部'}凭据（${authFilePath()}）`
      : `无可清除项（${url ?? '全部'}未配置）`);
    return 0;
  }

  if (opts.remote !== undefined || opts.username !== undefined || opts.token !== undefined) {
    if (!opts.remote || !opts.username || !opts.token) {
      log('--remote/--username/--token 需同时提供');
      return 2;
    }
    return saveCredentials(opts.remote, opts.username, opts.token, out, deps);
  }

  if (!isTTY && !deps.question) {
    log('非交互环境请用: ctxi auth --remote <url> --username <u> --token <t>');
    return 2;
  }

  const question = deps.question ?? ((q: string) => new Promise<string>(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans); });
  }));
  const muted = deps.questionMuted ?? mutedQuestion;

  let url = (await question('远端地址（回车 = 使用服务端配置的当前数据仓）: ')).trim();
  if (!url) url = readServerLakeConfig()?.address ?? '';
  const existing = getStoredCredentials(url);
  if (existing) log(`注意：该远端已有配置（凭据 ${maskToken(existing.password)}），本次保存将覆盖`);
  let username = (await question(`用户名（回车 = ${defaultUsername() || '必填'}）: `)).trim();
  if (!username) username = defaultUsername();
  if (!username) {
    log('用户名不能为空（数据仓账号名，git 认证会忽略用户名但挑战-应答需要它）');
    return 2;
  }
  const token = (await muted('个人凭据（输入不回显）: ')).trim();
  if (!token) {
    log('未输入凭据 —— 已取消（未写入任何配置）');
    return 1;
  }
  return saveCredentials(url, username, token, out, deps);
}

const USAGE_HINT = [
  '用法: ctxi auth                      交互式配置数据仓凭据（推荐）',
  '      ctxi auth --status             查看已配置远端（凭据脱敏）',
  '      ctxi auth --clear [url]        清除指定远端凭据（缺省全部）',
  '      ctxi auth --remote <url> --username <u> --token <t>   非交互配置',
].join('\n');

export function authCommand(): Command {
  const cmd = new Command('auth');
  cmd.description('配置数据仓推送凭据（与 Web 设置页共享同一份存储）');
  cmd.option('--status', '查看已配置远端（凭据脱敏）');
  cmd.option('--clear', '清除指定远端凭据（缺省全部）');
  cmd.option('--remote <url>', '非交互配置：远端地址');
  cmd.option('--username <name>', '非交互配置：用户名');
  cmd.option('--token <secret>', '非交互配置：凭据');
  cmd.argument('[url]', '--clear 的目标远端地址');
  cmd.action(async (url: string | undefined, options: AuthOptions) => {
    const code = await runAuthAction({ ...options, url }, {});
    if (code === 2) console.log(formatWarning(USAGE_HINT));
    else if (code === 0 && !options.status && !options.clear) console.log(formatSuccess('✓ 配置完成'));
    process.exitCode = code;
  });
  return cmd;
}
