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
import { nodeKeyOf } from "@/lib/run/view-model";
import { bandLabel, statusColor, statusLabel } from "@/components/run/run-theme";
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

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
  return `${(ms / 3600000).toFixed(1)}h`;
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

// 会话用量缩写（右侧胶囊，完整数值经 title 悬浮可见）：1.2k / 653k / 1.2M
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) {
    // 999,500 ≤ n < 1,000,000 时 Math.round(n/1_000)=1000 会产出「1000k」，
    // 与 ≥1M 档的「1.0M」衔接不一致——四舍五入到 1000k 时回落 M 档
    const k = Math.round(n / 1_000);
    if (k >= 1000) return `${(n / 1_000_000).toFixed(1)}M`;
    return `${k}k`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
          title={`${s.turns} turns · ${s.totalTokens} tokens`}
        >
          {s.turns} turns · {compactTokens(s.totalTokens)}
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
      {roleText}：无会话成员（{memberRef.kind === "process" ? "Bash/脚本" : "未开始"}）
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

  // 有效起止：manifest 成员时间戳缺失（session 成员常见）时，用该次尝试的成员
  // 会话行起止兜底——首个会话开始 → 最后一个会话结束
  const toTs = (iso: string | null): number | null => {
    if (iso === null) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const memberSessions = [attempt.executeMember.session ?? null, attempt.verifyMember?.session ?? null];
  const startTs = [attempt.startedAt, ...memberSessions.map(s => s?.startTime ?? null)]
    .map(toTs).filter((t): t is number => t !== null);
  const endTs = [attempt.finishedAt, ...memberSessions.map(s => s?.endTime ?? null)]
    .map(toTs).filter((t): t is number => t !== null);
  const rangeStart = startTs.length > 0 ? new Date(Math.min(...startTs)).toISOString() : null;
  const rangeEnd = endTs.length > 0 ? new Date(Math.max(...endTs)).toISOString() : null;
  const durationMs = startTs.length > 0 && endTs.length > 0
    ? Math.max(...endTs) - Math.min(...startTs)
    : null;

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
            <span className="ml-auto whitespace-nowrap text-[10.5px] leading-4 tabular-nums text-[#8c959f]" title="耗时（首会话开始 → 末会话结束）">
              {formatDurationMs(durationMs)}
            </span>
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-black/[0.08] px-4 py-3.5">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-[#1f2328]">{node.label}</h2>
          <p className="mt-0.5 text-[11px] leading-4 text-[#8c959f]">
            {bandLabel(node.generation)} · {EXECUTION_STATE_TEXT[node.executionState]}
            {node.taskType === "generator" ? " · 子图生成器" : node.taskType === "bash" ? " · 无 Agent 会话" : " · Agent 节点"}
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
