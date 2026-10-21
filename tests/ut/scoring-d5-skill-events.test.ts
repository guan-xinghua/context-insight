// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D5.skills 口径 IT（端到端：fixture → 导入管线 → runScorecard）：
//   ① 斜杠命令调用的技能算「已用」——slash 通道无工具调用，used 集合此前只扫
//      toolCalls，把真实用过的技能全算成未用（现场：day0 会话 12 个全未用、
//      day0-inference 明明 /day0-inference 加载过）
//   ② CLI 内置技能（不可控：装了 CLI 就有）剔除出评价口径，公式公示剔除数；
//      全为内置时整项不适用
// 夹具（scoring-d5-slash.jsonl）：可用列表 4 个——day0-inference（自定义，
// 斜杠调用 → 已用）、ops-analysis（自定义，未用）、code-review + dataviz
// （CLI 内置，未用 → 剔除）。期望：skill 2 个（剔 2 个CLI 内置）、未用 1 个。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service';
import { runScorecard } from '../../src/lib/scoring/core/runner';
import { FileScorecardStore } from '../../src/lib/scoring/core/store';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-d5-skill-'));
process.env.SCORING_DATA_DIR = path.join(TMP, 'api-store');
process.env.SCORING_BASELINE_DIR = path.join(TMP, 'baselines');
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');
const store = new FileScorecardStore(path.join(TMP, 'scorecards'));

const SID = 'scoring-d5-slash-0001TestSessionXy';
const FIXTURE = path.resolve(__dirname, 'data/claude-sessions/scoring-d5-slash.jsonl');

afterAll(async () => { await prisma.$disconnect() });

describe('D5.skills：斜杠调用算已用 + CLI 内置剔除', () => {
  it('slash invoke 的技能不进未用清单；内置技能剔除且公式公示', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID } });
    const r = await importSession(FIXTURE, SID, prisma, FIXTURE, 'claude-jsonl');
    expect(r.imported).toBe(true);

    // 前置：斜杠 invoke 确实落了事件（无工具调用通道）
    const invoke = await prisma.skillEvent.count({
      where: { turn: { session: { taskId: SID } }, skillName: 'day0-inference', eventType: 'invoke' },
    });
    expect(invoke).toBe(1);

    const card = await runScorecard(SID, prisma, { store });
    expect(card).not.toBeNull();
    const item = card!.dimensions.find(d => d.dimensionId === 'D5')!.items.find(i => i.itemId === 'D5.skills')!;
    expect(item.status).toBe('ok');
    // 自定义 2 个（day0-inference 已用、ops-analysis 未用），内置 2 个剔除
    expect(item.formula).toContain('skill 2 个');
    expect(item.formula).toContain('剔 2 个CLI 内置');
    expect(item.formula).toContain('未用 1 个');
    const evidenceText = (item.evidence ?? []).map(e => `${e.label ?? ''}${e.quote ?? ''}`).join(' ');
    expect(evidenceText).toContain('ops-analysis');
    expect(evidenceText).not.toContain('day0-inference');
    expect(evidenceText).not.toContain('code-review');
    expect(evidenceText).not.toContain('dataviz');
  });
});
