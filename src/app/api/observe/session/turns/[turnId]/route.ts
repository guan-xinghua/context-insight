// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getContextWindowLimit } from '@/lib/context-window-config';
import { isProxyVersion } from '@/lib/shared/session-format';
import { resolveSubagentIdentity } from '@/lib/subagent-identity';
import { selectInputContextTurns, toWireOrder } from '@/lib/ingest/input-reconstruct';
import { isContinuationTurn } from '@/lib/shared/command-parser';
import { listSubagentSessions } from '@/lib/ingest/adapters/claude-jsonl';
import { readFullContext, readTurnRequestParams, type FullContext } from '@/lib/ingest/adapters/claude-jsonl-full-context';
import { isClaudeFormatSession } from '@/lib/shared/session-format';
import { LruCache } from '@/lib/lru-cache';
import path from 'node:path';
import { withRouteLog } from '@/lib/api-route';

// 读侧热路径缓存：每次点击 turn 的重复确定性计算——
//   systemOverhead：只依赖首个 assistant turn（落库后不可变），永久缓存
//   subagentModel：subagent 首个带 model 的 assistant turn（同上不可变）
//   inputMessages 重建：O(前序全量) DB 扫描，turns append-only 下历史 turn
//     重建结果不变；TTL 兜底 live 会话重导入等极端情形
const systemOverheadCache = new LruCache<string, number>(256);
const subagentModelCache = new LruCache<string, string | null>(256);
const reconstructionCache = new LruCache<string, string>(64, 60_000);

/** 测试钩子：清空本模块缓存。 */
export function __clearTurnDetailCaches(): void {
  systemOverheadCache.clear();
  subagentModelCache.clear();
  reconstructionCache.clear();
}

/** subagent 首个带 model 的 assistant turn 的 model：混模会话里 subagent 的
 *  窗口基数回退源（user turn 不带 model，回退 root 会话 model 会与该 subagent
 *  assistant turn 自带的 model 基数各说各话）。 */
async function resolveSubagentModel(sessionId: string, subagentSessionId: string | null): Promise<string | null> {
  if (!subagentSessionId) return null;
  const cacheKey = `${sessionId}:${subagentSessionId}`;
  const hit = subagentModelCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const first = await prisma.turn.findFirst({
    where: { sessionId, subagentSessionId, role: 'assistant', model: { not: null } },
    orderBy: [{ turnIndex: 'asc' }],
    select: { model: true },
  });
  const value = first?.model ?? null;
  subagentModelCache.set(cacheKey, value);
  return value;
}

// Read the verbatim captured context (system prompt, tools, memory files, skills)
// from the session's capture file via Session.sourcePath. The proxy writes
// extended claude-format, so this applies to claude-code framework sessions.
// Returns null fc for other sources — those have no verbatim capture.
//
// For a SUBAGENT turn, read the subagent's OWN jsonl (subagents/<subId>.jsonl)
// — subagents have a different system prompt (cc_is_subagent=true) and a
// restricted toolset. Reading the main session's file would mislabel the
// main agent's context as the subagent's. Falls back to null (honest empty)
// if the subagent file is missing.
//
// 同时带出 session 行（model/sourcePath）：turn 详情是点击热路径，本函数
// 内部本就 findUnique 了 session——调用方的窗口基数回退与 reqParams 读取
// sourcePath 复用这一次查询，不再各自多跑一趟。
async function readSessionFullContext(
  sessionId: string,
  subagentSessionId: string | null = null,
): Promise<{
  fc: FullContext | null;
  session: { model: string | null; sourcePath: string | null } | null;
}> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { taskId: true, framework: true, version: true, sourcePath: true, model: true },
  });
  if (!session || !session.sourcePath) return { fc: null, session };
  if (!isClaudeFormatSession(session.framework, session.version)) return { fc: null, session };
  if (subagentSessionId) {
    try {
      // Subagent dirs are keyed by the session id (Session.taskId), NOT the
      // capture filename — proxy captures carry a cpx- filename prefix while
      // their <sid>/subagents/ dir uses the unprefixed id. For native imports
      // taskId === filename stem, so behavior is unchanged there.
      const fileSid = session.taskId || path.basename(session.sourcePath, '.jsonl');
      // listSubagentSessions 的 id 即规范连接键（claude：文件名 id；codex-proxy：
      // meta backfill 的 agentId）——与 turn.subagentSessionId（打标口径）同键
      const sub = listSubagentSessions(session.sourcePath, fileSid)
        .find(s => s.id === subagentSessionId);
      if (sub) return { fc: readFullContext(sub.filePath), session };
    } catch { /* fall through to null */ }
    return { fc: null, session };
  }
  return { fc: readFullContext(session.sourcePath), session };
}

// Compute stable system overhead from the first assistant turn
// For root turns: use root session; for subagent turns: use subagent's own turns
async function computeSystemOverhead(sessionId: string, subagentSessionId: string | null): Promise<number> {
  const cacheKey = `${sessionId}:${subagentSessionId ?? ''}`;
  const hit = systemOverheadCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const where = subagentSessionId
    ? { sessionId, role: 'assistant', subagentSessionId }
    : { sessionId, role: 'assistant', isSubagent: false };
  const firstAssistant = await prisma.turn.findFirst({
    where,
    orderBy: [{ turnIndex: 'asc' }],
    select: { id: true, turnIndex: true, inputMessagesTokens: true },
  });
  if (!firstAssistant || firstAssistant.inputMessagesTokens === 0) return 0;

  const priorWhere = subagentSessionId
    ? { sessionId, turnIndex: { lt: firstAssistant.turnIndex }, role: { in: ['user', 'assistant', 'system', 'tool_result'] }, subagentSessionId }
    : { sessionId, turnIndex: { lt: firstAssistant.turnIndex }, role: { in: ['user', 'assistant', 'system', 'tool_result'] }, isSubagent: false };
  const priorMessages = await prisma.turn.findMany({
    where: priorWhere,
    select: { id: true, role: true, content: true },
  });

  // Include tool call args tokens for prior assistant turns
  const priorAssistantIds = priorMessages.filter(ct => ct.role === 'assistant').map(ct => ct.id);
  const priorToolCalls = priorAssistantIds.length > 0 ? await prisma.toolCall.findMany({
    where: { turnId: { in: priorAssistantIds } },
    select: { turnId: true, argsJson: true },
  }) : [];
  const toolArgsTokens = priorToolCalls.reduce((s, tc) => s + Math.round((tc.argsJson?.length ?? 0) / 3.5), 0);

  const visibleEstimated = priorMessages.reduce((s, ct) => s + Math.round((ct.content?.length ?? 0) / 3.5), 0) + toolArgsTokens;
  const value = Math.max(0, firstAssistant.inputMessagesTokens - visibleEstimated);
  systemOverheadCache.set(cacheKey, value);
  return value;
}

export const GET = withRouteLog('observe/session/turns/[turnId]', async (request: NextRequest,
  { params }: { params: Promise<{ turnId: string }> }) => {
  const { turnId } = await params;

  // Virtual continuation turn: turnId ends with "-continuation"
  // The real turn in DB is the compaction turn whose id is the prefix.
  if (turnId.endsWith('-continuation')) {
    const compactionId = turnId.slice(0, -'-continuation'.length);
    const compaction = await prisma.turn.findUnique({
      where: { id: compactionId },
      select: { id: true, sessionId: true, turnIndex: true, role: true, content: true, contentSummary: true, contentJson: true, agentName: true, isSubagent: true, subagentName: true, subagentSessionId: true, createdAt: true, createdAt_ts: true },
    });
    if (!compaction || compaction.agentName !== 'compaction') {
      return NextResponse.json(
        { error: `Continuation turn not found: "${turnId}"` },
        { status: 404 }
      );
    }
    const systemOverheadTokens = await computeSystemOverhead(compaction.sessionId, compaction.subagentSessionId);
    const { fc, session: contSess } = await readSessionFullContext(compaction.sessionId, compaction.subagentSessionId);
    // 合成 continuation turn 无自身 model，窗口基数回退链与主分支同款：
    // subagent 首个 assistant 的 model → 会话级 model
    const contLimit = getContextWindowLimit(
      (await resolveSubagentModel(compaction.sessionId, compaction.subagentSessionId)) || contSess?.model || null
    );
    return NextResponse.json({
      turnId,
      sessionId: compaction.sessionId,
      turnIndex: compaction.turnIndex,
      role: 'user',
      content: compaction.content,
      contentJson: compaction.contentJson,
      contentSummary: compaction.contentSummary ?? compaction.content?.substring(0, 200) ?? null,
      inputMessagesJson: null,
      inputMessagesCount: 0,
      inputMessagesTokens: 0,
      contextWindowPct: null,
      systemOverheadTokens,
      systemPrompt: fc?.systemPrompt ?? null,
      fullContext: fc ? { tools: fc.tools, memoryFiles: fc.memoryFiles, skills: fc.skills } : null,
      agentName: 'continuation',
      subagentName: compaction.subagentName,
      subagentSessionId: compaction.subagentSessionId,
      isSubagent: compaction.isSubagent,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 0,
      ttftMs: null,
      createdAt: compaction.createdAt_ts?.toISOString() ?? compaction.createdAt.toISOString(),
      completedAt: null,
      model: null,
      modelId: null,
      providerId: null,
      contextWindowLimit: contLimit,
      finishReason: null,
      toolCalls: [],
      skillEvents: [],
    });
  }

  const turn = await prisma.turn.findUnique({
    where: { id: turnId },
    include: {
      toolCalls: true,
      skillEvents: true,
    },
  });

  if (!turn) {
    return NextResponse.json(
      { error: `Turn not found: "${turnId}"` },
      { status: 404 }
    );
  }

  // Reconstruct inputMessagesJson if not stored (import optimization: not stored during import)
  let inputMessagesJson = turn.inputMessagesJson;
  if (!inputMessagesJson && turn.role === 'assistant') {
    const cacheKey = turn.id;
    const hit = reconstructionCache.get(cacheKey);
    if (hit !== undefined) {
      inputMessagesJson = hit;
    } else {
    // For subagent turns, only include prior turns in the same subagent session
    // For root turns, only include prior root turns (skip subagent turns)
    const prevWhere = turn.isSubagent && turn.subagentSessionId
      ? {
          sessionId: turn.sessionId,
          turnIndex: { lt: turn.turnIndex },
          role: { in: ['user', 'assistant', 'system', 'tool_result'] },
          subagentSessionId: turn.subagentSessionId,
        }
      : {
          sessionId: turn.sessionId,
          turnIndex: { lt: turn.turnIndex },
          role: { in: ['user', 'assistant', 'system', 'tool_result'] },
          isSubagent: false,
        };
    const previousTurns = await prisma.turn.findMany({
      where: prevWhere,
      orderBy: [{ turnIndex: 'asc' }],
      select: { id: true, turnIndex: true, role: true, content: true, agentName: true },
    });

    // Fetch tool calls (args + result) for prior assistant turns
    const assistantIds = previousTurns.filter(ct => ct.role === 'assistant').map(ct => ct.id);
    const priorToolCalls = assistantIds.length > 0 ? await prisma.toolCall.findMany({
      where: { turnId: { in: assistantIds } },
      select: { turnId: true, toolCallId: true, toolName: true, argsJson: true, resultJson: true, isSkillRelated: true },
      orderBy: [{ id: 'asc' }],
    }) : [];
    // Map assistant turnId → tool calls
    const toolCallsByTurnId = new Map<string, typeof priorToolCalls>();
    for (const tc of priorToolCalls) {
      const arr = toolCallsByTurnId.get(tc.turnId) ?? [];
      arr.push(tc);
      toolCallsByTurnId.set(tc.turnId, arr);
    }

    // Build ordered message list: assistant messages include tool_calls, tool_results keep their content.
    // Apply compact-aware windowing: start at the most recent /compact continuation
    // before this turn and skip local CLI command noise. See input-reconstruct.
    // toWireOrder then folds reminder-split system turns back into their user
    // message so the list mirrors the original request exactly.
    const filtered = toWireOrder(selectInputContextTurns(previousTurns, turn.turnIndex, turn.agentName));

    // Fetch compaction turn totalTokens for accurate continuation tokenCount
    const compactionIds = filtered.filter(ct => ct.agentName === 'compaction').map(ct => ct.id);
    const compactionTokenRows = compactionIds.length > 0 ? await prisma.turn.findMany({
      where: { id: { in: compactionIds } },
      select: { id: true, totalTokens: true },
    }) : [];
    const compactionTokenMap = new Map<string, number>();
    for (const cr of compactionTokenRows) {
      compactionTokenMap.set(cr.id, cr.totalTokens);
    }

    const messages: Array<{ role: string; content: string | null; tokenCount: number; agentName?: string; tool_calls?: Array<{ name: string; args: string | null; result: string | null; isSkillRelated?: boolean }> }> = [];
    const targetInputTokens = turn.agentName === 'compaction'
      ? (turn.inputMessagesTokens > 0 ? turn.inputMessagesTokens : 0)
      : (turn.inputMessagesTokens > 0 ? Math.max(0, turn.inputMessagesTokens - turn.outputTokens) : 0);
    for (const ct of filtered) {
      const contentLen = ct.content?.length ?? 0;
      const baseTokens = Math.round(contentLen / 3.5);
      const isCompaction = ct.agentName === 'compaction';
      const isContinuation = isCompaction || (ct.role === 'user' && ct.content && isContinuationTurn(ct.content));
      const effectiveRole = isContinuation ? 'user' : ct.role;

      if (ct.role === 'assistant') {
        const tcs = toolCallsByTurnId.get(ct.id) ?? [];
        const argsTokens = tcs.reduce((s, tc) => s + Math.round((tc.argsJson?.length ?? 0) / 3.5), 0);
        const compactionTotal = compactionTokenMap.get(ct.id) ?? 0;
        const continuationTokens = isCompaction && compactionTotal > 0 ? compactionTotal : (isContinuation && targetInputTokens > 0 ? targetInputTokens : baseTokens + argsTokens);
        const msg: typeof messages[0] = {
          role: effectiveRole,
          content: ct.content ?? null,
          tokenCount: continuationTokens,
        };
        if (isContinuation) msg.agentName = 'continuation';
        if (tcs.length > 0 && !isCompaction) {
          msg.tool_calls = tcs.map(tc => {
            const isSkill = tc.isSkillRelated;
            const argsMax = isSkill ? 2000 : 1500;
            const resultMax = isSkill ? 5000 : 3000;
            return {
              name: tc.toolName,
              args: tc.argsJson ? (tc.argsJson.length > argsMax ? tc.argsJson.substring(0, argsMax) + '...' : tc.argsJson) : null,
              result: tc.resultJson ? (tc.resultJson.length > resultMax ? tc.resultJson.substring(0, resultMax) + '...' : tc.resultJson) : null,
              isSkillRelated: isSkill ? true : undefined,
            };
          });
        }
        messages.push(msg);
      } else {
        const isContinuationUser = isContinuation && ct.role === 'user';
        const continuationTokens = isContinuationUser && targetInputTokens > 0 ? targetInputTokens : baseTokens;
        const msg: typeof messages[0] = {
          role: effectiveRole,
          content: ct.content ?? null,
          tokenCount: continuationTokens,
        };
        if (isContinuation) msg.agentName = 'continuation';
        messages.push(msg);
      }
    }

    inputMessagesJson = JSON.stringify(messages);
    reconstructionCache.set(cacheKey, inputMessagesJson);
    }
    // The stored count predates the wire-order merge (reminder turn was its
    // own message); use the reconstructed list length so header == list.
    if (turn.agentName !== 'compaction' && inputMessagesJson) {
      (turn as { inputMessagesCount?: number }).inputMessagesCount = JSON.parse(inputMessagesJson).length;
    }
  }

  // Compute stable system overhead (fixed for entire session)
  const systemOverheadTokens = await computeSystemOverhead(turn.sessionId, turn.subagentSessionId);
  const { fc, session: sess } = await readSessionFullContext(turn.sessionId, turn.subagentSessionId);
  // 窗口基数回退链：turn.model →（subagent turn）该 subagent 首个 assistant
  // 的 model → 会话级 model。此前 null 一律落 200k 全局默认，同会话 root 卡
  // 1M / subagent 卡 200k 各说各话（现场：glm-5.3 会话的 subagent user turn
  // 34.1k 被算成 17%）；混模会话里 subagent 也不能回退 root 的 model——它的
  // assistant turn 带的是自己 jsonl 的 model，基数须同源。用 || 不用 ??：
  // '' 与 null 同样视为缺失，与列表 route 的真值判断同口径
  const contextWindowLimit = getContextWindowLimit(
    turn.model || (await resolveSubagentModel(turn.sessionId, turn.subagentSessionId)) || sess?.model || null
  );
  // 子代理身份双字段（类型 + 派发步骤），与列表 route 同源同口径：
  // Bridge join + proxy/原生步骤优先级
  const identity = turn.subagentSessionId
    ? resolveSubagentIdentity({
        subagentName: turn.subagentName,
        bridge: await prisma.interactionBridge.findFirst({
          where: { sessionId: turn.sessionId, subagentSessionId: turn.subagentSessionId },
          orderBy: [{ dispatchTimestamp: 'asc' }],
          select: { subagentType: true, dispatchContent: true },
        }),
        isProxy: isProxyVersion(
          (await prisma.session.findUnique({ where: { id: turn.sessionId }, select: { version: true } }))?.version ?? null
        ),
      })
    : null;
  // post-patch（spec §4.1 导入归宿）：proxy 捕获的 temperature/maxTokens/
  // 请求 model 只存在 jsonl 的 x_cannbay.data，DB 无对应列 → API 层按需叠加。
  // root assistant turn 才对齐 roundIndex（subagent turn 的全局 turnIndex 与
  // jsonl 行序不对应，跳过 —— 其请求参数由子代理自己的 jsonl 提供，另议）。
  let reqParams: { temperature: number | null; maxTokens: number | null; model: string | null } | null = null;
  if (turn.role === 'assistant' && !turn.subagentSessionId && fc !== null) {
    if (sess?.sourcePath) reqParams = readTurnRequestParams(sess.sourcePath, turn.turnIndex);
  }

  return NextResponse.json({
    turnId: turn.id,
    sessionId: turn.sessionId,
    turnIndex: turn.turnIndex,
    role: turn.role,
    content: turn.content,
    contentJson: turn.contentJson,
    contentSummary: turn.contentSummary ?? turn.content?.substring(0, 200) ?? null,
    inputMessagesJson,
    inputMessagesCount: turn.agentName === 'compaction' ? (inputMessagesJson ? JSON.parse(inputMessagesJson).length : turn.inputMessagesCount) : turn.inputMessagesCount,
    inputMessagesTokens: turn.agentName === 'compaction' && turn.inputMessagesTokens === turn.outputTokens ? turn.inputTokens : turn.inputMessagesTokens,
    contextWindowPct: turn.contextWindowPct,
    systemOverheadTokens,
    temperature: reqParams?.temperature ?? null,
    maxTokens: reqParams?.maxTokens ?? null,
    systemPrompt: fc?.systemPrompt ?? null,
    fullContext: fc ? { tools: fc.tools, memoryFiles: fc.memoryFiles, skills: fc.skills } : null,
    agentName: turn.agentName,
    subagentName: turn.subagentName,
    subagentSessionId: turn.subagentSessionId,
    subagentType: identity?.subagentType ?? null,
    dispatchStep: identity?.step ?? null,
    isSubagent: turn.isSubagent,
    totalTokens: turn.totalTokens,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    reasoningTokens: turn.reasoningTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheWriteTokens: turn.cacheWriteTokens,
    latencyMs: turn.latencyMs,
    ttftMs: turn.ttftMs,
    createdAt: turn.createdAt_ts?.toISOString() ?? turn.createdAt.toISOString(),
    completedAt: turn.completedAt?.toISOString() ?? null,
    model: turn.model,
    modelId: turn.modelId,
    providerId: turn.providerId,
    contextWindowLimit,
    finishReason: turn.finishReason,
    toolCalls: turn.toolCalls.map(tc => ({
      id: tc.id,
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      argsJson: tc.argsJson,
      resultJson: tc.resultJson,
      state: tc.state,
      errorType: tc.errorType,
      errorMessage: tc.errorMessage,
      startedAt: tc.startedAt?.toISOString() ?? null,
      completedAt: tc.completedAt?.toISOString() ?? null,
      durationMs: tc.durationMs,
      dispatchBridgeId: tc.dispatchBridgeId,
      isSkillRelated: tc.isSkillRelated,
    })),
    skillEvents: (() => {
      const skillToolCalls = turn.toolCalls.filter(tc => tc.isSkillRelated)
      return turn.skillEvents.map((se, idx) => {
        const matchedTc = skillToolCalls[idx]
        const resultError = matchedTc?.resultJson && (matchedTc.resultJson.includes('<tool_use_error>') || matchedTc.resultJson.includes('Exit code'))
        return {
          id: se.id,
          skillName: se.skillName,
          skillVersion: se.skillVersion,
          eventType: se.eventType,
          success: resultError ? false : se.success,
          errorMessage: resultError ? matchedTc!.resultJson!.substring(0, 200) : se.errorMessage,
          argsJson: se.argsJson,
          startedAt: se.startedAt?.toISOString() ?? null,
          completedAt: se.completedAt?.toISOString() ?? null,
          durationMs: se.durationMs,
        }
      })
    })(),
  });
});
