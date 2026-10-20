// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 失败归因 post-mortem（Run 侧纯函数）：证据源 = 尝试的验收 reason（Agent
// 验收报告 / 脚本结论）+ outputText（Bash 输出）。回答三件事——
// ① 是不是环境问题（环境指纹：改 prompt 无用，修环境或豁免重试）；
// ② 是不是同一个坑摔 N 次（同因连败：单点修复即可全部消除）；
// ③ 具体哪项验收没过（末次失败的逐项清单）。
// 环境指纹主单点与 scoring D5 共用（core/loop-detect 的 ENV_ERROR_RE），
// 补充段只覆盖 Bash/脚本输出形态（connection refused / 缺依赖 / 磁盘满）——
// 同一检测多处消费，口径不漂移。

import type { NodeInstance } from "@/lib/run/view-model";
import { ENV_ERROR_RE } from "@/lib/scoring/core/loop-detect";

// ── 环境指纹 ────────────────────────────────────────────────

/** Bash/脚本输出形态的环境指纹补充段（ENV_ERROR_RE 是 tool-error 形态的主单点）。 */
const RUN_ENV_SUPPLEMENT_RE =
  /connection refused|connection reset|permission denied|no space left|out of memory|oom[- ]?kill|module not found|no module named|importerror|command not found|enospc|eacces|bus error/i;

/** 错误行判定：指纹必须落在「像错误」的行上，避免验收报告正文顺带提及
 *  network/killed 等词造成的假阳性。 */
const ERROR_LINE_RE =
  /error|exception|traceback|fatal|crash|abort|refused|reset|unreachable|denied|not found|killed|oom|timed[ -]?out|timeout|exit [1-9]\b|exit code [1-9]|errno|段错误|失败|错误/i;

function envSuspect(reason: string | null, outputText: string | null): boolean {
  const hay = `${reason ?? ""}\n${outputText ?? ""}`;
  for (const line of hay.split(/\r?\n/)) {
    if ((ENV_ERROR_RE.test(line) || RUN_ENV_SUPPLEMENT_RE.test(line)) && ERROR_LINE_RE.test(line)) return true;
  }
  return false;
}

// ── 验收项解析 ──────────────────────────────────────────────

export interface VerifyItem {
  text: string;
  met: boolean;
}

const NOT_MET_RE = /not[ _-]?met|partially[ _-]?met|partial|未通过|不通过|\bfail(ed|ure)?\b/i;
const MET_RE = /(^|[^a-z])met\b|(^|[^a-z])pass(ed)?\b|通过|命中/i;
/** 结论尾部截断：`— met** 证据……` / `: not met (FAIL).` / `: ❌ NOT MET` /
 *  `— **FAILED**`——emoji/加粗包裹的结论词也要剥掉。 */
const VERDICT_TAIL_RE =
  /\s*[—–:：|]\s*[\*❌✅❎✗✔×✓]?\s*(?:not[ _-]?met|partially[ _-]?met|partial|met|pass(ed|ure)?|fail(ed|ure)?|未通过|不通过|通过|命中)\b[^]*$/i;
/** 结论标题行不是验收项：`**Verdict: FAILED**` / `**Verdict Report**`——
 *  只带总结论不带验收内容，误入清单还会污染同因签名。 */
const HEADER_ITEM_RE =
  /^(?:final\s+)?(?:verdict|acceptance|report|summary|conclusion|验收报告|验收结算|验收清单|结论|逐项结论|总评)(?:\s+(?:report|settlement|摘要|报告|清单))?$/i;

/** 从 Agent 验收报告解析逐项结论。真实 bundle 有三种已知格式——
 *  `**1. 项 — met** 证据`、`**1. "项" — NOT MET (FAIL).**`、
 *  `**Acceptance item 1 — 项: met.**`——共同点是结论词落在加粗行里，
 *  解析按行扫描：有加粗 + 有结论词才算验收项，证据行天然被排除。 */
export function parseVerifyItems(reason: string | null): VerifyItem[] {
  if (!reason) return [];
  const items: VerifyItem[] = [];
  for (const rawLine of reason.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.includes("**")) continue;
    const notMet = NOT_MET_RE.test(line);
    const met = !notMet && MET_RE.test(line);
    if (!notMet && !met) continue;
    const text = line
      .replace(/\*\*/g, "")
      .replace(/^#+\s*/, "")
      .replace(/^[-*]\s*/, "")
      .replace(/^\|\s*\d+\s*\|/, "")
      .replace(/^(?:acceptance\s+item\s*)?\d+\s*[.、)．]\s*/i, "")
      .replace(/^acceptance\s+item\s*\d+\s*[—–:：-]\s*/i, "")
      .replace(/^验收[项条]\s*\d+\s*[：.、]\s*/, "")
      .replace(VERDICT_TAIL_RE, "")
      .replace(/^["'「『]([^"'」』]+)["'」』]$/, "$1")
      .replace(/^[❌✅❎✗✔×✓]\s*/, "")
      .trim();
    if (text.length < 3 || text.length > 200) continue;
    if (HEADER_ITEM_RE.test(text)) continue;
    if (items.some(x => x.text === text)) continue;
    items.push({ text, met });
    if (items.length >= 12) break;
  }
  return items;
}

// ── 签名（同因判定） ────────────────────────────────────────

/** 归一化：数字/代码段 → #——同一验收项两次措辞里的计数差异（157 处 vs 13 处
 *  匹配）不产生新签名，同因才聚得住。 */
function normalizeSignature(s: string): string {
  return s
    .toLowerCase()
    .replace(/`[^`]*`/g, "`#`")
    .replace(/\d+/g, "#")
    .replace(/["“”'「」『』]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 无结构项时的失败摘要：reason 首个有内容行（script 一行结论 / Agent 报告
 *  首句）。跳过标题、分隔线与纯结论头——它们不是失败信息。 */
function excerptOf(reason: string | null): string | null {
  if (!reason) return null;
  for (const rawLine of reason.split(/\r?\n/)) {
    const line = rawLine.replace(/^#{1,6}\s*/, "").replace(/\*\*/g, "").trim();
    if (!line || /^[-—–]+$/.test(line)) continue;
    if (HEADER_ITEM_RE.test(line)) continue;
    return line.length > 120 ? `${line.slice(0, 120)}…` : line;
  }
  return null;
}

// ── 归因 ────────────────────────────────────────────────────

export type FailureKind = "env" | "same-cause" | "divergent";

export interface FailedAttemptView {
  ordinal: number;
  envSuspect: boolean;
  items: VerifyItem[];
  excerpt: string | null;
  /** 失败签名：未通过项（归一化）优先，reason 摘要兜底——跨尝试相等即同因 */
  signature: string | null;
  /** 该次尝试成员会话的上下文峰值水位（0-100，无数据 null） */
  contextPeakPct: number | null;
}

export interface FailureAttribution {
  kind: FailureKind | null;      // null = 单次失败（无连败模式）
  failedCount: number;
  envCount: number;
  /** 同因连败：同一签名在 ≥2 次失败尝试中出现 */
  sameCause: { ordinals: number[]; item: string } | null;
  attempts: FailedAttemptView[];
  lastFailed: FailedAttemptView | null;
  eventuallyPassed: boolean;     // 本代内最终通过（重试自愈）
  advice: string;
}

/** 节点失败归因；无失败尝试返回 null（零值信息不展示）。 */
export function attributeFailures(node: NodeInstance): FailureAttribution | null {
  const failedRaw = node.attempts.filter(a => a.status === "failed");
  if (failedRaw.length === 0) return null;

  const attempts: FailedAttemptView[] = failedRaw.map(a => {
    const reason = a.verification.reason;
    const items = parseVerifyItems(reason);
    const failedItems = items.filter(i => !i.met);
    // 摘要兜底链：reason 首行 → Bash 输出首行（reason 缺失的脚本/截断场景）
    const excerpt = excerptOf(reason) ?? excerptOf(a.outputText);
    // 签名：结构化未过项优先；短结论（脚本一行 reason）其次；长 Agent 报告
    // 散文不参与聚类——模板化开头（"我已完成……"）会让不同原因误聚成同因
    const signature = failedItems.length > 0
      ? failedItems.map(i => normalizeSignature(i.text)).join("∥")
      : reason !== null && reason.trim().length <= 120 && excerpt !== null
        ? normalizeSignature(excerpt)
        : null;
    const contextPeakPct = (() => {
      let peak: number | null = null;
      for (const m of [a.executeMember, a.verifyMember]) {
        const p = m?.session?.contextPeakPct;
        if (p != null) peak = peak === null ? p : Math.max(peak, p);
      }
      return peak;
    })();
    return { ordinal: a.ordinal, envSuspect: envSuspect(reason, a.outputText), items, excerpt, signature, contextPeakPct };
  });

  const failedCount = attempts.length;
  const envCount = attempts.filter(a => a.envSuspect).length;

  // 同因聚类：签名 → 尝试序号，取 ≥2 的最大簇
  const bySignature = new Map<string, { ordinals: number[]; item: string }>();
  for (const a of attempts) {
    if (a.signature === null) continue;
    const hit = bySignature.get(a.signature);
    if (hit) hit.ordinals.push(a.ordinal);
    else bySignature.set(a.signature, { ordinals: [a.ordinal], item: a.items.find(i => !i.met)?.text ?? a.excerpt ?? a.signature });
  }
  let sameCause: { ordinals: number[]; item: string } | null = null;
  for (const cluster of bySignature.values()) {
    if (cluster.ordinals.length < 2) continue;
    if (!sameCause || cluster.ordinals.length > sameCause.ordinals.length) sameCause = cluster;
  }

  const eventuallyPassed = (() => {
    const firstFailOrdinal = Math.min(...failedRaw.map(a => a.ordinal));
    return node.attempts.some(a => a.status === "passed" && a.ordinal > firstFailOrdinal);
  })();
  const healedOrdinal = eventuallyPassed
    ? node.attempts.find(a => a.status === "passed" && a.ordinal > Math.min(...failedRaw.map(a => a.ordinal)))?.ordinal ?? null
    : null;

  let kind: FailureKind | null;
  let advice: string;
  if (envCount === failedCount) {
    kind = "env";
    advice = `${failedCount} 次失败全部命中环境指纹（超时/网络/限流/缺依赖/资源不足）——改 prompt 或收紧验收无效：先修环境，或让引擎把该类失败豁免出重试预算`;
  } else if (sameCause) {
    kind = "same-cause";
    advice = `同一验收项连败 ${sameCause.ordinals.length} 次（第 ${sameCause.ordinals.join("/")} 次）——单点修复即可全部消除：优先处理「${sameCause.item}」`;
  } else if (envCount > 0) {
    kind = "env";
    advice = `其中 ${envCount}/${failedCount} 次命中环境指纹——先区分环境抖动与真实缺陷：逐次核对下方结论`;
  } else if (failedCount >= 2) {
    kind = "divergent";
    advice = `${failedCount} 次失败原因各异——非单点问题，逐次对比验收结论找共性`;
  } else {
    kind = null;
    advice = "1 次失败——未通过项与末次结论如下";
  }
  if (healedOrdinal !== null) {
    advice += `；第 ${healedOrdinal} 次尝试通过（重试自愈）`;
  }
  // 上下文逼限线索：失败时水位 ≥80%——长上下文遗忘指令/复读旧错会放大失败
  //（只是线索不是归因，与 env/same-cause 并列展示）
  const peak = attempts.reduce<number | null>(
    (acc, a) => (a.contextPeakPct != null && (acc === null || a.contextPeakPct > acc) ? a.contextPeakPct : acc),
    null,
  );
  if (peak !== null && peak >= 80) {
    advice += `；失败尝试的上下文水位达 ${Math.round(peak)}%（逼近上限——长上下文易遗忘指令、复读旧错，考虑拆分任务或压缩上下文）`;
  }

  return { kind, failedCount, envCount, sameCause, attempts, lastFailed: attempts[attempts.length - 1] ?? null, eventuallyPassed, advice };
}
