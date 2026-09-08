// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 第 1 层确定性过程分 D1–D6：全部零 LLM、纯函数、可复算。
// 每个指标返回 MetricResult（value + formula + inputs + evidence），账本原则。

import { parseReadArgs, computeRange, rangesOverlap, isDirectoryRead, type ReadRange } from '@/lib/file-reads';
import { extractFilePath, parseWriteLines } from '@/lib/file-restore';
import type { MetricResult, LoopPattern, LoopBand, PlanDeviationBreakdown, PlanStepMatch } from './types';
import type { ScoreToolCall, WireCharsSummary } from './collect';

export const round2 = (n: number): number => Math.round(n * 100) / 100;

function notEvaluated(id: string, label: string, note: string): MetricResult {
  return {
    id, label, status: 'not-evaluated', value: null,
    formula: '数据不可用，不进分母',
    inputs: [], evidence: [], note,
  };
}

function lowerTool(name: string): string {
  return name.toLowerCase();
}

// ── D1 重复读占比 ─────────────────────────────────────────

export function computeRepeatedRead(toolCalls: ScoreToolCall[]): MetricResult {
  const readsByFile = new Map<string, Array<{ range: ReadRange; turnIndex: number }>>();
  for (const tc of toolCalls) {
    if (lowerTool(tc.toolName) !== 'read') continue;
    const filePath = extractFilePath(tc.argsJson);
    if (!filePath || isDirectoryRead(filePath, tc.resultJson)) continue;
    const args = parseReadArgs(tc.argsJson);
    if (!args) continue;
    const arr = readsByFile.get(filePath) ?? [];
    arr.push({ range: computeRange(args), turnIndex: tc.turnIndex });
    readsByFile.set(filePath, arr);
  }

  let totalReads = 0;
  let overlappingReads = 0;
  const fileStats: Array<{ file: string; total: number; overlapping: number; turnIndexes: number[] }> = [];
  for (const [file, reads] of readsByFile) {
    let overlapping = 0;
    for (let i = 0; i < reads.length; i++) {
      let hit = false;
      for (let j = 0; j < reads.length; j++) {
        if (i !== j && rangesOverlap(reads[i].range, reads[j].range)) { hit = true; break; }
      }
      if (hit) overlapping++;
    }
    totalReads += reads.length;
    overlappingReads += overlapping;
    if (overlapping > 0) {
      fileStats.push({ file, total: reads.length, overlapping, turnIndexes: reads.map(r => r.turnIndex) });
    }
  }

  if (totalReads === 0) return notEvaluated('D1', '重复读占比', '会话内无带文件路径的 Read 工具调用');

  const value = overlappingReads / totalReads;
  return {
    id: 'D1', label: '重复读占比', status: 'ok', value: round2(value), unit: 'ratio',
    formula: `重复读占比 = 重叠读次数 / 总读次数 = ${overlappingReads} / ${totalReads} = ${round2(value)}`,
    inputs: [
      { label: '总读次数', value: totalReads },
      { label: '重叠读次数', value: overlappingReads },
      { label: '涉及文件数', value: readsByFile.size },
    ],
    evidence: fileStats
      .sort((a, b) => b.overlapping - a.overlapping)
      .slice(0, 5)
      .map(f => ({
        label: `${f.file}：${f.overlapping}/${f.total} 次重叠`,
        turnIndex: f.turnIndexes[0] ?? null,
      })),
  };
}

// ── D2a/D2b/D2c 冗余三口径（wire）─────────────────────────
// D2 口径修订（设计方案 §10）：跨轮前缀重发在 append-only 协议下恒 ≈99%
//（412 轮实测 0.99），无质量信息量——拆为轮内副本 / 缓存未覆盖成本 / 陈旧结果。

export function computeDupInjectionCopies(wire: WireCharsSummary | null): MetricResult {
  if (!wire) {
    return notEvaluated('D2a', '轮内重复注入副本', '非 claude 格式会话无 wire 逐轮报文（opencode 走 DB 视图），此指标不进分母');
  }
  if (wire.rounds === 0 || wire.requestChars === 0) {
    return notEvaluated('D2a', '轮内重复注入副本', 'wire 报文无有效请求轮');
  }
  const value = wire.dupCopyChars / wire.requestChars;
  return {
    id: 'D2a', label: '轮内重复注入副本', status: 'ok', value: round2(value), unit: 'ratio',
    formula: `轮内重复注入副本 = Σ各轮(同请求内逐字节相同消息 k 份计 k−1 份浪费)字符 / Σ各轮请求字符 = ${wire.dupCopyChars} / ${wire.requestChars} = ${round2(value)}（跨轮前缀重发不计——append-only 协议恒真，无质量信息量）`,
    inputs: [
      { label: '请求轮数', value: wire.rounds },
      { label: '各轮请求字符总量', value: wire.requestChars },
      { label: '轮内重复副本字符量', value: wire.dupCopyChars },
    ],
    evidence: [...wire.perRound]
      .sort((a, b) => b.dupCopyChars - a.dupCopyChars)
      .filter(r => r.dupCopyChars > 0)
      .slice(0, 3)
      .map(r => ({ label: `第 ${r.index} 轮：请求内重复副本 ${r.dupCopyChars} 字符（共 ${r.messageCount} 条消息）`, turnIndex: null })),
    note: 'roadmap #7 去重目标口径：同一注入文本在单次请求内的多余副本，是 cpx 转发时可物理剔除的部分',
  };
}

export const CACHE_READ_MULTIPLIER = 0.1;

export function computeCacheMissPrefixCost(wire: WireCharsSummary | null): MetricResult {
  if (!wire) {
    return notEvaluated('D2b', '缓存未覆盖前缀成本', '非 claude 格式会话无 wire 逐轮报文，此指标不进分母');
  }
  if (wire.roundsWithCacheUsage === 0) {
    return notEvaluated('D2b', '缓存未覆盖前缀成本', 'wire usage 无 cache_read/cached_tokens 字段（通道未回传缓存命中），无法区分全价与命中部分');
  }
  const uncachedUnits = wire.uncachedTokens;
  const cachedUnits = wire.cachedReadTokens * CACHE_READ_MULTIPLIER;
  const denom = uncachedUnits + cachedUnits;
  if (denom === 0) {
    return notEvaluated('D2b', '缓存未覆盖前缀成本', '缓存相关 token 计均为 0');
  }
  const value = uncachedUnits / denom;
  return {
    id: 'D2b', label: '缓存未覆盖前缀成本', status: 'ok', value: round2(value), unit: 'ratio',
    formula: `缓存未覆盖成本占比 = 付全价 token / (付全价 token + 缓存命中 × ${CACHE_READ_MULTIPLIER}) = ${uncachedUnits} / (${uncachedUnits} + ${round2(cachedUnits)}) = ${round2(value)}（缓存读按 0.1x 计价，单价在比值中相消）`,
    inputs: [
      { label: '带 cache 字段的请求轮数', value: wire.roundsWithCacheUsage },
      { label: '付全价 token（input + cache_creation）', value: uncachedUnits },
      { label: '缓存命中 token', value: wire.cachedReadTokens },
      { label: '命中折价系数', value: CACHE_READ_MULTIPLIER },
    ],
    evidence: [],
    note: 'input 含本轮新增内容（长会话中新增 ≪ 前缀），为未覆盖前缀成本的上界口径；cache_creation 实际 1.25x，按 1x 近似',
  };
}

export function computeStaleToolResults(wire: WireCharsSummary | null): MetricResult {
  if (!wire) {
    return notEvaluated('D2c', '陈旧工具结果占比', '非 claude 格式会话无 wire 逐轮报文，此指标不进分母');
  }
  if (wire.rounds === 0 || wire.requestChars === 0) {
    return notEvaluated('D2c', '陈旧工具结果占比', 'wire 报文无有效请求轮');
  }
  const value = wire.staleToolResultChars / wire.requestChars;
  return {
    id: 'D2c', label: '陈旧工具结果占比', status: 'ok', value: round2(value), unit: 'ratio',
    formula: `陈旧工具结果占比 = Σ各轮请求中已被更晚同文件读写取代的工具结果字符 / Σ各轮请求字符 = ${wire.staleToolResultChars} / ${wire.requestChars} = ${round2(value)}`,
    inputs: [
      { label: '请求轮数', value: wire.rounds },
      { label: '各轮请求字符总量', value: wire.requestChars },
      { label: '陈旧工具结果字符量', value: wire.staleToolResultChars },
      { label: '涉及文件数', value: wire.staleFiles.length },
    ],
    evidence: wire.staleFiles.map(f => ({ label: `${f.file}：${f.chars} 字符陈旧结果`, turnIndex: null })),
    note: '长会话膨胀主体（实测 96% 为历史工具结果/文件内容）；v1 仅按取代关系（后续同文件 Read/Write/Edit 出现即取代早前结果），不含超龄判定，compact 后历史不回缩按 append-only 计',
  };
}

// ── D3 返工环（edit→revert→re-edit）───────────────────────

interface ReworkFileStat {
  file: string;
  writes: number;
  reverts: number;
  cycles: number;
  firstTurnIndex: number;
}

export function computeRework(toolCalls: ScoreToolCall[]): { revertCycles: MetricResult; churnFiles: MetricResult } {
  const writesByFile = new Map<string, ScoreToolCall[]>();
  for (const tc of toolCalls) {
    if (lowerTool(tc.toolName) !== 'write') continue;
    const lines = parseWriteLines(tc.argsJson);
    if (!lines) continue;
    const filePath = extractFilePath(tc.argsJson);
    if (!filePath) continue;
    const arr = writesByFile.get(filePath) ?? [];
    arr.push(tc);
    writesByFile.set(filePath, arr);
  }

  if (writesByFile.size === 0) {
    return {
      revertCycles: notEvaluated('D3', '返工环数', '无 Write 全量写（Edit 增量写不含全文，无法比对快照）'),
      churnFiles: notEvaluated('D3b', '文件改动churn占比', '无 Write 全量写'),
    };
  }

  const stats: ReworkFileStat[] = [];
  let totalReverts = 0;
  let totalCycles = 0;
  for (const [file, writes] of writesByFile) {
    const snapshots: string[] = [];
    let pendingRevert = false;
    let reverts = 0;
    let cycles = 0;
    for (const w of writes) {
      const lines = parseWriteLines(w.argsJson)!;
      const content = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join('\n');
      const older = snapshots.slice(0, Math.max(0, snapshots.length - 1));
      const isRevert = older.includes(content);
      if (pendingRevert && content !== snapshots[snapshots.length - 1]) {
        cycles++;
        pendingRevert = false;
      }
      if (isRevert) {
        reverts++;
        pendingRevert = true;
      } else if (content === snapshots[snapshots.length - 1]) {
        // 连续两次相同全量写：churn 但不计返工环
      }
      snapshots.push(content);
    }
    totalReverts += reverts;
    totalCycles += cycles;
    stats.push({ file, writes: writes.length, reverts, cycles, firstTurnIndex: writes[0].turnIndex });
  }

  const filesWritten = writesByFile.size;
  const multiWriteFiles = stats.filter(s => s.writes >= 2).length;
  const churnRatio = filesWritten > 0 ? multiWriteFiles / filesWritten : 0;

  const revertCycles: MetricResult = {
    id: 'D3', label: '返工环数', status: 'ok', value: totalCycles, unit: 'cycles',
    formula: `返工环 = 检出 revert（写出内容 == 更早快照）后再改动 的次数 = ${totalCycles}（revert 事件 ${totalReverts} 次）`,
    inputs: [
      { label: 'Write 文件数', value: filesWritten },
      { label: 'revert 事件数', value: totalReverts },
      { label: '返工环数', value: totalCycles },
    ],
    evidence: stats.filter(s => s.cycles > 0 || s.reverts > 0)
      .sort((a, b) => b.cycles - a.cycles)
      .slice(0, 5)
      .map(s => ({ label: `${s.file}：${s.writes} 次写 / ${s.reverts} 次 revert / ${s.cycles} 环`, turnIndex: s.firstTurnIndex })),
    note: '仅覆盖 Write 全量写；Edit 增量写无全文可比对',
  };

  const churnFiles: MetricResult = {
    id: 'D3b', label: '文件改动churn占比', status: 'ok', value: round2(churnRatio), unit: 'ratio',
    formula: `churn 文件占比 = 写≥2次的文件 / 写过的文件 = ${multiWriteFiles} / ${filesWritten} = ${round2(churnRatio)}`,
    inputs: [
      { label: '写过的文件数', value: filesWritten },
      { label: '写≥2次的文件数', value: multiWriteFiles },
    ],
    evidence: stats.filter(s => s.writes >= 2)
      .sort((a, b) => b.writes - a.writes)
      .slice(0, 5)
      .map(s => ({ label: `${s.file}：${s.writes} 次写`, turnIndex: s.firstTurnIndex })),
  };

  return { revertCycles, churnFiles };
}

// ── D4 裸写率（验证缺失）──────────────────────────────────

const VERIFY_CMD_RE = /(test|vitest|jest|pytest|build|make|compile|npm\s+run|lint)/i;

function isWriteFamily(name: string): boolean {
  const n = lowerTool(name);
  return n === 'write' || n === 'edit' || n === 'edit1' || n === 'multiedit';
}

export function computeNakedWrite(toolCalls: ScoreToolCall[]): MetricResult {
  const writes = toolCalls.filter(tc =>
    isWriteFamily(tc.toolName) && extractFilePath(tc.argsJson) !== null
  );
  if (writes.length === 0) {
    return notEvaluated('D4', '裸写率', '无文件写操作');
  }

  let naked = 0;
  const nakedEvidence: Array<{ label: string; turnIndex: number }> = [];
  for (const w of writes) {
    const file = extractFilePath(w.argsJson)!;
    const nextSameFileWrite = writes.find(x => x.seq > w.seq && extractFilePath(x.argsJson) === file);
    const windowEnd = nextSameFileWrite ? nextSameFileWrite.seq : Infinity;
    const verified = toolCalls.some(tc =>
      tc.seq > w.seq
      && tc.seq < windowEnd
      && (
        (lowerTool(tc.toolName) === 'read' && extractFilePath(tc.argsJson) === file)
        || (lowerTool(tc.toolName) === 'bash' && VERIFY_CMD_RE.test(tc.argsJson ?? ''))
      )
    );
    if (!verified) {
      naked++;
      nakedEvidence.push({ label: `${w.toolName} ${file}：写后无同文件 Read、无 test/build 命令`, turnIndex: w.turnIndex });
    }
  }

  const value = naked / writes.length;
  return {
    id: 'D4', label: '裸写率', status: 'ok', value: round2(value), unit: 'ratio',
    formula: `裸写率 = 无验证写入 / 总写入 = ${naked} / ${writes.length} = ${round2(value)}（验证 = 同文件 Read 或 test/build 类 Bash）`,
    inputs: [
      { label: '总写入次数', value: writes.length },
      { label: '裸写次数', value: naked },
    ],
    evidence: nakedEvidence.slice(0, 8),
  };
}

// ── D5 循环分档 ───────────────────────────────────────────

export const LOOP_RUN_MIN = 3;
export const LOOP_PINGPONG_MIN = 6;

export function computeLoop(toolCalls: ScoreToolCall[]): { metric: MetricResult; patterns: LoopPattern[]; band: LoopBand } {
  const keys = toolCalls.map(tc => `${tc.toolName} ${tc.argsJson ?? ''}`);
  const patterns: LoopPattern[] = [];

  let i = 0;
  while (i < keys.length) {
    let j = i;
    while (j + 1 < keys.length && keys[j + 1] === keys[i]) j++;
    const runLen = j - i + 1;
    if (runLen >= LOOP_RUN_MIN) {
      patterns.push({
        kind: 'tool_repeat',
        tool: toolCalls[i].toolName,
        length: runLen,
        turnIndexes: [toolCalls[i].turnIndex, toolCalls[j].turnIndex],
        detail: '连续同工具同参数',
      });
    }
    i = j + 1;
  }

  let p = 0;
  while (p + 3 < keys.length) {
    if (keys[p] !== keys[p + 2] || keys[p] === keys[p + 1]) { p++; continue; }
    let q = p;
    while (q + 2 < keys.length && keys[q] === keys[q + 2] && keys[q] !== keys[q + 1]) q++;
    const len = q - p + 2;
    if (len >= LOOP_PINGPONG_MIN) {
      patterns.push({
        kind: 'ping_pong',
        tool: `${toolCalls[p].toolName} ⇄ ${toolCalls[p + 1].toolName}`,
        length: len,
        turnIndexes: [toolCalls[p].turnIndex, toolCalls[Math.min(q + 1, keys.length - 1)].turnIndex],
        detail: '两调用交替死循环',
      });
    }
    p = q + 2;
  }

  const maxLen = patterns.reduce((m, x) => Math.max(m, x.length), 0);
  let band: LoopBand = 'none';
  if (patterns.length === 1 && maxLen <= 5) band = 'minor';
  else if (patterns.length > 0 && patterns.length <= 3 && maxLen <= 8) band = 'moderate';
  else if (patterns.length > 0) band = 'severe';

  const metric: MetricResult = {
    id: 'D5', label: '循环分档', status: 'ok', value: patterns.length, unit: 'patterns',
    band,
    formula: `模式数 ${patterns.length}（tool_repeat 阈值 ≥${LOOP_RUN_MIN} 连发，ping_pong 阈值 ≥${LOOP_PINGPONG_MIN} 交替）→ 档位 ${band}`,
    inputs: [
      { label: '工具调用总数', value: toolCalls.length },
      { label: '检出模式数', value: patterns.length },
      { label: '最长模式长度', value: maxLen },
    ],
    evidence: patterns.slice(0, 6).map(x => ({
      label: `${x.kind}:${x.tool} ×${x.length}（${x.detail}）`,
      turnIndex: x.turnIndexes[0] ?? null,
    })),
  };
  return { metric, patterns, band };
}

// ── D6 计划-执行偏离 ──────────────────────────────────────

interface TodoItem { content?: unknown; status?: unknown }

export function extractTodoSteps(toolCalls: ScoreToolCall[]): Array<{ content: string; status: string }> | null {
  const todoCalls = toolCalls.filter(tc => {
    const n = lowerTool(tc.toolName);
    return n === 'todowrite' || n === 'todo_write' || n === 'todo';
  });
  if (todoCalls.length === 0) return null;
  const last = todoCalls[todoCalls.length - 1];
  if (!last.argsJson) return null;
  try {
    const parsed = JSON.parse(last.argsJson) as { todos?: TodoItem[] };
    if (!Array.isArray(parsed.todos) || parsed.todos.length === 0) return null;
    const steps = parsed.todos
      .map(t => ({ content: typeof t.content === 'string' ? t.content : '', status: typeof t.status === 'string' ? t.status : '' }))
      .filter(t => t.content.length > 0);
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

export function tokenizeStep(step: string): string[] {
  const out = new Set<string>();
  const lower = step.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_\-./]{2,}/g)) out.add(m[0]);
  for (const m of lower.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    if (run.length <= 2) out.add(run);
    else for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

export function computePlanDeviation(toolCalls: ScoreToolCall[]): { metric: MetricResult; breakdown: PlanDeviationBreakdown | null } {
  const steps = extractTodoSteps(toolCalls);
  if (!steps) {
    return { metric: notEvaluated('D6', '计划-执行偏离', '会话内无 TodoWrite 计划声明，无法对账（设计方案待验证问题 #1）'), breakdown: null };
  }

  const searchSpace = toolCalls
    .filter(tc => {
      const n = lowerTool(tc.toolName);
      return n !== 'todowrite' && n !== 'todo_write' && n !== 'todo';
    })
    .map(tc => ({
      tc,
      text: `${tc.argsJson ?? ''}\n${(tc.resultJson ?? '').slice(0, 20000)}`.toLowerCase(),
    }));

  const matches: PlanStepMatch[] = steps.map(step => {
    const tokens = tokenizeStep(step.content);
    let hit: { turnIndex: number; tool: string; seq: number } | null = null;
    for (const s of searchSpace) {
      const found = tokens.filter(t => s.text.includes(t));
      const ok = found.length >= 2 || (found.length >= 1 && found[0].length >= 4);
      if (ok) {
        hit = { turnIndex: s.tc.turnIndex, tool: s.tc.toolName, seq: s.tc.seq };
        break;
      }
    }
    return {
      step: step.content,
      matched: hit !== null,
      evidenceTurnIndex: hit?.turnIndex ?? null,
      evidenceTool: hit?.tool,
    };
  });

  const totalSteps = steps.length;
  const matchedSteps = matches.filter(m => m.matched).length;
  let inOrderPairs = 0;
  const matchedSeqs = matches.filter(m => m.matched).map(m => {
    const s = searchSpace.find(x => x.tc.turnIndex === m.evidenceTurnIndex && m.evidenceTool === x.tc.toolName);
    return s ? s.tc.seq : -1;
  });
  for (let i = 1; i < matchedSeqs.length; i++) {
    if (matchedSeqs[i] >= matchedSeqs[i - 1]) inOrderPairs++;
  }
  const adjacentPairs = Math.max(0, matchedSeqs.length - 1);
  const inOrderRatio = adjacentPairs > 0 ? inOrderPairs / adjacentPairs : (matchedSteps > 0 ? 1 : 0);
  const matchMode: PlanDeviationBreakdown['matchMode'] =
    matchedSteps === 0 ? 'NONE' : (inOrderRatio >= 1 ? 'IN_ORDER' : 'ANY_ORDER');
  const score = matchedSteps / totalSteps;

  const breakdown: PlanDeviationBreakdown = {
    matchMode,
    totalSteps,
    matchedSteps,
    inOrderRatio: round2(inOrderRatio),
    missed: matches.filter(m => !m.matched).map(m => m.step),
    steps: matches,
  };

  const metric: MetricResult = {
    id: 'D6', label: '计划-执行偏离', status: 'ok', value: round2(score), unit: 'ratio',
    formula: `对账得分 = 有工具证据的步骤 / 计划步骤 = ${matchedSteps} / ${totalSteps} = ${round2(score)}（匹配档位 ${matchMode}，顺序保持率 ${breakdown.inOrderRatio}）`,
    inputs: [
      { label: '计划步骤数（TodoWrite 末态）', value: totalSteps },
      { label: '有证据步骤数', value: matchedSteps },
      { label: '匹配档位', value: matchMode },
      ...breakdown.missed.map((s, i) => ({ label: `未执行步骤 ${i + 1}`, value: s })),
    ],
    evidence: matches
      .filter(m => m.matched)
      .slice(0, 8)
      .map(m => ({ label: `「${m.step}」→ ${m.evidenceTool}`, turnIndex: m.evidenceTurnIndex })),
    note: '步骤证据 = 工具 args/result 中出现步骤 token（≥2 个或 1 个长 token）',
  };
  return { metric, breakdown };
}
