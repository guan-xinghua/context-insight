// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { ParadigmSidebar, type ParadigmSummaryView } from '@/app/cannbay_viewer/_components/ParadigmSidebar';
import { FilterBar, EMPTY_FILTERS, type Filters } from '@/app/cannbay_viewer/_components/FilterBar';
import { RunsTable, type RunItemView } from '@/app/cannbay_viewer/_components/RunsTable';
import { OpgenProgress } from '@/app/cannbay_viewer/_components/OpgenProgress';
import { LakeProgressView } from '@/app/cannbay_viewer/_components/LakeProgressView';
import { VERSION_DISPLAY } from '@/lib/version';
import { BAY_VIEWER_NAME } from '@/lib/branding';

interface RunsResponse {
  paradigm: string;
  total: number;
  baselineSid: string | null;
  insightReachable: boolean;
  facets: { frameworks: string[]; ccVersions: string[] };
  items: RunItemView[];
}

// 浏览器时区偏移（±HH:MM）：日期筛选边界按用户本地时区解释，服务端不再
// 自行解读无时区日期（UTC 服务器上 +08 用户的「当天」会平移 8 小时）
function browserTzOffset(): string {
  const minutes = new Date().getTimezoneOffset();
  const sign = minutes <= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function filtersToQuery(paradigm: string, f: Filters): string {
  const p = new URLSearchParams();
  p.set('paradigm', paradigm);
  if (f.framework) p.set('framework', f.framework);
  if (f.ccVersion) p.set('ccVersion', f.ccVersion);
  if (f.opGen) p.set('opGen', f.opGen);
  if (f.scored) p.set('scored', f.scored);
  if (f.imported) p.set('imported', f.imported);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.from || f.to) p.set('tz', browserTzOffset());
  return p.toString();
}

function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="0" y="0" width="32" height="32" rx="7" fill="#0f172a" />
      <path
        d="M4.5 16 C8 10.5 12 8.5 16 8.5 C20 8.5 24 10.5 27.5 16 C24 21.5 20 23.5 16 23.5 C12 23.5 8 21.5 4.5 16 Z"
        fill="none"
        stroke="#22d3ee"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="4.2" fill="none" stroke="#a78bfa" strokeWidth="2" />
      <circle cx="16" cy="16" r="1.6" fill="#a78bfa" />
    </svg>
  );
}

function ViewerPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = useMemo<Filters>(() => ({
    framework: searchParams.get('framework') ?? '',
    ccVersion: searchParams.get('ccVersion') ?? '',
    opGen: (searchParams.get('opGen') as Filters['opGen']) ?? '',
    scored: (searchParams.get('scored') as Filters['scored']) ?? '',
    imported: (searchParams.get('imported') as Filters['imported']) ?? '',
    q: searchParams.get('q') ?? '',
    from: searchParams.get('from') ?? '',
    to: searchParams.get('to') ?? '',
  }), [searchParams]);

  const [paradigms, setParadigms] = useState<ParadigmSummaryView[] | null>(null);
  const selected = searchParams.get('paradigm') ?? paradigms?.[0]?.name ?? null;

  const [result, setResult] = useState<{ query: string; data: RunsResponse | null; error: string | null } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const query = selected ? filtersToQuery(selected, filters) : '';
  const runs = result?.query === query ? result.data : null;
  const error = result?.query === query ? result.error : null;

  useEffect(() => {
    let cancelled = false;
    void fetch('/cannbay_viewer/api/paradigms').then(r => r.json()).then((d: { items?: ParadigmSummaryView[] }) => {
      if (!cancelled) setParadigms(d.items ?? []);
    }).catch(() => {
      if (!cancelled) setParadigms([]);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/cannbay_viewer/api/runs?${query}`);
        const data = await res.json() as RunsResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (!cancelled) setResult({ query, data, error: null });
      } catch (e) {
        if (!cancelled) setResult({ query, data: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [query, refreshKey]);

  const importRun = async (sid: string): Promise<boolean> => {
    try {
      const res = await fetch('/cannbay_viewer/api/runs/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sid }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        console.error(`导入 ${sid} 失败:`, data.error ?? `HTTP ${res.status}`);
        return false;
      }
      setRefreshKey(k => k + 1);
      return true;
    } catch (e) {
      console.error(`导入 ${sid} 失败:`, e);
      return false;
    }
  };

  const updateUrl = (patch: Partial<Filters> & { paradigm?: string }) => {
    const p = new URLSearchParams(searchParams);
    const next = { ...filters, ...patch };
    for (const key of Object.keys(EMPTY_FILTERS) as Array<keyof Filters>) {
      const v = next[key];
      if (v) p.set(key, v); else p.delete(key);
    }
    if (patch.paradigm) p.set('paradigm', patch.paradigm);
    router.replace(`/cannbay_viewer/?${p.toString()}`, { scroll: false });
  };

  const loadingView = !error && !runs && !!selected;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <h1 className="text-base font-semibold">{BAY_VIEWER_NAME}</h1>
          </div>
          <span className="text-xs text-neutral-400">{VERSION_DISPLAY}</span>
          <span className="text-xs text-neutral-400">范式工作流实验管理</span>
        </div>
        <Link href="/" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-neutral-100 transition-colors">
          <ArrowLeftIcon className="size-4" />
          返回
        </Link>
      </header>
      <div className="flex min-h-0 flex-1">
        <ParadigmSidebar
          paradigms={paradigms ?? []}
          selected={selected}
          onSelect={name => updateUrl({ paradigm: name })}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <FilterBar filters={filters} facets={runs?.facets ?? { frameworks: [], ccVersions: [] }} onChange={f => updateUrl(f)} />
              {runs && runs.items.length > 0 && (
                <div className="px-4 pt-3">
                  <OpgenProgress paradigm={selected} items={runs.items} />
                </div>
              )}
              <div className="mt-2 flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-1.5 text-xs text-neutral-500">
                <span>
                  {selected}
                  {runs?.baselineSid && <span className="ml-2 text-emerald-600" title={`基准 ${runs.baselineSid}`}>◆ baseline</span>}
                </span>
                <span>
                  {loadingView ? '加载中…' : runs ? `共 ${runs.total} 条运行${runs.total > runs.items.length ? `（显示前 ${runs.items.length} 条）` : ''}` : ''}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {error && <p className="p-4 text-sm text-red-600">{error}</p>}
                {!error && runs && runs.items.length === 0 && (
                  <p className="p-8 text-center text-sm text-neutral-400">该筛选条件下无运行</p>
                )}
                {!error && runs && runs.items.length > 0 && (
                  <RunsTable items={runs.items} onImport={importRun} />
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              {paradigms == null
                ? <LakeProgressView />
                : paradigms.length === 0
                  ? <p className="text-sm text-neutral-400">数据仓为空或不可达</p>
                  : <p className="text-sm text-neutral-400">选择左侧范式开始</p>}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center text-sm text-neutral-400">加载中…</div>}>
      <ViewerPage />
    </Suspense>
  );
}
