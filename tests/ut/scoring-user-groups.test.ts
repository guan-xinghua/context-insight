// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D7 自定义维度组模型 IT：一个组 = 一套标准，组内维度一条条增删改；停用组不参评；
// 维度 id 跨组全局唯一（D7.<id> 是评分键）；旧版扁平 <id>.json 一次性并入默认组；
// API（GET/PUT/DELETE）与注册表消费同口径。

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { loadUserGroups, loadUserDefinitions, saveUserGroup, deleteUserGroup, importUserGroups } from '../../src/lib/scoring/user/loader';
import { loadRegistry } from '../../src/lib/scoring/registry';
import type { UserDimensionFile, UserGroup } from '../../src/lib/scoring/user/loader';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'user-groups-'));
const DIR = path.join(TMP, 'defs');
process.env.SCORING_USER_DEF_DIR = DIR;

const dim = (id: string, name: string): UserDimensionFile => ({
  id, name,
  bands: [
    { range: '9-10', label: '优秀', description: '主动做好且留痕' },
    { range: '5-6', label: '基本达成', description: '做了但被动或不足' },
    { range: '0-2', label: '严重缺陷', description: '完全没做或脱节' },
  ],
});

const group = (id: string, name: string, dims: UserDimensionFile[], enabled?: boolean): UserGroup => ({
  id, name, dimensions: dims, ...(enabled === false ? { enabled: false } : {}),
});

afterAll(() => {
  delete process.env.SCORING_USER_DEF_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('组模型 · loader', () => {
  it('保存/读取：组内维度一条条增删改（整组 upsert）；文件落 <groupId>.group.json', async () => {
    await saveUserGroup(group('doc', '文档质量组', [dim('doc-fresh', '文档更新及时性')]));
    await saveUserGroup(group('ops', '算子专项组', [dim('op-boundary', '算子边界覆盖'), dim('op-dtype', 'dtype 覆盖')]));
    let groups = await loadUserGroups();
    expect(groups.map(g => g.id).sort()).toEqual(['doc', 'ops']);

    // 增：doc 组加一条
    await saveUserGroup(group('doc', '文档质量组', [dim('doc-fresh', '文档更新及时性'), dim('doc-style', '文档风格一致')]));
    groups = await loadUserGroups();
    expect(groups.find(g => g.id === 'doc')!.dimensions).toHaveLength(2);
    // 改：改名
    await saveUserGroup(group('doc', '文档质量组 v2', [dim('doc-fresh', '文档更新及时性（改）'), dim('doc-style', '文档风格一致')]));
    expect((await loadUserGroups()).find(g => g.id === 'doc')!.name).toBe('文档质量组 v2');
    // 删：ops 组去掉一条
    await saveUserGroup(group('ops', '算子专项组', [dim('op-boundary', '算子边界覆盖')]));
    expect((await loadUserGroups()).find(g => g.id === 'ops')!.dimensions).toHaveLength(1);
    // 删组
    await deleteUserGroup('ops');
    expect((await loadUserGroups()).map(g => g.id)).toEqual(['doc']);
    expect(fs.existsSync(path.join(DIR, 'doc.group.json'))).toBe(true);
  });

  it('停用组只留存不参评：loadUserDefinitions 只取启用组', async () => {
    await saveUserGroup(group('doc', '文档组', [dim('doc-fresh', '文档更新及时性')]));
    await saveUserGroup(group('off', '停用组', [dim('off-x', '某标准')], false));
    const defs = await loadUserDefinitions();
    expect(defs.map(d => d.id)).toEqual(['doc-fresh']);   // off 组不在
    const groups = await loadUserGroups();
    expect(groups.find(g => g.id === 'off')!.dimensions).toHaveLength(1);   // 但仍可查看/编辑
  });

  it('维度 id 跨组冲突拒绝（D7.<id> 是评分键）', async () => {
    await saveUserGroup(group('group-a', 'A 组', [dim('dup-id', '标准一')]));
    await expect(saveUserGroup(group('group-b', 'B 组', [dim('dup-id', '撞号的标准')]))).rejects.toThrow('冲突');
  });

  it('旧版扁平 <id>.json 一次性并入默认组', async () => {
    fs.writeFileSync(path.join(DIR, 'legacy-fresh.json'), JSON.stringify(dim('legacy-fresh', '旧版定义'), null, 2));
    const groups = await loadUserGroups();
    const def = groups.find(g => g.id === 'default');
    expect(def).toBeTruthy();
    expect(def!.dimensions.map(d => d.id)).toContain('legacy-fresh');
    expect(fs.existsSync(path.join(DIR, 'legacy-fresh.json'))).toBe(false);   // 旧文件清理
  });
});

describe('组模型 · 导入/导出', () => {
  it('round-trip：A 环境导出（loadUserGroups 即导出内容）→ B 空环境导入 → 组与维度一致', async () => {
    const dirA = path.join(TMP, 'export-a');
    const dirB = path.join(TMP, 'import-b');
    await saveUserGroup(group('doc', '文档质量组', [dim('doc-fresh', '文档更新及时性'), dim('doc-style', '文档风格一致')]), dirA);
    await saveUserGroup(group('ops', '算子专项组', [dim('op-dtype', 'dtype 覆盖')]), dirA);
    const bundle = await loadUserGroups(dirA);   // 导出内容

    const sm = await importUserGroups(bundle, dirB);
    expect(sm).toMatchObject({ addedGroups: 2, addedDims: 3, skippedDims: 0, invalidGroups: 0 });
    const inB = await loadUserGroups(dirB);
    expect(inB.map(g => g.id).sort()).toEqual(['doc', 'ops']);
    expect(inB.find(g => g.id === 'doc')!.dimensions.map(d => d.id)).toEqual(['doc-fresh', 'doc-style']);
  });

  it('合并语义：同组只补缺的维度、同 id 本地保留不被覆盖；无效组忽略并计数', async () => {
    const dir = path.join(TMP, 'import-merge');
    await saveUserGroup(group('doc', '本地文档组', [dim('doc-fresh', '本地版本（应保留）')]), dir);
    const sm = await importUserGroups([
      group('doc', '远端文档组', [dim('doc-fresh', '远端版本（应被跳过）'), dim('doc-new', '新维度')]),
      group('other', '全新组', [dim('o-1', '标准')]),
      { id: 'bad', name: '坏组', dimensions: [{ id: 'x', name: '没写档说明', bands: [{ range: '9-10', label: '优', description: '' }] }] },
    ], dir);
    expect(sm).toMatchObject({ addedGroups: 1, mergedGroups: 1, addedDims: 2, skippedDims: 1, invalidGroups: 1 });
    const groups = await loadUserGroups(dir);
    const doc = groups.find(g => g.id === 'doc')!;
    expect(doc.name).toBe('本地文档组');   // 组名本地保留
    expect(doc.dimensions.find(d => d.id === 'doc-fresh')!.name).toBe('本地版本（应保留）');
    expect(doc.dimensions.map(d => d.id)).toContain('doc-new');
    expect(groups.some(g => g.id === 'other')).toBe(true);
    expect(groups.some(g => g.id === 'bad')).toBe(false);
  });

  it('replace 模式：清空本地全部组，以导入文件为准', async () => {
    const dir = path.join(TMP, 'import-replace');
    await saveUserGroup(group('local-only', '本地独有组', [dim('local-dim', '本地标准')]), dir);
    await saveUserGroup(group('doc', '本地文档组', [dim('doc-fresh', '本地版本')]), dir);
    const sm = await importUserGroups([
      group('doc', '远端文档组', [dim('doc-fresh', '远端版本（生效）'), dim('doc-new', '新维度')]),
    ], dir, 'replace');
    expect(sm).toMatchObject({ addedGroups: 1, addedDims: 2, skippedDims: 0 });
    const groups = await loadUserGroups(dir);
    expect(groups.map(g => g.id)).toEqual(['doc']);   // local-only 没了，远端版本生效
    const doc = groups[0];
    expect(doc.name).toBe('远端文档组');
    expect(doc.dimensions.find(d => d.id === 'doc-fresh')!.name).toBe('远端版本（生效）');
  });

  it('API POST 导入：body.groups → 合并 → GET 反映', async () => {
    const { POST, GET } = await import('../../src/app/api/observe/scoring/user-definitions/route');
    const res = await POST(new NextRequest('http://localhost/api/observe/scoring/user-definitions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: [group('api-import', 'API 导入组', [dim('api-import-dim', '导入标准')])] }),
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as { summary: { addedGroups: number }; groups: UserGroup[] };
    expect(data.summary.addedGroups).toBe(1);
    expect(data.groups.some(g => g.id === 'api-import')).toBe(true);
    expect((await (await GET()).json() as { groups: UserGroup[] }).groups.some(g => g.id === 'api-import')).toBe(true);
  });
});

describe('组模型 · 注册表与 API', () => {
  it('loadRegistry：启用组的维度成为 D7 评分维（含 LLM 评分器），停用组不出现', async () => {
    await saveUserGroup(group('doc', '文档组', [dim('doc-fresh', '文档更新及时性')]));
    await saveUserGroup(group('off', '停用组', [dim('off-x', '某标准')], false));
    const reg = await loadRegistry();
    expect(reg.defs.some(d => d.id === 'D7:doc-fresh')).toBe(true);
    expect(reg.defs.some(d => d.id === 'D7:off-x')).toBe(false);
    expect(reg.scorerOf.has('D7.doc-fresh')).toBe(true);
  });

  it('API：PUT 整组保存 → GET 列组 → DELETE 删组', async () => {
    const { PUT, GET, DELETE } = await import('../../src/app/api/observe/scoring/user-definitions/route');
    const put = await PUT(new NextRequest('http://localhost/api/observe/scoring/user-definitions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: group('api-g', 'API 组', [dim('api-dim', '接口标准')]) }),
    }));
    expect(put.status).toBe(200);
    const get = await GET();
    const data = await get.json() as { groups: UserGroup[] };
    expect(data.groups.some(g => g.id === 'api-g' && g.dimensions.some(d => d.id === 'api-dim'))).toBe(true);
    // 重复维度 id → 400
    const bad = await PUT(new NextRequest('http://localhost/api/observe/scoring/user-definitions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: group('api-h', '另一组', [dim('api-dim', '撞号')]) }),
    }));
    expect(bad.status).toBe(400);
    const del = await DELETE(new NextRequest('http://localhost/api/observe/scoring/user-definitions?id=api-g', { method: 'DELETE' }));
    expect(del.status).toBe(200);
    expect((await (await GET()).json() as { groups: UserGroup[] }).groups.some(g => g.id === 'api-g')).toBe(false);
  });
});
