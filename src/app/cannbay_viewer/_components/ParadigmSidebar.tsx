// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

import { useMemo, useState } from 'react';

export interface ParadigmSummaryView {
  name: string;
  runCount: number;
  hasBaseline: boolean;
}

export function ParadigmSidebar({
  paradigms,
  selected,
  onSelect,
}: {
  paradigms: ParadigmSummaryView[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? paradigms.filter(p => p.name.toLowerCase().includes(f)) : paradigms;
  }, [paradigms, filter]);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 p-3">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="过滤范式…"
          className="w-full rounded border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-neutral-500"
        />
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {visible.length === 0 && (
          <p className="px-2 py-4 text-sm text-neutral-400">无范式目录</p>
        )}
        {visible.map(p => (
          <button
            key={p.name}
            type="button"
            onClick={() => onSelect(p.name)}
            className={`mb-0.5 flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
              p.name === selected ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-100'
            }`}
          >
            <span className="truncate" title={p.name}>{p.name}</span>
            <span className="ml-2 flex shrink-0 items-center gap-1.5">
              {p.hasBaseline && (
                <span className={`text-xs ${p.name === selected ? 'text-emerald-300' : 'text-emerald-600'}`} title="已设基准">◆</span>
              )}
              <span className={`text-xs tabular-nums ${p.name === selected ? 'text-neutral-300' : 'text-neutral-500'}`}>{p.runCount}</span>
            </span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
