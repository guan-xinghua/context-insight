// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 包内 workflow.schema.json（draft-07）结构校验 IT：结构权威随包分发，
// 手写校验只保留 schema 表达不了的跨节点检查（id 唯一、关系端点解析）。
// fixture schema 与 Opsbot 导出件同源。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWithBundleSchema } from '@/lib/run/schema-validate';
import { validateBundleDir } from '@/lib/run/import-service';
import { buildIndex } from '@/lib/run/reader';
import { buildViewModel, findNodeInstance } from '@/lib/run/view-model';

const SCHEMA_SRC = path.resolve(__dirname, './data/run/workflow-bundle.v1.schema.json');
const OPSBOT_FIXTURE = path.resolve(__dirname, './data/run/opsbot-workflow-minimal.json');

function makeBundle(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-schema-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  }
  return dir;
}

function validManifest(): Record<string, unknown> {
  return {
    schema: 'workflow-bundle', version: 1, id: 'schema01',
    kind: 'workflow', name: 'n', startedAt: null, finishedAt: null,
    data: { exportDataComplete: true, members: [], relations: [] },
  };
}

const SCHEMA_TEXT = fs.readFileSync(SCHEMA_SRC, 'utf-8');

describe('validateWithBundleSchema', () => {
  it('schema 文件可信但 manifest.schema 错误时由 JSON Schema 拒绝', () => {
    const m = { ...validManifest(), schema: 'context.workflow-bundle' };
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      const result = validateWithBundleSchema(dir, m);
      expect(result.ok).toBe(false);
      expect(result.errors.join('|')).toContain('schema');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schema 文件可信但 manifest.version 错误时由 JSON Schema 拒绝', () => {
    const m = { ...validManifest(), version: 2 };
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      const result = validateWithBundleSchema(dir, m);
      expect(result.ok).toBe(false);
      expect(result.errors.join('|')).toContain('version');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('包内无 workflow.schema.json → 拒绝（不回落手写）', () => {
    const dir = makeBundle({ 'workflow.json': JSON.stringify(validManifest()) });
    try {
      const r = validateWithBundleSchema(dir, validManifest());
      expect(r.ok).toBe(false);
      expect(r.errors.join('|')).toContain('缺少 workflow.schema.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('合法 manifest 通过包内 schema', () => {
    const m = validManifest();
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      expect(validateWithBundleSchema(dir, m)).toEqual({ ok: true, errors: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('graph role 属于自由 annotation，schema 不硬编码它', () => {
    const m = validManifest();
    (m.data as { members: unknown[] }).members = [{
      id: 'm1', kind: 'process', name: 'x', startedAt: null, finishedAt: null,
      nodeId: 'n', generation: 0, attempt: 1,
    }];
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      const r = validateWithBundleSchema(dir, m);
      expect(r?.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schema 文件坏 JSON → 拒绝并说明包内 schema 不可解析', () => {
    const dir = makeBundle({ 'workflow.json': JSON.stringify(validManifest()), 'workflow.schema.json': '{ not json' });
    try {
      const r = validateWithBundleSchema(dir, validManifest());
      expect(r?.ok).toBe(false);
      expect(r?.errors.join('|')).toContain('不可解析');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateBundleDir 集成', () => {
  it('接受单会话 Run 的 handoff 关系', () => {
    const manifest = validManifest();
    (manifest.data as { members: unknown[]; relations: unknown[] }).members = [
      { id: 'a', kind: 'session', sessionId: 'a', location: null, startedAt: null, finishedAt: null },
      { id: 'b', kind: 'session', sessionId: 'b', location: null, startedAt: null, finishedAt: null },
    ];
    (manifest.data as { relations: unknown[] }).relations = [
      { from: 'a', to: 'b', type: 'handoff' },
    ];
    const dir = makeBundle({
      'workflow.json': JSON.stringify(manifest),
      'workflow.schema.json': SCHEMA_TEXT,
    });
    try {
      const result = validateBundleDir(dir);
      expect(result.ok).toBe(true);
      expect(buildIndex(result.manifest!).relations.map(r => r.raw.type)).toEqual(['handoff']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Opsbot 新契约样例经真实导入校验、索引和图模型读取', () => {
    const manifest = fs.readFileSync(OPSBOT_FIXTURE, 'utf-8');
    const dir = makeBundle({ 'workflow.json': manifest, 'workflow.schema.json': SCHEMA_TEXT });
    try {
      const result = validateBundleDir(dir);
      expect(result.ok).toBe(true);
      expect(result.manifest?.schema).toBe('workflow-bundle');
      const index = buildIndex(result.manifest!);
      expect(index.graphMembers).toHaveLength(4);
      expect(index.relations.map(r => r.raw.type)).toEqual(['depends_on', 'rollback', 'depends_on', 'depends_on']);
      const view = buildViewModel(index);
      expect(findNodeInstance(view, 'build', 0)?.attempts[0].verifyMember?.sessionId).toBe('ses_verify');
      expect(findNodeInstance(view, 'publish', 1)?.executionState).toBe('carried');
      expect(findNodeInstance(view, 'gen', 0)?.attempts).toHaveLength(1);
      expect(findNodeInstance(view, 'gen', 0)?.taskType).toBe('workflow');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('workflow 成员的子图节点进入该 workflow 自己的子视图', () => {
    const m = JSON.parse(fs.readFileSync(OPSBOT_FIXTURE, 'utf-8')) as {
      data: { members: Array<{ kind: string; data?: { members: Array<Record<string, unknown>> } }> };
    };
    const workflow = m.data.members.find(member => member.kind === 'workflow')!;
    Object.assign(workflow.data!.members[0], {
      nodeId: 'gen:sub', generation: 0, attempt: 1,
      executionState: 'finished', annotation: { role: 'execute' },
    });
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      const result = validateBundleDir(dir);
      expect(result.ok).toBe(true);
      const view = buildViewModel(buildIndex(result.manifest!));
      const parent = findNodeInstance(view, 'gen', 0)!;
      const child = findNodeInstance(view, 'gen:sub', 0)!;
      expect(parent.hasSubgraph).toBe(true);
      expect(child.parentKey).toBe(parent.key);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('data.members 和 data.relations 缺省时按空集合读取', () => {
    const m = validManifest();
    m.data = {};
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      const result = validateBundleDir(dir);
      expect(result.ok).toBe(true);
      expect(buildIndex(result.manifest!).members).toEqual([]);
      expect(buildIndex(result.manifest!).relations).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('伪造者保留 draft-07 和 $id 但放宽包内 schema → 导入入口拒绝', () => {
    const m = validManifest();
    delete m.kind;
    const forgedSchema = JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'urn:workflow-bundle:v1',
      type: 'object',
    });
    const dir = makeBundle({
      'workflow.json': JSON.stringify(m),
      'workflow.schema.json': forgedSchema,
    });
    try {
      const result = validateBundleDir(dir);
      expect(result).toMatchObject({ ok: false, status: 400, reason: 'bundle-manifest-schema-invalid' });
      expect(result.error).toContain('与 Insight 信任的 schema 哈希不一致');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('包内带 schema 且结构非法 → 400 结构不符 schema（结构权威前移）', () => {
    const m = validManifest();
    (m.data as { members: unknown[] }).members = [{
      id: 'm1', kind: 'session', name: 'x', startedAt: null, finishedAt: null,
      // 缺 location 键：reader 只做「半空」警告，schema 要求必填
      sessionId: 'ses_x',
      nodeId: 'n', generation: 0, attempt: 1, annotation: { role: 'execute' },
    }];
    const dir = makeBundle({
      'workflow.json': JSON.stringify(m),
      'workflow.schema.json': SCHEMA_TEXT,
      'sessions/ses_x.native/ses_x.jsonl': '',
    });
    try {
      expect(validateBundleDir(dir)).toMatchObject({
        ok: false, status: 400, reason: 'bundle-manifest-schema-invalid',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('包内带 schema 且结构合法 → 跨节点（悬空关系）仍由 buildIndex 拒绝', () => {
    const m = validManifest();
    (m.data as { members: unknown[] }).members = [{
      id: 'm1', kind: 'process', name: 'x', startedAt: null, finishedAt: null,
    }];
    (m.data as { relations: unknown[] }).relations = [{ from: 'm1', to: 'GHOST' }];
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      expect(validateBundleDir(dir)).toMatchObject({ ok: false, status: 400, reason: 'bundle-manifest-invalid' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('包内带 schema 且结构 + 跨节点均合法 → 通过', () => {
    const m = validManifest();
    (m.data as { members: unknown[] }).members = [{
      id: 'm1', kind: 'process', name: 'x', startedAt: null, finishedAt: null,
    }];
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      const v = validateBundleDir(dir);
      expect(v.ok).toBe(true);
      expect(v.manifest?.id).toBe('schema01');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
