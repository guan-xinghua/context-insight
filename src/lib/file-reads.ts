// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { shellCommandArgsOf, type ReadToolArgs } from './tool-conventions';

export interface ReadRange {
  type: 'full' | 'partial';
  start: number;
  end: number | null;
}

export interface ReadEntry {
  turnId: string;
  turnIndex: number;
  agent: string;
  prompt: string | null;
  subagentSessionId: string | null;
  llmOutput: string | null;
  range: ReadRange;
}

export function isDirectoryRead(filePath: string, resultJson: string | null): boolean {
  if (filePath.endsWith('/')) return true;
  if (resultJson && resultJson.includes('<type>directory</type>')) return true;
  return false;
}

export function computeRange(args: Pick<ReadToolArgs, 'offset' | 'limit'>): ReadRange {
  const hasOffset = args.offset !== undefined && args.offset !== null;
  const hasLimit = args.limit !== undefined && args.limit !== null;

  if (!hasOffset && !hasLimit) {
    return { type: 'full', start: 0, end: null };
  }
  if (hasOffset && !hasLimit) {
    return { type: 'full', start: args.offset!, end: null };
  }
  if (!hasOffset && hasLimit) {
    return { type: 'partial', start: 0, end: args.limit! };
  }
  return { type: 'partial', start: args.offset!, end: args.offset! + args.limit! };
}

export function rangesOverlap(a: ReadRange, b: ReadRange): boolean {
  if (a.type === 'full' || b.type === 'full') return true;
  return a.start < b.end! && b.start < a.end!;
}

export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr[0] <= last[1]) {
      last[1] = Math.max(last[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

export function analyzeReads(reads: ReadEntry[]): {
  overlappingReads: number;
  totalLinesRead: number;
  uniqueLinesRead: number;
  redundancyRate: number;
} {
  let overlappingReads = 0;
  for (let i = 0; i < reads.length; i++) {
    let overlaps = false;
    for (let j = 0; j < reads.length; j++) {
      if (i !== j && rangesOverlap(reads[i].range, reads[j].range)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) overlappingReads++;
  }

  const partialRanges = reads
    .filter(r => r.range.type === 'partial')
    .map(r => [r.range.start, r.range.end!] as [number, number]);

  const totalLinesRead = partialRanges.reduce((sum, [s, e]) => sum + (e - s), 0);
  const merged = mergeIntervals(partialRanges);
  const uniqueLinesRead = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
  const redundancyRate = totalLinesRead > 0 ? 1 - uniqueLinesRead / totalLinesRead : 0;

  return { overlappingReads, totalLinesRead, uniqueLinesRead, redundancyRate };
}

// ── codex exec 形态的文件读取提取 ─────────────────────────────────────
// codex 会话（第三方转换件产出 claude 信封）没有独立 Read 工具——文件读写
// 全部内嵌在 exec 工具参数的 exec_command({cmd:"..."}) shell 脚本里
// （cat / sed -n / head / tail / rg …）。从 argsJson 提取文件级读取：
// sed -n 'a,bp' 给精确行区间，cat/head/tail/rg 按整文件参与重叠统计；
// rg --files 是目录列举，跳过。

export interface ExecFileRead {
  filePath: string;
  range: ReadRange;
}

const FULL_RANGE: ReadRange = { type: 'full', start: 0, end: null };

function isFilePathLike(s: string): boolean {
  if (!s || s.startsWith('-')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  return s.startsWith('/') || s.startsWith('./') || s.startsWith('../') || s.startsWith('~')
    || s.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

function readFileOpsFromSegment(seg: string): ExecFileRead[] {
  const toks = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (toks.length === 0) return [];
  const head = toks[0];
  const rest = toks.slice(1).map(t => t.replace(/^['"]|['"]$/g, ''));

  if (head === 'cat') {
    return rest.filter(isFilePathLike).map(f => ({ filePath: f, range: FULL_RANGE }));
  }
  if (head === 'sed') {
    // -i 原地替换是写操作（≈ Edit 工具），不计入读取
    if (rest.some(t => t === '-i' || t === '--in-place' || /^(-i|--in-place=)/.test(t))) return [];
    let range: ReadRange | null = null;
    const files: string[] = [];
    for (const t of rest) {
      const rm = t.match(/^(\d+)(?:,(\d+))?p$/);
      if (rm) {
        range = { type: 'partial', start: Number(rm[1]), end: rm[2] ? Number(rm[2]) : Number(rm[1]) };
        continue;
      }
      // s/y 编辑命令（sed 's/a/b/' file）不是路径——含 / 会骗过 isFilePathLike
      if (/^(s|y)\//.test(t) || /^[aic]$/.test(t)) continue;
      if (t.startsWith('-')) continue;
      if (isFilePathLike(t)) files.push(t);
    }
    return files.map(f => ({ filePath: f, range: range ?? FULL_RANGE }));
  }
  if (head === 'head' || head === 'tail') {
    return rest.filter(t => !t.startsWith('-') && isFilePathLike(t)).map(f => ({ filePath: f, range: FULL_RANGE }));
  }
  if (head === 'rg' || head === 'grep') {
    if (rest.some(t => t === '--files')) return [];
    const positional = rest.filter(t => !t.startsWith('-'));
    if (positional.length < 2) return [];
    return positional.slice(1).filter(isFilePathLike).map(f => ({ filePath: f, range: FULL_RANGE }));
  }
  return [];
}

/** 命令文本 → 文件读记录（段切分 + 去重收集）；exec/shell 两提取器共用的解析核 */
function fileReadsFromCommandText(cmd: string, seen: Set<string>, out: ExecFileRead[]): void {
  for (const seg of cmd.split(/\n|&&|\|\||;|\|/)) {
    for (const r of readFileOpsFromSegment(seg.trim())) {
      // 目录尾斜杠跳过（与 Read 分支 isDirectoryRead 同口径）；rg 递归搜
      // 目录树（参数无尾斜杠）无法在此判别，按文件计入——已知近似
      if (r.filePath.endsWith('/')) continue;
      const key = `${r.filePath}:${r.range.type}:${r.range.start}-${r.range.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
  }
}

export function extractExecFileReads(argsJson: string | null): ExecFileRead[] {
  if (!argsJson) return [];
  let input = '';
  try {
    const a = JSON.parse(argsJson) as { input?: unknown };
    if (typeof a.input === 'string') input = a.input;
  } catch {
    return [];
  }
  const out: ExecFileRead[] = [];
  const seen = new Set<string>();
  for (const m of input.matchAll(/exec_command\(\{cmd:"((?:[^"\\]|\\.)*)"/g)) {
    const cmd = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    fileReadsFromCommandText(cmd, seen, out);
  }
  return out;
}

/**
 * shell 工具族（bash=opencode 1.x / shell=opencode 2.x / exec_command=codex，
 * 词表）的隐式文件读：command 键字符串/数组双形态（codex exec_command 的
 * 载荷在数组末元素，逐元素尝试避免连接后头部变 bash 漏提取），逐段复用
 * exec 提取同一套命令解析核（cat/sed/rg/…）。
 */
export function extractShellFileReads(argsJson: string | null): ExecFileRead[] {
  const out: ExecFileRead[] = [];
  const seen = new Set<string>();
  for (const part of shellCommandArgsOf(argsJson)) {
    fileReadsFromCommandText(part, seen, out);
  }
  return out;
}
