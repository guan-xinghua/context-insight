// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// IT：claude-code 斜杠命令技能调用（/skill 展开形态）计数闭环。
// 现场问题：/demo-inference 以 <command-name> 标签 + skill 注入 system 轮
// 加载（无工具调用），skills 统计不计。验证链路：
// jsonl 夹具 → claude-jsonl adapter（注入重分类 system）→ turn-split
// （斜杠命令 invoke SkillEvent）→ aggregates（sessionSkillsData 进账）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readSession } from '../../src/lib/ingest/adapters/claude-jsonl.ts';
import { splitIntoTurns, resetIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { prisma } from '../setup';
import path from 'node:path';

const FIXTURE_DIR = path.resolve(__dirname, './data/claude-sessions');
const SLASH_SKILL_FILE = path.join(FIXTURE_DIR, 'slash-skill-invoke.jsonl');
const IMPORT_SID = 'slash-skill-invoke-it';

describe('slash-command skill invocation', () => {
  let interactions: ReturnType<typeof readSession>;
  let result: ReturnType<typeof splitIntoTurns>;

  beforeAll(async () => {
    resetIdCounter();
    interactions = readSession(SLASH_SKILL_FILE, 'slash-skill-invoke');
    result = splitIntoTurns(interactions, 'session-slash-skill-invoke-test');

    await prisma.session.deleteMany({ where: { taskId: IMPORT_SID } }).catch(() => {});
    await importSession(SLASH_SKILL_FILE, IMPORT_SID, prisma, SLASH_SKILL_FILE, 'claude-jsonl');
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { taskId: IMPORT_SID } }).catch(() => {});
  });

  // ── Adapter: 注入行重分类 system ──

  describe('adapter layer', () => {
    it('keeps command-tag user turn as user role', () => {
      const cmdTurn = interactions.find(i => (i.content ?? '').includes('<command-name>/demo-inference</command-name>'));
      expect(cmdTurn).toBeDefined();
      expect(cmdTurn!.role).toBe('user');
    });

    it('reclassifies skill body injection into a system turn', () => {
      const inj = interactions.find(i => (i.content ?? '').includes('Base directory for this skill'));
      expect(inj).toBeDefined();
      expect(inj!.role).toBe('system');
    });
  });

  // ── turn-split: 斜杠命令 SkillEvent ──

  describe('turn-split: slash SkillEvent', () => {
    it('creates invoke SkillEvent for /demo-inference', () => {
      const ev = result.skillEvents.find(se => se.skillName === 'demo-inference');
      expect(ev).toBeDefined();
      expect(ev!.eventType).toBe('invoke');
      expect(ev!.success).toBe(true);
    });

    it('carries command args in argsJson', () => {
      const ev = result.skillEvents.find(se => se.skillName === 'demo-inference');
      expect(ev!.argsJson).toContain('Kimi-K3');
      expect(ev!.argsJson).toContain('tpot');
    });

    it('anchors the event on the user command turn', () => {
      const ev = result.skillEvents.find(se => se.skillName === 'demo-inference');
      const ownerTurn = result.turns.find(t => t.id === ev!.turnId);
      expect(ownerTurn).toBeDefined();
      expect(ownerTurn!.role).toBe('user');
      expect(ownerTurn!.content).toContain('<command-name>/demo-inference</command-name>');
    });

    it('does not count built-in local commands (no injection follows)', () => {
      const builtin = result.skillEvents.find(se => se.skillName === 'skills');
      expect(builtin).toBeUndefined();
      expect(result.skillEvents.filter(se => se.skillName === 'demo-inference').length).toBe(1);
    });
  });

  // ── DB 落库：skills 统计数据源（SkillEvent 表）进账 ──

  describe('import + DB roundtrip', () => {
    it('persists the slash invoke SkillEvent row', async () => {
      const events = await prisma.skillEvent.findMany({
        where: { turn: { session: { taskId: IMPORT_SID } } },
      });
      const ev = events.find(e => e.skillName === 'demo-inference');
      expect(ev).toBeDefined();
      expect(ev!.eventType).toBe('invoke');
      expect(ev!.success).toBe(true);
      expect(ev!.argsJson).toContain('Kimi-K3');
    });

    it('persists no SkillEvent for the built-in command', async () => {
      const events = await prisma.skillEvent.findMany({
        where: { turn: { session: { taskId: IMPORT_SID } } },
      });
      expect(events.filter(e => e.skillName === 'skills').length).toBe(0);
      expect(events.length).toBe(1);
    });
  });
});
