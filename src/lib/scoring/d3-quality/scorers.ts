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
import { findLastVerifiedRun, lastWriteSeq, isCodeWrite } from '../core/test-parser';
import { extractFilePath } from '@/lib/file-restore';

import { d3Focus } from './definition';

// ── D3.testResults 测试结果（部分失败给部分分）────────────────

class TestResultsScorer extends Scorer {
  readonly id = 'D3.testResults';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    // 改代码口径与 D1.verifiedRun 共用（isCodeWrite）：文档写不算——机检/测试
    // 跑完后只补报告的收尾不该把窗口推到最后、误判「缺测试运行」
    const since = lastWriteSeq(ctx.input.toolCalls, tc => isCodeWrite(tc.toolName, tc.argsJson));
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

const VERIFY_CMD_RE = /(test|vitest|jest|pytest|build|make|compile|npm\s+run|lint|check_[a-z0-9_.-]*|gate_lib|闸门)/i;

class NakedWriteScorer extends Scorer {
  readonly id = 'D3.nakedWrite';
  readonly needs = ['toolCalls'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const toolCalls = ctx.input.toolCalls;
    const isWriteFamily = (name: string) => ['write', 'edit', 'edit1', 'multiedit'].includes(name.toLowerCase());
    // 一次线性预扫建索引（此前每个写全量重扫 toolCalls——重编辑会话 O(n·m) 上千万次正则解析）：
    // readSeqsByFile / writeSeqsByFile 按 seq 升序（toolCalls 本身按序遍历），bashVerifySeqs 同
    const readSeqsByFile = new Map<string, number[]>();
    const writeSeqsByFile = new Map<string, number[]>();
    const bashVerifySeqs: number[] = [];
    const firstTouch = new Map<string, 'read' | 'write'>();
    for (const tc of toolCalls) {
      const name = tc.toolName.toLowerCase();
      // 核验命令不看成败（跑了就算核验过）；失败的调用不算触达也不进批次窗口（原口径）
      if (name === 'bash') {
        if (VERIFY_CMD_RE.test(tc.argsJson ?? '')) bashVerifySeqs.push(tc.seq);
        continue;
      }
      if (tc.state === 'error' || (name !== 'read' && !isWriteFamily(name))) continue;
      const p = extractFilePath(tc.argsJson);
      if (p == null) continue;
      if (name === 'read') {
        (readSeqsByFile.get(p) ?? readSeqsByFile.set(p, []).get(p)!).push(tc.seq);
        if (!firstTouch.has(p)) firstTouch.set(p, 'read');
      } else {
        (writeSeqsByFile.get(p) ?? writeSeqsByFile.set(p, []).get(p)!).push(tc.seq);
        // 首触达只认 Read/Write：Edit 不建文件（不是自建信号），但批次窗口要它的 seq
        if (name === 'write' && !firstTouch.has(p)) firstTouch.set(p, 'write');
      }
    }
    // 写失败的调用没有发生写入，不计（索引里保留其 seq 只用于窗口定位）
    const writes = toolCalls.filter(tc => isWriteFamily(tc.toolName) && extractFilePath(tc.argsJson) !== null && tc.state !== 'error');
    if (writes.length === 0) return notApplicable(ctx.def, '缺少文件写操作，无法评判');

    const seqIn = (sorted: number[], lo: number, hi: number): boolean => {
      for (const s of sorted) {
        if (s <= lo) continue;
        return s < hi;
      }
      return false;
    };
    const nextWriteSeqOf = (file: string, after: number): number | undefined =>
      writeSeqsByFile.get(file)?.find(s => s > after);

    let naked = 0;
    const evidence: SubItemResult['evidence'] = [];
    for (const w of writes) {
      const file = extractFilePath(w.argsJson)!;
      if (firstTouch.get(file) === 'write') continue;               // 自建文件：豁免
      const reads = readSeqsByFile.get(file) ?? [];
      if (reads.some(s => s < w.seq)) continue;                     // 写前读过：不算不读就写
      const nextWriteSeq = nextWriteSeqOf(file, w.seq);
      // 批次中间的写：后面还有同文件写且中间没补读 → 以批次尾的核验为准，不逐次计
      if (nextWriteSeq != null && !seqIn(reads, w.seq, nextWriteSeq)) continue;
      const windowEnd = nextWriteSeq ?? Infinity;
      const verified = seqIn(reads, w.seq, windowEnd) || seqIn(bashVerifySeqs, w.seq, windowEnd);
      if (!verified) {
        naked++;
        evidence.push(ev(w.turnIndex, `${w.toolName} ${file}：从未读过该文件就改（非会话内自建），写后亦无同文件 Read、无验证命令`));
      }
    }
    const ratio = naked / writes.length;
    return okResult(ctx.def, {
      value: round2(ratio),
      unit: 'ratio',
      score: round2(1 - ratio),
      formula: `不读就写率 = 盲改未读文件 / 总写入 = ${naked} / ${writes.length} = ${round2(ratio)} → 得分 ${round2(1 - ratio)}（自建文件与写前已读的不计）`,
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
