// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// workflow-bundle 导入入口（Runs 页），与 LocalFileImport 同款 Dialog 步骤流
// （input → browse → importing）与同一目录浏览通路（browse-directory API）：
// bundle 目录（含 workflow.json/manifest.json，服务端 isBundleDir 标记）绿色
// 高亮，点击即导入——对应 LocalFileImport 中可导入文件的直导交互。导入 job
// 化：POST 立即返回 jobId → 轮询 status 到 done/error → router.refresh()。

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  LoaderIcon,
} from "lucide-react";

type Step = "input" | "browse" | "importing";

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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
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
            {step === "importing" && (finished
              ? (job?.step === "error" ? "Import failed (details above)" : "Import complete")
              : `导入会话 ${importedSoFar}/${job?.total ?? 0}...`)}
          </DialogDescription>
        </DialogHeader>

        {step === "input" && (
          <div className="space-y-3">
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

        {step === "importing" && job && (
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
        {step === "importing" && !job && (
          <div className="flex items-center gap-2 py-4 justify-center">
            <LoaderIcon className="size-4 animate-spin" />
            <span className="text-sm text-muted-foreground">Starting import job...</span>
          </div>
        )}

        <DialogFooter>
          {step === "input" && (
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
          {step === "browse" && (
            <Button variant="outline" onClick={() => { setStep("input"); setError(null) }}>
              Back
            </Button>
          )}
          {step === "importing" && finished && (
            <Button onClick={handleDone}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
