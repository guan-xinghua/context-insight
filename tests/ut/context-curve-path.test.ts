// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ContextTracker 曲线回拐修复 IT：x 轴是真实时间、点距极不均匀（相邻段
// 6 秒 vs 17 小时），未钳制的 Catmull-Rom x 控制点被远邻段拉出段外 →
// Bézier 曲线横向过冲折回（实测 ses_f5b4a2b58ffe design #17 #134→#135）。
// 修复 = x 控制点钳制到段内（与既有 y 钳制对称）。

import { describe, it, expect } from 'vitest';
import { curvePath } from '@/components/observe/ContextTracker';

interface Pt { x: number; y: number }

// 解析 path 字符串：M x,y 后跟若干段 C cp1 cp2 p2
function parseSegments(d: string): Array<{ p1: Pt; cp1: Pt; cp2: Pt; p2: Pt }> {
  const nums = (d.match(/-?[\d.]+/g) ?? []).map(Number);
  const segs: Array<{ p1: Pt; cp1: Pt; cp2: Pt; p2: Pt }> = [];
  // M x0,y0 C a1,b1 a2,b2 x1,y1 C ... —— 每段 6 个数
  let p1 = { x: nums[0], y: nums[1] };
  for (let i = 2; i + 5 < nums.length + 1 && i + 5 <= nums.length; i += 6) {
    segs.push({
      p1,
      cp1: { x: nums[i], y: nums[i + 1] },
      cp2: { x: nums[i + 2], y: nums[i + 3] },
      p2: { x: nums[i + 4], y: nums[i + 5] },
    });
    p1 = { x: nums[i + 4], y: nums[i + 5] };
  }
  return segs;
}

// 真实回拐形态（ses_f5b4a2b58ffe design #17 的 #133~#137，x=时间戳 ms）：
// #129→#130 761s，#133→#134 18s，#134→#135 6.4s，#135→#137 17 小时
function realWorldBackBendPts(): Pt[] {
  const t = (h: number, m: number, s: number) => Date.UTC(2026, 8, 16, h, m, s);
  return [
    { x: t(8, 2, 37), y: 99616 },   // #129
    { x: t(8, 15, 18), y: 131538 }, // #130（前邻段 761s）
    { x: t(8, 29, 33), y: 170730 }, // #133
    { x: t(8, 29, 51), y: 170899 }, // #134
    { x: t(8, 29, 58), y: 182918 }, // #135
    { x: t(1, 29, 58) + 17 * 3600_000, y: 220306 }, // #137（17 小时远邻段）
  ];
}

describe('curvePath x 控制点钳制（回拐修复）', () => {
  it('真实回拐序列：每段控制点 x 都落在段内（Bézier 凸包不越界）', () => {
    const d = curvePath(realWorldBackBendPts());
    const segs = parseSegments(d);
    expect(segs.length).toBe(5);
    for (const s of segs) {
      const minX = Math.min(s.p1.x, s.p2.x);
      const maxX = Math.max(s.p1.x, s.p2.x);
      expect(s.cp1.x).toBeGreaterThanOrEqual(minX);
      expect(s.cp1.x).toBeLessThanOrEqual(maxX);
      expect(s.cp2.x).toBeGreaterThanOrEqual(minX);
      expect(s.cp2.x).toBeLessThanOrEqual(maxX);
    }
  });

  it('未钳制的旧公式在该序列下确实越界（负向验证：修复前的回拐根因）', () => {
    const pts = realWorldBackBendPts();
    // 段 #134→#135：p0=#133, p1=#134, p2=#135, p3=#137
    const p1 = pts[3], p2 = pts[4], p3 = pts[5];
    const oldCp2x = p2.x - (p3.x - p1.x) / 6;
    // 旧公式控制点被 17 小时远邻段拉到 #134 之前（段外左侧）——正是回拐
    expect(oldCp2x).toBeLessThan(p1.x);
    // 修复后：钳制到段内
    const segs = parseSegments(curvePath(pts));
    const seg134 = segs.find(s => s.p1.x === pts[3].x && s.p2.x === pts[4].x)!;
    expect(seg134.cp2.x).toBeGreaterThanOrEqual(Math.min(p1.x, p2.x));
  });

  it('y 向钳制保持（回归）与常规形态不受影响', () => {
    // 均匀点距 + 上升曲线：控制点本就段内，钳制前后一致
    const even = Array.from({ length: 8 }, (_, i) => ({ x: i * 100, y: 1000 - i * 50 }));
    const segs = parseSegments(curvePath(even));
    for (const s of segs) {
      expect(s.cp1.y).toBeGreaterThanOrEqual(Math.min(s.p1.y, s.p2.y));
      expect(s.cp2.y).toBeLessThanOrEqual(Math.max(s.p1.y, s.p2.y));
    }
    // 两点退化：直线
    expect(curvePath([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe('M 0,0 L 10,10');
    expect(curvePath([{ x: 1, y: 1 }])).toBe('M 1,1');
    expect(curvePath([])).toBe('');
  });
});
