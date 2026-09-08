// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D3 评分器：testResults/nakedWrite 代码直算 + 五项 LLM（BandJudge 实例化）+ CANN-Bench 评分（用户填报）。

import { Scorer, okResult, notApplicable, ev, round2, type ScorerContext } from '../core/scorer';
import type { SubItemResult } from '../core/types';
import { BandJudgeScorer } from '../core/judge';
import { OpBenchScorer } from '../core/op-bench/scorer';
import { findLastVerifiedRun, lastWriteSeq } from '../core/test-parser';
import { extractFilePath } from '@/lib/file-restore';

import { d3Focus } from './definition';

// ── D3.testResults 测试结果（部分失败给部分分）────────────────

class TestResultsScorer extends Scorer {
  readonly id = 'D3.testResults';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const writeFamilies = new Set(['write', 'edit', 'edit1', 'multiedit']);
    const since = lastWriteSeq(ctx.input.toolCalls, tc => writeFamilies.has(tc.toolName.toLowerCase()) && extractFilePath(tc.argsJson) != null);
    const last = findLastVerifiedRun(ctx.input.toolCalls, { sinceSeq: since });
    if (!last || !last.summary) {
      return notApplicable(ctx.def, '缺少改代码后的测试运行，无法评判');
    }
    const { call, summary } = last;
    const total = summary.passed + summary.failed;
    const score = total === 0 ? null : summary.passed / total;
    return okResult(ctx.def, {
      status: total === 0 ? 'not-applicable' : 'ok',
      value: `${summary.passed}✓/${summary.failed}✗`,
      unit: 'tests',
      score,
      formula: `§${call.turnIndex} ${summary.framework}：通过 ${summary.passed} / 失败 ${summary.failed} → 通过率 ${score == null ? '—' : round2(score)}`,
      evidence: [ev(call.turnIndex, `${summary.framework} 测试运行`)],
      note: total === 0 ? '只有跳过，无有效用例' : undefined,
    });
  }
}

// ── D3.nakedWrite 不读就写（v1 computeNakedWrite 迁移）──────

const VERIFY_CMD_RE = /(test|vitest|jest|pytest|build|make|compile|npm\s+run|lint)/i;

class NakedWriteScorer extends Scorer {
  readonly id = 'D3.nakedWrite';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const toolCalls = ctx.input.toolCalls;
    const isWriteFamily = (name: string) => ['write', 'edit', 'edit1', 'multiedit'].includes(name.toLowerCase());
    const writes = toolCalls.filter(tc => isWriteFamily(tc.toolName) && extractFilePath(tc.argsJson) !== null);
    if (writes.length === 0) return notApplicable(ctx.def, '缺少文件写操作，无法评判');

    let naked = 0;
    const evidence: SubItemResult['evidence'] = [];
    for (const w of writes) {
      const file = extractFilePath(w.argsJson)!;
      const nextSameFileWrite = writes.find(x => x.seq > w.seq && extractFilePath(x.argsJson) === file);
      const windowEnd = nextSameFileWrite ? nextSameFileWrite.seq : Infinity;
      const verified = toolCalls.some(tc =>
        tc.seq > w.seq
        && tc.seq < windowEnd
        && (
          (tc.toolName.toLowerCase() === 'read' && extractFilePath(tc.argsJson) === file)
          || (tc.toolName.toLowerCase() === 'bash' && VERIFY_CMD_RE.test(tc.argsJson ?? ''))
        ),
      );
      if (!verified) {
        naked++;
        evidence.push(ev(w.turnIndex, `${w.toolName} ${file}：写后无同文件 Read、无 test/build 命令`));
      }
    }
    const ratio = naked / writes.length;
    return okResult(ctx.def, {
      value: round2(ratio),
      unit: 'ratio',
      score: round2(1 - ratio),
      formula: `不读就写率 = 无验证写入 / 总写入 = ${naked} / ${writes.length} = ${round2(ratio)} → 得分 ${round2(1 - ratio)}`,
      evidence: evidence.slice(0, 8),
    });
  }
}

// ── LLM 五项 + CANN-Bench 评分（用户填报）──────────────────

function bandScorer(id: string): Scorer {
  return new BandJudgeScorer(
    { id, dimension: 'D3', name: id, scorerKind: 'llm' },
    {
      focus: d3Focus[id] ?? id,
    },
  );
}

export function d3Scorers(): Scorer[] {
  return [
    new TestResultsScorer(),
    new NakedWriteScorer(),
    bandScorer('D3.correctness'),
    bandScorer('D3.instruction'),
    bandScorer('D3.robustness'),
    bandScorer('D3.maintainability'),
    bandScorer('D3.safeCoding'),
    new OpBenchScorer({ id: 'D3.cannBench', dimension: 'D3', name: 'CANN-Bench 评分', scorerKind: 'user-input' }),
  ];
}
