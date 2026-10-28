// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 原生会话对位发现 IT（native-counterpart）：数据仓上传「同步上传原生会话」
// 的解析层。覆盖两级策略全框架：
//   ① DB 直查：同 sid 原生行命中（claude-code / opencode / cannbot / dsh）
//   ② 磁盘发现：claude 递归三形态 / dsh 固定代际名 / opencode 存储族查库 /
//      codex 时间窗 + 首问锚点（cpx sid ≠ rollout uuid，唯一命中才收）
//   ③ 拒绝面：非捕获行、未知框架、窗口内无匹配 / 多候选不确定
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { resolveNativeCounterpart, defaultNativeDiscoveryRoots } from '../../src/lib/ingest/native-counterpart';
import { materializeV1Fixture } from '../helpers/materialize-v1-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'native-counterpart-it-'));
const OPENCODE_DB = materializeV1Fixture('native-counterpart');
const OPENCODE_SID = 'ses_2051a32a4ffevX0jGBWVDDEqCk';

const CLAUDE_SID = 'nc-it-claude-0001';
const DSH_SID = 'nc-it-dsh-0001';
const CODEX_SID = 'nc-it-codex-0001';
const CODEX_UUID = 'cccc0dec-uuid-0001';
const ANCHOR = 'codex 锚点问题：帮我定位原生会话';

function emptyRoots() {
  return {
    claude: path.join(TMP, 'empty-claude'),
    codex: path.join(TMP, 'empty-codex'),
    dsh: path.join(TMP, 'empty-dsh'),
    opencode: [path.join(TMP, 'empty-opencode')],
  };
}

// claude 原生日志：~/.claude/projects/<cwd-slug>/<sid>.jsonl（子目录递归形态）
fs.mkdirSync(path.join(TMP, 'claude', 'proj-slug'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'claude', 'proj-slug', `${CLAUDE_SID}.jsonl`),
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'claude 原生首问' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
  ].join('\n') + '\n',
);

// DSH 原生日志：<root>/<encoded-cwd>/<sid>/session.v4.jsonl
fs.mkdirSync(path.join(TMP, 'dsh', 'encoded-cwd', DSH_SID), { recursive: true });
fs.writeFileSync(path.join(TMP, 'dsh', 'encoded-cwd', DSH_SID, 'session.v4.jsonl'), '');

// codex rollout：<root>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl，首问 = 锚点
function rolloutLines(firstUser: string): string {
  return [
    JSON.stringify({ timestamp: '2026-10-24T01:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstUser }] } }),
    JSON.stringify({ timestamp: '2026-10-24T01:00:05.000Z', type: 'token_usage_record', payload: { usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join('\n') + '\n';
}
fs.mkdirSync(path.join(TMP, 'codex', '2026', '10', '24'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'codex', '2026', '10', '24', `rollout-2026-10-24T01-00-00-${CODEX_UUID}.jsonl`), rolloutLines(ANCHOR));
// 干扰项：窗口内但首问不匹配（如子代理 rollout）
fs.writeFileSync(path.join(TMP, 'codex', '2026', '10', '24', 'rollout-2026-10-24T01-02-00-dddd0dec-uuid-0002.jsonl'), rolloutLines('子代理任务提示词，与捕获首问无关'));
// 干扰项：首问匹配但不在时间窗（mtime 压到窗口外）
const oldDir = path.join(TMP, 'codex', '2026', '01', '01');
fs.mkdirSync(oldDir, { recursive: true });
const oldFile = path.join(oldDir, 'rollout-2026-01-01T01-00-00-eeee0dec-uuid-0003.jsonl');
fs.writeFileSync(oldFile, rolloutLines(ANCHOR));
fs.utimesSync(oldFile, new Date(Date.now() - 90 * 24 * 3600 * 1000), new Date(Date.now() - 90 * 24 * 3600 * 1000));

function roots() {
  return {
    claude: path.join(TMP, 'claude'),
    codex: path.join(TMP, 'codex'),
    dsh: path.join(TMP, 'dsh'),
    opencode: [path.dirname(OPENCODE_DB)],
  };
}

const ALL_SIDS = [CLAUDE_SID, DSH_SID, CODEX_SID, OPENCODE_SID, 'nc-it-db-0001'];

afterAll(async () => {
  for (const sid of ALL_SIDS) {
    await prisma.session.deleteMany({ where: { taskId: sid } }).catch(() => {});
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(path.dirname(OPENCODE_DB), { recursive: true, force: true });
});

describe('原生会话对位发现：DB 直查（策略①）', () => {
  it('同 sid 原生行命中（origin=db），磁盘根为空也不受影响', async () => {
    await prisma.session.create({ data: { taskId: 'nc-it-db-0001', framework: 'claude-code', query: 'q', sourcePath: null } });
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: 'nc-it-db-0001', framework: 'claude-code-proxy', startTime: new Date(), endTime: new Date(), query: 'q' },
      emptyRoots(),
    );
    expect(r).toEqual({ status: 'found', origin: 'db', taskId: 'nc-it-db-0001', framework: 'claude-code' });
  });

  it('非捕获行（无 -proxy 后缀）直接拒绝', async () => {
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: 'nc-it-db-0001', framework: 'claude-code', startTime: new Date(), endTime: new Date(), query: 'q' },
      emptyRoots(),
    );
    expect(r.status).toBe('not-found');
    if (r.status === 'not-found') expect(r.reason).toContain('仅支持从 wire 捕获行');
  });
});

describe('原生会话对位发现：磁盘发现（策略②）', () => {
  it('claude：projects 子目录递归命中 <sid>.jsonl', async () => {
    await prisma.session.deleteMany({ where: { taskId: CLAUDE_SID } });
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: CLAUDE_SID, framework: 'claude-code-proxy', startTime: new Date(), endTime: new Date(), query: 'claude 原生首问' },
      roots(),
    );
    expect(r.status).toBe('found');
    if (r.status === 'found' && r.origin === 'disk') {
      expect(r.hit.sourceType).toBe('claude-jsonl');
      expect(r.hit.sessionId).toBe(CLAUDE_SID);
      expect(r.hit.path).toContain(CLAUDE_SID);
    } else throw new Error('expected disk hit');
  });

  it('dsh：<encoded-cwd>/<sid>/session.v4.jsonl 命中', async () => {
    await prisma.session.deleteMany({ where: { taskId: DSH_SID } });
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: DSH_SID, framework: 'dsh-proxy', startTime: new Date(), endTime: new Date(), query: 'q' },
      roots(),
    );
    expect(r.status).toBe('found');
    if (r.status === 'found' && r.origin === 'disk') {
      expect(r.hit.sourceType).toBe('dsh-native');
      expect(r.hit.path).toContain('session.v4.jsonl');
    } else throw new Error('expected disk hit');
  });

  it('opencode：存储根 .db 查会话表按 sid 命中', async () => {
    await prisma.session.deleteMany({ where: { taskId: OPENCODE_SID } });
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: OPENCODE_SID, framework: 'opencode-proxy', startTime: new Date(), endTime: new Date(), query: 'q' },
      roots(),
    );
    expect(r.status).toBe('found');
    if (r.status === 'found' && r.origin === 'disk') {
      expect(r.hit.sourceType).toBe('opencode-db');
      expect(r.hit.sessionId).toBe(OPENCODE_SID);
    } else throw new Error('expected disk hit');
  });

  it('codex：时间窗 + 首问锚点唯一命中（sid ≠ 捕获 sid，窗口外同名首问不算）', async () => {
    await prisma.session.deleteMany({ where: { taskId: CODEX_SID } });
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: CODEX_SID, framework: 'codex-proxy', startTime: new Date(Date.now() - 60_000), endTime: new Date(), query: ANCHOR },
      roots(),
    );
    expect(r.status).toBe('found');
    if (r.status === 'found' && r.origin === 'disk') {
      expect(r.hit.sourceType).toBe('codex-jsonl');
      expect(r.hit.sessionId).toBe(CODEX_UUID);
    } else throw new Error('expected disk hit');
  });

  it('codex：窗口内无锚点匹配 → not-found（子代理 rollout 不误收）', async () => {
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: CODEX_SID, framework: 'codex-proxy', startTime: new Date(Date.now() - 60_000), endTime: new Date(), query: '完全不相关的首问' },
      roots(),
    );
    expect(r.status).toBe('not-found');
    if (r.status === 'not-found') expect(r.reason).toContain('没有首问内容匹配');
  });

  it('codex：多候选命中 → not-found（不确定就不猜）', async () => {
    fs.writeFileSync(path.join(TMP, 'codex', '2026', '10', '24', 'rollout-2026-10-24T01-03-00-ffff0dec-uuid-0004.jsonl'), rolloutLines(ANCHOR));
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: CODEX_SID, framework: 'codex-proxy', startTime: new Date(Date.now() - 60_000), endTime: new Date(), query: ANCHOR },
      roots(),
    );
    expect(r.status).toBe('not-found');
    if (r.status === 'not-found') expect(r.reason).toContain('无法确定对应关系');
  });
});

describe('原生会话对位发现：拒绝面', () => {
  it('未知框架：注册表无发现器 → not-found', async () => {
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: 'nc-it-x', framework: 'unknown-fw-proxy', startTime: new Date(), endTime: new Date(), query: 'q' },
      roots(),
    );
    expect(r.status).toBe('not-found');
    if (r.status === 'not-found') expect(r.reason).toContain('暂不支持');
  });

  it('claude 根为空 → not-found 带根路径提示', async () => {
    const r = await resolveNativeCounterpart(
      prisma,
      { taskId: 'nc-it-missing', framework: 'claude-code-proxy', startTime: new Date(), endTime: new Date(), query: 'q' },
      emptyRoots(),
    );
    expect(r.status).toBe('not-found');
    if (r.status === 'not-found') expect(r.reason).toContain('未找到');
  });

  it('默认根与注入根同构（smoke：默认根可构造且四根齐备）', () => {
    const r = defaultNativeDiscoveryRoots();
    expect(r.claude).toContain('.claude');
    expect(r.codex).toContain('.codex');
    expect(r.dsh).toContain('.dsh');
    expect(r.opencode.length).toBeGreaterThan(0);
  });
});
