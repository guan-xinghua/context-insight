// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run 详情页：/api/observe/run/[runId] 拉取 view-model（已含成员会话 join），
// 主图/子图视图切换 + 纯 SVG DAG + 节点运行历史侧栏。成员下钻 session 页走
// 路由导航（非嵌入），session 页经 RunBadge 反向返回——闭环见 design.md §7。

import { useEffect, useMemo, useState } from "react";
import { use } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/layout/AppHeader";
import { RunGraph, bandLabel } from "@/components/run/RunGraph";
import { RunNodeDetail } from "@/components/run/RunNodeDetail";
import { Badge } from "@/components/ui/badge";
import { EyeIcon, SettingsIcon, Loader2Icon, ArrowLeftIcon } from "lucide-react";
import type { RunViewModel } from "@/lib/run/view-model";
import { BAY_VIEWER_NAME } from "@/lib/branding";

interface RunDetailResponse {
  run: {
    runId: string;
    name: string | null;
    status: string;
    exportDataComplete: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    import: {
      importedAt: string;
      sourceDir: string;
      sessions: { total: number; imported: number; existing: number; missingFile: number; failed: number };
      warnings: string[];
    } | null;
  };
  viewModel: RunViewModel;
}

const STATUS_VARIANT: Record<string, "green" | "red" | "orange" | "gray" | "slate" | "yellow"> = {
  passed: "green",
  failed: "red",
  running: "orange",
  pending: "gray",
  carried: "slate",
  unknown: "yellow",
};

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string>("main");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/observe/run/${encodeURIComponent(runId)}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? `加载失败 (${res.status})`);
          return;
        }
        setData(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [runId]);

  const nodesByKey = useMemo(
    () => new Map((data?.viewModel.nodes ?? []).map(n => [n.key, n])),
    [data],
  );
  const view = useMemo(
    () => data?.viewModel.views.find(v => v.id === viewId) ?? data?.viewModel.views[0] ?? null,
    [data, viewId],
  );
  const selectedNode = selectedKey ? nodesByKey.get(selectedKey) ?? null : null;

  if (error) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <main className="flex w-full max-w-7xl flex-col gap-6 px-6 py-8 mx-auto">
          <AppHeader />
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Link href="/runs" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
            ← 返回 Runs
          </Link>
        </main>
      </div>
    );
  }
  if (!data || !view) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <main className="flex w-full max-w-7xl flex-col gap-6 px-6 py-8 mx-auto">
          <AppHeader />
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> 加载 Run…
          </p>
        </main>
      </div>
    );
  }

  const { run, viewModel } = data;
  const nodeRollbacks = selectedNode
    ? viewModel.rollbacks.filter(r => r.triggerKey === selectedNode.key)
    : [];
  const peers = selectedNode
    ? viewModel.nodes
        .filter(n => n.nodeId === selectedNode.nodeId && n.generation !== selectedNode.generation)
        .sort((a, b) => a.generation - b.generation)
        .map(n => ({ key: n.key, generation: n.generation, status: n.status }))
    : [];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex w-full max-w-7xl flex-col gap-4 px-6 py-8 mx-auto">
        <AppHeader
          actions={
            <>
              <a href="/lake_viewer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent/30 transition-colors">
                <EyeIcon className="size-4 text-cyan-500" />
                {BAY_VIEWER_NAME}
              </a>
              <a href="/settings" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent/30 transition-colors">
                <SettingsIcon className="size-4 text-muted-foreground" />
                设置
              </a>
            </>
          }
        />

        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/runs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-4" /> Runs
          </Link>
          <h1 className="text-xl font-bold">{run.name ?? run.runId}</h1>
          <Badge variant={STATUS_VARIANT[run.status] ?? "gray"}>{run.status}</Badge>
          <span className="text-xs text-muted-foreground">{run.runId}</span>
          {!run.exportDataComplete ? (
            <Badge variant="yellow" className="text-xs">数据不完整</Badge>
          ) : null}
          {run.import ? (
            <span className="text-xs text-muted-foreground" title={`源目录 ${run.import.sourceDir}`}>
              会话：{run.import.sessions.imported + run.import.sessions.existing}/{run.import.sessions.total}
              {run.import.sessions.failed > 0 ? ` · 失败 ${run.import.sessions.failed}` : ""}
            </span>
          ) : null}
        </div>

        {viewModel.warnings.length > 0 ? (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-700 dark:text-yellow-400">
            {viewModel.warnings.slice(0, 5).map(w => <p key={w}>⚠ {w}</p>)}
          </div>
        ) : null}

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">视图：</span>
          {viewModel.views.map(v => (
            <button
              key={v.id}
              onClick={() => { setViewId(v.id); setSelectedKey(null); }}
              className={
                v.id === view.id
                  ? "rounded-md bg-accent px-2.5 py-1 text-xs font-medium"
                  : "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent/40"
              }
            >
              {v.title}
            </button>
          ))}
        </div>

        <div className="flex gap-4 items-start">
          <div className="flex-1 overflow-auto rounded-lg border bg-card p-2">
            <RunGraph
              view={view}
              nodesByKey={nodesByKey}
              selectedKey={selectedKey}
              onSelectNode={key => setSelectedKey(prev => (prev === key ? null : key))}
              onOpenSubgraph={key => { setViewId(`sub:${key}`); setSelectedKey(null); }}
            />
          </div>
          {selectedNode ? (
            <RunNodeDetail
              node={selectedNode}
              rollbacks={nodeRollbacks}
              peers={peers}
              onSelectNode={key => { setSelectedKey(key); }}
              onClose={() => setSelectedKey(null)}
            />
          ) : (
            <aside className="w-96 shrink-0 rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              点击图上节点查看运行历史（逐次尝试、验收结论、成员会话与 turn 下钻）。
              {view.rollbackLinks.length > 0 ? (
                <p className="mt-2">
                  本视图含 {view.rollbackLinks.length} 条回滚边（红虚线）：失败尝试的验收成员指向新代目标。
                </p>
              ) : null}
              {viewModel.generations.length > 1 ? (
                <p className="mt-1">代带：{viewModel.generations.map(g => bandLabel(g)).join(" → ")}</p>
              ) : null}
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}
