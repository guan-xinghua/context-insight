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
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  /** 重开回载的历史结果（②列表 ↺ 标记） */
  restored?: boolean;
}

/** 结果默认落盘目录：跨启动稳定（重开 TUI 回看历史靠它），不随 cwd 漂移 */
const defaultSaveDir = (): string => path.join(CONTEXT_HOME, 'score-results');
/** 结果文件名：<原会话名>.score.jsonl */
const scoreFileOf = (saveDir: string, taskId: string): string =>
  path.join(saveDir, `${taskId.replace(/[^\w.-]/g, '_')}.score.jsonl`);
/** 载入历史结果：meta(taskId/framework) + done(card/durationMs) → BatchResult（按落盘时间新→旧） */
function loadSavedResults(saveDir: string): BatchResult[] {
  let files: string[] = [];
  try { files = readdirSync(saveDir).filter(f => f.endsWith('.score.jsonl')); } catch { return []; }
  const out: Array<{ r: BatchResult; mtime: number }> = [];
  for (const f of files) {
    try {
      const evs = readFileSync(path.join(saveDir, f), 'utf-8').trim().split('\n')
        .filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
      const meta = evs.find(e => e.type === 'meta') as { taskId?: string; framework?: string | null } | undefined;
      const done = evs.find(e => e.type === 'done') as { card?: Scorecard; durationMs?: number } | undefined;
      if (!meta?.taskId || !done?.card) continue;
      out.push({
        r: {
          taskId: meta.taskId, framework: meta.framework ?? null, card: done.card, error: null,
          durationMs: typeof done.durationMs === 'number' ? done.durationMs : 0, restored: true,
        },
        mtime: statSync(path.join(saveDir, f)).mtimeMs,
      });
    } catch { /* 单文件损坏跳过，不炸回载 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(x => x.r);
}

export interface ScoreTuiProps {
  initialSession?: { taskId: string; framework?: string | null };
  concurrency?: number;
  timeoutMs?: number;
  workdir?: string;
  /** jsonl 保存目录（缺省 ~/.context-insight/score-results，重开可回看历史） */
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
    if (w + cw > maxWidth - 2) break; // 预留 '..' 两列，总宽恒 ≤ maxWidth
    out += ch;
    w += cw;
  }
  return out + '..';
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

/** 手工分区框：每行一个 Text 节点（行内零 Box——Ink 布局引擎对动态内容的
 * 行内 Box 有丢行缺陷；纯 span + 手动补位绝对稳定）。行可以是 string（自动补
 * 齐到内宽）或 { node, w }（已算好视觉宽度的着色 span 行） */
type FrameRow = string | { node: React.ReactNode; w: number };
/** 严格等宽手绘框：总宽 w = '│ ' + 内容(w-4) + ' │'；顶/底行同宽（CJK 宽度计入）。
 * h 给定则定高：内容行精确 h-2（不足补空行、超出裁掉）——每帧行数逐框同构，
 * ink 行 diff 无重排机会 */
function drawFrame(title: string, color: string, rows: FrameRow[], w: number, key: string, h?: number): React.ReactNode[] {
  const inner = Math.max(8, w - 4);
  const head = `─ ${title} `;
  const top = `╭${head}${'─'.repeat(Math.max(1, w - 2 - stringWidth(head)))}╮`;
  const bottom = `╰${'─'.repeat(w - 2)}╯`;
  const rail = <Text color={color}>│ </Text>;
  const railR = <Text color={color}> │</Text>;
  const body = h != null
    ? rows.slice(0, Math.max(0, h - 2)).concat(Array.from({ length: Math.max(0, h - 2 - rows.length) }, (_, i) => ({ node: <Text key={`${key}-pad${i}`}> </Text> as React.ReactNode, w: 1 })))
    : rows;
  return [
    <Text key={`${key}-t`} color={color}>{top}</Text>,
    ...body.map((r, i) => {
      const visW = Math.min(inner, typeof r === 'string' ? stringWidth(r) : r.w);
      const pad = Math.max(0, inner - visW);
      const content = typeof r === 'string'
        ? <Text>{truncV(r, inner - 2)}{' '.repeat(Math.max(0, inner - 2 - stringWidth(truncV(r, inner - 2))))}{'  '}</Text>
        : <Text>{r.node}{' '.repeat(pad)}</Text>;
      return <Text key={`${key}-r${i}`}>{rail}{content}{railR}</Text>;
    }),
    <Text key={`${key}-b`} color={color}>{bottom}</Text>,
  ];
}

/** 带光标前缀的行：node 可含着色 span；w = 视觉宽度（drawFrame 按此补位） */
function row(active: boolean, plain: string, node?: React.ReactNode, activeColor = 'cyan'): FrameRow {
  const prefix = active ? '❯ ' : '  ';
  return { node: <Text color={active ? activeColor : undefined}>{prefix}{node ?? plain}</Text>, w: stringWidth(prefix + plain) };
}

/** 维度行 / 子项行（FrameRow 版）：单行 Text + span，无 Box */
function dimRow(dim: DimensionResult): FrameRow {
  if (dim.status === 'not-applicable') return { node: <Text color="gray">{dim.dimensionId} {truncV(dim.name, 8)}  不适用</Text>, w: stringWidth(`${dim.dimensionId} ${truncV(dim.name, 8)}  不适用`) };
  if (dim.status === 'error') return { node: <Text color="red">{dim.dimensionId} {truncV(dim.name, 8)}  评算失败</Text>, w: stringWidth(`${dim.dimensionId} ${truncV(dim.name, 8)}  评算失败`) };
  if (typeof dim.score === 'number') {
    const tail = `${(dim.score * 10).toFixed(1)}${dim.verdict ? `  ${dim.verdict}` : ''}`;
    const plain = `${dim.dimensionId} ${truncV(dim.name, 8)}  ${tail}`;
    return { node: <Text><Text bold>{dim.dimensionId}</Text> {padEndV(truncV(dim.name, 8), 9)} <Bar10 score={dim.score} width={12} /> <Text color={scoreColor(dim.score)}>{tail}</Text></Text>, w: stringWidth(plain) + 4 };
  }
  const v = dim.verdict ?? '—';
  const plain = `${dim.dimensionId} ${truncV(dim.name, 8)}  ${v}${dim.disclose ? `  ${truncV(dim.disclose, 20)}` : ''}`;
  const color = v === 'clean' || v === '完成' ? 'green' : v === 'violation' || v === '未完成' ? 'red' : 'yellow';
  return { node: <Text><Text bold>{dim.dimensionId}</Text> {padEndV(truncV(dim.name, 8), 9)} <Text color={color}>{v}</Text>{dim.disclose ? <Text color="gray">  {truncV(dim.disclose, 20)}</Text> : null}</Text>, w: stringWidth(plain) };
}

function itemRow(it: SubItemResult, w: number): FrameRow {
  const icon = it.status === 'ok' ? '✓' : it.status === 'not-applicable' ? '○' : '✗';
  const iconColor = it.status === 'ok' ? 'green' : it.status === 'not-applicable' ? 'gray' : 'red';
  const parts: string[] = [];
  if (it.value !== undefined && it.value !== null) parts.push(String(it.value));
  if (typeof it.score === 'number') parts.push(`${(it.score * 10).toFixed(1)}分`);
  if (it.verdict) parts.push(it.verdict);
  if (it.note) parts.push(it.note);
  const labelW = Math.max(10, Math.min(16, w - 30));
  const text = truncV(parts.join(' / ') || '-', Math.max(12, w - labelW - 10));
  const plain = `  ${icon} ${truncV(it.label, labelW)}  ${text}`;
  return { node: <Text>  <Text color={iconColor}>{icon}</Text> {padEndV(truncV(it.label, labelW), labelW)}  <Text color="gray">{text}</Text></Text>, w: stringWidth(plain) };
}

const scoreColor = (score: number): string =>
  score >= 0.8 ? 'green' : score >= 0.6 ? 'yellow' : 'red';

function Bar10({ score, width = 10 }: { score: number; width?: number }) {
  const filled = Math.max(0, Math.min(width, Math.round(score * width)));
  return (
    <Text>
      <Text color={scoreColor(score)}>{'█'.repeat(filled)}</Text>
      <Text color="magenta">{'░'.repeat(width - filled)}</Text>
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
  const partsText = truncV(parts.join(' / ') || '-', Math.max(12, w - labelW - 10));
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
        <Bar10 score={dim.score} width={16} />
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
  const [rightSel, setRightSel] = useState(0);   // ②已完成框内的选中行
  const [detailIdx, setDetailIdx] = useState<number | null>(null); // ③评分卡载入的行
  const [rightSub, setRightSub] = useState<'list' | 'card'>('list'); // 右栏子块焦点

  // 运行态
  const [runPhase, setRunPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [phase, setPhase] = useState<'rule' | 'mate'>('rule');
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [queue, setQueue] = useState<Array<{ id: string; framework: string | null; filePath: string; source: string }>>([]);
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const saveDir = props.saveDir ?? defaultSaveDir();
  // 重开回看：启动即载入历史落盘结果（②已完成区 ↺ 行，Enter 可载入评分卡）
  const [results, setResults] = useState<BatchResult[]>(() => loadSavedResults(saveDir));
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [jumpUrl, setJumpUrl] = useState<string | null>(null);
  const dirInputRef = useRef('');
  const cardMaxRef = useRef(0); // ③框内滚动上界（渲染帧内更新，按键时读取）

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
    // 历史保留：只摘除本轮重评的会话（完成后新结果补位），其余 ↺ 历史行不动
    setResults(prev => prev.filter(r => !chosen.some(c => c.id === r.taskId)));
    setEvents([]);
    setSavedTo(null);
    setDetailIdx(null);
    setRightScroll(0);
    setRightSub('list');
    setFocus('right');
  }, [sourceMode, sessions, filteredSessions, dbSelected, dirSelected, dirSessions, tools, toolIdx, runPhase, rows, cursor]);

  useEffect(() => {
    if (runPhase !== 'running' || queue.length === 0) return;
    let alive = true;
    const tool = tools[toolIdx];
    const queueIds = new Set(queue.map(q => q.id));
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
        const sessionStart = collected.length; // 本会话事件切片起点（默认落盘用）
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
          const outcome: BatchResult = { taskId: item.id, framework: fw ?? null, card: code === 0 && done?.card ? done.card : null, error: code !== 0 ? (errEv?.message ?? '评分失败') : null, durationMs: Date.now() - t0 };
          outcomes.push(outcome);
          // 默认落盘：出卡即写 <taskId>.score.jsonl（重开可回看；失败不写，保留上次历史）
          if (outcome.card) {
            try {
              mkdirSync(saveDir, { recursive: true });
              writeFileSync(scoreFileOf(saveDir, item.id), collected.slice(sessionStart).map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
            } catch { /* 落盘失败不影响评分流程 */ }
          }
        } catch (err) {
          outcomes.push({ taskId: item.id, framework: item.framework ?? null, card: null, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0 });
        }
        setResults(prev => [...prev.filter(r => !queueIds.has(r.taskId)), ...outcomes]);
      }
      if (!alive) return;
      setRunPhase('done');
      // 评分卡完全手动：不自动载入——用户在②列表 Enter 载入③
    })();
    return () => { alive = false; };
  }, [runPhase, queue, tools, toolIdx, props.concurrency, props.timeoutMs, props.workdir]);

  const saveJsonl = useCallback(() => {
    if (!events.length) return;
    const name = events.filter(e => e.type === 'meta').length > 1
      ? path.join(saveDir, 'score-batch.jsonl')
      : scoreFileOf(saveDir, String((events[0] as { taskId?: string })?.taskId ?? 'score'));
    mkdirSync(path.dirname(name), { recursive: true });
    writeFileSync(name, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    setSavedTo(name);
  }, [events, saveDir]);

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
    // 输入模式（路径/过滤）行内捕获：TextInput 已为渲染稳定改为纯字符串行，
    // 键盘处理在此手写（ref 前置镜像防同 tick 连打丢字）
    if (dirFocus) {
      if (key.escape) { setDirFocus(false); return; }
      if (key.return) {
        setDirFocus(false);
        const v = dirInputRef.current.trim();
        if (v) scanDir(v);
        return;
      }
      if (key.backspace || key.delete) { setDirInputLed(dirInputRef.current.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) setDirInputLed(dirInputRef.current + input);
      return;
    }
    if (filterFocus) {
      if (key.escape) { setFilterFocus(false); setFilterText(''); return; }
      if (key.return) { setFilterFocus(false); return; }
      if (key.backspace || key.delete) { setFilterText(t => t.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) setFilterText(t => t + input);
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }
    if (input === 'o') { jump(); return; }
    if (input === 'b' && events.length) { saveJsonl(); return; }
    // 导航体系：WASD = 块级（W/S 分区、A/D 左右栏），↑↓ = 行级（分区内逐行，
    // 到边界经拍平行跨界续走）。无 Tab、无 J/K
    const k = input.toLowerCase();
    const sectionStarts = (() => {
      const sectionOf = (r: FlatRow) => r.k === 'source' ? 0 : r.k === 'dirQuick' ? 1 : r.k === 'session' ? 2 : r.k === 'tool' ? 3 : 4;
      const starts: number[] = [];
      let last = -1;
      rows.forEach((r, i) => { const sec = sectionOf(r); if (sec !== last) { starts.push(i); last = sec; } });
      return starts;
    })();

    if (k === 'a' && focus === 'right') { setFocus('left'); return; }
    if (k === 'd' && focus === 'left') { setFocus('right'); return; }
    if (k === 'w' || k === 's') {
      const fwd = k === 's';
      if (focus === 'right') {
        // 右栏子块切换：S（下）list→card，W（上）card→list
        setRightSub(sub => (fwd ? (detailIdx != null ? 'card' : sub) : 'list'));
        return;
      }
      // 左栏分区跳转
      const curSecIdx = sectionStarts.findIndex((start, i) =>
        cursor >= start && (i === sectionStarts.length - 1 || cursor < sectionStarts[i + 1]));
      const nextIdx = fwd ? Math.min(sectionStarts.length - 1, curSecIdx + 1) : Math.max(0, curSecIdx - 1);
      if (curSecIdx >= 0 && nextIdx !== curSecIdx) setCursor(sectionStarts[nextIdx]);
      return;
    }

    if (focus === 'right') {
      const up = key.upArrow;
      const down = key.downArrow;
      if (rightSub === 'card' && detailIdx != null) {
        if (key.return) { setRightSub('list'); return; }
        if (up) setRightScroll(v => Math.max(0, v - 1));
        else if (down) setRightScroll(v => Math.min(cardMaxRef.current, v + 1));
        return;
      }
      if (up) setRightSel(i => Math.max(0, i - 1));
      else if (down) setRightSel(i => Math.min(Math.max(0, results.length - 1), i + 1));
      else if (key.return && results[rightSel]?.card) { setDetailIdx(rightSel); setRightScroll(0); setRightSub('card'); }
      return;
    }

    // 左栏：拍平行连续光标（↑↓ 行级移动，跨界自然续走）
    const row = rows[cursor];
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

  // 左栏 = 真分区：每区独立边框盒（光标所在区边框高亮青色，其余灰）
  const curSection = curRow ? (curRow.k === 'source' ? 0 : curRow.k === 'dirQuick' ? 1 : curRow.k === 'session' ? 2 : curRow.k === 'tool' ? 3 : 4) : -1;
  const mkBox = (title: string, secIdx: number, children: FrameRow[]): React.ReactNode[] =>
    drawFrame(title, curSection === secIdx ? 'cyan' : 'gray', children, leftW - 2, `sec-${secIdx}`);

  // ── 来源 ──
  const srcNodes: FrameRow[] = [];
  for (const v of ['db', 'dir'] as const) {
    const on = sourceMode === v;
    const plain = `${on ? '●' : '○'} ${v === 'db' ? '本机库已导入会话' : '从目录选择（批量）'}`;
    srcNodes.push(row(isActiveRow({ k: 'source', v }), plain,
      <Text color={on ? 'green' : undefined}>{plain}</Text>));
  }

  // ── 目录（dir 模式）──
  const dirNodes: FrameRow[] = [];
  if (sourceMode === 'dir') {
    quicks.forEach((q, i) => {
      const plain = `${truncV(q.label, 14)} ${truncV(q.dir || 'Enter 输入', 18)}`;
      dirNodes.push(row(isActiveRow({ k: 'dirQuick', idx: i }), plain,
        <Text>{truncV(q.label, 14)} <Text color="gray">{truncV(q.dir || 'Enter 输入', 18)}</Text></Text>));
    });
    if (dirFocus) dirNodes.push(`路径: ${dirInput}█（Enter 扫描 / Esc 取消）`);
    if (scanning) dirNodes.push('扫描目录中…');
  }

  // ── 会话 ──
  const sessLabel = sourceMode === 'db'
    ? `会话 ${filteredSessions.length}/${sessions.length}${loadingSessions ? '（加载中…）' : ''}`
    : dirSessions == null ? '会话（未扫描）' : `会话 ${filteredDirSessions.length}/${dirSessions.length}`;
  const sessNodes: FrameRow[] = [];
  if (filterFocus) sessNodes.push(`过滤: ${filterText}█（Esc 清除）`);
  const curSessIdx = curRow?.k === 'session' ? (curRow as { idx: number }).idx : 0;
  const sessWinSize = sourceMode === 'dir' ? 5 : 7; // dir 模式多一框，会话窗口收窄
  const sessWinStart = Math.max(0, Math.min(curSessIdx - 3, Math.max(0, activeSessions.length - sessWinSize)));
  activeSessions.slice(sessWinStart, sessWinStart + sessWinSize).forEach((s, i) => {
    const gIdx = sessWinStart + i;
    const id = 'taskId' in s ? s.taskId : s.id;
    const check = activeSelected.has(sessionKey(s)) ? '[x]' : '[ ]';
    // 按帧内宽自适应组装：inner - 前缀(2) - 勾选框(3) - 空格，余量优先保 id
    const budget = (leftW - 6) - 2 - 3 - 1;
    const timeS = fmtTime('taskId' in s ? s.startTime : s.createdAt);
    const subS = 'taskId' in s ? `${fmtTokens(s.totalTokens)} ${s.totalSubagentCount}ag` : `${s.turnCount}轮`;
    let idW = budget - timeS.length - 1 - Math.min(subS.length, 10) - 1;
    let sub2 = truncV(subS, 10);
    if (idW < 10) { sub2 = ''; idW = budget - timeS.length - 1; } // 窄终端：先丢摘要
    if (idW < 8) { sub2 = ''; } // 再丢时间已不可能（budget≥8+12）
    idW = Math.max(8, idW);
    const plain = `${check} ${truncV(id, idW)} ${timeS}${sub2 ? ` ${sub2}` : ''}`;
    sessNodes.push(row(isActiveRow({ k: 'session', idx: gIdx }), plain,
      <Text>{check} {truncV(id, idW)} <Text color="gray">{timeS}{sub2 ? ` ${sub2}` : ''}</Text></Text>));
  });
  if (sourceMode === 'dir' && dirSessions == null) {
    sessNodes.push(' 选上方目录项开始扫描');
  } else if (activeSessions.length === 0 && (sourceMode === 'db' ? !loadingSessions : true)) {
    sessNodes.push(filterText ? ' 无匹配（Esc 清除过滤）' : sourceMode === 'db' ? ' 本机库暂无会话' : ' 目录内未发现会话');
  }
  sessNodes.push(' [Space] 勾选  [t] 全选  [/] 过滤');

  // ── Agent 工具 ──
  const toolNodes: FrameRow[] = [];
  tools.forEach(t => {
    const on = tools[toolIdx] === t;
    const plain = `${on ? '●' : '○'} ${t}`;
    toolNodes.push(row(isActiveRow({ k: 'tool', v: t }), plain,
      <Text color={on ? 'green' : undefined}>{plain}</Text>));
  });
  if (tools.length === 0) toolNodes.push('未探测到 claude / opencode');

  // ── 运行 ──
  const selCount = sourceMode === 'db' ? dbSelected.size : dirSelected.size;
  const runText = runPhase === 'running' ? '⏳ 评分中…（右栏看进度）'
    : runPhase === 'done' ? '↻ [Enter] 再评一轮'
    : `▶ [Enter] 开始评分${selCount > 0 ? `（已选 ${selCount}）` : sourceMode === 'db' ? '（光标会话）' : '（需勾选）'}`;
  const runNodes: FrameRow[] = [row(isActiveRow({ k: 'run' }), runText,
    <Text bold color={runPhase === 'running' ? 'yellow' : 'green'}>{runText}</Text>)];

  let leftSections: React.ReactNode[] = [
    ...mkBox('来源', 0, srcNodes),
    ...(sourceMode === 'dir' ? mkBox('目录', 1, dirNodes) : []),
    ...mkBox(sessLabel, 2, sessNodes),
    ...mkBox('Agent 工具', 3, toolNodes),
    ...mkBox('运行', 4, runNodes),
  ];
  // 行数定长（不足补空行）：行数随数据变化会触发 ink 行 diff 错位（顶边框丢失）
  const leftLineBudget = bodyH - 2;
  leftSections = leftSections.slice(0, leftLineBudget);
  while (leftSections.length < leftLineBudget) {
    leftSections.push(<Text key={`pad-${leftSections.length}`}> </Text>);
  }

  // ── 右栏渲染：idle = 预览；运行/完成 = 三段式（①待评分 ②已完成 ③评分卡）──
  // 单框内分节（分隔线代嵌套边框）：Ink 对结构性嵌套定高 Box 有布局缓存缺陷
  const rightLines: React.ReactNode[] = [];
  const rBox = (title: string, color: string, children: FrameRow[], h?: number): React.ReactNode[] =>
    drawFrame(title, color, children, rightInnerW, `rsec-${title}`, h);

  if (runPhase === 'idle' && results.length === 0) {
    const pvNodes: FrameRow[] = [];
    const preview = sourceMode === 'db'
      ? sessions.filter(s => dbSelected.has(sessionKey(s)))
      : (dirSessions ?? []).filter(s => dirSelected.has(sessionKey(s)));
    if (preview.length === 0) {
      pvNodes.push('左栏 [Space] 勾选会话；本机库模式未勾选时评光标行。');
      pvNodes.push('目录模式先选目录扫描 → 勾选 → 未导入的自动导入再评分。');
    } else {
      pvNodes.push(`已选 ${preview.length} 个：`);
      preview.slice(0, 12).forEach(s => {
        const id = 'taskId' in s ? s.taskId : s.id;
        const q = 'taskId' in s ? s.query : s.firstQuery;
        pvNodes.push(`• ${truncV(id, 30)} ${truncV(q ?? '', 30)}`);
      });
    }
    rightLines.push(...rBox('预览', 'gray', pvNodes, rightH));
  } else {
    // 三框恒定行高：① 7 行 ② 8 行 ③ 吃余量（~56%）——每帧行数逐框同构（ink 行
    // diff 零重排机会），③ 改框内滚动（全局切片会把框从中间切成半截）
    let qBoxH = 7, dBoxH = 8;
    let cBoxH = rightH - qBoxH - dBoxH;
    if (cBoxH < 6) { // 矮终端：③ 保底 40%，余量再分①②
      cBoxH = Math.max(4, Math.floor(rightH * 0.4));
      const rest = rightH - cBoxH;
      dBoxH = Math.max(4, Math.floor(rest * 0.5));
      qBoxH = Math.max(3, rest - dBoxH);
    }

    // ① 待评分（定高 qBoxH：cur + 进度条 + 待办窗口 + 计数）
    const qNodes: FrameRow[] = [];
    if (runPhase === 'running') {
      const cur = queue[batchIndex];
      const curPlain = `⏳ ${truncV(cur?.id ?? currentId ?? '', Math.max(10, rightInnerW - 26))}${phase === 'mate' && progress ? ` [${progress.done}/${progress.total}] ${truncV(progress.current, 12)}` : phase === 'rule' ? ' 规则层…' : ''}`;
      qNodes.push({ node: <Text color="yellow">{curPlain}</Text>, w: stringWidth(curPlain) });
      if (phase === 'mate' && progress) {
        const barW = Math.max(12, rightInnerW - 4);
        const fill = progress.total > 0 ? Math.min(barW, Math.round((progress.done / progress.total) * barW)) : 0;
        qNodes.push({ node: <Text>
        <Text color="green">{'█'.repeat(fill)}</Text>
        <Text color="magenta">{'░'.repeat(barW - fill)}</Text>
      </Text>, w: barW });
      }
      const pendSlots = Math.max(0, qBoxH - 2 - 3); // 预留 cur/bar/计数三行
      queue.slice(batchIndex + 1, batchIndex + 1 + pendSlots).forEach(item => {
        qNodes.push(`- ${truncV(item.id, rightInnerW - 6)}`);
      });
      if (queue.length - batchIndex - 1 > pendSlots) {
        qNodes.push(`- ..共剩 ${queue.length - batchIndex - 1} 个`);
      }
    } else if (runPhase === 'idle') {
      qNodes.push('待评分 · 左栏勾选/选会话后 [Enter] 开始');
    } else {
      qNodes.push('— 队列已完成 —');
    }

    // ── ② 已完成（定高 dBoxH：视口窗口 + 选中行跟随，纯派生无同步态）──
    const dRows = dBoxH - 2;
    const dNodes: FrameRow[] = [];
    if (results.length === 0) {
      dNodes.push('（尚无完成项）');
    } else {
      const rowsVisible = results.length > dRows ? dRows - 1 : dRows; // 溢出时末行给计数
      const maxStart = Math.max(0, results.length - rowsVisible);
      const start = Math.min(maxStart, Math.max(0, rightSel - (rowsVisible - 2)));
      results.slice(start, start + rowsVisible).forEach((r, i) => {
        const idx = start + i;
        const sel = focus === 'right' && rightSub === 'list' && idx === rightSel;
        const loaded = detailIdx === idx;
        const score = r.card?.framework.totalScore;
        const mark = loaded ? '▤' : r.restored ? '↺' : r.error ? '✗' : r.card?.framework.veto?.triggered ? '⛔' : '✓';
        const markColor = r.restored && !loaded ? 'gray' : r.error || r.card?.framework.veto?.triggered ? 'red' : 'green';
        const idW = Math.max(12, rightInnerW - 18);
        const tail = r.error != null
          ? <Text color="red">{truncV(r.error, Math.max(8, rightInnerW - 40))}</Text>
          : score != null ? <Text><Bar10 score={score} /> <Text color={scoreColor(score)}>{(score * 10).toFixed(1)}</Text></Text>
          : null;
        dNodes.push(row(sel, `${mark} ${truncV(r.taskId, idW)}`,
          <Text><Text color={markColor}>{mark}</Text> {truncV(r.taskId, idW)} {tail}</Text>));
      });
      if (results.length > dRows) dNodes.push(`… 共 ${results.length} 个`);
    }

    // ── ③ 评分卡（定高 cBoxH：完全手动载入；↑↓ 框内滚动）──
    const cRows = cBoxH - 2;
    const cNodes: FrameRow[] = [];
    const loadedResult = detailIdx != null ? results[detailIdx] : null;
    if (loadedResult?.card) {
      const card = loadedResult.card;
      const fw = card.framework;
      const cardLines: FrameRow[] = [];
      cardLines.push({ node: <Text bold color="cyan">{truncV(card.sessionId, rightInnerW - 6)}</Text>, w: stringWidth(truncV(card.sessionId, rightInnerW - 6)) });
      cardLines.push(`${(loadedResult.durationMs / 1000).toFixed(1)}s  覆盖率 ${(fw.coverage * 100).toFixed(0)}%`);
      if (fw.veto?.triggered) {
        cardLines.push('否决触发：总分归 0');
      } else if (typeof fw.totalScore === 'number') {
        cardLines.push({ node: <Text>总分 <Bar10 score={fw.totalScore} /> <Text bold>{(fw.totalScore * 10).toFixed(1)} / 10</Text></Text>, w: 3 + 10 + 1 + stringWidth(`${(fw.totalScore * 10).toFixed(1)} / 10`) });
      }
      card.dimensions.forEach(dim => {
        cardLines.push(dimRow(dim));
        dim.items.forEach(it => cardLines.push(itemRow(it, rightInnerW)));
      });
      if (fw.coverageGap?.length) {
        cardLines.push(`未覆盖 ${fw.coverageGap.length} 项`);
      }
      // ③框内滚动：偏移相对 cardLines 首行，上界钉死在末屏（不再全局切片）
      cardMaxRef.current = Math.max(0, cardLines.length - cRows);
      const visible = rightSub === 'card' ? Math.min(rightScroll, cardMaxRef.current) : 0;
      cardLines.slice(visible, visible + cRows).forEach(n => cNodes.push(n));
    } else {
      cardMaxRef.current = 0;
      cNodes.push('在已完成列表中 ↑↓ 选择  [Enter] 载入评分卡');
    }

    // 三分区盒渲染（活动子块青色；待评分运行中黄色）
    rightLines.push(...rBox(runPhase === 'running'
      ? `待评分（${batchIndex + 1}/${queue.length}）` : runPhase === 'idle' ? '待评分' : '待评分（完成）',
      runPhase === 'running' ? 'yellow' : 'gray', qNodes, qBoxH));
    rightLines.push(...rBox(results.length > 0
      ? `已完成（${results.filter(r => r.card).length}/${results.length}）` : '已完成',
      focus === 'right' && rightSub === 'list' ? 'cyan' : 'gray', dNodes, dBoxH));
    rightLines.push(...rBox('评分卡',
      focus === 'right' && rightSub === 'card' ? 'cyan' : 'gray', cNodes, cBoxH));
  }
  // 定高后无全局切片：三框（或预览框）恒占 rightH 行；补齐循环仅作安全兜底
  const rightWin = rightLines;
  while (rightWin.length < rightH) rightWin.push(<Text key={`rpad-${rightWin.length}`}> </Text>);

  const keybar = focus === 'right'
    ? '[W/S] 切换列表/评分卡 · [↑↓] 选行/滚动 · [A] 回配置 · [Enter] 载入/返回 · [b] 保存 · [o] 页面 · [q] 退出'
    : '[W/S] 切分区 · [A/D] 左右栏 · [↑↓] 行移动 · [Space] 勾选 · [t] 全选 · [/] 过滤 · [Enter] 激活 · [b] 保存 · [o] 页面 · [q] 退出';

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
      <Box flexDirection="row" gap={1}>
        <Box flexDirection="column" width={leftW} borderStyle="round" borderColor={focus === 'left' ? 'cyan' : 'gray'}>
          {leftSections}
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focus === 'right' ? 'cyan' : 'gray'}>
          {rightWin.length > 0 ? rightWin : <Text color="gray"> </Text>}
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
