// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D4 评分器：四个基线对比项（token/双时长/轮次）+ 并行度 + 浪费归因（只归因不扣分）。

import { Scorer, okResult, notApplicable, ev, round2, type ScorerContext } from '../core/scorer';
import type { SubItemResult } from '../core/types';
import { BaselineCompareScorer } from '../core/baseline-compare';
import { consecutiveRuns } from '../core/loop-detect';
import { isCompactionMarkerTurn } from '../core/compaction';
import { parseReadArgs, computeRange, rangesOverlap, isDirectoryRead, type ReadRange } from '@/lib/file-reads';
import { extractFilePath, parseWriteLines } from '@/lib/file-restore';
import { BASELINE_MEASURES } from '../core/baseline/measures';
import type { ScoreToolCall, ScoreTurn } from '../core/assembler/types';

export function d4Scorers(): Scorer[] {
  return [
    new BaselineCompareScorer(
      { id: 'D4.tokens', dimension: 'D4', name: 'token 排名', scorerKind: 'baseline-compare' },
      { baselineKey: 'D4.tokens', measure: BASELINE_MEASURES['D4.tokens'].measure, notApplicableNote: '缺少 token 记录，无法评判', unit: 'tokens' },
    ),
    new BaselineCompareScorer(
      { id: 'D4.llmTime', dimension: 'D4', name: 'LLM 时长比值', scorerKind: 'baseline-compare' },
      { baselineKey: 'D4.llmTime', measure: BASELINE_MEASURES['D4.llmTime'].measure, notApplicableNote: '缺少模型耗时记录，无法评判', unit: 'ms' },
    ),
    new BaselineCompareScorer(
      { id: 'D4.toolTime', dimension: 'D4', name: '工具时长比值', scorerKind: 'baseline-compare' },
      { baselineKey: 'D4.toolTime', measure: BASELINE_MEASURES['D4.toolTime'].measure, notApplicableNote: '缺少工具耗时记录，无法评判', unit: 'ms' },
    ),
    new BaselineCompareScorer(
      { id: 'D4.turns', dimension: 'D4', name: '轮次比值', scorerKind: 'baseline-compare' },
      { baselineKey: 'D4.turns', measure: BASELINE_MEASURES['D4.turns'].measure, notApplicableNote: '没有可计数的轮，无法评判', unit: '轮' },
    ),
    new ParallelScorer(),
    new CompactionScorer(),
    new WasteAttributionScorer(),
  ];
}

// ── D4.compaction 上下文水位管理：压缩次数线性扣（每次 −0.2，5 次见底）。
// 触发压缩 = 上下文塞爆窗口（水位失控）；重算的代价（缓存失效后 input
// 全价重算）已在 D4.tokens 比值罚过一次，这里只罚失控信号（10% 小权重，
// 与 turns 同档——重叠信号轻罚）。手动 /compact 同样计扣（用户发起压缩
// 也是水位信号），evidence 里标注自动/手动仅供解读。子代理链撑爆自己的
// 窗口照计（evidence 标注哪条链）。

class CompactionScorer extends Scorer {
  readonly id = 'D4.compaction';
  readonly needs = ['turns'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const turns = ctx.input.turns;
    let count = 0;
    let manual = 0;
    const evidence: SubItemResult['evidence'] = [];
    let runChain: string | null = null;   // 同链连续标记轮（边界+摘要）并成一次事件
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const chain = t.isSubagent ? t.subagentSessionId ?? 'sub' : 'root';
      if (!isCompactionMarkerTurn(t)) { runChain = null; continue; }
      if (runChain === chain) continue;
      runChain = chain;
      count++;
      const isManual = !t.isSubagent && this.manualOf(t, turns, i);
      if (isManual) manual++;
      evidence.push(ev(t.turnIndex, `[compact] ${t.isSubagent ? '子代理链' : '主链'}${isManual ? '手动 /compact' : '自动压缩'}`));
    }
    const score = round2(Math.max(0, 1 - count * 0.2));
    return okResult(ctx.def, {
      value: count,
      unit: 'compactions',
      score,
      formula: `压缩 ${count} 次 ×0.2 线性扣 → ${score}${manual > 0 ? `（其中手动 /compact ${manual} 次，同样计扣）` : ''}`,
      evidence,
      note: count > 0
        ? '触发压缩 = 上下文水位失控；重算成本已在 D4.tokens 罚过，此处只罚信号'
        : '未触发压缩（上下文水位未失控）',
    });
  }

  /** 手动判定（只作 evidence 标注，不影响计分）：opencode 边界轮自带 /compact(±auto) 文案；claude 看边界前最近的主链 user 轮是不是 /compact 命令 */
  private manualOf(t: ScoreTurn, turns: ScoreTurn[], idx: number): boolean {
    const own = (t.content ?? '').trim();
    if (own.startsWith('/compact')) return !own.includes('(auto)');
    for (let i = idx - 1; i >= 0; i--) {
      const u = turns[i];
      if (u.isSubagent || u.role !== 'user') continue;
      const text = (u.content ?? u.contentSummary ?? '').trim();
      if (text.startsWith('/compact')) return !text.includes('(auto)');
      if (isCompactionMarkerTurn(u)) continue;   // 同一事件内的其他标记轮（如边界前的摘要轮）不是"最近的用户消息"
      return false;
    }
    return false;
  }
}

// ── 浪费归因（诊断）：返工 / 重复读 / 失败重试 / 循环 / 缓存 ──
// v1 归属：revertCycles / churnFiles / loop / repeatedRead / cacheMissPrefixCost /
// hiddenOverhead / 调用失败率 → 全部进归因分解

class WasteAttributionScorer extends Scorer {
  readonly id = 'D4.waste';
  readonly needs = ['toolCalls', 'measures', 'wire'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const toolCalls = ctx.input.toolCalls;
    const attribution: NonNullable<SubItemResult['attribution']> = [];
    const evidence: SubItemResult['evidence'] = [];

    // 重复读（v1 computeRepeatedRead 精简版）：重叠读的 result 字符 ≈ 白读的量
    const readsByFile = new Map<string, Array<{ range: ReadRange; chars: number; turnIndex: number }>>();
    for (const tc of toolCalls) {
      if (tc.toolName.toLowerCase() !== 'read') continue;
      const filePath = extractFilePath(tc.argsJson);
      if (!filePath || isDirectoryRead(filePath, tc.resultJson)) continue;
      const args = parseReadArgs(tc.argsJson);
      if (!args) continue;
      const arr = readsByFile.get(filePath) ?? [];
      arr.push({ range: computeRange(args), chars: (tc.resultJson ?? '').length, turnIndex: tc.turnIndex });
      readsByFile.set(filePath, arr);
    }
    let dupReadChars = 0;
    let dupReadCount = 0;
    for (const [, reads] of readsByFile) {
      for (let i = 0; i < reads.length; i++) {
        const hit = reads.some((r, j) => i !== j && rangesOverlap(reads[i].range, r.range));
        if (hit) { dupReadCount++; dupReadChars += reads[i].chars; }
      }
    }
    if (dupReadCount > 0) {
      attribution.push({ label: `重复读文件（${dupReadCount} 次重叠读）`, tokens: Math.ceil(dupReadChars / 4) });
      evidence.push(ev(null, `重叠读 ${dupReadCount} 次，涉及 ${readsByFile.size} 文件`));
    }

    // 返工（v1 computeRework 精简版）：revert 后再改 = 一个返工环
    const writesByFile = new Map<string, ScoreToolCall[]>();
    for (const tc of toolCalls) {
      if (tc.toolName.toLowerCase() !== 'write') continue;
      const lines = parseWriteLines(tc.argsJson);
      const filePath = extractFilePath(tc.argsJson);
      if (!lines || !filePath) continue;
      const arr = writesByFile.get(filePath) ?? [];
      arr.push(tc);
      writesByFile.set(filePath, arr);
    }
    let reverts = 0;
    let cycles = 0;
    for (const [file, writes] of writesByFile) {
      const snapshots: string[] = [];
      let pendingRevert = false;
      for (const w of writes) {
        const content = [...(parseWriteLines(w.argsJson) ?? new Map()).entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join('\n');
        if (pendingRevert && content !== snapshots[snapshots.length - 1]) { cycles++; pendingRevert = false; }
        if (snapshots.slice(0, -1).includes(content)) { reverts++; pendingRevert = true; }
        snapshots.push(content);
      }
      if (cycles > 0 || reverts > 0) evidence.push(ev(writes[0].turnIndex, `${file}：${reverts} revert / ${cycles} 返工环`));
    }
    if (cycles > 0 || reverts > 0) {
      attribution.push({ label: `返工（${cycles} 环 / ${reverts} revert）`, tokens: cycles * 2000 + reverts * 500 });
    }

    // 失败重试：失败的调用次数（浪费的是时间+token，按次归因）
    const failed = toolCalls.filter(tc => tc.state !== 'success' && tc.state !== 'ok' && tc.state !== 'completed');
    if (failed.length > 0) {
      attribution.push({ label: `调用失败重试（${failed.length} 次失败调用）`, tokens: failed.length * 500 });
      evidence.push(ev(failed[0].turnIndex, `首个失败调用（${failed[0].toolName}）`));
    }

    // 连发/交替循环（v1 computeLoop 精简版；检测与 D5.redispatch/D5.repeat 共用 core/loop-detect，口径不漂移）
    const repeatRuns = consecutiveRuns(toolCalls).reduce((s, r) => s + (r.length - 1), 0);
    if (repeatRuns > 0) {
      attribution.push({ label: `原地打转（连续同调用多发 ${repeatRuns}）`, tokens: repeatRuns * 300 });
    }

    // 缓存未覆盖前缀成本（wire 有 cache 字段时）
    const wire = ctx.input.wire;
    if (wire) attribution.push({ label: '轮内重复注入/过期结果（详 D5）', tokens: wire.dupCopyTokens + wire.staleResultTokens });

    // subagent 隐性开销：subagent 执行单元的 token 占比（派活时重复搭上下文）
    const subTokens = ctx.input.executions.filter(e => e.isSubagent).reduce((s, e) => s + e.tokens, 0);
    if (subTokens > 0) {
      attribution.push({ label: `subagent 开销（${Math.round(subTokens / Math.max(1, ctx.input.measures.totalTokens) * 100)}% token 在 subagent）`, tokens: subTokens });
    }

    const totalAttr = attribution.reduce((s, a) => s + (a.tokens ?? 0), 0);
    for (const a of attribution) a.pct = round2((a.tokens ?? 0) / Math.max(1, ctx.input.measures.totalTokens));

    return okResult(ctx.def, {
      value: attribution.length > 0 ? `${attribution.length} 类浪费信号` : '无明显浪费信号',
      formula: `浪费只归因不扣分（排名已罚过一次）：归因合计约 ${totalAttr} token${attribution.length === 0 ? '；未检出浪费模式' : ''}`,
      attribution,
      evidence: evidence.slice(0, 6),
      note: attribution.length === 0 ? undefined : 'token 估算口径：重复读按结果字符、返工/重试按经验均值，量级参考',
    });
  }
}

// ── 并行度：Σ调用时长 ÷ 执行区间并集（并集去掉间歇）──
// 纯串行 → 并集=Σ → r=1；两路全程并行 → r=2。subagent 及其内部调用一起计入
//（派 subagent 本身就是并行行为）。只奖不罚：串行记持平 0.8（任务天生串行不该
// 挨罚，与「无基线默认 80」同哲学），1.75× 并行记 1.0。
// 区间来源优先级：wire 轮间隙推导（cpx 捕获，主链本地工具 + task 派发窗口=子代理
// 整段执行）> DB per-call 起止时间戳（采集侧未回填，现全库为 0 → 无法评判）。

export function parallelRatio(toolCalls: ScoreToolCall[]): number | null {
  return parallelRatioOfIntervals(
    toolCalls
      .filter(tc => tc.startedAtMs != null && tc.completedAtMs != null && tc.completedAtMs > tc.startedAtMs)
      .map(tc => [tc.startedAtMs!, tc.completedAtMs!] as [number, number]),
  );
}

function parallelRatioOfIntervals(intervals: Array<[number, number]>): number | null {
  if (intervals.length < 2) return null;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const busy = sorted.reduce((s, [a, b]) => s + (b - a), 0);
  const base = sorted[0][0];
  let union = 0;
  let segStart = 0;                       // 当前段起点（相对 base）
  let curEnd = sorted[0][1] - base;
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i][0] - base;
    const e = sorted[i][1] - base;
    if (s >= curEnd) {          // 间歇出现：结算当前段，开新段
      union += curEnd - segStart;
      segStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  union += curEnd - segStart;
  return union > 0 ? busy / union : null;
}

const parallelScoreOf = (r: number): number => round2(Math.min(1, Math.max(0.8, 0.8 + (r - 1) * (0.2 / 0.75))));

class ParallelScorer extends Scorer {
  readonly id = 'D4.parallel';
  readonly needs = ['toolCalls', 'wire'] as const;

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const wireIv = ctx.input.wire?.toolIntervals;
    if (wireIv && wireIv.length >= 2) {
      const r = parallelRatioOfIntervals(wireIv.map(i => [i.startMs, i.endMs] as [number, number]));
      if (r != null) {
        return okResult(ctx.def, {
          value: round2(r),
          unit: '×',
          score: parallelScoreOf(r),
          formula: `并行度 ${round2(r)}（wire 轮间隙推导：主链+子代理本地工具与 task 派发窗口的 Σ时长 ÷ 区间并集）→ 串行记 0.8、1.75× 记 1.0 → ${parallelScoreOf(r)}`,
          note: r > 1.5 ? '并行执行明显' : r > 1.05 ? '有并行执行' : '全串行（任务天生串行不扣分）',
        });
      }
    }
    const r = parallelRatio(ctx.input.toolCalls);
    if (r == null) return notApplicable(ctx.def, '带时间戳的工具调用不足 2 个，无法评判');
    return okResult(ctx.def, {
      value: round2(r),
      unit: '×',
      score: parallelScoreOf(r),
      formula: `并行度 ${round2(r)}（Σ时长 ÷ 区间并集；1=全串行，2=两路并行）→ 串行记 0.8、1.75× 记 1.0 → ${parallelScoreOf(r)}`,
      note: r > 1.5 ? '并行执行明显' : r > 1.05 ? '有并行执行' : '全串行（任务天生串行不扣分）',
    });
  }
}
