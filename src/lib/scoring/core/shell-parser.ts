// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you may redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 自研轻量 shell 拆分（已定：不引解析库；MLflow 红线类检查全走 LLM，无先例可抄）。
// 只回答一个问题：命令由哪些子命令组成、每个子命令的首词和 flag 是什么。
// 断不了的（命令替换 / 变量 / 反引号）标 uncertain——调用方不硬判，标疑似只披露。

export interface ShellSegment {
  command: string;      // 首词（小写）
  args: string[];       // 其余 token
  raw: string;
  uncertain: boolean;   // 含解析不了的结构：$( ) ` ` ${ } 嵌套引号
}

const SUBSHELL_OPENERS = new Set(['&&', '||', ';', '|', '\n']);

/** 顶层断句：尊重引号与 $() 反引号包裹（包裹整体不断开） */
export function splitShell(command: string): ShellSegment[] {
  const raws: string[] = [];
  let buf = '';
  let single = false;
  let double = false;
  let depth = 0;   // $( 或 ` 的嵌套深度
  let backtick = false;

  const push = () => {
    const t = buf.trim();
    if (t.length > 0) raws.push(t);
    buf = '';
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (depth > 0 || backtick) {
      if (!single && !double) {
        if (c === '(' && command[i - 1] === '$') depth++;
        else if (c === ')') depth--;
        else if (c === '`') backtick = false;
        else if (c === '`') backtick = true;
      }
      buf += c;
      continue;
    }
    if (single) {
      if (c === "'") single = false;
      buf += c;
      continue;
    }
    if (double) {
      if (c === '\\') { buf += c + (command[i + 1] ?? ''); i++; continue; }
      if (c === '"') double = false;
      buf += c;
      continue;
    }
    if (c === "'") { single = true; buf += c; continue; }
    if (c === '"') { double = true; buf += c; continue; }
    if (c === '`') { backtick = true; buf += c; continue; }
    if (c === '$' && command[i + 1] === '(') { depth = 1; buf += '$('; i++; continue; }

    const two = command.slice(i, i + 2);
    if (SUBSHELL_OPENERS.has(two) || SUBSHELL_OPENERS.has(c)) {
      push();
      if (SUBSHELL_OPENERS.has(two)) i++;
      continue;
    }
    buf += c;
  }
  push();

  return raws.map(raw => {
    const uncertain = /\$\(|`|\$\{|\$[A-Za-z_]/.test(raw);
    const tokens = raw.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
    const [head, ...rest] = tokens.map(t => t.replace(/^["']|["']$/g, ''));
    return {
      command: (head ?? '').toLowerCase().split('/').pop() ?? '',
      args: rest,
      raw,
      uncertain,
    };
  });
}

/** flag 是否存在（含合并短 flag，如 -rf 命中 -r 与 -f；大小写归一——-R 与 -r 同判） */
export function hasFlag(segment: ShellSegment, flag: string): boolean {
  const f = flag.toLowerCase();
  return segment.args.some(a => {
    const arg = a.toLowerCase();
    if (arg === f) return true;
    if (arg.startsWith('-') && !arg.startsWith('--') && f.length === 2) {
      return arg.slice(1).includes(f.slice(1));
    }
    return false;
  });
}

/** 去掉引号后的整段命令文本（正则快筛用） */
export function segmentsText(segments: ShellSegment[]): string {
  return segments.map(s => s.raw).join(' ; ');
}
