// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 边几何引擎 IT：链点正交化 + 平行段错开（P2 布线简洁——不同边共线
// 垂直段 y 区间重叠时横向错开，端点回归锚点；汇聚主干的有意叠线保留）。

import { describe, it, expect } from 'vitest';
import { nudgeParallelRuns, vChainPoints, verticalRuns } from '@/lib/run/edge-geometry';

describe('edge-geometry：链点正交化', () => {
  it('相邻点 x 不同时在中点 y 插水平过渡（纯横/竖交替折线）', () => {
    expect(vChainPoints([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
    ]);
  });

  it('同 x 直行不插点；多段链逐段正交化（共线中间点隐式合并）', () => {
    expect(vChainPoints([{ x: 5, y: 0 }, { x: 5, y: 8 }])).toEqual([
      { x: 5, y: 0 },
      { x: 5, y: 8 },
    ]);
    expect(vChainPoints([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 20, y: 30 }, { x: 20, y: 40 }])).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: 40 },
    ]);
  });
});

describe('edge-geometry：平行段错开（nudging）', () => {
  it('共线部分重叠：稳定序首条不动、次条 +3 错开，端点回归锚点且 y 单调不减', () => {
    const a = { id: 'a', pts: [{ x: 100, y: 0 }, { x: 100, y: 200 }] };
    const b = { id: 'b', pts: [{ x: 100, y: 100 }, { x: 100, y: 300 }] };
    const out = nudgeParallelRuns([a, b]);
    // 首条（稳定序）保持原列
    expect(out[0].pts).toEqual(a.pts);
    // 次条：中段 +3 错开，首尾锚点原样
    const nb = out[1].pts;
    expect(nb[0]).toEqual({ x: 100, y: 100 });
    expect(nb[nb.length - 1]).toEqual({ x: 100, y: 300 });
    // 错开档位 +3：中段竖直运行在 x=103，处于段内部（不越出端点保护带）
    const runs = verticalRuns(nb);
    expect(runs.some(r => r.x === 103 && r.y1 > 100 && r.y2 < 300)).toBe(true);
    // y 单调不减（正交小折不回跳）
    for (let i = 0; i < nb.length - 1; i++) {
      expect(nb[i + 1].y).toBeGreaterThanOrEqual(nb[i].y);
    }
  });

  it('三边共线束：档位 0 / +3 / -3 交替展开，档位互异', () => {
    const edges = [
      { id: 'a', pts: [{ x: 50, y: 0 }, { x: 50, y: 200 }] },
      { id: 'b', pts: [{ x: 50, y: 50 }, { x: 50, y: 250 }] },
      { id: 'c', pts: [{ x: 50, y: 100 }, { x: 50, y: 300 }] },
    ];
    const out = nudgeParallelRuns(edges);
    const laneOf = (pts: Array<{ x: number; y: number }>) => {
      const off = verticalRuns(pts).map(r => r.x).filter(x => x !== 50);
      return off.length === 0 ? 0 : off[0] - 50;
    };
    const lanes = out.map(e => laneOf(e.pts));
    expect(lanes[0]).toBe(0);
    expect(new Set(lanes).size).toBe(3);
    for (const lane of lanes) {
      expect(Math.abs(lane)).toBeLessThanOrEqual(3);
      expect(Math.abs(lane) % 3).toBe(0);
    }
  });

  it('完全同段（汇聚主干叠线）保留不动', () => {
    const a = { id: 'a', pts: [{ x: 100, y: 0 }, { x: 100, y: 200 }] };
    const b = { id: 'b', pts: [{ x: 100, y: 0 }, { x: 100, y: 200 }] };
    const out = nudgeParallelRuns([a, b]);
    expect(out[0].pts).toEqual(a.pts);
    expect(out[1].pts).toEqual(b.pts);
  });

  it('主干叠线 + 部分重叠第三边：第三边单独错开，主干保留', () => {
    const a = { id: 'a', pts: [{ x: 100, y: 0 }, { x: 100, y: 200 }] };
    const b = { id: 'b', pts: [{ x: 100, y: 0 }, { x: 100, y: 200 }] };
    const c = { id: 'c', pts: [{ x: 100, y: 100 }, { x: 100, y: 300 }] };
    const out = nudgeParallelRuns([a, b, c]);
    expect(out[0].pts).toEqual(a.pts);
    expect(out[1].pts).toEqual(b.pts);
    expect(verticalRuns(out[2].pts).some(r => r.x === 103)).toBe(true);
  });

  it('同列不重叠 / 段过短：均不动', () => {
    const a = { id: 'a', pts: [{ x: 100, y: 0 }, { x: 100, y: 100 }] };
    const b = { id: 'b', pts: [{ x: 100, y: 120 }, { x: 100, y: 220 }] }; // 同列不重叠
    const c = { id: 'c', pts: [{ x: 100, y: 0 }, { x: 100, y: 40 }] };    // 段长 40 < 最短 50
    const d = { id: 'd', pts: [{ x: 100, y: 10 }, { x: 100, y: 50 }] };   // 与 c 重叠但过短
    const out = nudgeParallelRuns([a, b, c, d]);
    out.forEach((e, i) => expect(e.pts).toEqual([a, b, c, d][i].pts));
  });

  it('同一条边的多个共线段互不相扰（连接而非重叠）', () => {
    const e = {
      id: 'a',
      pts: [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 120, y: 100 }, { x: 120, y: 200 }],
    };
    const out = nudgeParallelRuns([e]);
    expect(out[0].pts).toEqual(e.pts);
  });
});
