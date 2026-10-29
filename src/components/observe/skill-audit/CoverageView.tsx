"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { AuditLayerInfo, CoverageSummary, InstructionCoverage, SectionCoverage } from "@/lib/sift-audit-types"
import { LAYER_BADGE, matchFindingLayers } from "./verdictConfig"

const STATUS_DISPLAY: Record<InstructionCoverage["status"], { icon: string; label: string; cls: string; hint: string }> = {
  covered: {
    icon: "✓",
    label: "已覆盖",
    cls: "text-emerald-600 dark:text-emerald-400",
    hint: "会话碰过这条声明（守没守规看上方明细）",
  },
  uncovered: {
    icon: "○",
    label: "未触发",
    cls: "text-amber-600 dark:text-amber-400",
    hint: "规则存在、本次场景从未触发（全部 N/A）",
  },
  unknown: {
    icon: "?",
    label: "未知",
    cls: "text-muted-foreground",
    hint: "判不成/判不准（UNRESOLVED / INDETERMINATE 混合）",
  },
}

function ratePercent(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return Math.round(rate * 100)
}

function CoverageSeqLinks({ seqs, onJumpToSeq }: { seqs: number[]; onJumpToSeq?: (seq: number) => void }) {
  if (!seqs.length) return null
  return (
    <span className="ml-1.5 whitespace-nowrap">
      {seqs.map((s, i) => (
        <span key={s}>
          {i > 0 && " "}
          <button
            type="button"
            className="font-mono text-[10px] text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            title={`跳到 finding #${s}`}
            onClick={() => onJumpToSeq?.(s)}
          >
            #{s}
          </button>
        </span>
      ))}
    </span>
  )
}

function CoverageInstructionRow({
  ins,
  layers,
  onJumpToSeq,
}: {
  ins: InstructionCoverage
  layers?: AuditLayerInfo[]
  onJumpToSeq?: (seq: number) => void
}) {
  const st = STATUS_DISPLAY[ins.status]
  const matched = matchFindingLayers(
    { instruction_text: ins.instruction_text, source_excerpt: ins.source_excerpt },
    layers,
  )
  return (
    <div className="flex items-start gap-1.5 py-0.5 text-xs">
      <span className={`${st.cls} shrink-0 font-mono`} title={st.hint}>{st.icon}</span>
      <span className="min-w-0">
        <span className="break-words">{ins.headline || ins.instruction_text}</span>
        {matched.length > 0 && (
          <>
            {" "}
            {matched.map((l) => (
              <span
                key={l.kind}
                className={`rounded border px-1 text-[10px] ${LAYER_BADGE[l.kind].cls}`}
                title={`${LAYER_BADGE[l.kind].hint}（来源：${l.source}）`}
              >
                {l.label}
              </span>
            ))}
          </>
        )}
        <CoverageSeqLinks seqs={ins.seqs ?? []} onJumpToSeq={onJumpToSeq} />
      </span>
    </div>
  )
}

function SectionBlock({
  sec,
  layers,
  onJumpToSeq,
}: {
  sec: SectionCoverage
  layers?: AuditLayerInfo[]
  onJumpToSeq?: (seq: number) => void
}) {
  const nonCovered = sec.instructions.filter((i) => i.status !== "covered")
  const coveredCount = sec.instructions.filter((i) => i.status === "covered").length
  return (
    <details open={nonCovered.length > 0} className="rounded border border-border bg-card/50">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs font-medium">
        {sec.section || "（无标题节）"}
        <span className="ml-1.5 text-muted-foreground">
          {coveredCount}/{sec.total ?? sec.instructions.length}（{ratePercent(sec.coverage_rate)}%）
        </span>
        {nonCovered.length > 0 && (
          <span className="ml-1.5 text-amber-700 dark:text-amber-400">
            未覆盖 {sec.uncovered} · 未知 {sec.unknown}
          </span>
        )}
      </summary>
      <div className="space-y-0.5 px-2.5 pb-2 pt-0.5">
        {nonCovered.map((ins, i) => (
          <CoverageInstructionRow key={`${ins.instruction_text}-${i}`} ins={ins} layers={layers} onJumpToSeq={onJumpToSeq} />
        ))}
        {nonCovered.length === 0 && (
          <div className="py-0.5 text-[11px] text-muted-foreground">全部声明已覆盖 ✓</div>
        )}
        {nonCovered.length > 0 && coveredCount > 0 && (
          <div className="pt-0.5 text-[11px] text-muted-foreground">其余 {coveredCount} 条已覆盖</div>
        )}
      </div>
    </details>
  )
}

export function CoverageView({
  coverage,
  layers,
  onJumpToSeq,
}: {
  coverage: CoverageSummary
  layers?: AuditLayerInfo[]
  onJumpToSeq?: (seq: number) => void
}) {
  if (!coverage || !coverage.total) return null
  const pct = ratePercent(coverage.coverage_rate)
  return (
    <div className="rounded-lg border border-border bg-card/40 p-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold">声明覆盖</span>
        <span className="text-sm font-semibold tabular-nums">
          {coverage.covered}/{coverage.total}
          <span className="ml-1 text-muted-foreground">（{pct}%）</span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          未覆盖 <span className="tabular-nums text-amber-700 dark:text-amber-400">{coverage.uncovered}</span>
          {" · "}未知 <span className="tabular-nums">{coverage.unknown}</span>
          {" · "}已覆盖 <span className="tabular-nums text-emerald-700 dark:text-emerald-400">{coverage.covered}</span>
        </span>
        <span className="text-[11px] text-muted-foreground" title="unknown 计入分母——诚实低估；反推指令不计">
          = 碰过的声明 / 声明总数
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
        <div
          className="h-full rounded-full bg-emerald-500/70"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="mt-1.5 space-y-1">
        {coverage.sections.map((sec, i) => (
          <SectionBlock key={`${sec.section}-${i}`} sec={sec} layers={layers} onJumpToSeq={onJumpToSeq} />
        ))}
      </div>
    </div>
  )
}
