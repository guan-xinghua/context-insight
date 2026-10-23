// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run 上传到数据仓（lake-bundle 板块）：提交人/描述表单 → bundle-upload
// action（数据源 = 已导入 run，服务端从 insight 装配整包）。与会话上传
// （UploadToLakeDialog）同款受控弹窗 + onUploadStart/onResult 回调形态——
// sessions/runs 上传链路归一基础。

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoaderIcon } from "lucide-react";
import { BAY_NAME } from "@/lib/branding";

export interface BundleUploadOutcome {
  ok: boolean;
  message: string | null;
  /** 上传成功但包内缺正文的成员会话提示 */
  warnings?: string[];
}

interface UploadBundleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  runName: string | null;
  onUploadStart?: () => void;
  onResult?: (outcome: BundleUploadOutcome) => void;
}

export function UploadBundleDialog({
  open,
  onOpenChange,
  runId,
  runName,
  onUploadStart,
  onResult,
}: UploadBundleDialogProps) {
  const [submitter, setSubmitter] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ unchanged: boolean; sessionCount: number; missingSessions: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 打开即重置——render-phase prop 变化模式
  // （https://react.dev/learn/you-might-not-need-an-effect），替代在 effect
  // 里同步 setState（react-hooks 规则禁止，会触发级联渲染）
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSubmitter("");
      setDescription("");
      setUploading(false);
      setResult(null);
      setError(null);
    }
  }

  async function startUpload() {
    setUploading(true);
    setResult(null);
    setError(null);
    onUploadStart?.();
    try {
      const desc = `提交人: ${submitter.trim()}` + (description.trim() ? `\n内容描述: ${description.trim()}` : "");
      const res = await fetch("/api/ingest/lake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bundle-upload", runId, description: desc }),
      });
      const data = await res.json();
      if (!res.ok) {
        const message = data.error ?? `上传失败 (${res.status})`;
        setError(message);
        onResult?.({ ok: false, message });
        return;
      }
      setResult({
        unchanged: data.unchanged === true,
        sessionCount: typeof data.sessionCount === "number" ? data.sessionCount : 0,
        missingSessions: Array.isArray(data.missingSessions) ? data.missingSessions : [],
      });
      onResult?.({ ok: true, message: null, warnings: Array.isArray(data.warnings) ? data.warnings : [] });
    } catch (e) {
      const message = e instanceof Error ? e.message : "网络错误";
      setError(message);
      onResult?.({ ok: false, message });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传 Run 到 {BAY_NAME}</DialogTitle>
          <DialogDescription>
            整个 run 作为一个包上传（含 manifest、体检报告与成员会话），同名包再次上传会整体替换
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-sm bg-muted/50 px-3 py-2 rounded-md truncate" title={runId}>
            {runName || runId}
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">提交人</label>
            <Input
              placeholder="如：张三"
              value={submitter}
              onChange={(e) => setSubmitter(e.target.value)}
              disabled={uploading}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">内容描述</label>
            <Input
              placeholder="这个包是什么（可选）"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={uploading}
            />
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>包里的对话记录会先做敏感信息清洗，洗不干净的会拒绝上传</p>
          </div>
          {uploading && (
            <div className="flex items-center gap-2 py-2 justify-center">
              <LoaderIcon className="size-4 animate-spin" />
              <span className="text-sm text-muted-foreground">上传中（大包清洗耗时较长）...</span>
            </div>
          )}
          {result && (
            <div className="text-sm space-y-1">
              <p className="text-emerald-600 dark:text-emerald-400 break-words">
                {result.unchanged
                  ? "包内容与数据仓一致，无需重新上传"
                  : `已上传 ${result.sessionCount} 个成员会话到 ${BAY_NAME}`}
              </p>
              {result.missingSessions.length > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400 break-words">
                  ⚠ {result.missingSessions.length} 个成员会话不在 insight，包内缺其正文：{result.missingSessions.join(", ")}
                </p>
              )}
            </div>
          )}
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>
            关闭
          </Button>
          <Button onClick={() => startUpload()} disabled={!submitter.trim() || uploading}>
            {uploading ? (
              <span className="flex items-center gap-1.5">
                <LoaderIcon className="size-4 animate-spin" />
                上传中...
              </span>
            ) : (
              "上传"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
