// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 跨页横向对齐回归锁（样式契约）：html 必须预留滚动条槽位
// （scrollbar-gutter: stable）。否则内容长短不同的页面（Sessions 长列表有
// 滚动条、Runs 短页无）可视宽度相差一个滚动条——居中容器与品牌块
// （Context-Insight v0.x）在域切换时横向跳动。与 font-offline 同款：直读
// globals.css 锁规则存在。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const globalsCss = fs.readFileSync(path.resolve(__dirname, '../../src/app/globals.css'), 'utf-8');

describe('跨页布局对齐（滚动条槽位稳定）', () => {
  it('html 声明 scrollbar-gutter: stable——各域页面共享同一可视宽度', () => {
    expect(globalsCss).toContain('scrollbar-gutter: stable');
  });
});
