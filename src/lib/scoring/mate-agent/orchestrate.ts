// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Mode A 编排：服务端起独立 agent 进程，每维一个，并发池内并行，再合并成整卡材料。
// 维度清单自适应评分配置：传入注册表 defs 时按「有 LLM 子项的维度」派（D4 /
// 整维取消的不派；D7 用户维度照派），缺省回落内置五维。

import type { PrismaClient } from '@prisma/client';
import { MATE_DIMENSIONS, runMateAgentDimension, mateDimensionsOf, llmItemsOf, dimensionLabel, type MateAgentRunOptions } from './runner';
import type { MateAgentParsed, MateAgentItem } from './coerce';

export interface OrchestrateProgress {
  done: number;
  total: number;
  current: string;
}

export interface OrchestrateResult {
  parsed: MateAgentParsed;
  totalMs: number;
  /** 各维解析失败信息（维度 -> 失败原因） */
  failures: Record<string, string>;
}

/**
 * 慢维优先启动顺序（值越小越先）：要读工具调用/产物文件、或数数型判定的维度
 * 更耗时——正确性 D3（读产物+check 输出）最慢，其次完成度 D1、可信 D2；冗余 D5/
 * 效率 D4（summary 预计算）与自主性 D6（仅用户消息）最快。worker 池用 cursor
 * 抢占——任一维完成，空出的 slot 立刻拉下一个维，无需等整波。
 */
const DIM_START_ORDER: Record<string, number> = { D3: 0, D1: 1, D2: 2, D5: 3, D6: 4 };

export async function runMateAgentOrchestrated(
  taskId: string,
  prisma: PrismaClient,
  opts: MateAgentRunOptions & { concurrency?: number },
  onProgress?: (p: OrchestrateProgress) => void,
): Promise<OrchestrateResult> {
  const dims = (opts.defs ? mateDimensionsOf(opts.defs) : [...MATE_DIMENSIONS])
    .sort((a, b) => (DIM_START_ORDER[a] ?? 9) - (DIM_START_ORDER[b] ?? 9));
  const results = new Map<string, MateAgentItem[] | null>();
  const failures: Record<string, string> = {};
  let cursor = 0;
  let done = 0;
  const t0 = Date.now();

  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= dims.length) return;
      const dim = dims[idx];
      let items: MateAgentItem[] | null = null;
      try {
        const r = await runMateAgentDimension(taskId, prisma, dim, opts, opts.defs ? llmItemsOf(opts.defs, dim) : []);
        items = r.items;
        if (r.parseError) failures[dim] = r.parseError;
      } catch (err) {
        items = null;
        failures[dim] = err instanceof Error ? err.message : '运行失败';
      }
      results.set(dim, items);
      done++;
      onProgress?.({ done, total: dims.length, current: `${dim} ${dimensionLabel(opts.defs, dim)}` });
    }
  };

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, dims.length));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const parsed: MateAgentParsed = {
    summary: '',
    dimensions: dims.map(dim => ({ dimensionId: dim, items: results.get(dim) ?? [] })),
  };
  return { parsed, totalMs: Date.now() - t0, failures };
}