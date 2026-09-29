// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 零内置凭据防回潮锁（跨包扫描，自 cpx 侧迁移而来）：cpx 与 insight 全量
// 源码不得出现密文常量或内嵌凭据 URL——凭据一律走服务端存储与解析链。
// 嵌入凭据正则为 host 无关形态（不绑定任何托管平台域名）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = [
  path.resolve(__dirname, '../../../cpx/src'),
  path.resolve(__dirname, '../../src'),
];

describe('跨包源码零内置凭据（防回潮锁）', () => {
  it('cpx/insight 源码不得出现密文常量或内嵌凭据 URL', () => {
    const encodedConst = /LAKE_PUSH_URL_ENCODED|LAKE_PUSH_URL\s*=/;
    const base64Blob = /=\s*['"][A-Za-z0-9+/]{60,}={0,2}['"]/;
    // Host-agnostic: any user:pass@ URL on any host is forbidden.
    const embeddedCreds = /https?:\/\/[^/'"\s]+:[^'"\s@]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const [name, re] of [['encoded-const', encodedConst], ['base64-blob', base64Blob], ['embedded-creds', embeddedCreds]] as const) {
          if (re.test(src)) offenders.push(`${path.relative(path.resolve(__dirname, '../../..'), full)}: ${name}`);
        }
      }
    };
    for (const r of ROOTS) walk(r);
    expect(offenders, `检出内置凭据残留（凭据必须走服务端存储与解析链，绝不回源码）:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('平台中性哨兵（平台化 P1-P3 防回潮锁，词表源 sensitive-info-audit）', () => {
  // 私仓/组织/用户名/预设名/env 旧前缀——src 零容忍（任何命中都是回潮）。
  // CANNbay/CANNBay 是合法品牌显示名（branding.ts BAY_NAME 常量的字面量，
  // pack-context 翻转为 contextBay）——白名单三个合法居所，其他文件出现
  // 品牌字面量（应经 BAY_NAME 常量引用）即回潮
  const FORBIDDEN_ANYWHERE = [
    'atomgit', 'TTELab', 'guanxinghua', 'cann_corpus', 'trace_corpus',
    'CANNBAY2_', 'cannbay-lake', 'cannbay2',
  ];
  const BRAND_NAME_FILES = new Set([
    'insight/src/lib/branding.ts',
    'insight/scripts/pack-context.mjs',
    'insight/tests/e2e/context-pack.test.ts',
  ]);
  // cannbay 裸形态：仅允许三个白名单上下文——x_cannbay 双名信封键（P3 过渡）、
  // cannbay-auth.json 读兜底字面量（P1 兼容）、以其为前缀的标识符（xB* 局部
  // 变量名在双名臂旁随行）。白名单以"该行同时含 x_lake 或 lake-auth 或
  // 豁免串本身"判定——离开双名语境的 cannbay 即回潮
  const CANNBAY_LINE_OK = /x_cannbay|cannbay-auth\.json|lake-schema-spec/;
  // 品牌名白名单文件内 CANNbay/CANNBay 合法（branding 字面量/翻转规则/探针）
  const BRAND_FORMS = /CANNBay|CANNbay/;

  it('双包 src 词表扫描归零（私址/组织/用户名/预设名/env 旧前缀/品牌变体）', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        const relPath = rel(full);
        const isBrandFile = BRAND_NAME_FILES.has(relPath.replace(/\\/g, '/'));
        lines.forEach((line, i) => {
          for (const word of FORBIDDEN_ANYWHERE) {
            if (line.includes(word)) offenders.push(`${relPath}:${i + 1} [${word}] ${line.trim().slice(0, 80)}`);
          }
          // 品牌名白名单文件内 CANNbay/CANNBay 合法；其他文件出现品牌字面量即回潮
          // （应经 BAY_NAME/BAY_VIEWER_NAME 常量引用）
          if (!isBrandFile && BRAND_FORMS.test(line)) {
            offenders.push(`${relPath}:${i + 1} [brand-literal-outside-allowed] ${line.trim().slice(0, 80)}`);
          }
          // 裸 cannbay（非白名单上下文行）
          if (/(^|[^_\w-])cannbay([^_\w-]|$)/.test(line) && !CANNBAY_LINE_OK.test(line)) {
            offenders.push(`${relPath}:${i + 1} [bare-cannbay] ${line.trim().slice(0, 80)}`);
          }
        });
      }
    };
    for (const r of ROOTS) walk(r);
    expect(offenders, `平台化词表回潮（敏感词治理见 sensitive-info-audit；白名单外命中即红）:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('cpx 侧信封写点必须双名（旧键写点前 25 行窗口内须有配对 x_lake 写点）', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.ts$/.test(e.name)) continue;
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (/x_cannbay: xLake\(/.test(line)) {
            const window = lines.slice(Math.max(0, i - 25), i + 1).join('\n');
            if (!/x_lake: xLake\(/.test(window)) offenders.push(`${rel(full)}:${i + 1}`);
          }
        });
      }
    };
    walk(ROOTS[0]);
    expect(offenders, `cpx 信封写点单名（必须 x_lake + 旧键双挂——双名变换形态为 x_lake 在前、旧键紧随信封对象体之后）:\n${offenders.join('\n')}`).toEqual([]);
  });
});

function rel(full: string): string {
  return path.relative(path.resolve(__dirname, '../../..'), full);
}
