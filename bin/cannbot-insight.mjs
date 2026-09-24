#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// CANNBot-Insight 全局启动器（npm install -g / npx 入口）。
// 无参数 → 启动 Web UI（首次自动 build + migrate，后续直接 start）。
// 子命令 → 透传给 CLI（tsx 运行 src/cli/index.ts）。

import { spawn, spawnSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isTcpFree, isHttpHealthy, isSmartAgent, findFreePort } from './ports.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PKG_DIR = path.resolve(__dirname, '..')
const require = createRequire(PKG_DIR + '/')

const DATA_DIR = process.env.CANNBOT_INSIGHT_HOME || path.join(homedir(), '.cannbot-insight')
const BASE_PORT = Number.parseInt(process.env.CANNBOT_INSIGHT_PORT || '21025', 10)

const CLI_COMMANDS = new Set([
  'tui', 'sessions', 'session', 'stats', 'compare', 'search', 'turn',
  'import', 'delete', 'config', 'analyze', 'export', 'export-md', 'upload',
  'help', '--help', '-h', '--version', '-V', '-v',
])

const args = process.argv.slice(2)
const log = (msg) => process.stdout.write(`[cbi] ${msg}\n`)
const warn = (msg) => process.stderr.write(`[cbi] ${msg}\n`)

// ─── 1. CLI 子命令透传 ──────────────────────────────────────────
if (args[0] && CLI_COMMANDS.has(args[0])) {
  log(`CLI: ${args.join(' ')}`)
  // 优先 dist/cli.mjs（prepack 时的 esbuild 单文件产物）；
  // tsx 回退仅用于仓内开发态 —— npm 全局安装位置在 node_modules 内，
  // tsx 对 node_modules 内文件禁用 tsconfig paths，`@/` 别名会 ERR_MODULE_NOT_FOUND。
  const cliBundle = path.join(PKG_DIR, 'dist', 'cli.mjs')
  const cliArgv = existsSync(cliBundle)
    ? [cliBundle, ...args]
    : ['--import', 'tsx', 'src/cli/index.ts', ...args]
  const child = spawn(process.execPath, cliArgv, {
    cwd: PKG_DIR,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || `file:${path.join(DATA_DIR, 'insight.db')}` },
  })
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  startWebUi(args).catch((e) => { console.error(e); process.exit(1) })
}

// ─── 2. Web UI 启动器 ───────────────────────────────────────────
async function startWebUi(rawArgs) {
  const { advanced, killExisting, fresh } = parseFlags(rawArgs)

  // Node 版本检查（>= 20，与 start.sh 一致；v18.19.x 装不动 better-sqlite3 / Prisma 6）
  const major = Number.parseInt(process.versions.node.split('.')[0], 10)
  if (major < 20) {
    console.error(`[cbi] Node.js ${process.versions.node} 不支持，需 >= 20.0.0（v18.19.x 无法安装 better-sqlite3 / Prisma 6）。`)
    console.error('[cbi] 用 nvm: nvm install 20 && nvm use 20；或 https://nodejs.org 直接装。')
    process.exit(1)
  }

  // 数据目录：所有可写状态集中到 ~/.cannbot-insight/，全局包目录保持只读
  mkdirSync(DATA_DIR, { recursive: true })
  const dbPath = path.join(DATA_DIR, 'insight.db')
  const distDir = path.join(DATA_DIR, '.next')
  process.env.DATABASE_URL = `file:${dbPath}`
  process.env.CANNBOT_INSIGHT_DIST_DIR = distDir
  process.env.NEXT_PUBLIC_SHOW_ADVANCED_TABS = advanced ? 'true' : 'false'

  log(`Node ${process.versions.node} ✓`)
  log(`数据目录: ${DATA_DIR}`)

  // better-sqlite3 native ABI 守卫：Node 版本切换后旧 .node 会 self-register 失败
  ensureNative()

  // Prisma client 生成（postinstall 已做，兜底：若被清理或离线装失败）
  ensurePrismaClient()

  // 应用 migrations（首次建库 + 后续增量）
  log('应用 Prisma migrations...')
  runPrisma(['migrate', 'deploy'])

  // 首次启动 build（产物落 DATA_DIR/.next，包目录只读）
  if (fresh) {
    log('-f: 清理旧 build...')
    rmSync(distDir, { recursive: true, force: true })
  }
  if (!existsSync(path.join(distDir, 'BUILD_ID'))) {
    log('首次启动：构建 Next.js 产物（约 30s-2min，仅首次）...')
    runNext(['build'])
    log('构建完成 ✓')
  }

  // export-view bundle 兜底（postinstall 已预构建，缺失则补）
  const exportView = path.join(PKG_DIR, 'public', 'export-view.js')
  if (!existsSync(exportView)) {
    warn('export-view bundle 缺失，重新构建...')
    try {
      execSync('node scripts/build-export-view.mjs', { cwd: PKG_DIR, stdio: 'inherit' })
    } catch {
      warn('export-view 构建失败 —— HTML 导出功能不可用，其余功能正常')
    }
  }

  // 端口探测
  const port = killExisting ? BASE_PORT : await findFreePort(BASE_PORT)
  if (port == null) { console.error('[cbi] 无可用端口'); process.exit(1) }
  log(`端口: ${port}`)

  // smart-agent 可选：检测到 python3 + server.py 才启动，缺失静默降级；
  // 端口必须避让 next 实占端口（见 maybeStartSmartAgent）
  const agent = await maybeStartSmartAgent(port)

  // 启动 next start
  log('启动 CANNBot-Insight...')
  const nextProc = spawn(process.execPath, [nextBin(), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: PKG_DIR,
    stdio: 'inherit',
    env: { ...process.env, CANNBOT_INSIGHT_DIST_DIR: distDir },
  })

  // 等待 ready + 开浏览器
  await waitForReady(port)
  openBrowser(port)

  // 信号清理：退出时带走 smart-agent + next
  const cleanup = () => {
    if (agent?.pid && !agent.killed) {
      try { process.kill(-agent.pid, 'SIGTERM') } catch { try { process.kill(agent.pid, 'SIGTERM') } catch {} }
    }
    if (!nextProc.killed) { try { nextProc.kill('SIGTERM') } catch {} }
  }
  process.on('SIGINT', () => { cleanup(); process.exit(0) })
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  nextProc.on('exit', (code) => { cleanup(); process.exit(code ?? 0) })
}

// ─── helpers ────────────────────────────────────────────────────
function parseFlags(rawArgs) {
  const advanced = rawArgs.includes('-a') || rawArgs.includes('--advanced')
  const killExisting = rawArgs.includes('-k') || rawArgs.includes('--kill')
  const fresh = rawArgs.includes('-f') || rawArgs.includes('--fresh')
  return { advanced, killExisting, fresh }
}

function nextBin() {
  return require.resolve('next/dist/bin/next', { paths: [PKG_DIR] })
}

function prismaBin() {
  return require.resolve('prisma/build/index.js', { paths: [PKG_DIR] })
}

function runNext(nextArgs) {
  const r = spawnSync(process.execPath, [nextBin(), ...nextArgs], { cwd: PKG_DIR, stdio: 'inherit', env: process.env })
  if (r.status !== 0) { console.error('[cbi] next 命令失败'); process.exit(r.status ?? 1) }
}

function runPrisma(prismaArgs) {
  const r = spawnSync(process.execPath, [prismaBin(), ...prismaArgs], {
    cwd: PKG_DIR,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  })
  if (r.status !== 0) { console.error('[cbi] prisma 命令失败'); process.exit(r.status ?? 1) }
}

function ensureNative() {
  try {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.prepare('select 1 as x').get()
    db.close()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/NODE_MODULE_VERSION|did not self-register|was compiled against a different Node\.js version/i.test(msg)) {
      warn('better-sqlite3 二进制与 Node ABI 不匹配，rebuild...')
      try { execSync('npm rebuild better-sqlite3', { cwd: PKG_DIR, stdio: 'inherit' }) }
      catch { console.error('[cbi] better-sqlite3 rebuild 失败'); process.exit(1) }
    } else {
      console.error('[cbi] better-sqlite3 加载失败:', msg)
      process.exit(1)
    }
  }
}

function ensurePrismaClient() {
  try {
    require('@prisma/client')
  } catch {
    log('@prisma/client 未生成，运行 prisma generate...')
    runPrisma(['generate'])
  }
}

// smart-agent 端口候选区间：BASE+1 起 3 个。必须避开 next 实占端口——
// BASE 被占时 next 会滚到 BASE+1，若 smart-agent 仍钉 BASE+1 且先 spawn，
// python 抢先绑定 → next start EADDRINUSE 崩溃（客户实测 21026）。
const agentPortCandidates = (nextPort) => {
  const out = []
  for (let p = BASE_PORT + 1; p < BASE_PORT + 4; p++) if (p !== nextPort) out.push(p)
  return out
}

async function maybeStartSmartAgent(nextPort) {
  const serverPy = path.join(PKG_DIR, 'smart-agent', 'server.py')
  if (!existsSync(serverPy)) return null

  // ① 已有存活的 smart-agent（上次运行遗留）→ 直接复用，不重复 spawn。
  // 正身判定：/health 响应体须带 cannbot-smart-agent 服务标识——通用 /health
  // 服务（Actuator、dev server 等）绝不复用，否则 CANNBOT_AGENT_URL 指向
  // 陌生后端，audit v2/v3/v4 分析调用打错服务
  for (const p of agentPortCandidates(nextPort)) {
    if (await isSmartAgent(p)) {
      log(`smart-agent 已在运行 (port ${p})，复用`)
      process.env.CANNBOT_AGENT_URL = `http://localhost:${p}`
      return null
    }
  }

  let pythonBin = null
  for (const c of ['python3', 'python']) {
    try { execSync(`command -v ${c}`, { stdio: 'pipe' }); pythonBin = c; break } catch {}
  }
  if (!pythonBin) { warn('未检测到 python3 —— smart-agent 后端跳过（audit v2/v3/v4 分析功能降级）'); return null }

  // ② 找空闲端口起一个（避让 next 实占端口）
  let agentPort = null
  for (const p of agentPortCandidates(nextPort)) {
    if (await isTcpFree(p)) { agentPort = p; break }
  }
  if (agentPort == null) {
    warn(`smart-agent 端口 ${BASE_PORT + 1}-${BASE_PORT + 3} 均被占用（已避让 next 的 ${nextPort}），跳过`)
    return null
  }
  log(`检测到 ${pythonBin}，启动 smart-agent (port ${agentPort})...`)
  const child = spawn(pythonBin, ['server.py'], {
    cwd: path.join(PKG_DIR, 'smart-agent'),
    detached: true,
    env: { ...process.env, CANNBOT_AGENT_PORT: String(agentPort) },
    stdio: 'ignore',
  })
  child.unref()
  // 健康检查（最多 5s，内置 fetch 无 curl 依赖；校验服务标识，锁 /health 契约）
  for (let i = 0; i < 10; i++) {
    if (await isSmartAgent(agentPort)) {
      log('smart-agent ready ✓')
      process.env.CANNBOT_AGENT_URL = `http://localhost:${agentPort}`
      return child
    }
    await sleep(500)
  }
  warn('smart-agent 5s 内未就绪，跳过（后端仍可用）')
  return child
}

function waitForReady(port) {
  return new Promise((resolve) => {
    let tries = 0
    const tick = async () => {
      tries++
      if (await isHttpHealthy(port, '/', 2000)) {
        log(`服务就绪 (port ${port})`)
        resolve()
      } else if (tries > 60) {
        warn('服务 60s 内未就绪，不再等待')
        resolve()
      } else {
        setTimeout(tick, 1000)
      }
    }
    tick()
  })
}

function openBrowser(port) {
  // 测试环境熔断：vitest 子进程继承 VITEST env；显式 kill-switch 优先
  // （与 cpx openBrowser 同款纪律——PATH 桩对 cmd.exe 绝对路径分支无效）
  if (process.env.CANNBOT_NO_BROWSER || process.env.VITEST) return
  const url = `http://localhost:${port}`
  const isWin = platform() === 'win32'
  const isMac = platform() === 'darwin'
  const isWsl = isWin === false && existsSync('/proc/version') && readProcVersion().includes('microsoft')
  try {
    if (isWsl && existsSync('/mnt/c/Windows/System32/cmd.exe')) {
      spawn('/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (isMac) {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else if (isWin) {
      spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.env.DISPLAY) {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      log(`无图形会话（远程/无头 VM）—— 已端口转发则在浏览器打开 ${url}，或 ssh -L ${port}:localhost:${port}`)
    }
  } catch { /* 开浏览器失败不影响服务 */ }
}

function readProcVersion() {
  try { return readFileSync('/proc/version', 'utf8') } catch { return '' }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
