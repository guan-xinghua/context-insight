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

/** 任务标识：description 里**多字母前缀的复合编号**（Task29 / Task15.1 / step4）。
 *  单字母前缀（v2 / r1 / P1）不取——版本与轮次标记会跨任务撞车（实跑实证：
 *  "② 复审 v2" 与 "④ base 复审 v2" 同含 v2 却是不同任务，15 个不同复审被并成
 *  一簇记 14 次假重派）；独立数字（日期、错误码 507035）不取——防止不同任务
 *  误合、同任务误分。 */
export function dispatchIds(text: string): string[] {
  return [...String(text).matchAll(/[a-zA-Z]{2,}(\d+(?:\.\d+)*)/g)].map(m => m[1]);
}

/** 圈号 → 数字（工作流步骤标识：①~⑪ / ⓪）。 */
const CIRCLED: Record<string, string> = {
  '⓪': '0', '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6',
  '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10', '⑪': '11',
};

/** 任务步骤：圈号（含 "④.5" 复合）优先，其次多字母前缀编号（Task29）。
 *  这是设计类工作流 description 里真正的任务判别信息——版本/轮次标记
 *  （v2 / r1）与泳道（base/group）之外的第三维。 */
export function dispatchStep(text: string): string {
  const s = String(text);
  const m = s.match(/([①②③④⑤⑥⑦⑧⑨⑩⑪])\.(\d+)/);
  if (m) return `${CIRCLED[m[1]]}.${m[2]}`;
  const c = s.match(/[⓪①②③④⑤⑥⑦⑧⑨⑩⑪]/);
  if (c) return CIRCLED[c[0]];
  const t = s.match(/[a-zA-Z]{2,}(\d+(?:\.\d+)?)/);
  return t ? t[1] : '';
}

/** 泳道：base / group / empty（词边界判定，database 里的 base 不算）。 */
export function dispatchLane(text: string): string {
  const m = String(text).match(/(?:^|[^a-zA-Z])(base|group|empty)(?:$|[^a-zA-Z])/i);
  return m ? m[1].toLowerCase() : '';
}

export interface DispatchCall {
  call: ScoreToolCall;
  name: string;       // subagent 类型（subagent_type / name）
  desc: string;       // 任务标题（description，缺省取 prompt 前缀）
  ids: string[];      // 任务标识（多字母前缀编号）
  step: string;       // 步骤号（圈号 / Task 编号；无则 ''）
  lane: string;       // 泳道（base/group/empty；无则 ''）
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
    out.push({ call, name, desc, ids: dispatchIds(desc), step: dispatchStep(desc), lane: dispatchLane(desc) });
  }
  return out;
}

/** 无编号任务的模板归一化：数字→#、去"重新/第N次/重试/(补)"类修饰与残留空括号，
 *  全等才合簇（保守）。修饰词剥除后遗留的 "()" 必须清掉——否则
 *  "⑦ 同步 base" 与 "⑦ 同步 base (重试)" 永不相等，真实重派全部漏报（实跑实证）。 */
const templateOf = (s: string): string =>
  s.toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/重新|第.次|再次|重试|retry|again|\(补\)|（补）/g, '')
    .replace(/\(\s*\)|（\s*）/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export interface RedispatchCluster {
  name: string;
  ids: string[];
  step: string;
  lane: string;
  dispatches: DispatchCall[];
}

/** subagent 级：同任务重派簇。任务身份 = **类型 + 步骤 + 泳道**（有编号时），
 *  或 类型 + 模板归一化相等（无编号时）。**不要求连续**：重派天然隔着别的活，
 *  隔轮重派本身就是信号（与工具级阈值不同的原因：连发多半是误发，重派一次
 *  就是完整一轮"验收-修复"，本身就是信息）。
 *  版本/轮次标记（v2 / r1 / (重试) / (补)）**不参与**任务身份——它们区分的是
 *  同一任务的第几轮，正是重派要数的对象（实跑实证：按版本号聚簇会把
 *  15 个不同任务的复审误并成一簇记 14 次假重派，同时漏掉真正的 "(重试)"
 *  "(补)" 重发）。 */
export function redispatchClusters(dispatches: DispatchCall[]): RedispatchCluster[] {
  const clusters: RedispatchCluster[] = [];
  for (const d of dispatches) {
    // 泳道宽容匹配：双方都写了泳道才要求相等（base≠group 是真不同任务）；
    // 一方省略了泳道词（描述写法不一致）不拆簇——拆了会漏报真重派
    const laneCompatible = (a: string, b: string) => a === b || !a || !b;
    const hit = d.step
      ? clusters.find(c => c.name === d.name && c.step === d.step && laneCompatible(c.lane, d.lane))
      : clusters.find(c => c.name === d.name && !c.step && laneCompatible(c.lane, d.lane)
          && templateOf(c.dispatches[0].desc) === templateOf(d.desc));
    if (hit) hit.dispatches.push(d);
    else clusters.push({ name: d.name, ids: d.ids, step: d.step, lane: d.lane, dispatches: [d] });
  }
  return clusters.filter(c => c.dispatches.length >= 2);
}
