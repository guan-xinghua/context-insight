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

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeftIcon, RefreshCwIcon, LoaderIcon, AlertTriangleIcon, SparklesIcon, SettingsIcon, TargetIcon, FlaskConicalIcon } from 'lucide-react';
import { BRAND_NAME } from '@/lib/branding';
import { VERSION_DISPLAY } from '@/lib/version';
import { loadProviderConfig } from '@/lib/ai-provider-config';
import type { DimensionResult, Scorecard, SubItemResult } from '@/lib/scoring';
import { ScoringCriteria } from '@/components/scoring/ScoringCriteria';
import { UserDimensionManager } from '@/components/scoring/UserDimensionManager';
import { ProfileManager } from '@/components/scoring/ProfileManager';
import { OpBenchDialog } from '@/components/scoring/OpBenchDialog';
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
};
const VERDICT_TEXT: Record<string, string> = {
  完成: '完成', 未完成: '未完成', 无法判定: '无法判定',
  violation: '违规（否决）', suspected: '疑似（不否决）', clean: '无发现',
  pass: '通过', fail: '未通过',
};

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

function SubItemRow({ taskId, item, onJumpToTurn }: { taskId: string; item: SubItemResult; onJumpToTurn?: (turnIndex: number) => void }) {
  return (
    <details className="group rounded px-1.5 hover:bg-accent/25 transition-colors">
      <summary className="cursor-pointer select-none py-1 text-xs flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-muted-foreground shrink-0">{item.itemId}</span>
          <span className="font-medium">{item.label}</span>
          {item.status === 'ok' && <span className="font-mono tabular-nums">{formatValue(item)}</span>}
          {item.baselineScore != null && (
            <span className="text-[10px] text-muted-foreground font-mono">对比分 {Math.round(item.baselineScore * 100)}</span>
          )}
          {item.verdict && <span className="text-[10px] text-muted-foreground font-mono">{item.verdict}</span>}
          {item.status === 'not-applicable' && <Badge variant="gray" title="没有判断材料，弃权——不扣分，只拉低覆盖度">无法评判</Badge>}
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
          {item.evidence.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.evidence.map((e, i) => {
                const chipClass = 'inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-accent/40 transition-colors';
                const inner = (
                  <>
                    <span className="text-blue-600 dark:text-blue-400 font-mono">{e.turnIndex != null ? `§${e.turnIndex}` : '§'}</span>
                    <span className="text-muted-foreground truncate max-w-[280px]">{e.label}</span>
                  </>
                );
                // 页内跳转（session 页内嵌时零刷新）；独立页退化为带 errorTurn 的深链
                if (onJumpToTurn && e.turnIndex != null) {
                  return (
                    <span key={i} role="button" tabIndex={0} onClick={() => onJumpToTurn(e.turnIndex!)} title={`跳转会话 §${e.turnIndex}`} className={`${chipClass} cursor-pointer`}>
                      {inner}
                    </span>
                  );
                }
                return (
                  <Link
                    key={i}
                    href={`/session/${encodeURIComponent(taskId)}${e.turnIndex != null ? `?errorTurn=${e.turnIndex}` : ''}`}
                    title={e.turnIndex != null ? `跳转会话 §${e.turnIndex}` : '跳转会话'}
                    className={chipClass}
                  >
                    {inner}
                  </Link>
                );
              })}
            </div>
          )}
          {item.note && <p className="text-[11px] text-muted-foreground">{item.note}</p>}
          {item.error && <p className="text-[11px] text-red-500">{item.error.message}</p>}
        </div>
      </details>
  );
}

function DimensionCard({ taskId, dim, onJumpToTurn }: { taskId: string; dim: DimensionResult; onJumpToTurn?: (turnIndex: number) => void }) {
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
          {dim.items.filter(i => i.status !== 'not-applicable').map(item => <SubItemRow key={item.itemId} taskId={taskId} item={item} onJumpToTurn={onJumpToTurn} />)}
        </div>
        {(() => {
          const skipped = dim.items.filter(i => i.status === 'not-applicable');
          if (skipped.length === 0) return null;
          return (
            <details className="rounded px-1.5 hover:bg-accent/25 transition-colors">
              <summary className="cursor-pointer select-none py-1 text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                <span className="font-medium" title="没有判断材料，弃权——不扣分，只拉低覆盖度">无法评判 ×{skipped.length}</span>
                <span className="opacity-70">{skipped.map(i => i.label).join(' · ')}</span>
              </summary>
              <div className="mb-1.5 mt-1 space-y-1 rounded bg-muted/40 border border-border/60 px-2.5 py-2">
                {skipped.map(item => (
                  <div key={item.itemId} className="text-[11px] flex items-baseline gap-1.5 flex-wrap">
                    <span className="font-mono text-muted-foreground shrink-0">{item.itemId}</span>
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
  const [busy, setBusy] = useState<'none' | 'det' | 'llm'>('none');
  const [showUserDefs, setShowUserDefs] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showOpBench, setShowOpBench] = useState(false);

  /** force=false 读缓存（首开零等待）；force=true POST 强制重算（重算按钮用） */
  const fetchCard = useCallback(async (force = false) => {
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
      if (res.status === 404) { setState('404'); return; }
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); setState('error'); return; }
      if (!data?.framework) { setState('404'); return; }   // 空壳/非评分卡载荷：按"还没有卡"处理，不渲染
      setCard(data as Scorecard);
      setState('ok');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
      setState('error');
    } finally {
      setBusy('none');
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
          setError(e instanceof Error ? e.message : 'network error');
          setState('error');
        } finally {
          setBusy('none');
          setProgress(null);
        }
      })();
    });
  }, [taskId, framework]);

  const onUserDefsChanged = useCallback(() => { void fetchCard(); }, [fetchCard]);

  const body = (
    <>
      <HudStyles />
      {notice && (
        <div className="rounded border border-orange-500/40 bg-orange-500/10 px-3 py-2 flex items-start gap-2">
          <AlertTriangleIcon className="size-4 text-orange-500 shrink-0 mt-0.5" />
          <p className="text-xs text-orange-600 dark:text-orange-400">{notice}</p>
        </div>
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
                  <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
                    <span className="hud-chip">任务类型 <b className="text-foreground font-medium">{card.taskType}</b></span>
                    <span className="hud-chip" title="会话概要（不参与评分，对比时参考）">模型 <b className="text-foreground font-medium">{card.context?.models?.join(' / ') || '—'}</b></span>
                    {card.context?.frameworkVersion && (
                      <span className="hud-chip" title="会话概要（不参与评分，对比时参考）">版本 <b className="text-foreground font-mono font-medium">{card.context.frameworkVersion}</b></span>
                    )}
                    <span className="hud-chip">
                      权重 <b className="text-foreground font-mono font-medium">{Object.entries(card.framework.weightsUsed).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' / ') || '—'}</b>
                    </span>
                    <span className="hud-chip" title="评分口径（profile 覆盖层）——跨口径的卡总分不可直接比">
                      口径 <b className="text-foreground font-medium">{card.framework.profile?.name ?? '默认'}</b>
                    </span>
                    {card.judgeCost && (
                      <span className="hud-chip">评审成本 <b className="text-foreground font-mono font-medium">{card.judgeCost.calls} 次 / {card.judgeCost.tokens.toLocaleString()} tk</b></span>
                    )}
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
                    {col.map(dim => <DimensionCard key={dim.dimensionId} taskId={taskId} dim={dim} onJumpToTurn={onJumpToTurn} />)}
                  </div>
                ))}
              </div>
            );
          })()}

          <p className="text-[11px] text-muted-foreground">
            确定性层零 LLM 可复算；LLM 层（D1.acceptance/goalCoverage、D2.redlines/authorization、D3 五项、D5 两项、D6 分类、D7）按「运行 LLM 评审」激活；D3「CANN-Bench 评分」按用户填报的 cannbench.com 总分折算（未填默认 80 持平档）。
            口径由「评分配置」管理——profile 覆盖层（勾选子项/双级权重/自定义项），跨口径的卡总分不可直接比。
            评分卡缓存于 data/scorecards/（事实源是 turns 数据，重算随时可复现）。
          </p>
        </>
      )}

      <UserDimensionManager open={showUserDefs} onOpenChange={setShowUserDefs} onChanged={onUserDefsChanged} taskId={taskId} />
      <ProfileManager open={showProfile} onOpenChange={setShowProfile} onChanged={() => { void fetchCard(true); }} onOpenD7={() => setShowUserDefs(true)} />
      <OpBenchDialog open={showOpBench} onOpenChange={setShowOpBench} taskId={taskId} framework={framework} onSaved={() => { void fetchCard(true); }} />
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
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => void runSemantic()} disabled={busy !== 'none'} title="确定性层 + LLM 层整体重跑（需已配置 LLM）">
        {busy === 'llm' ? <LoaderIcon className="size-3.5 animate-spin" /> : <SparklesIcon className="size-3.5" />}
        运行 LLM 评审
      </Button>
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowProfile(true)} title="评分配置 profile：勾选子项 / 双级权重 / 维度内自定义项 / 模板 / 导入导出；D7 自定义维度入口在内">
        <SettingsIcon className="size-3.5" />
        评分配置
      </Button>
      {state === 'ok' && card && card.status === 'completed' && card.taskType !== 'unknown' && (
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => void setBaseline()} disabled={busy !== 'none'} title={`把本会话设为 ${card.taskType} 类任务的基线样例——D4/D5 的新会话与它比比值`}>
          {busy === 'det' ? <LoaderIcon className="size-3.5 animate-spin" /> : <TargetIcon className="size-3.5" />}
          设为基线
        </Button>
      )}
      {state === 'ok' && card && card.status === 'completed' && card.taskType === 'operator' && (
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowOpBench(true)} disabled={busy !== 'none'} title="填入 cannbench.com 总分（百分制），D3「CANN-Bench 评分」按它折算 0-10；未填默认 80 持平档">
          <FlaskConicalIcon className="size-3.5" />
          CANN-Bench 填报
        </Button>
      )}
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void fetchCard(true)} disabled={busy !== 'none'} title="重算确定性层（零 LLM，覆盖缓存）">
        {busy === 'det' ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
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

