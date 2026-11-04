// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Insight Score TUI（pi-tui 版）：左配置 / 右输出统一双栏。
// 组件契约 render(width)→string[]：行宽/行数违规在契约层暴露；宽度测量 ANSI 感知。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { matchesKey, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { prisma } from '@/lib/db';
import { CONTEXT_HOME } from '@/lib/scoring/core/store';
import { detectMateAgentTools, type MateAgentTool } from '@/lib/scoring/mate-agent/runner';
import { runMateScoreFlow, type ScoreEvent } from '@/cli/commands/score';
import { SOURCE_FAMILIES, getSource } from '@/lib/ingest/adapters/registry';
import { importSession } from '@/lib/ingest/data-service';
import type { Scorecard, DimensionResult, SubItemResult } from '@/lib/scoring';

// ── 颜色（内联 SGR：visibleWidth 剥终端序列后测宽）────────────────────────────
const C = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const gray = (s: string) => C('90', s);
const cyan = (s: string) => C('36', s);
const green = (s: string) => C('32', s);
const magenta = (s: string) => C('35', s);
const yellow = (s: string) => C('33', s);
const red = (s: string) => C('31', s);
const bold = (s: string) => C('1', s);
const scoreColor = (score: number): ((s: string) => string) =>
  score >= 0.8 ? green : score >= 0.6 ? yellow : red;

// ── 宽度工具（CJK + ANSI 感知）────────────────────────────────────────────────
function padEndV(str: string, width: number): string {
  const w = visibleWidth(str);
  return w >= width ? str : str + ' '.repeat(width - w);
}
function truncV(str: string, maxWidth: number): string {
  if (visibleWidth(str) <= maxWidth) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = visibleWidth(ch);
    if (w + cw > maxWidth - 2) break; // 预留 '..' 两列，总宽恒 ≤ maxWidth
    out += ch;
    w += cw;
  }
  return out + '..';
}
function truncW(line: string, maxWidth: number): string {
  // 整行截断（ANSI 感知）：SGR 序列整段保留（宽 0），切口绝不落在序列内部，
  // 有未闭合样式时补 reset——断裂的 \x1b[ 会被终端当 CSI 参数吞掉后续字符，
  // 造成整行排版崩坏（内容越过边框）
  if (visibleWidth(line) <= maxWidth) return line;
  const tokens: Array<{ s: string; w: number; sgr: boolean }> = [];
  const re = /\x1b\[[0-9;]*m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) {
      for (const c of line.slice(last, m.index)) tokens.push({ s: c, w: visibleWidth(c), sgr: false });
    }
    tokens.push({ s: m[0], w: 0, sgr: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) {
    for (const c of line.slice(last)) tokens.push({ s: c, w: visibleWidth(c), sgr: false });
  }
  let out = '';
  let w = 0;
  let styled = false;
  for (const t of tokens) {
    if (t.sgr) { out += t.s; styled = t.s !== '\x1b[0m'; continue; }
    if (w + t.w > maxWidth - 2) break;
    out += t.s;
    w += t.w;
  }
  return out + '..' + (styled ? '\x1b[0m' : '');
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const y = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()} `;
  return `${y}${md} ${hm}`;
}

/** 目录扫描来源短名（多来源混列时的人工标记）：codex-jsonl → codex 等 */
function shortSource(source: string): string {
  return source.replace(/-(jsonl|db|native)$/, '').replace('context-insight', 'insight');
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${String(sec % 60).padStart(2, '0')}s`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, '0')}m`;
}
function fmtCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '—';
  return cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`;
}


/** 双色条：分数色填充 + 品红余量（宽 width 格）*/
/** 分段竖棒条（密集排栏）：▎ 细棒自带右侧留白，相邻不粘连——每格一段，分辨率翻倍 */
function barSegments(segs: number, isFilled: (i: number) => boolean, fillColor: (s: string) => string): string {
  let out = '';
  for (let i = 0; i < segs; i++) out += isFilled(i) ? fillColor('▎') : magenta('┊');
  return out;
}
function bar(score: number, width: number): string {
  const segs = Math.max(3, width);
  return barSegments(segs, i => i < Math.round(score * segs), scoreColor(score));
}

// ── 结果持久化：默认落盘 + 重开回载 ──────────────────────────────────────────
const defaultSaveDir = (): string => path.join(CONTEXT_HOME, 'score-results');
const scoreFileOf = (saveDir: string, taskId: string): string =>
  path.join(saveDir, `${taskId.replace(/[^\w.-]/g, '_')}.score.jsonl`);
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
    } catch { /* 单文件损坏跳过 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(x => x.r);
}

// ── 环境探测 ─────────────────────────────────────────────────────────────────
function quickDirs(): Array<{ label: string; dir: string }> {
  const home = os.homedir();
  const candidates = [
    { label: '手动输入路径…', dir: '' },
    { label: 'Claude Code', dir: path.join(home, '.claude', 'projects') },
    { label: 'opencode', dir: path.join(home, '.local', 'share', 'opencode') }, // 数据根（opencode.db 所在；.config 只有配置）
    { label: 'Codex', dir: path.join(home, '.codex', 'sessions') },
    { label: '用户主目录', dir: home },
    { label: '当前目录', dir: process.cwd() },
  ];
  return candidates.filter(c => {
    if (!c.dir) return true;
    try { return existsSync(c.dir); } catch { return false; }
  });
}
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
  const candidates = process.env.SCORE_TUI_BROWSER
    ? [process.env.SCORE_TUI_BROWSER]
    : process.platform === 'darwin' ? ['open']
    : wsl ? ['wslview', 'explorer.exe'] // WSL 未装 wslu（wslview）时回退 explorer.exe
    : ['xdg-open'];
  // ENOENT 是 spawn 的异步 error 事件（同步 try/catch 接不住，未挂 handler 会炸进程）
  const tryAt = (i: number): void => {
    if (i >= candidates.length) return; // 全部落空：URL 仍回显状态行
    try {
      const child = spawn(candidates[i], [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => tryAt(i + 1));
      child.unref();
    } catch { tryAt(i + 1); }
  };
  tryAt(0);
}

// ── 手绘定高框：每帧行数逐框同构（差分渲染零重排机会）────────────────────────
function drawFrame(title: string, color: (s: string) => string, rows: string[], w: number, h: number): string[] {
  const inner = Math.max(8, w - 4);
  const head = title ? `─ ${title} ` : '';
  const top = `╭${head}${'─'.repeat(Math.max(1, w - 2 - visibleWidth(head)))}╮`;
  const bottom = `╰${'─'.repeat(w - 2)}╯`;
  const rail = color('│ ');
  const railR = color(' │');
  const out = [color(top)];
  for (let i = 0; i < h - 2; i++) {
    const r = rows[i];
    if (r == null) { out.push(`${rail}${' '.repeat(inner)}${railR}`); continue; }
    const content = truncW(r, inner);
    const pad = Math.max(0, inner - visibleWidth(content));
    out.push(`${rail}${content}${' '.repeat(pad)}${railR}`);
  }
  out.push(color(bottom));
  return out;
}

// ── 数据形状 ─────────────────────────────────────────────────────────────────
interface SessionRow {
  taskId: string; framework: string; startTime: Date; endTime: Date | null; totalTokens: number;
  totalSubagentCount: number; query: string | null; label?: string | null; model?: string | null; version?: string | null;
  totalInputTokens?: number; totalOutputTokens?: number; totalCacheReadTokens?: number;
  totalCost?: number; totalLatencyMs?: number; totalToolCallCount?: number; totalLlmCallCount?: number; totalSkillLoadCount?: number;
}
interface DirSessionRow {
  id: string; source: string; filePath: string; framework: string | null;
  createdAt: string; endedAt?: string | null; turnCount: number; modelName: string | null;
  firstQuery: string | null; totalTokens?: number | null; version?: string | null;
}
interface BatchResult {
  taskId: string; framework: string | null; card: Scorecard | null; error: string | null;
  durationMs: number; restored?: boolean;
}
export interface ScoreTuiProps {
  initialSession?: { taskId: string; framework?: string | null };
  concurrency?: number;
  timeoutMs?: number;
  workdir?: string;
  saveDir?: string;
}
type FlatRow =
  | { k: 'source'; v: 'db' | 'dir' }
  | { k: 'dirQuick'; idx: number }
  | { k: 'session'; idx: number }
  | { k: 'tool'; v: MateAgentTool }
  | { k: 'run' };
interface QueueItem { id: string; framework: string | null; filePath: string; source: string }

export interface ScoreAppOptions {
  cols: () => number;
  rows: () => number;
  requestRender: () => void;
  onQuit: () => void;
  props?: ScoreTuiProps;
}

// ── 应用组件 ─────────────────────────────────────────────────────────────────
export class ScoreApp implements Component {
  private cols: () => number;
  private rows: () => number;
  private rq: () => void;
  private quit: () => void;
  private props: ScoreTuiProps;
  private saveDir: string;

  // 配置态
  private sourceMode: 'db' | 'dir' = 'db';
  private sessions: SessionRow[] = [];
  private loadingSessions = true;
  private quicks: Array<{ label: string; dir: string }> = [];
  private dirInput = '';
  private dirFocus = false;
  private dirSessions: DirSessionRow[] | null = null; // null = 未扫描
  private scanning = false;
  private dbSelected = new Set<string>();
  private dirSelected = new Set<string>();
  private filterText = '';
  private filterFocus = false;
  private tools: MateAgentTool[] = [];
  private toolIdx = 0;

  // 光标与焦点
  private cursor = 0;
  private focus: 'left' | 'right' = 'left';
  private cardScroll = 0;
  private rightSel = 0;
  private detailIdx: number | null = null;
  private rightSub: 'list' | 'card' = 'list';

  // 运行态
  private runPhase: 'idle' | 'running' | 'done' = 'idle';
  private phase: 'rule' | 'mate' = 'rule';
  private progress: { done: number; total: number; current: string } | null = null;
  private batchIndex = 0;
  private sessionT0: number | null = null; // 当前会话起点（①区已用秒数）
  private livenessTimer: ReturnType<typeof setInterval> | null = null; // 每秒重绘（走钟）
  private currentId: string | null = null;
  private queue: QueueItem[] = [];
  private results: BatchResult[];
  private savedTo: string | null = null;
  private jumpUrl: string | null = null;
  private jumpNote: string | null = null; // 跳转附注（服务未启动等）
  private cardMax = 0;

  constructor(opts: ScoreAppOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.rq = opts.requestRender;
    this.quit = opts.onQuit;
    this.props = opts.props ?? {};
    this.saveDir = this.props.saveDir ?? defaultSaveDir();
    this.results = loadSavedResults(this.saveDir); // 重开回看
  }

  /** Component 契约：无内部渲染缓存（render 纯粹由状态推导），失效即空操作 */
  invalidate(): void { /* no-op */ }

  /** 异步装载：本机库会话 + 快捷目录 + 工具探测（构造后调用一次）*/
  init(): void {
    this.quicks = quickDirs();
    this.tools = detectMateAgentTools();
    if (this.tools.length === 0) this.tools = []; // 保持空态提示
    prisma.session.findMany({
      orderBy: { startTime: 'desc' },
      take: 200,
      select: { taskId: true, framework: true, startTime: true, endTime: true, totalTokens: true, totalSubagentCount: true, query: true, label: true, model: true, version: true, totalInputTokens: true, totalOutputTokens: true, totalCacheReadTokens: true, totalCost: true, totalLatencyMs: true, totalToolCallCount: true, totalLlmCallCount: true, totalSkillLoadCount: true },
    }).then(rows => {
      this.sessions = rows as SessionRow[];
      this.loadingSessions = false;
      const init = this.props.initialSession;
      if (init) {
        const row = rows.find(r => r.taskId === init.taskId && (init.framework == null || r.framework === init.framework));
        if (row) this.dbSelected = new Set([`${row.taskId}:${row.framework}`]);
      }
      this.clampCursor();
      this.rq();
    }).catch(() => { this.loadingSessions = false; this.rq(); });
    this.rq();
  }

  // ── 派生：过滤与会话键 ──────────────────────────────────────────────────────
  private get lc() { return this.filterText.trim().toLowerCase(); }
  private get filteredSessions(): SessionRow[] {
    const l = this.lc;
    return !l ? this.sessions : this.sessions.filter(s =>
      [s.taskId, s.framework, s.query ?? ''].some(v => v.toLowerCase().includes(l)));
  }
  private get filteredDirSessions(): DirSessionRow[] {
    const l = this.lc;
    const all = this.dirSessions ?? [];
    return !l ? all : all.filter(s =>
      [s.id, s.source, s.modelName ?? '', s.firstQuery ?? ''].some(v => v.toLowerCase().includes(l)));
  }
  private get activeSessions(): Array<SessionRow | DirSessionRow> {
    return this.sourceMode === 'db' ? this.filteredSessions : this.filteredDirSessions;
  }
  private get activeSelected(): Set<string> {
    return this.sourceMode === 'db' ? this.dbSelected : this.dirSelected;
  }
  private sessionKey(r: SessionRow | DirSessionRow): string {
    return 'taskId' in r ? `${r.taskId}:${r.framework}` : `${r.id}:${r.source}`;
  }

  // ── 拍平行（跨分区连续光标）────────────────────────────────────────────────
  private get flatRows(): FlatRow[] {
    const out: FlatRow[] = [
      { k: 'source', v: 'db' },
      { k: 'source', v: 'dir' },
    ];
    if (this.sourceMode === 'dir') this.quicks.forEach((_, idx) => out.push({ k: 'dirQuick', idx }));
    this.activeSessions.forEach((_, idx) => out.push({ k: 'session', idx }));
    this.tools.forEach(t => out.push({ k: 'tool', v: t }));
    out.push({ k: 'run' });
    return out;
  }
  private clampCursor(): void {
    this.cursor = Math.min(this.cursor, Math.max(0, this.flatRows.length - 1));
  }
  private sectionStarts(): number[] {
    const sectionOf = (r: FlatRow) => r.k === 'source' ? 0 : r.k === 'dirQuick' ? 1 : r.k === 'session' ? 2 : r.k === 'tool' ? 3 : 4;
    const starts: number[] = [];
    let last = -1;
    this.flatRows.forEach((r, i) => { const sec = sectionOf(r); if (sec !== last) { starts.push(i); last = sec; } });
    return starts;
  }

  // ── 目录扫描（注册表单点发现）──────────────────────────────────────────────
  private scanDir(dir: string): void {
    this.scanning = true;
    this.rq();
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
                createdAt: s.createdAt, endedAt: s.endedAt ?? null, turnCount: s.turnCount,
                modelName: s.modelName, firstQuery: s.firstQuery, totalTokens: s.totalTokens ?? null, version: s.version ?? null,
              });
            }
          } catch { /* 单源失败不炸整个扫描 */ }
        }
      }
      found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      this.dirSessions = found;
      this.dirSelected = new Set();
    } finally {
      this.scanning = false;
      this.clampCursor();
      this.rq();
    }
  }

  // ── 评分执行（批量顺序：未导入先导入，完成即默认落盘）──────────────────────
  private startRun(): void {
    const tool = this.tools[this.toolIdx];
    if (!tool || this.runPhase === 'running') return;
    const chosen: QueueItem[] = [];
    if (this.sourceMode === 'db') {
      for (const r of this.sessions.filter(r => this.dbSelected.has(this.sessionKey(r)))) {
        chosen.push({ id: r.taskId, framework: r.framework, filePath: '', source: '' });
      }
      if (chosen.length === 0) {
        const cur = this.flatRows[this.cursor];
        if (cur?.k === 'session') {
          const s = this.filteredSessions[cur.idx];
          if (s) chosen.push({ id: s.taskId, framework: s.framework, filePath: '', source: '' });
        }
      }
    } else {
      for (const r of (this.dirSessions ?? []).filter(r => this.dirSelected.has(this.sessionKey(r)))) {
        chosen.push({ id: r.id, framework: r.framework, filePath: r.filePath, source: r.source });
      }
    }
    if (chosen.length === 0) return;
    this.queue = chosen;
    this.runPhase = 'running';
    this.startLiveness();
    // 历史保留：只摘除本轮重评的会话（完成后新结果补位），其余 ↺ 历史行不动
    const chosenIds = new Set(chosen.map(c => c.id));
    this.results = this.results.filter(r => !chosenIds.has(r.taskId));
    this.savedTo = null;
    this.detailIdx = null;
    this.cardScroll = 0;
    this.rightSel = 0;
    this.rightSub = 'list';
    this.focus = 'right';
    this.rq();
    void this.runQueue();
  }

  private async runQueue(): Promise<void> {
    const tool = this.tools[this.toolIdx];
    const queueIds = new Set(this.queue.map(q => q.id));
    const collected: ScoreEvent[] = [];
    const outcomes: BatchResult[] = [];
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      this.batchIndex = i;
      this.currentId = item.id;
      this.phase = 'rule';
      this.progress = null;
      this.rq();
      const t0 = Date.now();
      this.sessionT0 = t0;
      const sessionStart = collected.length;
      try {
        let fw = item.framework ?? undefined;
        if (item.filePath) {
          const existing = await prisma.session.findFirst({ where: { taskId: item.id }, select: { framework: true } });
          if (!existing) await importSession(item.filePath, item.id, prisma, item.filePath, item.source);
          fw = (await prisma.session.findFirst({ where: { taskId: item.id }, select: { framework: true } }))?.framework ?? undefined;
        }
        const code = await runMateScoreFlow(
          { session: item.id, framework: fw, tool, concurrency: this.props.concurrency, timeoutMs: this.props.timeoutMs, workdir: this.props.workdir, store: true },
          e => {
            collected.push(e);
            if (e.type === 'progress') {
              this.phase = 'mate';
              this.progress = { done: e.done as number, total: e.total as number, current: e.current as string };
            }
            this.rq();
          },
        );
        const done = collected.slice().reverse().find(e => e.type === 'done') as { card?: Scorecard } | undefined;
        const errEv = collected.slice().reverse().find(e => e.type === 'error') as { message?: string } | undefined;
        const outcome: BatchResult = {
          taskId: item.id, framework: fw ?? null,
          card: code === 0 && done?.card ? done.card : null,
          error: code !== 0 ? (errEv?.message ?? '评分失败') : null,
          durationMs: Date.now() - t0,
        };
        outcomes.push(outcome);
        // 默认落盘：出卡即写 <taskId>.score.jsonl（失败不写，保留上次历史）
        if (outcome.card) {
          try {
            mkdirSync(this.saveDir, { recursive: true });
            const file = scoreFileOf(this.saveDir, item.id);
            writeFileSync(file, collected.slice(sessionStart).map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
            this.savedTo = file;
          } catch { /* 落盘失败不影响评分流程 */ }
        }
      } catch (err) {
        outcomes.push({ taskId: item.id, framework: item.framework ?? null, card: null, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0 });
      }
      this.results = [...this.results.filter(r => !queueIds.has(r.taskId)), ...outcomes];
      this.rq();
    }
    this.runPhase = 'done';
    this.stopLiveness();
    this.rq();
  }

  /** 每秒重绘：规则层长耗时无事件时段，①区已用秒数持续走动 */
  private startLiveness(): void {
    this.stopLiveness();
    this.livenessTimer = setInterval(() => this.rq(), 1000);
  }
  private stopLiveness(): void {
    if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
  }

  private jump(): void {
    const one = this.detailIdx != null && this.results[this.detailIdx]
      ? this.results[this.detailIdx]
      : this.results.length === 1 ? this.results[0] : null;
    const fw = one?.framework
      ?? (this.sourceMode === 'db' ? this.sessions.find(s => this.dbSelected.has(this.sessionKey(s)))?.framework : null);
    const taskId = one?.taskId
      ?? (this.sourceMode === 'db' ? [...this.dbSelected][0]?.split(':')[0] : [...this.dirSelected][0]?.split(':')[0]);
    if (!taskId) return;
    const url = `http://127.0.0.1:${insightPort()}/scoring/${encodeURIComponent(taskId)}${fw ? `?framework=${encodeURIComponent(fw)}` : ''}`;
    this.jumpUrl = url;
    this.jumpNote = null;
    this.rq();
    // 先探测 insight 服务端口再开浏览器：TUI 不启服务（独立执行定位），服务没跑
    // 就不开死链——只回显 URL + 提示
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      this.jumpNote = 'insight 服务未启动 · ./start.sh 后可跳转';
      this.rq();
    };
    try {
      const probe = net.connect({ host: '127.0.0.1', port: Number(insightPort()) });
      probe.setTimeout(400);
      probe.on('connect', () => {
        if (settled) { probe.destroy(); return; }
        settled = true;
        probe.destroy();
        openInBrowser(url);
        this.rq();
      });
      probe.on('timeout', () => { probe.destroy(); fail(); });
      probe.on('error', () => fail());
    } catch { fail(); }
  }

  // ── 键盘 ───────────────────────────────────────────────────────────────────
  handleInput(data: string): void {
    // 输入模式（路径/过滤）行内捕获
    if (this.dirFocus) {
      if (matchesKey(data, 'escape')) { this.dirFocus = false; this.rq(); return; }
      if (matchesKey(data, 'enter')) {
        this.dirFocus = false;
        const v = this.dirInput.trim();
        if (v) this.scanDir(v);
        this.rq(); return;
      }
      if (matchesKey(data, 'backspace') || matchesKey(data, 'delete')) {
        this.dirInput = this.dirInput.slice(0, -1); this.rq(); return;
      }
      if (data.length === 1 && data >= ' ') { this.dirInput += data; this.rq(); return; }
      return;
    }
    if (this.filterFocus) {
      if (matchesKey(data, 'escape')) { this.filterFocus = false; this.filterText = ''; this.clampCursor(); this.rq(); return; }
      if (matchesKey(data, 'enter')) { this.filterFocus = false; this.rq(); return; }
      if (matchesKey(data, 'backspace') || matchesKey(data, 'delete')) {
        this.filterText = this.filterText.slice(0, -1); this.clampCursor(); this.rq(); return;
      }
      if (data.length === 1 && data >= ' ') { this.filterText += data; this.clampCursor(); this.rq(); return; }
      return;
    }
    if (matchesKey(data, 'ctrl+c')) { this.quit(); return; }
    const k = data.length === 1 ? data.toLowerCase() : '';
    if (k === 'q') { this.quit(); return; }
    if (k === 'o') { this.jump(); this.rq(); return; }

    // WASD = 块级（W/S 分区或右栏子块、A/D 左右栏）；↑↓ = 行级
    if (k === 'a' && this.focus === 'right') { this.focus = 'left'; this.rq(); return; }
    if (k === 'd' && this.focus === 'left') { this.focus = 'right'; this.rq(); return; }
    if (k === 'w' || k === 's') {
      const fwd = k === 's';
      if (this.focus === 'right') {
        // 右栏子块切换：S list→card（已载入时），W card→list
        this.rightSub = fwd ? (this.detailIdx != null ? 'card' : this.rightSub) : 'list';
      } else {
        const starts = this.sectionStarts();
        const curSecIdx = starts.findIndex((start, i) =>
          this.cursor >= start && (i === starts.length - 1 || this.cursor < starts[i + 1]));
        const nextIdx = fwd ? Math.min(starts.length - 1, curSecIdx + 1) : Math.max(0, curSecIdx - 1);
        if (curSecIdx >= 0 && nextIdx !== curSecIdx) this.cursor = starts[nextIdx];
      }
      this.rq(); return;
    }

    if (this.focus === 'right') {
      if (this.rightSub === 'card' && this.detailIdx != null) {
        if (matchesKey(data, 'enter')) { this.rightSub = 'list'; this.rq(); return; }
        if (matchesKey(data, 'up')) {
          // 滚到顶再 ↑ → 回②列表（行级跨界续走，与左栏同则）
          if (this.cardScroll > 0) this.cardScroll -= 1;
          else this.rightSub = 'list';
          this.rq(); return;
        }
        if (matchesKey(data, 'down')) { this.cardScroll = Math.min(this.cardMax, this.cardScroll + 1); this.rq(); return; }
        return;
      }
      if (matchesKey(data, 'up')) { this.rightSel = Math.max(0, this.rightSel - 1); this.rq(); return; }
      if (matchesKey(data, 'down')) {
        // ②选到末行再 ↓ → 进③已载入的评分卡（对称跨界）
        if (this.results.length > 0 && this.rightSel >= this.results.length - 1 && this.detailIdx != null) {
          this.rightSub = 'card';
        } else {
          this.rightSel = Math.min(Math.max(0, this.results.length - 1), this.rightSel + 1);
        }
        this.rq(); return;
      }
      if (matchesKey(data, 'enter') && this.results[this.rightSel]?.card) {
        this.detailIdx = this.rightSel; this.cardScroll = 0; this.rightSub = 'card';
      }
      this.rq(); return;
    }

    // 左栏：行级移动 + 行为
    const row = this.flatRows[this.cursor];
    const toggleSession = (s: SessionRow | DirSessionRow | undefined): void => {
      if (!s) return;
      const key = this.sessionKey(s);
      const sel = this.activeSelected;
      if (sel.has(key)) sel.delete(key); else sel.add(key);
    };
    if (matchesKey(data, 'up')) { this.cursor = Math.max(0, this.cursor - 1); this.rq(); return; }
    if (matchesKey(data, 'down')) { this.cursor = Math.min(this.flatRows.length - 1, this.cursor + 1); this.rq(); return; }
    if (data === '/') { this.filterText = ''; this.filterFocus = true; this.rq(); return; }
    if (k === 'x' && this.runPhase === 'running' && row?.k === 'session') {
      // 取消排队：仅未开始的会话（评分中的无法安全中止）
      const sid = this.activeSessions[row.idx];
      const id = sid ? ('taskId' in sid ? sid.taskId : sid.id) : null;
      const qi = id != null ? this.queue.findIndex((q, idx) => idx > this.batchIndex && q.id === id) : -1;
      if (qi > this.batchIndex) this.queue.splice(qi, 1);
      this.rq(); return;
    }
    if (k === 't') {
      const sel = this.activeSelected;
      const keys = this.activeSessions.map(s => this.sessionKey(s));
      const all = sel.size === this.activeSessions.length && this.activeSessions.length > 0;
      sel.clear();
      if (!all) keys.forEach(kk => sel.add(kk));
      this.rq(); return;
    }
    const activate = matchesKey(data, 'enter') || matchesKey(data, 'space');
    if (activate && row) {
      if (row.k === 'source') this.sourceMode = row.v;
      else if (row.k === 'dirQuick') {
        const q = this.quicks[row.idx];
        if (!q.dir) this.dirFocus = true;
        else this.scanDir(q.dir);
      } else if (row.k === 'session') toggleSession(this.activeSessions[row.idx]);
      else if (row.k === 'tool') this.toolIdx = Math.max(0, this.tools.findIndex(t => t === row.v)); // Agent 工具可选（Enter/Space）
      else if (row.k === 'run') this.startRun();
      this.clampCursor();
      this.rq(); return;
    }
    if (matchesKey(data, 'space') && row?.k === 'session') toggleSession(this.activeSessions[row.idx]);
    this.rq();
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────────
  render(width: number): string[] {
    const termW = Math.max(60, width);
    const termH = Math.max(16, this.rows());
    const leftW = Math.min(56, Math.max(36, Math.floor(termW * 0.44)));
    const gap = 1;
    const rightW = Math.max(28, termW - leftW - gap - 2);
    const bodyH = Math.max(12, termH - 4); // 顶栏1 + 主体 + keybar1 + 状态1
    const contentH = bodyH - 2;            // 外框 rails

    const out: string[] = [];
    const title = bold(cyan('Insight Score')) + bold(' · 会话独立评分');
    const action = cyan('[O] 评分页面 ↗');
    const topPad = Math.max(2, termW - visibleWidth(title) - visibleWidth(action));
    out.push(truncW(title + ' '.repeat(topPad) + action, termW));

    const leftCol = this.renderLeft(leftW - 4, contentH);
    const rightCol = this.renderRight(rightW - 4, contentH);
    const leftFrame = drawFrame('', this.focus === 'left' ? cyan : gray, leftCol, leftW, bodyH);
    const rightFrame = drawFrame('', this.focus === 'right' ? cyan : gray, rightCol, rightW, bodyH);
    for (let i = 0; i < bodyH; i++) {
      out.push(truncW((leftFrame[i] ?? '') + ' '.repeat(gap) + (rightFrame[i] ?? ''), termW));
    }

    // 键位提示：WSAD=分块移动（上下分区/子块、左右切栏），↑↓=行级移动——单一心智
    // 模型；全局键进 keybar，上下文键（勾选/全选/过滤/路径输入）留在分区行内就地提示
    const keybar = this.focus === 'right'
      ? 'WSAD 分块移动 · ↑↓ 行移动 · [Enter] 载入/返回 · [O] 评分页 · [Q] 退出'
      : 'WSAD 分块移动 · ↑↓ 行移动 · [Enter] 激活 · [O] 评分页 · [Q] 退出';
    out.push(truncW(gray(keybar), termW));
    const shownFile = this.detailIdx != null && this.results[this.detailIdx]
      ? scoreFileOf(this.saveDir, this.results[this.detailIdx].taskId)
      : this.savedTo;
    out.push(truncW(gray([shownFile ? `jsonl：${shownFile}` : null, this.jumpUrl ? `↗ ${this.jumpUrl}${this.jumpNote ? gray(` · ${this.jumpNote}`) : ''}` : null]
      .filter(Boolean).join(' · ') || ' '), termW));
    return out;
  }

  /** 左栏：来源 / 目录 / 会话 / Agent 工具 / 运行（动态分区高、总高恒定）*/
  private renderLeft(w: number, budget: number): string[] {
    const lines: string[] = [];
    const cur = this.flatRows[this.cursor];
    const isActive = (r: FlatRow): boolean => {
      for (let i = 0; i < this.flatRows.length; i++) {
        const x = this.flatRows[i];
        if (x.k !== r.k) continue;
        if (x.k === 'source' && x.v !== (r as { v?: string }).v) continue;
        if ((x.k === 'dirQuick' || x.k === 'session') && (x as { idx: number }).idx !== (r as { idx: number }).idx) continue;
        if (x.k === 'tool' && x.v !== (r as { v?: string }).v) continue;
        if (i === this.cursor) return true;
      }
      return false;
    };
    const secOf = (r: FlatRow) => r.k === 'source' ? 0 : r.k === 'dirQuick' ? 1 : r.k === 'session' ? 2 : r.k === 'tool' ? 3 : 4;
    const curSec = cur ? secOf(cur) : -1;
    const mkBox = (secIdx: number, t: string, rows: string[]): void => {
      lines.push(...drawFrame(t, curSec === secIdx ? cyan : gray, rows, w, rows.length + 2));
    };

    // 来源
    const srcRows: string[] = [];
    for (const v of ['db', 'dir'] as const) {
      const on = this.sourceMode === v;
      const active = isActive({ k: 'source', v });
      srcRows.push(`${active ? '❯ ' : '  '}${on ? '●' : '○'} ${v === 'db' ? '本机库已导入会话' : '从目录选择（批量）'}`);
    }
    mkBox(0, '来源', srcRows);

    // 目录（dir 模式）
    if (this.sourceMode === 'dir') {
      const dirRows: string[] = [];
      this.quicks.forEach((q, i) => {
        const active = isActive({ k: 'dirQuick', idx: i });
        dirRows.push(`${active ? '❯ ' : '  '}${padEndV(truncV(q.label, 14), 14)} ${gray(truncV(q.dir || 'Enter 输入', Math.max(8, w - 24)))}`);
      });
      if (this.dirFocus) dirRows.push(`路径: ${this.dirInput}█（Enter 扫描 / Esc 取消）`);
      if (this.scanning) dirRows.push('扫描目录中…');
      mkBox(1, '目录', dirRows);
    }

    // 会话（窗口视口 + 光标跟随；行 = 首问 + 时间，光标行下挂详情行补全选择依据）
    const sessLabel = this.sourceMode === 'db'
      ? `会话 ${this.filteredSessions.length}/${this.sessions.length}${this.loadingSessions ? '（加载中…）' : ''}`
      : this.dirSessions == null ? '会话（未扫描）' : `会话 ${this.filteredDirSessions.length}/${this.dirSessions.length}`;
    const sessRows: string[] = [];
    if (this.filterFocus) sessRows.push(`过滤: ${this.filterText}█（Esc 清除）`);
    const curIdx = cur?.k === 'session' ? cur.idx : 0;
    // 会话窗口吃满剩余空间：其余区（来源/目录/工具/运行 + 会话框自身开销）高度先估算
    const dirBoxH = this.sourceMode === 'dir' ? this.quicks.length + (this.dirFocus ? 1 : 0) + (this.scanning ? 1 : 0) + 2 : 0;
    const toolBoxH = Math.max(1, this.tools.length) + 2;
    const sessOverhead = 2 + 1 + 1 + (this.filterFocus ? 1 : 0); // 边框 + 提示行 + 光标详情行 + 过滤行
    const winSize = Math.max(7, budget - (4 + dirBoxH + toolBoxH + 3 + sessOverhead));
    const active = this.activeSessions;
    const winStart = Math.max(0, Math.min(curIdx - 3, Math.max(0, active.length - winSize)));
    active.slice(winStart, winStart + winSize).forEach((s, i) => {
      const gIdx = winStart + i;
      const id = 'taskId' in s ? s.taskId : s.id;
      const check = this.activeSelected.has(this.sessionKey(s)) ? '[x]' : '[ ]';
      const budget = w - 2 - 3 - 1;
      const timeS = fmtTime('taskId' in s ? s.startTime : s.createdAt);
      // 主标签 = 会话内容（首问），空则退回 id——id 是机器名，不足以人肉挑选
      const q = (('taskId' in s ? s.query : s.firstQuery) ?? '').trim();
      const labelW = Math.max(8, budget - timeS.length - 1);
      const label = q ? truncV(q, labelW) : truncV(id, labelW);
      const active2 = isActive({ k: 'session', idx: gIdx });
      sessRows.push(`${active2 ? '❯ ' : '  '}${check} ${padEndV(label, labelW)} ${gray(timeS)}`);
      if (active2) {
        // 光标行详情：id · 来源 · 规模 · 模型（目录模式混多来源，来源标记必选）
        const src = 'taskId' in s ? s.framework : shortSource(s.source);
        const size = 'taskId' in s ? `${fmtTokens(s.totalTokens)} · ${s.totalSubagentCount}ag` : `${s.turnCount}轮`;
        const model = !('taskId' in s) && s.modelName ? ` · ${truncV(s.modelName, 14)}` : '';
        sessRows.push(gray(`     ${truncV(id, Math.max(12, w - 26))} · ${src} · ${size}${model}`));
      }
    });
    if (this.sourceMode === 'dir' && this.dirSessions == null) {
      sessRows.push(' 选上方目录项开始扫描');
    } else if (active.length === 0 && (this.sourceMode === 'db' ? !this.loadingSessions : true)) {
      sessRows.push(this.filterText ? ' 无匹配（Esc 清除过滤）' : this.sourceMode === 'db' ? ' 本机库暂无会话' : ' 目录内未发现会话');
    }
    sessRows.push(' [Space] 勾选  [T] 全选  [/] 过滤');
    mkBox(2, sessLabel, sessRows);

    // Agent 工具（Enter/Space 可选）
    const toolRows: string[] = [];
    this.tools.forEach((t, i) => {
      const on = i === this.toolIdx;
      const act = isActive({ k: 'tool', v: t });
      toolRows.push(`${act ? '❯ ' : '  '}${on ? green('●') : '○'} ${t}`);
    });
    if (this.tools.length === 0) toolRows.push('未探测到 claude / opencode');
    mkBox(3, 'Agent 工具', toolRows);

    // 运行
    const selCount = this.sourceMode === 'db' ? this.dbSelected.size : this.dirSelected.size;
    const runText = this.runPhase === 'running' ? '⏳ 评分中…（右栏看进度）'
      : this.runPhase === 'done' ? '↻ [Enter] 再评一轮'
      : `▶ [Enter] 开始评分${selCount > 0 ? `（已选 ${selCount}）` : this.sourceMode === 'db' ? '（光标会话）' : '（需勾选）'}`;
    const runActive = isActive({ k: 'run' });
    mkBox(4, '运行', [`${runActive ? '❯ ' : '  '}${this.runPhase === 'running' ? yellow(runText) : runText}`]);

    // 定长补齐：行数恒为 budget（差分稳定）
    while (lines.length < budget) lines.push('');
    return lines.slice(0, budget);
  }

/** 会话概览行（右栏 master-detail：信息集对齐观察台 Overview 页）*/
  private buildOverviewRows(sess: SessionRow | DirSessionRow, w: number): string[] {
  const rows: string[] = [];
  const kv = (k: string, v: string) => `${gray(padEndV(k, 7))} ${v}`;
  // 首问折行（最多 3 行）
  const q = (('taskId' in sess ? sess.query : sess.firstQuery) ?? '').trim();
  if (q) {
    let rest = q;
    for (let i = 0; i < 3 && rest; i++) {
      let line = '';
      let width = 0;
      let cut = 0;
      for (const ch of rest) {
        const cw = visibleWidth(ch);
        if (width + cw > w - 8) break;
        line += ch;
        width += cw;
        cut += ch.length;
      }
      rows.push(truncV(line, Math.max(8, w - 8)));
      rest = rest.slice(cut);
      if (i === 2 && rest) rows[rows.length - 1] = truncV(line + '…', Math.max(8, w - 8));
    }
    rows.push(''); // 首问与详情间以空行分区（不画横线——不连边框的横线看起来像框断裂）
  }
  const id = 'taskId' in sess ? sess.taskId : sess.id;
  rows.push(kv('id', truncV(id, Math.max(10, w - 12))));
  const src = 'taskId' in sess
    ? `${sess.framework}${sess.version ? ` · ${truncV(sess.version, 14)}` : ''}`
    : `${shortSource(sess.source)}${sess.version ? ` · ${truncV(sess.version, 14)}` : ''}${sess.filePath ? gray(` · ${truncV(sess.filePath, Math.max(10, w - 34))}`) : ''}`;
  rows.push(kv('来源', src));
  const start = fmtTime('taskId' in sess ? sess.startTime : sess.createdAt);
  const end = ('taskId' in sess ? sess.endTime : sess.endedAt) ?? null;
  const dur = start.includes('—') || !end ? null : new Date(end).getTime() - new Date('taskId' in sess ? sess.startTime : sess.createdAt).getTime();
  rows.push(kv('时间', `${start} → ${end ? fmtTime(end) : '…'}${dur != null && dur > 0 ? gray(` · ${fmtDuration(dur)}`) : ''}`));
  const model = 'taskId' in sess ? sess.model : sess.modelName;
  if (model) rows.push(kv('模型', truncV(model, Math.max(10, w - 12))));
  const tok = sess.totalTokens ?? 0;
  if (tok > 0) {
    const inT = 'totalInputTokens' in sess ? sess.totalInputTokens : undefined;
    const outT = 'totalOutputTokens' in sess ? sess.totalOutputTokens : undefined;
    const cacheT = 'totalCacheReadTokens' in sess ? sess.totalCacheReadTokens : undefined;
    rows.push(kv('Tokens', `${fmtTokens(tok)}${inT || outT || cacheT ? gray(`（in ${fmtTokens(inT ?? 0)} · out ${fmtTokens(outT ?? 0)} · 命中 ${fmtTokens(cacheT ?? 0)}）`) : ''}`));
  } else if (!('taskId' in sess)) {
    rows.push(kv('规模', `${sess.turnCount}轮`));
  }
  if ('taskId' in sess) {
    const cost = sess.totalCost ?? 0;
    const latency = sess.totalLatencyMs ?? 0;
    const llm = sess.totalLlmCallCount ?? 0;
    rows.push(kv('耗时', `${fmtDuration(latency)} 累计时延 · LLM ${llm} 次${cost > 0 ? ` · ${fmtCost(cost)}` : ''}`));
    const tools = sess.totalToolCallCount ?? 0;
    rows.push(kv('活动', `工具 ${tools} 次 · 子代理 ${sess.totalSubagentCount} · skill ${sess.totalSkillLoadCount ?? 0}`));
  } else {
    rows.push(kv('轮次', `${sess.turnCount} 轮`));
  }
  if (this.runPhase === 'running') {
    const elapsed = this.sessionT0 ? Math.floor((Date.now() - this.sessionT0) / 1000) : 0;
    if (this.queue[this.batchIndex]?.id === id) rows.push(kv('状态', yellow(`评分中… ${elapsed}s`)));
    else if (this.queue.some((q, idx) => idx > this.batchIndex && q.id === id)) rows.push(kv('状态', `排队中 · ${gray('[X] 取消')}`));
  }
  const scored = this.results.find(r => r.taskId === id);
  if (scored?.card) {
    const sc = scored.card.framework.totalScore;
    rows.push(kv('已评分', sc != null ? `${scoreColor(sc)((sc * 10).toFixed(1))} / 10（↺ 历史可回看）` : '已评（无总分）'));
  }
  return rows;
}

  /** 光标所在会话（左栏浏览态的 master 端）*/
  private cursorSession(): SessionRow | DirSessionRow | null {
    const cur = this.flatRows[this.cursor];
    return cur?.k === 'session' ? (this.activeSessions[cur.idx] ?? null) : null;
  }

  /** 右栏：idle 预览 / 定高三段（待评分 7 行 · 已完成 8 行 · 评分卡余量）*/
  private renderRight(w: number, contentH: number): string[] {
    const frame = (t: string, active: boolean, rows: string[], h: number) =>
      drawFrame(t, active ? cyan : gray, rows, w, h);
    if (this.runPhase === 'idle' && this.results.length === 0) {
      // master-detail：光标会话概览（信息集对齐观察台 Overview 页）+ 已选清单
      const curSess = this.cursorSession();
      const sel = this.sourceMode === 'db'
        ? this.sessions.filter(s => this.dbSelected.has(this.sessionKey(s)))
        : (this.dirSessions ?? []).filter(s => this.dirSelected.has(this.sessionKey(s)));
      if (curSess) {
        const ovH = Math.min(contentH - 5, this.buildOverviewRows(curSess, w).length + 2);
        const selH = contentH - ovH;
        const pv: string[] = [];
        if (sel.length === 0) {
          pv.push(`已选 0 个 · [Space] 勾选光标会话`);
        } else {
          pv.push(`已选 ${sel.length} 个：`);
          sel.slice(0, Math.max(1, selH - 3)).forEach(s => {
            const id = 'taskId' in s ? s.taskId : s.id;
            const q = 'taskId' in s ? s.query : s.firstQuery;
            pv.push(`• ${truncV(id, 24)} ${truncV(q ?? '', Math.max(8, w - 32))}`);
          });
        }
        return [
          ...frame('概览', this.focus === 'left', this.buildOverviewRows(curSess, w), ovH),
          ...frame('已选', false, pv, selH),
        ];
      }
      const pv: string[] = [];
      if (sel.length === 0) {
        pv.push('左栏 [Space] 勾选会话；本机库模式未勾选时评光标行。');
        pv.push('目录模式先选目录扫描 → 勾选 → 未导入的自动导入再评分。');
      } else {
        pv.push(`已选 ${sel.length} 个：`);
        sel.slice(0, Math.max(2, contentH - 4)).forEach(s => {
          const id = 'taskId' in s ? s.taskId : s.id;
          const q = 'taskId' in s ? s.query : s.firstQuery;
          pv.push(`• ${truncV(id, 30)} ${truncV(q ?? '', Math.max(8, w - 36))}`);
        });
      }
      return frame('预览', false, pv, contentH);
    }

    let qBoxH = 8, dBoxH = 8;
    let cBoxH = contentH - qBoxH - dBoxH;
    if (cBoxH < 6) {
      cBoxH = Math.max(4, Math.floor(contentH * 0.4));
      const rest = contentH - cBoxH;
      dBoxH = Math.max(4, Math.floor(rest * 0.5));
      qBoxH = Math.max(3, rest - dBoxH);
    }
    // idle 概览态：①框加高装下整份概览（③保底 6 行）
    if (this.runPhase === 'idle' && this.focus === 'left' && this.cursorSession()) {
      qBoxH = Math.min(Math.max(qBoxH, 14), contentH - dBoxH - 6);
    }

    // ① 待评分：当前会话 id 独占一行（完整显示），状态/进度独立成行不被挤掉
    const qRows: string[] = [];
    if (this.runPhase === 'running') {
      const curId = this.queue[this.batchIndex]?.id ?? this.currentId ?? '';
      const elapsed = this.sessionT0 ? Math.floor((Date.now() - this.sessionT0) / 1000) : 0;
      const barW = Math.max(12, w - 4);
      qRows.push(yellow(`⏳ ${truncV(curId, Math.max(10, w - 6))}`));
      if (this.phase === 'mate' && this.progress) {
        qRows.push(`[${this.progress.done}/${this.progress.total}] ${truncV(this.progress.current, Math.max(6, w - 18))} · ${elapsed}s`);
        const fill = this.progress.total > 0 ? Math.min(barW, Math.round((this.progress.done / this.progress.total) * barW)) : 0;
        const isegs = Math.max(8, barW);
        qRows.push(barSegments(isegs, i => i < Math.round((this.progress!.done / Math.max(1, this.progress!.total)) * isegs), green));
      } else {
        qRows.push(gray(`规则层计算中… ${elapsed}s`));
        // 不确定进度活动条：规则层无里程碑事件，滑段随每秒走钟移动（活度反馈）
        const segs = Math.max(8, barW);
        const run = Math.max(3, Math.floor(segs / 6));
        const pos = elapsed % Math.max(1, segs - run);
        qRows.push(barSegments(segs, i => i >= pos && i < pos + run, green));
      }
      if (this.queue.length > 1) {
        // 队列总进度：已完成会话数 + 当前会话内进度 折算
        const innerFrac = this.phase === 'mate' && this.progress && this.progress.total > 0 ? this.progress.done / this.progress.total : 0;
        const overall = Math.min(1, (this.batchIndex + innerFrac) / this.queue.length);
        const fill = Math.round(overall * barW);
        const qsegs = Math.max(8, barW);
        qRows.push(gray(`队列 ${Math.min(this.batchIndex + 1, this.queue.length)}/${this.queue.length} `)
          + barSegments(qsegs, i => i < Math.round(overall * qsegs), green));
      }
      const pendSlots = Math.max(0, qBoxH - 2 - 4 - (this.queue.length > 1 ? 1 : 0)); // 预留 id/状态/条/队列条/计数
      this.queue.slice(this.batchIndex + 1, this.batchIndex + 1 + pendSlots).forEach(item => {
        qRows.push(`- ${truncV(item.id, w - 6)}`);
      });
      if (this.queue.length - this.batchIndex - 1 > pendSlots) {
        qRows.push(`- ..共剩 ${this.queue.length - this.batchIndex - 1} 个`);
      }
    } else if (this.runPhase === 'idle') {
      // idle 有历史时 ①框让位给光标会话概览（浏览挑选的主场景）
      const curSess = this.cursorSession();
      if (curSess && this.focus === 'left') {
        qRows.push(...this.buildOverviewRows(curSess, w));
      } else {
        qRows.push('待评分 · 左栏勾选/选会话后 [Enter] 开始');
      }
    } else {
      qRows.push('— 队列已完成 —');
    }

    // ② 已完成（定高视口 + 选中跟随；分数右对齐 4 列）
    const dRows = dBoxH - 2;
    const dRowsArr: string[] = [];
    if (this.results.length === 0) {
      dRowsArr.push('（尚无完成项）');
    } else {
      const rowsVisible = this.results.length > dRows ? dRows - 1 : dRows;
      const maxStart = Math.max(0, this.results.length - rowsVisible);
      const start = Math.min(maxStart, Math.max(0, this.rightSel - (rowsVisible - 2)));
      this.results.slice(start, start + rowsVisible).forEach((r, i) => {
        const idx = start + i;
        const sel = this.focus === 'right' && this.rightSub === 'list' && idx === this.rightSel;
        const loaded = this.detailIdx === idx;
        const score = r.card?.framework.totalScore;
        const mark = loaded ? '▤' : r.restored ? '↺' : r.error ? '✗' : r.card?.framework.veto?.triggered ? '⛔' : '✓';
        const markColor = r.restored && !loaded ? gray : r.error || r.card?.framework.veto?.triggered ? red : green;
        const idW = Math.max(12, w - 36);
        const tail = r.error != null
          ? red(truncV(r.error, Math.max(8, w - idW - 22)))
          : score != null ? `${bar(score, 15)} ${scoreColor(score)((score * 10).toFixed(1).padStart(4))}`
          : '';
        dRowsArr.push(`${sel ? '❯ ' : '  '}${markColor(mark)} ${padEndV(truncV(r.taskId, idW), idW)} ${tail}`);
      });
      if (this.results.length > dRows) dRowsArr.push(`… 共 ${this.results.length} 个`);
    }

    // ③ 评分卡（定高框内滚动；分数列对齐）
    const cRows = cBoxH - 2;
    const cRowsArr: string[] = [];
    const loaded = this.detailIdx != null ? this.results[this.detailIdx] : null;
    if (loaded?.card) {
      const card = loaded.card;
      const fw = card.framework;
      const innerW = w - 4; // 框内容宽（分数区右锚定的列基准）
      const cardLines: string[] = [];
      cardLines.push(bold(cyan(truncV(card.sessionId, w - 2))));
      cardLines.push(gray(`${(loaded.durationMs / 1000).toFixed(1)}s  覆盖率 ${(fw.coverage * 100).toFixed(0)}%`));
      if (fw.veto?.triggered) {
        cardLines.push(red('否决触发：总分归 0'));
      } else if (typeof fw.totalScore === 'number') {
        cardLines.push(this.scoreRow(bold('总分'), fw.totalScore, innerW, bold(' / 10')));
      }
      card.dimensions.forEach(dim => {
        cardLines.push(...this.dimLines(dim, innerW));
      });
      if (fw.coverageGap?.length) {
        cardLines.push(yellow(`未覆盖 ${fw.coverageGap.length} 项`));
      }
      this.cardMax = Math.max(0, cardLines.length - cRows);
      const vis = this.rightSub === 'card' ? Math.min(this.cardScroll, this.cardMax) : 0;
      cardLines.slice(vis, vis + cRows).forEach(l => cRowsArr.push(l));
    } else {
      this.cardMax = 0;
      const curSess = this.cursorSession();
      if (curSess && this.focus === 'left') {
        cRowsArr.push(...this.buildOverviewRows(curSess, w)); // 运行中浏览：③让位概览
      } else if (this.runPhase !== 'running') {
        cRowsArr.push('在已完成列表中 ↑↓ 选择  [Enter] 载入评分卡');
      } else {
        cRowsArr.push(gray('评分完成后在已完成列表 Enter 载入'));
      }
    }

    const lines = [
      ...frame(this.runPhase === 'running'
        ? `待评分（${this.batchIndex + 1}/${this.queue.length}）`
        : this.runPhase === 'idle' && this.cursorSession() && this.focus === 'left' ? '概览（光标会话）' : '待评分',
        this.runPhase === 'running', qRows, qBoxH),
      ...frame(this.results.length > 0
        ? `已完成（${this.results.filter(r => r.card).length}/${this.results.length}）` : '已完成',
        this.focus === 'right' && this.rightSub === 'list', dRowsArr, dBoxH),
      ...frame(this.detailIdx == null && this.cursorSession() && this.focus === 'left' && this.runPhase === 'running'
        ? '概览（光标会话）' : '评分卡',
        this.focus === 'right' && this.rightSub === 'card', cRowsArr, cBoxH),
    ];
    return lines;
  }

  /** 分数区右锚定：分数(4 列) 固定收在 [inner-16, inner-13]，条形图右对齐到
   * inner-17——前缀宽度不参差、verdict 宽度不影响列位。窄框时条宽自适应收缩
   * （保分数列不变），极窄弃条保分数——任何宽度不出框 */
  private scoreRow(prefix: string, score: number, inner: number, tail = ''): string {
    const s = scoreColor(score)((score * 10).toFixed(1).padStart(4));
    const headW = visibleWidth(prefix);
    const scoreStart = inner - 16;
    const barSpace = scoreStart - 1 - headW; // 头之后到条区的可用宽（条 + 间隔）
    if (barSpace - 1 >= 4) {
      const barW = Math.min(26, barSpace - 1);
      const barStart = scoreStart - 1 - barW;
      return `${prefix}${' '.repeat(Math.max(0, barStart - headW))}${bar(score, barW)} ${s}${tail}`;
    }
    if (headW + 1 <= scoreStart - 1) {
      return `${prefix}${' '.repeat(scoreStart - 1 - headW)}${s}${tail}`;
    }
    return truncW(`${prefix} ${s}${tail}`, inner);
  }

  /** 维度块 → 行 */
  private dimLines(dim: DimensionResult, w: number): string[] {
    const head = `${bold(dim.dimensionId)} ${padEndV(truncV(dim.name, 8), 9)}`;
    const out: string[] = [];
    if (dim.status === 'not-applicable') {
      out.push(`${head}  ${gray('不适用')}`);
    } else if (dim.status === 'error') {
      out.push(`${head}  ${red('评算失败')}`);
    } else if (typeof dim.score === 'number') {
      out.push(this.scoreRow(head, dim.score, w, dim.verdict ? gray(`  ${dim.verdict}`) : ''));
    } else {
      const v = dim.verdict ?? '—';
      const color = v === 'clean' || v === '完成' ? green : v === 'violation' || v === '未完成' ? red : yellow;
      out.push(`${head}  ${color(v)}${dim.disclose ? gray(`  ${truncV(dim.disclose, 22)}`) : ''}`);
    }
    dim.items.forEach(it => out.push(this.itemLine(it, w)));
    return out;
  }

  private itemLine(it: SubItemResult, w: number): string {
    const icon = it.status === 'ok' ? '✓' : it.status === 'not-applicable' ? '○' : '✗';
    const iconColor = it.status === 'ok' ? green : it.status === 'not-applicable' ? gray : red;
    const labelW = Math.max(10, Math.min(16, w - 30));
    const parts: string[] = [];
    if (it.value !== undefined && it.value !== null) parts.push(String(it.value));
    if (typeof it.score === 'number') parts.push(`${(it.score * 10).toFixed(1)}分`);
    if (it.verdict) parts.push(it.verdict);
    if (it.note) parts.push(it.note);
    const partsText = truncV(parts.join(' / ') || '-', Math.max(12, w - labelW - 10));
    return `  ${iconColor(icon)} ${padEndV(truncV(it.label, labelW), labelW)}  ${gray(partsText)}`;
  }
}
