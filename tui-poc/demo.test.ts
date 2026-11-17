// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 组件契约测试：render(width) 的行宽/行数/框完整性 + WASD/↑↓/Enter 交互流。
// pi-tui 的 render→string[] 契约让测试无需渲染替身——所见行即终端行。
import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ScorePoc } from './demo';

const COLS = 120, ROWS = 40;
const plain = (lines: string[]) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
const mk = () => new ScorePoc(ROWS, () => {});

describe('pi-tui PoC：双栏定高布局', () => {
  it('idle 帧：行数恒定、零超宽、框成对闭合', () => {
    const app = mk();
    const lines = app.render(COLS);
    expect(lines.length).toBe(ROWS - 1); // 顶栏1 + 主体36 + keybar1 + 状态1 = 39（无 alt 屏底行）
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(COLS);
    const p = plain(lines);
    expect(p.join('\n').match(/╭/g)?.length).toBe(p.join('\n').match(/╰/g)?.length);
    for (const label of ['来源', '会话 3/3', 'Agent 工具', '运行', '待评分', '已完成', '评分卡']) {
      expect(p.join('\n')).toContain(label);
    }
  });

  it('两次渲染行数逐帧同构（差分渲染的稳定性前提）', () => {
    const app = mk();
    const a = app.render(COLS).length;
    app.handleInput('d'); // 焦点去右栏
    const b = app.render(COLS).length;
    app.handleInput('\x1b[B'); // 右栏滚动
    const c = app.render(COLS).length;
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('W/S 分区跳 + Space 勾选 + Enter 运行 → 完成态出卡', async () => {
    const app = mk();
    app.handleInput('s');       // 来源区 → 会话区首行（poc-sid-001）
    app.handleInput(' ');       // 勾选
    let p = plain(app.render(COLS)).join('\n');
    expect(p).toContain('[x] poc-sid-001');
    app.handleInput('s'); app.handleInput('s'); // 会话 → 工具 → 运行
    p = plain(app.render(COLS)).join('\n');
    expect(p).toContain('❯ ▶ [Enter] 开始评分（已选 1）');
    app.handleInput('\r');
    p = plain(app.render(COLS)).join('\n');
    expect(p).toContain('待评分（1/1）'); // 运行态
    await new Promise(r => setTimeout(r, 1800)); // 模拟评分流走完（5×300ms）
    p = plain(app.render(COLS)).join('\n');
    expect(p).toContain('队列已完成');
    expect(p).toContain('已完成（1/1）');
    // 右栏载入评分卡：D → 焦点右栏，③已常驻展示总分
    app.handleInput('d');
    p = plain(app.render(COLS)).join('\n');
    expect(p).toContain('总分');
    expect(p).toContain('D1 完成度');
  });

  it('CJK 内容行不超宽（会话行含中文与全角字符）', () => {
    const app = mk();
    const p = app.render(80); // 窄终端压力
    for (const l of p) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
    const joins = plain(p).join('\n');
    expect(joins.match(/╭/g)?.length).toBe(joins.match(/╰/g)?.length);
  });
});
