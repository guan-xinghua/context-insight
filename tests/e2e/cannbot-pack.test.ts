// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbot 品牌变体发布链路 IT：pack-cannbot.mjs 打包 → 解包 → 品牌切换断言 +
// 格式契约保留断言 + 品牌泄漏哨兵（源码品牌字面量漂移会让打包期 minHits 先炸，
// 这里兜底扫产物，双保险）。源码仓即 context 主体，变体只翻品牌面。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../../src/lib/version'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TGZ = path.join(PKG_DIR, '.cannbot-pack', `cannbot-insight-${VERSION}.tgz`)

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.mdx', '.py',
  '.css', '.scss', '.html', '.txt', '.sh', '.yml', '.yaml', '.sql',
  '.prisma', '.xml', '.svg', '.example',
])

let extracted = ''
let tmpRoot = ''

function read(rel: string): string {
  return fs.readFileSync(path.join(extracted, rel), 'utf8')
}

// needle：context 主品牌字面量，cannbot 变体产物里禁止出现（品牌泄漏）。
// 注意裸小写 "context-insight" 不在列——它是 BRAND_SOURCE_TYPE 数据格式契约，
// 变体刻意保留（两品牌数据互通）。
const FORBIDDEN: string[] = [
  'Context-Insight',
  'contextBay',
  '[ctxi]',
  'ctxi',
  '.context-insight',
  'CONTEXT_',
  'context-cpx',
  'context-smart-agent',
  'context-mate-agent',
]

function scanForbidden(root: string, forbidden: string[]): string[] {
  const leaks: string[] = []
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules') continue
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) { walk(full); continue }
      if (!TEXT_EXTS.has(path.extname(name))) continue
      const text = fs.readFileSync(full, 'utf8')
      for (const bad of forbidden) {
        if (text.includes(bad)) leaks.push(`${path.relative(root, full)}: ${bad}`)
      }
    }
  }
  walk(root)
  return leaks
}

describe('cannbot 品牌变体打包（pack-cannbot.mjs）', () => {
  beforeAll(() => {
    const r = spawnSync(process.execPath, ['scripts/pack-cannbot.mjs'], {
      cwd: PKG_DIR, encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
    })
    expect(r.status, `pack-cannbot.mjs 失败:\n${r.stderr}`).toBe(0)
    expect(fs.existsSync(TGZ), `产物缺失: ${TGZ}`).toBe(true)

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cbot-insight-'))
    const t = spawnSync('tar', ['-xzf', TGZ, '-C', tmpRoot], { encoding: 'utf8', timeout: 60_000 })
    expect(t.status, t.stderr).toBe(0)
    extracted = path.join(tmpRoot, 'package')
  }, 300_000)

  afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* tmp 目录留置无害 */ }
  })

  it('package.json：包名 / bin / 版本与主包同源', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.name).toBe('cannbot-insight')
    expect(pkg.bin).toEqual({
      'cannbot-insight': './bin/cannbot-insight.mjs',
      cbi: './bin/cannbot-insight.mjs',
    })
    expect(pkg.version).toBe(VERSION)
    expect(pkg.private).toBeUndefined()
  })

  it('CLI bundle 实跑：--version 输出 CANNBot-Insight 品牌串', () => {
    fs.symlinkSync(path.join(PKG_DIR, 'node_modules'), path.join(extracted, 'node_modules'), 'dir')
    const r = spawnSync(process.execPath, ['dist/cli.mjs', '--version'], {
      cwd: extracted, encoding: 'utf8', timeout: 60_000,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(`CANNBot-Insight v${VERSION}`)
  })

  it('品牌泄漏哨兵：显示名 / Bay 名 / 别名 / 数据目录 / env 前缀 / 服务标识零残留', () => {
    const leaks = scanForbidden(extracted, FORBIDDEN)
    expect(leaks, `品牌泄漏:\n${leaks.join('\n')}`).toEqual([])
  })

  it('格式契约保留：source type / x_lake 命名空间 / env·目录·服务标识品牌还原', () => {
    // 数据格式契约：两品牌数据互通靠它们，变体不翻
    expect(read('src/lib/branding.ts')).toContain('BRAND_SOURCE_TYPE = "context-insight"')
    expect(read('src/lib/shared/envelope.ts')).toContain('x_lake')
    // 品牌面还原：老用户的目录 / env / 服务标识习惯延续
    expect(read('bin/cannbot-insight.mjs')).toContain("'.cannbot-insight'")
    expect(read('bin/cannbot-insight.mjs')).toContain('CANNBOT_INSIGHT_HOME')
    expect(read('smart-agent/server.py')).toContain('cannbot-smart-agent')
  })
})
