// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 子代理标题双格式解析回归锁：真机湖数据标题为
// 'P1 需求分析 (@ascendc-ops-architect subagent)'（新序，连字符全名），旧版
// opencode 为 '@(build) subagent: scan logs'。旧代码只认 '@(name)' 序 → 新序
// 永不命中；fallback @(\w+) 在首个连字符截断（'ascendc-ops-architect' →
// 'ascendc'）。本用例经 v2 reader 全链验证双格式 + 全名捕获。

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readSession } from '@/lib/ingest/adapters/opencode-db';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-title-regex-'));

function buildDb(name: string, title: string): string {
  const dbPath = path.join(TMP, name);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY, project_id text NOT NULL, parent_id text, title text,
      version text NOT NULL, directory text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      summary_additions integer, summary_deletions integer, summary_files integer,
      agent text, model text
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
      seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('ses_title_main', 'global', null, 'main', '2.0.18', '/p', 1790000000000, 1790000001000, 0, 0, 0, null, null);
  db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('ses_title_sub', 'global', 'ses_title_main', title, '2.0.18', '/p', 1790000002000, 1790000003000, 0, 0, 0, null, null);
  db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)')
    .run('msg_title_1', 'ses_title_sub', 'assistant', 1, 1790000002000, 1790000002500,
      JSON.stringify({
        time: { created: 1790000002000, completed: 1790000002500 },
        agent: 'whatever-agent',
        model: { id: 'm1', providerID: 'gw' },
        finish: 'stop',
        content: [{ type: 'text', text: '产出内容' }],
      }));
  db.close();
  return dbPath;
}

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('opencode 子代理标题双格式解析', () => {
  it('新序（湖数据实测）：(@ascendc-ops-architect subagent) → 连字符全名', () => {
    const db = buildDb('new-order.db', 'P1 需求分析 (@ascendc-ops-architect subagent)');
    const rows = readSession(db, 'ses_title_sub');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.subagent_name).toBe('ascendc-ops-architect');
  });

  it('旧序（v2 夹具既有形态）：@(build) subagent: scan logs → build（回归）', () => {
    const db = buildDb('old-order.db', '@(build) subagent: scan logs');
    const rows = readSession(db, 'ses_title_sub');
    expect(rows[0]!.subagent_name).toBe('build');
  });

  it('新序简名：(@build subagent) → build', () => {
    const db = buildDb('simple.db', '扫日志 (@build subagent)');
    const rows = readSession(db, 'ses_title_sub');
    expect(rows[0]!.subagent_name).toBe('build');
  });

  it('无标记标题 → null（不误猜）', () => {
    const db = buildDb('no-marker.db', '普通子会话标题');
    const rows = readSession(db, 'ses_title_sub');
    expect(rows[0]!.subagent_name).toBeNull();
  });
});
