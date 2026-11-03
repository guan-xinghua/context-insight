// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Insight Score TUI：左配置 / 右输出 的常驻双栏界面。
// 左栏拍平为跨分区连续光标（↑↓ 穿过来历/目录/会话/工具/运行，Enter 按行类型
// 激活，Space 勾选会话行）；右栏预览/进度/结果三态（评分卡视图 + 批量汇总，
// Enter 进详情）。[o] 打开 insight 评分页（端口读登记文件 → env → 21025；
// WSL 用 wslview）。执行流与一次性 CLI 共用 runMateScoreFlow，直接读本机库。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { prisma } from '@/lib/db';
import { CONTEXT_HOME } from '@/lib/scoring/core/store';
import { detectMateAgentTools, type MateAgentTool } from '@/lib/scoring/mate-agent/runner';
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
  framework: string | null;
  card: Scorecard | null;
  error: string | null;
  durationMs: number;
}

export interface ScoreTuiProps {
  initialSession?: { taskId: string; framework?: string | null };
  concurrency?: number;
  timeoutMs?: number;
  workdir?: string;
  /** jsonl 保存目录（缺省当前目录） */
  saveDir?: string;
}

// 左栏宽度自适应：宽终端给配置更多空间，窄终端保右栏可读（100 列测试环境也够用）

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
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function quickDirs(): Array<{ label: string; dir: string }> {
  const home = os.homedir();
  const candidates = [
    { label: '手动输入路径…', dir: '' },
    { label: 'Claude Code', dir: path.join(home, '.claude', 'projects') },
    { label: 'opencode', dir: path.join(home, '.config', 'opencode') },
    { label: 'Codex', dir: path.join(home, '.codex', 'sessions') },
    { label: '用户主目录', dir: home },
    { label: '当前目录', dir: process.cwd() },
  ];
  return candidates.filter(c => {
    if (!c.dir) return true;
    try { return existsSync(c.dir); } catch { return false; }
  });
}

/** insight 服务端口：登记文件 → env → 21025（[o] 跳转用） */
function insightPort(): string {
  try {
    const m = readFileSync(path.join(CONTEXT_HOME, 'insight-port'), 'utf-8').match(/\d+/);
    if (m) return m[0];
  } catch { /* 未登记 */ }
  return process.env.CONTEXT_INSIGHT_PORT ?? '21025';
}

function openInBrowser(url: string): void {
  if (process.env.SCORE_TUI_NO_OPEN) return;
  const wsl = process.env.WSL_DISTRO_NAME || existsSync('/mnt/c');
  const cmd = process.platform === 'darwin' ? 'open' : wsl ? 'wslview' : 'xdg-open';
  try { spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 打不开时 URL 仍回显 */ }
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

function ItemLine({ it, w }: { it: SubItemResult; w: number }) {
  const icon = it.status === 'ok' ? '✓' : it.status === 'not-applicable' ? '○' : '✗';
  const iconColor = it.status === 'ok' ? 'green' : it.status === 'not-applicable' ? 'gray' : 'red';
  const labelW = Math.max(10, Math.min(16, w - 30));
  const parts: string[] = [];
  if (it.value !== undefined && it.value !== null) parts.push(String(it.value));
  if (typeof it.score === 'number') parts.push(`${(it.score * 10).toFixed(1)}分`);
  if (it.verdict) parts.push(it.verdict);
  if (it.note) parts.push(it.note);
  const partsText = truncV(parts.join(' · ') || '—', Math.max(12, w - labelW - 10));
  return (
    <Text>
      <Text>  </Text>
      <Text color={iconColor}>{icon}</Text>
      <Text> {padEndV(truncV(it.label, labelW), labelW)}  </Text>
      <Text color="gray">{partsText}</Text>
    </Text>
  );
}

function DimBlock({ dim, w }: { dim: DimensionResult; w: number }) {
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
        {dim.disclose ? <Text color="gray">  {truncV(dim.disclose, 22)}</Text> : null}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>{head}  {line}</Text>
      {dim.items.map(it => <ItemLine key={it.itemId} it={it} w={w} />)}
    </Box>
  );
}

function ScorecardView({ card, meta, w = 80 }: { card: Scorecard; meta: { durationMs: number; aborted?: boolean; failureNote?: string | null }; w?: number }) {
  const fw = card.framework;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{card.sessionId}</Text>
      <Text color="gray">{(meta.durationMs / 1000).toFixed(1)}s · 覆盖率 {(fw.coverage * 100).toFixed(0)}%{meta.aborted ? ' · 会话截断，仅规则层' : ''}</Text>
      {fw.veto?.triggered ? (
        <Box flexDirection="column">
          <Text color="red">否决触发：总分归 0</Text>
          {fw.veto.reasons.map((r, i) => <Text key={i} color="red">  • {truncV(r, w - 4)}</Text>)}
        </Box>
      ) : typeof fw.totalScore === 'number' ? (
        <Text>总分  <Bar10 score={fw.totalScore} />  <Text bold>{(fw.totalScore * 10).toFixed(1)} / 10</Text></Text>
      ) : (
        <Text color="gray">总分不可算（维度覆盖不足 / 全部不适用）</Text>
      )}
      {card.dimensions.map(dim => <DimBlock key={dim.dimensionId} dim={dim} w={w} />)}
      {fw.coverageGap?.length ? (
        <Text color="yellow">未覆盖 {fw.coverageGap.length} 项：{fw.coverageGap.map(g => truncV(g, Math.max(8, w - 20))).join('、')}</Text>
      ) : null}
      {meta.failureNote ? <Text color="yellow">部分维度失败：{truncV(meta.failureNote, w - 4)}</Text> : null}
    </Box>
  );
}

// ── 左栏拍平行模型：跨分区连续光标的核心 ────────────────────────────────────
type FlatRow =
  | { k: 'source'; v: 'db' | 'dir' }
  | { k: 'dirQuick'; idx: number }
  | { k: 'session'; idx: number }   // 指向当前来源的过滤后会话数组
  | { k: 'tool'; v: MateAgentTool }
  | { k: 'run' };

export function ScoreTui(props: ScoreTuiProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termW = stdout?.columns ?? 120;
  const termH = stdout?.rows ?? 40;
  const leftW = Math.min(56, Math.max(36, Math.floor(termW * 0.44)));
  const rightInnerW = Math.max(24, termW - leftW - 6);
  // 固定画布：顶栏 1 + 主体（双栏）+ keybar 1 + 状态行 1 恒占位——总高不随内容跳动
  const bodyH = Math.max(12, termH - 4);
  const rightH = Math.max(8, bodyH - 2); // 减双栏边框

  // 配置态
  const [sourceMode, setSourceMode] = useState<'db' | 'dir'>('db');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [quicks, setQuicks] = useState<Array<{ label: string; dir: string }>>([]);
  const [dirInput, setDirInput] = useState('');
  const [dirFocus, setDirFocus] = useState(false);
  const [dirSessions, setDirSessions] = useState<DirSessionRow[] | null>(null); // null = 未扫描
  const [scanning, setScanning] = useState(false);
  const [dbSelected, setDbSelected] = useState<Set<string>>(new Set());
  const [dirSelected, setDirSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [filterFocus, setFilterFocus] = useState(false);
  const [tools, setTools] = useState<MateAgentTool[]>([]);
  const [toolIdx, setToolIdx] = useState(0);

  // 光标与焦点
  const [cursor, setCursor] = useState(0);
  const [focus, setFocus] = useState<'left' | 'right'>('left');
  const [rightScroll, setRightScroll] = useState(0);
  const [rightSel, setRightSel] = useState(0);   // 已完成框内的选中行
  const [detailIdx, setDetailIdx] = useState<number | null>(null);

  // 运行态
  const [runPhase, setRunPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [phase, setPhase] = useState<'rule' | 'mate'>('rule');
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [queue, setQueue] = useState<Array<{ id: string; framework: string | null; filePath: string; source: string }>>([]);
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [jumpUrl, setJumpUrl] = useState<string | null>(null);
  const dirInputRef = useRef('');

  // ── 数据装载 ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    prisma.session.findMany({
      orderBy: { startTime: 'desc' },
      take: 200,
      select: { taskId: true, framework: true, startTime: true, totalTokens: true, totalSubagentCount: true, query: true },
    }).then(rows => {
      if (!alive) return;
      setSessions(rows);
      setLoadingSessions(false);
      // --tui --session 预选：定位该会话行并勾选（framework 缺省取库里第一行）
      const init = props.initialSession;
      if (init) {
        const row = rows.find(r => r.taskId === init.taskId && (init.framework == null || r.framework === init.framework));
        if (row) setDbSelected(new Set([`${row.taskId}:${row.framework}`]));
      }
    }).catch(() => { if (alive) setLoadingSessions(false); });
    setQuicks(quickDirs());
    setTools(detectMateAgentTools());
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- 仅装载一次；initialSession 只在入口生效

  const lc = filterText.trim().toLowerCase();
  const filteredSessions = useMemo(() => !lc ? sessions : sessions.filter(s =>
    [s.taskId, s.framework, s.query ?? ''].some(v => v.toLowerCase().includes(lc))), [sessions, lc]);
  const dirRows = dirSessions ?? [];
  const filteredDirSessions = useMemo(() => !lc ? dirRows : dirRows.filter(s =>
    [s.id, s.source, s.modelName ?? '', s.firstQuery ?? ''].some(v => v.toLowerCase().includes(lc))), [dirRows, lc]);
  const activeSessions: Array<SessionRow | DirSessionRow> = sourceMode === 'db' ? filteredSessions : filteredDirSessions;
  const activeSelected = sourceMode === 'db' ? dbSelected : dirSelected;
  const sessionKey = (r: SessionRow | DirSessionRow) => 'taskId' in r ? `${r.taskId}:${r.framework}` : `${r.id}:${r.source}`;

  // ── 拍平行（跨分区连续光标的一维序列）─────────────────────────────────────
  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [
      { k: 'source', v: 'db' },
      { k: 'source', v: 'dir' },
    ];
    if (sourceMode === 'dir') quicks.forEach((_, idx) => out.push({ k: 'dirQuick', idx }));
    activeSessions.forEach((_, idx) => out.push({ k: 'session', idx }));
    tools.forEach(t => out.push({ k: 'tool', v: t }));
    out.push({ k: 'run' });
    return out;
  }, [sourceMode, quicks, activeSessions, tools]);
  useEffect(() => { setCursor(c => Math.min(c, Math.max(0, rows.length - 1))); }, [rows.length]);

  // ── 目录扫描（jsonl + sqlite 两族，注册表单点）────────────────────────────
  const scanDir = useCallback((dir: string) => {
    setScanning(true);
    try {
      const found: DirSessionRow[] = [];
      for (const family of Object.keys(SOURCE_FAMILIES)) {
        for (const t of SOURCE_FAMILIES[family]) {
          const m = getSource(t);
          if (!m?.listSessions) continue;
          try {
            for (const s of m.listSessions(dir)) {
              if (!s.filePath) continue;
              found.push({
                id: s.id, source: t, filePath: s.filePath, framework: s.framework ?? null,
                createdAt: s.createdAt, turnCount: s.turnCount, modelName: s.modelName, firstQuery: s.firstQuery,
              });
            }
          } catch { /* 单源失败不炸整个扫描 */ }
        }
      }
      found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setDirSessions(found);
      setDirSelected(new Set());
    } finally {
      setScanning(false);
    }
  }, []);

  // ── 评分执行（批量顺序：未导入先导入，再逐个跑流；右栏实时呈现）──────────
  const startRun = useCallback(() => {
    const tool = tools[toolIdx];
    if (!tool || runPhase === 'running') return;
    const chosen: Array<{ id: string; framework: string | null; filePath: string; source: string }> = [];
    if (sourceMode === 'db') {
      for (const r of sessions.filter(r => dbSelected.has(sessionKey(r)))) {
        chosen.push({ id: r.taskId, framework: r.framework, filePath: '', source: '' });
      }
      // 未勾选：光标所在会话行
      if (chosen.length === 0) {
        const cur = rows[cursor];
        if (cur?.k === 'session') {
          const s = filteredSessions[cur.idx];
          if (s) chosen.push({ id: s.taskId, framework: s.framework, filePath: '', source: '' });
        }
      }
    } else {
      for (const r of (dirSessions ?? []).filter(r => dirSelected.has(sessionKey(r)))) {
        chosen.push({ id: r.id, framework: r.framework, filePath: r.filePath, source: r.source });
      }
    }
    if (chosen.length === 0) return;
    setQueue(chosen);
    setRunPhase('running');
    setResults([]);
    setEvents([]);
    setSavedTo(null);
    setDetailIdx(null);
    setRightScroll(0);
    setFocus('right');
  }, [sourceMode, sessions, filteredSessions, dbSelected, dirSelected, dirSessions, tools, toolIdx, runPhase, rows, cursor]);

  useEffect(() => {
    if (runPhase !== 'running' || queue.length === 0) return;
    let alive = true;
    const tool = tools[toolIdx];
    (async () => {
      const collected: ScoreEvent[] = [];
      const outcomes: BatchResult[] = [];
      for (let i = 0; i < queue.length; i++) {
        if (!alive) return;
        const item = queue[i];
        setBatchIndex(i);
        setCurrentId(item.id);
        setPhase('rule');
        setProgress(null);
        const t0 = Date.now();
        try {
          let fw = item.framework ?? undefined;
          if (item.filePath) {
            const existing = await prisma.session.findFirst({ where: { taskId: item.id }, select: { framework: true } });
            if (!existing) await importSession(item.filePath, item.id, prisma, item.filePath, item.source);
            fw = (await prisma.session.findFirst({ where: { taskId: item.id }, select: { framework: true } }))?.framework ?? undefined;
          }
          const code = await runMateScoreFlow(
            { session: item.id, framework: fw, tool, concurrency: props.concurrency, timeoutMs: props.timeoutMs, workdir: props.workdir, store: true },
            e => {
              if (!alive) return;
              collected.push(e);
              setEvents([...collected]);
              if (e.type === 'progress') { setPhase('mate'); setProgress({ done: e.done as number, total: e.total as number, current: e.current as string }); }
            },
          );
          const done = collected.slice().reverse().find(e => e.type === 'done') as { card?: Scorecard } | undefined;
          const errEv = collected.slice().reverse().find(e => e.type === 'error') as { message?: string } | undefined;
          outcomes.push({ taskId: item.id, framework: fw ?? null, card: code === 0 && done?.card ? done.card : null, error: code !== 0 ? (errEv?.message ?? '评分失败') : null, durationMs: Date.now() - t0 });
        } catch (err) {
          outcomes.push({ taskId: item.id, framework: item.framework ?? null, card: null, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0 });
        }
        setResults([...outcomes]);
      }
      if (!alive) return;
      setRunPhase('done');
      setDetailIdx(outcomes.length === 1 && outcomes[0].card ? 0 : null);
    })();
    return () => { alive = false; };
  }, [runPhase, queue, tools, toolIdx, props.concurrency, props.timeoutMs, props.workdir]);

  const saveJsonl = useCallback(() => {
    if (!events.length) return;
    const name = events.filter(e => e.type === 'meta').length > 1
      ? 'score-batch.jsonl'
      : `${String((events[0] as { taskId?: string })?.taskId ?? 'score').replace(/[^\w.-]/g, '_')}.score.jsonl`;
    const file = path.join(props.saveDir ?? process.cwd(), name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    setSavedTo(file);
  }, [events, props.saveDir]);

  const jump = useCallback(() => {
    const one = detailIdx != null && results[detailIdx]
      ? results[detailIdx]
      : results.length === 1 ? results[0] : null;
    const fw = one?.framework
      ?? (sourceMode === 'db' ? sessions.find(s => dbSelected.has(sessionKey(s)))?.framework : null);
    const taskId = one?.taskId
      ?? (sourceMode === 'db' ? [...dbSelected][0]?.split(':')[0] : [...dirSelected][0]?.split(':')[0]);
    if (!taskId) return;
    const url = `http://127.0.0.1:${insightPort()}/scoring/${encodeURIComponent(taskId)}${fw ? `?framework=${encodeURIComponent(fw)}` : ''}`;
    setJumpUrl(url);
    openInBrowser(url);
  }, [detailIdx, results, sourceMode, sessions, dbSelected, dirSelected]);

  // ── 按键 ──────────────────────────────────────────────────────────────────
  const setDirInputLed = (v: string) => { dirInputRef.current = v; setDirInput(v); };

  useInput((input, key) => {
    if (dirFocus || filterFocus) return; // 输入模式由 TextInput 处理
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }
    if (input === 'o') { jump(); return; }
    if (input === 'b' && events.length) { saveJsonl(); return; }
    // WASD 导航（不分大小写；与 ↑↓/Tab 等效；A/D 左右栏）。导航优先级最高，
    // 冲突功能让位：全选 t、保存 b
    const k = input.toLowerCase();
    const wasdUD = k === 'w' ? 'up' : k === 's' ? 'down' : null;
    if (k === 'a' || k === 'd' || key.tab) {
      setFocus(f => {
        const canRight = f === 'left' && (events.length > 0 || results.length > 0);
        if (k === 'a') return 'left';
        if (k === 'd') return canRight ? 'right' : f;
        return canRight ? 'right' : 'left'; // Tab 保持原切换语义
      });
      return;
    }
    if (wasdUD) {
      const up = wasdUD === 'up';
      if (focus === 'right') { setRightScroll(v => (up ? Math.max(0, v - 1) : v + 1)); return; }
      setCursor(c => (up ? Math.max(0, c - 1) : Math.min(rows.length - 1, c + 1)));
      return;
    }

    if (focus === 'right') {
      const up = key.upArrow || k === 'w';
      const down = key.downArrow || k === 's';
      if (detailIdx != null) {
        if (key.return || key.escape) { setDetailIdx(null); setRightScroll(0); }
        else if (up) setRightScroll(v => Math.max(0, v - 1));
        else if (down) setRightScroll(v => v + 1);
        return;
      }
      if (up) setRightSel(i => Math.max(0, i - 1));
      else if (down) setRightSel(i => Math.min(Math.max(0, results.length - 1), i + 1));
      else if (key.return && results[rightSel]?.card) { setDetailIdx(rightSel); setRightScroll(0); }
      return;
    }

    // 左栏：跨分区连续光标（[/] 分区跳转：会话清单长时 ↓ 逐行太慢）
    const row = rows[cursor];
    const sectionOf = (r: FlatRow) => r.k === 'source' ? 0 : r.k === 'dirQuick' ? 1 : r.k === 'session' ? 2 : r.k === 'tool' ? 3 : 4;
    const sectionStarts = (() => {
      const starts: number[] = [];
      let last = -1;
      rows.forEach((r, i) => { const sec = sectionOf(r); if (sec !== last) { starts.push(i); last = sec; } });
      return starts;
    })();
    if (k === 'j' || k === 'k') {
      const curSecIdx = sectionStarts.findIndex((start, i) =>
        cursor >= start && (i === sectionStarts.length - 1 || cursor < sectionStarts[i + 1]));
      const nextIdx = k === 'j' ? Math.min(sectionStarts.length - 1, curSecIdx + 1) : Math.max(0, curSecIdx - 1);
      if (curSecIdx >= 0 && nextIdx !== curSecIdx) setCursor(sectionStarts[nextIdx]);
      return;
    }
    const toggleSession = (s: SessionRow | DirSessionRow | undefined) => {
      if (!s) return;
      const k = sessionKey(s);
      const setter = sourceMode === 'db' ? setDbSelected : setDirSelected;
      setter(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    };
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow) setCursor(c => Math.min(rows.length - 1, c + 1));
    else if (input === '/') { setFilterText(''); setFilterFocus(true); return; }
    else if (input === 't') {
      const setter = sourceMode === 'db' ? setDbSelected : setDirSelected;
      setter(prev => prev.size === activeSessions.length ? new Set() : new Set(activeSessions.map(sessionKey)));
      return;
    } else if (key.return && row) {
      if (row.k === 'source') setSourceMode(row.v);
      else if (row.k === 'dirQuick') {
        const q = quicks[row.idx];
        if (!q.dir) setDirFocus(true);
        else scanDir(q.dir);
      } else if (row.k === 'session') toggleSession(activeSessions[row.idx]);
      else if (row.k === 'tool') setToolIdx(tools.findIndex(t => t === row.v));
      else if (row.k === 'run') startRun();
    } else if (input === ' ' && row?.k === 'session') {
      toggleSession(activeSessions[row.idx]);
    }
  });

  // ── 左栏渲染（分区标题 + 行；❯ 高亮跟随全局 cursor）───────────────────────
  const curRow = rows[cursor];
  const flatIndexOf = (r: FlatRow | undefined): number => {
    if (!r) return -1;
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      if (x.k !== r.k) continue;
      if (x.k === 'source' && x.v !== (r as { v?: string }).v) continue;
      if ((x.k === 'dirQuick' || x.k === 'session') && (x as { idx: number }).idx !== (r as { idx: number }).idx) continue;
      if (x.k === 'tool' && x.v !== (r as { v?: string }).v) continue;
      return i;
    }
    return -1;
  };
  const isActiveRow = (r: FlatRow) => flatIndexOf(r) === cursor;

  const leftLines: React.ReactNode[] = [];
  const rowNode = (active: boolean, node: React.ReactNode) => (
    <Box key={leftLines.length}>
      {active ? <Text color="cyan">❯ </Text> : <Text>  </Text>}
      {node}
    </Box>
  );
  const sect = (label: string) => <Text key={leftLines.length} bold color="gray">── {label} ──────</Text>;

  leftLines.push(sect('来源'));
  for (const v of ['db', 'dir'] as const) {
    const on = sourceMode === v;
    leftLines.push(rowNode(isActiveRow({ k: 'source', v }),
      <Text color={on ? 'green' : undefined}>{on ? '●' : '○'} {v === 'db' ? '本机库已导入会话' : '从目录选择（批量）'}</Text>));
  }
  if (sourceMode === 'dir') {
    leftLines.push(sect('目录'));
    quicks.forEach((q, i) => {
      leftLines.push(rowNode(isActiveRow({ k: 'dirQuick', idx: i }),
        <Text>{truncV(q.label, 14)} <Text color="gray">{truncV(q.dir || 'Enter 输入', 22)}</Text></Text>));
    });
    if (dirFocus) {
      leftLines.push(
        <Box key={leftLines.length} marginLeft={2}>
          <TextInput
            value={dirInput}
            onChange={setDirInputLed}
            focus={dirFocus}
            onEscape={() => setDirFocus(false)}
            placeholder="路径（Enter 扫描）"
            onSubmit={() => { setDirFocus(false); const v = dirInputRef.current.trim(); if (v) scanDir(v); }}
          />
        </Box>,
      );
    }
    if (scanning) leftLines.push(<Spinner key={leftLines.length} label="扫描目录中…" />);
  }

  const sessLabel = sourceMode === 'db'
    ? `会话 ${filteredSessions.length}/${sessions.length}${loadingSessions ? '（加载中…）' : ''}`
    : dirSessions == null ? '会话（未扫描）' : `会话 ${filteredDirSessions.length}/${dirSessions.length}`;
  leftLines.push(sect(sessLabel));
  if (filterFocus) {
    leftLines.push(
      <Box key={leftLines.length} marginLeft={2}>
        <Text color="cyan">过滤: </Text>
        <TextInput
          value={filterText}
          focus={filterFocus}
          onChange={v => setFilterText(v)}
          onEscape={() => { setFilterFocus(false); setFilterText(''); }}
          onSubmit={() => setFilterFocus(false)}
          placeholder="关键字（Esc 清除）"
        />
      </Box>,
    );
  }
  // 会话窗口跟随光标滚动
  const curSessIdx = curRow?.k === 'session' ? (curRow as { idx: number }).idx : 0;
  const sessWinStart = Math.max(0, Math.min(curSessIdx - 4, Math.max(0, activeSessions.length - 9)));
  activeSessions.slice(sessWinStart, sessWinStart + 9).forEach((s, i) => {
    const gIdx = sessWinStart + i;
    const id = 'taskId' in s ? s.taskId : s.id;
    const time = 'taskId' in s ? fmtTime(s.startTime) : fmtTime(s.createdAt);
    const sub = 'taskId' in s
      ? `${fmtTokens(s.totalTokens)}·${s.totalSubagentCount}ag`
      : `${s.turnCount}轮 ${truncV(s.modelName ?? '', 10)}`;
    leftLines.push(rowNode(isActiveRow({ k: 'session', idx: gIdx }),
      <Text>
        {activeSelected.has(sessionKey(s)) ? <Text color="green">[x]</Text> : <Text color="gray">[ ]</Text>}{' '}
        {padEndV(truncV(id, Math.max(18, leftW - 24)), Math.max(19, leftW - 23))} <Text color="gray">{time} {sub}</Text>
      </Text>));
  });
  if (sourceMode === 'dir' && dirSessions == null) {
    leftLines.push(<Text key={leftLines.length} color="gray">  选择上方目录项开始扫描</Text>);
  } else if (activeSessions.length === 0 && (sourceMode === 'db' ? !loadingSessions : true)) {
    leftLines.push(<Text key={leftLines.length} color="gray">  {filterText ? '无匹配（Esc 清除过滤）' : sourceMode === 'db' ? '本机库暂无会话' : '目录内未发现会话'}</Text>);
  }
  leftLines.push(<Text key={leftLines.length} color="gray">  [Space] 勾选 · [t] 全选/清空 · [/] 过滤</Text>);

  leftLines.push(sect('Agent 工具'));
  tools.forEach(t => {
    const on = tools[toolIdx] === t;
    leftLines.push(rowNode(isActiveRow({ k: 'tool', v: t }),
      <Text color={on ? 'green' : undefined}>{on ? '●' : '○'} {t}</Text>));
  });
  if (tools.length === 0) leftLines.push(<Text key={leftLines.length} color="red">  未探测到 claude / opencode</Text>);

  leftLines.push(sect('运行'));
  const selCount = sourceMode === 'db' ? dbSelected.size : dirSelected.size;
  leftLines.push(rowNode(isActiveRow({ k: 'run' }),
    <Text bold color={runPhase === 'running' ? 'yellow' : 'green'}>
      {runPhase === 'running' ? '⏳ 评分中…（右栏看进度）'
        : runPhase === 'done' ? '↻ [Enter] 再评一轮'
        : `▶ [Enter] 开始评分${selCount > 0 ? `（已选 ${selCount}）` : sourceMode === 'db' ? '（光标会话）' : '（需勾选）'}`}
    </Text>));

  // ── 右栏渲染（预览 / 进度 / 结果三态）──────────────────────────────────────
  const rightLines: React.ReactNode[] = [];
  let rightSplit: React.ReactNode = null; // 批量运行时的双框形态（替代普通行窗口）
  if (runPhase === 'idle') {
    rightLines.push(<Text bold key="rt">待运行</Text>);
    const preview = sourceMode === 'db'
      ? sessions.filter(s => dbSelected.has(sessionKey(s)))
      : (dirSessions ?? []).filter(s => dirSelected.has(sessionKey(s)));
    if (preview.length === 0) {
      rightLines.push(<Text key="rp" color="gray">左栏 [Space] 勾选会话；本机库模式未勾选时评光标行。</Text>);
      rightLines.push(<Text key="rp2" color="gray">目录模式先选目录扫描 → 勾选 → 未导入的自动导入再评分。</Text>);
    } else {
      rightLines.push(<Text key="rpc" color="gray">已选 {preview.length} 个：</Text>);
      preview.slice(0, 12).forEach(s => {
        const id = 'taskId' in s ? s.taskId : s.id;
        const q = 'taskId' in s ? s.query : s.firstQuery;
        rightLines.push(<Text key={`p-${id}`}>• {truncV(id, 30)} <Text color="gray">{truncV(q ?? '', 30)}</Text></Text>);
      });
    }
  } else if (runPhase === 'running') {
    // 批量运行：上框「正在评分」实时进度，下框「已完成」可浏览（focus 右栏可选）
    if (queue.length > 1) {
      const runningBox: React.ReactNode[] = [];
      runningBox.push(<Text bold key="rb-t">正在评分（{batchIndex + 1}/{queue.length}）：{truncV(currentId ?? '', 30)}</Text>);
      if (phase === 'rule') runningBox.push(<Spinner key="rb-sp" label="规则层直算中…" />);
      if (phase === 'mate' && progress) {
        runningBox.push(<Text key="rb-pg"><Text color="green">[{progress.done}/{progress.total}]</Text> {progress.current}</Text>);
        runningBox.push(
          <Text key="rb-pb">
            <Text color="green">{'█'.repeat(Math.max(0, progress.done))}</Text>
            <Text color="gray">{'░'.repeat(Math.max(0, progress.total - progress.done))}</Text>
          </Text>,
        );
      }
      const doneBox: React.ReactNode[] = [];
      doneBox.push(<Text bold key="db-t" color="gray">已完成 {results.length}：</Text>);
      results.forEach((r, i) => {
        const sel = focus === 'right' && i === rightSel;
        const score = r.card?.framework.totalScore;
        doneBox.push(
          <Text key={`db-${i}`} color={sel ? 'cyan' : undefined} inverse={sel}>
            {sel ? '❯' : ' '}{r.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>} {padEndV(truncV(r.taskId, 24), 25)}
            {score != null ? <Text><Bar10 score={score} /> <Text color={scoreColor(score)}>{(score * 10).toFixed(1)}</Text></Text> : null}
          </Text>,
        );
      });
      if (results.length === 0) doneBox.push(<Text key="db-e" color="gray">（尚无完成项）</Text>);
      rightSplit = (
        <Box flexDirection="column" height="100%">
          <Box flexDirection="column" height={7} overflow="hidden" borderStyle="round" borderColor="yellow">
            <Text bold color="yellow">正在评分（{batchIndex + 1}/{queue.length}）</Text>
            {runningBox.slice(1)}
          </Box>
          <Box flexDirection="column" height={rightH - 8} overflow="hidden" borderStyle="round" borderColor={focus === 'right' ? 'cyan' : 'gray'} marginTop={0}>
            {doneBox}
          </Box>
        </Box>
      );
    }
    rightLines.push(<Text bold key="rt">评分中：{truncV(currentId ?? '', 36)}</Text>);
    if (phase === 'rule') rightLines.push(<Spinner key="sp" label="规则层直算中…" />);
    if (phase === 'mate' && progress) {
      rightLines.push(
        <Text key="pg"><Text color="green">[{progress.done}/{progress.total}]</Text> {progress.current}</Text>,
      );
      rightLines.push(
        <Text key="pb">
          <Text color="green">{'█'.repeat(Math.max(0, progress.done))}</Text>
          <Text color="gray">{'░'.repeat(Math.max(0, progress.total - progress.done))}</Text>
        </Text>,
      );
    }
  } else if (detailIdx != null && results[detailIdx]?.card) {
    rightLines.push(<Text key="bk" color="gray">[Enter] 返回列表</Text>);
    rightLines.push(<ScorecardView key="card" card={results[detailIdx].card!} meta={{ durationMs: results[detailIdx].durationMs }} w={rightInnerW} />);
  } else if (results.length === 1) {
    const r = results[0];
    if (r.card) rightLines.push(<ScorecardView key="card" card={r.card} meta={{ durationMs: r.durationMs }} w={rightInnerW} />);
    else rightLines.push(<Text key="err" color="red">✗ {truncV(r.taskId, 32)}：{r.error}</Text>);
  } else if (results.length > 1) {
    rightLines.push(<Text bold key="sum">批量完成（{results.filter(r => r.card).length}/{results.length} 成功）</Text>);
    results.forEach((r, i) => {
      const sel = focus === 'right' && i === rightSel;
      const score = r.card?.framework.totalScore;
      rightLines.push(
        <Text key={`s-${i}`} color={sel ? 'cyan' : undefined} inverse={sel}>
          {sel ? '❯ ' : '  '}{r.error ? <Text color="red">✗</Text> : r.card?.framework.veto?.triggered ? <Text color="red">⛔</Text> : <Text color="green">✓</Text>}{' '}
          {padEndV(truncV(r.taskId, Math.max(14, rightInnerW - 18)), Math.max(15, rightInnerW - 17))}
          {r.error ? <Text color="red">{truncV(r.error, Math.max(8, rightInnerW - 36))}</Text>
            : score != null ? <Text><Bar10 score={score} /> <Text color={scoreColor(score)}>{(score * 10).toFixed(1)}</Text></Text>
            : null}
        </Text>,
      );
    });
    rightLines.push(<Text key="hint" color="gray">[Tab] 切到列表 · [W/S] 选择 · [Enter] 看评分卡</Text>);
  }
  const rightWin = rightLines.slice(rightScroll, rightScroll + rightH);

  const keybar = focus === 'right'
    ? '[W/S 或 ↑↓] 滚动/选择 · [Enter] 详情/返回 · [A 或 Tab] 回配置 · [b] 保存 · [o] 页面 · [q] 退出'
    : '[W/S 或 ↑↓] 移动 · [J/K] 分区跳转 · [Space] 勾选 · [t] 全选 · [/] 过滤 · [Enter] 激活 · [D 或 Tab] 看结果 · [b] 保存 · [o] 页面 · [q] 退出';

  // 顶栏单行纯文本：块字符 logo（█▀▄）在 CJK 字体终端是歧义宽度（每字符占 2 格），
  // 布局按 1 格计算必然错位溢出——改零歧义文本 logo，任何终端/字体下稳定
  const rightAction = '[o] 评分页面 ↗';
  const leftTitle = 'Insight Score · 会话独立评分';
  const topPad = Math.max(2, termW - stringWidth(leftTitle) - stringWidth(rightAction) - 2);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" height={1} overflow="hidden">
        <Text bold color="cyan">Insight Score</Text>
        <Text bold> · 会话独立评分</Text>
        <Text>{' '.repeat(topPad)}</Text>
        <Text color="cyan">{rightAction}</Text>
      </Box>
      <Box flexDirection="row" gap={1} height={bodyH}>
        <Box flexDirection="column" width={leftW} height={bodyH} overflow="hidden" borderStyle="round" borderColor={focus === 'left' ? 'cyan' : 'gray'}>
          {leftLines}
        </Box>
        <Box flexDirection="column" flexGrow={1} height={bodyH} overflow="hidden" borderStyle="round" borderColor={focus === 'right' ? 'cyan' : 'gray'}>
          {rightSplit ?? (rightWin.length > 0 ? rightWin : <Text color="gray"> </Text>)}
        </Box>
      </Box>
      <Text color="gray">{truncV(keybar, Math.max(40, termW - 4))}</Text>
      <Text color="gray">{
        [savedTo ? `jsonl：${savedTo}` : null, jumpUrl ? `↗ ${jumpUrl}` : null]
          .filter(Boolean).join(' · ') || ' '
      }</Text>
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
