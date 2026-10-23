// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 评分卡 v2（六维评价体系）：维度卡是通用组件——不认识具体维度，
// 遍历 dimensions 列表按角色出组件，D7 用户自定义维度自动有完整呈现。
// 三态结论 + 逐项明细（公式/证据 §N 可跳回会话），不出伪精确数字。

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeftIcon, LoaderIcon, AlertTriangleIcon, SparklesIcon, SettingsIcon, TargetIcon, FlaskConicalIcon, BotIcon, ShareIcon, PlayIcon, RefreshCwIcon } from 'lucide-react';
import { BRAND_NAME, BAY_NAME } from '@/lib/branding';
import { VERSION_DISPLAY } from '@/lib/version';
import { loadProviderConfig } from '@/lib/ai-provider-config';
import type { DimensionResult, Evidence, Scorecard, SubItemResult } from '@/lib/scoring';
import { isNaReviewGap } from '@/lib/scoring/core/aggregator';
import { VERDICT_TEXT as SHARED_VERDICT_TEXT } from '@/lib/scoring/core/verdict-text';
import { ScoringCriteria } from '@/components/scoring/ScoringCriteria';
import { UserDimensionManager } from '@/components/scoring/UserDimensionManager';
import { ProfileManager } from '@/components/scoring/ProfileManager';
import { BenchReportDialog } from '@/components/scoring/BenchReportDialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DimensionRadar } from '@/components/scoring/DimensionRadar';

/** 分数/判定 → 档位色（十六进制；光晕、角标、进度条同一来源，与雷达图同色） */
function bandHex(score: number | null | undefined, verdict?: string | null): string {
  if (verdict === '未完成' || verdict === 'violation') return '#ef4444';
  if (verdict === 'suspected') return '#f97316';
  if (verdict === '完成' || verdict === 'clean') return '#10b981';
  if (score == null) return '#94a3b8';
  if (score >= 0.8) return '#10b981';
  if (score >= 0.6) return '#3b82f6';
  if (score >= 0.4) return '#f97316';
  return '#ef4444';
}

/** 任务控制台（HUD）视觉语言：网格底纹 / 角标框 / 数据芯片 / 分数色光晕。
    亮色克制、暗色发光（.dark 由 globals.css @custom-variant 定义） */
function HudStyles() {
  return (
    <style>{`
      .hud-grid {
        background-image:
          repeating-linear-gradient(0deg, color-mix(in srgb, currentColor 3.5%, transparent) 0 1px, transparent 1px 26px),
          repeating-linear-gradient(90deg, color-mix(in srgb, currentColor 3.5%, transparent) 0 1px, transparent 1px 26px);
      }
      .dark .hud-grid {
        background-image:
          repeating-linear-gradient(0deg, color-mix(in srgb, currentColor 7%, transparent) 0 1px, transparent 1px 26px),
          repeating-linear-gradient(90deg, color-mix(in srgb, currentColor 7%, transparent) 0 1px, transparent 1px 26px);
      }
      .hud-corner { position: absolute; width: 9px; height: 9px; border: 0 solid var(--acc); opacity: .6; pointer-events: none; }
      .hud-corner-tl { top: 6px; left: 6px; border-top-width: 1.5px; border-left-width: 1.5px; }
      .hud-corner-br { bottom: 6px; right: 6px; border-bottom-width: 1.5px; border-right-width: 1.5px; }
      .hud-chip {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10px; letter-spacing: .02em; white-space: nowrap;
        border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        background: color-mix(in srgb, currentColor 6%, transparent);
        border-radius: 4px; padding: 2px 8px;
      }
      .dim-card { transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease; }
      .dim-card:hover {
        border-color: color-mix(in srgb, var(--acc) 45%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--acc) 18%, transparent), 0 4px 18px -6px color-mix(in srgb, var(--acc) 35%, transparent);
      }
      @media (prefers-reduced-motion: no-preference) {
        .dim-card:hover { transform: translateY(-1px); }
      }
      .dark .num-glow { text-shadow: 0 0 16px currentColor, 0 0 44px color-mix(in srgb, currentColor 30%, transparent); }
      .score-glow { filter: drop-shadow(0 0 4px color-mix(in srgb, currentColor 55%, transparent)); }
    `}</style>
  );
}

function ScoreBar({ score }: { score: number | null | undefined }) {
  const pct = score == null ? 0 : Math.max(0, Math.min(1, score)) * 100;
  const color = bandHex(score);
  const w = pct * 1.2;
  return (
    <svg width="120" height="8" className="shrink-0" aria-hidden>
      <rect x="0" y="0" width="120" height="8" rx="4" fill="currentColor" className="text-muted/30" />
      <g className="score-glow" style={{ color }}>
        <rect x="0" y="0" width={w} height="8" rx="4" fill={color} />
        {w > 6 && <rect x={w - 3} y="0" width="3" height="8" rx="1.5" fill="#ffffff" opacity="0.55" />}
      </g>
    </svg>
  );
}

const VERDICT_VARIANT: Record<string, 'green' | 'red' | 'yellow' | 'gray' | undefined> = {
  完成: 'green', 未完成: 'red', 无法判定: 'gray',
  violation: 'red', suspected: 'yellow', clean: 'green',
  pass: 'green', fail: 'red',
  normal: 'green', error: 'red', truncated: 'yellow', unknown: 'gray',
  completed: 'green', incomplete: 'red',
  high: 'green', mid: 'yellow', low: 'red',
  none: 'gray',
};
// verdict 文案：共享权威源（与 judge 证据标签同源）。D2 违规按次扣分不归零维、
// 更不否决总分——不再标「（否决）」；否决语义只属于 D1 维级横幅
const VERDICT_TEXT: Record<string, string> = { ...SHARED_VERDICT_TEXT };

function VerdictBadge({ verdict }: { verdict?: string }) {
  if (!verdict) return null;
  return <Badge variant={VERDICT_VARIANT[verdict] ?? 'secondary'}>{VERDICT_TEXT[verdict] ?? verdict}</Badge>;
}

function formatValue(item: SubItemResult): string {
  if (item.value == null) return '—';
  if (item.unit === 'ratio' && typeof item.value === 'number') return `${Math.round(item.value * 100)}%`;
  if (item.unit === 'ms' && typeof item.value === 'number') return `${(item.value / 1000).toFixed(1)}s`;
  return String(item.value);
}

/** 评审工具类型：llm（带判卷模型）/ mate（带 claude·opencode）；无盖章 = 确定性层已评完、LLM 层未执行（语义项全部无法评判） */
function reviewerLabel(review: Scorecard['review']): string {
  if (!review) return '确定性层评审完成 · LLM 评审未执行';
  if (review.reviewer === 'mate') return `Mate Agent · ${review.tool ?? 'agent'}`;
  return review.tool ? `LLM · ${review.tool}` : 'LLM';
}

/** ISO → 本地 `YYYY-MM-DD HH:mm`（非法输入原样返回） */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 毫秒 → `45s` / `2m3s` / `1h5m`（评审耗时，人读刻度） */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Mate 进度百分比：维度完成数打底，当前段按实测均值（~70s/维，全评 5-6 分钟）插值爬升（封顶不出 100，等真实 done 事件） */
export function MateProgressText({ p }: { p: { done: number; total: number; current?: string | null } }) {
  const [now, setNow] = useState(Date.now());
  const timelineRef = useRef<{ segStartMs: number; lastDone: number; lastCurrent: string } | null>(null);
  if (timelineRef.current == null) {
    timelineRef.current = { segStartMs: Date.now(), lastDone: p.done, lastCurrent: p.current ?? '' };
  }
  const timeline = timelineRef.current;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (p.done !== timeline.lastDone || (p.current ?? '') !== timeline.lastCurrent) {
      timeline.lastDone = p.done;
      timeline.lastCurrent = p.current ?? '';
      timeline.segStartMs = Date.now();
    }
  }, [p.done, p.current, timeline]);
  const PER_DIM_MS = 70_000;   // 实测整评 5-6 分钟 / 5 维
  const frac = Math.min((now - timeline.segStartMs) / PER_DIM_MS, 1);
  const pct = Math.min(99, Math.round(((p.done + frac) / p.total) * 100));
  const remainMin = Math.max(1, Math.ceil(((p.total - p.done - frac) * PER_DIM_MS) / 60_000));
  return (
    <span className="text-muted-foreground font-mono tabular-nums text-xs" title={`维度完成 ${p.done}/${p.total}；当前段按实测均值 ~70s/维 估算插值——完成事件落地即对齐，估算只补"正在跑的那一维"的爬升`}>
      {pct}% · 预计还需 ~{remainMin}m
    </span>
  );
}

/** 总分算式（权重芯片正文）：参与维度 权重×得分 加总 → × 覆盖度 = 总分；否决/无分退化回纯权重清单 */
export function totalFormulaOf(card: Scorecard): string {
  const w = card.framework.weightsUsed;
  const parts = card.dimensions.filter(d => w[d.dimensionId] != null && typeof d.score === 'number');
  if (card.framework.veto?.triggered || parts.length === 0 || card.framework.totalScore == null) {
    return Object.entries(w).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' / ') || '—';
  }
  const weighted = parts.reduce((s, d) => s + w[d.dimensionId] * (d.score as number), 0);
  const calc = parts.map(d => `${d.dimensionId} ${Math.round(w[d.dimensionId] * 100)}%×${Math.round((d.score as number) * 100)}`).join(' + ');
  const cov = card.framework.coverage ?? 1;
  return `${calc} → ${Math.round(weighted * 100)} × 覆盖度 ${Math.round(cov * 100)}% = ${Math.round(card.framework.totalScore * 100)}`;
}

/** 子项行三个数字的口径说明（数值 / 得分/满分 / 维内占比，悬停可见） */
const SCORE_NUMBERS_NOTE = [
  '行内数字的口径：',
  '① 数值 —— 该子项自己的原始统计刻度（次数 / 比值 / 耗时 / 0-10 档位分等），只描述事实',
  '② N/100 —— 得分/满分：按维度聚合口径折算成 0-100（数值分直取、判定型按三态折算：无发现/达标 100、疑似 80、违规 0，扣分制按费率算），维度分由它加权而来',
  '③ 维内 N% —— 该子项在维度总分里的权重（只有加权维的计分子项有；按次扣分/组合判定维没有逐项权重）',
].join('\n');

function SubItemRow({ taskId, item, onJumpToTurn, onAdjudicate, adjBusy }: {
  taskId: string;
  item: SubItemResult;
  onJumpToTurn?: (turnIndex: number) => void;
  onAdjudicate?: (itemId: string, e: Evidence, confirmed: 'problem' | 'fine') => void;
  adjBusy?: boolean;
}) {
  // 数值与得分同值（含 0-10 分制/比率只是刻度差异）→ 只出得分芯片，不出两个一样的数
  const redundantValue = typeof item.value === 'number' && item.effScore != null
    && (item.value === item.effScore
      || (item.unit === 'score/10' && Math.round(item.effScore * 10) === item.value)
      || (item.unit === 'ratio' && Math.round(item.effScore * 100) === Math.round(item.value * 100)));
  // 对比分与得分同值（D4 基线比值项：得分即对比位置分）→ 并入得分芯片，不再单出「对比分 N」
  const baselineDup = item.baselineScore != null && item.effScore != null
    && Math.round(item.baselineScore * 100) === Math.round(item.effScore * 100);
  return (
    <details className="group rounded px-1.5 hover:bg-accent/25 transition-colors">
      <summary className="cursor-pointer select-none py-1 text-xs flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-muted-foreground shrink-0">{item.itemId}</span>
          <span className="font-medium">{item.label}</span>
          {item.status === 'ok' && !redundantValue && (
            <span className="font-mono tabular-nums" title={SCORE_NUMBERS_NOTE}>数值 {formatValue(item)}</span>
          )}
          {item.baselineScore != null && !baselineDup && (
            <span className="text-[10px] text-muted-foreground font-mono">对比分 {Math.round(item.baselineScore * 100)}</span>
          )}
          {item.verdict && <span className="text-[10px] text-muted-foreground font-mono">{VERDICT_TEXT[item.verdict] ?? item.verdict}</span>}
          {item.effScore != null && (
            <span
              className="font-mono tabular-nums font-medium shrink-0"
              style={{ color: bandHex(item.effScore) }}
              title={SCORE_NUMBERS_NOTE}
            >
              {Math.round(item.effScore * 100)}/100
            </span>
          )}
          {item.weightInDim != null && (
            <span className="text-[10px] text-muted-foreground font-mono shrink-0" title={SCORE_NUMBERS_NOTE}>
              维内 {Math.round(item.weightInDim * 100)}%
            </span>
          )}
          {item.adjState === 'pending' && <Badge variant="yellow" className="px-1.5 py-0 text-[10px]" title="疑似先不扣分：逐点确认有问题才扣">疑似待确认</Badge>}
          {item.adjState === 'problem' && <Badge variant="red" className="px-1.5 py-0 text-[10px]">已确认有问题</Badge>}
          {item.adjState === 'fine' && <Badge variant="green" className="px-1.5 py-0 text-[10px]">人工复核通过</Badge>}
          {item.status === 'not-applicable' && (
            isNaReviewGap(item)
              ? <Badge variant="orange" title="未评判：评审没跑（未开启 LLM 评审 / Mate 未给出子项）——跑一次 Mate/LLM 评审即出分；拉低覆盖度">未评判</Badge>
              : <Badge variant="gray" title="无法评判：材料客观缺失（如缺少测试运行/wire 报文），是确定性层评过的结论——不扣分、不拉低覆盖度">无法评判</Badge>
          )}
          {item.status === 'error' && <Badge variant="red">错误</Badge>}
        </summary>
        <div className="mb-1.5 mt-1 space-y-2 rounded bg-muted/40 border border-border/60 px-2.5 py-2">
          {item.formula && (
            <div className="rounded bg-muted/50 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed break-all">{item.formula}</div>
          )}
          {item.attribution && item.attribution.length > 0 && (
            <div className="space-y-1">
              {item.attribution.map((a, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="truncate flex-1">{a.label}</span>
                  <span className="font-mono tabular-nums text-muted-foreground shrink-0">
                    {a.tokens != null ? `≈${a.tokens.toLocaleString()} tk` : ''}{a.pct != null ? ` · ${Math.round(a.pct * 100)}%` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
          {item.evidence.length > 0 && !item.adjState && (() => {
            const chipOf = (e: Evidence, i: number) => {
              const chipClass = 'inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-accent/40 transition-colors';
              const markClass = e.impact === 'bad'
                ? 'text-red-600 dark:text-red-400 font-mono'
                : e.impact === 'good'
                  ? 'text-green-600 dark:text-green-400 font-mono'
                  : 'text-blue-600 dark:text-blue-400 font-mono';
              const inner = (
                <>
                  <span className={markClass}>{e.turnIndex != null ? `§${e.turnIndex}` : '§'}</span>
                  <span className="text-muted-foreground truncate max-w-[420px]">{e.label}</span>
                </>
              );
              // 页内跳转（session 页内嵌时零刷新）；独立页退化为带 errorTurn 的深链
              if (onJumpToTurn && e.turnIndex != null) {
                return (
                  <span key={i} role="button" tabIndex={0} onClick={() => onJumpToTurn(e.turnIndex!)} title={`${e.label}（跳转会话 §${e.turnIndex}）`} className={`${chipClass} cursor-pointer`}>
                    {inner}
                  </span>
                );
              }
              return (
                <Link
                  key={i}
                  href={`/session/${encodeURIComponent(taskId)}${e.turnIndex != null ? `?errorTurn=${e.turnIndex}` : ''}`}
                  title={e.label ? `${e.label}（点击跳转会话${e.turnIndex != null ? ` §${e.turnIndex}` : ''}）` : '跳转会话'}
                  className={chipClass}
                >
                  {inner}
                </Link>
              );
            };
            // 优缺点混排易误读（一眼全像问题）：带倾向标注时分组——问题在前、做得好在后；无标注保持平铺
            const bad = item.evidence.filter(e => e.impact === 'bad');
            const good = item.evidence.filter(e => e.impact === 'good');
            const neutral = item.evidence.filter(e => !e.impact);
            if (bad.length === 0 && good.length === 0) {
              return <div className="flex flex-wrap gap-1.5">{item.evidence.map(chipOf)}</div>;
            }
            return (
              <div className="space-y-1">
                {bad.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-red-600 dark:text-red-400">问题（扣分依据）：</p>
                    <div className="flex flex-wrap gap-1.5">{bad.map(chipOf)}</div>
                  </div>
                )}
                {neutral.length > 0 && <div className="flex flex-wrap gap-1.5">{neutral.map(chipOf)}</div>}
                {good.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-green-600 dark:text-green-400">做得好（加分依据）：</p>
                    <div className="flex flex-wrap gap-1.5">{good.map(chipOf)}</div>
                  </div>
                )}
              </div>
            );
          })()}
          {item.note && <p className="text-[11px] text-muted-foreground">{item.note}</p>}
          {item.adjState && (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground">疑似点人工复核（有问题才扣分，确认后从疑似中去掉）：</p>
              {item.evidence.map((e, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[11px]">
                  {onJumpToTurn && e.turnIndex != null ? (
                    <span role="button" tabIndex={0} onClick={() => onJumpToTurn(e.turnIndex!)} title={`跳转会话 §${e.turnIndex}`} className="font-mono text-blue-600 dark:text-blue-400 shrink-0 cursor-pointer">{e.turnIndex != null ? `§${e.turnIndex}` : '§'}</span>
                  ) : (
                    <span className="font-mono text-blue-600 dark:text-blue-400 shrink-0">{e.turnIndex != null ? `§${e.turnIndex}` : '§'}</span>
                  )}
                  <span className="flex-1 truncate text-muted-foreground" title={e.label}>{e.label}</span>
                  {e.adj ? (
                    <Badge variant={e.adj === 'problem' ? 'red' : 'green'} className="px-1.5 py-0 text-[10px] shrink-0">{e.adj === 'problem' ? '有问题' : '没问题'}</Badge>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" className="h-5 px-1.5 text-[10px] shrink-0" disabled={adjBusy} onClick={() => onAdjudicate?.(item.itemId, e, 'problem')}>有问题</Button>
                      <Button variant="outline" size="sm" className="h-5 px-1.5 text-[10px] shrink-0" disabled={adjBusy} onClick={() => onAdjudicate?.(item.itemId, e, 'fine')}>没问题</Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {item.error && <p className="text-[11px] text-red-500">{item.error.message}</p>}
        </div>
      </details>
  );
}

function DimensionCard({ taskId, dim, onJumpToTurn, onAdjudicate, adjBusy }: {
  taskId: string;
  dim: DimensionResult;
  onJumpToTurn?: (turnIndex: number) => void;
  onAdjudicate?: (itemId: string, e: Evidence, confirmed: 'problem' | 'fine') => void;
  adjBusy?: boolean;
}) {
  const na = dim.status === 'not-applicable';
  const acc = bandHex(dim.score, dim.verdict);
  return (
    <Card
      size="sm"
      className={`dim-card relative overflow-hidden ${na ? 'opacity-80' : ''}`}
      style={{ '--acc': acc } as React.CSSProperties}
    >
      <span aria-hidden className="hud-corner hud-corner-tl" />
      <span aria-hidden className="hud-corner hud-corner-br" />
      <span aria-hidden className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full" style={{ background: acc, boxShadow: `0 0 8px ${acc}66` }} />
      <CardHeader className="py-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-muted-foreground">{dim.dimensionId}</span>
          <CardTitle className="text-sm">{dim.name}</CardTitle>
          {dim.custom && <Badge variant="purple" className="px-1.5 py-0 text-[10px]">自定义</Badge>}
          {dim.role === 'veto' && <Badge variant="orange" className="px-1.5 py-0 text-[10px]">否决维</Badge>}
          {dim.verdict && <VerdictBadge verdict={dim.verdict} />}
          {typeof dim.score === 'number' && (
            <span className="num-glow font-mono text-sm tabular-nums" style={{ color: acc }}>
              {Math.round(dim.score * 100)}
            </span>
          )}
          {!dim.verdict && typeof dim.score !== 'number' && <span className="font-mono text-sm">{na ? '无法评判' : '—'}</span>}
          {dim.score != null && <ScoreBar score={dim.score} />}
          {dim.disclose && <span className="text-[11px] text-orange-600 dark:text-orange-400">{dim.disclose}</span>}
        </div>
      </CardHeader>
      <CardContent className="px-2.5 pb-2.5 space-y-1">
        {/* 密度：有效项两列；不适用项折叠成一行（"这维为什么缺信息"一行说清，不逐项占行） */}
        <div className="grid gap-x-4 gap-y-0 lg:grid-cols-2">
          {dim.items.filter(i => i.status !== 'not-applicable').map(item => <SubItemRow key={item.itemId} taskId={taskId} item={item} onJumpToTurn={onJumpToTurn} onAdjudicate={onAdjudicate} adjBusy={adjBusy} />)}
        </div>
        {(() => {
          const skipped = dim.items.filter(i => i.status === 'not-applicable');
          if (skipped.length === 0) return null;
          const gaps = skipped.filter(i => isNaReviewGap(i));
          const absent = skipped.filter(i => !isNaReviewGap(i));
          return (
            <details className="rounded px-1.5 hover:bg-accent/25 transition-colors">
              <summary className="cursor-pointer select-none py-1 text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                {gaps.length > 0 && (
                  <span className="font-medium text-orange-600 dark:text-orange-400" title="未评判：评审没跑——跑一次 Mate/LLM 评审即出分；拉低覆盖度">未评判 ×{gaps.length}</span>
                )}
                {absent.length > 0 && (
                  <span className="font-medium" title="无法评判：材料客观缺失（如缺少测试运行/wire 报文），是评过的结论——不扣分、不拉低覆盖度">无法评判 ×{absent.length}</span>
                )}
                <span className="opacity-70">{skipped.map(i => i.label).join(' · ')}</span>
              </summary>
              <div className="mb-1.5 mt-1 space-y-1 rounded bg-muted/40 border border-border/60 px-2.5 py-2">
                {skipped.map(item => (
                  <div key={item.itemId} className="text-[11px] flex items-baseline gap-1.5 flex-wrap">
                    <span className={`font-mono shrink-0 ${isNaReviewGap(item) ? 'text-orange-500' : 'text-muted-foreground'}`}>{item.itemId}</span>
                    <span className="font-medium">{item.label}</span>
                    {item.note && <span className="text-muted-foreground">{item.note}</span>}
                  </div>
                ))}
              </div>
            </details>
          );
        })()}
      </CardContent>
    </Card>
  );
}

export function TrajectoryScoring({ taskId, framework, embedded = false, onJumpToTurn }: { taskId: string; framework?: string; embedded?: boolean; onJumpToTurn?: (turnIndex: number) => void }) {
  const [card, setCard] = useState<Scorecard | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | '404' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string; startedAt: number } | null>(null);
  const [busy, setBusy] = useState<'none' | 'det' | 'llm' | 'mate'>('none');
  // 换会话/换记录类（App Router 同位复用不重挂载）后的旧流守卫：fetchCard 与
  // 评审 done 的 setCard 只对发起时的 taskId/framework 生效——晚到的旧响应
  // 后到者胜，会把 A 会话的卡写进 B 的 Score 页
  const runTokenRef = useRef(0);
  const runTokenFirstRef = useRef(true);
  useEffect(() => {
    if (runTokenFirstRef.current) { runTokenFirstRef.current = false; return; }
    runTokenRef.current++;
  }, [taskId, framework]);
  const [showUserDefs, setShowUserDefs] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showBenchReport, setShowBenchReport] = useState(false);
  const [reportConfirm, setReportConfirm] = useState<{ latest: { totalScore?: number | null; completedAt?: string } } | null>(null);
  const [mateTools, setMateTools] = useState<string[]>([]);
  const [mateTool, setMateTool] = useState<string>('opencode');
  const [reviewer, setReviewer] = useState<'mate' | 'llm'>('mate');
  const [mateProgress, setMateProgress] = useState<{ done: number; total: number; current: string; startedAt: number } | null>(null);

  /** force=false 读缓存（首开零等待）；force=true POST 强制重算（重算按钮用） */
  const fetchCard = useCallback(async (force = false): Promise<Scorecard | null> => {
    const token = runTokenRef.current;
    const stale = () => runTokenRef.current !== token;
    setState('loading');
    setBusy('det');
    try {
      const res = force
        ? await fetch(`/api/observe/session/scorecard`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, framework }),
          })
        : await fetch(`/api/observe/session/scorecard?taskId=${encodeURIComponent(taskId)}${framework ? `&framework=${encodeURIComponent(framework)}` : ''}`);
      if (res.status === 404) { if (!stale()) setState('404'); return null; }
      const data = await res.json();
      if (!res.ok) { if (!stale()) { setError(data.error ?? `HTTP ${res.status}`); setState('error'); } return null; }
      if (!data?.framework) { if (!stale()) setState('404'); return null; }   // 空壳/非评分卡载荷：按"还没有卡"处理，不渲染
      if (stale()) return null;   // 旧会话的晚到响应：不覆盖新会话的卡
      setCard(data as Scorecard);
      setState('ok');
      return data as Scorecard;
    } catch (e) {
      if (!stale()) { setError(e instanceof Error ? e.message : 'network error'); setState('error'); }
      return null;
    } finally {
      if (!stale()) setBusy('none');
    }
  }, [taskId, framework]);

  // setState 放微任务：避免 effect 体内同步 setState（仓库既有模式）
  useEffect(() => {
    queueMicrotask(() => { void fetchCard(); });
  }, [fetchCard]);

  const runSemantic = useCallback(async () => {
    // LLM 配置复用 AI 分析设置（localStorage），不另建配置入口
    queueMicrotask(() => {
      const cfg = loadProviderConfig();
      if (!cfg?.apiKey || !cfg.baseUrl || !cfg.model) {
        // 显式提示（不能只写 error state——页面状态还是 ok，那套错误分支不渲染，等于点了没反应）
        setNotice('未配置 LLM：先到「设置」页填好 baseUrl / apiKey / model 并保存，再回来运行 LLM 评审。确定性层（零 LLM）不受影响。');
        return;
      }
      setNotice(null);
      setBusy('llm');
      setState('loading');
      setProgress({ done: 0, total: 0, current: '', startedAt: Date.now() });
      const token = runTokenRef.current;
      const stale = () => runTokenRef.current !== token;
      (async () => {
        try {
          const res = await fetch('/api/observe/session/scorecard/semantic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              taskId,
              framework,
              provider: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
            }),
          });
          if (!res.ok || !res.body) {
            const data = await res.json().catch(() => ({}) as { error?: string });
            setError(data.error ?? `HTTP ${res.status}`);
            setState('error');
            return;
          }
          // NDJSON 流：逐行读进度（每个 LLM 子项一条），收尾 done 携带整卡
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const evt = JSON.parse(line) as {
                type: 'progress' | 'done' | 'error';
                done?: number; total?: number; current?: string;
                card?: Scorecard; message?: string;
              };
              if (evt.type === 'progress') {
                setProgress(p => ({ done: evt.done ?? p?.done ?? 0, total: evt.total ?? p?.total ?? 0, current: evt.current ?? '', startedAt: p?.startedAt ?? Date.now() }));
              } else if (stale()) {
                continue;   // 已切到别的会话：旧评审流的终态不再落卡
              } else if (evt.type === 'done' && evt.card) {
                setCard(evt.card);
                setState('ok');
              } else if (evt.type === 'error') {
                setError(evt.message ?? 'LLM 评审失败');
                setState('error');
              }
            }
          }
        } catch (e) {
          if (!stale()) { setError(e instanceof Error ? e.message : 'network error'); setState('error'); }
        } finally {
          if (!stale()) { setBusy('none'); setProgress(null); }
        }
      })();
    });
  }, [taskId, framework]);

  // 评审运行中（mate/llm 长窗口）配置变更不触发重算：fetchCard 会抢占 busy
  //（运行横幅消失、按钮解禁），评审 done 事件随后用旧 profile 的卡覆盖回来
  // ——配置入口已随 busy 禁用，这里是回调侧的兜底守卫
  const onUserDefsChanged = useCallback(() => { if (busy === 'none') void fetchCard(); }, [busy, fetchCard]);

  /** 疑似点人工复核：确认一条（problem=有问题扣分 / fine=没问题出池），服务端返回重聚合后的整卡 */
  const [adjBusy, setAdjBusy] = useState(false);
  const adjudicate = useCallback(async (itemId: string, e: Evidence, confirmed: 'problem' | 'fine') => {
    setAdjBusy(true);
    try {
      const res = await fetch('/api/observe/session/scorecard/adjudicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, framework, itemId, turnIndex: e.turnIndex, label: e.label, confirmed }),
      });
      const data = await res.json();
      if (!res.ok) { setNotice(data.error ?? `HTTP ${res.status}`); return; }
      if (data?.framework) setCard(data as Scorecard);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'network error');
    } finally {
      setAdjBusy(false);
    }
  }, [taskId, framework]);

  // Mate Agent：探测本机可用工具（claude/opencode）
  const fetchMateTools = useCallback(async () => {
    try {
      const res = await fetch('/api/observe/session/mate-agent');
      const data = await res.json() as { tools?: string[] };
      const avail = data.tools ?? [];
      setMateTools(avail);
      if (avail.length > 0 && !avail.includes(mateTool)) setMateTool(avail[0]);
    } catch { /* 探测失败静默，按钮禁用即可 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void fetchMateTools(); });
  }, [fetchMateTools]);

  // 上报评分卡快照到数据湖（实验记录 notes）：覆盖写——旧 scorecard 记录整类替换
  // 为当前快照（历史仍在 git 提交里），总分算式/模板/评审工具/耗时齐带，不动本地卡。
  // 框架定记录位：-proxy 行报捕获位、原生行报 native 位。库里已有快照时先弹确认
  const lakeNotesUrl = useCallback(() => {
    const recording = framework?.endsWith('-proxy') ? 'capture' : framework ? 'native' : '';
    return `/lake_viewer/api/runs/${encodeURIComponent(taskId)}/notes${recording ? `?recording=${recording}` : ''}`;
  }, [taskId, framework]);

  const doReportToLake = useCallback(async () => {
    setBusy('det');
    try {
      const res = await fetch(lakeNotesUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'scorecard' }),
      });
      const data = await res.json() as { error?: string; records?: unknown[] };
      if (!res.ok) {
        // 上传失败不打成整页「评分失败」：评分本身完好，降级为可重试的提示
        setNotice(`上报 ${BAY_NAME} 失败：${data.error ?? `HTTP ${res.status}`}——本地评分卡不受影响，稍后重试上传即可。`);
        return;
      }
      const latest = (data.records ?? []).filter((r): r is { type: string; totalScore?: number | null } =>
        typeof r === 'object' && r !== null && (r as { type?: string }).type === 'scorecard').pop();
      setNotice(`已上报 ${BAY_NAME}：评分卡快照已覆盖${latest?.totalScore != null ? `（总分 ${Math.round(latest.totalScore * 100)}）` : ''}。`);
    } catch (e) {
      setNotice(`上报 ${BAY_NAME} 失败：${e instanceof Error ? e.message : 'network error'}——本地评分卡不受影响，稍后重试上传即可。`);
    } finally {
      setBusy('none');
    }
  }, [lakeNotesUrl]);

  const reportToLake = useCallback(async () => {
    setNotice(null);
    setError(null);
    setBusy('det');
    try {
      const res = await fetch(lakeNotesUrl());
      const data = await res.json() as { error?: string; records?: Array<{ type?: string; totalScore?: number | null; completedAt?: string }> };
      if (!res.ok) {
        setNotice(`上报 ${BAY_NAME} 失败：${data.error ?? `HTTP ${res.status}`}——本地评分卡不受影响，稍后重试上传即可。`);
        return;
      }
      const snaps = (data.records ?? []).filter(r => r.type === 'scorecard');
      if (snaps.length > 0) {
        setReportConfirm({ latest: snaps[snaps.length - 1] });
        return;   // 已有快照：先让用户确认
      }
      await doReportToLake();
    } catch (e) {
      setNotice(`上报 ${BAY_NAME} 失败：${e instanceof Error ? e.message : 'network error'}——本地评分卡不受影响，稍后重试上传即可。`);
    } finally {
      setBusy('none');
    }
  }, [lakeNotesUrl, doReportToLake]);

  const runMate = useCallback(async () => {
    const token = runTokenRef.current;
    const stale = () => runTokenRef.current !== token;
    setNotice(null);
    setError(null);
    setBusy('mate');
    setMateProgress({ done: 0, total: 5, current: '评分中', startedAt: Date.now() });
    try {
      const res = await fetch('/api/observe/session/mate-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, framework, tool: mateTool }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        setState('error');
        return;
      }
      // NDJSON 流：逐维 progress + 收尾 done 携带整卡
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line) as {
            type: 'progress' | 'done' | 'error';
            done?: number; total?: number; current?: string;
            card?: Scorecard | null;
            failureNote?: string;
            message?: string;
          };
          if (evt.type === 'progress') {
            setMateProgress(p => ({ done: evt.done ?? p?.done ?? 0, total: evt.total ?? p?.total ?? 5, current: evt.current ?? '', startedAt: p?.startedAt ?? Date.now() }));
          } else if (stale()) {
            continue;   // 已切到别的会话：旧评审流的终态不再落卡
          } else if (evt.type === 'done') {
            if (evt.card) {
              setCard(evt.card);
              setState('ok');
              if (evt.failureNote) setNotice(`Mate Agent 部分维度失败，对应子项按规则层/无法评判回退：${evt.failureNote}`);
            } else {
              setError('未产出评分卡');
              setState('error');
            }
          } else if (evt.type === 'error') {
            setError(evt.message ?? '评审失败');
            setState('error');
          }
        }
      }
    } catch (e) {
      if (!stale()) { setError(e instanceof Error ? e.message : 'network error'); setState('error'); }
    } finally {
      if (!stale()) { setBusy('none'); setMateProgress(null); }
    }
  }, [taskId, framework, mateTool]);

  const body = (
    <>
      <HudStyles />
      {notice && (
        <div className="rounded border border-orange-500/40 bg-orange-500/10 px-3 py-2 flex items-start gap-2">
          <AlertTriangleIcon className="size-4 text-orange-500 shrink-0 mt-0.5" />
          <p className="text-xs text-orange-600 dark:text-orange-400">{notice}</p>
        </div>
      )}
      {busy === 'mate' && (
        <Card size="sm">
          <CardContent className="pt-4 pb-4 px-4">
            <div className="flex items-center gap-2 text-sm">
              <LoaderIcon className="size-4 animate-spin text-violet-500" />
              <span className="font-medium">Mate Agent 评审运行中</span>
              {mateProgress && mateProgress.total > 0 && <MateProgressText p={mateProgress} />}
              {mateProgress?.current && (
                <span className="text-muted-foreground text-xs truncate">· {mateProgress.current}</span>
              )}
              <span className="text-muted-foreground text-xs">
                {mateTool}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
      {state === 'loading' && busy === 'llm' && progress && (
        <Card size="sm">
          <CardContent className="pt-4 pb-4 px-4 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <LoaderIcon className="size-4 animate-spin text-blue-500" />
              <span className="font-medium">LLM 评审运行中</span>
              <span className="text-muted-foreground font-mono tabular-nums text-xs">
                {progress.total > 0 ? `${progress.done}/${progress.total}` : '准备中'}
              </span>
              <span className="text-muted-foreground text-xs">
                已进行 {Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000))}s（并行评审中，可能需要几分钟）
              </span>
            </div>
            {progress.total > 0 && (
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }}
                />
              </div>
            )}
            {progress.current && (
              <p className="text-xs text-muted-foreground truncate">
                正在评审：<span className="font-mono">{progress.current}</span>
              </p>
            )}
          </CardContent>
        </Card>
      )}
      {state === 'loading' && !(busy === 'llm' && progress) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-16 justify-center">
          <LoaderIcon className="size-4 animate-spin" />
          {busy === 'llm' ? 'LLM 评审运行中（准备中...）' : '计算评分卡（确定性层，零 LLM）...'}
        </div>
      )}
      {state === '404' && (
        <div className="text-center py-16 space-y-2">
          <p className="text-sm text-muted-foreground">未找到 session：<span className="font-mono">{taskId}</span></p>
          <Link href="/" className="inline-flex items-center px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent/30 transition-colors">返回首页</Link>
        </div>
      )}
      {state === 'error' && (
        <div className="text-center py-16 space-y-2">
          <p className="text-sm text-red-500">评分失败：{error}</p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void fetchCard(true)}>重试</Button>
          </div>
        </div>
      )}

      {state === 'ok' && card && (
        <>
          {card.status === 'aborted' ? (
            <Card size="sm">
              <CardContent className="pt-4 pb-4">
                <div className="rounded border border-orange-500/40 bg-orange-500/10 px-3 py-2 flex items-start gap-2">
                  <AlertTriangleIcon className="size-4 text-orange-500 shrink-0 mt-0.5" />
                  <div className="text-xs space-y-0.5">
                    <p className="font-medium text-orange-600 dark:text-orange-400">评价中止：session 被截断（stop_reason=max_tokens）</p>
                    <p className="text-muted-foreground">截断的轨迹评不出完成度，整卡不评、不进基线语料。</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card size="sm" className="relative overflow-hidden">
              <div aria-hidden className="hud-grid absolute inset-0 pointer-events-none text-foreground" />
              <CardContent className="relative py-5 px-5">
                <div className="flex items-center gap-8 flex-wrap">
                  <div className="flex items-baseline gap-3">
                    <span
                      className="num-glow font-mono text-6xl font-bold tabular-nums leading-none"
                      style={{ color: bandHex(card.framework.totalScore, card.framework.veto?.triggered ? 'violation' : null) }}
                    >
                      {card.framework.totalScore != null ? Math.round(card.framework.totalScore * 100) : '—'}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-muted-foreground">总分</span>
                      {card.framework.veto?.triggered && (
                        <span className="text-xs font-medium text-red-500 dark:text-red-400">已否决 · 0 分</span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
                      <span className="w-14 text-[10px] font-medium text-muted-foreground/70 shrink-0 select-none">原任务</span>
                      <span className="hud-chip">任务类型 <b className="text-foreground font-medium">{card.taskType}</b></span>
                      <span className="hud-chip" title="会话概要（不参与评分，对比时参考）">模型 <b className="text-foreground font-medium">{card.context?.models?.join(' / ') || '—'}</b></span>
                      {card.context?.frameworkVersion && (
                        <span className="hud-chip" title="会话概要（不参与评分，对比时参考）">版本 <b className="text-foreground font-mono font-medium">{card.context.frameworkVersion}</b></span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
                      <span className="w-14 text-[10px] font-medium text-muted-foreground/70 shrink-0 select-none">评分任务</span>
                      <span
                        className="hud-chip"
                        title="总分算式：各维得分 × 权重（未出分的维度不参与，其权重在参与维度间归一）加总后，再乘覆盖度折扣（已评子项 / 应评子项——评审没评的拉低覆盖度；材料缺失的「无法评判」是评过的结论，不计入）。被否决时总分直接 0，不走此算式。"
                      >
                        权重 <b className="text-foreground font-mono font-medium">{totalFormulaOf(card)}</b>
                      </span>
                      {(card.framework.coverageGap?.length ?? 0) > 0 && (
                        <span
                          className="hud-chip text-orange-700 dark:text-orange-300"
                          title={`未覆盖 = 评审缺口（未开启 LLM 评审 / Mate 未给出子项）或出错的项——拉低覆盖度；材料缺失的「无法评判」（如缺少改代码后的测试运行）是评过的结论，不计入。\n\n${card.framework.coverageGap!.join('\n')}\n\n各维卡片底部「无法评判」行可展开看原因。`}
                        >
                          未覆盖 <b className="font-mono font-medium">{card.framework.coverageGap!.length}</b> 项
                        </span>
                      )}
                      <span className="hud-chip" title="评分模板（profile 覆盖层）——跨模板的卡总分不可直接比">
                        评分模板 <b className="text-foreground font-medium">{card.framework.profile?.name ?? '默认'}</b>
                      </span>
                      <span className="hud-chip" title="本卡最近一次评审所用的工具（重算确定性层后回落为确定性层）">
                        评审 <b className="text-foreground font-medium">{reviewerLabel(card.review)}</b>
                      </span>
                      <span className="hud-chip" title="评审完成时间">评完 <b className="text-foreground font-mono font-medium">{fmtDateTime(card.review?.completedAt ?? card.computedAt)}</b></span>
                      {card.review?.durationMs != null && (
                        <span className="hud-chip" title="评审耗时：从发起评审到出卡的时长">耗时 <b className="text-foreground font-mono font-medium">{fmtDuration(card.review.durationMs)}</b></span>
                      )}
                      {card.judgeCost && (
                        <span className="hud-chip">评审成本 <b className="text-foreground font-mono font-medium">{card.judgeCost.calls} 次 / {card.judgeCost.tokens.toLocaleString()} tk</b></span>
                      )}
                    </div>
                  </div>
                </div>
                {card.framework.veto?.triggered && (
                  <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2.5 flex items-start gap-2">
                    <AlertTriangleIcon className="size-4 text-red-500 shrink-0 mt-0.5" />
                    <div className="text-sm space-y-1">
                      <p className="font-medium text-red-600 dark:text-red-400">已否决：总分是处分不是成绩（0 分，不进基线语料；各维度照常评，供诊断）</p>
                      {card.framework.veto.reasons.map((r, i) => <p key={i}>· {r}</p>)}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* 三块 1:1:1：雷达图（随列宽放大）| 维度卡两列（D7 自定义维度均分到两列） */}
          {(() => {
            const half = Math.ceil(card.dimensions.length / 2);
            const colA = card.dimensions.slice(0, half);
            const colB = card.dimensions.slice(half);
            // 默认 stretch：雷达卡随行高拉伸到与维度列等高，图在卡内垂直居中
            return (
              <div className="grid gap-3 xl:grid-cols-3">
                <div className="flex flex-col justify-center min-w-0">
                  <Card size="sm" className="dim-card relative overflow-hidden" style={{ '--acc': card.framework.veto?.triggered ? '#ef4444' : '#3b82f6' } as React.CSSProperties}>
                    <span aria-hidden className="hud-corner hud-corner-tl" />
                    <span aria-hidden className="hud-corner hud-corner-br" />
                    <CardHeader className="py-2.5">
                      <CardTitle className="text-sm">六维能力图</CardTitle>
                    </CardHeader>
                    <CardContent className="px-2 pb-2 flex justify-center">
                      <DimensionRadar dimensions={card.dimensions} />
                    </CardContent>
                  </Card>
                </div>
                {[colA, colB].map((col, ci) => (
                  <div key={ci} className="grid gap-3 min-w-0">
                    {col.map(dim => <DimensionCard key={dim.dimensionId} taskId={taskId} dim={dim} onJumpToTurn={onJumpToTurn} onAdjudicate={(iid, e, c) => void adjudicate(iid, e, c)} adjBusy={adjBusy} />)}
                  </div>
                ))}
              </div>
            );
          })()}

          <p className="text-[11px] text-muted-foreground">
            确定性子项零 LLM、可复算；语义子项由「LLM / Mate Agent 评审」激活；基准测试评分按用户填报折算（未填默认 80）。
            评分模板由「评分配置」管理，跨模板总分不可直接比；评分卡随时可重算。
          </p>
         </>
       )}

      <UserDimensionManager open={showUserDefs} onOpenChange={setShowUserDefs} onChanged={onUserDefsChanged} taskId={taskId} />
      <ProfileManager open={showProfile} onOpenChange={setShowProfile} onChanged={() => { if (busy === 'none') void fetchCard(true); }} onOpenD7={() => setShowUserDefs(true)} />
      <Dialog open={reportConfirm != null} onOpenChange={o => { if (!o) setReportConfirm(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>评分上传确认</DialogTitle>
            <DialogDescription>
              {BAY_NAME} 上已有本会话的评分卡快照
              {reportConfirm?.latest?.totalScore != null ? `（总分 ${Math.round(reportConfirm.latest.totalScore * 100)}${reportConfirm.latest.completedAt ? `，评于 ${reportConfirm.latest.completedAt.slice(0, 16).replace('T', ' ')}` : ''}）` : ''}。确认用当前快照覆盖？旧快照只留在 git 提交历史里，记录中不再保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setReportConfirm(null)}>取消</Button>
            <Button size="sm" onClick={() => { setReportConfirm(null); void doReportToLake(); }}>确认上传</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BenchReportDialog open={showBenchReport} onOpenChange={setShowBenchReport} taskId={taskId} framework={framework} onSaved={() => {
        // 填报是读时覆盖：GET 刷新即生效，不整卡重算（不动评审卡）；未跑评审时提醒
        void fetchCard().then(c => {
          if (c && !c.review) {
            setNotice('基准测试填报已保存（立即生效）。当前卡尚未跑 LLM / Mate Agent 评审——语义子项还没有分，建议跑一次评审。');
          }
        });
      }} />
      <ScoringCriteria />
    </>
  );

  /** 把本会话设为其任务类型的基线样例（单会话基线：新会话与它比比值） */
  const setBaseline = useCallback(async () => {
    setBusy('det');
    try {
      const res = await fetch('/api/observe/session/scorecard/baseline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, framework }),
      });
      const data = await res.json();
      if (!res.ok) { setNotice(data.error ?? `HTTP ${res.status}`); return; }
      setNotice(`已设为 ${data.taskType} 类基线会话「${data.label}」（${data.metricsCount} 项度量）。重算后 D4/D5 按它评比值。`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'network error');
    } finally {
      setBusy('none');
    }
  }, [taskId, framework]);

  const actions = (
    <div className="flex items-center gap-1.5">
      {/* 评审入口二选一：评审器分段互斥选中（Mate 默认·推荐），单一「运行评审」跑当前段。*/}
      {/* 使用频率排序：评审器+运行（最常用）→ 填报/上报 → 设为基线 → 评分配置（最不常用） */}
      <div className="flex items-center rounded-md border border-border bg-muted/30 p-0.5" role="radiogroup" aria-label="评审器（二选一，后跑覆盖先跑）">
        {([['mate', 'Mate Agent'], ['llm', 'LLM']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={reviewer === key}
            disabled={busy !== 'none'}
            onClick={() => setReviewer(key)}
            title={key === 'mate' ? '本地 claude/opencode 读原始数据判语义子项（规则层仍代码直算）——推荐：材料更全、能核对工具答复链等证据' : '直连 LLM 端点评语义子项（需已配置 LLM）'}
            className={`h-6 rounded px-2 text-xs inline-flex items-center gap-1 transition-colors disabled:opacity-50 ${reviewer === key ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {key === 'mate' ? <BotIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
            {label}
            {key === 'mate' && <span className="rounded-sm bg-green-500/15 px-1 py-px text-[9px] leading-none text-green-600 dark:text-green-400">推荐</span>}
          </button>
        ))}
      </div>
      {reviewer === 'mate' && mateTools.length > 0 && (
        <select
          value={mateTool}
          onChange={e => setMateTool(e.target.value)}
          disabled={busy !== 'none'}
          className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-muted-foreground"
          title="选择本地 agent 工具"
        >
          {mateTools.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1"
        onClick={() => void (reviewer === 'mate' ? runMate() : runSemantic())}
        disabled={busy !== 'none' || (reviewer === 'mate' && mateTools.length === 0)}
        title={reviewer === 'mate' ? '用本地 agent 读原始数据取证评审（推荐）' : '确定性层 + LLM 层整体重跑（需已配置 LLM）——与 Mate 评审二选一，后跑的覆盖先跑的'}
      >
        {busy !== 'none' ? <LoaderIcon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
        运行评审
      </Button>
      {state === 'ok' && card && card.status === 'completed' && card.taskType === 'operator' && (
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowBenchReport(true)} disabled={busy !== 'none'} title="填入排行榜总分（百分制），D3「基准测试评分」按它折算 0-10；未填默认 80 持平档">
          <FlaskConicalIcon className="size-3.5" />
          基准测试填报
        </Button>
      )}
      {state === 'ok' && card && card.status === 'completed' && (
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => void reportToLake()} disabled={busy !== 'none'} title={`把当前评分卡快照上传到 ${BAY_NAME} 的实验记录（notes）：总分算式、评分模板、评审工具、评完时间与耗时都随快照带走；本地卡不动；已有快照时覆盖（先确认）`}>
          {busy === 'det' ? <LoaderIcon className="size-3.5 animate-spin" /> : <ShareIcon className="size-3.5" />}
          评分上传
        </Button>
      )}
      {state === 'ok' && card && card.status === 'completed' && card.taskType !== 'unknown' && (
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => void setBaseline()} disabled={busy !== 'none'} title={`把本会话设为 ${card.taskType} 类任务的基线样例——D4/D5 的新会话与它比比值`}>
          {busy === 'det' ? <LoaderIcon className="size-3.5 animate-spin" /> : <TargetIcon className="size-3.5" />}
          设为基线
        </Button>
      )}
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => { void fetchCard(true); }} disabled={busy !== 'none'} title="重算确定性层（零 LLM）：源数据更新/自动同步后评分卡是陈旧缓存时用它刷新；评审运行中不可用">
        <RefreshCwIcon className="size-3.5" />
        重算
      </Button>
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowProfile(true)} disabled={busy !== 'none'} title="评分配置 profile：勾选子项 / 双级权重 / 维度内自定义项 / 模板 / 导入导出；D7 自定义维度入口在内；评审运行中暂不可改（改了也不会作用于进行中的评审）">
        <SettingsIcon className="size-3.5" />
        评分配置
      </Button>
    </div>
  );

  if (embedded) {
    return (
      <div className="space-y-4 p-4 h-full overflow-y-auto">
        <div className="flex items-center justify-end gap-2">
          {actions}
        </div>
        {state === 'error' && error && (
          <p className="text-[11px] text-red-500 px-1">{error}</p>
        )}
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href={`/session/${encodeURIComponent(taskId)}`}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/30 transition-colors"
          >
            <ArrowLeftIcon className="size-4" />
            返回 Session
          </Link>
          <div className="flex items-center gap-1.5">
            <span className="text-2xl font-bold tracking-tight text-foreground">{BRAND_NAME}</span>
            <span className="text-xs text-muted-foreground">{VERSION_DISPLAY}</span>
          </div>
          <h1 className="text-xl font-bold truncate">轨迹评分：{taskId}</h1>
          <div className="ml-auto">{actions}</div>
        </div>
      </div>

      <main className="flex-1 overflow-auto px-4 py-4 max-w-6xl w-full mx-auto space-y-4">
        {body}
      </main>
    </div>
  );
}

