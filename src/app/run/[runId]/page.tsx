// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run 详情页：/api/observe/run/[runId] 拉取 view-model（已含成员会话 join），
// 布局 = 页面 chrome（全站对齐）+ 工作台（toolbar 视图标题/图例 + 点阵
// 画布 + 侧栏）。画布支持缩放平移（Ctrl/⌘+滚轮以光标为锚缩放、左键拖拽平移、
// 浮动工具条缩放/适配）；跑马灯按需点亮——选中节点点亮其关联边，点击空白
// 熄灭。侧栏两态：未选中 → Run 概览；选中 → 节点运行历史。子图不占顶层
// 视图——生成器节点「子图 ▸」入口以弹窗展开，弹窗内按代际切换。

import { useCallback, useEffect, useMemo, useState, use } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/layout/AppHeader";
import { RunCanvas } from "@/components/run/RunCanvas";
import { RunNodeDetail } from "@/components/run/RunNodeDetail";
import { RunRetryLedger } from "@/components/run/RunRetryLedger";
import { RunSubgraphDialog } from "@/components/run/RunSubgraphDialog";
import { RunTrace } from "@/components/run/RunTrace";
import { METRIC_EMPTY, METRIC_SCALE, REDUNDANCY_BANDS, RUN_COLORS, RUN_STATUS_META, WATER_CRITICAL_PCT, bandLabel } from "@/components/run/run-theme";
import { LENS_META, type LensKey } from "@/lib/run/run-metrics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UploadBundleDialog } from "@/components/run/UploadBundleDialog";
import { BAY_NAME } from "@/lib/branding";
import { Loader2Icon, ArrowLeftIcon, UploadIcon } from "lucide-react";
import type { RunViewModel } from "@/lib/run/view-model";

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

const LEGEND_STATUSES = ["passed", "failed", "running", "carried"] as const;

function RunOverview({ viewModel }: { viewModel: RunViewModel }) {
  const stats: { label: string; value: string }[] = [
    { label: "节点", value: String(viewModel.nodes.length) },
    { label: "代", value: String(viewModel.generations.length) },
    { label: "回滚", value: String(viewModel.rollbacks.length) },
    { label: "子图", value: String(viewModel.views.length - 1) },
  ];
  return (
    <div className="flex flex-col">
      <div className="border-b border-black/[0.08] px-4 py-3.5">
        <h2 className="text-[15px] font-semibold text-[#1f2328]">Run 概览</h2>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="grid grid-cols-4 gap-2">
          {stats.map(s => (
            <div key={s.label} className="rounded-lg border border-black/[0.08] bg-black/[0.02] px-2 py-2.5 text-center">
              <div className="text-[16px] font-semibold tabular-nums text-[#1f2328]">{s.value}</div>
              <div className="mt-0.5 text-[10px] text-[#8c959f]">{s.label}</div>
            </div>
          ))}
        </div>

        <div>
          <h3 className="mb-2 text-[11px] font-medium tracking-wide text-[#8c959f]">代际</h3>
          <div className="flex flex-wrap gap-1.5">
            {viewModel.generations.map(g => (
              <span
                key={g}
                className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-black/[0.03] px-2 py-0.5 text-[11px] leading-4 text-[#57606a]"
              >
                {g > 0 ? <span className="size-1.5 rounded-full bg-[#cf222e]" aria-hidden /> : null}
                {bandLabel(g)}
              </span>
            ))}
          </div>
        </div>

        {viewModel.rollbacks.length > 0 ? (
          <div>
            <h3 className="mb-2 text-[11px] font-medium tracking-wide text-[#8c959f]">回滚历史</h3>
            <div className="flex flex-col gap-1">
              {viewModel.rollbacks.map(r => (
                <p key={r.ordinal} className="text-[11px] leading-5 text-[#57606a]">
                  <span className="text-[#cf222e]">回滚 #{r.ordinal}</span>
                  ：{r.from.nodeId} 第 {r.from.attempt} 次失败 → {r.to.nodeId} {bandLabel(r.to.generation)} 第 {r.to.attempt} 次
                </p>
              ))}
            </div>
          </div>
        ) : null}

        <p className="mt-1 border-t border-black/[0.08] pt-3.5 text-[11px] leading-5 text-[#8c959f]">
          点击图上节点查看运行历史（逐次尝试、验收结论、成员会话与 turn 下钻）；生成器节点右上角
          <span className="text-[#57606a]">「子图 ▸」</span>以弹窗展开该代子图（可点击子图节点下钻会话）；
          <span className="text-[#57606a]"> 红虚线为回滚边</span>——失败尝试的验收成员指向新代目标。
        </p>
      </div>
    </div>
  );
}

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 子图弹窗：点击生成器节点「子图 ▸」入口打开（entryKey = 该代生成器节点）
  const [subgraphKey, setSubgraphKey] = useState<string | null>(null);
  // 系统级观测：视图模式（结构图 / 时间轴 / 重试账本）与指标透镜（结构图着色维度）
  const [mode, setMode] = useState<"graph" | "trace" | "ledger">("graph");
  const [lens, setLens] = useState<LensKey>("status");
  const [uploadOpen, setUploadOpen] = useState(false);
  // 稳定回调：RunGraph memo 依赖 props 引用稳定（子图入口不随无关重渲染换引用）
  const openSubgraph = useCallback((key: string) => setSubgraphKey(key), []);

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
  // 主图即工作台（子图为弹窗，不再是顶层视图）
  const view = data?.viewModel.views[0] ?? null;
  // 图数据缺失（导出侧未启用 graph 插件）：结构图/时间轴/账本三模式全部
  // 依赖图数据，工作台降级为空态引导卡，隐藏模式切换与图例
  const hasGraph = (view?.nodeKeys.length ?? 0) > 0;
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
  // 页头成员会话计数（导入时口径）：已导入/引用 + 失败附注；悬停给完整明细
  const s = run.import?.sessions;
  const sessionStats = run.import && s
    ? `成员会话：${s.imported + s.existing}/${s.total}`
      + (s.failed > 0 ? ` · 失败 ${s.failed}` : "")
    : null;
  const sessionStatsTitle = run.import && s
    ? `新导入 ${s.imported} · 已存在 ${s.existing}`
      + (s.missingFile > 0 ? ` · 缺文件 ${s.missingFile}` : "")
      + (s.failed > 0 ? ` · 失败 ${s.failed}` : "")
      + ` · 引用 ${s.total}（不含 Bash 脚本成员）`
      + (run.import.sourceDir ? ` · 源目录 ${run.import.sourceDir}` : "")
    : "";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <main className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        {/* 铺满布局：导航 / 标题行 / 警告固定高，工作台 flex-1 精确吃满剩余高度 */}
        <div className="shrink-0">
          <AppHeader />
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <Link href="/runs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-4" /> Runs
          </Link>
          <h1 className="text-xl font-bold">{run.name ?? run.runId}</h1>
          <Badge variant={STATUS_VARIANT[run.status] ?? "gray"}>{run.status}</Badge>
          <span className="font-mono text-xs text-muted-foreground">{run.runId}</span>
          {!run.exportDataComplete ? (
            <Badge variant="yellow" className="text-xs">数据不完整</Badge>
          ) : null}
          {sessionStats ? (
            <span className="text-xs text-muted-foreground" title={sessionStatsTitle}>
              {sessionStats}
            </span>
          ) : null}
          <span className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-1.5"
            onClick={() => setUploadOpen(true)}
          >
            <UploadIcon className="size-3.5" />
            上传到{BAY_NAME}
          </Button>
        </div>

        <UploadBundleDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          runId={run.runId}
          runName={run.name}
        />

        {viewModel.warnings.length > 0 ? (
          <div className="shrink-0 rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-700 dark:text-yellow-400">
            {viewModel.warnings.slice(0, 5).map(w => <p key={w}>⚠ {w}</p>)}
          </div>
        ) : null}

        {/* 工作台（铺满页宽）：toolbar（视图标题 / 模式与透镜 / 图例）+ 画布（结构
            图或时间轴）+ 侧栏；子图经生成器节点「子图 ▸」入口以弹窗展开 */}
        <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="flex h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-black/[0.08] bg-black/[0.015] px-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="truncate px-1 text-xs font-medium text-[#57606a]" title={view.title}>
                {view.title}
              </span>
              {/* 视图模式：结构图（DAG）/ 时间轴（Trace 泳道）/ 账本（重试浪费）——共用选中与侧栏；
                  无图数据时隐藏（三模式均不可用，切换无意义） */}
              {hasGraph ? (
                <div className="flex items-center rounded-md border border-black/10 bg-white p-0.5" role="group" aria-label="视图模式">
                  {([["graph", "结构"], ["trace", "时间轴"], ["ledger", "账本"]] as const).map(([k, t]) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={mode === k}
                      onClick={() => setMode(k)}
                      className={`rounded px-2 py-0.5 text-[11px] leading-5 transition-colors ${
                        mode === k ? "bg-black/[0.07] font-medium text-[#1f2328]" : "text-[#57606a] hover:text-[#1f2328]"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              ) : null}
              {/* 指标透镜（结构图模式）：切换节点着色维度——状态 / Token / 时长 / 轮次 / 缓存 */}
              {mode === "graph" && hasGraph ? (
                <div className="flex items-center rounded-md border border-black/10 bg-white p-0.5" role="group" aria-label="指标透镜">
                  {LENS_META.map(l => (
                    <button
                      key={l.key}
                      type="button"
                      aria-pressed={lens === l.key}
                      onClick={() => setLens(l.key)}
                      className={`rounded px-1.5 py-0.5 text-[11px] leading-5 transition-colors ${
                        lens === l.key ? "bg-black/[0.07] font-medium text-[#1f2328]" : "text-[#57606a] hover:text-[#1f2328]"
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {hasGraph && mode === "graph" && lens === "status" ? (
              <div className="hidden items-center gap-3.5 text-[11px] text-[#8c959f] lg:flex" aria-label="图例">
                {LEGEND_STATUSES.map(s => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ backgroundColor: RUN_STATUS_META[s].color }} aria-hidden />
                    {RUN_STATUS_META[s].label}
                  </span>
                ))}
                <span className="h-3.5 w-px bg-black/10" aria-hidden />
                <span className="inline-flex items-center gap-1.5">
                  <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden>
                    <path d="M1 4 H17" stroke={RUN_COLORS.edge} strokeWidth="1.25" />
                  </svg>
                  依赖
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden>
                    <path d="M1 4 H17" stroke={RUN_COLORS.rollback} strokeWidth="1.25" strokeDasharray="4 3" />
                  </svg>
                  回滚
                </span>
              </div>
            ) : hasGraph && mode === "graph" ? (
              <div className="hidden items-center gap-2 text-[11px] text-[#8c959f] lg:flex" aria-label="图例">
                <span>{LENS_META.find(l => l.key === lens)?.legend}</span>
                {lens === "context" ? (
                  // 水位透镜：节点是容器、上下文是水——图例直接给容器示意与警戒线
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                        <rect x="0.5" y="0.5" width="13" height="13" rx="3.5" fill="#ffffff" stroke="#d0d7de" strokeWidth="1" />
                        <rect x="1.5" y={14 - 12 * 0.6} width="11" height={12 * 0.6} fill="#4a93da" fillOpacity="0.32" />
                        <line x1="1.5" x2="12.5" y1={14 - 12 * 0.8} y2={14 - 12 * 0.8} stroke="#cf222e" strokeWidth="1" strokeDasharray="2 1.5" strokeOpacity="0.6" />
                      </svg>
                      水深 = 峰值水位
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden>
                        <line x1="1" y1="4" x2="15" y2="4" stroke="#cf222e" strokeWidth="1.2" strokeDasharray="3 2.5" strokeOpacity="0.6" />
                      </svg>
                      {WATER_CRITICAL_PCT}% 警戒线
                    </span>
                  </>
                ) : lens === "redundancy" ? (
                  // 冗余透镜：绝对阈值三档（评分卡同款 0.6/0.8），低分才警示
                  <>
                    {REDUNDANCY_BANDS.map(b => (
                      <span
                        key={b.label}
                        className="inline-flex items-center gap-1.5"
                        title={b.label}
                      >
                        <span
                          className="size-2.5 rounded-sm border"
                          style={{ borderColor: b.color, backgroundColor: `${b.color}30` }}
                          aria-hidden
                        />
                        {b.label}
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    <span>低</span>
                    {METRIC_SCALE.map(c => (
                      <span
                        key={c}
                        className="size-2.5 rounded-sm border"
                        style={{ borderColor: c, backgroundColor: `${c}30` }}
                        aria-hidden
                      />
                    ))}
                    <span>高</span>
                  </>
                )}
                <span className="h-3.5 w-px bg-black/10" aria-hidden />
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm border" style={{ borderColor: METRIC_EMPTY }} aria-hidden />
                  无会话数据
                </span>
              </div>
            ) : hasGraph && mode === "trace" ? (
              <div className="hidden items-center gap-3.5 text-[11px] text-[#8c959f] lg:flex" aria-label="图例">
                <span className="inline-flex items-center gap-1.5">
                  <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden>
                    <rect width="20" height="8" rx="2" fill={RUN_STATUS_META.passed.color} fillOpacity="0.82" />
                  </svg>
                  执行
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden>
                    <rect y="0.5" width="20" height="6" rx="2" fill={RUN_STATUS_META.passed.color} fillOpacity="0.22" stroke={RUN_STATUS_META.passed.color} strokeWidth="0.8" />
                  </svg>
                  验收
                </span>
                <span className="h-3.5 w-px bg-black/10" aria-hidden />
                {(["passed", "failed"] as const).map(s => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ backgroundColor: RUN_STATUS_META[s].color }} aria-hidden />
                    {RUN_STATUS_META[s].label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="relative flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1">
              {!hasGraph ? (
                /* 空态引导卡：导出包无 graph 注解——就地说明原因与仍可用的
                   信息，替代静默空画布（内容层，哑光材质不用玻璃） */
                <div className="flex min-w-0 flex-1 items-center justify-center p-8">
                  <div className="max-w-md rounded-2xl border border-dashed border-black/15 bg-black/[0.015] px-8 py-7 text-center">
                    <p className="text-sm font-semibold text-[#1f2328]">该 Run 没有图数据</p>
                    <p className="mt-2 text-xs leading-5 text-[#57606a]">
                      导出包未包含 graph 注解数据（annotation.graph），结构图、时间轴与重试账本不可用。
                      Run 概览与成员会话信息仍可在右侧查看。
                    </p>
                  </div>
                </div>
              ) : mode === "graph" ? (
                <RunCanvas
                  view={view}
                  nodesByKey={nodesByKey}
                  selectedKey={selectedKey}
                  onSelectNode={setSelectedKey}
                  onOpenSubgraph={openSubgraph}
                  lens={lens}
                />
              ) : mode === "trace" ? (
                <RunTrace
                  view={view}
                  nodesByKey={nodesByKey}
                  selectedKey={selectedKey}
                  onSelectNode={setSelectedKey}
                />
              ) : (
                <RunRetryLedger
                  vm={viewModel}
                  selectedKey={selectedKey}
                  onSelectNode={setSelectedKey}
                />
              )}
            </div>
            {/* 概览/历史侧栏：浮层玻璃面板（平移画布时内容从面板下滑过被
                虚化，替代硬边栏），滚动内容经 mask 在上下缘渐隐。右缘让出
                28px——trace/台账模式的画布滚动条不被面板盖住 */}
            <aside className="run-glass run-scroll-fade absolute inset-y-2 right-7 z-10 w-[360px] shrink-0 overflow-y-auto rounded-2xl">
              {selectedNode ? (
                <RunNodeDetail
                  node={selectedNode}
                  rollbacks={nodeRollbacks}
                  peers={peers}
                  onSelectNode={key => { setSelectedKey(key); }}
                  onClose={() => setSelectedKey(null)}
                />
              ) : (
                <RunOverview viewModel={viewModel} />
              )}
            </aside>
          </div>
        </div>

        <RunSubgraphDialog
          open={subgraphKey !== null}
          onOpenChange={next => { if (!next) setSubgraphKey(null); }}
          views={viewModel.views}
          nodesByKey={nodesByKey}
          rollbacks={viewModel.rollbacks}
          entryKey={subgraphKey}
          lens={lens}
        />
      </main>
    </div>
  );
}
