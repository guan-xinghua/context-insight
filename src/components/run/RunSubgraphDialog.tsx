"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RunNodeDetail } from "./RunNodeDetail";
import { bandLabel } from "./run-theme";
import { RunCanvas } from "./RunCanvas";
import type { LensKey } from "@/lib/run/run-metrics";
import type { NodeInstance, RollbackRecord, RunView } from "@/lib/run/view-model";

// 子图弹窗：主图中点击生成器节点的「子图 ▸」入口打开（不再割裂为顶层视图）。
// 只展示入口节点所在代的子图（其他代不混入）；右侧内嵌节点运行历史侧栏（逐次
// 尝试/验收/成员会话下钻，与主图同构）；画布支持缩放平移与选中点亮，打开自动
// 适配。注意 DialogContent 默认带 sm:max-w-sm（384px 上限），大画布布局必须
// 显式覆盖 sm: 档位，否则 tailwind-merge 不替换、桌面端被压回 384px。
export function RunSubgraphDialog({
  open,
  onOpenChange,
  views,
  nodesByKey,
  rollbacks,
  entryKey,
  lens,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  views: RunView[];
  nodesByKey: Map<string, NodeInstance>;
  rollbacks: RollbackRecord[];
  entryKey: string | null;
  lens?: LensKey;
}) {
  const entry = entryKey !== null ? nodesByKey.get(entryKey) ?? null : null;
  // 锁定入口代：只取该代生成器节点的子图视图
  const view = entry ? views.find(v => v.parentKey === entry.key) ?? null : null;

  // 本地状态按入口节点键失效（重开/换节点 → 重置），派生代替 effect 同步
  const [sel, setSel] = useState<{ entryKey: string; key: string | null } | null>(null);
  const selectedKey = entry && sel?.entryKey === entry.key ? sel.key : null;
  const selectedNode = selectedKey !== null ? nodesByKey.get(selectedKey) ?? null : null;

  if (!open || !entry || !view) return null;

  const viewKeys = new Set(view.nodeKeys);
  const selectInDialog = (key: string | null) => setSel({ entryKey: entry.key, key });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="run-glass flex h-[84vh] w-[94vw] max-w-[min(1180px,94vw)] flex-col gap-0 rounded-2xl p-0 ring-0 sm:max-w-[min(1180px,94vw)]">
        <DialogHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b border-black/[0.08] px-4 py-3">
          <DialogTitle className="text-sm">
            {entry.label} · 子图
            <span className="ml-2 rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] font-normal text-[#57606a]">
              {bandLabel(entry.generation)}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1">
            <RunCanvas
              view={view}
              nodesByKey={nodesByKey}
              selectedKey={selectedKey}
              onSelectNode={selectInDialog}
              fitKey={view.id}
              lens={lens}
              className="m-3"
            />
          </div>
          {/* 历史侧栏：浮层玻璃面板，画布内容滑入下方被虚化，滚动经 mask 渐隐 */}
          <aside className="run-glass run-scroll-fade absolute inset-y-2 right-2 z-10 w-[340px] shrink-0 overflow-y-auto rounded-xl">
            {selectedNode ? (
              <RunNodeDetail
                node={selectedNode}
                rollbacks={rollbacks.filter(r => r.triggerKey === selectedNode.key)}
                peers={[]}
                onSelectNode={key => {
                  // 跨代跳转目标不在本代子图内 → 忽略（弹窗锁定入口代）
                  if (viewKeys.has(key)) selectInDialog(key);
                }}
                onClose={() => selectInDialog(null)}
              />
            ) : (
              <p className="p-4 text-[11px] leading-5 text-[#8c959f]">
                点击子图节点查看运行历史（逐次尝试、验收结论、成员会话与 turn 下钻）。
              </p>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
