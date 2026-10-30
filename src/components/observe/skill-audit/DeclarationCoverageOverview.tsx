"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type {
  AuditLayerInfo,
  CoverageSummary,
  TextCoverageSummary,
  TextCoverageUnit,
} from "@/lib/sift-audit-types"
import { matchFindingLayers } from "./verdictConfig"

/**
 * 声明覆盖总览（原文快照版）：对账时刻的声明原文（skill_body）整篇原文呈现，
 * 颜色直接涂在文本上——绿=已触达（该段指令全部被真实执行碰过）、黄=未验证
 * （有规则未触发或判不全，保守最低态）、灰=未建模（没抽出指令——说明文字或
 * 抽取盲区）。不做分段盒子、不插明细行：文档就是原文本身，色块即覆盖位置，
 * hover 色块看该段指令摘要（含 root 组合声明归层）。
 *
 * 原文重建：以 skill_body 为基准，按单元顺序 indexOf 逐段消费（精确子串匹配，
 * 无偏移算术——Python 侧 code point 偏移与 JS UTF-16 code unit 不混用）；
 * 单元之间的间隙（空行、代码围栏）原样保留——快照逐字节可信。无 skill_body
 * 或匹配失配时回退单元顺序拼接（着色语义不变，仅丢失间隙排版）。
 *
 * 头部指标分报（含义不同不混）：指令覆盖 covered/total（碰过的指令/指令总数）
 * + 可评文本覆盖率 covered/modeled（未建模不进分母）+ 建模完整度 modeled/total。
 * heading 是结构行（加粗、不着色、不进分母）。
 */

const INSTR_ICON: Record<string, string> = {
  covered: "✓",
  uncovered: "○",
  unknown: "?",
}

const STATE_RUN: Record<string, { cls: string; label: string; hint: string }> = {
  covered: {
    cls: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
    label: "已触达",
    hint: "该段声明的指令全部被真实执行触达（守没守规 hover 看指令摘要）",
  },
  uncovered: {
    cls: "bg-amber-500/20 text-amber-800 dark:bg-amber-500/25 dark:text-amber-200",
    label: "未验证",
    hint: "该段有指令但未触发或判不全（保守最低态：任一未验证即拉黄）",
  },
  unmodeled: {
    cls: "bg-muted/60 text-muted-foreground",
    label: "未建模",
    hint: "该段没有抽出任何指令——非规则文本或抽取盲区（不猜）",
  },
}

function ratePercent(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return Math.round(rate * 100)
}

/** 一个着色文本段：原文切片 + 三色 class + hover 摘要。 */
interface Run {
  text: string
  cls: string
  title?: string
}

/** 单元 hover 摘要：状态说明 + 指令逐条（含 root 归层标签）。 */
function unitTooltip(unit: TextCoverageUnit, layers?: AuditLayerInfo[]): string | undefined {
  const instrs = unit.instructions ?? []
  if (!instrs.length) {
    return unit.state ? STATE_RUN[unit.state]?.hint : undefined
  }
  const lines = instrs.map((i) => {
    const icon = INSTR_ICON[i.status] ?? "?"
    const matched = layers
      ? matchFindingLayers({ instruction_text: i.instruction_text, source_excerpt: undefined }, layers)
      : []
    const layerTxt = matched.length ? `（${matched.map((l) => l.label).join("/")}）` : ""
    return `${icon} ${i.headline || i.instruction_text}${layerTxt}`
  })
  const hint = unit.state ? STATE_RUN[unit.state]?.hint : ""
  return [hint, ...lines].filter(Boolean).join("\n")
}

function unitRun(unit: TextCoverageUnit, layers?: AuditLayerInfo[]): Run {
  if (unit.kind === "heading") {
    return { text: unit.text, cls: "font-bold text-foreground" }
  }
  const st = unit.state ? STATE_RUN[unit.state] : null
  return {
    text: unit.text,
    cls: st?.cls ?? "",
    title: unitTooltip(unit, layers),
  }
}

/**
 * 以 skill_body 为基准按序消费单元，重建整篇原文 + 着色段：
 * 间隙（空行/代码围栏等不属于任何单元的原文）以中性色原样保留。
 * 匹配失败（任一单元文本在剩余原文中找不到）→ 返回 null，调用方走拼接回退。
 */
function buildRuns(skillBody: string, units: TextCoverageUnit[], layers?: AuditLayerInfo[]): Run[] | null {
  const runs: Run[] = []
  let cursor = 0
  for (const u of units) {
    const idx = skillBody.indexOf(u.text, cursor)
    if (idx < 0) return null
    if (idx > cursor) runs.push({ text: skillBody.slice(cursor, idx), cls: "" })
    runs.push(unitRun(u, layers))
    cursor = idx + u.text.length
  }
  if (cursor < skillBody.length) runs.push({ text: skillBody.slice(cursor), cls: "" })
  return runs
}

/** 回退：无 skill_body / 匹配失配 → 单元顺序拼接（着色不变，间隙排版丢失）。 */
function fallbackRuns(units: TextCoverageUnit[], layers?: AuditLayerInfo[]): Run[] {
  return units.map((u) => {
    const r = unitRun(u, layers)
    return { ...r, text: r.text + (u.kind === "heading" ? "\n" : "\n\n") }
  })
}

export function DeclarationCoverageOverview({
  textCoverage,
  skillBody,
  coverage,
  layers,
}: {
  textCoverage: TextCoverageSummary
  /** 对账时刻的声明原文快照（AuditReport.skill_body）；着色以此为基准。 */
  skillBody?: string
  coverage?: CoverageSummary
  layers?: AuditLayerInfo[]
}) {
  if (!textCoverage || !textCoverage.total_units) return null
  const modeled = textCoverage.covered + textCoverage.uncovered
  const pct = ratePercent(textCoverage.coverage_rate)
  const modeledPct = ratePercent(textCoverage.modeled_ratio)
  const total = textCoverage.total_units
  const unmapped = textCoverage.unmapped_instructions ?? []
  const runs = skillBody
    ? (buildRuns(skillBody, textCoverage.units, layers) ?? fallbackRuns(textCoverage.units, layers))
    : fallbackRuns(textCoverage.units, layers)
  return (
    <div className="rounded-lg border border-border bg-card/40 p-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold">声明覆盖总览</span>
        <span className="text-[11px] text-muted-foreground">原文声明快照</span>
        {coverage && coverage.total > 0 && (
          <>
            <span className="text-[11px] text-muted-foreground">指令覆盖</span>
            <span className="text-sm font-semibold tabular-nums">
              {coverage.covered}/{coverage.total}
              <span className="ml-1 text-muted-foreground">（{ratePercent(coverage.coverage_rate)}%）</span>
            </span>
            <span className="text-[11px] text-muted-foreground">
              未覆盖 <span className="tabular-nums text-amber-700 dark:text-amber-400">{coverage.uncovered}</span>
              {" · "}未知 <span className="tabular-nums">{coverage.unknown}</span>
            </span>
          </>
        )}
        <span className="text-[11px] text-muted-foreground">可评文本覆盖</span>
        <span className="text-sm font-semibold tabular-nums">
          {textCoverage.covered}/{modeled}
          <span className="ml-1 text-muted-foreground">（{pct}%）</span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          建模完整度 <span className="tabular-nums">{modeled}/{total}（{modeledPct}%）</span>
          {" · "}未建模 <span className="tabular-nums">{textCoverage.unmodeled}</span>
        </span>
        <span
          className="text-[11px] text-muted-foreground"
          title="可评文本覆盖率 = 已触达 / 已建模（未建模不进分母）；建模完整度 = 已建模 / 全部文本单元；原文为对账时刻快照（防止事后编辑导致快照与当前内容不符）"
        >
          = 对账时刻原文快照，颜色即覆盖位置
        </span>
      </div>
      {/* 三色堆叠条：三段之和恒 100%，绿+黄=已建模、灰=未建模 */}
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
        <div className="h-full bg-emerald-500/70" style={{ width: `${(100 * textCoverage.covered) / total}%` }} />
        <div className="h-full bg-amber-500/70" style={{ width: `${(100 * textCoverage.uncovered) / total}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        <span className="rounded bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-300">绿 已触达</span>
        {"（该段指令全部碰过） · "}
        <span className="rounded bg-amber-500/20 px-1 text-amber-800 dark:text-amber-200">黄 未验证</span>
        {"（有规则未触发或判不全） · "}
        <span className="rounded bg-muted/60 px-1 text-muted-foreground">灰 未建模</span>
        {"（没抽出指令）——hover 色块看该段指令摘要"}
      </div>
      {/* 原文快照：整篇原文一体的 pre，颜色直接涂在文本上（间隙/围栏原样保留） */}
      <pre className="mt-2 max-h-[32rem] overflow-auto rounded border bg-background/60 p-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words">
        {runs.map((r, i) => (
          <span key={i} className={r.cls} title={r.title}>
            {r.text}
          </span>
        ))}
      </pre>
      {unmapped.length > 0 && (
        <details className="mt-1.5 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none w-fit">
            另有 {unmapped.length} 条指令未落回原文（如类别级参考查阅）
          </summary>
          <div className="mt-0.5 space-y-0.5 pl-3">
            {unmapped.map((t, i) => (
              <div key={`${t}-${i}`} className="break-words">{t}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
