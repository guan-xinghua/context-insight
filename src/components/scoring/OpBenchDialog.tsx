// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// CANN-Bench 填报：把 cannbench.com 排行榜总分（百分制）填到本 session，
// D3「CANN-Bench 评分」子项按它折算 0-10；未填报按默认 80 持平档计。

import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoaderIcon } from 'lucide-react';

export function OpBenchDialog({ open, onOpenChange, taskId, framework, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  framework?: string;
  onSaved?: () => void;
}) {
  const [score, setScore] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hadExisting, setHadExisting] = useState(false);   // 库里已有填报 → 覆盖需确认
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setConfirming(false);
    try {
      const res = await fetch(`/api/observe/session/scorecard/op-bench?taskId=${encodeURIComponent(taskId)}${framework ? `&framework=${encodeURIComponent(framework)}` : ''}`);
      const data = await res.json() as { score?: number | null; note?: string | null; error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setScore(data.score != null ? String(data.score) : '');
      setHadExisting(data.score != null);
      setNote(data.note ?? '');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
    } finally {
      setLoading(false);
    }
  }, [taskId, framework]);

  useEffect(() => {
    if (open) queueMicrotask(() => { void load(); });
  }, [open, load]);

  const save = useCallback(async () => {
    const v = Number(score);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      setError('总分必须是 0-100 的数字（CANN-Bench 百分制）');
      return;
    }
    // 已有填报：先确认再覆盖
    if (hadExisting && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/observe/session/scorecard/op-bench', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, framework, score: v, note: note.trim() || undefined }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setError(null);
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
    } finally {
      setSaving(false);
    }
  }, [taskId, score, note, onOpenChange, onSaved, hadExisting, confirming]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>CANN-Bench 填报</DialogTitle>
          <DialogDescription>
            从 cannbench.com 排行榜抄本会话产出算子的总分（百分制），折算 0-10 计入 D3「CANN-Bench 评分」；未填报按默认 80（持平档）计。保存后立即生效，不需要重算、不影响已完成的评审。
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <LoaderIcon className="size-4 animate-spin" />
            读取当前填报...
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="opbench-score" className="text-xs font-medium">CANN-Bench 总分（0-100）</label>
              <Input
                id="opbench-score"
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={score}
                onChange={e => setScore(e.target.value)}
                placeholder="如 87"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="opbench-note" className="text-xs font-medium">备注（可选）</label>
              <Input
                id="opbench-note"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="如任务名 / 排行榜链接"
              />
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        )}
        <DialogFooter>
          {confirming ? (
            <>
              <span className="text-xs text-orange-600 dark:text-orange-400 mr-auto">该会话已有填报，确认覆盖为新填的值？</span>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={saving}>返回修改</Button>
              <Button size="sm" onClick={() => void save()} disabled={saving || loading}>
                {saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                确认覆盖
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
              <Button size="sm" onClick={() => void save()} disabled={saving || loading}>
                {saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                保存
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
