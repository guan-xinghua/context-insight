// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 节点运行历史侧栏（Run 工作台内）：竖轨时间线呈现逐次尝试
// （状态/起止/验收/输出/成员会话链接）、carried/空占位语义、跨代全景、本节点
// 触发的回滚。成员点击三态（design.md §7.2）：session 成员 → session 页；
// process 成员 → 展开输出无跳转；空占位 → 灰态说明。

import Link from "next/link";
import type { AttemptRecord, NodeInstance, RollbackRecord, SessionMemberRef } from "@/lib/run/view-model";
import type { RuleFinding } from "@/lib/run/model";
import { nodeKeyOf } from "@/lib/run/view-model";
import type { NodeUsage } from "@/lib/run/run-metrics";
import { bandLabel, redundancyColor, statusColor, statusLabel, TIME_COMPOSE } from "@/components/run/run-theme";
import { RunFailureAttribution } from "@/components/run/RunFailureAttribution";
import { attemptRangeOf, attemptSpanMs, compactTokens, formatDurationMs, nodeUsageOf, sessionSpanMs } from "@/lib/run/run-metrics";
import { ChevronDownIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useState } from "react";

const EXECUTION_STATE_TEXT: Record<NodeInstance["executionState"], string> = {
  executed: "本代执行过",
  not_run: "本代尚未运行",
  carried: "本代承接编排状态，未重跑",
};

/** 确定性格式的时间行：同日只写一次日期（10-10 02:01:30 → 02:01:35），跨日各自带日期。 */
function formatRange(startIso: string | null, endIso: string | null): string {
  const clock = (iso: string): { date: string; time: string } | null => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, "0");
    return { date: `${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
  };
  const s = startIso !== null ? clock(startIso) : null;
  const e = endIso !== null ? clock(endIso) : null;
  if (!s) return "—";
  if (!e) return `${s.date} ${s.time} → —`;
  return s.date === e.date ? `${s.date} ${s.time} → ${e.time}` : `${s.date} ${s.time} → ${e.date} ${e.time}`;
}

function StatusPill({ status, label }: { status: string; label?: string }) {
  const c = statusColor(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4"
      style={{ color: c, borderColor: `${c}59`, backgroundColor: `${c}17` }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: c }} />
      {label ?? statusLabel(status)}
    </span>
  );
}

/** 成员行：链接（session 成员 → session 页）+ 右侧用量胶囊；胶囊放不下时整体换行，
 *  不从链接/胶囊中间断词。角色词精简为 执行/验收，session id 展示前 8 位（完整
 *  id 在 title 悬浮与 href 中保留全量）。三态（design.md §7.2）：session → 链接；
 *  sessionId 未导入 → 灰链 + 「正文未导入」胶囊；无成员 → 灰态说明。 */
function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id;
}

function MemberLink({ member: memberRef }: { member: SessionMemberRef }) {
  const roleText = memberRef.role === "execute" ? "执行" : "验收";
  if (memberRef.session) {
    const s = memberRef.session;
    const d5 = s.ruleScores?.d5 ?? null;
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          href={`/session/${encodeURIComponent(s.taskId)}?framework=${encodeURIComponent(s.framework)}`}
          title={s.taskId}
          className="inline-flex min-w-0 items-center gap-1 text-xs text-[#8250df] hover:underline"
        >
          {roleText}：{shortId(s.taskId)}
          <ExternalLinkIcon className="size-3 shrink-0" />
        </Link>
        <span
          className="ml-auto whitespace-nowrap rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] leading-4 tabular-nums text-[#8c959f]"
          title={`${s.turns} turns · ${s.totalTokens} tokens${s.contextPeakPct != null ? ` · 上下文峰值 ${Math.round(s.contextPeakPct)}%` : ""}${s.ruleScores ? ` · 综合分 效率 ${s.ruleScores.d4 ?? "—"} / 冗余 ${s.ruleScores.d5 ?? "—"}（1 = 没被扣分）` : ""}`}
        >
          {s.turns} turns · {compactTokens(s.totalTokens)}
          {s.contextPeakPct != null ? (
            <span className={s.contextPeakPct >= 80 ? "text-[#9a6700]" : undefined}>
              {" · "}水位 {Math.round(s.contextPeakPct)}%
            </span>
          ) : null}
          {d5 !== null ? (
            <span style={{ color: redundancyColor(d5) }}>
              {" · "}冗余 {d5.toFixed(2)}
            </span>
          ) : null}
        </span>
      </div>
    );
  }
  if (memberRef.sessionId) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 text-xs text-[#57606a]" title={memberRef.sessionId}>
          {roleText}：{shortId(memberRef.sessionId)}
        </span>
        <span className="ml-auto whitespace-nowrap rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] leading-4 text-[#9a6700]">正文未导入</span>
      </div>
    );
  }
  return (
    <span className="text-xs text-[#8c959f]">
      {roleText}：无成员会话（{memberRef.kind === "process" ? "Bash/脚本" : "未开始"}）
    </span>
  );
}

const VERIFICATION_TYPE_TEXT: Record<string, string> = {
  agent: "Agent",
  script: "脚本",
  none: "无",
};

/** 验收报告块（仅长报告渲染）：状态/类型已在尝试标头展示，这里只放字数 +
 *  展开切换 + 预览/全文，不重复结论。 */
function VerificationReport({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5 text-[11px] leading-5">
        <span className="text-[#57606a]">验收报告</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          className="inline-flex items-center gap-0.5 rounded text-[#8c959f] transition-colors hover:text-[#1f2328]"
        >
          {open ? "收起" : "展开"}
          <ChevronDownIcon className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-black/[0.08] bg-white p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-[#24292f]">
          {reason}
        </pre>
      ) : (
        <div className="mt-1 line-clamp-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-[#8c959f]">
          {reason}
        </div>
      )}
    </div>
  );
}

function AttemptTimelineItem({ attempt, isLast }: { attempt: AttemptRecord; isLast: boolean }) {
  const c = statusColor(attempt.status);
  const reason = attempt.verification.reason ?? "";
  const long = reason.length > 80;
  const typeText = VERIFICATION_TYPE_TEXT[attempt.verification.type] ?? attempt.verification.type;

  // 有效起止/时长：口径单点在 run-metrics（节点透镜、时间轴摘要同源）——
  // manifest 时间戳缺失时用成员会话行起止兜底，含执行→验收派发间隙
  const { start: rangeStart, end: rangeEnd } = attemptRangeOf(attempt);
  const durationMs = attemptSpanMs(attempt);

  return (
    <div className="relative pl-5 pb-3.5 last:pb-0">
      {isLast ? null : <span className="absolute left-[4.5px] top-[16px] bottom-0 w-px bg-black/10" aria-hidden />}
      <span className="absolute left-0 top-[6px] size-[10px] rounded-full border-2" style={{ borderColor: c, backgroundColor: "#ffffff" }} aria-hidden />
      <div className="rounded-lg border border-black/[0.08] bg-black/[0.02] px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold text-[#1f2328]">第 {attempt.ordinal} 次</span>
          {attempt.ordinal > 1 ? (
            <span className="rounded-full border border-black/10 bg-black/[0.04] px-1.5 py-0.5 text-[10px] leading-4 text-[#57606a]">
              重试 {attempt.ordinal - 1}
            </span>
          ) : null}
          <StatusPill status={attempt.status} label={typeText !== "无" ? `${typeText} · ${statusLabel(attempt.status)}` : undefined} />
          {!long && reason ? <span className="text-[#8c959f]">（{reason}）</span> : null}
          {durationMs !== null && durationMs >= 0 ? (
            (() => {
              const execSpanMs = attempt.executeMember.session ? sessionSpanMs(attempt.executeMember.session) : null;
              const verifySpanMs = attempt.verifyMember?.session ? sessionSpanMs(attempt.verifyMember.session) : null;
              const gapSpanMs = Math.max(durationMs - (execSpanMs ?? 0) - (verifySpanMs ?? 0), 0);
              return (
                <span
                  className="ml-auto whitespace-nowrap text-[10.5px] leading-4 tabular-nums text-[#8c959f]"
                  title={`耗时 ${formatDurationMs(durationMs)}（${[
                    `执行 ${formatDurationMs(execSpanMs ?? 0)}`,
                    verifySpanMs !== null ? `验收 ${formatDurationMs(verifySpanMs)}` : null,
                    `间隙 ${formatDurationMs(gapSpanMs)}`,
                  ].filter(Boolean).join(" · ")}）`}
                >
                  {formatDurationMs(durationMs)}
                </span>
              );
            })()
          ) : null}
        </div>
        <div className="mt-1.5 text-[10.5px] leading-4 tabular-nums text-[#8c959f]">
          {formatRange(rangeStart, rangeEnd)}
        </div>
        {long ? <VerificationReport reason={reason} /> : null}
        {attempt.outputText ? (
          <pre className="mt-1.5 max-h-32 overflow-auto rounded-md border border-black/[0.08] bg-white p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-[#24292f]">
            {attempt.outputText}
          </pre>
        ) : null}
        <div className="mt-1.5 flex flex-col gap-1.5">
          <MemberLink member={attempt.executeMember} />
          {attempt.verifyMember ? <MemberLink member={attempt.verifyMember} /> : null}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-2 text-[11px] font-medium tracking-wide text-[#8c959f]">{children}</h3>;
}

/** 节点时间块：总时长（含重试等待）+ 构成堆叠条——回答「时间花在哪」：
 *  执行贵 → 优化 prompt/拆节点；验收贵 → 收紧验收或换脚本；间隙/重试等待大 →
 *  引擎编排开销（间隙 = 执行→验收派发；重试等待 = 上次尝试结束 → 重试派发）。
 *  零值构成不展示（单次通过等场景只看有效部分）。 */
function TimeComposeBlock({ usage }: { usage: NodeUsage }) {
  const allSegments: Array<{ key: string; ms: number; color: string; label: string; tip: string }> = [
    { key: "exec", ms: usage.execMs, color: TIME_COMPOSE.exec, label: "执行", tip: "执行会话时长" },
    { key: "verify", ms: usage.verifyMs, color: TIME_COMPOSE.verify, label: "验收", tip: "验收会话时长" },
    { key: "gap", ms: usage.gapMs, color: TIME_COMPOSE.gap, label: "间隙", tip: "派发间隙：执行结束 → 验收开始" },
    { key: "wait", ms: usage.waitMs, color: TIME_COMPOSE.wait, label: "重试等待", tip: "上次尝试结束 → 重试派发开始" },
  ];
  const segments = allSegments.filter(s => s.ms > 0);
  return (
    <div className="flex flex-col gap-1.5 border-b border-black/[0.08] px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-[#8c959f]" title="Σ尝试跨度 + 重试等待（首会话开始 → 末会话结束）">时长</span>
        <span className="text-[13px] font-semibold tabular-nums text-[#1f2328]">
          {formatDurationMs(usage.totalMs)}
        </span>
      </div>
      {segments.length > 0 ? (
        <>
          <div className="usage-compose-bar flex h-1.5 overflow-hidden rounded-full bg-black/[0.05]">
            {segments.map(s => (
              <span
                key={s.key}
                style={{ flexGrow: s.ms, backgroundColor: s.color }}
                title={`${s.label} ${formatDurationMs(s.ms)}（${s.tip}）`}
                aria-hidden
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] leading-4 text-[#57606a]">
            {segments.map(s => (
              <span key={s.key} className="inline-flex items-center gap-1" title={s.tip}>
                <span className="size-1.5 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
                {s.label} <span className="tabular-nums">{formatDurationMs(s.ms)}</span>
              </span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** 白干信号的展示文案：itemId → 白话标题 + 按原始计数值说的白话句。
 *  评分器公式（"×10 线性扣"之类）收进「复算明细」折叠区——表面说人话，
 *  想对账的人展开还能看到原始算式（账本原则：可展开复算）。 */
const FINDING_META: Record<string, { title: string; explain: (value: number | string | null) => string }> = {
  "D5.redispatch": {
    title: "子任务重派",
    explain: v => `同一个子任务派了 ${(Number(v) || 0) + 1} 遍——重派一遍就是一整段子会话重来`,
  },
  "D5.repeat": {
    title: "同一命令反复跑",
    explain: v => `同参数命令原样连跑，白跑 ${Number(v) || 0} 次（连跑 3 遍起算；改完再重跑不算白干）`,
  },
  "D5.toolErrors": {
    title: "调用失败白干",
    explain: v => {
      const m = /^(\d+)\/(\d+)$/.exec(String(v ?? ""));
      return m ? `${m[2]} 次调用里 ${m[1]} 次失败白干` : "有调用失败白干";
    },
  },
  "D4.compaction": {
    title: "上下文撑爆",
    explain: v => `上下文塞满窗口，触发 ${Number(v) || 0} 次压缩`,
  },
};

/** 冗余信号（评分卡规则层融合，第六刀）：把成员会话里评分 <1 的规则子项
 *  （子任务重派 / 同一命令反复跑 / 调用失败白干 / 上下文撑爆）浮出来。
 *  零值不展示：本节点全部会话干净时整块不渲染。与失败归因互补：归因看
 *  「尝试为什么失败」，这里看「会话里有没有白干活」。 */
function RunSessionFindings({ node }: { node: NodeInstance }) {
  const rows: Array<{ key: string; role: string; taskId: string; d4: number | null; d5: number | null; findings: RuleFinding[] }> = [];
  for (const attempt of node.attempts) {
    for (const m of [attempt.executeMember, attempt.verifyMember]) {
      const scores = m?.session?.ruleScores;
      if (!scores || scores.findings.length === 0) continue;
      rows.push({
        key: `${m!.role}:${m!.session!.taskId}`,
        role: m!.role === "execute" ? "执行" : "验收",
        taskId: m!.session!.taskId,
        d4: scores.d4,
        d5: scores.d5,
        findings: scores.findings,
      });
    }
  }
  if (rows.length === 0) return null;
  return (
    <div className="mt-4 border-t border-black/[0.08] pt-3.5">
      <h3
        className="mb-2 text-[11px] font-medium tracking-wide text-[#8c959f]"
        title="会话里没产生进展的活：同一命令反复跑、子任务重派、调用失败白干。冗余分越低白干越多，1 = 干净"
      >
        冗余信号
      </h3>
      <div className="flex flex-col gap-2">
        {rows.map(row => (
          <div key={row.key} className="rounded-lg border border-black/[0.08] bg-black/[0.015] px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4">
              <span className="text-[#57606a]">{row.role}：{shortId(row.taskId)}</span>
              <span
                className="ml-auto flex items-center gap-1.5 tabular-nums text-[#8c959f]"
                title="两个综合分（0-1）：效率 = 并行习惯 + 压缩次数；冗余 = 重派 + 反复跑 + 失败白干。1 = 没被扣分"
              >
                <span>效率 {row.d4 !== null ? row.d4.toFixed(2) : "—"}</span>
                <span style={{ color: row.d5 !== null ? redundancyColor(row.d5) : undefined }}>
                  冗余 {row.d5 !== null ? row.d5.toFixed(2) : "—"}
                </span>
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              {row.findings.map(f => {
                const meta = FINDING_META[f.itemId];
                return (
                  <details key={f.itemId} className="group rounded px-1.5 py-0.5 transition-colors hover:bg-black/[0.03]">
                    <summary className="cursor-pointer select-none text-[11px] leading-5 text-[#57606a]">
                      <span className="font-medium" style={{ color: redundancyColor(f.score) }}>{meta?.title ?? f.label}</span>
                      <span className="ml-1.5 tabular-nums" title="单项分：1 = 没扣分，越低越严重">{f.score.toFixed(2)}</span>
                      {f.evidence.length > 0 ? (
                        <span className="ml-1.5 text-[10px] text-[#8c959f]">证据 {f.evidence.length} 条 ▾</span>
                      ) : null}
                    </summary>
                    <div className="mt-1 space-y-1 rounded bg-black/[0.025] px-2 py-1.5">
                      <p className="text-[10.5px] leading-4 text-[#57606a]">{meta?.explain(f.value) ?? f.label}</p>
                      {f.evidence.slice(0, 5).map((e, i) => (
                        <p key={i} className="text-[10.5px] leading-4 text-[#8c959f]">
                          <span className="tabular-nums">turn {e.turnIndex ?? "?"}</span>
                          {" · "}
                          {e.label}
                        </p>
                      ))}
                      {f.evidence.length > 5 ? (
                        <p className="text-[10.5px] leading-4 text-[#8c959f]">… 共 {f.evidence.length} 条</p>
                      ) : null}
                      {f.formula ? (
                        <p className="font-mono text-[10.5px] leading-4 break-all text-[#8c959f]" title="评分器的原始算式（可对账）">复算：{f.formula}</p>
                      ) : null}
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RunNodeDetail({
  node,
  rollbacks,
  peers,
  onSelectNode,
  onClose,
}: {
  node: NodeInstance;
  rollbacks: RollbackRecord[];
  peers: { key: string; generation: number; status: string }[];
  onSelectNode: (key: string) => void;
  onClose: () => void;
}) {
  const usage = nodeUsageOf(node);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-black/[0.08] px-4 py-3.5">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-[#1f2328]">{node.label}</h2>
          <p className="mt-0.5 text-[11px] leading-4 text-[#8c959f]">
            {bandLabel(node.generation)} · {EXECUTION_STATE_TEXT[node.executionState]}
            {node.taskType === "generator" ? " · 子图生成器" : node.taskType === "workflow" ? " · 子图节点" : node.taskType === "bash" ? " · 无 Agent 会话" : " · Agent 节点"}
          </p>
        </div>
        <button
          className="shrink-0 rounded-md p-1 text-[#8c959f] transition-colors hover:bg-black/[0.05] hover:text-[#1f2328]"
          onClick={onClose}
          aria-label="关闭"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-2 border-b border-black/[0.08] px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusPill status={node.status} />
          {node.attempts.length > 0 ? (
            <span className="text-[11px] text-[#57606a]">执行 {node.attempts.length} 次</span>
          ) : null}
        </div>
        {node.retryPolicy ? (
          <span className="text-[11px] text-[#8c959f]" title="重试策略">
            重试上限 {node.retryPolicy.maxRetries ?? "?"} · 用尽后 {node.retryPolicy.onExhaust ?? "?"}
          </span>
        ) : null}
      </div>

      <RunFailureAttribution node={node} />
      {usage !== null ? <TimeComposeBlock usage={usage} /> : null}

      <div className="flex-1 overflow-y-auto px-4 py-3.5">
        {node.executionState === "carried" && node.carriedFromGeneration !== null ? (
          <div className="mb-3.5 rounded-lg border border-[#1b7c83]/30 bg-[#1b7c83]/[0.06] px-3 py-2 text-[11px] leading-5 text-[#57606a]">
            本代没有重新执行，沿用
            <button
              className="mx-1 text-[#1b7c83] hover:underline"
              onClick={() => onSelectNode(nodeKeyOf(node.nodeId, node.carriedFromGeneration!))}
            >
              {bandLabel(node.carriedFromGeneration)}
            </button>
            的结果
          </div>
        ) : null}

        {node.attempts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/15 px-3 py-3 text-[11px] leading-5 text-[#8c959f]">
            {node.pendingMembers.length > 0 ? (
              <>
                本代尚未执行（attempt=0，role={node.pendingMembers[0].role}）：
                {node.pendingMembers[0].kind === "session"
                  ? "sessionId=null，location=null——一旦执行会以真实成员替换占位。"
                  : "Bash process 尚无执行输出。"}
              </>
            ) : (
              "本代没有执行记录；未运行不代表数据被删除。"
            )}
          </div>
        ) : (
          <div className="flex flex-col">
            {node.attempts.map((a, i) => (
              <AttemptTimelineItem key={a.ordinal} attempt={a} isLast={i === node.attempts.length - 1} />
            ))}
          </div>
        )}

        <RunSessionFindings node={node} />

        {rollbacks.length > 0 ? (
          <div className="mt-4 border-t border-black/[0.08] pt-3.5">
            <SectionTitle>触发的回滚</SectionTitle>
            <div className="flex flex-col gap-1">
              {rollbacks.map(r => (
                <button
                  key={r.ordinal}
                  className="text-left text-[11px] leading-5 text-[#cf222e] hover:underline"
                  onClick={() => onSelectNode(r.targetKey)}
                >
                  回滚 #{r.ordinal}：第 {r.from.attempt} 次尝试失败（{r.from.nodeId}）→ {r.to.nodeId} {bandLabel(r.to.generation)} 第 {r.to.attempt} 次
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {peers.length > 0 ? (
          <div className="mt-4 border-t border-black/[0.08] pt-3.5">
            <SectionTitle>其他代</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {peers.map(p => (
                <button
                  key={p.key}
                  onClick={() => onSelectNode(p.key)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-black/[0.03] px-2 py-0.5 text-[11px] leading-4 text-[#57606a] transition-colors hover:border-black/25 hover:text-[#1f2328]"
                >
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: statusColor(p.status) }} aria-hidden />
                  {bandLabel(p.generation)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
