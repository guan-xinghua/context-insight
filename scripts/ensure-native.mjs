// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS PROGRAM IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Pre-test guard: detect stale or missing native addons and rebuild them
// automatically. Without this, a `node` bump silently breaks every test that
// touches better-sqlite3 — they fail with "Module did not self-register" /
// "NODE_MODULE_VERSION mismatch", which is hard to diagnose from the test
// output. A missing binary ("Could not locate the bindings file") hits fresh
// installs too: npm ≥12 blocks dependency install scripts unless allowlisted,
// so the build step never runs. Run via the `pretest` hook.
//
// Fast path (binary fresh): one smoke-test load per module, ~tens of ms.
// Slow path (binary stale/missing): `npm rebuild <mod>`, then re-probe in a
// CHILD process — a failed import stays cached in this one, and npm ≥12
// let `npm rebuild` exit 0 without running any build script, which used to
// fool a build/-directory existence check into skipping the real fix.
// Still broken → run the module's own build step directly.

import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// Exported for tests/ensure-native-smoke.test.ts（进程内 import 不触发下方守卫循环）
export const NATIVES = [
  {
    name: 'better-sqlite3',
    // smoke test: open an in-memory db, run a trivial query, close.
    probe: async (mod) => {
      const Database = mod.default ?? mod;
      const db = new Database(':memory:');
      db.prepare('select 1 as x').get();
      db.close();
    },
    // Same smoke as child-process source. Keep the two in sync: rebuild
    // verification must run outside this process (module cache), while the
    // fast path avoids paying for a process spawn per module.
    childSmoke: (name) => `import(${JSON.stringify(name)}).then((mod) => {
      const Database = mod.default ?? mod;
      const db = new Database(':memory:');
      db.prepare('select 1 as x').get();
      db.close();
    });`,
  },
];

const STALE = /NODE_MODULE_VERSION|did not self-register|was compiled against a different Node\.js version|Could not locate the bindings file/i;

// engines 预检判定：semver 是传递依赖（npm 生态几乎必在），走 satisfies
// 全区间判定；被 dedupe 掉时退化为保守的数值比较（见 catch 内）。
function nodeSatisfies(version, range) {
  try {
    return require('semver').satisfies(version, range, { includePrerelease: true });
  } catch {
    // 无 semver 时的保守判定：带 || 并集（低版本可能合法）或无 >= 下限的
    // 区间一律放行——预检只拦「必崩」，不拦「可能合法」，误报会把能跑的
    // 环境挡在门外。
    if (range.includes('||')) return true;
    const floors = [...range.matchAll(/>=\s*(\d+(?:\.\d+){0,2})/g)].map(m => m[1].split('.').map(Number));
    if (floors.length === 0) return true;
    const cur = version.replace(/^v/, '').split('.').map(Number);
    const below = floors.some(f => {
      for (let i = 0; i < f.length; i++) {
        if ((cur[i] ?? 0) !== f[i]) return (cur[i] ?? 0) < f[i];
      }
      return false;
    });
    return !below;
  }
}

// 子进程复探：带回 stderr——最终失败瞬间恰恰最需要真实原因（仍是 ABI 不匹配？
// prebuild-install 按 PATH 里的 node 下错了 ABI？还是引入了新错误），布尔返回
// 会把它丢掉（spawnSync 默认 stdio pipe 不透传终端）。
export function smokeProbe(native) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', native.childSmoke(native.name)]);
  return { ok: r.status === 0, err: (r.stderr ?? '').toString() };
}

function rebuild(native) {
  execSync(`npm rebuild ${native.name}`, { stdio: 'inherit' });
  if (smokeProbe(native).ok) return;
  // npm rebuild exited 0 but the binary still fails to load: scripts were
  // blocked (npm ≥12 allowScripts), or a partial build dir / stale-ABI
  // binary survived. Run the module's own build step directly — the policy
  // does not intercept it. prebuild-install goes by hoisted path, not npx:
  // npx's local prefix stops at the dep's own package.json.
  const pkgDir = path.dirname(require.resolve(`${native.name}/package.json`));
  try {
    execSync('../.bin/prebuild-install || npx -y node-gyp rebuild', {
      cwd: pkgDir,
      stdio: 'inherit',
    });
  } catch (e) {
    console.error(`[ensure-native] ${native.name}: direct build failed — no network or missing toolchain.`);
    console.error('  prebuild-install needs registry access; node-gyp needs python3, make, g++ (plus network on first run).');
    console.error(`  Alternatively allow the install script: npm install-scripts approve ${native.name} (npm ≥12), then reinstall.`);
    throw e;
  }
  const probe = smokeProbe(native);
  if (!probe.ok) {
    console.error(`[ensure-native] ${native.name}: binary still fails to load after rebuild. Child-process diagnostics:`);
    console.error(probe.err || '(child exited nonzero with no stderr)');
    process.exit(1);
  }
}

// 守卫循环只在被直接执行时运行（node scripts/ensure-native.mjs，pretest 固定
// cwd=包目录——裸导入按 cwd 解析的前提）；测试 import 本模块取
// NATIVES/smokeProbe 时跳过。
const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsScript) {
  // 版本门槛前移到 import 之前：engines 不满足的原生模块（N-API 稳定 ABI，
  // 加载不抛错）常在构造时直接 SIGSEGV——守卫循环靠捕获异常触发自愈，对段
  // 错误无效，自己先崩。npm 装依赖时只警告（EBADENGINE）不拦截（未开
  // engine-strict 的机器），这里是运行路径上的最后一道人话报错。
  for (const native of NATIVES) {
    let pkg;
    try {
      pkg = require(`${native.name}/package.json`);
    } catch {
      continue; // 模块本体缺失/损坏交回下方守卫循环的结构化报错处理
    }
    const need = pkg.engines?.node;
    if (need && !nodeSatisfies(process.version, need)) {
      console.error(`[ensure-native] ${native.name}@${pkg.version} 要求 node ${need}，当前 ${process.version} —— 不满足，原生模块可能加载/构造即崩（SIGSEGV）`);
      console.error('[ensure-native] 请切换 Node 后重跑（如 nvm use 22），或降级依赖至支持当前版本的分段');
      process.exit(1);
    }
  }

  let rebuilt = false;
  for (const native of NATIVES) {
    try {
      const mod = await import(native.name);
      await native.probe(mod);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (STALE.test(msg)) {
        console.warn(`[ensure-native] ${native.name} binary is stale or missing, rebuilding...`);
        rebuild(native);
        rebuilt = true;
      } else {
        // A real bug (not an ABI mismatch) — surface it, don't hide.
        console.error(`[ensure-native] ${native.name} failed to load for an unexpected reason:`);
        console.error(e);
        process.exit(1);
      }
    }
  }

  if (rebuilt) {
    console.warn('[ensure-native] native addon(s) rebuilt. The test process will load the fresh binary.');
  }
}
