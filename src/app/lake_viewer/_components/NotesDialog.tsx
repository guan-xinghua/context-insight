// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

import { useEffect, useState } from 'react';
import { formatDateTime, formatDuration, formatScore, formatTokens } from '@/app/lake_viewer/_lib/format';
import type { RunItemView } from './RunsTable';

interface NoteEntry { ts: string; type: 'note'; text: string }
interface ScorecardEntry { ts: string; type: 'scorecard'; totalScore: number | null; dimensions: Array<{ dimensionId: string; name: string; score: number | null }>; computedAt: string
  formula?: string; profile?: string; reviewer?: string; completedAt?: string; durationMs?: number; coverage?: number }
type LakeRecord = NoteEntry | ScorecardEntry;
interface SubmitInfo { author: string | null; description: string | null; remark: string | null }

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-16 shrink-0 text-neutral-400">{label}</span>
      <span className="min-w-0 break-words text-neutral-700">{value}</span>
    </div>
  );
}

export function NotesDialog({ item, onClose }: { item: RunItemView; onClose: () => void }) {
  const [records, setRecords] = useState<LakeRecord[] | null>(null);
  const [submit, setSubmit] = useState<SubmitInfo | null>(null);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postingScore, setPostingScore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ ts: string; text: string } | null>(null);
  const [editText, setEditText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [opGen, setOpGenState] = useState<'success' | 'failure' | null>(item.opGen);
  const [savingOpGen, setSavingOpGen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/lake_viewer/api/runs/${encodeURIComponent(item.sid)}/notes?recording=${item.recording}`)
      .then(r => r.json())
      .then((d: { records?: LakeRecord[]; submit?: SubmitInfo; error?: string }) => {
        if (cancelled) return;
        setRecords(d.records ?? []);
        setSubmit(d.submit ?? null);
        if (d.error) setError(d.error);
      })
      .catch(() => { if (!cancelled) setRecords([]); });
    return () => { cancelled = true; };
  }, [item.sid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const post = async (body: Record<string, unknown>, busy: (b: boolean) => void): Promise<boolean> => {
    busy(true);
    setError(null);
    try {
      const res = await fetch(`/lake_viewer/api/runs/${encodeURIComponent(item.sid)}/notes?recording=${item.recording}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json() as { records?: LakeRecord[]; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setRecords(d.records ?? []);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
      return false;
    } finally {
      busy(false);
    }
  };

  const postNote = async () => {
    if (!text.trim() || posting) return;
    if (await post({ kind: 'note', text }, setPosting)) setText('');
  };

  // 覆盖语义：已有快照时先确认（两段式按钮），避免一键静默覆盖
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const hasSnapshot = (records ?? []).some(r => r.type === 'scorecard');
  const postScorecard = async () => {
    if (hasSnapshot && !confirmOverwrite) { setConfirmOverwrite(true); return; }
    setConfirmOverwrite(false);
    await post({ kind: 'scorecard' }, setPostingScore);
  };

  const saveEdit = async () => {
    if (!editing || !editText.trim() || savingEdit) return;
    const target = editing;
    if (!(await post({ kind: 'edit', ts: target.ts, text: target.text, newText: editText }, setSavingEdit))) return;
    setEditing(null);
    setEditText('');
  };

  // 任务结果标注修正：改湖里 meta.json，提交成功后本地乐观更新（表格列刷新后同步）
  const changeOpGen = async (value: 'success' | 'failure' | null) => {
    if (savingOpGen || value === opGen) return;
    setSavingOpGen(true);
    setError(null);
    try {
      const res = await fetch(`/lake_viewer/api/runs/${encodeURIComponent(item.sid)}/notes?recording=${item.recording}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'opgen', value }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setOpGenState(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : '标注失败');
    } finally {
      setSavingOpGen(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-100 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {item.isBaseline && <span className="text-emerald-600" title="范式基准">◆</span>}
              <span className="font-mono text-xs text-neutral-800">{item.sid}</span>
            </div>
            <div className="mt-1 text-xs text-neutral-400">实验记录（存数据湖，团队可见）</div>
          </div>
          <button type="button" className="px-1 text-neutral-400 hover:text-neutral-700" onClick={onClose} title="关闭 (Esc)">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="space-y-1 border-b border-neutral-100 pb-3">
            <div className="mb-1.5 text-xs font-medium text-neutral-500">会话信息</div>
            <InfoRow label="工具" value={`${item.framework ?? '未知'}${item.ccVersion ? ` · ${item.ccVersion}` : ''}`} />
            <InfoRow label="开始" value={<>{formatDateTime(item.startTime)}{item.startTimeApprox && <span className="ml-1 text-neutral-400" title="未导入本地库，取数据仓提交时间（近似）">≈</span>}</>} />
            <InfoRow label="Active / Wall" value={<>{item.activeKnown ? formatDuration(item.durationMs) : <span className="text-neutral-400">—</span>}{item.wallMs != null && <span className="text-neutral-400"> / {formatDuration(item.wallMs)}</span>}</>} />
            <InfoRow label="Token" value={formatTokens(item.totalTokens)} />
            <InfoRow label="质量" value={formatScore(item.totalScore)} />
            <div className="flex items-center gap-2 text-xs">
              <span className="w-16 shrink-0 text-neutral-400">任务结果</span>
              <span className="inline-flex overflow-hidden rounded border border-neutral-200">
                {([['success', '✓ 成功', 'bg-emerald-50 text-emerald-700'], ['failure', '✗ 失败', 'bg-red-50 text-red-600'], [null, '· 清除', 'bg-neutral-100 text-neutral-600']] as const).map(([value, label, activeCls]) => (
                  <button
                    key={label}
                    type="button"
                    className={`px-2 py-0.5 ${opGen === value ? activeCls : 'text-neutral-400 hover:bg-neutral-50'} ${savingOpGen ? 'opacity-50' : ''}`}
                    disabled={savingOpGen}
                    title={value == null ? '清除任务结果标注（未标注）' : `标注为${value === 'success' ? '成功' : '失败'}（写入数据湖 meta）`}
                    onClick={() => void changeOpGen(value)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
          </div>

          <div className="space-y-1 border-b border-neutral-100 py-3">
            <div className="mb-1.5 text-xs font-medium text-neutral-500">提交信息（上传时填写）</div>
            {submit == null ? (
              <div className="text-xs text-neutral-300">读取中…</div>
            ) : (
              <>
                <InfoRow label="提交人" value={submit.author ?? '—'} />
                <InfoRow label="描述" value={submit.description ?? '—'} />
                <InfoRow label="备注" value={submit.remark ?? '—'} />
              </>
            )}
          </div>

          <div className="py-3">
            <div className="mb-2 text-xs font-medium text-neutral-500">记录时间线</div>
            {records == null ? (
              <div className="text-xs text-neutral-300">加载中…</div>
            ) : records.length === 0 ? (
              <div className="text-xs text-neutral-300">暂无记录</div>
            ) : (
              <ul className="space-y-2">
                {records.map((r, i) => {
                  const isEditing = editing != null && r.type === 'note' && r.ts === editing.ts && r.text === editing.text;
                  return (
                  <li key={`${r.ts}-${i}`} className="rounded border border-neutral-100 bg-neutral-50 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                      <span>{formatDateTime(r.ts)}</span>
                      {r.type === 'scorecard' && <span className="rounded bg-violet-100 px-1 py-0.5 text-violet-700">评分卡快照</span>}
                      {r.type === 'note' && !isEditing && (
                        <button
                          type="button"
                          className="ml-auto px-1 text-neutral-300 hover:text-neutral-600"
                          title="编辑此记录"
                          onClick={() => { setEditing({ ts: r.ts, text: r.text }); setEditText(r.text); }}
                        >
                          ✎
                        </button>
                      )}
                    </div>
                    {isEditing ? (
                      <div className="mt-1 flex gap-2">
                        <textarea
                          className="min-h-[3rem] flex-1 resize-y rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-sky-400"
                          value={editText}
                          maxLength={10000}
                          disabled={savingEdit}
                          onChange={e => setEditText(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEdit(); }}
                        />
                        <div className="flex h-fit shrink-0 flex-col gap-1.5">
                          <button
                            type="button"
                            className="rounded border border-sky-300 bg-sky-50 px-2 py-1 text-xs text-sky-700 hover:bg-sky-100 disabled:opacity-50"
                            disabled={savingEdit || !editText.trim()}
                            onClick={() => void saveEdit()}
                          >
                            {savingEdit ? '保存中…' : '保存'}
                          </button>
                          <button
                            type="button"
                            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
                            disabled={savingEdit}
                            onClick={() => { setEditing(null); setEditText(''); }}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : r.type === 'note' ? (
                      <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-neutral-800">{r.text}</div>
                    ) : (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className={r.totalScore == null ? 'text-neutral-400' : r.totalScore >= 60 ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'}>
                          总分 {formatScore(r.totalScore)}
                        </span>
                        {r.dimensions.map(d => (
                          <span key={d.dimensionId} className={d.score == null ? 'text-neutral-400' : d.score >= 60 ? 'text-emerald-700' : 'text-amber-700'}>
                            {d.name} {formatScore(d.score)}
                          </span>
                        ))}
                      </div>
                    )}
                    {r.type === 'scorecard' && (
                      <div className="mt-1 space-y-0.5 text-[11px] leading-relaxed text-neutral-500">
                        {r.formula && <div className="font-mono">{r.formula}</div>}
                        <div>
                          {r.reviewer && <span>{r.reviewer} · </span>}
                          评完 {formatDateTime(r.completedAt ?? r.computedAt)}
                          {r.durationMs != null && <span> · 耗时 {Math.max(1, Math.round(r.durationMs / 1000))}s</span>}
                          {r.profile && <span> · 模板 {r.profile}</span>}
                          {r.coverage != null && <span> · 覆盖度 {Math.round(r.coverage * 100)}%</span>}
                        </div>
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="border-t border-neutral-100 px-4 py-3">
          {error && <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{error}</div>}
          <div className="flex gap-2">
            <textarea
              className="min-h-[3rem] flex-1 resize-y rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-sky-400"
              placeholder="追加一条实验记录（如：参数调优结论 / 失败原因 / 对比观察）…"
              value={text}
              maxLength={10000}
              disabled={posting}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void postNote(); }}
            />
            <div className="flex h-fit shrink-0 flex-col gap-1.5">
              <button
                type="button"
                className="rounded border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-700 hover:bg-sky-100 disabled:opacity-50"
                disabled={posting || !text.trim()}
                onClick={() => void postNote()}
              >
                {posting ? '推送中…' : '添加记录'}
              </button>
              <button
                type="button"
                className={`rounded border px-3 py-1.5 text-xs disabled:opacity-50 ${confirmOverwrite ? 'border-amber-400 text-amber-700 hover:bg-amber-50' : 'border-violet-300 text-violet-700 hover:bg-violet-50'}`}
                disabled={postingScore}
                title="把当前评分卡快照写入记录——已有快照时覆盖（旧快照只留在 git 提交历史里）"
                onClick={() => void postScorecard()}
              >
                {postingScore ? '写入中…' : confirmOverwrite ? '已有快照，确认覆盖？' : '写入评分快照'}
              </button>
            </div>
          </div>
          <div className="mt-1 text-xs text-neutral-300">Ctrl/⌘+Enter 提交</div>
        </div>
      </div>
    </div>
  );
}
