// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

export interface Filters {
  framework: string;
  ccVersion: string;
  opGen: '' | 'success' | 'failure';
  scored: '' | 'true' | 'false';
  imported: '' | 'true' | 'false';
  q: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: Filters = {
  framework: '', ccVersion: '', opGen: '', scored: '', imported: '', q: '', from: '', to: '',
};

const selectCls = 'rounded border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-neutral-500';

export function FilterBar({
  filters,
  facets,
  onChange,
}: {
  filters: Filters;
  facets: { frameworks: string[]; ccVersions: string[] };
  onChange: (next: Filters) => void;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const active = Object.entries(filters).some(([, v]) => v !== '');

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-white px-4 py-2">
      <select className={selectCls} value={filters.framework} onChange={e => set({ framework: e.target.value })}>
        <option value="">全部工具</option>
        {facets.frameworks.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
      <select className={selectCls} value={filters.ccVersion} onChange={e => set({ ccVersion: e.target.value })}>
        <option value="">全部版本</option>
        {facets.ccVersions.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
      <select className={selectCls} value={filters.opGen} onChange={e => set({ opGen: e.target.value as Filters['opGen'] })}>
        <option value="">算子生成：全部</option>
        <option value="success">算子生成：成功</option>
        <option value="failure">算子生成：失败</option>
      </select>
      <select className={selectCls} value={filters.scored} onChange={e => set({ scored: e.target.value as Filters['scored'] })}>
        <option value="">评分：全部</option>
        <option value="true">已评分</option>
        <option value="false">未评分</option>
      </select>
      <select className={selectCls} value={filters.imported} onChange={e => set({ imported: e.target.value as Filters['imported'] })}>
        <option value="">导入：全部</option>
        <option value="true">已导入</option>
        <option value="false">未导入</option>
      </select>
      <input
        type="date"
        className={selectCls}
        value={filters.from}
        onChange={e => set({ from: e.target.value })}
        title="开始时间下界"
      />
      <span className="text-sm text-neutral-400">→</span>
      <input
        type="date"
        className={selectCls}
        value={filters.to}
        onChange={e => set({ to: e.target.value })}
        title="开始时间上界"
      />
      <input
        value={filters.q}
        onChange={e => set({ q: e.target.value })}
        placeholder="sid 搜索…"
        className={`${selectCls} w-40`}
      />
      {active && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="rounded border border-neutral-300 px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
        >
          清除筛选
        </button>
      )}
    </div>
  );
}
