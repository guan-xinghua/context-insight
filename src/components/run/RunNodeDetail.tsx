// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 节点运行历史侧栏（原型 showNode 的组件化）：逐次尝试（状态/起止/验收/输出/
// 成员会话链接）、carried/空占位语义、跨代全景、本节点触发的回滚。
// 成员点击三态（design.md §7.2）：session 成员 → /session/<taskId>?framework=
// （现有 10 tab 全量复用）；process 成员 → 展开输出无跳转；空占位 → 灰态说明。

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AttemptRecord, NodeInstance, RollbackRecord, SessionMemberRef } from "@/lib/run/view-model";
import { nodeKeyOf } from "@/lib/run/view-model";
import { bandLabel } from "@/components/run/RunGraph";
import { ExternalLinkIcon, XIcon } from "lucide-react";

const STATUS_VARIANT: Record<string, "green" | "red" | "orange" | "gray" | "slate" | "yellow"> = {
  passed: "green",
  failed: "red",
  running: "orange",
  pending: "gray",
  carried: "slate",
  unknown: "yellow",
};

const EXECUTION_STATE_TEXT: Record<NodeInstance["executionState"], string> = {
  executed: "本代执行过",
  not_run: "本代尚未运行",
  carried: "本代承接编排状态，未重跑",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function MemberLink({ member: memberRef }: { member: SessionMemberRef }) {
  if (memberRef.session) {
    const s = memberRef.session;
    return (
      <Link
        href={`/session/${encodeURIComponent(s.taskId)}?framework=${encodeURIComponent(s.framework)}`}
        className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
      >
        {memberRef.role === "execute" ? "执行会话" : "验收会话"}：{s.taskId}
        <ExternalLinkIcon className="size-3" />
        <span className="text-muted-foreground">（{s.turns} turns · {s.totalTokens} tokens）</span>
      </Link>
    );
  }
  if (memberRef.sessionId) {
    return (
      <span className="text-xs text-muted-foreground">
        {memberRef.role === "execute" ? "执行会话" : "验收会话"}：{memberRef.sessionId}
        <span className="text-yellow-600 dark:text-yellow-400">（正文未导入）</span>
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {memberRef.role === "execute" ? "执行" : "验收"}：无会话成员（{memberRef.kind === "process" ? "Bash/脚本" : "未开始"}）
    </span>
  );
}

function AttemptCard({ attempt }: { attempt: AttemptRecord }) {
  return (
    <div className="rounded-md border p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">第 {attempt.ordinal} 次</span>
        {attempt.ordinal > 1 ? <Badge variant="slate" className="text-xs">重试 {attempt.ordinal - 1}</Badge> : null}
        <Badge variant={STATUS_VARIANT[attempt.status] ?? "gray"} className="text-xs">{attempt.status}</Badge>
      </div>
      <div className="text-xs text-muted-foreground">
        {formatTime(attempt.startedAt)} → {formatTime(attempt.finishedAt)}
      </div>
      <div className="text-xs">
        验收：<span className="text-muted-foreground">{attempt.verification.type} / {attempt.verification.status}</span>
        {attempt.verification.reason ? <span className="ml-1 text-muted-foreground">（{attempt.verification.reason}）</span> : null}
      </div>
      {attempt.outputText ? (
        <pre className="max-h-32 overflow-auto rounded bg-muted/60 p-2 text-xs whitespace-pre-wrap break-all">
          {attempt.outputText}
        </pre>
      ) : null}
      <MemberLink member={attempt.executeMember} />
      {attempt.verifyMember ? <MemberLink member={attempt.verifyMember} /> : null}
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
  return (
    <aside className="w-96 shrink-0 overflow-y-auto rounded-lg border bg-card p-4 flex flex-col gap-3 max-h-[calc(100vh-220px)]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold">{node.label}</h2>
          <p className="text-xs text-muted-foreground">
            {bandLabel(node.generation)} · {EXECUTION_STATE_TEXT[node.executionState]}
            {node.taskType === "generator" ? " · 子图生成器" : node.taskType === "bash" ? " · 无 Agent 会话" : " · Agent 节点"}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onClose} aria-label="关闭">
          <XIcon className="size-4" />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant={STATUS_VARIANT[node.status] ?? "gray"}>{node.status}</Badge>
        {node.attempts.length > 0 ? (
          <span className="text-xs text-muted-foreground">执行 {node.attempts.length} 次</span>
        ) : null}
        {node.retryPolicy ? (
          <span className="text-xs text-muted-foreground" title="重试策略">
            上限 {node.retryPolicy.maxRetries ?? "?"} · 用尽后 {node.retryPolicy.onExhaust ?? "?"}
          </span>
        ) : null}
      </div>

      {node.executionState === "carried" && node.carriedFromGeneration !== null ? (
        <div className="rounded-md border border-cyan-500/40 bg-cyan-500/5 p-2 text-xs">
          本代没有重新执行，沿用
          <button
            className="mx-1 text-cyan-600 dark:text-cyan-400 hover:underline"
            onClick={() => onSelectNode(nodeKeyOf(node.nodeId, node.carriedFromGeneration!))}
          >
            {bandLabel(node.carriedFromGeneration)}
          </button>
          的结果
        </div>
      ) : null}

      {node.attempts.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
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
        <div className="flex flex-col gap-2">
          {node.attempts.map(a => <AttemptCard key={a.ordinal} attempt={a} />)}
        </div>
      )}

      {rollbacks.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted-foreground">触发的回滚</h3>
          {rollbacks.map(r => (
            <button
              key={r.ordinal}
              className="text-left text-xs text-red-600 dark:text-red-400 hover:underline"
              onClick={() => onSelectNode(r.targetKey)}
            >
              回滚 #{r.ordinal}：第 {r.from.attempt} 次尝试失败（{r.from.nodeId}）→ {r.to.nodeId} {bandLabel(r.to.generation)} 第 {r.to.attempt} 次
            </button>
          ))}
        </div>
      ) : null}

      {peers.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted-foreground">其他代</h3>
          <div className="flex flex-wrap gap-1.5">
            {peers.map(p => (
              <button
                key={p.key}
                onClick={() => onSelectNode(p.key)}
                className="rounded bg-muted px-2 py-0.5 text-xs hover:bg-accent"
              >
                {bandLabel(p.generation)} · {p.status}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
