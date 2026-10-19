// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 槽位分配 IT（现场 ses_ecb797cb 模式：三业务车道多波次并发 + 串行阶段穿插）。
// 锁四件事：①车道钉死跨波次不漂移 ②车道内部并发>1 时池自动扩 ③未分类贪心
// 装填（无车道时与现状行为一致）④槽标签车道名/slotN。
import { describe, it, expect } from 'vitest';
import { assignLaneSlots, computeMaxConcurrency } from '../../src/lib/swimlane-slots.ts';

const T = (ms: number) => 1_000_000 + ms;
const LANES = ['base', 'group', 'empty'];

function wave(waveAt: number, dur = 50) {
  return [
    { key: `base-${waveAt}`, start: T(waveAt), end: T(waveAt + dur), laneKey: 'base' },
    { key: `group-${waveAt}`, start: T(waveAt + 1), end: T(waveAt + dur), laneKey: 'group' },
    { key: `empty-${waveAt}`, start: T(waveAt + 2), end: T(waveAt + dur), laneKey: 'empty' },
  ];
}

describe('assignLaneSlots：车道池 + 贪心', () => {
  it('三车道多波次：每车道恒定同槽（跨波不漂移），标签为车道名', () => {
    const spans = [...wave(0), ...wave(100), ...wave(200)];
    const { slotOf, labels } = assignLaneSlots(spans, LANES);
    expect(labels).toEqual(['base', 'group', 'empty']);
    for (const at of [0, 100, 200]) {
      expect(slotOf.get(`base-${at}`)).toBe(0);
      expect(slotOf.get(`group-${at}`)).toBe(1);
      expect(slotOf.get(`empty-${at}`)).toBe(2);
    }
  });

  it('车道内部并发 2：池自动扩为 2 槽，外车道不受影响', () => {
    // base 两条重叠（b2 在 b1 结束前启动）+ group 一条
    const spans = [
      { key: 'b1', start: T(0), end: T(100), laneKey: 'base' },
      { key: 'b2', start: T(50), end: T(120), laneKey: 'base' },
      { key: 'g1', start: T(0), end: T(80), laneKey: 'group' },
    ];
    const { slotOf, labels } = assignLaneSlots(spans, LANES);
    expect(labels).toEqual(['base', 'base', 'group']);
    expect(slotOf.get('b1')).toBe(0);
    expect(slotOf.get('b2')).toBe(1);
    expect(slotOf.get('g1')).toBe(2);
  });

  it('未分类条贪心装填：与车道槽隔离，槽标签 slotN', () => {
    const spans = [
      ...wave(0),
      { key: 'serial-1', start: T(1), end: T(40), laneKey: null },
      { key: 'serial-2', start: T(200), end: T(300), laneKey: null },
    ];
    const { slotOf, labels } = assignLaneSlots(spans, LANES);
    expect(labels).toEqual(['base', 'group', 'empty', 'slot1']);
    expect(slotOf.get('serial-1')).toBe(3);
    expect(slotOf.get('serial-2')).toBe(3); // 不重叠复用同一贪心槽
  });

  it('无车道声明：全部贪心（与现状行为等价，标签 slotN）', () => {
    const spans = [
      { key: 'a', start: T(0), end: T(50) },
      { key: 'b', start: T(10), end: T(50) },
      { key: 'c', start: T(100), end: T(150) },
    ];
    const { slotOf, labels } = assignLaneSlots(spans, []);
    expect(labels).toEqual(['slot1', 'slot2']);
    expect(slotOf.get('a')).toBe(0);
    expect(slotOf.get('b')).toBe(1);
    expect(slotOf.get('c')).toBe(0); // 复用空闲槽
  });

  it('声明了但数据无命中的车道不占槽', () => {
    const spans = [{ key: 'x', start: T(0), end: T(10), laneKey: 'base' }];
    const { labels } = assignLaneSlots(spans, ['base', 'left', 'right']);
    expect(labels).toEqual(['base']);
  });

  it('computeMaxConcurrency：端点相接不算并发', () => {
    expect(computeMaxConcurrency([
      { start: T(0), end: T(10) },
      { start: T(10), end: T(20) },
    ])).toBe(1);
    expect(computeMaxConcurrency([
      { start: T(0), end: T(10) },
      { start: T(5), end: T(20) },
    ])).toBe(2);
    expect(computeMaxConcurrency([])).toBe(1);
  });
});
