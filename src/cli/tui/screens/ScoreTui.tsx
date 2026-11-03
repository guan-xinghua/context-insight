// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS OR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// mate 评分 TUI：选来源（本机库 / 目录）→ 选 agent 工具 → 实时进度 → 评分展示。
// 目录路径与 insight 导入页同思路：常用 agent 默认目录快捷项 + 手动输入；目录内
// session 自动扫描（jsonl/sqlite 两族，注册表单点），支持全选/单选/多选批量
// 「导入 + 评分」。与一次性 CLI 共用 runMateScoreFlow（同一执行流、同一事件词汇），
// 直接读本机库，不需要 insight 服务进程。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { prisma } from '@/lib/db';
import { detectMateAgentTools, DIM_NAMES, type MateAgentTool } from '@/lib/scoring/mate-agent/runner';
import { runMateScoreFlow, type ScoreEvent } from '@/cli/commands/score';
import { Spinner } from '@/cli/tui/components/Spinner';
import { TextInput } from '@/cli/tui/components/TextInput';
import { SOURCE_FAMILIES, getSource } from '@/lib/ingest/adapters/registry';
import { importSession } from '@/lib/ingest/data-service';
import type { Scorecard, DimensionResult, SubItemResult } from '@/lib/scoring';

interface SessionRow {
  taskId: string;
  framework: string;
  startTime: Date;
  totalTokens: number;
  totalSubagentCount: number;
  query: string | null;
}

interface DirSessionRow {
  id: string;
  source: string;
  filePath: string;
  framework: string | null;
  createdAt: string;
  turnCount: number;
  modelName: string | null;
  firstQuery: string | null;
}

interface BatchResult {
  taskId: string;
  card: Scorecard | null;
  error: string | null;
  durationMs: number;
}

type Stage =
  | 'source' | 'session' | 'tool'
  | 'dir' | 'dirSessions'
  | 'running' | 'result' | 'summary' | 'detail' | 'error';

export interface ScoreTuiProps {
  initialSession?: { taskId: string; framework?: string | null };
  concurrency?: number;
  timeoutMs?: number;
  workdir?: string;
  /** jsonl 保存目录（缺省当前目录） */
  saveDir?: string;
}

const VIEW_ROWS = 12;

function padEndV(str: string, width: number): string {
  const w = stringWidth(str);
  return w >= width ? str : str + ' '.repeat(width - w);
}
function truncV(str: string, maxWidth: number): string {
  if (stringWidth(str) <= maxWidth) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** MM-DD HH:mm（列表列宽友好；跨年才需要年份，会话列表按时间倒序基本同年） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 常用 agent 默认目录快捷项（导入页同思路）：存在才列出 */
function quickDirs(): Array<{ label: string; dir: string }> {
  const home = os.homedir();
  const candidates = [
    { label: 'Claude Code 原生会话', dir: path.join(home, '.claude', 'projects') },
    { label: 'opencode 会话', dir: path.join(home, '.config', 'opencode') },
    { label: 'Codex 会话', dir: path.join(home, '.codex', 'sessions') },
    { label: '用户主目录', dir: home },
    { label: '当前目录', dir: process.cwd() },
  ];
  return candidates.filter(c => {
    try { return existsSync(c.dir); } catch { return false; }
  });
}

const scoreColor = (score: number): string =>
  score >= 0.8 ? 'green' : score >= 0.6 ? 'yellow' : 'red';

function Bar10({ score }: { score: number }) {
  const filled = Math.max(0, Math.min(10, Math.round(score * 10)));
  return (
    <Text>
      <Text color={scoreColor(score)}>{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(10 - filled)}</Text>
    </Text>
  );
}

function ItemLine({ it }: { it: SubItemResult }) {
  const icon = it.status === 'ok' ? '✓' : it.status === 'not-applicable' ? '○' : '✗';
  const iconColor = it.status === 'ok' ? 'green' : it.status === 'not-applicable' ? 'gray' : 'red';
  const parts: string[] = [];
  if (it.value !== undefined && it.value !== null) parts.push(String(it.value));
  if (typeof it.score === 'number') parts.push(`${(it.score * 10).toFixed(1)}分`);
  if (it.verdict) parts.push(it.verdict);
  if (it.note) parts.push(truncV(it.note, 36));
  return (
    <Text>
      <Text>  </Text>
      <Text color={iconColor}>{icon}</Text>
      <Text> {padEndV(truncV(it.label, 22), 22)}  </Text>
      <Text color="gray">{parts.join(' · ') || '—'}</Text>
    </Text>
  );
}

function DimBlock({ dim }: { dim: DimensionResult }) {
  const head = (
    <Text>
      <Text bold>{dim.dimensionId}</Text>
      <Text> {padEndV(truncV(dim.name, 8), 9)}</Text>
    </Text>
  );
  let line: React.ReactNode;
  if (dim.status === 'not-applicable') line = <Text color="gray">不适用</Text>;
  else if (dim.status === 'error') line = <Text color="red">评算失败</Text>;
  else if (typeof dim.score === 'number') {
    line = (
      <Text>
        <Bar10 score={dim.score} />
        <Text color={scoreColor(dim.score)}> {(dim.score * 10).toFixed(1)}</Text>
        {dim.verdict ? <Text color="gray">  {dim.verdict}</Text> : null}
      </Text>
    );
  } else {
    const v = dim.verdict ?? '—';
    const color = v === 'clean' || v === '完成' ? 'green' : v === 'violation' || v === '未完成' ? 'red' : 'yellow';
    line = (
      <Text>
        <Text color={color}>{v}</Text>
        {dim.disclose ? <Text color="gray">  {truncV(dim.disclose, 30)}</Text> : null}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>{head}  {line}</Text>
      {dim.items.map(it => <ItemLine key={it.itemId} it={it} />)}
    </Box>
  );
}

function ScorecardView({ card, meta }: { card: Scorecard; meta: { tool: string; durationMs: number; aborted?: boolean; failureNote?: string | null } }) {
  const fw = card.framework;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">评分结果 · {card.sessionId}</Text>
      <Text color="gray">mate={meta.tool} · {(meta.durationMs / 1000).toFixed(1)}s · 覆盖率 {(fw.coverage * 100).toFixed(0)}%{meta.aborted ? ' · 会话截断，仅规则层' : ''}</Text>
      <Text> </Text>
      {fw.veto?.triggered ? (
        <Box flexDirection="column">
          <Text color="red">否决触发：总分归 0</Text>
          {fw.veto.reasons.map((r, i) => <Text key={i} color="red">  • {truncV(r, 60)}</Text>)}
        </Box>
      ) : typeof fw.totalScore === 'number' ? (
        <Text>总分  <Bar10 score={fw.totalScore} />  <Text bold>{(fw.totalScore * 10).toFixed(1)} / 10</Text></Text>
      ) : (
        <Text color="gray">总分不可算（维度覆盖不足 / 全部不适用）</Text>
      )}
      <Text> </Text>
      {card.dimensions.map(dim => <DimBlock key={dim.dimensionId} dim={dim} />)}
      {fw.coverageGap?.length ? (
        <Text color="yellow">未覆盖 {fw.coverageGap.length} 项：{fw.coverageGap.map(g => truncV(g, 26)).join('、')}</Text>
      ) : null}
      {meta.failureNote ? <Text color="yellow">部分维度失败：{truncV(meta.failureNote, 60)}</Text> : null}
    </Box>
  );
}

export function ScoreTui(props: ScoreTuiProps) {
  const { exit } = useApp();
  const [stage, setStage] = useState<Stage>(props.initialSession ? 'running' : 'source');
  const [sourceCursor, setSourceCursor] = useState(0);

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  const [quicks, setQuicks] = useState<Array<{ label: string; dir: string }>>([]);
  const [quickCursor, setQuickCursor] = useState(0);
  const [dirInput, setDirInput] = useState('');
  const [dirFocus, setDirFocus] = useState(false);
  // 同 tick 连续 stdin 写入时 onSubmit 闭包里的 dirInput 是旧值——ref 前置镜像
  const dirInputRef = useRef('');
  const setDirInputLed = (v: string) => { dirInputRef.current = v; setDirInput(v); };

  const [dirSessions, setDirSessions] = useState<DirSessionRow[]>([]);
  const [dirCursor, setDirCursor] = useState(0);
  const [dirOffset, setDirOffset] = useState(0);
  const [dirSelected, setDirSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [filterFocus, setFilterFocus] = useState(false);

  const [tools, setTools] = useState<MateAgentTool[]>([]);
  const [toolCursor, setToolCursor] = useState(0);
  const [picked, setPicked] = useState<{ taskId: string; framework?: string | null; tool: MateAgentTool } | null>(
    props.initialSession ? { taskId: props.initialSession.taskId, framework: props.initialSession.framework ?? undefined, tool: 'claude' } : null,
  );
  /** 待评分队列（批量）：null = 单会话直跑（initialSession / 本机库单选） */
  const [queue, setQueue] = useState<DirSessionRow[] | null>(null);

  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [phase, setPhase] = useState<'rule' | 'mate'>('rule');
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [card, setCard] = useState<Scorecard | null>(null);
  const [cardMeta, setCardMeta] = useState<{ tool: string; durationMs: number; aborted?: boolean; failureNote?: string | null } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [summaryCursor, setSummaryCursor] = useState(0);

  // ── 数据装载 ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (stage !== 'session') return;
    let alive = true;
    setLoadingSessions(true);
    prisma.session.findMany({
      orderBy: { startTime: 'desc' },
      take: 200,
      select: { taskId: true, framework: true, startTime: true, totalTokens: true, totalSubagentCount: true, query: true },
    }).then(rows => {
      if (!alive) return;
      setSessions(rows);
      setLoadingSessions(false);
      setCursor(0); setOffset(0);
    }).catch(err => {
      if (!alive) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStage('error');
    });
    return () => { alive = false; };
  }, [stage]);

  useEffect(() => {
    if (stage !== 'dir') return;
    setQuicks(quickDirs());
    setQuickCursor(0);
  }, [stage]);

  useEffect(() => {
    if (stage !== 'tool') return;
    setTools(detectMateAgentTools());
    setToolCursor(0);
  }, [stage]);

  // ── 执行流（单会话 / 批量共用；queue 变化即开跑）──────────────────────────
  useEffect(() => {
    if (stage !== 'running' || !picked) return;
    let alive = true;
    const items = queue ?? [{ id: picked.taskId, source: '', filePath: '', framework: picked.framework ?? null, turnCount: 0, modelName: null, firstQuery: null }];
    let cancelled = false;

    (async () => {
      setEvents([]);
      setResults([]);
      setBatchIndex(0);
      setSavedTo(null);
      const collected: ScoreEvent[] = [];
      const outcomes: BatchResult[] = [];
      const tool = picked.tool;

      for (let i = 0; i < items.length; i++) {
        if (!alive) { cancelled = true; break; }
        const item = items[i];
        setBatchIndex(i);
        setCurrentId(item.id);
        setPhase('rule');
        setProgress(null);
        const t0 = Date.now();
        try {
          // 未导入的先导入（同 taskId 已有行则直接复用，不重复导入）
          if (queue) {
            const existing = await prisma.session.findFirst({ where: { taskId: item.id }, select: { framework: true } });
            if (!existing) {
              await importSession(item.filePath, item.id, prisma, item.filePath, item.source);
            }
          }
          const code = await runMateScoreFlow(
            {
              session: item.id,
              framework: (queue ? (await prisma.session.findFirst({ where: { taskId: item.id }, select: { framework: true } }))?.framework : picked.framework) ?? undefined,
              tool,
              concurrency: props.concurrency,
              timeoutMs: props.timeoutMs,
              workdir: props.workdir,
              store: true,
            },
            e => {
              if (!alive) return;
              collected.push(e);
              setEvents([...collected]);
              if (e.type === 'progress') {
                setPhase('mate');
                setProgress({ done: e.done as number, total: e.total as number, current: e.current as string });
              }
            },
          );
          const done = collected.slice().reverse().find(e => e.type === 'done') as { card?: Scorecard } | undefined;
          const errEv = collected.slice().reverse().find(e => e.type === 'error') as { message?: string } | undefined;
          outcomes.push({
            taskId: item.id,
            card: code === 0 && done?.card ? done.card : null,
            error: code !== 0 ? (errEv?.message ?? '评分失败') : null,
            durationMs: Date.now() - t0,
          });
        } catch (err) {
          outcomes.push({ taskId: item.id, card: null, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0 });
        }
        setResults([...outcomes]);
      }

      if (!alive || cancelled) return;
      // 单会话 → 结果视图；批量 → 汇总
      if (outcomes.length === 1 && outcomes[0].card) {
        const lastDone = collected.slice().reverse().find(e => e.type === 'done') as { aborted?: boolean; failureNote?: string | null } | undefined;
        setCard(outcomes[0].card);
        setCardMeta({ tool, durationMs: outcomes[0].durationMs, aborted: lastDone?.aborted, failureNote: lastDone?.failureNote ?? null });
        setStage('result');
      } else {
        setStage('summary');
      }
    })();

    return () => { alive = false; };
  }, [stage, picked, queue, props.concurrency, props.timeoutMs, props.workdir]);

  const saveJsonl = useCallback(() => {
    if (!events.length) return;
    const name = events.length > 0 && (events.filter(e => e.type === 'meta').length > 1)
      ? 'score-batch.jsonl'
      : `${String((events[0] as { taskId?: string })?.taskId ?? 'score').replace(/[^\w.-]/g, '_')}.score.jsonl`;
    const file = path.join(props.saveDir ?? process.cwd(), name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    setSavedTo(file);
  }, [events, props.saveDir]);

  // ── 目录扫描（jsonl + sqlite 两族，注册表单点；跳过无 filePath 条目）──────
  const scanDir = useCallback((dir: string) => {
    setScanning(true);
    setScanError(null);
    try {
      const rows: DirSessionRow[] = [];
      for (const family of Object.keys(SOURCE_FAMILIES)) {
        for (const t of SOURCE_FAMILIES[family]) {
          const m = getSource(t);
          if (!m?.listSessions) continue;
          try {
            for (const s of m.listSessions(dir)) {
              if (!s.filePath) continue;
              rows.push({
                id: s.id,
                source: t,
                filePath: s.filePath,
                framework: s.framework ?? null,
                createdAt: s.createdAt,
                turnCount: s.turnCount,
                modelName: s.modelName,
                firstQuery: s.firstQuery,
              });
            }
          } catch { /* 单源失败不炸整个扫描 */ }
        }
      }
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // 最新在前（时间列可见）
      setDirSessions(rows);
      setDirCursor(0);
      setDirOffset(0);
      setDirSelected(new Set());
      setStage('dirSessions');
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, []);

  // ── 按键 ──────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (dirFocus || filterFocus) return; // 输入模式由 TextInput 自行处理
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }

    if (stage === 'source') {
      if (key.upArrow) setSourceCursor(c => Math.max(0, c - 1));
      else if (key.downArrow) setSourceCursor(c => Math.min(1, c + 1));
      else if (key.return) setStage(sourceCursor === 0 ? 'session' : 'dir');
      return;
    }

    if (stage === 'session') {
      if (input === '/') { setFilterText(''); setFilterFocus(true); return; }
      if (key.escape && filterText) { setFilterText(''); setCursor(0); setOffset(0); return; }
      if (filteredSessions.length === 0) return;
      if (key.upArrow) setCursor(c => { const n = Math.max(0, c - 1); if (n < offset) setOffset(n); return n; });
      else if (key.downArrow) {
        setCursor(c => {
          const n = Math.min(filteredSessions.length - 1, c + 1);
          if (n >= offset + VIEW_ROWS) setOffset(n - VIEW_ROWS + 1);
          return n;
        });
      } else if (key.return) {
        const row = filteredSessions[cursor];
        setQueue(null);
        setPicked({ taskId: row.taskId, framework: row.framework, tool: 'claude' });
        setStage('tool');
      }
      return;
    }

    if (stage === 'dir') {
      const total = quicks.length + 1; // + 手动输入项
      if (key.upArrow) setQuickCursor(c => Math.max(0, c - 1));
      else if (key.downArrow) setQuickCursor(c => Math.min(total - 1, c + 1));
      else if (key.return) {
        if (quickCursor === 0) setDirFocus(true);
        else scanDir(quicks[quickCursor - 1].dir);
      }
      else if (key.escape) setStage('source');
      return;
    }

    if (stage === 'dirSessions') {
      const keyOf = (r: DirSessionRow) => `${r.id}:${r.source}`;
      if (input === '/') { setFilterText(''); setFilterFocus(true); return; }
      if (key.escape && filterText) { setFilterText(''); setDirCursor(0); setDirOffset(0); return; }
      if (filteredDirSessions.length === 0) {
        if (key.escape) setStage('dir');
        return;
      }
      if (key.upArrow) setDirCursor(c => { const n = Math.max(0, c - 1); if (n < dirOffset) setDirOffset(n); return n; });
      else if (key.downArrow) {
        setDirCursor(c => {
          const n = Math.min(filteredDirSessions.length - 1, c + 1);
          if (n >= dirOffset + VIEW_ROWS) setDirOffset(n - VIEW_ROWS + 1);
          return n;
        });
      } else if (input === ' ') {
        setDirSelected(prev => {
          const next = new Set(prev);
          const k = keyOf(filteredDirSessions[dirCursor]);
          if (next.has(k)) next.delete(k); else next.add(k);
          return next;
        });
      } else if (input === 'a') {
        setDirSelected(prev => prev.size === filteredDirSessions.length ? new Set() : new Set(filteredDirSessions.map(keyOf)));
      } else if (key.return) {
        const chosen = dirSelected.size > 0
          ? dirSessions.filter(r => dirSelected.has(keyOf(r)))
          : [filteredDirSessions[dirCursor]];
        if (!chosen.length) return;
        setQueue(chosen);
        setPicked({ taskId: chosen[0].id, framework: chosen[0].framework, tool: 'claude' });
        setStage('tool');
      } else if (key.escape) {
        setStage('dir');
      }
      return;
    }

    if (stage === 'tool') {
      if (key.upArrow) setToolCursor(c => Math.max(0, c - 1));
      else if (key.downArrow) setToolCursor(c => Math.min(tools.length - 1, c + 1));
      else if (key.return && tools[toolCursor] && picked) {
        setPicked({ ...picked, tool: tools[toolCursor] });
        setStage('running');
      } else if (key.escape) setStage(queue ? 'dirSessions' : 'session');
      return;
    }

    if (stage === 'result') {
      if (input === 's') saveJsonl();
      else if (key.escape) setStage('source');
    } else if (stage === 'summary') {
      if (input === 's') saveJsonl();
      else if (key.upArrow) setSummaryCursor(c => Math.max(0, c - 1));
      else if (key.downArrow) setSummaryCursor(c => Math.min(results.length - 1, c + 1));
      else if (key.return && results[summaryCursor]?.card) setStage('detail');
      else if (key.escape) setStage('source');
    } else if (stage === 'detail') {
      if (input === 's') saveJsonl();
      else if (key.escape || key.return) setStage('summary');
    } else if (stage === 'error' && key.escape) {
      setStage('source');
    }
  });

  // [/] 过滤：id / 框架 / 首问 / 模型跨列包含匹配（iCode 会话浏览器同款思路）
  const lc = filterText.trim().toLowerCase();
  const filteredSessions = useMemo(() => !lc ? sessions : sessions.filter(s =>
    [s.taskId, s.framework, s.query ?? ''].some(v => v.toLowerCase().includes(lc))), [sessions, lc]);
  const filteredDirSessions = useMemo(() => !lc ? dirSessions : dirSessions.filter(s =>
    [s.id, s.source, s.modelName ?? '', s.firstQuery ?? ''].some(v => v.toLowerCase().includes(lc))), [dirSessions, lc]);
  const sessionWindow = useMemo(() => filteredSessions.slice(offset, offset + VIEW_ROWS), [filteredSessions, offset]);
  const dirWindow = useMemo(() => filteredDirSessions.slice(dirOffset, dirOffset + VIEW_ROWS), [filteredDirSessions, dirOffset]);
  const filterInput = (focusStage: 'session' | 'dirSessions') => filterFocus ? (
    <Box>
      <Text color="cyan">过滤: </Text>
      <TextInput
        value={filterText}
        focus={filterFocus}
        onChange={v => {
          setFilterText(v);
          if (focusStage === 'session') { setCursor(0); setOffset(0); } else { setDirCursor(0); setDirOffset(0); }
        }}
        onEscape={() => { setFilterFocus(false); setFilterText(''); setCursor(0); setOffset(0); setDirCursor(0); setDirOffset(0); }}
        onSubmit={() => setFilterFocus(false)}
        placeholder="输入关键字过滤（Esc 清除）"
      />
    </Box>
  ) : null;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">Insight Score TUI</Text>
      <Text color="gray">────────────────────────────────────────────────────────────</Text>

      {stage === 'source' && (
        <Box flexDirection="column">
          <Text bold>选择会话来源（↑↓ · Enter）</Text>
          <Text color={sourceCursor === 0 ? 'cyan' : undefined} inverse={sourceCursor === 0}>
            {sourceCursor === 0 ? '❯ ' : '  '}本机库已导入会话
          </Text>
          <Text color={sourceCursor === 1 ? 'cyan' : undefined} inverse={sourceCursor === 1}>
            {sourceCursor === 1 ? '❯ ' : '  '}从目录选择（自动扫描，支持批量评分）
          </Text>
        </Box>
      )}

      {stage === 'session' && (
        <Box flexDirection="column">
          <Text bold>选择会话{loadingSessions ? '（加载中…）' : `（${filteredSessions.length}/${sessions.length} 个，↑↓ 移动 · Enter 确认 · [/] 过滤）`}</Text>
          {filterInput('session')}
          <Text color="gray">{padEndV('Task ID', 38)} {padEndV('FW', 16)} {padEndV('Tokens', 8)} Subs  Query</Text>
          {sessionWindow.map((row, i) => {
            const idx = offset + i;
            const selected = idx === cursor;
            return (
              <Text key={`${row.taskId}:${row.framework}`} color={selected ? 'cyan' : undefined} inverse={selected}>
                {selected ? '❯ ' : '  '}{padEndV(truncV(row.taskId, 37), 38)} {padEndV(truncV(row.framework, 15), 16)} {padEndV(fmtTokens(row.totalTokens), 8)} {padEndV(String(row.totalSubagentCount), 5)}  {truncV(row.query ?? '', 24)}
              </Text>
            );
          })}
          {!loadingSessions && sessions.length === 0 && <Text color="gray">暂无已导入会话——返回选「从目录选择」导入并评分</Text>}
          {sessions.length > 0 && filteredSessions.length === 0 && <Text color="gray">无匹配会话（Esc 清除过滤）</Text>}
        </Box>
      )}

      {stage === 'dir' && (
        <Box flexDirection="column">
          <Text bold>选择目录（↑↓ · Enter 扫描 · Esc 返回）</Text>
          <Text color={quickCursor === 0 ? 'cyan' : undefined} inverse={quickCursor === 0}>
            {quickCursor === 0 ? '❯ ' : '  '}{dirFocus ? '手动输入路径：' : '手动输入路径…'}
          </Text>
          {dirFocus && (
            <Box marginLeft={2}>
              <TextInput
                value={dirInput}
                onChange={setDirInputLed}
                focus={dirFocus}
                onEscape={() => setDirFocus(false)}
                placeholder="/path/to/sessions（Enter 确认 · Esc 取消）"
                onSubmit={() => { setDirFocus(false); const v = dirInputRef.current.trim(); if (v) scanDir(v); }}
              />
            </Box>
          )}
          {quicks.map((q, i) => {
            const idx = i + 1; // 首项是手动输入
            return (
              <Text key={q.dir} color={idx === quickCursor ? 'cyan' : undefined} inverse={idx === quickCursor}>
                {idx === quickCursor ? '❯ ' : '  '}{padEndV(truncV(q.label, 18), 18)} <Text color="gray">{truncV(q.dir, 44)}</Text>
              </Text>
            );
          })}
          {scanning && <Spinner label="扫描目录中…" />}
          {scanError && <Text color="red">{scanError}</Text>}
        </Box>
      )}

      {stage === 'dirSessions' && (
        <Box flexDirection="column">
          <Text bold>目录内会话（{filteredDirSessions.length}/{dirSessions.length} 个 · [Space] 勾选 · [a] 全选/清空 · [/] 过滤 · Enter 评分所选 · Esc 返回）</Text>
          {filterInput('dirSessions')}
          <Text color="gray">{padEndV('Session ID', 30)} {padEndV('时间', 11)} {padEndV('Source', 12)} {padEndV('Turns', 5)} {padEndV('Model', 12)} 简介</Text>
          {dirWindow.map((row, i) => {
            const idx = dirOffset + i;
            const selected = idx === dirCursor;
            const checked = dirSelected.has(`${row.id}:${row.source}`);
            return (
              <Text key={`${row.id}:${row.source}`} color={selected ? 'cyan' : undefined} inverse={selected}>
                {checked ? '[x]' : '[ ]'}{selected ? '❯' : ' '}{padEndV(truncV(row.id, 27), 28)} {padEndV(fmtTime(row.createdAt), 11)} {padEndV(truncV(row.source, 11), 12)} {padEndV(String(row.turnCount), 5)} {padEndV(truncV(row.modelName ?? '', 11), 12)} {truncV(row.firstQuery ?? '—', 22)}
              </Text>
            );
          })}
          {dirSessions.length === 0 && <Text color="gray">目录内未发现会话文件（jsonl / opencode db / codex rollout）</Text>}
          {dirSessions.length > 0 && filteredDirSessions.length === 0 && <Text color="gray">无匹配（Esc 清除过滤）</Text>}
          <Text color="gray">已选 {dirSelected.size} 个 · 未勾选时 Enter 评分当前行</Text>
        </Box>
      )}

      {stage === 'tool' && (
        <Box flexDirection="column">
          <Text bold>选择 mate agent 工具（↑↓ · Enter · Esc 返回）</Text>
          <Text color="gray">{queue ? `批量 ${queue.length} 个会话，首个：${queue[0]?.id}` : `会话：${picked?.taskId}（${picked?.framework ?? '—'}）`}</Text>
          {tools.length === 0 && <Text color="red">本机未探测到 claude / opencode CLI</Text>}
          {tools.map((t, i) => (
            <Text key={t} color={i === toolCursor ? 'cyan' : undefined} inverse={i === toolCursor}>
              {i === toolCursor ? '❯ ' : '  '}{t}
            </Text>
          ))}
        </Box>
      )}

      {stage === 'running' && picked && (
        <Box flexDirection="column">
          <Text bold>
            评分中{queue ? `（${batchIndex + 1}/${queue.length}）` : ''}：{currentId ?? picked.taskId} · 工具 {picked.tool}
          </Text>
          {queue && <Text color="gray">未导入的会话会先自动导入（标准管线），再评分</Text>}
          {phase === 'rule' && <Spinner label="规则层直算中…" />}
          {phase === 'mate' && progress && (
            <Box flexDirection="column">
              <Text>
                <Text color="green">[{progress.done}/{progress.total}]</Text>
                {' '}mate 评审 {progress.current}
              </Text>
              <Text>
                <Text color="green">{'█'.repeat(Math.max(0, progress.done))}</Text>
                <Text color="gray">{'░'.repeat(Math.max(0, progress.total - progress.done))}</Text>
              </Text>
            </Box>
          )}
          <Text color="gray">（每个维度一个本地 agent 进程，大会话可能数分钟）</Text>
        </Box>
      )}

      {stage === 'result' && card && cardMeta && (
        <Box flexDirection="column">
          <ScorecardView card={card} meta={cardMeta} />
          <Text> </Text>
          <Text color="gray">[s] 保存 jsonl{savedTo ? `（已保存 ${truncV(savedTo, 40)}）` : ''} · [Esc] 回到开头 · [q] 退出</Text>
        </Box>
      )}

      {stage === 'summary' && (
        <Box flexDirection="column">
          <Text bold>批量评分完成（{results.filter(r => r.card).length}/{results.length} 成功）</Text>
          {results.map((r, i) => {
            const selected = i === summaryCursor;
            const score = r.card?.framework.totalScore;
            return (
              <Text key={r.taskId} color={selected ? 'cyan' : undefined} inverse={selected}>
                {selected ? '❯ ' : '  '}{padEndV(truncV(r.taskId, 30), 31)}
                {r.error ? <Text color="red"> ✗ {truncV(r.error, 30)}</Text> : score != null && r.card?.framework.veto?.triggered
                  ? <Text color="red"> 否决 0.0</Text>
                  : <Text>{score != null ? <Bar10 score={score} /> : null}{score != null ? <Text color={scoreColor(score)}> {(score * 10).toFixed(1)}</Text> : null}</Text>}
              </Text>
            );
          })}
          <Text color="gray">[Enter] 查看评分卡 · [s] 保存全部 jsonl{savedTo ? `（已保存 ${truncV(savedTo, 40)}）` : ''} · [Esc] 回到开头 · [q] 退出</Text>
        </Box>
      )}

      {stage === 'detail' && results[summaryCursor]?.card && (
        <Box flexDirection="column">
          <ScorecardView
            card={results[summaryCursor].card!}
            meta={{ tool: picked?.tool ?? '', durationMs: results[summaryCursor].durationMs }}
          />
          <Text> </Text>
          <Text color="gray">[Esc/Enter] 返回汇总 · [s] 保存全部 jsonl · [q] 退出</Text>
        </Box>
      )}

      {stage === 'error' && (
        <Box flexDirection="column">
          <Text color="red">出错：{errorMsg}</Text>
          <Text color="gray">[Esc] 回到开头 · [q] 退出</Text>
        </Box>
      )}
    </Box>
  );
}

export async function runScoreTui(initial?: ScoreTuiProps): Promise<number> {
  const { waitUntilExit } = render(<ScoreTui {...initial} />, {
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await waitUntilExit();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  const code = process.exitCode;
  process.exitCode = undefined;
  return typeof code === 'number' ? code : 0;
}
