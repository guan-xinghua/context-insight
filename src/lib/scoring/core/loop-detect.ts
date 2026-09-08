// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 重复尝试检测（一源两用）：D4.waste 用它归因"贵在哪"（代价在 D4 比值罚过），
// D5.redispatch / D5.repeat 用它罚"不改道"频率——同一检测多处消费，口径永不漂移。

import type { ScoreToolCall } from './assembler/types';

/** 环境类错误指纹（超时/网络/限流/服务端）：原样重试不算糙，豁免。
 *  D5.toolErrors 可避免错误率共用同一份。 */
export const ENV_ERROR_RE = /(time[ -]?out|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|network|socket|epipe|econnaborted|rate.?limit|too many requests|429|50[234]|bad gateway|service unavailable|overloaded|internal server error|server error|dns|upstream|interrupted|cancelled|canceled|aborted|segmentation fault|killed)/i;

export const isFailed = (tc: ScoreToolCall): boolean =>
  tc.errorType != null || /^(error|failed)/i.test(tc.state);

/** 派发类工具（cannbot 的 task / claude-code 的 Agent）——subagent 重派识别只看这类 */
const DISPATCH_TOOLS = new Set(['task', 'agent']);

export const isEnvFailure = (tc: ScoreToolCall): boolean =>
  isFailed(tc) && ENV_ERROR_RE.test(tc.errorMessage ?? '');

export interface RepeatRun {
  key: string;            // 工具名 + 参数原文
  length: number;         // 连发长度
  calls: ScoreToolCall[];
}

/** 工具级：原样连发段——同指纹**连续** ≥3 次（2 连发多半是误发/超时重试，不冤枉；
 *  隔着重跑是好习惯：改完重跑测试、写完重读文件，参数一样但不是白干） */
export function consecutiveRuns(toolCalls: ScoreToolCall[]): RepeatRun[] {
  const keys = toolCalls.map(tc => `${tc.toolName} ${tc.argsJson ?? ''}`);
  const runs: RepeatRun[] = [];
  let i = 0;
  while (i < keys.length) {
    let j = i;
    while (j + 1 < keys.length && keys[j + 1] === keys[i]) j++;
    if (j - i + 1 >= 3) runs.push({ key: keys[i], length: j - i + 1, calls: toolCalls.slice(i, j + 1) });
    i = j + 1;
  }
  return runs;
}

/** 任务标识：description 里**紧邻字母的复合编号**（Task29 / Task15.1 / v2.1）。
 *  独立数字（日期、错误码 507035）不取——防止不同任务误合、同任务误分。 */
export function dispatchIds(text: string): string[] {
  return [...String(text).matchAll(/[a-zA-Z](\d+(?:\.\d+)*)/g)].map(m => m[1]);
}

export interface DispatchCall {
  call: ScoreToolCall;
  name: string;       // subagent 类型（subagent_type / name）
  desc: string;       // 任务标题（description，缺省取 prompt 前缀）
  ids: string[];      // 任务标识
}

export function parseDispatches(toolCalls: ScoreToolCall[]): DispatchCall[] {
  const out: DispatchCall[] = [];
  for (const call of toolCalls) {
    if (!DISPATCH_TOOLS.has(call.toolName.toLowerCase())) continue;
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.argsJson ?? '') as Record<string, unknown>; } catch { continue; }
    const name = typeof args['subagent_type'] === 'string' ? args['subagent_type']
      : typeof args['name'] === 'string' ? args['name'] : 'default';
    const desc = String(args['description'] ?? '').trim() || String(args['prompt'] ?? '').slice(0, 80);
    out.push({ call, name, desc, ids: dispatchIds(desc) });
  }
  return out;
}

/** 无编号任务的模板归一化：数字→#、去"重新/第N次"类修饰，全等才合簇（保守） */
const templateOf = (s: string): string =>
  s.toLowerCase().replace(/\d+/g, '#').replace(/重新|第.次|再次|重试|retry|again/g, '').trim();

export interface RedispatchCluster {
  name: string;
  ids: string[];
  dispatches: DispatchCall[];
}

/** subagent 级：同任务重派簇——同类型 + 任务标识有交集（"验收 Task29" ∩
 *  "Task29 第二次修复Kernel" = {29}）。**不要求连续**：重派天然隔着别的活，
 *  隔轮重派本身就是信号（与工具级阈值不同的原因：连发多半是误发，重派一次
 *  就是完整一轮"验收-修复"，本身就是信息）。 */
export function redispatchClusters(dispatches: DispatchCall[]): RedispatchCluster[] {
  const clusters: RedispatchCluster[] = [];
  for (const d of dispatches) {
    const hit = d.ids.length > 0
      ? clusters.find(c => c.name === d.name && c.ids.some(x => d.ids.includes(x)))
      : clusters.find(c => c.name === d.name && c.ids.length === 0 && templateOf(c.dispatches[0].desc) === templateOf(d.desc));
    if (hit) hit.dispatches.push(d);
    else clusters.push({ name: d.name, ids: d.ids, dispatches: [d] });
  }
  return clusters.filter(c => c.dispatches.length >= 2);
}
