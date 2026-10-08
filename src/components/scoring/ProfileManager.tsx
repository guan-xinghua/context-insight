// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 评分配置 profile 管理（评分模板）：叠在内置评分上的覆盖层——勾选子项、双级权重、维度内自定义项、
// 模板（使用/复制）、导入导出、恢复默认。全局单激活；D7 自定义维度是独立系统（底部入口跳转）。
// 子项清单/默认权重从客户端安全的 definitions 取；模板从 profile/presets 叶子模块取。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoaderIcon, PlusIcon, TrashIcon, DownloadIcon, UploadIcon, CopyIcon, RotateCcwIcon } from 'lucide-react';
import { BUILTIN_DIMENSIONS } from '@/lib/scoring/definitions';
import { PRESETS } from '@/lib/scoring/core/profile/presets';
import { D1_LOCKED_ITEMS, EXCLUDE_DEGRADES } from '@/lib/scoring/core/profile/types';
import type { CustomItemSpec, ScoringProfile } from '@/lib/scoring/core/profile/types';
import { SIGNALS } from '@/lib/scoring/user/rule-scorer';
import type { RuleSpec } from '@/lib/scoring/user/rule-scorer';

const DEFAULT_BANDS = [
  { range: '9-10', label: '优秀', description: '' },
  { range: '7-8', label: '良好', description: '' },
  { range: '5-6', label: '基本达成', description: '' },
  { range: '3-4', label: '明显问题', description: '' },
  { range: '0-2', label: '严重缺陷', description: '' },
];

const COMPARE_OPTIONS: Array<{ value: RuleSpec['compare']; label: string }> = [
  { value: 'exists', label: '存在（≥1 次）' },
  { value: 'absent', label: '不存在（=0 次）' },
  { value: 'gte', label: '≥ 次数/数值' },
  { value: 'lte', label: '≤ 次数/数值' },
  { value: 'eq', label: '= 次数/数值' },
];

const WEIGHTED_DIMS = ['D2', 'D3', 'D4', 'D5', 'D6'] as const;
const DEFAULT_DIM_WEIGHT: Record<string, number> = { D2: 0.15, D3: 0.35, D4: 0.15, D5: 0.15, D6: 0.20 };
const CUSTOM_WEIGHT_REQUIRED = ['D4', 'D5'];
const CUSTOM_WEIGHT_HIDDEN = ['D1', 'D2', 'D6'];
const BUILTIN_ITEM_IDS = new Set(BUILTIN_DIMENSIONS.flatMap(d => d.items.map(i => i.id)));

const slug = (name: string): string => {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (s.length >= 2) return s;
  // CJK/纯符号名剥完是空 → 'custom'：所有此类名字会同 id 互相覆盖（saveProfile
  // 按文件名写）。缀名字短哈希让不同名字稳定不同 id；同名视为用户自己的重复
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `custom-${h.toString(36)}`;
};

const summaryOf = (p: ScoringProfile): string => {
  const parts: string[] = [];
  if (p.excludedItems?.length) parts.push(`勾除 ${p.excludedItems.length} 项`);
  if (p.customItems?.length) parts.push(`自定义 ${p.customItems.length} 项`);
  const dw = Object.keys(p.dimensionWeights ?? {}).length;
  if (dw > 0) parts.push(`维度权重 ×${dw}`);
  const iw = Object.keys(p.itemWeights ?? {}).length;
  if (iw > 0) parts.push(`子项权重 ×${iw}`);
  return parts.length > 0 ? parts.join(' · ') : '空覆盖（等同默认）';
};

export function ProfileManager({ open, onOpenChange, onChanged, onOpenD7 }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 保存/激活/删除后触发（父级强制重算评分卡） */
  onChanged?: () => void;
  onOpenD7?: () => void;
}) {
  const [profiles, setProfiles] = useState<ScoringProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScoringProfile | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/observe/scoring/profiles');
      const data = await res.json() as { profiles?: ScoringProfile[]; activeId?: string | null; warnings?: string[]; error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setProfiles(data.profiles ?? []);
      setActiveId(data.activeId ?? null);
      setWarnings(data.warnings ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
    } finally {
      setLoading(false);
    }
  }, []);

  // setState 放微任务：避免 effect 体内同步 setState（仓库既有模式）
  useEffect(() => {
    if (open) queueMicrotask(() => { void load(); });
  }, [open, load]);

  const save = useCallback(async (profile: ScoringProfile): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fetch('/api/observe/scoring/profiles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const data = await res.json() as { error?: string; warnings?: string[] };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return false; }
      setError(null);
      setNotice(data.warnings && data.warnings.length > 0
        ? `已保存「${profile.name}」——${data.warnings.join('；')}`
        : `已保存「${profile.name}」${activeId === profile.id ? '（生效中，重算后应用）' : ''}`);
      await load();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [load, onChanged, activeId]);

  const activate = useCallback(async (id: string | null) => {
    setBusy(true);
    try {
      const res = await fetch('/api/observe/scoring/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeId: id }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setError(null);
      setNotice(id == null ? '已恢复默认评分模板（重算后生效）' : '已激活（重算后生效）');
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
    } finally {
      setBusy(false);
    }
  }, [load, onChanged]);

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/observe/scoring/profiles?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setError(null);
      setNotice('已删除');
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
    } finally {
      setBusy(false);
    }
  }, [load, onChanged]);

  const exportOne = useCallback((p: ScoringProfile) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `scoring-profile-${p.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`已导出「${p.name}」——在另一环境「导入」即可`);
  }, []);

  const doImport = useCallback(async (file: File) => {
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      if (parsed['schema'] !== 'scoring-profile') { setError('文件格式不对：需要单个 profile JSON（schema: scoring-profile）'); return; }
      const res = await fetch('/api/observe/scoring/profiles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: parsed }),
      });
      const data = await res.json() as { error?: string; warnings?: string[] };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setError(null);
      setNotice(`已导入「${String(parsed['name'])}」${data.warnings?.length ? `——${data.warnings.join('；')}` : ''}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? `文件解析失败：${e.message}` : '文件解析失败');
    } finally {
      setBusy(false);
    }
  }, [load]);

  const duplicate = useCallback(async (source: ScoringProfile) => {
    const base = slug(source.name);
    const unique = profiles.some(p => p.id === base) ? `${base}-${Date.now().toString(36).slice(-4)}` : base;
    const copy: ScoringProfile = { ...structuredClone(source), id: unique, name: `${source.name}（副本）` };
    const ok = await save(copy);
    if (ok) setEditing(copy);
  }, [profiles, save]);

  const createProfile = useCallback(() => {
    setEditing({ schema: 'scoring-profile', version: 1, id: '', name: `我的配置 ${profiles.length + 1}` });
  }, [profiles.length]);

  const activeName = activeId == null
    ? '默认评分模板'
    : PRESETS.find(p => p.id === activeId)?.name ?? profiles.find(p => p.id === activeId)?.name ?? activeId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-5xl w-[92vw] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>评分配置 · 评分模板管理</DialogTitle>
          <DialogDescription>
            profile 是叠在内置评分上的<b>覆盖层（评分模板）</b>：勾选子项参与、改子项/维度权重、加维度内自定义项。
            全局单激活；<b>跨评分模板的总分不可直接比</b>。D7 自定义维度是独立系统（底部入口）。
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-red-500 px-1">{error}</p>}
        {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400 px-1">{notice}</p>}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
            <LoaderIcon className="size-4 animate-spin" /> 加载中...
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="text-muted-foreground">当前生效：</span>
              <Badge variant={activeId == null ? 'gray' : 'blue'} className="px-1.5 py-0 text-[10px]">{activeName}</Badge>
              {warnings.length > 0 && (
                <span className="text-orange-600 dark:text-orange-400">{warnings.join('；')}</span>
              )}
              {activeId != null && (
                <Button variant="ghost" size="sm" className="h-6 text-[11px] gap-1" disabled={busy} onClick={() => void activate(null)}>
                  <RotateCcwIcon className="size-3" /> 恢复默认模板
                </Button>
              )}
            </div>

            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">内置模板</h3>
                <span className="text-[11px] text-muted-foreground">只读，「复制」成自己的可改；「默认全项」= 不激活 profile</span>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                {PRESETS.map(preset => (
                  <div key={preset.id} className={`rounded border px-2.5 py-2 space-y-1.5 ${activeId === preset.id ? 'border-blue-500/60 bg-blue-500/5' : 'border-border'}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{preset.name}</span>
                      {activeId === preset.id && <Badge variant="blue" className="px-1.5 py-0 text-[10px] shrink-0">生效中</Badge>}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{preset.note}</p>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[11px]"
                        disabled={busy || activeId === preset.id}
                        onClick={() => void activate(preset.id)}
                      >
                        使用
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 text-[11px] gap-1" disabled={busy} onClick={() => void duplicate(preset)}>
                        <CopyIcon className="size-3" /> 复制
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">我的配置</h3>
                {editing == null && (
                  <Button variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={createProfile}>
                    <PlusIcon className="size-3.5" /> 新建配置
                  </Button>
                )}
              </div>
              {profiles.length === 0 && editing == null && (
                <p className="text-xs text-muted-foreground py-1">还没有自己的配置——从模板「复制」一份开始改，或新建。</p>
              )}
              {profiles.map(p => (
                <div key={p.id} className={`rounded border px-2.5 py-2 flex items-center gap-2 flex-wrap ${activeId === p.id ? 'border-blue-500/60 bg-blue-500/5' : 'border-border'}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{p.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{p.id}</span>
                      {activeId === p.id && <Badge variant="blue" className="px-1.5 py-0 text-[10px]">生效中</Badge>}
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {summaryOf(p)}{p.note ? ` · ${p.note}` : ''}
                    </p>
                  </div>
                  {activeId !== p.id && (
                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void activate(p.id)}>激活</Button>
                  )}
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing(structuredClone(p))}>编辑</Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => exportOne(p)} title="导出为 JSON 文件">
                    <UploadIcon className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500" disabled={busy} onClick={() => void remove(p.id)}>
                    <TrashIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </section>

            {editing != null && (
              <ProfileEditor
                // key 随 id 换：编辑器草稿 useState(structuredClone(initial)) 只认
                // 首挂载——duplicate 换 editing 对象不换 key 会继续显示旧草稿，
                // 保存写回旧 id
                key={editing.id || 'new'}
                initial={editing}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={async p => { const ok = await save(p); if (ok) setEditing(null); }}
              />
            )}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => fileInput.current?.click()} disabled={busy || loading} title="导入单个 profile JSON（服务端校验）">
            <DownloadIcon className="size-3.5" /> 导入
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) { setNotice(null); void doImport(f); }
              e.target.value = '';
            }}
          />
          <span className="text-border self-stretch w-px" />
          {onOpenD7 && (
            <Button variant="ghost" size="sm" className="gap-1" onClick={onOpenD7} title="D7 自定义维度（独立系统：组管理/启停/试算）">
              管理自定义维度（D7）
            </Button>
          )}
        </div>

        <DialogFooter>
          <p className="text-[10px] text-muted-foreground text-left flex-1">
            保存/激活后需重算评分卡才应用；勾除项不进覆盖度分母（主动不要 ≠ 没数据）；自定义项只出分不出判定。
          </p>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** profile 编辑器：名称备注 / 维度权重 / 每维子项勾选+权重 / 自定义项 */
function ProfileEditor({ initial, busy, onCancel, onSave }: {
  initial: ScoringProfile;
  busy: boolean;
  onCancel: () => void;
  onSave: (p: ScoringProfile) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<ScoringProfile>(structuredClone(initial));
  const [editingCustom, setEditingCustom] = useState<number | 'new' | null>(null);

  const setExcluded = (itemId: string, excluded: boolean) => {
    setDraft(d => {
      const cur = new Set(d.excludedItems ?? []);
      if (excluded) cur.add(itemId); else cur.delete(itemId);
      return { ...d, excludedItems: cur.size > 0 ? [...cur] : undefined };
    });
  };
  const setItemWeight = (itemId: string, w: number | undefined) => {
    setDraft(d => {
      const cur = { ...(d.itemWeights ?? {}) };
      if (w == null) delete cur[itemId]; else cur[itemId] = w;
      return { ...d, itemWeights: Object.keys(cur).length > 0 ? cur : undefined };
    });
  };
  const setDimWeight = (dim: string, w: number | undefined) => {
    setDraft(d => {
      const cur = { ...(d.dimensionWeights ?? {}) };
      if (w == null) delete cur[dim as 'D2']; else cur[dim as 'D2'] = w;
      return { ...d, dimensionWeights: Object.keys(cur).length > 0 ? cur : undefined };
    });
  };
  const upsertCustom = (spec: CustomItemSpec, index: number | 'new') => {
    setDraft(d => {
      const cur = [...(d.customItems ?? [])];
      if (index === 'new') cur.push(spec); else cur[index] = spec;
      return { ...d, customItems: cur };
    });
    setEditingCustom(null);
  };

  const nameOk = draft.name.trim().length > 0 && draft.name.length <= 40;
  const customIds = new Set((draft.customItems ?? []).map(c => c.id));

  return (
    <div className="rounded border border-border space-y-3 px-3 py-3">
      <div className="grid grid-cols-[1fr_1.6fr] gap-2">
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">配置名称</span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="如：算子严格版"
          />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">备注（可选）</span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            value={draft.note ?? ''}
            onChange={e => setDraft(d => ({ ...d, note: e.target.value || undefined }))}
            placeholder="这套评分模板给什么场景用"
          />
        </label>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">
          维度权重（留空 = 默认；引擎归一化，不必凑 100%）
        </span>
        <div className="grid grid-cols-5 gap-2">
          {WEIGHTED_DIMS.map(dim => (
            <label key={dim} className="text-[11px] space-y-0.5">
              <span className="text-muted-foreground font-mono">
                {dim}（默认 {Math.round((DEFAULT_DIM_WEIGHT[dim] ?? 0) * 100)}%）
              </span>
              <input
                type="number"
                min="0"
                step="0.05"
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono"
                value={draft.dimensionWeights?.[dim] ?? ''}
                placeholder="默认"
                onChange={e => setDimWeight(dim, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">子项勾选与权重（勾除 = 整条退出评分，不进覆盖度分母）</span>
        {BUILTIN_DIMENSIONS.map(dim => {
          const excluded = new Set(draft.excludedItems ?? []);
          const lockedCount = dim.items.filter(i => (D1_LOCKED_ITEMS as readonly string[]).includes(i.id)).length;
          return (
            <details key={dim.id} className="rounded border border-border/70 px-2.5 py-1.5">
              <summary className="cursor-pointer select-none text-xs flex items-center gap-2 flex-wrap">
                <span className="font-mono text-muted-foreground">{dim.id}</span>
                <span className="font-medium">{dim.name}</span>
                {dim.role === 'veto' && <Badge variant="orange" className="px-1.5 py-0 text-[10px]">否决维</Badge>}
                <span className="text-[11px] text-muted-foreground">
                  {dim.items.filter(i => !excluded.has(i.id)).length}/{dim.items.length} 项参与
                  {lockedCount > 0 ? ` · ${lockedCount} 项固定` : ''}
                </span>
              </summary>
              <div className="mt-1.5 space-y-1 pl-1">
                {dim.items.map(item => {
                  const locked = (D1_LOCKED_ITEMS as readonly string[]).includes(item.id);
                  const isExcluded = excluded.has(item.id);
                  const degrade = isExcluded ? EXCLUDE_DEGRADES[item.id] : undefined;
                  return (
                    <div key={item.id} className="space-y-0.5">
                      <div className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="shrink-0"
                          checked={!isExcluded}
                          disabled={locked}
                          title={locked ? 'D1 否决证据链固定项，不可勾除' : undefined}
                          onChange={e => setExcluded(item.id, !e.target.checked)}
                        />
                        <span className={`truncate ${isExcluded ? 'text-muted-foreground line-through' : ''}`}>{item.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground shrink-0">{item.id}</span>
                        {!isExcluded && (
                          <input
                            type="number"
                            min="0"
                            step="0.05"
                            className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-mono ml-auto shrink-0"
                            value={draft.itemWeights?.[item.id] ?? ''}
                            placeholder={item.weight != null ? `默认 ${item.weight}` : '等权'}
                            onChange={e => setItemWeight(item.id, e.target.value === '' ? undefined : Number(e.target.value))}
                          />
                        )}
                      </div>
                      {degrade && <p className="text-[10px] text-orange-600 dark:text-orange-400 pl-5">{degrade}</p>}
                    </div>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">维度内自定义项（只出分不出判定）</span>
          {editingCustom == null && (
            <Button variant="ghost" size="sm" className="h-6 text-[11px] gap-1" onClick={() => setEditingCustom('new')}>
              <PlusIcon className="size-3" /> 加一项
            </Button>
          )}
        </div>
        {(draft.customItems ?? []).map((c, i) => (
          <div key={c.id} className="rounded border border-border/70 bg-card/40 px-2.5 py-1.5 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium truncate">{c.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{c.id}</span>
                <Badge variant={c.kind === 'rule' ? 'purple' : 'outline'} className="px-1.5 py-0 text-[10px]">{c.kind === 'rule' ? '规则' : 'LLM'}</Badge>
                {CUSTOM_WEIGHT_HIDDEN.includes(c.targetDimension) && (
                  <Badge variant="gray" className="px-1.5 py-0 text-[10px]">
                    {c.targetDimension === 'D1' ? '进完成度均值' : '只展示'}
                  </Badge>
                )}
                {c.weight != null && <Badge variant="blue" className="px-1.5 py-0 text-[10px]">权重 {c.weight}</Badge>}
              </div>
              {c.note && <p className="text-[10px] text-muted-foreground truncate">{c.note}</p>}
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditingCustom(i)}>编辑</Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-red-500"
              onClick={() => setDraft(d => ({ ...d, customItems: (d.customItems ?? []).filter((_, j) => j !== i) }))}
            >
              <TrashIcon className="size-3.5" />
            </Button>
          </div>
        ))}
        {editingCustom != null && (
          <CustomItemEditor
            initial={editingCustom === 'new' ? null : (draft.customItems ?? [])[editingCustom] ?? null}
            existingIds={[...customIds].filter(id => editingCustom === 'new' || id !== (draft.customItems ?? [])[editingCustom]?.id)}
            onCancel={() => setEditingCustom(null)}
            onSave={spec => upsertCustom(spec, editingCustom as number | 'new')}
          />
        )}
      </div>

      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" disabled={!nameOk || busy} onClick={() => void onSave({ ...draft, id: draft.id || slug(draft.name) })}>
          保存
        </Button>
      </div>
    </div>
  );
}

/** 自定义项编辑器：目标维度决定聚合方式与权重规则（D4/D5 必填、D3 可选、D1/D2/D6 无权重） */
function CustomItemEditor({ initial, existingIds, onCancel, onSave }: {
  initial: CustomItemSpec | null;
  existingIds: string[];
  onCancel: () => void;
  onSave: (spec: CustomItemSpec) => void;
}) {
  const [draft, setDraft] = useState<CustomItemSpec>(
    initial
      ? structuredClone(initial)
      : { id: '', targetDimension: 'D3', name: '', kind: 'llm', bands: DEFAULT_BANDS.map(b => ({ ...b })) },
  );

  const setBands = (i: number, description: string) => {
    setDraft(d => ({ ...d, bands: d.bands?.map((b, j) => (j === i ? { ...b, description } : b)) }));
  };
  const isRule = draft.kind === 'rule';
  const rule = draft.rule ?? { signal: 'command', compare: 'exists' as const };
  const setRule = (patch: Partial<RuleSpec>) => setDraft(d => ({ ...d, rule: { ...(d.rule ?? rule), ...patch } }));

  const idPreview = `${draft.targetDimension}.${slug(draft.name)}`;
  const idTaken = BUILTIN_ITEM_IDS.has(idPreview)
    || existingIds.some(id => id.split('.')[1] === slug(draft.name))
    || (initial != null && draft.name.trim() === initial.name && idPreview !== initial.id && BUILTIN_ITEM_IDS.has(idPreview));

  let regexOk = true;
  if (isRule && rule.filter) { try { new RegExp(rule.filter, 'i'); } catch { regexOk = false; } }
  const thresholdOk = rule.compare === 'exists' || rule.compare === 'absent' || typeof rule.threshold === 'number';
  const ruleReady = !!rule.signal && thresholdOk && regexOk;
  const isBinary = draft.kind === 'binary';
  const llmReady = (draft.bands ?? []).every(b => b.description.trim().length >= 4);
  const binaryReady = (draft.note ?? '').trim().length >= 4;
  const weightRequired = CUSTOM_WEIGHT_REQUIRED.includes(draft.targetDimension);
  const weightOk = !weightRequired || (draft.weight != null && draft.weight > 0);
  const saveReady = draft.name.trim().length > 0 && draft.name.length <= 40
    && !idTaken && weightOk && (isRule ? ruleReady : isBinary ? binaryReady : llmReady);

  // 灰按钮不说原因 = 用户猜谜（每档标准填「1」这种常见）；把不满足的条件直接列出来
  const problems: string[] = [];
  if (draft.name.trim().length === 0) problems.push('名称必填');
  if (draft.name.length > 40) problems.push('名称超 40 字');
  if (!weightOk) problems.push('该维度的维度内权重必填且大于 0');
  if (isRule) {
    if (!rule.signal) problems.push('规则信号必选');
    if (!thresholdOk) problems.push('阈值无效');
    if (!regexOk) problems.push('过滤正则写错了');
  } else if (isBinary) {
    if (!binaryReady) problems.push('判定标准至少 4 字——写明白什么算「达成」（达成 1 分 / 未达成 0 分 / 判不了不扣分）');
  } else {
    const short = (draft.bands ?? []).filter(b => b.description.trim().length < 4);
    if (short.length > 0) problems.push(`每档标准至少 4 字（${short.map(b => b.range).join('、')} 档还太短）——这是给评审的判卷标准，写明白什么样算这一档`);
  }
  const bandTooShort = (s: string) => !isRule && !isBinary && s.trim().length < 4;

  return (
    <div className="rounded border border-border bg-muted/20 space-y-2 px-2.5 py-2">
      <div className="grid grid-cols-[1fr_1.2fr_1.6fr] gap-2">
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">目标维度</span>
          <select
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
            value={draft.targetDimension}
            onChange={e => setDraft(d => ({ ...d, targetDimension: e.target.value as CustomItemSpec['targetDimension'] }))}
          >
            {BUILTIN_DIMENSIONS.map(d => <option key={d.id} value={d.id}>{d.id} {d.name}</option>)}
          </select>
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">名称（决定 id：{idPreview}）</span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="如：文档同步"
          />
        </label>
        {!isBinary && (
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">一句话评什么（可选）</span>
            <input
              className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
              value={draft.note ?? ''}
              onChange={e => setDraft(d => ({ ...d, note: e.target.value || undefined }))}
              placeholder="如：改代码的同时有没有更新文档"
            />
          </label>
        )}
      </div>
      {idTaken && <p className="text-[11px] text-red-500 px-1">id「{idPreview}」与内置子项或已有自定义项冲突，换个名字</p>}

      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">类型</span>
        {([['llm', 'LLM 评分（五档）'], ['binary', '两档判定（是/否）'], ['rule', '规则判定（零 LLM）']] as const).map(([k, label]) => (
          <label key={k} className="flex items-center gap-1 cursor-pointer">
            <input type="radio" checked={draft.kind === k} onChange={() => setDraft(d => ({ ...d, kind: k }))} />
            {label}
          </label>
        ))}
        <span className="text-muted-foreground ml-auto">
          {draft.targetDimension === 'D1' && '进完成度分均值'}
          {draft.targetDimension === 'D2' && '只展示（判定驱动维度）'}
          {draft.targetDimension === 'D6' && '只展示（次数驱动维度）'}
        </span>
        {!CUSTOM_WEIGHT_HIDDEN.includes(draft.targetDimension) && (
          <label className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">维度内权重{weightRequired ? '（必填）' : '（可选，默认等权）'}</span>
            <input
              type="number"
              min="0"
              step="0.05"
              className="w-20 rounded border border-border bg-background px-2 py-0.5 text-xs font-mono"
              value={draft.weight ?? ''}
              placeholder={weightRequired ? '如 0.1' : '等权'}
              onChange={e => setDraft(d => ({ ...d, weight: e.target.value === '' ? undefined : Number(e.target.value) }))}
            />
          </label>
        )}
      </div>

      {isRule ? (
        <div className="space-y-2 rounded border border-border/70 bg-muted/20 px-2.5 py-2">
          <div className="grid grid-cols-[1.4fr_1fr_0.9fr_0.5fr] gap-2">
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">信号（在哪数）</span>
              <select
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                value={rule.signal}
                onChange={e => setRule({ signal: e.target.value })}
              >
                {Object.entries(SIGNALS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
              </select>
            </label>
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">过滤（正则，可选）</span>
              <input
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono"
                value={rule.filter ?? ''}
                onChange={e => setRule({ filter: e.target.value || undefined })}
                placeholder={SIGNALS[rule.signal]?.filterHint}
              />
            </label>
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">比较</span>
              <select
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                value={rule.compare}
                onChange={e => setRule({ compare: e.target.value as RuleSpec['compare'] })}
              >
                {COMPARE_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">阈值</span>
              <input
                type="number"
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono disabled:opacity-40"
                value={rule.threshold ?? ''}
                disabled={rule.compare === 'exists' || rule.compare === 'absent'}
                onChange={e => setRule({ threshold: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </label>
          </div>
        </div>
      ) : isBinary ? (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">判定标准（是非题：达成 1 分 / 未达成 0 分 / 判不了不扣分——写明白什么算「达成」）</span>
          <textarea
            className={`w-full rounded border bg-background px-2 py-1 text-xs ${binaryReady ? 'border-border' : 'border-red-400'}`}
            rows={2}
            value={draft.note ?? ''}
            onChange={e => setDraft(d => ({ ...d, note: e.target.value || undefined }))}
            placeholder="如：设计变更同步更新到 docs/ 下的设计文档（只建文件不算，要有实质内容更新）"
          />
        </div>
      ) : (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">每档标准（大白话写明白什么样算这一档）</span>
          {(draft.bands ?? []).map((b, i) => (
            <div key={b.range} className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground w-10 shrink-0">{b.range}</span>
              <span className="text-[11px] w-16 shrink-0">{b.label}</span>
              <input
                className={`flex-1 rounded border bg-background px-2 py-1 text-xs ${bandTooShort(b.description) ? 'border-red-400' : 'border-border'}`}
                value={b.description}
                onChange={e => setBands(i, e.target.value)}
                placeholder={`${b.label}：什么样算这一档`}
              />
            </div>
          ))}
        </div>
      )}

      {!saveReady && problems.length > 0 && (
        <p className="text-[11px] text-red-500 px-1">还不能保存：{problems.join('；')}</p>
      )}

      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button
          size="sm"
          disabled={!saveReady}
          onClick={() => onSave({
            ...draft,
            id: initial?.id ?? idPreview,
            ...(CUSTOM_WEIGHT_HIDDEN.includes(draft.targetDimension) ? { weight: undefined } : {}),
          })}
        >
          保存自定义项
        </Button>
      </div>
    </div>
  );
}
