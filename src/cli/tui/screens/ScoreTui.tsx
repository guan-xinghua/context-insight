// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS OR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 独立 mate 评分 TUI：选会话 → 选 agent 工具 → 实时进度 → 评分卡展示。
// 与 ctxi score 一次性 CLI 共用 runMateScoreFlow（同一执行流、同一事件词汇），
// 直接读本机库，不需要 insight 服务进程。s 落 jsonl、esc 回选会话、q 退出。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import stringWidth from 'string-width';
import { prisma } from '@/lib/db';
import { detectMateAgentTools, DIM_NAMES, type MateAgentTool } from '@/lib/scoring/mate-agent/runner';
import { runMateScoreFlow, type ScoreEvent } from '@/cli/commands/score';
import { Spinner } from '@/cli/tui/components/Spinner';
import type { Scorecard, DimensionResult, SubItemResult } from '@/lib/scoring';

interface SessionRow {
  taskId: string;
  framework: string;
  startTime: Date;
  totalTokens: number;
  totalSubagentCount: number;
  query: string | null;
}

type Stage = 'session' | 'tool' | 'running' | 'result' | 'error';

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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
  const [stage, setStage] = useState<Stage>(props.initialSession ? 'running' : 'session');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(!props.initialSession);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [tools, setTools] = useState<MateAgentTool[]>([]);
  const [toolCursor, setToolCursor] = useState(0);
  const [picked, setPicked] = useState<{ taskId: string; framework?: string | null; tool: MateAgentTool } | null>(
    props.initialSession ? { taskId: props.initialSession.taskId, framework: props.initialSession.framework ?? undefined, tool: 'claude' } : null,
  );
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [phase, setPhase] = useState<'rule' | 'mate'>('rule');
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [card, setCard] = useState<Scorecard | null>(null);
  const [cardMeta, setCardMeta] = useState<{ tool: string; durationMs: number; aborted?: boolean; failureNote?: string | null } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  // 会话清单（直接读库，按开始时间倒序）
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
      setCursor(0);
      setOffset(0);
    }).catch(err => {
      if (!alive) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStage('error');
    });
    return () => { alive = false; };
  }, [stage]);

  // 工具探测
  useEffect(() => {
    if (stage !== 'tool') return;
    setTools(detectMateAgentTools());
    setToolCursor(0);
  }, [stage]);

  // 执行流（picked 置位即开跑）
  useEffect(() => {
    if (stage !== 'running' || !picked) return;
    let alive = true;
    setEvents([]);
    setPhase('rule');
    setProgress(null);
    setCard(null);
    setSavedTo(null);
    runMateScoreFlow(
      {
        session: picked.taskId,
        framework: picked.framework ?? undefined,
        tool: picked.tool,
        concurrency: props.concurrency,
        timeoutMs: props.timeoutMs,
        workdir: props.workdir,
        store: true,
      },
      e => {
        if (!alive) return;
        setEvents(prev => [...prev, e]);
        if (e.type === 'progress') {
          setPhase('mate');
          setProgress({ done: e.done as number, total: e.total as number, current: e.current as string });
        } else if (e.type === 'done') {
          setCard(e.card as Scorecard);
          setCardMeta({ tool: picked.tool, durationMs: e.durationMs as number, aborted: e.aborted as boolean | undefined, failureNote: e.failureNote as string | null | undefined });
          setStage('result');
        } else if (e.type === 'error') {
          setErrorMsg(String(e.message));
          setStage('error');
        }
      },
    ).catch(err => {
      if (!alive) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStage('error');
    });
    return () => { alive = false; };
  }, [stage, picked, props.concurrency, props.timeoutMs, props.workdir]);

  const saveJsonl = useCallback(() => {
    if (!events.length || !picked) return;
    const file = path.join(props.saveDir ?? process.cwd(), `${picked.taskId.replace(/[^\w.-]/g, '_')}.score.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    setSavedTo(file);
  }, [events, picked, props.saveDir]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }
    if (stage === 'session' && sessions.length > 0) {
      if (key.upArrow) { setCursor(c => { const n = Math.max(0, c - 1); if (n < offset) setOffset(n); return n; }); }
      else if (key.downArrow) {
        setCursor(c => {
          const n = Math.min(sessions.length - 1, c + 1);
          if (n >= offset + VIEW_ROWS) setOffset(n - VIEW_ROWS + 1);
          return n;
        });
      } else if (key.return) {
        const row = sessions[cursor];
        setPicked({ taskId: row.taskId, framework: row.framework, tool: 'claude' });
        setStage('tool');
      }
      return;
    }
    if (stage === 'tool') {
      if (key.upArrow) setToolCursor(c => Math.max(0, c - 1));
      else if (key.downArrow) setToolCursor(c => Math.min(tools.length - 1, c + 1));
      else if (key.return && tools[toolCursor] && picked) {
        setPicked({ ...picked, tool: tools[toolCursor] });
        setStage('running');
      } else if (key.escape) setStage('session');
      return;
    }
    if (stage === 'result') {
      if (input === 's') saveJsonl();
      else if (key.escape) setStage('session');
    } else if (stage === 'error' && key.escape) {
      setStage('session');
    }
  });

  const window = useMemo(() => sessions.slice(offset, offset + VIEW_ROWS), [sessions, offset]);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">Mate Score TUI</Text>
      <Text color="gray">────────────────────────────────────────────────────────────</Text>

      {stage === 'session' && (
        <Box flexDirection="column">
          <Text bold>选择会话{loadingSessions ? '（加载中…）' : `（${sessions.length} 个，↑↓ 移动 · Enter 确认）`}</Text>
          <Text color="gray">{padEndV('Task ID', 38)} {padEndV('FW', 16)} {padEndV('Tokens', 8)} Subs  Query</Text>
          {window.map((row, i) => {
            const idx = offset + i;
            const selected = idx === cursor;
            return (
              <Text key={`${row.taskId}:${row.framework}`} color={selected ? 'cyan' : undefined} inverse={selected}>
                {selected ? '❯ ' : '  '}{padEndV(truncV(row.taskId, 37), 38)} {padEndV(truncV(row.framework, 15), 16)} {padEndV(fmtTokens(row.totalTokens), 8)} {padEndV(String(row.totalSubagentCount), 5)}  {truncV(row.query ?? '', 24)}
              </Text>
            );
          })}
        </Box>
      )}

      {stage === 'tool' && (
        <Box flexDirection="column">
          <Text bold>选择 mate agent 工具（↑↓ · Enter · Esc 返回）</Text>
          <Text color="gray">会话：{picked?.taskId}（{picked?.framework ?? '—'}）</Text>
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
          <Text bold>评分中：{picked.taskId} · 工具 {picked.tool}</Text>
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
          <Text color="gray">[s] 保存 jsonl{savedTo ? `（已保存 ${savedTo}）` : ''} · [Esc] 重选会话 · [q] 退出</Text>
        </Box>
      )}

      {stage === 'error' && (
        <Box flexDirection="column">
          <Text color="red">出错：{errorMsg}</Text>
          <Text color="gray">[Esc] 重选会话 · [q] 退出</Text>
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
