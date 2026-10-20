// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 域 reader IT：结构样例（graph-demo 回滚 manifest：76 成员/82 关系/3 代/
// 2 回滚/1 子图）全量断言 + 校验矩阵（错误拒绝 / 警告容忍）。
// fixture：tests/ut/data/run/graph-demo-rollback-manifest.json

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseManifest,
  parseAndIndex,
  lookupByFiveKey,
  memberKey,
  ManifestParseError,
} from '@/lib/run/reader';
const FIXTURE = path.resolve(__dirname, './data/run/graph-demo-rollback-manifest.json');
const raw: unknown = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));

function baseManifest(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
}

describe('reader：结构样例全量断言', () => {
  const index = parseAndIndex(raw);

  it('根信封：schema/version/id/kind + exportDataComplete', () => {
    expect(index.manifest.schema).toBe('cannbot.workflow-bundle');
    expect(index.manifest.version).toBe(1);
    expect(index.manifest.id).toBe('WC7D09351F7D2B9E0');
    expect(index.manifest.kind).toBe('workflow');
    expect(index.manifest.data.exportDataComplete).toBe(true);
  });

  it('全树：76 成员（75 个带 graph 注解）/ 83 关系', () => {
    expect(index.members).toHaveLength(76);
    expect(index.graphMembers).toHaveLength(75);
    expect(index.relations).toHaveLength(83);
    // 全树 id 唯一（重复在 buildIndex 抛错，这里验证可正常建索引）
    expect(index.membersById.size).toBe(76);
  });

  it('关系分类：78 依赖 + 2 回滚 + 3 子图生成（端点全部解析）', () => {
    const count = (pred: (a: Record<string, unknown> | undefined) => boolean) =>
      index.relations.filter(r => pred(r.raw.annotation)).length;
    expect(count(a => a?.type === 'depends_on')).toBe(78);
    expect(count(a => a?.type === 'rollback')).toBe(2);
    expect(count(a => a?.kind === 'gen-sub-graph')).toBe(3);
  });

  it('五键定位：gen-sub:sub-flaky 第 0 代第 1 次执行 = process 成员', () => {
    const hits = lookupByFiveKey(index, {
      nodeId: 'gen-sub:sub-flaky',
      generation: 0,
      attempt: 1,
      role: 'execute',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].member.kind).toBe('process');
    expect(hits[0].ownerWorkflowId).toBe('MAC41B7669DBB2BD6'); // 子图 workflow 成员
    expect(memberKey(hits[0])).toBe('gen-sub:sub-flaky|0|1|execute');
  });

  it('attempt 跨代归零重现：flaky-step g0 与 g2 的第 1 次是不同成员', () => {
    const g0 = lookupByFiveKey(index, { nodeId: 'flaky-step', generation: 0, attempt: 1, role: 'execute' });
    const g2 = lookupByFiveKey(index, { nodeId: 'flaky-step', generation: 2, attempt: 1, role: 'execute' });
    expect(g0[0].member.id).not.toBe(g2[0].member.id);
  });

  it('根直接成员 ownerWorkflowId=null，子图成员指向子图 workflow', () => {
    const rootMember = lookupByFiveKey(index, { nodeId: 'init', generation: 0, attempt: 1, role: 'execute' });
    expect(rootMember[0].ownerWorkflowId).toBeNull();
    const subMember = lookupByFiveKey(index, { nodeId: 'gen-sub:sub-init', generation: 1, attempt: 1, role: 'verify' });
    expect(subMember[0].ownerWorkflowId).toBe('MAC41B7669DBB2BD6');
  });
});

describe('reader：校验矩阵（错误 = 拒绝导入）', () => {
  it.each([
    ['bad-schema', (m: Record<string, unknown>) => { m.schema = 'other'; }],
    ['unsupported-version', (m: Record<string, unknown>) => { m.version = 99; }],
    ['bad-id', (m: Record<string, unknown>) => { m.id = ''; }],
    ['bad-kind', (m: Record<string, unknown>) => { m.kind = 'process'; }],
    ['members-missing', (m: Record<string, unknown>) => { delete (m.data as Record<string, unknown>).members; }],
    ['dup-member-id', (m: Record<string, unknown>) => {
      const members = (m.data as { members: unknown[] }).members;
      (members[1] as Record<string, unknown>).id = (members[0] as Record<string, unknown>).id;
    }],
    ['dangling-relation', (m: Record<string, unknown>) => {
      const data = m.data as { relations: unknown[] };
      data.relations.push({ from: 'NO_SUCH_MEMBER', to: 'ALSO_MISSING' });
    }],
  ])('%s → ManifestParseError', (reason, mutate) => {
    const m = baseManifest();
    mutate(m);
    try {
      parseAndIndex(m);
      expect.unreachable(`应抛 ${reason}`);
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestParseError);
      expect((e as ManifestParseError).reason).toBe(reason);
    }
  });

  it('根非对象 / 非法 JSON 值：not-an-object', () => {
    expect(() => parseManifest('x')).toThrowError(ManifestParseError);
    expect(() => parseManifest([1])).toThrowError(/根必须是 JSON 对象/);
  });

  it('未知顶层字段透传（信封冻结：加可选字段不升版）', () => {
    const m = baseManifest() as { futureField?: string };
    m.futureField = 'v2 预留';
    const manifest = parseManifest(m);
    expect((manifest as { futureField?: string }).futureField).toBe('v2 预留');
  });
});

describe('reader：警告矩阵（容忍态，不阻断）', () => {
  it('session 成员携带 output → 警告且不丢成员', () => {
    const m = baseManifest() as { data: { members: Array<Record<string, unknown>> } };
    const build = m.data.members.find(
      x => (x as { annotation?: { graph?: { nodeId?: string } } }).annotation?.graph?.nodeId === 'step-a',
    ) as Record<string, unknown>;
    build.output = { text: '不该有' };
    const index = parseAndIndex(m);
    expect(index.warnings.some(w => w.includes('不应携带 output'))).toBe(true);
    expect(index.members).toHaveLength(76);
  });

  it('sessionId/location 半空 → 警告', () => {
    const m = baseManifest() as { data: { members: Array<Record<string, unknown>> } };
    const build = m.data.members.find(
      x => (x as { sessionId?: unknown }).sessionId === 'S2BB26D62E3566801',
    ) as Record<string, unknown>;
    build.location = null;
    const index = parseAndIndex(m);
    expect(index.warnings.some(w => w.includes('sessionId/location'))).toBe(true);
  });

  it('坏 graph 注解（role 越界）→ 降级为无注解成员 + 警告', () => {
    const m = baseManifest() as { data: { members: Array<Record<string, unknown>> } };
    const init = m.data.members.find(
      x => (x as { annotation?: { graph?: { nodeId?: string } } }).annotation?.graph?.nodeId === 'init',
    ) as { annotation: { graph: Record<string, unknown> } };
    init.annotation.graph.role = 'plan';
    const index = parseAndIndex(m);
    expect(index.graphMembers).toHaveLength(74); // 75 - 1 个降级
    expect(index.warnings.some(w => w.includes('五键字段不合法'))).toBe(true);
  });

  it('根缺 exportDataComplete → 警告并按 false 对待', () => {
    const m = baseManifest();
    delete (m.data as Record<string, unknown>).exportDataComplete;
    const index = parseAndIndex(m);
    // 缺失保留 undefined（区别于显式 false）；下游统一以 === true 按 false 对待
    expect(index.manifest.data.exportDataComplete).toBeUndefined();
    // 回归锁：缺失告警曾为死代码，现随 index.warnings 透传到 UI
    expect(index.warnings.some(w => w.includes('exportDataComplete 缺失'))).toBe(true);
  });
});
