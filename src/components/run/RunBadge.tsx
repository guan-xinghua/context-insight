// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Session 详情页 Run 归属徽标（design.md §7.2）：反向归属 API
// （/api/observe/run/by-session/<taskId>，按 sid 扫描 run manifest，不触 DB）
// →「run 名 · 节点 · 第 N 代 · 第 M 次 · 角色」徽标，点击回 /run/<runId>。
// 无归属的普通会话零渲染开销（早退 null）。

import { useEffect, useState } from "react";
import Link from "next/link";
import { GitBranchIcon } from "lucide-react";

interface Membership {
  runId: string;
  runName: string | null;
  nodeId: string;
  generation: number;
  attempt: number;
  role: "execute" | "verify";
  memberName: string | null;
  kind: "process" | "session" | "workflow";
}

function bandLabel(generation: number): string {
  return generation === 0 ? "第 1 次" : `回滚 #${generation} 代`;
}

export function RunBadge({ taskId }: { taskId: string }) {
  const [memberships, setMemberships] = useState<Membership[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/observe/run/by-session/${encodeURIComponent(taskId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setMemberships(data.memberships ?? []);
      } catch {
        /* 归属徽标是增强信息，失败静默 */
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  if (!memberships || memberships.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {memberships.slice(0, 3).map(m => (
        <Link
          key={`${m.runId}-${m.nodeId}-${m.generation}-${m.attempt}-${m.role}`}
          href={`/run/${encodeURIComponent(m.runId)}`}
          title={m.memberName ?? undefined}
          className="inline-flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-xs text-violet-600 dark:text-violet-400 hover:bg-violet-500/20 transition-colors"
        >
          <GitBranchIcon className="size-3" />
          {m.runName ?? m.runId} · {m.nodeId} · {bandLabel(m.generation)} 第 {m.attempt} 次 · {m.role === "execute" ? "执行" : "验收"}
        </Link>
      ))}
      {memberships.length > 3 ? (
        <span className="text-xs text-muted-foreground">+{memberships.length - 3}</span>
      ) : null}
    </div>
  );
}
