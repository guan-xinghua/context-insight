// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

import { useMemo, useState } from 'react';
import { formatDateTime, formatDuration, formatScore, formatTokens, formatDelta } from '@/app/lake_viewer/_lib/format';
import { agentFrameworkOf, isProxyVersion } from '@/lib/shared/session-format';
import { NotesDialog } from './NotesDialog';
import { toast } from 'sonner';

export type ImportState = 'idle' | 'importing' | 'error';

export interface RunItemView {
  sid: string;
  isBaseline: boolean;
  recording: 'capture' | 'native';
  framework: string | null;
  ccVersion: string | null;
  workflow: string | null;
  description: string | null;
  author: string | null;
  opGen: 'success' | 'failure' | null;
  startTime: string | null;
  startTimeApprox: boolean;
  durationMs: number | null;
  activeKnown: boolean;
  wallMs: number | null;
  totalTokens: number | null;
  model: string | null;
  imported: boolean;
  totalScore: number | null;
  scoreSource: 'local' | 'lake-note' | null;
  dimensions: Array<{ dimensionId: string; name: string; score: number | null }>;
  baselineDelta: number | null;
  /** 仅已导入行有值；未导入为 null（记录类导入前不可知，见 RunItem 契约） */
  insightUrl: string | null;
}

type SortKey = 'startTime' | 'durationMs' | 'totalTokens' | 'totalScore';

const FRAMEWORK_BADGE: Record<string, string> = {
  'claude-code': 'bg-orange-100 text-orange-800',
  opencode: 'bg-violet-100 text-violet-800',
  codex: 'bg-emerald-100 text-emerald-800',
  cannbot: 'bg-sky-100 text-sky-800',
};

function DimBars({ dims }: { dims: RunItemView['dimensions'] }) {
  const scored = dims.filter(d => d.score != null);
  if (scored.length === 0) return null;
  const COLORS = ['#0284c7', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0f766e', '#be185d'];
  return (
    <span className="ml-1.5 inline-flex items-end gap-0.5" title={scored.map(d => `${d.name}: ${formatScore(d.score)}`).join('\n')}>
      {scored.map((d, i) => {
        const pct = Math.max(4, Math.min(100, (d.score as number)));
        return (
          <span
            key={d.dimensionId}
            className="inline-block w-1 rounded-sm"
            style={{ height: `${Math.max(3, Math.round(pct / 12))}px`, backgroundColor: COLORS[i % COLORS.length], opacity: 0.85 }}
          />
        );
      })}
    </span>
  );
}

function copySid(sid: string) {
  void navigator.clipboard?.writeText(sid);
}

// 同 sid 双记录（捕获 + 原生）是两行——行键用 sid@recording 复合（与导入
// 对话框的 sid@recording 选择键同口径）
const rowKey = (r: RunItemView): string => `${r.sid}@${r.recording}`;

export function RunsTable({
  items,
  onImport,
}: {
  items: RunItemView[];
  onImport: (sid: string, recording: 'capture' | 'native') => Promise<{ insightUrl: string } | { error: string }>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('startTime');
  const [sortDesc, setSortDesc] = useState(true);
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [importErrors, setImportErrors] = useState<Map<string, string>>(new Map());
  const [notesFor, setNotesFor] = useState<RunItemView | null>(null);

  // 会话详情页同源站内跳转：同窗口 location 跳转（浏览器返回键回到 viewer，
  // URL 记住范式与筛选状态），无需旧独立应用时期的 window.open 用户激活技巧
  const importAndOpen = async (r: RunItemView) => {
    const k = rowKey(r);
    setImporting(prev => new Set(prev).add(k));
    setImportErrors(prev => { const m = new Map(prev); m.delete(k); return m; });
    const outcome = await onImport(r.sid, r.recording);
    setImporting(prev => { const s = new Set(prev); s.delete(k); return s; });
    if ('error' in outcome) {
      setImportErrors(prev => new Map(prev).set(k, outcome.error));
      toast.error('导入失败', { description: outcome.error });
    } else {
      // 跳转只认导入响应回带的权威深链（framework = 刚落库行的记录类）；
      // 渲染行里的 insightUrl 是导入前的陈旧值（未导入行本就为 null）
      window.location.href = outcome.insightUrl;
    }
  };

  const sorted = useMemo(() => {
    const val = (r: RunItemView) => {
      switch (sortKey) {
        case 'durationMs': return r.durationMs ?? -1;
        case 'totalTokens': return r.totalTokens ?? -1;
        case 'totalScore': return r.totalScore ?? -1;
        default: return r.startTime ? new Date(r.startTime).getTime() : -1;
      }
    };
    return [...items].sort((a, b) => (sortDesc ? val(b) - val(a) : val(a) - val(b)));
  }, [items, sortKey, sortDesc]);

  const th = (key: SortKey, label: string, title?: string) => (
    <th
      title={title}
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2 font-medium ${sortKey === key ? 'text-neutral-900' : 'text-neutral-500'}`}
      onClick={() => {
        if (sortKey === key) setSortDesc(!sortDesc);
        else { setSortKey(key); setSortDesc(true); }
      }}
    >
      {label}{sortKey === key ? (sortDesc ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 border-b border-neutral-200 bg-white">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium text-neutral-500">运行</th>
            <th className="px-3 py-2 font-medium text-neutral-500">描述</th>
            <th className="px-3 py-2 font-medium text-neutral-500">作者</th>
            <th className="px-3 py-2 font-medium text-neutral-500">工具</th>
            <th className="px-3 py-2 font-medium text-neutral-500">模型类型</th>
            {th('startTime', '开始时间')}
            {th('durationMs', 'Active / Wall', '活跃时长 / 墙钟（斜杠后为墙钟）：间隔 >5min 的空档计非活跃，API 调用进行中计活跃；活跃未知（未导入旧快照/无 turns）显示 — / 墙钟')}
            {th('totalTokens', 'Token')}
            {th('totalScore', '质量')}
            <th className="px-3 py-2 font-medium text-neutral-500">vs Baseline</th>
            <th className="px-3 py-2 font-medium text-neutral-500">算子生成</th>
            <th className="px-3 py-2 font-medium text-neutral-500">导入</th>
            <th className="px-3 py-2 font-medium text-neutral-500">操作</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => {
            const busy = importing.has(rowKey(r));
            const rowAction = () => {
              if (busy) return;
              if (r.imported && r.insightUrl) window.location.href = r.insightUrl;
              else if (!r.imported) void importAndOpen(r);
            };
            return (
            <tr
              key={rowKey(r)}
              className={`${busy ? 'cursor-not-allowed' : 'cursor-pointer'} border-b border-neutral-100 hover:bg-neutral-50`}
              onClick={rowAction}
              title={r.imported ? '点击查看会话详情' : '点击导入到本地库并打开（首次需物化下载数据）'}
            >
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                <span className="inline-flex items-center gap-1.5">
                  {r.isBaseline && <span className="text-emerald-600" title="范式基准">◆</span>}
                  <span title={r.sid}>{r.sid.slice(0, 8)}</span>
                  <button
                    type="button"
                    className="text-neutral-400 hover:text-neutral-700"
                    title="复制完整 sid"
                    onClick={e => { e.stopPropagation(); copySid(r.sid); }}
                  >
                    ⧉
                  </button>
                </span>
              </td>
              <td className="max-w-[16rem] px-3 py-2 text-xs text-neutral-600">
                <span className="block truncate" title={r.description ?? undefined}>
                  {r.description ?? <span className="text-neutral-300">—</span>}
                </span>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-600">
                {r.author ?? <span className="text-neutral-300">—</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                {/* 与 insight 首页同款：框架按 agent 归属归一，proxy 记录挂黄色标签。
                    lake 命名归一后 meta framework 是裸 agent 名——proxy 判据以记录类
                    （capture = cpx 捕获）为准，framework 后缀只作兜底 */}
                {(() => {
                  const fw = r.framework ?? '';
                  const agent = agentFrameworkOf(fw) ?? fw;
                  const proxy = r.recording === 'capture' || fw.endsWith('-proxy') || isProxyVersion(r.ccVersion);
                  return (
                    <span className="inline-flex items-center gap-1">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${agent ? (FRAMEWORK_BADGE[agent] ?? 'bg-neutral-100 text-neutral-700') : 'bg-neutral-100 text-neutral-400'}`}>
                        {agent || '未知'}
                      </span>
                      {r.ccVersion && <span className="ml-1 text-xs text-neutral-500">{r.ccVersion}</span>}
                      {proxy && <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-amber-100 text-amber-800">proxy</span>}
                    </span>
                  );
                })()}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-600">
                {r.model ? <span className="font-mono" title={r.model}>{r.model}</span> : <span className="text-neutral-300">—</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-700">
                {formatDateTime(r.startTime)}{r.startTimeApprox && <span className="ml-1 text-neutral-400" title="未导入本地库，取数据仓提交时间（近似）">≈</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                <span className={r.activeKnown ? 'text-neutral-700' : 'text-neutral-400'}>
                  {r.activeKnown ? formatDuration(r.durationMs) : '—'}
                </span>
                {r.wallMs != null && (
                  <span className="text-neutral-400"> / {formatDuration(r.wallMs)}</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-700">{formatTokens(r.totalTokens)}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                <span
                  className={r.totalScore == null ? 'text-neutral-400' : r.totalScore >= 60 ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'}
                  title={r.scoreSource === 'lake-note' ? '来自仓内评审记录快照（本机未导入，未重算）' : undefined}
                >
                  {formatScore(r.totalScore)}
                  {r.scoreSource === 'lake-note' && <sup className="ml-0.5 text-[10px] font-normal text-neutral-400">仓</sup>}
                </span>
                <DimBars dims={r.dimensions} />
              </td>
              <td className={`whitespace-nowrap px-3 py-2 tabular-nums ${
                r.baselineDelta == null ? 'text-neutral-400'
                  : r.baselineDelta >= 0 ? 'text-emerald-700' : 'text-red-600'
              }`}>
                {formatDelta(r.baselineDelta)}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                {r.opGen === 'success' && <span className="text-emerald-600" title="算子生成成功">✓</span>}
                {r.opGen === 'failure' && <span className="text-red-600" title="算子生成失败">✗</span>}
                {r.opGen == null && <span className="text-neutral-300">·</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                {r.imported
                  ? <span className="text-xs text-emerald-700">已导入</span>
                  : <span className="text-xs text-neutral-400" title="本地库中无此会话">未导入</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2" onClick={e => e.stopPropagation()}>
                <button
                  type="button"
                  className="mr-1.5 rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100"
                  title="实验记录（存数据湖，团队可见）"
                  onClick={() => setNotesFor(r)}
                >
                  记录
                </button>
                {busy ? (
                  <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                    导入中…
                  </span>
                ) : importErrors.has(rowKey(r)) ? (
                  <button
                    type="button"
                    onClick={() => void importAndOpen(r)}
                    className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                    title={importErrors.get(rowKey(r))}
                  >
                    重试导入
                  </button>
                ) : r.imported ? (
                  r.insightUrl ? (
                    <a
                      href={r.insightUrl}
                      className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100"
                    >
                      查看详情
                    </a>
                  ) : null
                ) : (
                  <button
                    type="button"
                    onClick={() => void importAndOpen(r)}
                    className="rounded border border-sky-300 px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50"
                  >
                    导入查看
                  </button>
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      {notesFor && <NotesDialog item={notesFor} onClose={() => setNotesFor(null)} />}
    </div>
  );
}
