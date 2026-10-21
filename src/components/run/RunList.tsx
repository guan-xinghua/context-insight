// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run 列表（服务端 page 直读 run-store 出初始数据；导入/删除后 router.refresh
// 回服务端重取——列表数据无客户端分页需求，量级 = 已导入 run 数）。

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UploadBundleDialog } from "@/components/run/UploadBundleDialog";
import { BAY_NAME } from "@/lib/branding";
import { Trash2Icon, UploadIcon, LoaderIcon, CheckIcon, XIcon } from "lucide-react";

export interface RunRow {
  runId: string;
  name: string | null;
  status: string;
  exportDataComplete: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  importedAt: string | null;
  generations: number[];
  nodeCount: number;
  memberCount: number;
  sessionMemberCount: number;
  rollbackCount: number;
  subgraphCount: number;
  warnings: string[];
}

const STATUS_VARIANT: Record<string, "green" | "red" | "orange" | "gray" | "slate" | "yellow"> = {
  passed: "green",
  failed: "red",
  running: "orange",
  pending: "gray",
  carried: "slate",
  unknown: "yellow",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function RunList({ initialRuns, warnings }: { initialRuns: RunRow[]; warnings: string[] }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 上传到数据仓（与会话列表同款「导入后上传」）：行内状态图标 + 共享弹窗
  type UploadStatus = "idle" | "uploading" | "done" | "error";
  const [uploadStatus, setUploadStatus] = useState<Record<string, UploadStatus>>({});
  const [uploadTarget, setUploadTarget] = useState<{ runId: string; name: string | null } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const remove = async (runId: string) => {
    setDeleting(runId);
    setError(null);
    try {
      const res = await fetch(`/api/observe/run/${encodeURIComponent(runId)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `删除失败 (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Opsbot graph 运行（workflow-bundle 导入件）。run 导入的会话只在 run 详情内查看，不进 Sessions 列表；
        删除 run 会同时删除由它导入的会话（导入前已存在的会话不受影响）。
      </p>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {warnings.map(w => (
        <p key={w} className="text-xs text-yellow-600 dark:text-yellow-400">⚠ {w}</p>
      ))}
      {initialRuns.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无导入的 Run。点击右上「导入 Bundle」，选择包含 workflow.json 与 sessions/ 的包目录；
          也可用 CLI：<code className="mx-1 rounded bg-muted px-1">cbi import-bundle &lt;dir&gt;</code>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Run</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">代</th>
                <th className="px-3 py-2 font-medium">规模</th>
                <th className="px-3 py-2 font-medium">回滚/子图</th>
                <th className="px-3 py-2 font-medium">导入时间</th>
                <th className="px-3 py-2 font-medium w-14" title={`上传到 ${BAY_NAME}`}>上传</th>
                <th className="px-3 py-2 font-medium w-10"></th>
              </tr>
            </thead>
            <tbody>
              {initialRuns.map(run => (
                <tr key={run.runId} className="border-b last:border-0 hover:bg-accent/20">
                  <td className="px-3 py-2">
                    <Link href={`/run/${encodeURIComponent(run.runId)}`} className="font-medium text-foreground hover:underline">
                      {run.name ?? run.runId}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {run.runId}
                      {!run.exportDataComplete && (
                        <span className="ml-1 text-yellow-600 dark:text-yellow-400" title="导出数据不完整（exportDataComplete=false）">
                          · 数据不完整
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={STATUS_VARIANT[run.status] ?? "gray"}>{run.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {run.generations.map(g => (
                      <span key={g} className="mr-1 rounded bg-muted px-1.5 py-0.5">{g === 0 ? "g0 首次" : `g${g} 回滚`}</span>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {run.nodeCount} 节点 · {run.memberCount} 成员 · {run.sessionMemberCount} 会话
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {run.rollbackCount} 回滚 · {run.subgraphCount} 子图
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(run.importedAt)}</td>
                  <td className="px-3 py-2">
                    {(() => {
                      const uStatus = uploadStatus[run.runId] ?? "idle";
                      return (
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-7"
                          onClick={() => {
                            setUploadTarget({ runId: run.runId, name: run.name });
                            setUploadOpen(true);
                          }}
                          disabled={uStatus === "uploading"}
                          title={`上传到 ${BAY_NAME}`}
                          aria-label={`上传 run ${run.runId} 到数据仓`}
                        >
                          {uStatus === "uploading" && <LoaderIcon className="size-4 animate-spin" />}
                          {uStatus === "idle" && <UploadIcon className="size-4" />}
                          {uStatus === "done" && <CheckIcon className="size-4 text-emerald-500" />}
                          {uStatus === "error" && <XIcon className="size-4 text-red-500" />}
                        </Button>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-red-500"
                      disabled={deleting === run.runId}
                      onClick={() => void remove(run.runId)}
                      aria-label={`删除 run ${run.runId}`}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <UploadBundleDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        runId={uploadTarget?.runId ?? ""}
        runName={uploadTarget?.name ?? null}
        onUploadStart={() => {
          if (uploadTarget) setUploadStatus(prev => ({ ...prev, [uploadTarget.runId]: "uploading" }));
          setError(null);
        }}
        onResult={({ ok, message }) => {
          if (uploadTarget) setUploadStatus(prev => ({ ...prev, [uploadTarget.runId]: ok ? "done" : "error" }));
          if (!ok && message) setError(message);
        }}
      />
    </div>
  );
}
