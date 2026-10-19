// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Runs 页渲染 IT：页面直读 run-store（CANNBOT_INSIGHT_HOME 可注入），已导入
// 的 run 必须出现在列表。回归锁：曾因未声明动态渲染被构建期静态预渲染成
// 「空列表」缓存——导入成功后页面仍显示暂无 Run。此处在组件层锁数据接线
// （store → page → RunList），构建产物层面的 force-dynamic 声明一并断言。

import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import RunsPage, { dynamic as runsPageDynamic } from '@/app/runs/page';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => '/runs',
  useSearchParams: () => new URLSearchParams(''),
}))

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-runs-page-'));
const ORIG_HOME = process.env.CANNBOT_INSIGHT_HOME;

beforeAll(() => {
  process.env.CANNBOT_INSIGHT_HOME = tmpHome;
  const manifest = parseAndIndex(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8')),
  ).manifest;
  const meta: RunImportMeta = {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt: '2026-10-15T10:00:00+08:00',
      sourceDir: '/bundle/mini',
      manifestFile: 'workflow.json',
      exportDataComplete: true,
      sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
      failures: [],
      warnings: [],
    },
  };
  saveRun(manifest, meta);
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CANNBOT_INSIGHT_HOME;
  else process.env.CANNBOT_INSIGHT_HOME = ORIG_HOME;
})

let root: Root | null = null

describe('Runs 页：store → page → RunList 数据接线', () => {
  it('已导入的 run 渲染进列表（非空态），不显示「暂无导入的 Run」', async () => {
    const tree = await RunsPage()
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(tree)
    })

    expect(document.body.textContent).toContain('mini-bundle')
    expect(document.body.textContent).not.toContain('暂无导入的 Run')
    // 导入入口挂在 header 动作区（与首页 Import Session 同位同尺寸），
    // 且 runs 页不出现数据仓 viewer 入口
    expect(document.body.textContent).toContain('导入 Bundle')
    expect(document.body.textContent).not.toContain('Viewer')
  })

  it('页面声明 force-dynamic（fs 数据源禁止构建期静态预渲染）', () => {
    expect(runsPageDynamic).toBe('force-dynamic')
  })
})
