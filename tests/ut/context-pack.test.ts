// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// context 品牌变体发布链路 IT：pack-context.mjs 打包 → 解包 → 品牌切换断言 +
// 格式契约保留断言 + 品牌泄漏哨兵（源码品牌字面量漂移会让打包期 minHits 先炸，
// 这里兜底扫产物，双保险）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../../src/lib/version'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TGZ = path.join(PKG_DIR, '.context-pack', `context-insight-${VERSION}.tgz`)

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

// needle：禁止出现的品牌字面量；allow：先从文本中剥除的豁免串（如 v1 路由
// 硬编码的真实仓 URL——guanxinghua/CANNBay.git 是仓库名不是品牌显示，替换会断链）
const FORBIDDEN: Array<{ needle: string; allow?: string }> = [
  { needle: 'CANNBot-Insight' },
  { needle: 'CANNbay' },
  { needle: 'CANNBay', allow: 'guanxinghua/CANNBay.git' },
  { needle: '[cbi]' },
  { needle: '.cannbot-insight' },
]

function scanForbidden(root: string, forbidden: Array<{ needle: string; allow?: string }>): string[] {
  const leaks: string[] = []
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules') continue
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) { walk(full); continue }
      if (!TEXT_EXTS.has(path.extname(name))) continue
      const raw = fs.readFileSync(full, 'utf8')
      for (const bad of forbidden) {
        const text = bad.allow ? raw.split(bad.allow).join('') : raw
        if (text.includes(bad.needle)) leaks.push(`${path.relative(root, full)}: ${bad.needle}`)
      }
    }
  }
  walk(root)
  return leaks
}

describe('context 品牌变体打包（pack-context.mjs）', () => {
  beforeAll(() => {
    const r = spawnSync(process.execPath, ['scripts/pack-context.mjs'], {
      cwd: PKG_DIR, encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
    })
    expect(r.status, `pack-context.mjs 失败:\n${r.stderr}`).toBe(0)
    expect(fs.existsSync(TGZ), `产物缺失: ${TGZ}`).toBe(true)

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-insight-'))
    const t = spawnSync('tar', ['-xzf', TGZ, '-C', tmpRoot], { encoding: 'utf8', timeout: 60_000 })
    expect(t.status, t.stderr).toBe(0)
    extracted = path.join(tmpRoot, 'package')
  }, 300_000)

  afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* tmp 目录留置无害 */ }
  })

  it('package.json：包名 / bin / 版本与主包同源', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.name).toBe('context-insight')
    expect(pkg.bin).toEqual({
      'context-insight': './bin/context-insight.mjs',
      ctxi: './bin/context-insight.mjs',
    })
    expect(pkg.version).toBe(VERSION)
    expect(pkg.private).toBeUndefined()
  })

  it('CLI bundle 实跑：--version 输出 Context-Insight 品牌串', () => {
    fs.symlinkSync(path.join(PKG_DIR, 'node_modules'), path.join(extracted, 'node_modules'), 'dir')
    const r = spawnSync(process.execPath, ['dist/cli.mjs', '--version'], {
      cwd: extracted, encoding: 'utf8', timeout: 60_000,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(`Context-Insight v${VERSION}`)
  })

  it('品牌泄漏哨兵：显示名 / Bay 名（大小写两种形态）/ 别名 / 数据目录路径零残留', () => {
    const leaks = scanForbidden(extracted, FORBIDDEN)
    expect(leaks, `品牌泄漏:\n${leaks.join('\n')}`).toEqual([])
  })

  it('格式契约保留：source type / smart-agent 服务标识 / CANNBAY2 env 文档', () => {
    expect(read('src/lib/branding.ts')).toContain('BRAND_SOURCE_TYPE = "cannbot-insight"')
    expect(read('smart-agent/server.py')).toContain('cannbot-smart-agent')
    expect(read('README.md')).toContain('CANNBAY2_LFS')
    expect(read('bin/context-insight.mjs')).toContain("'.context-insight'")
  })
})
