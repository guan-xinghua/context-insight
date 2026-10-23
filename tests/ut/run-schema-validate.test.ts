// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 包内 workflow.schema.json（draft-07）结构校验 IT：结构权威随包分发，
// 手写校验只保留 schema 表达不了的跨节点检查（id 唯一、关系端点解析）
// 与 version 闸。fixture schema 与 opsbot 导出件同源（tests/ut/data/run/
// workflow-bundle.v1.schema.json）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWithBundleSchema } from '@/lib/run/schema-validate';
import { validateBundleDir } from '@/lib/run/import-service';

const SCHEMA_SRC = path.resolve(__dirname, './data/run/workflow-bundle.v1.schema.json');

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
    schema: 'context.workflow-bundle', version: 1, id: 'schema01',
    kind: 'workflow', name: 'n', startedAt: null, finishedAt: null,
    data: { exportDataComplete: true, members: [], relations: [] },
  };
}

const SCHEMA_TEXT = fs.readFileSync(SCHEMA_SRC, 'utf-8');

describe('validateWithBundleSchema', () => {
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

  it('graph 注解缺 role（手写会容忍降级）→ schema 拒绝并定位 dataPath', () => {
    const m = validManifest();
    (m.data as { members: unknown[] }).members = [{
      id: 'm1', kind: 'process', name: 'x', startedAt: null, finishedAt: null,
      annotation: { graph: { nodeId: 'n', generation: 0, attempt: 1 } },
    }];
    const dir = makeBundle({ 'workflow.json': JSON.stringify(m), 'workflow.schema.json': SCHEMA_TEXT });
    try {
      const r = validateWithBundleSchema(dir, m);
      expect(r?.ok).toBe(false);
      expect(r?.errors.join('|')).toContain('role');
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
  it('包内带 schema 且结构非法 → 400 结构不符 schema（结构权威前移）', () => {
    const m = validManifest();
    (m.data as { members: unknown[] }).members = [{
      id: 'm1', kind: 'session', name: 'x', startedAt: null, finishedAt: null,
      // 缺 location 键：reader 只做「半空」警告，schema 要求必填
      sessionId: 'ses_x',
      annotation: { graph: { role: 'execute', nodeId: 'n', generation: 0, attempt: 1 } },
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