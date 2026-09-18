// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextResponse } from 'next/server';
import { getLakeListing, invalidateCaches } from '@/app/cannbay_viewer/_lib/runs';
import { appendNote, appendScorecard, editNote, readRecords, readSubmitInfo, setOpGen, NotesConflictError } from '@/app/cannbay_viewer/_lib/lake/notes';
import type { SessionLoc, OpGenValue } from '@/app/cannbay_viewer/_lib/lake/notes';
import { getScorecard } from '@/app/cannbay_viewer/_lib/insight-data';

// recording 消歧：同 sid 双记录（捕获 + 原生）时按参数定位；缺省优先捕获位
// （存量兼容——旧客户端/裸目录会话无 recording 概念）
async function findSession(sid: string, recording?: string | null): Promise<SessionLoc | null> {
  const lake = await getLakeListing();
  const matches = lake.sessions.filter(x => x.sid === sid);
  const s = recording === 'native' || recording === 'capture'
    ? matches.find(x => x.recording === recording)
    : (matches.find(x => x.recording === 'capture') ?? matches[0]);
  if (!s || !s.paradigm) return null;
  return { sid: s.sid, paradigm: s.paradigm, isBaseline: s.isBaseline, recording: s.recording };
}

export async function GET(req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const { sid } = await ctx.params;
  const session = await findSession(sid, new URL(req.url).searchParams.get('recording'));
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const [records, submit] = await Promise.all([readRecords(session), readSubmitInfo(session)]);
  return NextResponse.json({ sid, records, submit });
}

// body: {kind:'note', text} | {kind:'scorecard'}（评分卡快照取自 insight 当时刻值）
//      | {kind:'edit', ts, text, newText}（按 ts+原文定位改写，保留原 ts）
//      | {kind:'opgen', value}（写 meta 的 opGen 标注；native 会话写 .native 位 meta）
//      | body.recording（'capture' | 'native'，双记录消歧，缺省捕获位）
export async function POST(req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const { sid } = await ctx.params;
  const session = await findSession(sid, new URL(req.url).searchParams.get('recording'));
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  let kind = 'note';
  let text = '';
  let edit = { ts: '', text: '', newText: '' };
  let opGen: OpGenValue | 'invalid' = 'invalid';
  try {
    const body = await req.json() as { kind?: unknown; text?: unknown; ts?: unknown; newText?: unknown; value?: unknown };
    if (body.kind === 'scorecard') kind = 'scorecard';
    if (body.kind === 'edit') {
      kind = 'edit';
      edit = {
        ts: typeof body.ts === 'string' ? body.ts : '',
        text: typeof body.text === 'string' ? body.text : '',
        newText: typeof body.newText === 'string' ? body.newText : '',
      };
    }
    if (body.kind === 'opgen') {
      kind = 'opgen';
      opGen = body.value === 'success' || body.value === 'failure' ? body.value : (body.value === null ? null : 'invalid');
    }
    if (typeof body.text === 'string' && kind !== 'edit' && kind !== 'opgen') text = body.text;
  } catch { /* 落到默认 note + 空文本 400 */ }
  try {
    let records;
    if (kind === 'scorecard') {
      const card = await getScorecard(sid);
      if (!card) return NextResponse.json({ error: '无评分卡（该会话未导入或未评分）' }, { status: 409 });
      records = await appendScorecard(session, card);
    } else if (kind === 'edit') {
      if (!edit.ts || !edit.text) return NextResponse.json({ error: 'ts and text required' }, { status: 400 });
      records = await editNote(session, { ts: edit.ts, text: edit.text }, edit.newText);
    } else if (kind === 'opgen') {
      if (opGen === 'invalid') return NextResponse.json({ error: "value must be 'success' | 'failure' | null" }, { status: 400 });
      await setOpGen(session, opGen);
    } else {
      if (!text.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 });
      records = await appendNote(session, text);
    }
    invalidateCaches();
    return NextResponse.json({ sid, records });
  } catch (e) {
    if (e instanceof NotesConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'append failed' }, { status: 502 });
  }
}
