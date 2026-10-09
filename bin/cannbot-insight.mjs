#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// CANNBot-Insight 全局启动器（npm install -g / npx 入口）。
// 无参数 → 启动 Web UI（首次自动 build + migrate，后续直接 start）；
//          端口固定 BASE_PORT，被占 fail-fast（多人服务器每人固定端口）。
// --stop → 停止自家实例（PID 文件 + 候选区间验明正身锚定，绝不盲杀）。
// 子命令 → 透传给 CLI（tsx 运行 src/cli/index.ts）。

import { spawn, spawnSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isTcpFree, isHttpHealthy, isSmartAgent, findPortOwnerPid } from './ports.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PKG_DIR = path.resolve(__dirname, '..')
const require = createRequire(PKG_DIR + '/')

const DATA_DIR = process.env.CANNBOT_INSIGHT_HOME || path.join(homedir(), '.cannbot-insight')
const BASE_PORT = Number.parseInt(process.env.CANNBOT_INSIGHT_PORT || '21025', 10)
// --stop/-k 的击杀锚定：每次启动记录自家全家福（launcher/next/agent 的 PID）。
// 崩溃（SIGKILL/断电）后残留进程仍记录在内 → 下次 --stop 可回收。
const PID_FILE = path.join(DATA_DIR, 'insight.pid')

// 发现契约登记文件（读侧：cpx src/cli/insight-discovery.ts 与本包 src/cli/config.ts，
// 解析链 env → 本文件 → 21025 兜底）。锚定与读侧严格一致：设了 CANNBOT_PROXY_DIR
// 登记随它走（与其父目录同源），否则随 DATA_DIR。持久保留、不随实例退出删除
// （删除会在实例未运行窗口期让 cpx 回落 21025，把捕获导进别人实例）。
function registryPath() {
  return process.env.CANNBOT_PROXY_DIR
    ? path.join(path.dirname(process.env.CANNBOT_PROXY_DIR), 'insight-port')
    : path.join(DATA_DIR, 'insight-port')
}

const CLI_COMMANDS = new Set([
  'tui', 'sessions', 'session', 'stats', 'compare', 'search', 'turn',
  'import', 'delete', 'config', 'analyze', 'export', 'export-md', 'upload',
  'help', '--help', '-h', '--version', '-V', '-v',
])

const args = process.argv.slice(2)
const log = (msg) => process.stdout.write(`[cbi] ${msg}\n`)
const warn = (msg) => process.stderr.write(`[cbi] ${msg}\n`)

// ─── 0. --stop / -k 击杀机制 ────────────────────────────────────
// （先于分发定义：dispatch 的同步段就会调到这里，放文件后部会 TDZ）
// 击杀锚定（多人服务器红线：绝不盲杀、绝不无差别 pkill）：
//   ① DATA_DIR/insight.pid —— 上次启动记录的自家全家福（launcher/next/agent）
//   ② smart-agent 候选区间验明正身的孤儿（旧版本启动器无 PID 文件时的兜底）
//   ③ BASE_PORT 仍被占 → 报错退出：那是别人的实例或无关进程，绝不代杀

// smart-agent 端口候选区间：BASE+1 起 3 个。历史教训：next 曾漂移到 BASE+1
// 与钉死 BASE+1 的 smart-agent 撞车 EADDRINUSE（客户实测 21026）——现在
// next 固定 BASE_PORT 不再漂移，避让保留为结构保险。
const agentPortCandidates = (nextPort) => {
  const out = []
  for (let p = BASE_PORT + 1; p < BASE_PORT + 4; p++) if (p !== nextPort) out.push(p)
  return out
}

async function stopExisting() {
  let hadPidFile = false
  if (existsSync(PID_FILE)) {
    hadPidFile = true
    try {
      const rec = JSON.parse(readFileSync(PID_FILE, 'utf8'))
      const entries = [
        { pid: rec.launcher, group: false },
        { pid: rec.next, group: false },
        ...(Array.isArray(rec.agents) ? rec.agents : []).map((pid) => ({ pid, group: true })),
      ].filter((e) => Number.isInteger(e.pid))
      await killPidList(entries, 'PID 记录')
    } catch { warn('PID 记录损坏，按无记录处理') }
  } else {
    log(`无 PID 记录（${PID_FILE}）—— 没有自家实例在跑`)
  }
  for (const p of agentPortCandidates(BASE_PORT)) {
    if (!(await isSmartAgent(p))) continue
    const pid = findPortOwnerPid(p)
    if (pid) {
      log(`清理候选区间孤儿 smart-agent (port ${p}, PID ${pid})`)
      await killPidList([{ pid, group: true }], '孤儿 smart-agent')
    } else {
      warn(`端口 ${p} 有验明正身的 smart-agent 但定位不到属主（可能是他人的）—— 避让`)
    }
  }
  if (!(await waitTcpFree(BASE_PORT, 10000))) {
    console.error(`[cbi] 端口 ${BASE_PORT} 仍被占用 —— PID 记录与候选区间里都没有它，不是自家实例；请确认属主后手动处理，不代杀。`)
    process.exit(1)
  }
  if (hadPidFile) rmSync(PID_FILE, { force: true })
  log(`端口 ${BASE_PORT} 空闲 ✓`)
}

const OUR_FAMILY = /next|server\.py|cannbot-insight|context-insight/

// PID 复用防御：只杀 /proc/<pid>/cmdline 形态对得上自家三种进程
// （launcher / next / smart-agent）的 PID。非 Linux 无 /proc → 放行（尽力而为）。
function pidMatchesOurFamily(pid) {
  if (pid === process.pid) return false
  try { return OUR_FAMILY.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')) } catch { return true }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// group=true 优先组杀（detached 的 smart-agent 是独立进程组组长），回退单杀
function signalPid({ pid, group }, sig) {
  if (group) { try { process.kill(-pid, sig); return } catch { /* 组不存在/无权限 */ } }
  try { process.kill(pid, sig) } catch { /* 已退出 */ }
}

// TERM → 3s 宽限 → KILL 升级（next-server 曾实测无视 SIGTERM，start.sh 同款路径）
// TERM → 3s 宽限 → KILL 升级（next-server 曾实测无视 SIGTERM，start.sh 同款路径）。
// entries 元素：number（单杀）或 { pid, group }（group=true 优先组杀，detached 的
// smart-agent 是独立进程组组长）。跳过存活但形态不符的 PID 时如实告警——
// 击杀锚定的诚实性比静默乐观重要（冒烟实测：假 agent 无形态标记被静默跳过）。
async function killPidList(entries, label) {
  const norm = entries.map((e) => (typeof e === 'number' ? { pid: e, group: false } : e))
  const alive = norm.filter((e) => Number.isInteger(e.pid) && pidMatchesOurFamily(e.pid) && isAlive(e.pid))
  for (const e of norm) {
    if (!Number.isInteger(e.pid)) { warn(`${label}: 非法 pid 记录 ${JSON.stringify(e)}，跳过`); continue }
    if (isAlive(e.pid) && !pidMatchesOurFamily(e.pid)) warn(`${label}: pid ${e.pid} 存活但 cmdline 形态不符（PID 复用？），跳过`)
  }
  if (alive.length === 0) return false
  log(`${label}: 停止 ${alive.map((e) => e.pid).join(', ')}...`)
  for (const e of alive) signalPid(e, 'SIGTERM')
  for (let i = 0; i < 30 && alive.some((e) => isAlive(e.pid)); i++) await sleep(100)
  const stubborn = alive.filter((e) => isAlive(e.pid))
  if (stubborn.length > 0) {
    log(`${label}: SIGTERM 未生效，SIGKILL ${stubborn.map((e) => e.pid).join(', ')}`)
    for (const e of stubborn) signalPid(e, 'SIGKILL')
    await sleep(200)
  }
  return true
}

async function waitTcpFree(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await isTcpFree(port)) return true
    await sleep(200)
  }
  return await isTcpFree(port)
}

// ─── 1. 命令分发：--stop / CLI 透传 / Web UI ────────────────────
if (args[0] === '--stop') {
  stopExisting().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
} else if (args[0] && CLI_COMMANDS.has(args[0])) {
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

  // Node 版本检查（>= 22.12，与 engines/ensure-native/start.sh 同门槛；
  // better-sqlite3@13 / commander@14 等依赖要求 Node ≥22，低版本原生模块
  // 加载/构造直接段错误）
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(n => Number.parseInt(n, 10))
  if (nodeMajor < 22 || (nodeMajor === 22 && (nodeMinor || 0) < 12)) {
    console.error(`[cbi] Node.js ${process.versions.node} 不支持，需 >= 22.12.0（better-sqlite3@13 等依赖要求 Node ≥22，低版本会段错误）。`)
    console.error('[cbi] 用 nvm: nvm install 22 && nvm use 22；或 https://nodejs.org 直接装。')
    process.exit(1)
  }

  // 数据目录：可写状态（库/登记/PID）集中到 ~/.cannbot-insight/。构建产物在包目录
  // .next——Next 16 Turbopack 强制 distDir 不许逃出项目根（外置 distDir 会被拼进
  // 包目录深处成垃圾路径且 BUILD_ID 探测永远落空 → 每次启动重建）；多人隔离靠
  // 每人各自的 npm 安装（包目录按用户隔离）。
  mkdirSync(DATA_DIR, { recursive: true })
  const dbPath = path.join(DATA_DIR, 'insight.db')
  const distDir = path.join(PKG_DIR, '.next')
  // 历史清理：旧版启动器曾把绝对 distDir 传给 Next，被拼成包目录深处的垃圾路径
  // （如 <PKG>/home/<user>/.cannbot-insight/.next），一次性回收
  const legacyJunk = path.join(PKG_DIR, DATA_DIR, '.next')
  if (legacyJunk !== distDir) rmSync(legacyJunk, { recursive: true, force: true })
  process.env.DATABASE_URL = `file:${dbPath}`
  process.env.NEXT_PUBLIC_SHOW_ADVANCED_TABS = advanced ? 'true' : 'false'

  log(`Node ${process.versions.node} ✓`)
  log(`数据目录: ${DATA_DIR}`)

  // 固定端口语义（多人服务器，与 start.sh 单实例收口对齐）：默认钉死 BASE_PORT，
  // 被占 fail-fast；-k 先杀自家旧实例再复用。绝不静默漂移——漂移断 cpx 端口
  // 登记发现与浏览器书签，且静默起第二个实例 = 同一 HOME 两套库、数据分叉
  // （历史默认行为最多漂移 +128，用户全程无感）。
  if (killExisting) await stopExisting()
  if (!(await isTcpFree(BASE_PORT))) {
    const healthy = await isHttpHealthy(BASE_PORT, '/', 1500)
    console.error(`[cbi] 端口 ${BASE_PORT} 被占用${healthy ? '（疑似另一个 insight 实例在运行）' : ''}。`)
    console.error('[cbi] 自家旧实例：加 --stop 参数先停掉（或 -k 杀旧重启）。')
    console.error('[cbi] 不是自家的，换自己的固定端口（多人每人固定、间隔 ≥5）：')
    console.error('[cbi]   export CANNBOT_INSIGHT_PORT=<你的端口>')
    process.exit(1)
  }
  const port = BASE_PORT
  log(`端口: ${port}`)

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

  // smart-agent 可选：检测到 python3 + server.py 才启动，缺失静默降级；
  // 恒 clean：候选区间验明正身的旧 agent 先回收再起全新的（见 startSmartAgentClean）
  const agent = await startSmartAgentClean(port)

  // 启动 next start
  log('启动 CANNBot-Insight...')
  const nextProc = spawn(process.execPath, [nextBin(), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: PKG_DIR,
    stdio: 'inherit',
    env: { ...process.env },
  })

  // PID 全家福落盘：--stop/-k 的击杀锚定（SIGKILL/断电后残留子进程仍可凭它回收）
  try {
    writeFileSync(PID_FILE, JSON.stringify({
      launcher: process.pid,
      next: nextProc.pid,
      agents: agent?.pid ? [agent.pid] : [],
      port,
      savedAt: new Date().toISOString(),
    }, null, 2) + '\n')
  } catch (e) { warn(`PID 记录写入失败（--stop 将退化到候选区间兜底）: ${e.message}`) }

  // 等待 ready → 端口登记 → 开浏览器
  await waitForReady(port)
  // 发现契约登记（读侧 cpx insight-discovery / cbi config；持久保留，不随退出删除）
  try { writeFileSync(registryPath(), `${port}\n`) } catch (e) { warn(`端口登记写入失败: ${e.message}`) }
  openBrowser(port)

  // 信号清理（随会话语义，与 start.sh 同拍板）：INT/TERM/HUP 任一路径带走
  // smart-agent + next，TERM→3s→KILL 升级（next-server 曾实测无视 SIGTERM）。
  // HUP = SSH 断开/终端关闭的内核信号——此前没挂，detached 的 smart-agent
  // 收不到任何清理信号，断连即残留（npm 形态多人零残留的病根）。
  let exiting = false
  const cleanup = async () => {
    if (exiting) return
    exiting = true
    await killPidList(agent?.pid ? [{ pid: agent.pid, group: true }] : [], 'smart-agent')
    if (!nextProc.killed) await killPidList([nextProc.pid], 'next')
  }
  process.on('SIGINT', () => { if (exiting) process.exit(0); cleanup().finally(() => process.exit(0)) })
  process.on('SIGTERM', () => { if (exiting) process.exit(0); cleanup().finally(() => process.exit(0)) })
  process.on('SIGHUP', () => { if (exiting) process.exit(0); cleanup().finally(() => process.exit(0)) })
  nextProc.on('exit', (code) => { cleanup().finally(() => process.exit(code ?? 0)) })
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

async function startSmartAgentClean(nextPort) {
  const serverPy = path.join(PKG_DIR, 'smart-agent', 'server.py')
  if (!existsSync(serverPy)) return null

  // ① 恒 clean（与 checkout 流 pick-smart-agent-port 同拍板）：候选区间内验明
  // 正身的旧 smart-agent 一律击杀回收、再起全新的——复用是残留泄漏的来源
  // （checkout 流实测 2026-09-21：keep 模式残留的 21026 python3 从上午活到
  // 晚间）。正身判定：/health 响应体须带 cannbot-smart-agent 服务标识——通用
  // /health 服务（Actuator、dev server 等）绝不击杀。属主定位走 /proc，
  // 他人进程天然定位不到 → 避让不越权。
  for (const p of agentPortCandidates(nextPort)) {
    if (!(await isSmartAgent(p))) continue
    const pid = findPortOwnerPid(p)
    if (pid) {
      log(`回收旧 smart-agent (port ${p}, PID ${pid})`)
      await killPidList([{ pid, group: true }], '旧 smart-agent')
    } else {
      warn(`端口 ${p} 有验明正身的 smart-agent 但定位不到属主（可能是他人的）—— 避让`)
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
