// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 车道键解析 + 内容签名推断 IT：词边界（database 不得误伤 base）、大小写、
// 声明序、空输入；inferLanes 的双门槛（率 ≥ 0.4、车道 ≥ 2）、分母剔除、
// 多表择优与边界值（0.39/0.40）。
import { describe, it, expect } from 'vitest';
import { resolveLaneKey, inferLanes } from '../../src/lib/swimlane-lanes.ts';

const LANES = ['base', 'group', 'empty'];

describe('resolveLaneKey：步骤文本 → 车道键', () => {
  it('命中各车道（中文紧邻、标点紧邻均算边界）', () => {
    expect(resolveLaneKey('④ base 泳道模板计算流', LANES)).toBe('base');
    expect(resolveLaneKey('④.5 group 存活节点分析', LANES)).toBe('group');
    expect(resolveLaneKey('R④.5 empty 复审 v2', LANES)).toBe('empty');
  });

  it('词边界：database 不得误伤 base', () => {
    expect(resolveLaneKey('database schema 校验', LANES)).toBeNull();
    expect(resolveLaneKey('based_on 引用检查', LANES)).toBeNull();
    expect(resolveLaneKey('update base_map 表', LANES)).toBeNull(); // base_map 是同词延伸
  });

  it('大小写不敏感 + 声明序优先（同时命中取表中靠前）', () => {
    expect(resolveLaneKey('BASE lane run', LANES)).toBe('base');
    expect(resolveLaneKey('Group lane', LANES)).toBe('group');
    expect(resolveLaneKey('base 与 group 混排步骤', LANES)).toBe('base'); // 声明序
  });

  it('未命中 / 空输入', () => {
    expect(resolveLaneKey('P1 需求分析', LANES)).toBeNull();
    expect(resolveLaneKey('① 建图与定序', LANES)).toBeNull();
    expect(resolveLaneKey(null, LANES)).toBeNull();
    expect(resolveLaneKey('④ base 泳道', [])).toBeNull();
  });
});

describe('inferLanes：派发描述 → 车道表（内容签名推断）', () => {
  const TABLES = { 'op-fusion': LANES };

  it('op-fusion 形态描述 → 命中表（rate 与车道数均过门槛）', () => {
    const contents = [
      'P1 需求分析', 'R 门控：P1 审核',
      '④ 模板计算流：base', '④ 模板计算流：group',
      'R 门控：④ base 审核', '④.5 存活节点：group', '⑤ VF 融合：base',
    ];
    expect(inferLanes(contents, TABLES)).toEqual({ paradigm: 'op-fusion', lanes: LANES });
  });

  it('率不过阈（0.39 边界）→ null', () => {
    // 5 条有效描述、2 条命中（base+group）→ 0.4 恰好过线；去掉 1 条命中变 1/5
    const pass = ['base 段', 'group 段', '前置', '门控', '复审'];
    expect(inferLanes(pass, TABLES)).toEqual({ paradigm: 'op-fusion', lanes: LANES }); // 2/5 = 0.40 ✅
    const fail = ['base 段', '前置', '门控', '复审', '结项'];
    expect(inferLanes(fail, TABLES)).toBeNull(); // 1/5 = 0.20 且单车道
    expect(inferLanes(['base 段', 'group 段', '前置①', '前置②', '前置③', '门控④', '复审⑤'], TABLES)).toBeNull(); // 2/7 ≈ 0.29
  });

  it('单车道命中（率再高也不算结构证据）→ null', () => {
    const onlyBase = Array.from({ length: 10 }, (_, i) => `base 段 ${i}`);
    expect(inferLanes(onlyBase, TABLES)).toBeNull();
  });

  it('null/空白不进分母：pending 桥不稀释命中率', () => {
    const contents = ['base 段', 'group 段', null, '  ', undefined];
    expect(inferLanes(contents, TABLES)).toEqual({ paradigm: 'op-fusion', lanes: LANES }); // 2/2 而非 2/5
  });

  it('全空 / 无表 → null', () => {
    expect(inferLanes([], TABLES)).toBeNull();
    expect(inferLanes([null, ''], TABLES)).toBeNull();
    expect(inferLanes(['base', 'group'], {})).toBeNull();
  });

  it('多表过阈取 rate 最高，平分比不同车道数', () => {
    const tables = {
      'op-fusion': LANES,
      'op-split': ['sync', 'async'],
    };
    const contents = ['sync 段', 'async 段', 'base 段', 'group 段', 'base 复审'];
    // op-fusion: 3/5 = 0.6；op-split: 2/5 = 0.4 → 取 op-fusion
    expect(inferLanes(contents, tables)).toEqual({ paradigm: 'op-fusion', lanes: LANES });
    const tie = ['sync 段', 'async 段', 'base 段', 'group 段'];
    // 两表均 2/4 = 0.5、车道均 2 → 声明序取 op-fusion
    expect(inferLanes(tie, tables)).toEqual({ paradigm: 'op-fusion', lanes: LANES });
  });
});
