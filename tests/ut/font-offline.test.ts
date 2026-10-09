// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 字体离线契约锁 IT（客户现场回归锁：国内网络无法访问 fonts.googleapis.com，
// next/font/google 在 next build 时联网拉 Geist/Geist Mono 导致安装失败）：
//   ① src 源码零 next/font/google 与 Google Fonts 域名引用——字体一律走
//      geist 本地包，构建期零联网
//   ② globals.css 接线正确：--font-sans/--font-heading 消费 --font-geist-sans
//      （历史上 `--font-sans: var(--font-sans)` 自引用空转曾使 Geist Sans
//      从未真正生效，正文一直是浏览器默认衬线体）
//   ③ 根布局挂 GeistSans/GeistMono 变量类
//   ④ geist 必须在 dependencies（客户 npm install --omit=dev 也能拿到）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PKG_ROOT = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(PKG_ROOT, 'src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe('字体离线（客户网络无法访问 Google Fonts 回归锁）', () => {
  it('src 源码零 next/font/google 引用——字体不依赖构建期联网', () => {
    const offenders = listSourceFiles(SRC_DIR).filter(f => {
      const content = fs.readFileSync(f, 'utf-8');
      return content.includes('next/font/google') || content.includes('fonts.googleapis') || content.includes('fonts.gstatic');
    });
    expect(offenders).toEqual([]);
  });

  it('根布局使用 geist 本地包变量类（GeistSans/GeistMono）', () => {
    const layout = fs.readFileSync(path.join(SRC_DIR, 'app/layout.tsx'), 'utf-8');
    expect(layout).toContain('geist/font/sans');
    expect(layout).toContain('geist/font/mono');
    expect(layout).toContain('${GeistSans.variable} ${GeistMono.variable}');
  });

  it('globals.css 接线：--font-sans/--font-heading 消费 --font-geist-sans，无自引用空转', () => {
    const css = fs.readFileSync(path.join(SRC_DIR, 'app/globals.css'), 'utf-8');
    expect(css).toContain('--font-sans: var(--font-geist-sans);');
    expect(css).toContain('--font-heading: var(--font-geist-sans);');
    expect(css).toContain('--font-mono: var(--font-geist-mono);');
    expect(css).not.toContain('--font-sans: var(--font-sans)');
  });

  it('geist 位于 dependencies（客户生产安装可获取）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.dependencies?.geist).toBeTruthy();
    expect(pkg.devDependencies?.geist).toBeFalsy();
  });
});
