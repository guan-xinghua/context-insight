// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 测试输出解析（D1.verifiedRun 验证证据 与 D3.testResults 测试结果 共用，一次解析两处用）。
// 计数数字优先从工具输出原文解析（设计 §2.2 三道保险之一）；解析不出返回 null。

import type { ScoreToolCall } from './assembler/types';
import { extractFilePath } from '@/lib/file-restore';

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  framework: string;
}

const num = (s: string | undefined): number => {
  const v = s ? Number(s.replace(/,/g, '')) : NaN;
  return Number.isFinite(v) ? v : 0;
};

/** 从 argsJson 解出命令串（{"command":"..."} 或裸串） */
export function commandOf(argsJson: string | null): string {
  if (!argsJson) return '';
  try {
    const p = JSON.parse(argsJson) as { command?: unknown; output?: unknown };
    if (typeof p.command === 'string') return p.command;
  } catch { /* 裸串原样返回 */ }
  return argsJson;
}

/** 从 resultJson 解出输出文本（{"output":"..."} / {"stdout":"..."} 或裸串） */
function outputOf(resultJson: string | null): string {
  if (!resultJson) return '';
  try {
    const p = JSON.parse(resultJson) as { output?: unknown; stdout?: unknown; content?: unknown };
    for (const k of [p.output, p.stdout, p.content]) {
      if (typeof k === 'string' && k.length > 0) return k;
    }
  } catch { /* 裸串原样返回 */ }
  return resultJson ?? '';
}

/** 从一段输出解析测试统计；认不出返回 null（宁漏勿错） */
export function parseTestOutput(raw: string | null): TestSummary | null {
  const text = outputOf(raw);
  if (!text) return null;

  // vitest / jest: "Tests  1483 passed | 3 skipped" / "Tests:        10 passed, 2 failed, 1 skipped"
  let m = text.match(/Tests?[ :]?\s+(\d[\d,]*)\s+passed(?:\s*[|,]\s*(\d[\d,]*)\s+failed)?(?:\s*[|,]\s*(\d[\d,]*)\s+skipped)?/i);
  if (m) {
    return { passed: num(m[1]), failed: num(m[2]), skipped: num(m[3]), framework: 'vitest/jest' };
  }

  // pytest: "=== 3 passed, 1 failed, 2 skipped in 0.5s ==="（顺序可变，逐项取）
  if (/=+ .*(passed|failed|error).* =+/i.test(text) && /passed|failed|error/i.test(text)) {
    const passed = num(text.match(/(\d[\d,]*)\s+passed/i)?.[1]);
    const failed = num(text.match(/(\d[\d,]*)\s+failed/i)?.[1]) + num(text.match(/(\d[\d,]*)\s+errors?/i)?.[1]);
    const skipped = num(text.match(/(\d[\d,]*)\s+skipped/i)?.[1]);
    if (passed + failed + skipped > 0) return { passed, failed, skipped, framework: 'pytest' };
  }

  // mvn: "Tests run: 10, Failures: 2, Errors: 0, Skipped: 1"
  m = text.match(/Tests run:\s*(\d[\d,]*),\s*Failures:\s*(\d[\d,]*),\s*Errors:\s*(\d[\d,]*)(?:,\s*Skipped:\s*(\d[\d,]*))?/i);
  if (m) {
    return { passed: num(m[1]) - num(m[2]) - num(m[3]), failed: num(m[2]) + num(m[3]), skipped: num(m[4]), framework: 'maven' };
  }

  // go test: "ok  	pkg	0.5s" / "--- FAIL: TestX" / "FAIL"
  if (/^ok\s+/m.test(text) || /^--- FAIL:/m.test(text) || /^FAIL$/m.test(text)) {
    const okPkgs = (text.match(/^ok\s+/gm) ?? []).length;
    const failTests = (text.match(/^--- FAIL:/gm) ?? []).length;
    if (okPkgs > 0 || failTests > 0) {
      return { passed: okPkgs, failed: failTests, skipped: 0, framework: 'go test' };
    }
  }

  // ctest: "100% tests passed, 0 tests failed out of 120" / "97% tests passed, 3 tests failed out of 120"
  m = text.match(/(\d[\d.]*)% tests passed,\s*(\d[\d,]*)\s*tests? failed out of\s*(\d[\d,]*)/i);
  if (m) {
    const total = num(m[3]);
    const failed = num(m[2]);
    return { passed: total - failed, failed, skipped: 0, framework: 'ctest' };
  }

  // cargo test: "test result: ok. 10 passed; 2 failed; 0 ignored"
  m = text.match(/test result: \w+\.\s*(\d[\d,]*)\s+passed;\s*(\d[\d,]*)\s+failed(?:;\s*(\d[\d,]*)\s+ignored)?/i);
  if (m) {
    return { passed: num(m[1]), failed: num(m[2]), skipped: num(m[3]), framework: 'cargo' };
  }

  // 设计流水线门控（ops-registry 等 check_*.py）："闸门通过 4/4" / "计入验收 4/4" / "[PASS]"/"[FAIL]"
  m = text.match(/闸门通过\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i);
  if (m) {
    const total = num(m[2]);
    return { passed: num(m[1]), failed: total - num(m[1]), skipped: 0, framework: 'gate' };
  }
  m = text.match(/计入验收\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i);
  if (m) {
    const total = num(m[2]);
    return { passed: num(m[1]), failed: total - num(m[1]), skipped: 0, framework: 'gate' };
  }
  const gatePass = (text.match(/\[PASS\]/gi) ?? []).length;
  const gateFail = (text.match(/\[FAIL\]/gi) ?? []).length;
  if (gatePass + gateFail > 0) {
    return { passed: gatePass, failed: gateFail, skipped: 0, framework: 'gate' };
  }
  // 布尔门控（validate_spec.py 等）："=== overall: PASS ===" / "overall: FAIL"——
  // 无计数行，通过与否本身就是结论（通过=1 过 / 失败=1 败）
  m = text.match(/overall\s*[:：]\s*(PASS|FAIL)/i);
  if (m) {
    const pass = m[1].toUpperCase() === 'PASS';
    return { passed: pass ? 1 : 0, failed: pass ? 0 : 1, skipped: 0, framework: 'gate' };
  }

  return null;
}

/** 白名单验证命令：grep "test"、cat report 之类不算——宁漏勿错 */
export const VERIFY_CMD_RE = /(^|[/\s])(npm|npx|pnpm|yarn|vitest|jest|pytest|python3?|go|cargo|make|cmake|ctest|mvn|gradle)(\s+|$)/i;
export const VERIFY_HINT_RE = /\b(test|vitest|jest|pytest|spec|ctest)\b|\bmake\b.*test|\bmvn\b.*test|\bcheck_[a-z0-9_.-]*|\bvalidate_[a-z0-9_.-]*|gate_lib|闸门/i;

/** 这条 Bash 调用是不是白名单验证命令（入参可以是 argsJson 或裸命令串） */
export function isVerifyCommand(command: string): boolean {
  const c = commandOf(command);
  return VERIFY_CMD_RE.test(c) && VERIFY_HINT_RE.test(c);
}

/**
 * 找"最后一次改代码之后"的最晚一次测试运行及其解析结果。
 * 返回 null = 没有合规的验证运行。
 */
export function findLastVerifiedRun(
  toolCalls: ScoreToolCall[],
  options: { sinceSeq?: number } = {},
): { call: ScoreToolCall; summary: TestSummary | null } | null {
  const since = options.sinceSeq ?? -Infinity;
  const candidates = toolCalls
    .filter(tc => tc.toolName.toLowerCase() === 'bash')
    .filter(tc => isVerifyCommand(tc.argsJson ?? ''))
    .filter(tc => tc.seq > since);
  if (candidates.length === 0) return null;
  const last = candidates[candidates.length - 1];
  return { call: last, summary: parseTestOutput(last.resultJson ?? '') };
}

/** 最后一次文件写（Write/Edit 家族）的 seq——验证必须在其后 */
/** 改代码判定（D1.verifiedRun / D3.testResults 共用口径）：写源码/配置/构建文件算——
 *  纯文档写（.md / CHANGELOG / README / LICENSE…）不算：测试过了只补文档的收尾
 *  不该把验证窗口推到最后、误判「改代码后无验证/缺测试运行」。 */
const DOC_FILE_RE = /\.(md|markdown|txt|rst|adoc)$/i;
const DOC_NAME_RE = /(^|[/\\])(CHANGELOG[^/\\]*|LICENSE[^/\\]*|NOTICE|README)$/i;
export function isCodeWrite(toolName: string, argsJson: string | null): boolean {
  if (!['write', 'edit', 'edit1', 'multiedit'].includes(toolName.toLowerCase())) return false;
  const p = extractFilePath(argsJson);
  return p != null && !DOC_FILE_RE.test(p) && !DOC_NAME_RE.test(p);
}

export function lastWriteSeq(toolCalls: ScoreToolCall[], isWrite: (tc: ScoreToolCall) => boolean): number {
  let seq = -1;
  for (const tc of toolCalls) if (isWrite(tc) && tc.seq > seq) seq = tc.seq;
  return seq;
}
