// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// workflow-bundle 导入入口（Runs 页），与 LocalFileImport 同款 Dialog 步骤流
// 与双数据源形态（本地目录 / 数据仓）：
// - 本地：input → browse（browse-directory API，bundle 目录绿色高亮点击即导
//   入——对应 LocalFileImport 中可导入文件的直导交互）
// - 数据仓：两阶段（目录选择 → 目录内 bundle 列表），与 sessions 页数据仓
//   导入步同构（同一顶层目录注册表 + 过滤/全选/多选/批量导入/逐项状态），
//   为后续两会话导入入口归一预留同一结构
// 两条通路都 job 化：POST 立即返回 jobId → 轮询 status 到 done/error →
// router.refresh()。数据仓未配置/凭据失败 → LakeTokenDialog 引导（保存后
// 自动重试），全程不离开导入流。

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { LakeTokenDialog } from "@/components/LakeTokenDialog";
import { serverLakeConfigStatus, type LakeTokenReason } from "@/lib/lake-token-prompt";
import { lakeErrorMessage } from "@/components/ingest/lake-ui";
import { BAY_NAME } from "@/lib/branding";
import { BUNDLE_ROOT_DIR } from "@/lib/lake/bundle-layout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { sortDirEntries, type DirEntry } from "@/components/ingest/browse";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  FileIcon,
  FolderGit2Icon,
  FolderIcon,
  GlobeIcon,
  LoaderIcon,
  SearchIcon,
} from "lucide-react";

type Step = "input" | "browse" | "importing" | "lake";
type SourceType = "local" | "lake";

interface LakeBundleItem {
  runId: string;
  name: string | null;
  status: string | null;
  exportDataComplete: boolean | null;
  memberCount: number | null;
  sessionCount: number | null;
  submitter: string | null;
  uploadedAt: string | null;
  commitTime: string | null;
  fileCount: number | null;
  imported: boolean;
}

// 数据仓批量导入逐项状态（镜像 sessions 页 importStatuses；bundle 导入是
// job 化的——POST 发起后统一轮询，状态机 pending → importing → success/error）
interface LakeImportItem {
  runId: string;
  name: string | null;
  jobId: string | null;
  status: "pending" | "importing" | "success" | "error";
  message: string | null;
}

const LAKE_STATUS_VARIANT: Record<string, "green" | "red" | "orange" | "gray"> = {
  passed: "green",
  failed: "red",
  running: "orange",
};

interface JobState {
  jobId: string;
  runId: string;
  step: "validate" | "store" | "import" | "done" | "error";
  total: number;
  imported: number;
  existing: number;
  missingFile: number;
  failed: number;
  currentSid: string | null;
  error: string | null;
  warnings: string[];
}

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)}K`;
  return `${(size / 1048576).toFixed(1)}M`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function BundleImport() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("input");
  const [dirPath, setDirPath] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [dirEntries, setDirEntries] = useState<DirEntry[]>([]);
  const [dirFilter, setDirFilter] = useState("");
  // 目录浏览时间排序方向：默认降序（最新在前），点表头箭头切换
  const [dirSortAsc, setDirSortAsc] = useState(false);
  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  // 导入来源：本地目录 / 数据仓（与 LocalFileImport 双源形态对齐）
  const [sourceType, setSourceType] = useState<SourceType>("local");
  const [lakeBundles, setLakeBundles] = useState<LakeBundleItem[]>([]);
  const [lakeLoading, setLakeLoading] = useState(false);
  const [lakeScope, setLakeScope] = useState("");
  // 数据仓两阶段（与 sessions 页同构）：null = 目录选择；选中目录 → 该目录
  // 内的 bundle 列表（bundle 专区计真实数，其余目录为会话范式恒空）
  const [lakeDirs, setLakeDirs] = useState<string[]>([]);
  const [lakeDir, setLakeDir] = useState<string | null>(null);
  const [lakeFilter, setLakeFilter] = useState("");
  const [lakeSelected, setLakeSelected] = useState<Set<string>>(new Set());
  // 批量导入逐项状态（轮询 tick 内读最新值 → ref 镜像）
  const [lakeImports, setLakeImports] = useState<LakeImportItem[]>([]);
  const lakeImportsRef = useRef<LakeImportItem[]>([]);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenReason, setTokenReason] = useState<LakeTokenReason>("no-credentials");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    lakeImportsRef.current = lakeImports;
  }, [lakeImports]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (batchPollRef.current) clearInterval(batchPollRef.current);
    };
  }, []);

  function resetState() {
    setStep("input");
    setDirPath("");
    setStarting(false);
    setError(null);
    setJob(null);
    setDirEntries([]);
    setDirFilter("");
    setDirSortAsc(false);
    setCurrentDir(null);
    setParentDir(null);
    setBrowseLoading(false);
    setSourceType("local");
    setLakeBundles([]);
    setLakeLoading(false);
    setLakeScope("");
    setLakeDirs([]);
    setLakeDir(null);
    setLakeFilter("");
    setLakeSelected(new Set());
    setLakeImports([]);
    lakeImportsRef.current = [];
    if (batchPollRef.current) {
      clearInterval(batchPollRef.current);
      batchPollRef.current = null;
    }
  }

  function startPolling(jobId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/ingest/import-bundle/status?jobId=${encodeURIComponent(jobId)}`);
        if (!res.ok) return; // job 过期等——保留最后状态，用户可重开
        const data = await res.json();
        setJob(data.job);
        if (data.job.step === "done" || data.job.step === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          router.refresh();
        }
      } catch {
        /* 轮询失败下轮重试 */
      }
    }, 1000);
  }

  async function startImport(target: string) {
    setError(null);
    setStarting(true);
    setDirPath(target);
    try {
      const res = await fetch("/api/ingest/import-bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirPath: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Import failed (${res.status})`);
        return;
      }
      setJob({
        jobId: data.jobId,
        runId: data.runId,
        step: "validate",
        total: 0,
        imported: 0,
        existing: 0,
        missingFile: 0,
        failed: 0,
        currentSid: null,
        error: null,
        warnings: [],
      });
      setStep("importing");
      startPolling(data.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setStarting(false);
    }
  }

  // 数据仓来源：预检服务端单源配置（未配置 → LakeTokenDialog 引导，保存后
  // 经 onSaved 自动重试本函数——首次使用全程不离开导入流），再拉目录清单 +
  // bundle 列表（恒停目录选择阶段，与 sessions 页一致）
  async function handleOpenLake() {
    const server = await serverLakeConfigStatus();
    if (!server.configured) {
      setTokenReason("unconfigured");
      setTokenDialogOpen(true);
      return;
    }
    setLakeScope(`${server.address || "服务端配置"} · 分支 ${server.branch}`);
    setLakeLoading(true);
    setError(null);
    setLakeBundles([]);
    setLakeDirs([]);
    setLakeDir(null);
    setLakeFilter("");
    setLakeSelected(new Set());
    try {
      const res = await fetch("/api/ingest/lake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bundle-list" }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 凭据类失败（私有仓未配置/令牌无效）→ 弹引导配置
        if (["no-credentials", "auth-failed", "forbidden"].includes(data.code ?? "")) {
          setTokenReason(data.code as LakeTokenReason);
          setTokenDialogOpen(true);
        }
        throw new Error(lakeErrorMessage(data));
      }
      setLakeBundles((data.items ?? []) as LakeBundleItem[]);
      setLakeDirs((data.dirs ?? []) as string[]);
      setStep("lake");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLakeLoading(false);
    }
  }

  function pickLakeDir(dir: string) {
    setLakeDir(dir);
    setLakeFilter("");
    setLakeSelected(new Set());
  }

  function toggleLakeSelection(runId: string) {
    setLakeSelected(prev => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  function updateLakeImports(runId: string, patch: Partial<LakeImportItem>) {
    setLakeImports(prev => prev.map(s => (s.runId === runId ? { ...s, ...patch } : s)));
  }

  // 数据仓批量导入：逐项发起（物化在 POST 内同步完成）→ 全部发起后统一轮询
  // 各 job 到终态。逐项状态与 sessions 页导入步同构（pending/importing/
  // success/error + Progress 计数）
  async function handleImportLakeBundles() {
    if (lakeSelected.size === 0) return;
    const byId = new Map(lakeBundles.map(b => [b.runId, b]));
    const selected = Array.from(lakeSelected)
      .map(id => byId.get(id))
      .filter((b): b is LakeBundleItem => b != null);
    if (selected.length === 0) return;
    setLakeImports(selected.map(b => ({
      runId: b.runId,
      name: b.name,
      jobId: null,
      status: "pending" as const,
      message: null,
    })));
    setStep("importing");
    setError(null);
    let anyJob = false;
    for (const b of selected) {
      updateLakeImports(b.runId, { status: "importing" });
      try {
        const res = await fetch("/api/ingest/lake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "bundle-import", runId: b.runId }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (["no-credentials", "auth-failed", "forbidden"].includes(data.code ?? "")) {
            setTokenReason(data.code as LakeTokenReason);
            setTokenDialogOpen(true);
          }
          updateLakeImports(b.runId, { status: "error", message: lakeErrorMessage(data) });
        } else {
          anyJob = true;
          updateLakeImports(b.runId, { jobId: data.jobId });
        }
      } catch (e) {
        updateLakeImports(b.runId, { status: "error", message: e instanceof Error ? e.message : "Network error" });
      }
    }
    if (anyJob) startBatchPolling();
    else router.refresh();
  }

  // 批量 job 轮询：每 tick 拉取所有未终态 job 的状态；本 tick 内全部到终态
  // 即收尾（清定时器 + 刷新），不等下一拍
  function startBatchPolling() {
    if (batchPollRef.current) clearInterval(batchPollRef.current);
    batchPollRef.current = setInterval(async () => {
      const pending = lakeImportsRef.current.filter(s => s.status === "importing" && s.jobId);
      if (pending.length === 0) {
        if (batchPollRef.current) {
          clearInterval(batchPollRef.current);
          batchPollRef.current = null;
        }
        return;
      }
      let finishedNow = 0;
      for (const p of pending) {
        try {
          const res = await fetch(`/api/ingest/import-bundle/status?jobId=${encodeURIComponent(p.jobId!)}`);
          if (!res.ok) continue; // job 过期等——保留最后状态
          const data = await res.json();
          const j = (data.job ?? null) as JobState | null;
          if (!j) continue;
          if (j.step === "done") {
            updateLakeImports(p.runId, {
              status: "success",
              message: `新导入 ${j.imported} · 已存在 ${j.existing}`
                + (j.missingFile > 0 ? ` · 缺文件 ${j.missingFile}` : "")
                + (j.failed > 0 ? ` · 失败 ${j.failed}` : ""),
            });
            finishedNow++;
          } else if (j.step === "error") {
            updateLakeImports(p.runId, { status: "error", message: j.error ?? "Import failed" });
            finishedNow++;
          }
        } catch {
          /* 轮询失败下轮重试 */
        }
      }
      if (finishedNow === pending.length) {
        if (batchPollRef.current) {
          clearInterval(batchPollRef.current);
          batchPollRef.current = null;
        }
        router.refresh();
      }
    }, 1000);
  }

  async function browseDirectory(dirPath: string) {
    setBrowseLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ingest/browse-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to browse directory");
        setBrowseLoading(false);
        return;
      }
      if (!data.isDirectory) {
        const parent = data.parentPath ?? (dirPath.split("/").slice(0, -1).join("/") || "/");
        browseDirectory(parent);
        return;
      }
      setDirEntries(data.entries ?? []);
      setDirFilter(""); // 进入新目录重置过滤（旧词对新目录无意义）
      setCurrentDir(data.currentPath);
      setParentDir(data.parentPath);
      setStep("browse");
      setBrowseLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setBrowseLoading(false);
    }
  }

  // bundle 目录点击即导入（对应 LocalFileImport 可导入文件的直导交互）；
  // 普通目录点击进入；文件不可导（bundle 导入目标是目录）
  function handleDirEntryClick(entry: DirEntry) {
    if (entry.isBundleDir) {
      startImport(entry.fullPath);
    } else if (entry.isDir) {
      browseDirectory(entry.fullPath);
    }
  }

  function handleBrowseFromInput() {
    browseDirectory(dirPath.trim() || "/");
  }

  function handleQuickJump(dirPath: string) {
    setDirPath(dirPath);
    browseDirectory(dirPath);
  }

  function handleGoUp() {
    if (parentDir) {
      browseDirectory(parentDir);
    }
  }

  function handleDone() {
    setOpen(false);
    resetState();
  }

  const busy = job !== null && job.step !== "done" && job.step !== "error";
  const finished = job !== null && (job.step === "done" || job.step === "error");
  const lakeDoneCount = lakeImports.filter(s => s.status === "success" || s.status === "error").length;
  const lakeAllDone = lakeImports.length > 0 && lakeDoneCount === lakeImports.length;
  const dirQuery = dirFilter.trim().toLowerCase();
  const filteredDirEntries = dirQuery
    ? dirEntries.filter(e => e.name.toLowerCase().includes(dirQuery))
    : dirEntries;
  const bundleTotal = dirEntries.filter(e => e.isBundleDir).length;
  const importedSoFar = (job?.imported ?? 0) + (job?.existing ?? 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetState(); }}>
      <DialogTrigger render={<Button variant="default" size="lg" className="gap-2 font-semibold"><FolderGit2Icon className="size-4 text-violet-500" />导入 Bundle</Button>} />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入 Bundle</DialogTitle>
          <DialogDescription>
            {step === "input" && "导入 Opsbot graph 运行的 workflow-bundle 目录"}
            {step === "browse" && "Browse directories and click a bundle directory to import"}
            {step === "lake" && (lakeDir == null
              ? "选择目录（数据仓顶层目录）"
              : "选择该目录下的 bundle 包导入")}
            {step === "importing" && (lakeImports.length > 0
              ? (lakeAllDone ? "Bundle import complete" : `导入 bundle ${lakeDoneCount}/${lakeImports.length}...`)
              : finished
                ? (job?.step === "error" ? "Import failed (details above)" : "Import complete")
                : `导入会话 ${importedSoFar}/${job?.total ?? 0}...`)}
          </DialogDescription>
        </DialogHeader>

        {step === "input" && (
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">导入来源</label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={sourceType === "local" ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSourceType("local"); setError(null); }}
                >
                  <FolderIcon className="size-3.5 mr-1" />
                  本地目录
                </Button>
                <Button
                  variant={sourceType === "lake" ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSourceType("lake"); setError(null); void handleOpenLake(); }}
                >
                  <GlobeIcon className="size-3.5 mr-1" />
                  {BAY_NAME}
                </Button>
              </div>
            </div>
            {sourceType === "local" && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">Bundle 目录</label>
              <div className="flex gap-2">
                <Input
                  placeholder="/path/to/bundle（含 workflow.json 与 sessions/）"
                  value={dirPath}
                  onChange={(e) => setDirPath(e.target.value)}
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBrowseFromInput}
                  className="gap-1.5 shrink-0"
                  disabled={starting}
                >
                  <FolderIcon className="size-3.5" />
                  Browse
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => handleQuickJump("~")}
                  title="~"
                >
                  <FolderIcon className="size-3 text-muted-foreground" />
                  主目录
                </Button>
              </div>
              <div className="mt-2 text-xs text-muted-foreground space-y-1">
                <p>workflow-bundle 目录：含 workflow.json 与 sessions/（manifest.json 同样识别）</p>
                <p>成员会话立即全量导入标准管线，导入完成后 run 页可见多代 DAG</p>
                <p className="text-blue-500 dark:text-blue-400">Click Browse to explore directories — bundle 目录绿色高亮，点击即导入</p>
              </div>
            </div>
            )}
            {sourceType === "lake" && lakeLoading && (
              <div className="flex items-center gap-2 py-4 justify-center">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">读取数据仓 bundle 列表...</span>
              </div>
            )}
            {starting && (
              <div className="flex items-center gap-2 py-2 justify-center">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Validating bundle...</span>
              </div>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "browse" && (
          <div className="space-y-3 overflow-hidden">
            <div className="flex items-center gap-2 text-sm font-medium bg-muted/50 px-3 py-2 rounded-md">
              <FolderIcon className="size-4 text-blue-500 shrink-0" />
              <span className="flex-1 min-w-0 truncate">{currentDir}</span>
            </div>
            {parentDir && (
              <Button variant="ghost" size="sm" onClick={handleGoUp} className="gap-1.5">
                <ArrowUpIcon className="size-3.5" />
                Parent directory
              </Button>
            )}
            {browseLoading ? (
              <div className="flex items-center gap-2 py-4">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Loading directory...</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Filter by directory name..."
                    value={dirFilter}
                    onChange={(e) => setDirFilter(e.target.value)}
                    className="flex-1"
                  />
                  {dirQuery && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {filteredDirEntries.length} of {dirEntries.length} shown
                    </span>
                  )}
                </div>
                <div className="max-h-[320px] overflow-y-auto overflow-x-hidden border rounded-lg">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px]"></TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead className="w-[150px]">
                          <span
                            role="button"
                            className="inline-flex items-center gap-0.5 cursor-pointer select-none hover:text-foreground"
                            title={dirSortAsc ? "按修改时间升序（点击改为降序）" : "按修改时间降序（点击改为升序）"}
                            onClick={() => setDirSortAsc(v => !v)}
                          >
                            Modified
                            {dirSortAsc
                              ? <ChevronUpIcon className="size-3.5" />
                              : <ChevronDownIcon className="size-3.5" />}
                          </span>
                        </TableHead>
                        <TableHead className="w-[80px]">Size</TableHead>
                        <TableHead className="w-[100px]">Type</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredDirEntries.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                            {dirQuery ? "No entries match your filter" : "Empty directory"}
                          </TableCell>
                        </TableRow>
                      )}
                      {sortDirEntries(filteredDirEntries, dirSortAsc).map(entry => (
                      <TableRow
                        key={entry.fullPath}
                        className="cursor-pointer hover:bg-primary/5"
                        onClick={() => handleDirEntryClick(entry)}
                      >
                        <TableCell>
                          {entry.isBundleDir
                            ? <FolderGit2Icon className="size-4 text-emerald-500" />
                            : entry.isDir
                              ? <FolderIcon className="size-4 text-blue-500" />
                              : <FileIcon className="size-4 text-muted-foreground" />
                          }
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex items-center gap-1">
                            <span className={`flex-1 min-w-0 truncate${entry.isBundleDir ? " font-medium text-emerald-600 dark:text-emerald-400" : ""}`} title={entry.name}>
                              {entry.name}
                            </span>
                            {entry.isDir && <ChevronRightIcon className="size-3.5 text-muted-foreground shrink-0" />}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                          {entry.mtime ? formatTime(new Date(entry.mtime).toISOString()) : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {entry.isDir ? "" : formatSize(entry.size)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {entry.isBundleDir ? (
                            <span className="text-emerald-500 dark:text-emerald-400">Bundle</span>
                          ) : entry.isDir ? (
                            <span className="text-blue-500 dark:text-blue-400">Directory</span>
                          ) : (
                            <span className="text-muted-foreground">{entry.name.includes('.') ? entry.name.split('.').pop()! : "File"}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              </>
            )}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setStep("input"); setError(null) }}>
                Back
              </Button>
              <span className="text-xs text-muted-foreground">
                {dirQuery
                  ? `${filteredDirEntries.filter(e => e.isBundleDir).length} of ${bundleTotal} bundle directories shown`
                  : `${bundleTotal} bundle directories found`}
              </span>
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "lake" && lakeDir == null && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">当前远端：{lakeScope}</p>
            {lakeDirs.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                数据仓暂无目录
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2 max-h-[320px] overflow-y-auto">
                {lakeDirs.map(d => (
                  <Button key={d} variant="outline" size="sm" className="justify-between h-auto py-2" onClick={() => pickLakeDir(d)}>
                    <span className="truncate" title={d}>{d}</span>
                    <span className="text-xs text-muted-foreground shrink-0 ml-1">
                      {d === BUNDLE_ROOT_DIR ? lakeBundles.length : 0}
                    </span>
                  </Button>
                ))}
              </div>
            )}
            {lakeDirs.length > 0 && !lakeDirs.includes(BUNDLE_ROOT_DIR) && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                数据仓暂无 bundle 专区（{BUNDLE_ROOT_DIR}/）——先在 Runs 页上传 bundle 后再导入
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              目录 = 数据仓顶层目录；bundle 包存放在 <span className="font-medium text-foreground">{BUNDLE_ROOT_DIR}</span> 专区，其余目录为会话范式
            </p>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "lake" && lakeDir != null && (() => {
          const q = lakeFilter.toLowerCase();
          const scoped = lakeDir === BUNDLE_ROOT_DIR ? lakeBundles : [];
          const filtered = scoped
            .filter(b => !q
              || (b.name?.toLowerCase().includes(q) ?? false)
              || b.runId.toLowerCase().includes(q)
              || (b.submitter?.toLowerCase().includes(q) ?? false)
              || (b.status?.toLowerCase().includes(q) ?? false))
            .slice()
            .sort((a, b) => (b.uploadedAt ?? b.commitTime ?? "").localeCompare(a.uploadedAt ?? a.commitTime ?? ""));
          const allFilteredSelected = filtered.length > 0 && filtered.every(b => lakeSelected.has(b.runId));
          return (
            <div className="space-y-3 overflow-hidden">
              <p className="text-xs text-muted-foreground">
                当前远端：{lakeScope}
                {lakeDirs.length > 0 && (
                  <> · 目录 <span className="font-medium text-foreground">{lakeDir}</span></>
                )}
              </p>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Search by name, run ID, submitter, or status..."
                  value={lakeFilter}
                  onChange={(e) => setLakeFilter(e.target.value)}
                  className="flex-1"
                />
                <SearchIcon className="size-4 text-muted-foreground shrink-0" />
              </div>
              <div className="flex items-center gap-2 mb-2">
                <Checkbox checked={allFilteredSelected} onCheckedChange={() => {
                  if (allFilteredSelected) {
                    setLakeSelected(prev => {
                      const next = new Set(prev);
                      for (const b of filtered) next.delete(b.runId);
                      return next;
                    });
                  } else {
                    setLakeSelected(prev => {
                      const next = new Set(prev);
                      for (const b of filtered) next.add(b.runId);
                      return next;
                    });
                  }
                }} />
                <span className="text-sm text-muted-foreground">
                  {q ? `${filtered.length} of ${scoped.length} shown` : `${scoped.length} bundles`}
                </span>
              </div>
              <div className="max-h-[320px] overflow-y-auto overflow-x-hidden border rounded-lg">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[36px] px-2"></TableHead>
                      <TableHead className="w-[170px] px-2">Run</TableHead>
                      <TableHead className="w-[90px] px-2">状态</TableHead>
                      <TableHead className="w-[110px] px-2">规模</TableHead>
                      <TableHead className="w-[90px] px-2">提交人</TableHead>
                      <TableHead className="w-[110px] px-2">时间</TableHead>
                      <TableHead className="px-2">提交信息</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground py-4">
                          {q
                            ? "No bundles match your search"
                            : lakeDir === BUNDLE_ROOT_DIR
                              ? "专区暂无 bundle 包——先在 Runs 页上传"
                              : `该目录是会话范式目录，bundle 包存放在 ${BUNDLE_ROOT_DIR} 专区`}
                        </TableCell>
                      </TableRow>
                    )}
                    {filtered.map(b => (
                      <TableRow key={b.runId} className={lakeSelected.has(b.runId) ? "bg-primary/5" : ""}>
                        <TableCell className="px-2 w-[36px]">
                          <Checkbox checked={lakeSelected.has(b.runId)} onCheckedChange={() => toggleLakeSelection(b.runId)} />
                        </TableCell>
                        <TableCell className="px-2 text-xs py-2 align-middle">
                          <span className="block truncate" title={b.name || b.runId}>
                            {b.imported && <Badge variant="purple" className="px-1 text-[10px] mr-1">已导入</Badge>}
                            {b.name || <span className="text-muted-foreground">{b.runId}</span>}
                          </span>
                        </TableCell>
                        <TableCell className="px-2 text-xs py-2 align-middle">
                          <Badge variant={LAKE_STATUS_VARIANT[b.status ?? ""] ?? "gray"}>{b.status ?? "—"}</Badge>
                        </TableCell>
                        <TableCell className="px-2 text-xs py-2 align-middle whitespace-nowrap">
                          {b.memberCount ?? "—"} 成员 · {b.sessionCount ?? "—"} 会话
                        </TableCell>
                        <TableCell className="px-2 text-xs py-2 align-middle truncate" title={b.submitter ?? ""}>
                          {b.submitter ?? "—"}
                        </TableCell>
                        <TableCell className="px-2 text-xs py-2 align-middle whitespace-nowrap">
                          {(b.uploadedAt ?? b.commitTime) ? formatTime(b.uploadedAt ?? b.commitTime!) : "—"}
                        </TableCell>
                        <TableCell className="px-2 text-xs py-2 align-middle">
                          <span className="block truncate" title={b.runId}>
                            {b.fileCount ?? "—"} files · {b.runId}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {lakeSelected.size === 0 && (
                <p className="text-sm text-muted-foreground">Select at least one bundle to import</p>
              )}
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            </div>
          );
        })()}

        {step === "importing" && lakeImports.length > 0 && (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            <div className="flex items-center gap-2 text-xs text-muted-foreground pb-1 border-b">
              <LoaderIcon className={`size-3.5 ${lakeAllDone ? "hidden" : "animate-spin"}`} />
              <span>Progress: {lakeDoneCount}/{lakeImports.length}</span>
            </div>
            {lakeImports.map(s => (
              <div key={s.runId} className="text-sm border-b pb-1.5 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate" title={s.runId}>{s.name ?? s.runId}</span>
                  {s.status === "pending" && <span className="text-muted-foreground">Waiting</span>}
                  {s.status === "importing" && (
                    <span className="text-blue-600 dark:text-blue-400 flex items-center gap-1">
                      <LoaderIcon className="size-3 animate-spin" />
                      Importing...
                    </span>
                  )}
                  {s.status === "success" && (
                    <span className="text-emerald-600 dark:text-emerald-400">{s.message}</span>
                  )}
                  {s.status === "error" && <Badge variant="red">Failed</Badge>}
                </div>
                {s.status === "error" && s.message && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">{s.message}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {step === "importing" && job && lakeImports.length === 0 && (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            <div className="flex items-center gap-2 text-xs text-muted-foreground pb-1 border-b">
              <LoaderIcon className={`size-3.5 ${busy ? "animate-spin" : "hidden"}`} />
              <span>
                Progress: {importedSoFar}/{job.total}
                {job.step === "validate" ? " · 校验 manifest..." : job.step === "store" ? " · 写入 manifest..." : ""}
              </span>
            </div>
            {job.currentSid && busy && (
              <div className="text-sm border-b pb-1.5">
                <span className="flex-1 truncate font-mono text-xs">{job.currentSid}</span>
              </div>
            )}
            <div className="text-sm space-y-1">
              {job.step === "error" ? (
                <p className="text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">{job.error}</p>
              ) : job.step === "done" ? (
                <p className="text-emerald-600 dark:text-emerald-400">
                  完成：新导入 {job.imported} · 已存在 {job.existing}
                  {job.missingFile > 0 ? ` · 缺文件 ${job.missingFile}` : ""}
                  {job.failed > 0 ? ` · 失败 ${job.failed}` : ""}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  {job.step === "import" ? "导入成员会话..." : "处理 manifest..."}
                </p>
              )}
              {job.warnings.map(w => (
                <p key={w} className="text-xs text-amber-600 dark:text-amber-400 break-words" title={w}>⚠ {w}</p>
              ))}
            </div>
          </div>
        )}
        {step === "importing" && !job && lakeImports.length === 0 && (
          <div className="flex items-center gap-2 py-4 justify-center">
            <LoaderIcon className="size-4 animate-spin" />
            <span className="text-sm text-muted-foreground">Starting import job...</span>
          </div>
        )}

        <DialogFooter>
          {step === "input" && sourceType === "local" && (
            <Button onClick={() => startImport(dirPath.trim())} disabled={!dirPath.trim() || starting}>
              {starting ? (
                <span className="flex items-center gap-1.5">
                  <LoaderIcon className="size-4 animate-spin" />
                  Validating...
                </span>
              ) : (
                "导入"
              )}
            </Button>
          )}
          {step === "input" && sourceType === "lake" && (
            <Button onClick={() => void handleOpenLake()} disabled={lakeLoading}>
              {lakeLoading ? "Fetching..." : `Fetch from ${BAY_NAME}`}
            </Button>
          )}
          {step === "browse" && (
            <Button variant="outline" onClick={() => { setStep("input"); setError(null) }}>
              Back
            </Button>
          )}
          {step === "lake" && lakeDir == null && (
            <Button variant="outline" onClick={() => { setStep("input"); setError(null) }}>
              Back
            </Button>
          )}
          {step === "lake" && lakeDir != null && (
            <>
              <Button variant="outline" onClick={() => { setLakeDir(null); setLakeFilter(""); setLakeSelected(new Set()); }}>
                目录选择
              </Button>
              <Button onClick={() => void handleImportLakeBundles()} disabled={lakeSelected.size === 0}>
                Import {lakeSelected.size > 0 ? `${lakeSelected.size} Selected` : ""}
              </Button>
            </>
          )}
          {step === "importing" && (finished || lakeAllDone) && (
            <Button onClick={handleDone}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
      <LakeTokenDialog
        open={tokenDialogOpen}
        onOpenChange={setTokenDialogOpen}
        reason={tokenReason}
        onSaved={() => {
          if (tokenReason === "unconfigured") {
            setTokenDialogOpen(false);
            void handleOpenLake();
          }
        }}
      />
    </Dialog>
  );
}
