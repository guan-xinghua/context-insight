// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// pi-tui PoC：ScoreTui 双栏布局在新框架下的等价复刻（mock 数据 + 模拟评分流）。
// 验证点：render(width)→string[] 契约、定高框、WASD/↑↓ 导航、CJK 宽度、差分渲染。
import {
  ProcessTerminal, TuiAltScreen, matchesKey,
  visibleWidth, truncateToWidth,
} from '@earendil-works/pi-tui';

// ── 颜色（内联 SGR：pi-tui 的 visibleWidth 会剥掉终端序列再测宽）──────────────
const C = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const cyan = (s: string) => C('36', s);
const gray = (s: string) => C('90', s);
const green = (s: string) => C('32', s);
const magenta = (s: string) => C('35', s);
const yellow = (s: string) => C('33', s);
const red = (s: string) => C('31', s);
const bold = (s: string) => C('1', s);

// ── 手绘框（ScoreTui drawFrame 的移植：定高 + ANSI 感知测宽）─────────────────
function drawFrame(title: string, color: (s: string) => string, rows: string[], w: number, h: number): string[] {
  const inner = Math.max(8, w - 4);
  const head = `─ ${title} `;
  const top = `╭${head}${'─'.repeat(Math.max(1, w - 2 - visibleWidth(head)))}╮`;
  const bottom = `╰${'─'.repeat(w - 2)}╯`;
  const rail = color('│ ');
  const railR = color(' │');
  const body = rows.slice(0, Math.max(0, h - 2));
  const out = [color(top)];
  for (let i = 0; i < h - 2; i++) {
    const r = body[i];
    if (r == null) { out.push(`${rail}${' '.repeat(inner)}${railR}`); continue; }
    const content = truncateToWidth(r, inner);
    const pad = Math.max(0, inner - visibleWidth(content));
    out.push(`${rail}${content}${' '.repeat(pad)}${railR}`);
  }
  out.push(color(bottom));
  return out;
}

// ── mock 数据 ────────────────────────────────────────────────────────────────
interface MockSession { id: string; time: string; tokens: string; query: string }
const SESSIONS: MockSession[] = [
  { id: 'poc-sid-001', time: '11-03 18:00', tokens: '6.2k', query: '给 utils 加乘法并跑测试' },
  { id: '310d62ba-99..', time: '10-30 16:59', tokens: '22.7M', query: '修复子代理过滤' },
  { id: '5bea9a13-de..', time: '10-27 21:13', tokens: '463.6M', query: '评分卡渲染优化' },
];
const TOOLS = ['claude', 'opencode'];
const MOCK_CARD = {
  sessionId: 'poc-sid-001',
  coverage: 0.73, totalScore: 0.66,
  dims: [
    { id: 'D1', name: '完成度', score: 0.7, items: [{ label: '目标覆盖对账', text: '7.0分 · partial · 目标达成' }] },
    { id: 'D3', name: '正确性', score: 0.9, items: [{ label: '正确性', text: '9.0分 · partial · 测试通过' }] },
    { id: 'D6', name: '自主性', score: 0.5, items: [{ label: '用户打断', text: '2 · 8.0分' }] },
  ],
};

// ── 应用组件 ─────────────────────────────────────────────────────────────────
export class ScorePoc {
  rows: number;
  private onQuit: () => void;
  private focus: 'left' | 'right' = 'left';
  private cursor = 0; // 拍平行：0=本机库 1=目录 2..n=会话 n+1..=工具 末=运行
  private checked = new Set<string>();
  private toolIdx = 0;
  private runPhase: 'idle' | 'running' | 'done' = 'idle';
  private progress = { done: 0, total: 5 };
  private cardScroll = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private cardMax = 0;

  constructor(rows: number, onQuit: () => void) {
    this.rows = rows;
    this.onQuit = onQuit;
  }

  private get flatLen() { return 2 + SESSIONS.length + TOOLS.length + 1; }

  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+c')) { this.onQuit(); return; }
    const k = data.length === 1 ? data.toLowerCase() : '';
    if (k === 'q') { this.onQuit(); return; }
    if (k === 'a' && this.focus === 'right') { this.focus = 'left'; return; }
    if (k === 'd' && this.focus === 'left') { this.focus = 'right'; return; }
    if (k === 'w' || k === 's') {
      const fwd = k === 's';
      if (this.focus === 'left') {
        // 分区跳：来源(0) → 会话(2) → 工具(2+len) → 运行(末)
        const bounds = [0, 2, 2 + SESSIONS.length, this.flatLen - 1];
        const cur = bounds.findIndex((b, i) => this.cursor >= b && (i === bounds.length - 1 || this.cursor < bounds[i + 1]));
        const next = fwd ? Math.min(bounds.length - 1, cur + 1) : Math.max(0, cur - 1);
        if (cur >= 0 && next !== cur) this.cursor = bounds[next];
      }
      return;
    }
    if (matchesKey(data, 'up')) { if (this.focus === 'left') this.cursor = Math.max(0, this.cursor - 1); else this.cardScroll = Math.max(0, this.cardScroll - 1); return; }
    if (matchesKey(data, 'down')) {
      if (this.focus === 'left') this.cursor = Math.min(this.flatLen - 1, this.cursor + 1);
      else this.cardScroll = Math.min(this.cardMax, this.cardScroll + 1);
      return;
    }
    if (matchesKey(data, 'space') || matchesKey(data, 'enter')) {
      if (this.cursor >= 2 && this.cursor < 2 + SESSIONS.length) {
        const s = SESSIONS[this.cursor - 2];
        if (this.checked.has(s.id)) this.checked.delete(s.id); else this.checked.add(s.id);
      } else if (this.cursor === this.flatLen - 1 && this.runPhase === 'idle') {
        this.startRun();
      }
    }
  }

  private startRun(): void {
    this.runPhase = 'running';
    this.progress = { done: 0, total: 5 };
    this.tick = setInterval(() => {
      this.progress.done += 1;
      if (this.progress.done >= this.progress.total) {
        if (this.tick) clearInterval(this.tick);
        this.tick = null;
        this.runPhase = 'done';
      }
    }, 300);
  }

  render(width: number): string[] {
    const leftW = Math.max(40, Math.min(56, Math.floor(width * 0.42)));
    const termRows = this.rows;
    const bodyH = Math.max(12, termRows - 4);
    const title = bold(cyan('Insight Score')) + bold(' · 会话独立评分');
    const action = cyan('[o] 评分页面 ↗');
    const topPad = Math.max(2, width - visibleWidth(title) - visibleWidth(action));
    const out: string[] = [title + ' '.repeat(topPad) + action];

    // 左栏：来源 / 会话 / 工具 / 运行（每帧行数恒定）
    const qRows = (start: number, end: number, height: number, title2: string, rows2: string[]) =>
      drawFrame(title2, (s) => (this.cursor >= start && this.cursor < end && this.focus === 'left' ? cyan(s) : gray(s)), rows2, leftW, height);
    const srcRows = SESSIONS.length + 1;
    const toolStart = 2 + SESSIONS.length;
    const src = qRows(0, 2, srcRows + 2, '来源', [
      `${this.cursor === 0 ? '❯ ' : '  '}● 本机库已导入会话`,
      `${this.cursor === 1 ? '❯ ' : '  '}○ 从目录选择（批量）`,
    ]);
    const sess = qRows(2, toolStart, SESSIONS.length + 3, `会话 ${SESSIONS.length}/${SESSIONS.length}`, SESSIONS.map((s, i) => {
      const cur = this.cursor === 2 + i;
      const check = this.checked.has(s.id) ? '[x]' : '[ ]';
      return `${cur ? '❯ ' : '  '}${check} ${s.id} ${gray(s.time)}`;
    }).concat(['  [Space] 勾选  [t] 全选  [/] 过滤']));
    const tools = qRows(toolStart, toolStart + TOOLS.length, TOOLS.length + 2, 'Agent 工具',
      TOOLS.map((t, i) => `${this.cursor === toolStart + i ? '❯ ' : '  '}${this.toolIdx === i ? '●' : '○'} ${t}`));
    const runH = bodyH - src.length - sess.length - tools.length;
    const runTxt = this.runPhase === 'running' ? '⏳ 评分中…（右栏看进度）'
      : this.runPhase === 'done' ? '↻ [Enter] 再评一轮' : `▶ [Enter] 开始评分（已选 ${this.checked.size}）`;
    const run = drawFrame('运行', (s) => (this.cursor === this.flatLen - 1 && this.focus === 'left' ? cyan(s) : gray(s)),
      [`${this.cursor === this.flatLen - 1 ? '❯ ' : '  '}${runTxt}`], leftW, runH);

    // 右栏：定高三框 ①7 ②8 ③余量
    const rightW = width - leftW - 1;
    let qBoxH = 7, dBoxH = 8;
    let cBoxH = bodyH - 2 - qBoxH - dBoxH;
    if (cBoxH < 6) { cBoxH = Math.max(4, Math.floor((bodyH - 2) * 0.4)); const rest = bodyH - 2 - cBoxH; dBoxH = Math.max(4, Math.floor(rest * 0.5)); qBoxH = Math.max(3, rest - dBoxH); }
    const rInner = rightW;
    const rFrame = (t: string, active: boolean, rows2: string[], h: number) =>
      drawFrame(t, active ? cyan : gray, rows2, rInner, h);
    let q: string[], d: string[], c: string[];
    if (this.runPhase === 'idle') {
      q = rFrame('待评分', false, ['待评分 · 左栏勾选/选会话后 [Enter] 开始'], qBoxH);
      d = rFrame('已完成', false, ['（尚无完成项）'], dBoxH);
    } else {
      const barW = rInner - 4;
      const fill = Math.round((this.progress.done / this.progress.total) * barW);
      const bar = green('█'.repeat(fill)) + magenta('░'.repeat(barW - fill));
      q = rFrame(this.runPhase === 'running' ? `待评分（1/1）` : '待评分（完成）', this.runPhase === 'running',
        this.runPhase === 'running'
          ? [yellow(`⏳ poc-sid-001 [${this.progress.done}/${this.progress.total}] D2 行为可信`), bar]
          : ['— 队列已完成 —'], qBoxH);
      d = rFrame(this.runPhase === 'done' ? '已完成（1/1）' : '已完成',
        this.runPhase === 'done' && this.focus === 'right',
        [`${this.runPhase === 'done' ? '❯ ✓ poc-sid-001 ' : '  … poc-sid-001 '}${this.runPhase === 'done' ? bar.slice(0, 10) + ' 6.6' : ''}`], dBoxH);
    }
    // ③ 评分卡（框内滚动）
    const cardLines: string[] = [
      bold(cyan(MOCK_CARD.sessionId)),
      `0.8s  覆盖率 ${(MOCK_CARD.coverage * 100).toFixed(0)}%`,
      `总分 ${bar16(MOCK_CARD.totalScore)} ${bold('6.6 / 10')}`,
    ];
    for (const dim of MOCK_CARD.dims) {
      cardLines.push(`${bold(dim.id)} ${dim.name} ${bar16(dim.score)} ${(dim.score * 10).toFixed(1)}`);
      for (const it of dim.items) cardLines.push(gray(`  ✓ ${it.label}  ${it.text}`));
    }
    this.cardMax = Math.max(0, cardLines.length - (cBoxH - 2));
    const vis = this.focus === 'right' ? Math.min(this.cardScroll, this.cardMax) : 0;
    c = rFrame('评分卡', this.focus === 'right', cardLines.slice(vis, vis + cBoxH - 2).concat(
      Array.from({ length: Math.max(0, cBoxH - 2 - cardLines.length) }, () => '')), cBoxH);

    // 左右拼列（行数恒定 bodyH）
    const leftCol = [...src, ...sess, ...tools, ...run];
    const rightCol = [...q, ...d, ...c];
    for (let i = 0; i < bodyH; i++) {
      const l = leftCol[i] ?? ' '.repeat(leftW);
      const r = rightCol[i] ?? '';
      out.push(`${l} ${r}`);
    }
    out.push(truncateToWidth(gray(this.focus === 'right'
      ? '[W/S] 切列表/评分卡 · [↑↓] 滚动 · [A] 回配置 · [Enter] 载入 · [q] 退出'
      : '[W/S] 切分区 · [A/D] 左右栏 · [↑↓] 行移动 · [Space] 勾选 · [Enter] 开始 · [q] 退出'), width));
    out.push(gray(' '));
    return out;
  }
}

function bar16(score: number): string {
  const filled = Math.max(0, Math.min(16, Math.round(score * 16)));
  const color = score >= 0.8 ? green : score >= 0.6 ? yellow : red;
  return color('█'.repeat(filled)) + magenta('░'.repeat(16 - filled));
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('demo.ts') || process.argv[1]?.endsWith('demo.js')) {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const quit = () => { tui.stop(); process.exit(0); };
  const app = new ScorePoc(terminal.rows, quit);
  tui.addChild(app as never); // Component 契约：render/handleInput
  tui.setFocus(app as never);
  tui.start();
}
