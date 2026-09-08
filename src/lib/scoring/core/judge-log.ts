// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分 LLM 调用过程日志（可维护性）：逐 attempt 落盘请求/响应，超时/空正文这类
// 偶发问题可事后复现。格式走 cannbay 捕获规范（docs/cannbay-schema-spec.md）：
// 信封冻结 + 扩展进 x_cannbay（payload schema `cc-judge-round` v1）。
// 布局按捕获的 subagent 形态（并发 3 路交错写单流会把 request/response 配对打乱，
// 子项各成一个子代理流则天然顺序配对）：
//   score-judge-logs/<被评sid>/<ts>-<runId>/<ts>-<runId>.jsonl   主流：run 头、逐子项 派发(惰性)/结果、footer
//   score-judge-logs/<被评sid>/<ts>-<runId>/<ts>-<runId>/subagents/<itemId>.jsonl（+ .meta.json）
// 派发行跟着真实调用走：子项首次发起 LLM 调用才写（Agent tool_use）——弃权子项
// （缺清单材料等，一次没调）只留一行结果，不建空 subagent 流/空卡。
// 主流/子代理流都是合法 claude-jsonl，insight 导入主流即自动挂上全部子代理轮次
// （结果与调用过程一一对应）。日志是 best-effort：任何写失败只丢弃日志，绝不阻断评分。

import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { JudgeCallMeta } from './assembler/types';
import { CANNBOT_HOME, migrateLegacyDir } from './store';

export const JUDGE_SCHEMA = 'cc-judge-round';
export const JUDGE_SCHEMA_VERSION = 1;

export const JUDGE_RUN_SCHEMA = 'cc-judge-run';
export const JUDGE_RUN_SCHEMA_VERSION = 1;

/** 请求行 content 里 system 与 user 的分隔标记（重放时按此拆回两个 role） */
export const JUDGE_SYSTEM_USER_SPLIT = '\n\n<<<judge-system|judge-user>>>\n\n';

/** cc-judge-round v1 的 data 载荷（类型定义义务，见 cannbay-schema-spec.md §4.6） */
export interface JudgeRoundData {
  runId: string;
  sessionId: string;
  dimensionId: string;
  itemId: string;
  itemName: string;
  attempt: number;
  maxTokens: number;
  latencyMs: number;
  promptChars: number;
  contentChars?: number;
  status?: number;
  stopReason?: string;
  error?: string;
  retryReason?: 'timeout' | 'empty-content';
}

export interface JudgeAttemptOutcome {
  attempt: number;
  maxTokens: number;
  latencyMs: number;
  promptChars: number;
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
  status?: number;
  stopReason?: string;
  error?: string;
  retryReason?: 'timeout' | 'empty-content';
}

const JUDGE_LOGS_DIR_NAME = 'score-judge-logs';
let legacyJudgeLogsMigrated = false;

/** footer 人话里的子项状态名 */
const FOOTER_STATUS_LABEL: Record<string, string> = {
  'ok': '出分', 'not-applicable': '无法评判', 'error': '出错',
};

export function judgeLogsDir(): string {
  if (process.env.SCORING_JUDGE_LOG_DIR) return process.env.SCORING_JUDGE_LOG_DIR;
  // SCORING_DATA_DIR 指向 scorecards 目录本身：日志挂它下面（listForBaseline 只收 *.json，目录天然跳过）
  if (process.env.SCORING_DATA_DIR) return path.join(process.env.SCORING_DATA_DIR, JUDGE_LOGS_DIR_NAME);
  if (!legacyJudgeLogsMigrated) {
    legacyJudgeLogsMigrated = true;
    const target = path.join(CANNBOT_HOME, JUDGE_LOGS_DIR_NAME);
    // 两个旧位置都收：仓库 data/judge-logs（v2.07 前）与用户目录 judge-logs（v2.07~2.08 曾用名）
    migrateLegacyDir(path.join(CANNBOT_HOME, 'judge-logs'), target);
    migrateLegacyDir(path.join(process.cwd(), 'data', 'judge-logs'), target);
  }
  return path.join(CANNBOT_HOME, JUDGE_LOGS_DIR_NAME);
}

/** native user 行（请求原文 / 弃权结果 / run 头尾摘要共用） */
export function nativeUserLine(content: string): string {
  return JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content } });
}

/** run 头/尾行：人话进 content（Turns 里直接可读），机器载荷进 x_cannbay（cc-judge-run v1） */
export function judgeRunLine(text: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'user', timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
    x_cannbay: { schema: JUDGE_RUN_SCHEMA, version: JUDGE_RUN_SCHEMA_VERSION, data },
  });
}

/**
 * 派发行（原生 Task 形状）：assistant 的 Agent tool_use，input 带 subagent_session_id——
 * bridge-builder 据此建 InteractionBridge（AgentCallGraph/编排视图的驱动数据），
 * 纯文本派发行链不上，导入后子代理就成一堆散轮。
 */
export function judgeDispatchLine(model: string, runId: string, meta: JudgeCallMeta): string {
  return JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: {
      role: 'assistant', id: `j-${runId}-${meta.itemId}-dispatch`,
      content: [{
        type: 'tool_use', id: `j-${runId}-${meta.itemId}`, name: 'Agent',
        input: { subagent_session_id: meta.itemId, name: meta.itemName, description: `评分子项 ${meta.itemId} ${meta.itemName}（调用过程在子代理流）` },
      }],
      model, usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

/** 结果行（原生形状）：tool_result 回到主流，tool_use_id 与派发行配对 */
export function judgeResultLine(runId: string, meta: JudgeCallMeta, payloadJson: string): string {
  return JSON.stringify({
    type: 'user', timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `j-${runId}-${meta.itemId}`, content: payloadJson }] },
  });
}

/** cc-subagent-meta v1（顶层旧字段与 x_cannbay.data 同值双写，规范 §4.5） */
export function subagentMetaLine(runId: string, meta: JudgeCallMeta): string {
  const toolUseId = `j-${runId}-${meta.itemId}`;
  const base = { toolUseId, name: meta.itemName, agentType: 'scoring-judge', subagentSessionId: meta.itemId };
  return JSON.stringify({ ...base, x_cannbay: { schema: 'cc-subagent-meta', version: 1, data: base } });
}

/** 请求行：content = system + 分隔标记 + user（可原样重放） */
export function judgeRequestLine(meta: JudgeCallMeta, attempt: number, system: string, user: string): string {
  return nativeUserLine(`${system}${JUDGE_SYSTEM_USER_SPLIT}${user}`);
}

/** 响应行：assistant 信封（usage/时间戳/model）+ cc-judge-round 扩展；失败时 content 放错误摘要 */
export function judgeResponseLine(
  model: string, runId: string, sessionId: string, meta: JudgeCallMeta, o: JudgeAttemptOutcome,
): string {
  const data: JudgeRoundData = {
    runId, sessionId,
    dimensionId: meta.dimensionId, itemId: meta.itemId, itemName: meta.itemName,
    attempt: o.attempt, maxTokens: o.maxTokens, latencyMs: o.latencyMs, promptChars: o.promptChars,
    ...(o.content != null ? { contentChars: o.content.length } : {}),
    ...(o.status != null ? { status: o.status } : {}),
    ...(o.stopReason != null ? { stopReason: o.stopReason } : {}),
    ...(o.error != null ? { error: o.error } : {}),
    ...(o.retryReason != null ? { retryReason: o.retryReason } : {}),
  };
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      id: `j-${runId}-${meta.itemId}-a${o.attempt}`,
      content: o.error != null ? `[judge-error] ${o.error}` : (o.content ?? ''),
      model,
      usage: { input_tokens: o.promptTokens ?? 0, output_tokens: o.completionTokens ?? 0 },
    },
    x_cannbay: { schema: JUDGE_SCHEMA, version: JUDGE_SCHEMA_VERSION, data },
  });
}

export class JudgeJournal {
  readonly runId: string;
  private readonly itemMetasWritten = new Set<string>();
  private readonly dispatchedItems = new Set<string>();
  private constructor(
    /** 主流文件（run 头/派发/结果/footer）；评分卡 meta.judgeLogFile 指向它 */
    readonly file: string,
    runId: string,
    private readonly model: string,
    private readonly subagentsDir: string,
  ) {
    this.runId = runId;
  }

  /** 创建失败返回 null（目录不可写等）——日志缺席不影响评分 */
  static create(sessionId: string, header: { model: string; concurrency: number; scorerVersion: string; withSemantic: boolean }): JudgeJournal | null {
    try {
      if (!/^[A-Za-z0-9_.\-]+$/.test(sessionId)) return null;
      const runId = randomUUID().replace(/-/g, '').slice(0, 8);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stem = `${stamp}-${runId}`;
      // 捕获布局：<stem>.jsonl 主流 + <stem>/subagents/ 子代理流（adapter 按此发现）
      const runDir = path.join(judgeLogsDir(), sessionId, stem);
      const subagentsDir = path.join(runDir, stem, 'subagents');
      mkdirSync(subagentsDir, { recursive: true });
      const journal = new JudgeJournal(path.join(runDir, `${stem}.jsonl`), runId, header.model, subagentsDir);
      journal.appendMain(judgeRunLine(
        `评分运行 ${runId} 开始 · 模型 ${header.model} · 并发 ${header.concurrency} · 评分器 ${header.scorerVersion} · 语义评审${header.withSemantic ? '开' : '关'}`,
        {
          kind: 'judge-run-header', phase: 'header', runId, sessionId, model: header.model,
          concurrency: header.concurrency, scorerVersion: header.scorerVersion,
          withSemantic: header.withSemantic, startedAt: new Date().toISOString(),
        },
      ));
      return journal;
    } catch {
      return null;
    }
  }

  /** 主流：子项结果（与评分卡同源——日志侧即可对上"这次调用得了什么结论"）。
   *  真调过 LLM 的子项 → tool_result（与派发的 tool_use 配对）；
   *  一次都没调就弃权的（缺清单材料等）→ 普通 user 行留痕，不派子代理——
   *  否则会建出 0 turns 的空 subagent 卡（派发行无条件写时的老问题）。 */
  result(meta: JudgeCallMeta, r: { status: string; score?: number | null; verdict?: string | null; value?: unknown; note?: string | null; error?: { message: string } | null }): void {
    const payload = {
      kind: 'judge-item-result', itemId: meta.itemId, itemName: meta.itemName,
      status: r.status,
      ...(r.score != null ? { score: r.score } : {}),
      ...(r.verdict != null ? { verdict: r.verdict } : {}),
      ...(r.value != null ? { value: String(r.value).slice(0, 120) } : {}),
      ...(r.note != null ? { note: r.note.slice(0, 200) } : {}),
      ...(r.error != null ? { error: r.error.message.slice(0, 200) } : {}),
    };
    const line = this.dispatchedItems.has(meta.itemId)
      ? judgeResultLine(this.runId, meta, JSON.stringify(payload))
      : nativeUserLine(JSON.stringify(payload));
    this.appendMain(line);
  }

  /** 子代理流（<itemId>.jsonl）：该子项全部 attempt 的请求/响应，天然顺序配对。
   *  首次触达时才写主流派发行（Agent tool_use）——派发跟着真实调用走，弃权项无派发无子代理流 */
  request(meta: JudgeCallMeta, attempt: number, system: string, user: string): void {
    if (!this.dispatchedItems.has(meta.itemId)) {
      this.dispatchedItems.add(meta.itemId);
      this.appendMain(judgeDispatchLine(this.model, this.runId, meta));
    }
    this.appendTo(this.itemFile(meta), judgeRequestLine(meta, attempt, system, user));
  }

  response(sessionId: string, meta: JudgeCallMeta, o: JudgeAttemptOutcome): void {
    this.appendTo(this.itemFile(meta), judgeResponseLine(this.model, this.runId, sessionId, meta, o));
  }

  footer(summary: Record<string, unknown>): void {
    const parts = [`评分运行 ${this.runId} 结束`];
    if (typeof summary.durationMs === 'number') parts.push(`耗时 ${(summary.durationMs / 1000).toFixed(1)}s`);
    if (typeof summary.judgeCalls === 'number') parts.push(`评审调用 ${summary.judgeCalls} 次`);
    if (typeof summary.judgeTokens === 'number') parts.push(`token ${summary.judgeTokens.toLocaleString()}`);
    const items = summary.items;
    if (items != null && typeof items === 'object') {
      const counts = Object.entries(items as Record<string, number>)
        .map(([k, v]) => `${FOOTER_STATUS_LABEL[k] ?? k} ${v}`).join(' / ');
      if (counts) parts.push(`子项 ${counts}`);
    }
    this.appendMain(judgeRunLine(parts.join(' · '), { kind: 'judge-run-footer', phase: 'footer', runId: this.runId, finishedAt: new Date().toISOString(), ...summary }));
  }

  /** 懒建子代理流；首次触碰时写 cc-subagent-meta（name/agentType 关联信息） */
  private itemFile(meta: JudgeCallMeta): string {
    if (!this.itemMetasWritten.has(meta.itemId)) {
      this.itemMetasWritten.add(meta.itemId);
      this.appendRaw(path.join(this.subagentsDir, `${meta.itemId}.meta.json`), subagentMetaLine(this.runId, meta));
    }
    return path.join(this.subagentsDir, `${meta.itemId}.jsonl`);
  }

  private appendMain(line: string): void {
    this.appendRaw(this.file, line);
  }

  private appendTo(file: string, line: string): void {
    this.appendRaw(file, line);
  }

  private appendRaw(file: string, line: string): void {
    try {
      appendFileSync(file, `${line}\n`);
    } catch { /* best-effort：写不进就丢这条，不阻断评分 */ }
  }
}
