// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 重试浪费账本 + 平行宇宙（第三视图模式）：回答 workflow 开发者三个问题——
// 「重试烧掉了多少」（A/B 宇宙对比与账本合计，严格可对账）、「修复哪个最值」
// （leave-one-out 修复收益排序——浪费在并行分支中被吸收的不推迟墙钟）、
// 「每个节点怎么败的」（尝试解剖阶梯：红=失败 绿=通过 灰=重试等待）。

import { useMemo } from "react";
import type { NodeInstance, RunViewModel } from "@/lib/run/view-model";
import {
  marginalSavingsOf,
  retryWasteOf,
  simulateUniverses,
  type RetryWaste,
  type UniverseSummary,
} from "@/lib/run/run-simulate";
import { attemptRangeOf, attemptSpanMs, compactTokens, formatDurationMs, runUsageOf, validTs } from "@/lib/run/run-metrics";
import { attributeFailures } from "@/lib/run/failure-attribution";
import { FAILURE_KIND_META, RUN_STATUS_META, bandLabel, statusLabel } from "@/components/run/run-theme";

// ── 平行宇宙对比面板 ────────────────────────────────────────

function UniverseRow({
  name,
  tag,
  summary,
  barMs,
  color,
  note,
}: {
  name: string;
  tag: string;
  summary: UniverseSummary;
  barMs: number;
  color: string;
  note: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="flex w-[5.5rem] shrink-0 items-baseline gap-1.5">
          <span className="text-[12.5px] font-semibold text-[#1f2328]">{name}</span>
          <span className="text-[10px] text-[#8c959f]">{tag}</span>
        </span>
        <div className="h-3 flex-1 overflow-hidden rounded-full bg-black/[0.05]" aria-hidden>
          <span
            className="block h-full rounded-full transition-[width]"
            style={{ width: `${Math.max((summary.wallMs ?? 0) / Math.max(barMs, 1), 0.015) * 100}%`, backgroundColor: color }}
          />
        </div>
        <span className="w-[4.5rem] shrink-0 text-right text-[14px] font-semibold tabular-nums text-[#1f2328]">
          {summary.wallMs !== null ? formatDurationMs(summary.wallMs) : "—"}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-[5.5rem] shrink-0" aria-hidden />
        <div className="flex flex-1 flex-wrap items-baseline justify-between gap-x-4 text-[10.5px] leading-4 text-[#8c959f]">
          <span title="各节点占用时间之和（并行分支累加；大于墙钟即存在并行）">
            Σ节点时长 <span className="tabular-nums">{formatDurationMs(summary.busyMs)}</span>
          </span>
          <span title="全部尝试的 token 合计">
            Token <span className="tabular-nums">{compactTokens(summary.tokens)}</span>
          </span>
          <span className="min-w-0 truncate">{note}</span>
        </div>
        <span className="w-[4.5rem] shrink-0" aria-hidden />
      </div>
    </div>
  );
}

// ── 尝试解剖阶梯 ────────────────────────────────────────────

const LADDER_COLORS: Record<string, string> = {
  passed: "#1a7f37",
  failed: "#cf222e",
  running: "#9a6700",
  unknown: "#8c959f",
  wait: "#d0d7de",
};

/** 每次尝试一段（红=失败 绿=通过 灰=重试等待），宽度 ∝ 时长——重试风暴
 *  （如 10 连败）与「败了多久才过」在表格里直接可见。 */
function AttemptLadder({ node }: { node: NodeInstance }) {
  const segs: Array<{ key: string; ms: number; kind: string; title: string }> = [];
  let prevEnd: number | null = null;
  for (const a of node.attempts) {
    const r = attemptRangeOf(a);
    const st = validTs(r.start);
    const en = validTs(r.end);
    if (st !== null && en !== null && en >= st) {
      if (prevEnd !== null && st > prevEnd) {
        segs.push({ key: `w${a.ordinal}`, ms: st - prevEnd, kind: "wait", title: `重试等待 ${formatDurationMs(st - prevEnd)}` });
      }
      if (en > st) {
        segs.push({
          key: `a${a.ordinal}`, ms: en - st, kind: a.status,
          title: `第 ${a.ordinal} 次 · ${statusLabel(a.status)} · ${formatDurationMs(en - st)}`,
        });
      }
      prevEnd = en;
    } else {
      const ms = attemptSpanMs(a) ?? 0;
      if (ms > 0) {
        segs.push({
          key: `a${a.ordinal}`, ms, kind: a.status,
          title: `第 ${a.ordinal} 次 · ${statusLabel(a.status)} · ${formatDurationMs(ms)}`,
        });
      }
    }
  }
  const total = segs.reduce((s, x) => s + x.ms, 0);
  if (total <= 0) return <span className="text-[11px] text-[#8c959f]">—</span>;
  return (
    <span className="ledger-ladder flex h-2.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full">
      {segs.map(s => (
        <span
          key={s.key}
          title={s.title}
          style={{ flexGrow: s.ms, backgroundColor: LADDER_COLORS[s.kind] ?? "#8c959f" }}
        />
      ))}
    </span>
  );
}

function LedgerStatus({ status }: { status: NodeInstance["status"] }) {
  const meta = RUN_STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] leading-4 text-[#57606a]">
      <span className="size-2 rounded-full" style={{ backgroundColor: meta?.color ?? "#8c959f" }} aria-hidden />
      {meta?.label ?? status}
    </span>
  );
}

// ── 主组件 ──────────────────────────────────────────────────

export function RunRetryLedger({
  vm,
  selectedKey,
  onSelectNode,
}: {
  vm: RunViewModel;
  selectedKey: string | null;
  onSelectNode: (key: string) => void;
}) {
  const universes = useMemo(() => simulateUniverses(vm), [vm]);
  const realWallMs = useMemo(() => runUsageOf(vm.nodes).wallMs, [vm]);
  const mainKeys = useMemo(() => new Set(vm.views[0].nodeKeys), [vm]);
  const rows = useMemo(
    () => vm.nodes
      .map(node => ({ node, waste: retryWasteOf(node) }))
      .filter((r): r is { node: NodeInstance; waste: RetryWaste } => r.waste !== null),
    [vm],
  );
  // 修复收益（leave-one-out）：消除该节点重试（其余保持现状）后的墙钟提前量
  const fixGain = useMemo(
    () => marginalSavingsOf(vm, [...new Set(rows.map(r => r.node.nodeId))]),
    [vm, rows],
  );
  // 失败归因徽标（疑似环境/同因连败/原因各异）：修复名单直接带「为什么败」
  const attribution = useMemo(
    () => new Map(rows.map(r => [r.node.key, attributeFailures(r.node)])),
    [rows],
  );
  const sorted = useMemo(
    () => [...rows].sort((a, b) => {
      const ga = fixGain.get(a.node.nodeId) ?? -1;
      const gb = fixGain.get(b.node.nodeId) ?? -1;
      return gb - ga
        || (b.waste.wastedMs ?? 0) - (a.waste.wastedMs ?? 0)
        || b.waste.wastedTokens - a.waste.wastedTokens;
    }),
    [rows, fixGain],
  );

  const { real, ideal, cyclic } = universes;
  const barMs = Math.max(real.wallMs ?? 0, ideal.wallMs ?? 0, 1);
  const savedWallMs = !cyclic && real.wallMs !== null && ideal.wallMs !== null
    ? Math.max(real.wallMs - ideal.wallMs, 0)
    : null;
  const savedShare = savedWallMs !== null && (real.wallMs ?? 0) > 0
    ? Math.round((savedWallMs / (real.wallMs as number)) * 100)
    : null;
  const savedTokens = Math.max(real.tokens - ideal.tokens, 0);
  const totalWastedMs = rows.reduce((s, r) => s + (r.waste.wastedMs ?? 0), 0);
  const totalWastedTokens = rows.reduce((s, r) => s + r.waste.wastedTokens, 0);

  return (
    <div className="run-retry-ledger h-full w-full min-w-0 overflow-y-auto bg-[#f6f8fa]">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-5">

        {/* 平行宇宙对比：同比例尺条形，74% 的差距直接可见 */}
        <section className="overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-black/[0.06] bg-black/[0.015] px-5 py-3">
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-[#1f2328]">平行宇宙 · 重试代价</h2>
              <p
                className="mt-0.5 text-[11px] leading-4 text-[#8c959f]"
                title="意图管线 = 节点按 nodeId 折叠（回滚即同节点重跑），依赖边保留；两宇宙只差时长假设，其差恒等于账本总额"
              >
                同一工作流拓扑模拟，只改变重试假设——B 宇宙中每个节点直接跳到它最终「留住」的那次尝试
              </p>
            </div>
            {realWallMs !== null ? (
              <span
                className="shrink-0 rounded-full border border-black/10 bg-black/[0.02] px-2.5 py-0.5 text-[10.5px] leading-5 tabular-nums text-[#57606a]"
                title="会话观测值；与 A 模拟之差 = 并行 / 引擎调度效应"
              >
                真实墙钟 {formatDurationMs(realWallMs)}
              </span>
            ) : null}
          </div>

          {cyclic ? (
            <p className="px-5 py-4 text-[11.5px] text-yellow-700">
              依赖图含环或数据缺失，无法模拟墙钟——账本明细仍可对账
            </p>
          ) : (
            <div className="flex flex-col gap-4 px-5 py-4">
              <div className="flex flex-col gap-3">
                <UniverseRow
                  name="现实"
                  tag="A"
                  summary={real}
                  barMs={barMs}
                  color="#1f2328"
                  note="按依赖序串行展开（观测回放）"
                />
                <UniverseRow
                  name="首试即过"
                  tag="B"
                  summary={ideal}
                  barMs={barMs}
                  color="#1a7f37"
                  note="无重试、无回滚重跑"
                />
              </div>
              <div
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-dashed border-black/10 pt-3"
                title="A 宇宙墙钟 − B 宇宙墙钟。上界估计：现实中验收与重试仍会失败，该值是全部重做部分的总代价"
              >
                <span className="text-[11.5px] text-[#8c959f]">可省（上界）</span>
                {savedWallMs !== null ? (
                  <span className="inline-flex items-baseline gap-1.5">
                    <span className="text-[16px] font-semibold tabular-nums text-[#1a7f37]">
                      {formatDurationMs(savedWallMs)}
                    </span>
                    <span className="text-[11px] text-[#57606a]">
                      墙钟{savedShare !== null ? `（${savedShare}%）` : null}
                    </span>
                  </span>
                ) : null}
                {savedTokens > 0 ? (
                  <span className="text-[11.5px] tabular-nums text-[#57606a]">
                    Token {compactTokens(savedTokens)}
                  </span>
                ) : null}
              </div>
            </div>
          )}
        </section>

        {/* 修复优先级：浪费 × 修复收益 × 尝试解剖 */}
        <section className="overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-black/[0.06] bg-black/[0.015] px-5 py-3">
            <div>
              <h2 className="text-[14px] font-semibold text-[#1f2328]">修复优先级</h2>
              <p className="mt-0.5 text-[11px] leading-4 text-[#8c959f]">
                按「全局可提前」排序——节点浪费被并行分支吸收的不推迟完成时间，可缓修
              </p>
            </div>
            {rows.length > 0 ? (
              <span className="shrink-0 text-[11px] tabular-nums text-[#8c959f]">
                合计浪费 {formatDurationMs(totalWastedMs)} · {compactTokens(totalWastedTokens)} tokens
              </span>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-[12px] text-[#8c959f]">
              本 Run 无重试——所有节点一次尝试完成，没有浪费
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-black/[0.06] text-[10.5px] text-[#8c959f]">
                    <th className="px-5 py-2.5 font-medium">节点</th>
                    <th className="px-3 py-2.5 font-medium" title="每次尝试一段（红=失败 绿=通过 灰=重试等待），宽度∝时长">
                      尝试解剖
                    </th>
                    <th className="px-3 py-2.5 font-medium" title="本节点被覆盖的尝试 + 重试等待的时长（节点墙钟 − 末次尝试跨度）——节点自己的成本账">
                      节点浪费
                    </th>
                    <th className="px-3 py-2.5 font-medium" title="只修好这一个节点（其余节点保持现状）时，run 完成时间可提前的量——全图视角；与节点浪费之差 = 被并行分支吸收的部分">
                      全局可提前
                    </th>
                    <th className="px-3 py-2.5 font-medium" title="被覆盖尝试的 token（末次尝试不计）">浪费 Token</th>
                    <th className="px-5 py-2.5 font-medium">终态</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(({ node, waste }) => {
                    const inMain = mainKeys.has(node.key);
                    const gain = fixGain.get(node.nodeId);
                    const kind = attribution.get(node.key)?.kind ?? null;
                    const kindMeta = kind ? FAILURE_KIND_META[kind] : null;
                    return (
                      <tr
                        key={node.key}
                        className={`ledger-row cursor-pointer border-b border-black/[0.04] last:border-b-0 transition-colors ${
                          selectedKey === node.key ? "bg-black/[0.04]" : "hover:bg-black/[0.025]"
                        }`}
                        onClick={() => onSelectNode(node.key)}
                      >
                        <td className="px-5 py-2.5">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[12px] font-medium text-[#1f2328]">{node.label}</span>
                            <span className="rounded-full border border-black/10 bg-black/[0.03] px-1.5 py-0.5 text-[10px] leading-4 text-[#57606a]">
                              {bandLabel(node.generation)}
                            </span>
                            {kindMeta ? (
                              <span
                                className="rounded-full border px-1.5 py-0.5 text-[10px] leading-4"
                                style={{ color: kindMeta.color, borderColor: `${kindMeta.color}59`, backgroundColor: `${kindMeta.color}14` }}
                                title="失败归因（启发式）：点行在侧栏看逐次验收结论与建议"
                              >
                                {kindMeta.label}
                              </span>
                            ) : null}
                            {!inMain ? (
                              <span className="rounded-full border border-black/10 bg-black/[0.03] px-1.5 py-0.5 text-[10px] leading-4 text-[#57606a]">
                                子图
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex min-w-[120px] items-center gap-2">
                            <span className="shrink-0 text-[10.5px] tabular-nums text-[#8c959f]">{waste.attempts} 次</span>
                            <AttemptLadder node={node} />
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-[11.5px] font-semibold tabular-nums text-[#1f2328]">
                          {waste.wastedMs !== null ? formatDurationMs(waste.wastedMs) : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-[11.5px] font-semibold tabular-nums text-[#1a7f37]">
                          {gain !== undefined && gain !== null ? formatDurationMs(gain) : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-[11.5px] tabular-nums text-[#57606a]">
                          {waste.wastedTokens > 0 ? compactTokens(waste.wastedTokens) : "—"}
                        </td>
                        <td className="px-5 py-2.5"><LedgerStatus status={node.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-black/[0.06] px-5 py-2.5 text-[10.5px] leading-4 text-[#8c959f]">
            节点浪费 = 本节点白做的部分（被覆盖的尝试 + 重试等待）；全局可提前 = 只修好该节点（其余保持现状）时 run
            完成时间的提前量（leave-one-out 反事实，两宇宙之差恒等于账本合计）。点击行在侧栏查看逐次尝试与验收结论。
          </p>
        </section>
      </div>
    </div>
  );
}
