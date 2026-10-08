// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// P2 加固回归：① scorecardStore 并发写串行化（读-归档-替换序列互斥，多并发
// 触发源下不再 ENOENT/tmp 互踩）；② TrackedLlmClient 成本记账按每次真实消耗
// 累计（截断升预算重试的前几响应也花钱，曾只在最终成功 attempt 记账）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileScorecardStore } from '../../src/lib/scoring/core/store';
import { TrackedLlmClient } from '../../src/lib/scoring/core/llm';
import type { AIProviderConfig } from '../../src/lib/ai/analyzer';
import { SCORECARD_SCHEMA, type Scorecard } from '../../src/lib/scoring/core/types';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-store-llm-'));

function mkCard(sessionId: string, computedAt: string): Scorecard {
  return {
    schemaVersion: SCORECARD_SCHEMA,
    sessionId,
    taskType: 'operator',
    computedAt,
    status: 'completed',
    framework: { totalScore: 0.5, veto: null, coverage: 1, weightsUsed: {} },
    dimensions: [],
    judgeCost: null,
  };
}

describe('scorecardStore 并发写串行化', () => {
  afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true }); });

  it('同 sessionId 并发 put：全部成功、latest 是其中一张、其余全进 archive、无未处理拒绝', async () => {
    const store = new FileScorecardStore(TMP);
    const N = 8;
    const puts = Array.from({ length: N }, (_, i) =>
      store.put(mkCard('ses-concurrent', `2026-10-05T10:00:0${i}:00.000Z`)));
    await Promise.all(puts);   // 修复前：并发读-归档-替换交错，第二个 rename ENOENT 上抛

    const latest = await store.get('ses-concurrent');
    expect(latest).toBeTruthy();
    const archiveDir = path.join(TMP, 'archive', 'ses-concurrent');
    const archived = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
    expect(archived).toHaveLength(N - 1);   // 全部串行归档，零丢失
  });
});

describe('TrackedLlmClient 成本记账（每次真实消耗）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('截断升预算重试：前几次响应的 usage 也进 calls/tokens（曾只在最终成功 attempt 记账）', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        // 首次截断：正文有但 finish_reason=length → 升预算重试（这次的钱不能消失）
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 300 } }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' } as AIProviderConfig;
    const client = new TrackedLlmClient(provider);
    const out = await client.complete('sys', 'user');
    expect(out.content).toBe('{"a":1}');
    expect(client.cost()).toEqual({ calls: 2, tokens: 1000 + 500 + 1200 + 300 });
  });
});
