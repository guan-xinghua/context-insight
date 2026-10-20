// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 失败归因块（节点侧栏）：账本回答「修什么」，这里回答「为什么败」——
// 归因徽标（疑似环境/同因连败/原因各异）+ 一句话行动建议 + 末次失败的
// 逐项验收清单（未通过置顶）。无失败尝试不渲染（零值信息不展示）。

import { useMemo } from "react";
import type { NodeInstance } from "@/lib/run/view-model";
import { attributeFailures } from "@/lib/run/failure-attribution";
import { FAILURE_KIND_META } from "@/components/run/run-theme";

function KindChip({ kind, extra }: { kind: string; extra?: string }) {
  const meta = FAILURE_KIND_META[kind];
  if (!meta) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] leading-4"
      style={{ color: meta.color, borderColor: `${meta.color}59`, backgroundColor: `${meta.color}14` }}
      title={extra}
    >
      {extra ? `${meta.label} ${extra}` : meta.label}
    </span>
  );
}

export function RunFailureAttribution({ node }: { node: NodeInstance }) {
  const attr = useMemo(() => attributeFailures(node), [node]);
  if (!attr) return null;
  const items = attr.lastFailed?.items ?? [];
  const notMet = items.filter(i => !i.met);
  const met = items.filter(i => i.met);

  return (
    <div className="failure-attribution flex flex-col gap-2 border-b border-black/[0.08] px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="text-[11px] font-medium tracking-wide text-[#8c959f]">失败归因</h3>
        {attr.kind ? <KindChip kind={attr.kind} extra={attr.kind === "env" && attr.envCount < attr.failedCount ? `${attr.envCount}/${attr.failedCount}` : undefined} /> : null}
      </div>
      <p className="text-[11.5px] leading-5 text-[#24292f]">{attr.advice}</p>
      {items.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[10px] leading-4 text-[#8c959f]">
            末次失败验收（第 {attr.lastFailed?.ordinal} 次 · 通过 {met.length}/{items.length}）
          </p>
          {notMet.map(i => (
            <div key={i.text} className="flex items-start gap-1.5 text-[11px] leading-4" title={i.text}>
              <span className="mt-px shrink-0 text-[#cf222e]" aria-hidden>✗</span>
              <span className="min-w-0 text-[#24292f]">{i.text}</span>
            </div>
          ))}
          {met.slice(0, 3).map(i => (
            <div key={i.text} className="flex items-start gap-1.5 text-[11px] leading-4" title={i.text}>
              <span className="mt-px shrink-0 text-[#1a7f37]" aria-hidden>✓</span>
              <span className="min-w-0 text-[#57606a]">{i.text}</span>
            </div>
          ))}
          {met.length > 3 ? (
            <span className="pl-4 text-[10.5px] leading-4 text-[#8c959f]">+{met.length - 3} 项通过</span>
          ) : null}
        </div>
      ) : attr.lastFailed?.excerpt ? (
        <p className="text-[11px] leading-5 text-[#57606a]">
          末次失败结论（第 {attr.lastFailed.ordinal} 次）：
          <span className="font-mono text-[10.5px] text-[#24292f]">{attr.lastFailed.excerpt}</span>
        </p>
      ) : (
        <p className="text-[11px] leading-5 text-[#8c959f]">末次失败未产出验收结论（reason 与输出均缺失）</p>
      )}
    </div>
  );
}
