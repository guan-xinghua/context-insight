// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// D7 用户自定义维度管理（组模型 + 双类型）：一个组 = 一套标准，组内维度一条条增删改；
// 组可启停（停用只留存不参评）。维度两种类型——
//   LLM 评分：写名称 + 每档大白话，平台组装评审；
//   规则判定：声明「信号 × 比较」（零 LLM 零成本，证据带轮次）。
// 支持一键导出/导入（合并或替换）与「在本会话试算」（规则即时出，LLM 真调一次）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoaderIcon, PlusIcon, TrashIcon, DownloadIcon, UploadIcon, FlaskConicalIcon } from 'lucide-react';
import { SIGNALS } from '@/lib/scoring/user/rule-scorer';   // 叶子模块（无 node:fs）——客户端组件禁走服务端 barrel
import { loadProviderConfig } from '@/lib/ai-provider-config';
import type { RuleSpec } from '@/lib/scoring/user/rule-scorer';
import type { UserDimensionFile, UserGroup } from '@/lib/scoring/user/loader';
import type { SubItemResult } from '@/lib/scoring/definitions';

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

const slug = (name: string): string => {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s.length >= 2 ? s : 'custom';
};

const emptyDim = (): UserDimensionFile => ({ id: '', name: '', kind: 'llm', bands: DEFAULT_BANDS.map(b => ({ ...b })), includeInTotal: false });

export function UserDimensionManager({ open, onOpenChange, onChanged, taskId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
  /** 有值时编辑器可用「在本会话试算」 */
  taskId?: string;
}) {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ groupId: string; dim: UserDimensionFile } | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/observe/scoring/user-definitions');
      const data = await res.json() as { groups?: UserGroup[]; error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setGroups(data.groups ?? []);
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

  const saveGroup = useCallback(async (group: UserGroup): Promise<boolean> => {
    try {
      const res = await fetch('/api/observe/scoring/user-definitions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return false; }
      setError(null);
      await load();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
      return false;
    }
  }, [load, onChanged]);

  const removeGroup = useCallback(async (id: string) => {
    await fetch(`/api/observe/scoring/user-definitions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const saveDim = useCallback(async (groupId: string, dim: UserDimensionFile): Promise<boolean> => {
    const group = groups.find(g => g.id === groupId);
    if (!group) { setError('所属组不存在（可能已被删除），刷新后重试'); return false; }
    const exists = group.dimensions.some(d => d.id === dim.id);
    const next: UserGroup = {
      ...group,
      dimensions: exists ? group.dimensions.map(d => (d.id === dim.id ? dim : d)) : [...group.dimensions, dim],
    };
    return saveGroup(next);
  }, [groups, saveGroup]);

  const removeDim = useCallback(async (groupId: string, dimId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    await saveGroup({ ...group, dimensions: group.dimensions.filter(d => d.id !== dimId) });
  }, [groups, saveGroup]);

  const toggleEnabled = useCallback(async (group: UserGroup) => {
    await saveGroup({ ...group, enabled: !(group.enabled !== false) });
  }, [saveGroup]);

  const doExport = useCallback(() => {
    const bundle = { schema: 'workflow-user-dimension-groups' as const, version: 1 as const, exportedAt: new Date().toISOString(), groups };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `user-dimension-groups-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`已导出 ${groups.length} 个组（${groups.reduce((s2, g) => s2 + g.dimensions.length, 0)} 条维度）——在另一环境「导入」即合并进来`);
  }, [groups]);

  const doImport = useCallback(async (file: File, mode: 'merge' | 'replace') => {
    try {
      const parsed = JSON.parse(await file.text()) as { groups?: unknown } | unknown[];
      const incoming = Array.isArray(parsed) ? parsed : parsed?.groups;
      if (!Array.isArray(incoming)) { setError('文件格式不对：需要 { groups: [...] } 或组数组'); return; }
      const res = await fetch('/api/observe/scoring/user-definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: incoming, mode }),
      });
      const data = await res.json() as { summary?: { addedGroups: number; mergedGroups: number; addedDims: number; skippedDims: number; invalidGroups: number }; error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setError(null);
      const sm = data.summary!;
      setNotice(`导入完成（${mode === 'replace' ? '替换' : '合并'}）：新建 ${sm.addedGroups} 组 · 并入 ${sm.mergedGroups} 组 · 新增 ${sm.addedDims} 条维度 · 跳过 ${sm.skippedDims} 条 · 无效 ${sm.invalidGroups} 组`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? `文件解析失败：${e.message}` : '文件解析失败');
    }
  }, [load, onChanged]);

  const createGroup = useCallback(async () => {
    const name = `自定义组 ${groups.length + 1}`;
    const base = slug(name) === 'custom' ? `group-${Date.now().toString(36).slice(-6)}` : slug(name);
    const unique = groups.some(g => g.id === base) ? `${base}-${Date.now().toString(36).slice(-4)}` : base;
    await saveGroup({ id: unique, name, dimensions: [] });
    setEditingGroup(unique);
  }, [groups, saveGroup]);

  /** 试算：把当前草稿对 taskId 会话立即跑一次（规则即时出，LLM 用页面配置真调） */
  const tryDraft = useCallback(async (draft: UserDimensionFile): Promise<SubItemResult | null> => {
    if (!taskId) return null;
    try {
      const cfg = loadProviderConfig();
      const res = await fetch('/api/observe/scoring/user-definitions/try', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          dimension: draft.id ? draft : { ...draft, id: slug(draft.name) },
          ...(draft.kind !== 'rule' && cfg?.apiKey && cfg?.baseUrl && cfg?.model ? { provider: cfg } : {}),
        }),
      });
      const data = await res.json() as { result?: SubItemResult; error?: string };
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return null; }
      setError(null);
      return data.result ?? null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
      return null;
    }
  }, [taskId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-5xl w-[92vw] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>自定义评分维度（D7）· 按组管理</DialogTitle>
          <DialogDescription>
            一个组 = 一套标准，组内维度一条条增加 / 删除 / 修改。维度两种类型：<b>规则判定</b>（声明「信号 × 比较」，零 LLM，
            证据带轮次）与 <b>LLM 评分</b>（写每档大白话，平台组装评审）。停用的组只留存不参评。
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-red-500 px-1">{error}</p>}
        {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400 px-1">{notice}</p>}
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
            <LoaderIcon className="size-4 animate-spin" /> 加载中...
          </div>
        ) : (
          <div className="space-y-2">
            {groups.length === 0 && (
              <p className="text-xs text-muted-foreground py-2">还没有自定义组。新建一个组，往里加维度。</p>
            )}
            {groups.map(g => {
              const enabled = g.enabled !== false;
              return (
                <div key={g.id} className={`rounded border px-3 py-2 space-y-2 ${enabled ? 'border-border' : 'border-border/60 opacity-75'}`}>
                  {editingGroup === g.id ? (
                    <GroupEditor
                      initial={g}
                      onCancel={() => setEditingGroup(null)}
                      onSave={async next => { const ok = await saveGroup(next); if (ok) setEditingGroup(null); }}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={enabled}
                        title={enabled ? '参评中（取消勾选 = 停用，只留存不参评）' : '已停用（勾选 = 恢复参评）'}
                        onChange={() => void toggleEnabled(g)}
                        className="shrink-0"
                      />
                      <span className="text-sm font-medium truncate">{g.name}</span>
                      <Badge variant={enabled ? 'blue' : 'gray'} className="px-1.5 py-0 text-[10px] shrink-0">
                        {enabled ? '参评中' : '已停用'}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground shrink-0">{g.dimensions.length} 条维度</span>
                      {g.description && <span className="text-[11px] text-muted-foreground truncate flex-1">{g.description}</span>}
                      <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={() => setEditingGroup(g.id)}>编辑组</Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500 shrink-0" onClick={() => void removeGroup(g.id)}>
                        <TrashIcon className="size-3.5" />
                      </Button>
                    </div>
                  )}

                  {g.dimensions.length > 0 && (
                    <div className="space-y-1 pl-6">
                      {g.dimensions.map(d => (
                        <div key={d.id} className="rounded border border-border/70 bg-card/40 px-2.5 py-1.5 flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium truncate">{d.name}</span>
                              <span className="font-mono text-[10px] text-muted-foreground">{d.id}</span>
                              <Badge variant={d.kind === 'rule' ? 'purple' : 'outline'} className="px-1.5 py-0 text-[10px]">
                                {d.kind === 'rule' ? '规则' : 'LLM'}
                              </Badge>
                              {d.includeInTotal
                                ? <Badge variant="blue" className="px-1.5 py-0 text-[10px]">进总分</Badge>
                                : <Badge variant="gray" className="px-1.5 py-0 text-[10px]">只展示</Badge>}
                            </div>
                            <p className="text-[10px] text-muted-foreground truncate">
                              {d.kind === 'rule' && d.rule
                                ? `${SIGNALS[d.rule.signal]?.label ?? d.rule.signal}${d.rule.filter ? ` · 过滤 ${d.rule.filter}` : ''} · ${COMPARE_OPTIONS.find(c => c.value === d.rule!.compare)?.label ?? d.rule.compare}${d.rule.threshold != null ? ` ${d.rule.threshold}` : ''}`
                                : `${d.bands?.length ?? 0} 档标准${d.description ? ` · ${d.description}` : ''}`}
                            </p>
                          </div>
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing({ groupId: g.id, dim: d })}>编辑</Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500" onClick={() => void removeDim(g.id, d.id)}>
                            <TrashIcon className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {g.dimensions.length === 0 && (
                    <p className="text-[11px] text-muted-foreground pl-6">组内还没有维度。</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {editing ? (
          <Editor
            initial={editing.dim}
            taskId={taskId}
            onTry={tryDraft}
            onCancel={() => setEditing(null)}
            onSave={async d => { const ok = await saveDim(editing.groupId, d); if (ok) setEditing(null); }}
          />
        ) : (
          <Button variant="outline" size="sm" className="gap-1" onClick={() => {
            const firstEnabled = groups.find(g => g.enabled !== false);
            if (!firstEnabled) { setError('先新建一个组，再往里加维度'); return; }
            setEditing({ groupId: firstEnabled.id, dim: emptyDim() });
          }}>
            <PlusIcon className="size-3.5" /> 新建维度
          </Button>
        )}

        {pendingImport && (
          <div className="rounded border border-blue-500/40 bg-blue-500/10 px-3 py-2 space-y-2">
            <p className="text-xs font-medium">导入「{pendingImport.name}」——选一种方式：</p>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { const f = pendingImport; setPendingImport(null); void doImport(f, 'merge'); }}>
                合并导入（推荐）
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs text-red-500" onClick={() => { const f = pendingImport; setPendingImport(null); void doImport(f, 'replace'); }}>
                替换导入
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPendingImport(null)}>取消</Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              合并 = 保留本地已有定义，只补缺失的组和维度；替换 = <span className="text-red-500">清空本地全部自定义组</span>，以文件为准。
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => void createGroup()}>
            <PlusIcon className="size-3.5" /> 新建组
          </Button>
          <span className="text-border self-stretch w-px" />
          <Button variant="ghost" size="sm" className="gap-1" onClick={doExport} disabled={groups.length === 0} title="全部组导出为一份 JSON——换环境导入即合并">
            <UploadIcon className="size-3.5" /> 导出全部
          </Button>
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => fileInput.current?.click()} title="导入组 JSON（合并或替换）">
            <DownloadIcon className="size-3.5" /> 导入
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) { setNotice(null); setPendingImport(f); }
              e.target.value = '';   // 同名文件可重复导入
            }}
          />
        </div>

        <DialogFooter>
          <p className="text-[10px] text-muted-foreground text-left flex-1">
            注意：两个 session 用了不同的自定义维度时总分口径不同，横向对比要留意——这也是维度默认不进总分的原因。
          </p>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 组名 / 描述编辑（启停在组头部的 checkbox 上） */
function GroupEditor({ initial, onCancel, onSave }: {
  initial: UserGroup;
  onCancel: () => void;
  onSave: (g: UserGroup) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<UserGroup>({ ...initial });
  return (
    <div className="rounded border border-border bg-muted/30 space-y-2 px-2.5 py-2">
      <div className="grid grid-cols-[1fr_1.4fr] gap-2">
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">组名</span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="如：文档质量组"
          />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">组说明（可选）</span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            value={draft.description ?? ''}
            onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
            placeholder="这组标准给什么场景用"
          />
        </label>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" disabled={!draft.name.trim()} onClick={() => void onSave(draft)}>保存</Button>
      </div>
    </div>
  );
}

/** 维度编辑器：类型切换（LLM 评分 / 规则判定）+ 对应表单 + 在本会话试算 */
function Editor({ initial, taskId, onTry, onCancel, onSave }: {
  initial: UserDimensionFile;
  taskId?: string;
  onTry: (draft: UserDimensionFile) => Promise<SubItemResult | null>;
  onCancel: () => void;
  onSave: (d: UserDimensionFile) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<UserDimensionFile>({
    ...initial,
    kind: initial.kind ?? 'llm',
    bands: (initial.bands ?? DEFAULT_BANDS).map(b => ({ ...b })),
    rule: initial.rule ?? { signal: 'command', compare: 'exists' },
  });
  const [trying, setTrying] = useState(false);
  const [tryResult, setTryResult] = useState<SubItemResult | null>(null);

  const setBand = (i: number, description: string) => {
    setDraft(d => ({ ...d, bands: d.bands?.map((b, j) => (j === i ? { ...b, description } : b)) }));
  };

  const isRule = draft.kind === 'rule';
  const rule = draft.rule ?? { signal: 'command', compare: 'exists' as const };
  const setRule = (patch: Partial<RuleSpec>) => setDraft(d => ({ ...d, rule: { ...(d.rule ?? rule), ...patch } }));

  let regexOk = true;
  if (isRule && rule.filter) { try { new RegExp(rule.filter, 'i'); } catch { regexOk = false; } }
  const thresholdOk = rule.compare === 'exists' || rule.compare === 'absent' || typeof rule.threshold === 'number';
  const ruleReady = isRule && !!rule.signal && thresholdOk && regexOk;
  const llmReady = !isRule && (draft.bands ?? []).every(b => b.description.trim().length >= 4);
  const saveReady = !!draft.name.trim() && (isRule ? ruleReady : llmReady);

  /** 规则公式实时预览（保存前就能看到判定会长什么样） */
  const rulePreview = isRule
    ? `${SIGNALS[rule.signal]?.label ?? rule.signal}：${rule.filter ? `过滤「${rule.filter}」· ` : ''}${COMPARE_OPTIONS.find(c => c.value === rule.compare)?.label ?? ''}${rule.threshold != null ? ` ${rule.threshold}` : ''} → 通过 / 未通过`
    : '';

  return (
    <div className="rounded border border-border space-y-2 px-3 py-3">
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">维度名称（如「文档更新及时性」）</span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="维度名称"
          />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">一句话评什么（可选）</span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            value={draft.description ?? ''}
            onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
            placeholder="如：改代码的同时有没有更新相关文档"
          />
        </label>
      </div>

      {/* 类型切换 */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">类型</span>
        {([['llm', 'LLM 评分'], ['rule', '规则判定（零 LLM）']] as const).map(([k, label]) => (
          <label key={k} className="flex items-center gap-1 cursor-pointer">
            <input type="radio" checked={(draft.kind ?? 'llm') === k} onChange={() => setDraft(d => ({ ...d, kind: k }))} />
            {label}
          </label>
        ))}
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
          <p className="text-[11px] text-muted-foreground">{rulePreview}</p>
        </div>
      ) : (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">每档标准（大白话写明白什么样算这一档）</span>
          {(draft.bands ?? []).map((b, i) => (
            <div key={b.range} className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground w-10 shrink-0">{b.range}</span>
              <span className="text-[11px] w-16 shrink-0">{b.label}</span>
              <input
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
                value={b.description}
                onChange={e => setBand(i, e.target.value)}
                placeholder={`${b.label}：什么样算这一档`}
              />
            </div>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={draft.includeInTotal === true}
          onChange={e => setDraft(d => ({ ...d, includeInTotal: e.target.checked }))}
        />
        进总分（默认不进：规则型通过=100 / 未通过=0；LLM 型按档位折算）
      </label>

      {/* 试算结果 */}
      {tryResult && (
        <div className="rounded border border-border bg-muted/30 px-2.5 py-2 space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <FlaskConicalIcon className="size-3.5 text-blue-500" />
            <span className="font-medium">本会话试算</span>
            {tryResult.verdict && <Badge variant={tryResult.verdict === 'pass' ? 'green' : tryResult.verdict === 'fail' ? 'red' : 'secondary'}>{tryResult.verdict === 'pass' ? '通过' : tryResult.verdict === 'fail' ? '未通过' : tryResult.verdict}</Badge>}
            {tryResult.status === 'not-applicable' && <Badge variant="gray">无法评判</Badge>}
            {tryResult.status === 'error' && <Badge variant="red">错误</Badge>}
            {typeof tryResult.score === 'number' && <span className="font-mono">{Math.round(tryResult.score * 100)}</span>}
          </div>
          {tryResult.formula && <p className="text-[11px] font-mono break-all">{tryResult.formula}</p>}
          {tryResult.evidence.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              证据：{tryResult.evidence.map(e => `§${e.turnIndex ?? '—'} ${e.label}`).join('；')}
            </p>
          )}
          {tryResult.note && <p className="text-[10px] text-muted-foreground">{tryResult.note}</p>}
          {tryResult.error && <p className="text-[10px] text-red-500">{tryResult.error.message}</p>}
        </div>
      )}

      <div className="flex items-center gap-2 justify-end">
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={!saveReady || !taskId || trying}
          title={taskId ? '对当前会话立即跑一次这条维度（规则即时出；LLM 真调一次评审）' : '仅在 Session 的 Score 页内可用'}
          onClick={async () => { setTrying(true); setTryResult(await onTry(draft)); setTrying(false); }}
        >
          {trying ? <LoaderIcon className="size-3.5 animate-spin" /> : <FlaskConicalIcon className="size-3.5" />}
          在本会话试算
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button
          size="sm"
          disabled={!saveReady}
          onClick={() => {
            const id = draft.id || slug(draft.name);
            void onSave({ ...draft, id });
          }}
        >
          保存
        </Button>
      </div>
    </div>
  );
}
