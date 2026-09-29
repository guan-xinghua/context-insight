// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 算子生成耗时优化图：run chart——x=运行开始时间，y=生成耗时；仅统计算子
// 生成成功（✓）的运行，失败的会话不进优化曲线；基线/期望为水平参考线
// （存湖 <paradigm>/<paradigm>.jsonl，面板可改）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunItemView } from './RunsTable';

interface Target { baselineMs: number | null; expectedMs: number | null }
interface Hover { left: number; top: number; run: RunItemView }

const W = 720;
const H = 150;
const PAD = { l: 44, r: 10, t: 12, b: 20 };

const SUCCESS_FILL = '#059669';
const fmtDur = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, '')}h` : `${Math.round(ms / 60_000)}m`);

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

export function OpgenProgress({ paradigm, items }: { paradigm: string; items: RunItemView[] }) {
  // 派生状态：loaded/edits 均带 paradigm 键，切换范式时旧值自然失效（无需 effect 重置）
  const [loaded, setLoaded] = useState<{ paradigm: string; target: Target | null } | null>(null);
  const [edits, setEdits] = useState<{ paradigm: string; baseline: string; expected: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const target: Target | null | undefined = loaded?.paradigm === paradigm ? loaded.target : undefined;
  // 目标配置加载中（切换范式 / GET 失败未落 loaded）：输入框尚无真实回显，
  // 此时保存会发出全 null 抹掉团队参考线——禁用保存
  const targetLoading = loaded?.paradigm !== paradigm;
  // 回显保留 2 位小数（往返无损）：Math.round 会把 1.5min 显示成 2，未动输入
  // 再保存就把存储值棘轮到 2min
  const msToMin = (ms: number) => String(+(ms / 60_000).toFixed(2));
  const baselineMin = edits?.paradigm === paradigm
    ? edits.baseline
    : (target?.baselineMs != null ? msToMin(target.baselineMs) : '');
  const expectedMin = edits?.paradigm === paradigm
    ? edits.expected
    : (target?.expectedMs != null ? msToMin(target.expectedMs) : '');

  useEffect(() => {
    let cancelled = false;
    fetch(`/lake_viewer/api/paradigms/${encodeURIComponent(paradigm)}/target`)
      .then(r => r.json())
      .then((d: { target?: Target | null }) => { if (!cancelled) setLoaded({ paradigm, target: d.target ?? null }); })
      .catch(() => {
        // 读取失败不落 loaded（保持"加载中"）：输入框显示空但保存被禁用，
        // 防止用户在无回显状态下保存出全 null
        if (!cancelled) setError('目标配置读取失败，保存已禁用（可刷新重试）');
      });
    return () => { cancelled = true; };
  }, [paradigm]);

  const editBaseline = (v: string) => setEdits({ paradigm, baseline: v, expected: expectedMin });
  const editExpected = (v: string) => setEdits({ paradigm, baseline: baselineMin, expected: v });

  const save = async () => {
    if (saving) return;
    const toMs = (v: string): number | null => {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n * 60_000) : null;
    };
    const b = baselineMin.trim() === '' ? null : toMs(baselineMin);
    const e = expectedMin.trim() === '' ? null : toMs(expectedMin);
    if (baselineMin.trim() !== '' && b == null) { setError('基线需为正数（分钟）'); return; }
    if (expectedMin.trim() !== '' && e == null) { setError('期望需为正数（分钟）'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/lake_viewer/api/paradigms/${encodeURIComponent(paradigm)}/target`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baselineMs: b, expectedMs: e }),
      });
      const d = await res.json() as { target?: Target | null; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setLoaded({ paradigm, target: d.target ?? null });
      setEdits(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const series = useMemo(() => {
    const out: Array<{ run: RunItemView; t: number; d: number }> = [];
    for (const r of items) {
      if (r.opGen !== 'success') continue;
      if (r.durationMs == null || !r.startTime || Number.isNaN(Date.parse(r.startTime))) continue;
      out.push({ run: r, t: Date.parse(r.startTime), d: r.durationMs });
    }
    return out.sort((a, b) => a.t - b.t);
  }, [items]);

  const geom = useMemo(() => {
    if (series.length === 0) return null;
    const values = series.map(p => p.d);
    if (target?.baselineMs != null) values.push(target.baselineMs);
    if (target?.expectedMs != null) values.push(target.expectedMs);
    const yMax = niceMax(Math.max(...values) * 1.08);
    let tMin = series[0]?.t ?? 0;
    let tMax = series[series.length - 1]?.t ?? 1;
    if (tMin === tMax) { tMin -= 30 * 60_000; tMax += 30 * 60_000; }
    const x = (t: number) => PAD.l + ((t - tMin) / (tMax - tMin)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - v / yMax) * (H - PAD.t - PAD.b);
    return { yMax, tMin, tMax, x, y };
  }, [series, target]);

  const onDot = (e: React.MouseEvent<SVGCircleElement>, run: RunItemView) => {
    const card = cardRef.current?.getBoundingClientRect();
    const dot = e.currentTarget.getBoundingClientRect();
    if (!card) return;
    setHover({ left: dot.left - card.left + dot.width / 2, top: dot.top - card.top, run });
  };

  return (
    <div ref={cardRef} className="relative rounded-lg border border-neutral-200 bg-white px-4 pb-3 pt-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-neutral-700">算子生成耗时优化</span>
        <span className="flex items-center gap-1 text-[10px] text-neutral-500">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: SUCCESS_FILL }} />仅算子生成成功（✓）的运行
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-neutral-500">
          基线
          <input
            className="w-14 rounded border border-neutral-300 px-1 py-0.5 text-right text-[10px] outline-none focus:border-sky-400"
            type="number" min="0" step="any" placeholder="—" value={baselineMin}
            disabled={saving} onChange={e => editBaseline(e.target.value)}
          /> 分钟
          期望
          <input
            className="w-14 rounded border border-neutral-300 px-1 py-0.5 text-right text-[10px] outline-none focus:border-sky-400"
            type="number" min="0" step="any" placeholder="—" value={expectedMin}
            disabled={saving} onChange={e => editExpected(e.target.value)}
          /> 分钟
          <button
            type="button"
            className="rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] text-sky-700 hover:bg-sky-100 disabled:opacity-50"
            disabled={saving || targetLoading}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </span>
      </div>
      {error && <div className="mb-1 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] text-red-700">{error}</div>}

      {series.length === 0 || geom == null ? (
        <div className="flex h-[110px] items-center justify-center text-xs text-neutral-300">
          暂无「算子生成成功」且带耗时数据的运行
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[150px] w-full" role="img" aria-label={`${paradigm} 算子生成耗时随时间变化`}>
          {[0.25, 0.5, 0.75, 1].map(f => {
            const v = geom.yMax * f;
            const yy = geom.y(v);
            return (
              <g key={f}>
                <line x1={PAD.l} x2={W - PAD.r} y1={yy} y2={yy} stroke="#f5f5f5" strokeWidth="1" />
                <text x={PAD.l - 6} y={yy + 3} textAnchor="end" fontSize="9" fill="#a3a3a3">{fmtDur(v)}</text>
              </g>
            );
          })}

          {target?.baselineMs != null && target.baselineMs <= geom.yMax && (() => {
            const yy = geom.y(target.baselineMs);
            return (
              <g>
                <line x1={PAD.l} x2={W - PAD.r} y1={yy} y2={yy} stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5 4" />
                <text x={W - PAD.r - 2} y={yy - 4} textAnchor="end" fontSize="9" fill="#525252">基线 {fmtDur(target.baselineMs)}</text>
              </g>
            );
          })()}
          {target?.expectedMs != null && target.expectedMs <= geom.yMax && (() => {
            const yy = geom.y(target.expectedMs);
            return (
              <g>
                <line x1={PAD.l} x2={W - PAD.r} y1={yy} y2={yy} stroke="#0284c7" strokeWidth="1.5" strokeDasharray="5 4" />
                <text x={W - PAD.r - 2} y={yy - 4} textAnchor="end" fontSize="9" fill="#525252">期望 {fmtDur(target.expectedMs)}</text>
              </g>
            );
          })()}

          {series.length > 1 && (
            <polyline
              points={series.map(p => `${geom.x(p.t)},${geom.y(p.d)}`).join(' ')}
              fill="none" stroke="#d4d4d4" strokeWidth="1.5"
            />
          )}
          {series.map(p => (
            <circle
              key={p.run.sid}
              cx={geom.x(p.t)}
              cy={geom.y(p.d)}
              r="4"
              fill={SUCCESS_FILL}
              stroke="#ffffff"
              strokeWidth="1.5"
              className="cursor-pointer"
              onMouseEnter={e => onDot(e, p.run)}
              onMouseLeave={() => setHover(null)}
            />
          ))}

          <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="#e5e5e5" strokeWidth="1" />
          <text x={PAD.l} y={H - 6} fontSize="9" fill="#a3a3a3">{new Date(geom.tMin).toLocaleDateString()}</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="9" fill="#a3a3a3">{new Date(geom.tMax).toLocaleDateString()}</text>
        </svg>
      )}

      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded border border-neutral-200 bg-white px-2 py-1 text-[10px] shadow-sm"
          style={{ left: hover.left, top: hover.top - 6 }}
        >
          <div className="font-mono text-neutral-500">{hover.run.sid}</div>
          <div className="text-neutral-700">{fmtDur(hover.run.durationMs ?? 0)} · {hover.run.opGen === 'success' ? '✓ 成功' : hover.run.opGen === 'failure' ? '✗ 失败' : '· 未标注'}</div>
          <div className="text-neutral-400">{new Date(hover.run.startTime ?? '').toLocaleString()}{hover.run.author ? ` · ${hover.run.author}` : ''}</div>
        </div>
      )}
    </div>
  );
}
