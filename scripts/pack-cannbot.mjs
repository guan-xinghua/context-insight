// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbot 品牌变体打包（npm pack）—— 源码仓即 context 主体，本脚本在打包期把
// 品牌面翻转回 cannbot（延续老用户的包名/目录/env 习惯）：
//   node scripts/pack-cannbot.mjs  →  .cannbot-pack/cannbot-insight-<version>.tgz
//   发布：npm publish .cannbot-pack/cannbot-insight-<version>.tgz
//
// 机制：单源码仓 + 打包期变换 —— `npm pack --dry-run` 取本包真实清单，复制到
// staging 后做精确字面量替换（规则表见下），staging 内 `npm pack`（prepack 的
// build-cli.mjs 在 staging 跑，产出品牌变换后的 dist/cli.mjs）。源码仓零改动。
//
// 品牌边界（与 context-insight 主包同内容、仅品牌面不同）：
//   翻转 —— 显示名 / CLI 别名 / bin 文件名 / 数据目录（~/.cannbot-insight）/
//           Bay 显示名（branding.ts 常量）/ 环境变量前缀（CONTEXT_* → CANNBOT_*）/
//           smart-agent 服务标识 / mate-agent 临时目录 / 导出文件前缀（cannbot_session_）/
//           lake git 机器提交身份
//   保留 —— 数据格式标识（BRAND_SOURCE_TYPE="context-insight"，两品牌数据互通）/
//           x_lake 命名空间 / cc-* schema 名 / LAKE_* 环境变量名
//
// 数据目录迁移垫片自洽性：bin 启动器与 cpx writer 的首启迁移逻辑在变体里天然
// no-op——新目录字面量被打包翻转回 ~/.cannbot-insight，与旧目录等路径，垫片内
// 的等路径守卫直接返回，cannbot 老用户目录原地不动、无需迁移。
//
// 每条规则带 minHits（防漂移哨兵）：源码重构后若必命中的规则命中 0 次，打包报错，
// 提示同步更新规则表。tests/e2e/cannbot-pack.test.ts 对产物做品牌泄漏扫描。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STAGING = path.join(PKG_DIR, '.cannbot-pack', 'pkg')
const OUT_DIR = path.join(PKG_DIR, '.cannbot-pack')

// 文件重命名（bin 启动器随包名改名；package.json bin 值在结构化改写中同步）
const RENAMES = new Map([['bin/context-insight.mjs', 'bin/cannbot-insight.mjs']])

// 不进 cannbot 变体包：打包脚本自身（规则串自引用，会误触品牌泄漏哨兵）
const EXCLUDE = new Set(['scripts/pack-cannbot.mjs'])

// 通用规则（全部文本文件；精确字符串替换，非正则）
const GLOBAL_RULES = [
  { find: 'Context-Insight', replace: 'CANNBot-Insight', minHits: 1 },
  { find: '"contextBay"', replace: '"CANNbay"', minHits: 1 },
  { find: '"contextBay Viewer"', replace: '"CANNBay Viewer"', minHits: 1 },
  // 数据目录三种形态全覆盖：单引号字面量（TS 源码）/ ~ 波浪线（文档示例）/
  // 斜杠嵌入（bash 的 $HOME/.context-insight/...——引号规则够不到，漏翻=品牌泄漏哨兵红）
  { find: "'.context-insight'", replace: "'.cannbot-insight'", minHits: 2 },
  { find: '~/.context-insight', replace: '~/.cannbot-insight', minHits: 2 },
  // shell 里 ~ 不在引号内展开，运行时只能 $HOME 拼路径（start.sh slog 的日志
  // 目录）——与上一条同属数据目录翻转面，漏了会把 cannbot 变体的日志写进
  // context 的家目录并击穿泄漏哨兵
  { find: '$HOME/.context-insight', replace: '$HOME/.cannbot-insight', minHits: 1 },
  // 宽形态兜底：$HOME / ~ 规则之后残留的斜杠嵌入（当前 0 命中，防未来形态漂移）
  { find: '/.context-insight', replace: '/.cannbot-insight', minHits: 0 },
  { find: '[ctxi]', replace: '[cbi]', minHits: 2 },
  { find: '"ctxi"', replace: '"cbi"', minHits: 1 },
  // 宽形态兜底：md 文档反引号/表格与 src CLI 用法文案里的裸别名（`ctxi --stop`、
  // 'ctxi auth' 等）——上面两条方括号/引号形态够不到，漏翻=变体用户拿到错误
  // 指令（变体 bin 只注册 cannbot-insight/cbi），泄漏哨兵按裸词兜底
  { find: 'ctxi', replace: 'cbi', minHits: 20 },
  { find: 'context-insight.mjs', replace: 'cannbot-insight.mjs', minHits: 2 },
  { find: '[context-insight postinstall]', replace: '[cannbot-insight postinstall]', minHits: 1 },
  // 环境变量前缀还原：cannbot 老用户的部署脚本 / systemd 单元继续读 CANNBOT_* 生效
  { find: 'CONTEXT_', replace: 'CANNBOT_', minHits: 5 },
  // smart-agent 服务标识还原（启动器 isSmartAgent 契约随包内五点同源翻转，自洽）
  { find: 'context-smart-agent', replace: 'cannbot-smart-agent', minHits: 2 },
  { find: 'context-mate-agent', replace: 'cannbot-mate-agent', minHits: 1 },
  // 导出文件名前缀还原（用户可见文件名属品牌面；导入侧另有内容级探测兜底）
  { find: 'context_session_', replace: 'cannbot_session_', minHits: 2 },
  // lake git 机器提交身份还原（数据仓内 author 显示名与 cannbot 时代连续）
  { find: 'user.name=context-insight', replace: 'user.name=cannbot-insight', minHits: 2 },
]

// 文档规则（*.md：README / docs / prompts —— 面向 cannbot 包用户，包名与按钮名全部翻转；
// 长串规则已在通用层先跑，这里翻剩余的无点小写包名）
const MD_RULES = [
  { find: 'context-cpx', replace: 'cannbot-proxy', minHits: 0 },
  { find: 'context-insight', replace: 'cannbot-insight', minHits: 1 },
  { find: 'contextBay', replace: 'CANNbay', minHits: 0 },
]

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.mdx', '.py',
  '.css', '.scss', '.html', '.txt', '.sh', '.yml', '.yaml', '.sql',
  '.prisma', '.xml', '.svg', '.example',
])

function rewritePkgJson(pkg) {
  pkg.name = 'cannbot-insight'
  pkg.description = 'Session-level observability tool for LLM coding agents (opencode/Claude Code)'
  pkg.bin = { 'cannbot-insight': './bin/cannbot-insight.mjs', cbi: './bin/cannbot-insight.mjs' }
  pkg.keywords = [
    'cannbot-insight', 'cannbot-proxy', 'llm', 'agent', 'observability',
    'session', 'opencode', 'claude-code', 'tokens', 'timeline',
  ]
  return pkg
}

function packFileList() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_DIR, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`npm pack --dry-run 失败:\n${r.stderr}`)
  const parsed = JSON.parse(r.stdout)
  // npm ≥12 输出为按包名键的对象，旧版是数组（与 build-cli.mjs 同款归一化）
  const entry = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
  return entry.files.map((f) => f.path)
}

function copyTree(files) {
  fs.rmSync(path.join(PKG_DIR, '.cannbot-pack'), { recursive: true, force: true })
  fs.mkdirSync(STAGING, { recursive: true })
  for (const rel of files) {
    if (EXCLUDE.has(rel)) continue
    // 防御：上次运行的 .cannbot-pack 产物若混入清单（如 .npmignore 缺失时），
    // rm -rf 后源已不存在，复制必 ENOENT —— 一律跳过
    if (rel === '.cannbot-pack' || rel.startsWith('.cannbot-pack/')) continue
    const src = path.join(PKG_DIR, rel)
    const dst = path.join(STAGING, RENAMES.get(rel) ?? rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

function transformTree() {
  const hits = new Map()
  for (const rule of [...GLOBAL_RULES, ...MD_RULES]) hits.set(rule.find, 0)
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) { walk(full); continue }
      const rel = path.relative(STAGING, full)
      if (rel === 'package.json') continue
      if (!TEXT_EXTS.has(path.extname(name))) continue
      let text = fs.readFileSync(full, 'utf8')
      const rules = path.extname(name) === '.md' ? [...GLOBAL_RULES, ...MD_RULES] : GLOBAL_RULES
      for (const rule of rules) {
        const n = text.split(rule.find).length - 1
        if (n > 0) { text = text.split(rule.find).join(rule.replace); hits.set(rule.find, hits.get(rule.find) + n) }
      }
      if (text !== fs.readFileSync(full, 'utf8')) fs.writeFileSync(full, text)
    }
  }
  walk(STAGING)

  const pkgPath = path.join(STAGING, 'package.json')
  const pkg = rewritePkgJson(JSON.parse(fs.readFileSync(pkgPath, 'utf8')))
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  for (const rule of [...GLOBAL_RULES, ...MD_RULES]) {
    if ((hits.get(rule.find) ?? 0) < rule.minHits) {
      throw new Error(
        `规则 "${rule.find}" 命中 ${hits.get(rule.find) ?? 0} 次 < 最低 ${rule.minHits} —— ` +
        '源码品牌字面量可能已漂移，请核对 scripts/pack-cannbot.mjs 规则表',
      )
    }
  }
  return hits
}

function main() {
  const files = packFileList()
  copyTree(files)
  const hits = transformTree()

  // prepack（build-cli.mjs）需要 esbuild 等 devDeps —— symlink 复用包根 node_modules；
  // npm pack 内建忽略 node_modules，不会进 tgz。
  fs.symlinkSync(path.join(PKG_DIR, 'node_modules'), path.join(STAGING, 'node_modules'), 'dir')

  const r = spawnSync('npm', ['pack', '--json', '--pack-destination', OUT_DIR], {
    cwd: STAGING, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`staging npm pack 失败:\n${r.stderr}`)
  // npm ≥12 输出为按包名键的对象，旧版是数组（与上方 packFileList 同款归一化）
  const packed = JSON.parse(r.stdout)
  const tgzName = (Array.isArray(packed) ? packed[0] : packed[Object.keys(packed)[0]]).filename

  console.log(`[pack-cannbot] 规则命中统计：`)
  for (const [find, n] of hits) if (n > 0) console.log(`  ${n}×  ${find}`)
  console.log(`[pack-cannbot] 产物：${path.join(OUT_DIR, tgzName)}`)
  console.log(`[pack-cannbot] 发布：npm publish ${path.join(OUT_DIR, tgzName)}`)
}

main()
