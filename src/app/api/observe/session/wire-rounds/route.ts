// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { isClaudeFormatSession } from '@/lib/shared/session-format';
import { parseJsonlLines } from '@/lib/ingest/adapters/claude-jsonl';

// Wire-rounds view: rebuild each WIRE REQUEST directly from the capture
// jsonl, independent of the DB/import pipeline. The file stores each message
// once (delta), so a round's request = the messages accumulated before its
// assistant response line(s) — exactly what the agent sent on the wire.
// This is the ground-truth view to compare against the LLM Input tab (which
// reconstructs from imported DB turns).
// verbatim: no server-side truncation — the client collapses per message
// with an expand toggle (like the Turns tab)
//
// ?delta=1：每轮只回 requestMessages[newFrom..]（新增段，append-only 历史
// 的增量），客户端按 newFrom 前缀拼接还原快照。全量快照是 O(N²) 复制——
// 数千轮会话（4408 轮实测）直接爆 V8 字符串上限（"Invalid string length"）。

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    const full = searchParams.get('full') === '1';
    const delta = searchParams.get('delta') === '1';
    if (!taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    const session = await prisma.session.findFirst({
      where: { taskId },
      select: { id: true, sourcePath: true, framework: true, version: true },
      orderBy: { startTime: 'desc' },
    });
    if (!session || !session.sourcePath) {
      return NextResponse.json({ error: 'Session or sourcePath not found' }, { status: 404 });
    }
    if (!isClaudeFormatSession(session.framework, session.version)) {
      return NextResponse.json({ error: 'Only claude-format sessions (claude-code or proxy capture) have a wire capture' }, { status: 400 });
    }

    const lines = parseJsonlLines(session.sourcePath);
    const preview = (s: string): { json: string; truncated: boolean; chars: number } => ({
      json: s,
      truncated: false,
      chars: s.length,
    });

    interface WireMessage { role: string; content: ReturnType<typeof preview>; timestamp: string | null }
    const rounds: Array<{
      index: number;
      timestamp: string | null;
      model: string | null;
      usage: { input?: number; output?: number } | null;
      // requestMessages[0..newFrom) carried over from the previous round;
      // [newFrom..) are NEW in this round (append-only wire history)
      newFrom: number;
      requestMessages: WireMessage[];
      response: { content: ReturnType<typeof preview>; blocks: string[]; text: string };
    }> = [];

    const history: Array<{ role: string; content: string; timestamp: string | null }> = [];
    let pending: { msgsSnapshot: WireMessage[]; blocks: unknown[]; model: string | null; usage: unknown; ts: string | null; text: string; xb?: { schema?: string; version?: number; data?: { roundIndex?: number } } } | null = null;
    // 上一轮全量快照长度（newFrom 基准）。不能回读 rounds[last].requestMessages.length
    // ——delta 模式下那里存的是截断后的增量，回读会让 newFrom 指错位置，
    // slice 失效退回 O(N²) 全量复制（实测 4.4MB 捕获仍爆 V8 上限）
    let prevSnapshotLen = 0;

    const snapshot = (): WireMessage[] => history.map(h => ({ role: h.role, content: preview(h.content), timestamp: h.timestamp }));

    // wire 源 usage 是 anthropic 风格 input_tokens/output_tokens，页面口径是 input/output
    const usageOf = (u: unknown): { input?: number; output?: number } | null => {
      if (!u || typeof u !== 'object') return null;
      const r = u as { input_tokens?: number; output_tokens?: number; input?: number; output?: number };
      return { input: r.input_tokens ?? r.input, output: r.output_tokens ?? r.output };
    };

    const closeRound = () => {
      if (!pending) return;
      // roundIndex 权威化（spec §4.1 "wire 轮次对齐权威键"）：x_cannbay.data.roundIndex
      // 优先；缺失（legacy 文件 / 老 norm）回退数组序号（rounds.length + 1）
      const xbRound = pending.xb ? (pending.xb.schema === 'cc-wire-round' && pending.xb.version === 1 ? pending.xb.data?.roundIndex : undefined) : undefined;
      const newFrom = prevSnapshotLen;
      rounds.push({
        index: xbRound ?? rounds.length + 1,
        timestamp: pending.ts,
        model: pending.model,
        usage: usageOf(pending.usage),
        newFrom,
        requestMessages: delta ? pending.msgsSnapshot.slice(newFrom) : pending.msgsSnapshot,
        response: {
          content: preview(JSON.stringify(pending.blocks)),
          blocks: pending.blocks.map(b => (b as { type?: string })?.type ?? '?'),
          text: pending.text.slice(0, 300),
        },
      });
      history.push({ role: 'assistant', content: JSON.stringify(pending.blocks), timestamp: pending.ts });
      prevSnapshotLen = pending.msgsSnapshot.length;
      pending = null;
    };

    for (const line of lines) {
      if (line.type === 'assistant' && line.message) {
        if (!pending) {
          const xb = (line as { x_cannbay?: { schema?: string; version?: number; data?: { roundIndex?: number } } }).x_cannbay;
          pending = { msgsSnapshot: snapshot(), blocks: [], model: line.message.model ?? null, usage: line.message.usage ?? null, ts: line.timestamp ?? null, text: '', xb };
        }
        const blocks = Array.isArray(line.message.content) ? line.message.content : [];
        pending.blocks.push(...blocks);
        for (const b of blocks as Array<{ type?: string; text?: string }>) {
          if (b?.type === 'text' && b.text) pending.text += b.text;
        }
        if (line.message.model) pending.model = line.message.model;
        if (line.message.usage) pending.usage = line.message.usage;
        continue;
      }
      closeRound();
      if ((line.type === 'user' || line.type === 'system') && line.message) {
        history.push({
          role: line.message.role,
          content: JSON.stringify(line.message.content ?? ''),
          timestamp: line.timestamp ?? null,
        });
      }
    }
    closeRound();

    return NextResponse.json({
      taskId,
      sourcePath: session.sourcePath,
      full,
      delta,
      totalRounds: rounds.length,
      rounds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
