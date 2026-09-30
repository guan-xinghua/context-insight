// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import Database from 'better-sqlite3';
import type { SessionListItem, RawInteraction, ToolCallInfo, TokenUsage } from '../../shared/types';

// opencode native db comes in two schema generations:
//   v1 (opencode 1.x):   tables session / message / part, messages ordered by time_created
//   v2 (opencode 2.x):   tables session_v2 / session_message, event-sourced rows
//                        ordered by per-session seq, tool calls inlined in the
//                        assistant content array, title column nullable
// Detection is by table presence (not version string) so any patch level and
// in-place upgraded dbs classify correctly; when both generations coexist, v2
// wins because that is what a running opencode 2.x writes and reads.
type OpencodeSchema = 1 | 2;

// opencode 2.x 的 session_message 是事件溯源表：除真实会话消息外还混有控制面
// 行（idle / shell / agent-switched / model-switched / location-switched 等，
// 每轮响应后追加、无对话内容）。可导入类型的白名单是「列表 turnCount / 导入
// 管线 / 自动刷新探针」三处的单一真身——v1 的 message 表没有控制面行，v2 若
// 把 COUNT(*) 直接平移过去会把控制面行算成轮数、列表显示虚高。任何一处口径
// 变更都必须改这里，避免三处漂移。
export const V2_IMPORTABLE_TYPES: readonly string[] = [
  'assistant',
  'compaction',
  'user',
  'synthetic',
  'skill',
  'system',
];

// 白名单的 SQL `type IN (...)` 片段（值全部来自上面的硬编码常量，无注入面）。
export function v2ImportableTypeSql(): string {
  return `type IN (${V2_IMPORTABLE_TYPES.map(t => `'${t}'`).join(', ')})`;
}

export class NotOpencodeDbError extends Error {
  readonly tables: string[];

  constructor(tables: string[]) {
    super(
      '所选文件不是可识别的 opencode 会话库' +
        (tables.length > 0 ? `（找到的表：${tables.slice(0, 10).join('、')}${tables.length > 10 ? ' 等' : ''}）` : '（无表）') +
        '。可能原因：① opencode 2.x 非标准渠道安装时会用 opencode-<渠道>.db 作为库文件名，请在同目录寻找其他 opencode*.db；' +
        '② 所选文件不是 opencode 的数据文件。'
    );
    this.name = 'NotOpencodeDbError';
    this.tables = tables;
  }
}

function listTables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(r => r.name);
}

function opencodeSchemaOf(db: Database.Database): OpencodeSchema | null {
  const names = new Set(listTables(db));
  if (names.has('session_v2')) return 2;
  if (names.has('session')) return 1;
  return null;
}

// 两代表共存的库（opencode 2.x 首跑会把存量 1.x 会话回填进 v2 表，之后
// 1.x 版本继续只写 v1 表——v2 副本自回填时刻停更；实测 2.26GB 活库：全部
// 223 个 1.x 会话都在 session_v2 里，但活跃会话回填后新增的 8 条消息只存
// 在 v1 表）。此时全库按任一代表读都会丢数据，必须按会话粒度选代表：
//   v2 会话行存在 且（无 v1 行 或 v2 消息严格更新）→ v2 读方
//   否则 → v1 读方（平局归 v1：1.x 会话的权威写方，内容完备）
// 列表聚合、readSession/readSessionMeta 与 auto-refresh 探针同用此口径。
export function opencodeReaderGeneration(db: Database.Database, sessionId: string): OpencodeSchema {
  const names = new Set(listTables(db));
  const hasV2 = names.has('session_v2');
  const hasV1 = names.has('session');
  if (hasV2 && !hasV1) return 2;
  if (!hasV2) return 1;
  const v2Row = db.prepare('SELECT 1 AS x FROM session_v2 WHERE id = ?').get(sessionId);
  if (!v2Row) return 1;
  const v1Row = db.prepare('SELECT 1 AS x FROM session WHERE id = ?').get(sessionId);
  if (!v1Row) return 2;
  const v1Max = (db.prepare('SELECT MAX(time_created) AS m FROM message WHERE session_id = ?').get(sessionId) as { m: number | null }).m;
  const v2Max = (db.prepare('SELECT MAX(time_created) AS m FROM session_message WHERE session_id = ?').get(sessionId) as { m: number | null }).m;
  return v2Max !== null && (v1Max === null || v2Max > v1Max) ? 2 : 1;
}

export function listSessions(dbPath: string): SessionListItem[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }

  try {
    const schema = opencodeSchemaOf(db);
    if (schema === 2) {
      // 两代表共存 → 按会话粒度合并（回填停更副本不能代表全库）
      if (listTables(db).includes('session')) return listSessionsMixed(db);
      return listSessionsV2(db);
    }
    if (schema === 1) return listSessionsV1(db);
    throw new NotOpencodeDbError(listTables(db));
  } finally {
    db.close();
  }
}

// 两代表共存的列表合并：v1/v2 各自全量聚合后按会话 id 归并——v2 条目仅当
// 其 endedAt（该表消息的 MAX(time_created)）严格更新时胜出，与
// opencodeReaderGeneration 的路由口径一致（平局/缺失归 v1）。
function listSessionsMixed(db: Database.Database): SessionListItem[] {
  const v1 = listSessionsV1(db);
  const v2 = listSessionsV2(db);
  const byId = new Map<string, SessionListItem>(v1.map(s => [s.id, s]));
  for (const s of v2) {
    const a = byId.get(s.id);
    const sEnd = s.endedAt ?? null;
    const aEnd = a?.endedAt ?? null;
    if (!a || (sEnd !== null && (aEnd === null || sEnd > aEnd))) {
      byId.set(s.id, s);
    }
  }
  const result = [...byId.values()];
  result.sort((a, b) => ((b.endedAt ?? b.createdAt) ?? '').localeCompare((a.endedAt ?? a.createdAt) ?? ''));
  return result;
}

function listSessionsV1(db: Database.Database): SessionListItem[] {
    const sessions = db.prepare(
      'SELECT id, title, version, time_created FROM session WHERE parent_id IS NULL OR parent_id = \'\' ORDER BY time_created DESC'
    ).all() as { id: string; title: string; version: string; time_created: number }[];

    if (sessions.length === 0) return [];

    const sessionIds = sessions.map(s => s.id);

    const userMsgs = db.prepare(
      `SELECT session_id, id, data FROM message WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) AND json_extract(data, '$.role') = 'user' ORDER BY time_created`
    ).all(...sessionIds) as { session_id: string; id: string; data: string }[];

    const msgCounts = db.prepare(
      `SELECT session_id, COUNT(*) as cnt FROM message WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) GROUP BY session_id`
    ).all(...sessionIds) as { session_id: string; cnt: number }[];

    const countBySession = new Map<string, number>();
    for (const c of msgCounts) {
      countBySession.set(c.session_id, c.cnt);
    }

    const assistantMsgs = db.prepare(
      `SELECT session_id, data FROM message WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created`
    ).all(...sessionIds) as { session_id: string; data: string }[];

    const assistantMsgBySession = new Map<string, { data: string }>();
    for (const m of assistantMsgs) {
      if (!assistantMsgBySession.has(m.session_id)) {
        assistantMsgBySession.set(m.session_id, { data: m.data });
      }
    }

    const lastMsgTimeBySession = db.prepare(
      `SELECT session_id, MAX(time_created) AS max_ts FROM message WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) GROUP BY session_id`
    ).all(...sessionIds) as { session_id: string; max_ts: number | null }[];

    const endTsBySession = new Map<string, number | null>();
    for (const r of lastMsgTimeBySession) {
      endTsBySession.set(r.session_id, r.max_ts);
    }

    const tokenSumBySession = new Map<string, number>();
    for (const m of assistantMsgs) {
      try {
        const msgData = JSON.parse(m.data);
        if (msgData.tokens && typeof msgData.tokens.total === 'number') {
          tokenSumBySession.set(m.session_id, (tokenSumBySession.get(m.session_id) ?? 0) + msgData.tokens.total);
        }
      } catch { /* skip */ }
    }

    // Only need first user message per session — filter parts by those specific message IDs
    const firstUserMsgBySession = new Map<string, string>();
    for (const m of userMsgs) {
      if (!firstUserMsgBySession.has(m.session_id)) {
        firstUserMsgBySession.set(m.session_id, m.id);
      }
    }

    const firstUserMsgIds = [...firstUserMsgBySession.values()];

    // Filtered text parts — only for first user messages, not the entire DB
    const textParts = firstUserMsgIds.length > 0
      ? (db.prepare(
          `SELECT message_id, data FROM part WHERE message_id IN (${firstUserMsgIds.map(() => '?').join(',')}) AND json_extract(data, '$.type') = 'text' ORDER BY time_created`
        ).all(...firstUserMsgIds) as { message_id: string; data: string }[])
      : [];

    const textByMsgId = new Map<string, string[]>();
    for (const p of textParts) {
      try {
        const pd = JSON.parse(p.data);
        const text = pd.text || '';
        if (!textByMsgId.has(p.message_id)) textByMsgId.set(p.message_id, []);
        textByMsgId.get(p.message_id)!.push(text);
      } catch { /* skip */ }
    }

    // Store full user msg data (id + data) for fallback text extraction
    const userMsgDataBySession = new Map<string, { id: string; data: string }>();
    for (const m of userMsgs) {
      if (!userMsgDataBySession.has(m.session_id)) {
        userMsgDataBySession.set(m.session_id, { id: m.id, data: m.data });
      }
    }

    const result: SessionListItem[] = [];
    for (const session of sessions) {
      let firstQuery: string | null = null;
      const userMsgData = userMsgDataBySession.get(session.id);
      if (userMsgData) {
        try {
          const msgData = JSON.parse(userMsgData.data);
          if (msgData.content && typeof msgData.content === 'string') {
            firstQuery = msgData.content;
          } else {
            const texts = textByMsgId.get(userMsgData.id) ?? [];
            firstQuery = texts.join('\n').trim() || null;
          }
        } catch { /* skip */ }
      }

      const turnCount = countBySession.get(session.id) ?? 0;

      let modelName: string | null = null;
      const assistantMsgData = assistantMsgBySession.get(session.id);
      if (assistantMsgData) {
        try {
          const msgData = JSON.parse(assistantMsgData.data);
          if (msgData.modelID) {
            modelName = msgData.providerID && msgData.modelID
              ? `${msgData.providerID}/${msgData.modelID}`
              : msgData.modelID;
          } else if (msgData.model) {
            modelName = msgData.model.providerID && msgData.model.modelID
              ? `${msgData.model.providerID}/${msgData.model.modelID}`
              : msgData.model.modelID || null;
          }
        } catch { /* skip */ }
      }

      result.push({
        id: session.id,
        createdAt: new Date(session.time_created).toISOString(),
        endedAt: endTsBySession.get(session.id) ? new Date(endTsBySession.get(session.id) as number).toISOString() : null,
        firstQuery,
        turnCount,
        modelName,
        totalTokens: tokenSumBySession.get(session.id) ?? 0,
        version: session.version,
      });
    }

    result.sort((a, b) => (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt));

    return result;
}

// v2 session listing: session_v2 rows + session_message aggregation. Mirrors
// the v1 output contract (SessionListItem) — firstQuery from the first user
// message text, turnCount from all rows, model from the first assistant
// message, totalTokens as the five-field sum (v2 tokens carry no `total`).
function listSessionsV2(db: Database.Database): SessionListItem[] {
  const sessions = db.prepare(
    "SELECT id, title, version, time_created FROM session_v2 WHERE parent_id IS NULL OR parent_id = '' ORDER BY time_created DESC"
  ).all() as { id: string; title: string | null; version: string; time_created: number }[];

  if (sessions.length === 0) return [];

  const sessionIds = sessions.map(s => s.id);
  const inList = sessionIds.map(() => '?').join(',');

  const userMsgs = db.prepare(
    `SELECT session_id, id, data FROM session_message WHERE session_id IN (${inList}) AND type = 'user' ORDER BY seq`
  ).all(...sessionIds) as { session_id: string; id: string; data: string }[];

  // 轮数计数与导入管线/自动刷新探针同口径：只数可导入类型，控制面行
  // （每轮响应后追加的 idle 等）不计入，否则列表轮数虚高。
  const msgCounts = db.prepare(
    `SELECT session_id, COUNT(*) as cnt FROM session_message WHERE session_id IN (${inList}) AND ${v2ImportableTypeSql()} GROUP BY session_id`
  ).all(...sessionIds) as { session_id: string; cnt: number }[];

  const countBySession = new Map<string, number>();
  for (const c of msgCounts) {
    countBySession.set(c.session_id, c.cnt);
  }

  const assistantMsgs = db.prepare(
    `SELECT session_id, data FROM session_message WHERE session_id IN (${inList}) AND type = 'assistant' ORDER BY seq`
  ).all(...sessionIds) as { session_id: string; data: string }[];

  const assistantMsgBySession = new Map<string, { data: string }>();
  for (const m of assistantMsgs) {
    if (!assistantMsgBySession.has(m.session_id)) {
      assistantMsgBySession.set(m.session_id, { data: m.data });
    }
  }

  const lastMsgTimeBySession = db.prepare(
    `SELECT session_id, MAX(time_created) AS max_ts FROM session_message WHERE session_id IN (${inList}) GROUP BY session_id`
  ).all(...sessionIds) as { session_id: string; max_ts: number | null }[];

  const endTsBySession = new Map<string, number | null>();
  for (const r of lastMsgTimeBySession) {
    endTsBySession.set(r.session_id, r.max_ts);
  }

  const tokenSumBySession = new Map<string, number>();
  for (const m of assistantMsgs) {
    try {
      const msgData = JSON.parse(m.data);
      const total = v2TokenTotal(msgData.tokens);
      if (total > 0) {
        tokenSumBySession.set(m.session_id, (tokenSumBySession.get(m.session_id) ?? 0) + total);
      }
    } catch { /* skip */ }
  }

  const firstQueryBySession = new Map<string, string>();
  for (const m of userMsgs) {
    if (firstQueryBySession.has(m.session_id)) continue;
    try {
      const msgData = JSON.parse(m.data);
      if (typeof msgData.text === 'string' && msgData.text) {
        firstQueryBySession.set(m.session_id, msgData.text);
      }
    } catch { /* skip */ }
  }

  const result: SessionListItem[] = [];
  for (const session of sessions) {
    let modelName: string | null = null;
    const assistantMsgData = assistantMsgBySession.get(session.id);
    if (assistantMsgData) {
      try {
        const msgData = JSON.parse(assistantMsgData.data);
        modelName = modelRefString(msgData.model);
      } catch { /* skip */ }
    }

    result.push({
      id: session.id,
      createdAt: new Date(session.time_created).toISOString(),
      endedAt: endTsBySession.get(session.id) ? new Date(endTsBySession.get(session.id) as number).toISOString() : null,
      firstQuery: firstQueryBySession.get(session.id) ?? null,
      turnCount: countBySession.get(session.id) ?? 0,
      modelName,
      totalTokens: tokenSumBySession.get(session.id) ?? 0,
      version: session.version,
    });
  }

  result.sort((a, b) => (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt));

  return result;
}

export function listSubagentSessions(dbPath: string, parentSessionId: string): string[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }

  try {
    return _listSubagentSessions(db, parentSessionId);
  } finally {
    db.close();
  }
}

function _listSubagentSessions(db: Database.Database, parentSessionId: string): string[] {
  // 两代表共存时取并集：子代理可能只存在于其中一代（回填时刻之后新建/
  // 2.x 独写），各会话的读方由 opencodeReaderGeneration 独立路由
  const names = new Set(listTables(db));
  const ids = new Set<string>();
  if (names.has('session_v2')) {
    for (const c of db.prepare('SELECT id FROM session_v2 WHERE parent_id = ?').all(parentSessionId) as { id: string }[]) ids.add(c.id);
  }
  if (names.has('session')) {
    for (const c of db.prepare('SELECT id FROM session WHERE parent_id = ?').all(parentSessionId) as { id: string }[]) ids.add(c.id);
  }
  return [...ids];
}

export function readSession(dbPath: string, sessionId: string): RawInteraction[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }

  try {
    return readSessionWithDb(db, sessionId);
  } finally {
    db.close();
  }
}

function _readSession(db: Database.Database, sessionId: string): RawInteraction[] {
  const sessionRow = db.prepare(
    'SELECT id, parent_id FROM session WHERE id = ?'
  ).get(sessionId) as { id: string; parent_id: string | null } | undefined;

  if (!sessionRow) return [];

  const isSubagent = sessionRow.parent_id && sessionRow.parent_id !== '';

  const subagentInfo = isSubagent ? db.prepare(
    'SELECT id, title, parent_id FROM session WHERE id = ?'
  ).get(sessionId) as { id: string; title: string; parent_id: string } : null;

  let subagent_name: string | null = null;
  if (subagentInfo) {
    const titleMatch = subagentInfo.title.match(/@\((\w+)\)\s+subagent/);
    if (titleMatch) {
      subagent_name = titleMatch[1];
    } else {
      const agentFromTitle = subagentInfo.title.match(/@(\w+)/);
      if (agentFromTitle) subagent_name = agentFromTitle[1];
    }
  }

  const messages = db.prepare(
    'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created'
  ).all(sessionId) as { id: string; time_created: number; data: string }[];

  const msgIds = messages.map(m => m.id);
  if (msgIds.length === 0) return [];

  const allTextParts = db.prepare(
    `SELECT message_id, data FROM part WHERE message_id IN (${msgIds.map(() => '?').join(',')}) AND json_extract(data, '$.type') = 'text' ORDER BY time_created`
  ).all(...msgIds) as { message_id: string; data: string }[];

  const allReasoningParts = db.prepare(
    `SELECT message_id, data FROM part WHERE message_id IN (${msgIds.map(() => '?').join(',')}) AND json_extract(data, '$.type') = 'reasoning' ORDER BY time_created`
  ).all(...msgIds) as { message_id: string; data: string }[];

  const allToolParts = db.prepare(
    `SELECT message_id, data FROM part WHERE message_id IN (${msgIds.map(() => '?').join(',')}) AND json_extract(data, '$.type') = 'tool' ORDER BY time_created`
  ).all(...msgIds) as { message_id: string; data: string }[];

  const allCompactionParts = db.prepare(
    `SELECT message_id, data FROM part WHERE message_id IN (${msgIds.map(() => '?').join(',')}) AND json_extract(data, '$.type') = 'compaction' ORDER BY time_created`
  ).all(...msgIds) as { message_id: string; data: string }[];

  const compactionByMsg = new Map<string, { auto: boolean; tailStartId: string }>();
  for (const p of allCompactionParts) {
    try {
      const pd = JSON.parse(p.data);
      compactionByMsg.set(p.message_id, { auto: pd.auto === true, tailStartId: pd.tail_start_id ?? '' });
    } catch { /* skip */ }
  }

  const textByMsg = new Map<string, string[]>();
  for (const p of allTextParts) {
    try {
      const pd = JSON.parse(p.data);
      if (pd.text) {
        if (!textByMsg.has(p.message_id)) textByMsg.set(p.message_id, []);
        textByMsg.get(p.message_id)!.push(pd.text);
      }
    } catch { /* skip */ }
  }

  const reasoningByMsg = new Map<string, string[]>();
  for (const p of allReasoningParts) {
    try {
      const pd = JSON.parse(p.data);
      if (pd.text) {
        if (!reasoningByMsg.has(p.message_id)) reasoningByMsg.set(p.message_id, []);
        reasoningByMsg.get(p.message_id)!.push(pd.text);
      }
    } catch { /* skip */ }
  }

  const toolCallsByMsg = new Map<string, ToolCallInfo[]>();
  for (const p of allToolParts) {
    try {
      const pd = JSON.parse(p.data);
      const callID = pd.callID || '';
      const toolName = pd.tool || '';
      const state = pd.state?.status || 'unknown';

      let argsJson: string | null = null;
      if (pd.input) {
        argsJson = JSON.stringify(pd.input);
      } else if (pd.state?.input) {
        const stateInput = pd.state.input;
        const mergedArgs: Record<string, unknown> = { ...stateInput };
        if (pd.state.metadata?.sessionId) {
          mergedArgs.subagent_session_id = pd.state.metadata.sessionId;
        }
        if (pd.state.metadata?.model) {
          mergedArgs.subagent_model = pd.state.metadata.model;
        }
        if (pd.state.title) {
          mergedArgs.summary = pd.state.title;
        }
        argsJson = JSON.stringify(mergedArgs);
      }

      let resultJson: string | null = null;
      if (pd.output) {
        resultJson = typeof pd.output === 'string' ? pd.output : JSON.stringify(pd.output);
      } else if (pd.state?.output) {
        resultJson = typeof pd.state.output === 'string' ? pd.state.output : JSON.stringify(pd.state.output);
      }

      const tc: ToolCallInfo = { toolCallId: callID, toolName, argsJson, resultJson, state };
      if (!toolCallsByMsg.has(p.message_id)) toolCallsByMsg.set(p.message_id, []);
      toolCallsByMsg.get(p.message_id)!.push(tc);
    } catch { /* skip */ }
  }

  const result: RawInteraction[] = [];

  for (const msg of messages) {
    try {
      const msgData = JSON.parse(msg.data);
      const role = msgData.role || 'unknown';
      const isCompactionSummary = role === 'assistant' && (msgData.mode === 'compaction' || msgData.summary === true);
      const compactionInfo = compactionByMsg.get(msg.id);
      const hasNoTextContent = !textByMsg.has(msg.id) && !reasoningByMsg.has(msg.id) && !(msgData.content && typeof msgData.content === 'string');

      let content: string | null;
      let agent: string | null;

      if (compactionInfo && hasNoTextContent) {
        content = compactionInfo.auto ? '/compact (auto)' : '/compact';
        agent = 'compaction-boundary';
      } else if (isCompactionSummary) {
        content = extractMessageContentBulk(msg.id, msgData, textByMsg, reasoningByMsg);
        agent = 'compaction';
      } else {
        content = extractMessageContentBulk(msg.id, msgData, textByMsg, reasoningByMsg);
        agent = msgData.agent || null;
      }

      const timeInfo = msgData.time
        ? {
            created: msgData.time.created ?? msg.time_created,
            completed: msgData.time.completed ?? undefined,
          }
        : { created: msg.time_created };

      let latency: number | null = null;
      if (timeInfo.completed && timeInfo.created) {
        latency = timeInfo.completed - timeInfo.created;
      }

      let usage: TokenUsage | null = null;
      if (msgData.tokens) {
        const input = msgData.tokens.input ?? 0;
        const cacheRead = msgData.tokens.cache?.read ?? 0;
        const cacheWrite = msgData.tokens.cache?.write ?? 0;
        usage = {
          total: msgData.tokens.total ?? 0,
          input,
          output: msgData.tokens.output ?? 0,
          reasoning: msgData.tokens.reasoning ?? 0,
          cacheRead,
          cacheWrite,
          cost: msgData.cost ?? 0,
          inputMessagesTokens: input + cacheRead + cacheWrite,
        };
      }

      let model: string | null = null;
      let modelID: string | null = null;
      let providerID: string | null = null;
      if (msgData.modelID) {
        modelID = msgData.modelID;
        providerID = msgData.providerID;
        model = providerID && modelID ? `${providerID}/${modelID}` : modelID;
      } else if (msgData.model) {
        providerID = msgData.model.providerID;
        modelID = msgData.model.modelID;
        model = providerID && modelID ? `${providerID}/${modelID}` : modelID;
      }

      const finish_reason = msgData.finish || null;

      const tool_calls = toolCallsByMsg.has(msg.id)
        ? toolCallsByMsg.get(msg.id)!
        : null;

      result.push({
        role,
        content,
        timestamp: new Date(msg.time_created).toISOString(),
        timeInfo,
        agent,
        subagent_name: isSubagent ? subagent_name : null,
        subagent_session_id: isSubagent ? sessionId : null,
        subagent_type: null,
        tool_calls,
        usage,
        model,
        modelID,
        providerID,
        latency,
        finish_reason,
      });
    } catch {
      result.push({
        role: 'unknown',
        content: null,
        timestamp: new Date(msg.time_created).toISOString(),
        timeInfo: { created: msg.time_created },
        agent: null,
        subagent_name: null,
        subagent_session_id: null,
        subagent_type: null,
        tool_calls: null,
        usage: null,
        model: null,
        modelID: null,
        providerID: null,
        latency: null,
        finish_reason: null,
      });
    }
  }

  return result;
}

function extractMessageContentBulk(
  messageId: string,
  msgData: Record<string, unknown>,
  textByMsg: Map<string, string[]>,
  reasoningByMsg: Map<string, string[]>,
): string | null {
  if (msgData.content && typeof msgData.content === 'string') {
    return msgData.content;
  }

  const textContent = textByMsg.get(messageId) ?? [];
  const reasoningContent = reasoningByMsg.get(messageId) ?? [];

  const parts: string[] = [];
  if (reasoningContent.length > 0) {
    parts.push(`<thinking>${reasoningContent.join('\n')}</thinking>`);
  }
  if (textContent.length > 0) {
    parts.push(textContent.join('\n'));
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ── v2 session readers (session_v2 + session_message) ──

function finiteNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// v2 tokens carry {input, output, reasoning, cache:{read, write}} with no
// `total` field — the total is the five-field sum (mirrors opencode's own
// TokenUsage.total()).
function v2TokenTotal(tokens: unknown): number {
  if (!tokens || typeof tokens !== 'object') return 0;
  const t = tokens as Record<string, unknown>;
  const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>;
  return finiteNum(t.input) + finiteNum(t.output) + finiteNum(t.reasoning) + finiteNum(cache.read) + finiteNum(cache.write);
}

function v2TokenUsage(msgData: Record<string, unknown>): TokenUsage | null {
  const tokens = msgData.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const t = tokens as Record<string, unknown>;
  const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>;
  const input = finiteNum(t.input);
  const output = finiteNum(t.output);
  const reasoning = finiteNum(t.reasoning);
  const cacheRead = finiteNum(cache.read);
  const cacheWrite = finiteNum(cache.write);
  return {
    total: input + output + reasoning + cacheRead + cacheWrite,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cost: finiteNum(msgData.cost),
    inputMessagesTokens: input + cacheRead + cacheWrite,
  };
}

// v2 model ref shape: {id, providerID, variant?} → "providerID/id" display
// string (same convention as the v1 path).
function modelRefString(model: unknown): string | null {
  if (!model || typeof model !== 'object') return null;
  const m = model as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id : null;
  const providerID = typeof m.providerID === 'string' ? m.providerID : null;
  if (!id) return null;
  return providerID ? `${providerID}/${id}` : id;
}

function v2TimeInfo(msgData: Record<string, unknown>, fallbackCreated: number): { created: number; completed?: number } {
  const time = msgData.time as { created?: unknown; completed?: unknown } | undefined;
  if (time && typeof time === 'object') {
    return {
      created: typeof time.created === 'number' ? time.created : fallbackCreated,
      completed: typeof time.completed === 'number' ? time.completed : undefined,
    };
  }
  return { created: fallbackCreated };
}

function v2ToolCallInfo(c: Record<string, unknown>): ToolCallInfo {
  const state = (c.state && typeof c.state === 'object' ? c.state : {}) as Record<string, unknown>;
  const status = typeof state.status === 'string' ? state.status : 'unknown';

  let argsJson: string | null = null;
  if (state.input !== undefined && state.input !== null) {
    if (typeof state.input === 'string') {
      argsJson = state.input;
    } else {
      const metadata = (state.metadata && typeof state.metadata === 'object' ? state.metadata : null) as Record<string, unknown> | null;
      if (metadata) {
        // v1 parity: surface dispatch metadata (subagent session/model, title)
        // as merged args so downstream linkage keeps working
        const merged: Record<string, unknown> = { ...(state.input as Record<string, unknown>) };
        if (metadata.sessionId) merged.subagent_session_id = metadata.sessionId;
        if (metadata.model) merged.subagent_model = metadata.model;
        if (typeof state.title === 'string') merged.summary = state.title;
        argsJson = JSON.stringify(merged);
      } else {
        argsJson = JSON.stringify(state.input);
      }
    }
  }

  let resultJson: string | null = null;
  if (status === 'completed' && state.content !== undefined && state.content !== null) {
    resultJson = typeof state.content === 'string' ? state.content : JSON.stringify(state.content);
  } else if (status === 'error') {
    if (state.error !== undefined && state.error !== null) {
      resultJson = typeof state.error === 'string' ? state.error : JSON.stringify(state.error);
    } else if (state.content !== undefined && state.content !== null) {
      resultJson = typeof state.content === 'string' ? state.content : JSON.stringify(state.content);
    }
  }

  return {
    toolCallId: typeof c.id === 'string' ? c.id : '',
    toolName: typeof c.name === 'string' ? c.name : '',
    argsJson,
    resultJson,
    state: status,
  };
}

function v2AssistantRow(
  msg: { time_created: number },
  msgType: string,
  msgData: Record<string, unknown>,
  subagentName: string | null,
  subagentSessionId: string | null,
): RawInteraction {
  const timeInfo = v2TimeInfo(msgData, msg.time_created);
  const latency = timeInfo.completed !== undefined && timeInfo.completed >= timeInfo.created
    ? timeInfo.completed - timeInfo.created
    : null;

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCallInfo[] = [];

  if (Array.isArray(msgData.content)) {
    for (const item of msgData.content) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      if (c.type === 'text' && typeof c.text === 'string') {
        textParts.push(c.text);
      } else if (c.type === 'reasoning' && typeof c.text === 'string') {
        reasoningParts.push(c.text);
      } else if (c.type === 'tool') {
        toolCalls.push(v2ToolCallInfo(c));
      }
    }
  }

  const isCompaction = msgType === 'compaction';
  let content: string | null;
  if (isCompaction) {
    content = typeof msgData.summary === 'string' ? msgData.summary : null;
  } else {
    const parts: string[] = [];
    if (reasoningParts.length > 0) parts.push(`<thinking>${reasoningParts.join('\n')}</thinking>`);
    if (textParts.length > 0) parts.push(textParts.join('\n'));
    content = parts.length > 0 ? parts.join('\n\n') : null;
  }

  const modelRef = msgData.model as Record<string, unknown> | null;
  const modelID = modelRef && typeof modelRef.id === 'string' ? modelRef.id : null;
  const providerID = modelRef && typeof modelRef.providerID === 'string' ? modelRef.providerID : null;

  return {
    role: 'assistant',
    content,
    timestamp: new Date(timeInfo.created).toISOString(),
    timeInfo,
    agent: isCompaction ? 'compaction' : (typeof msgData.agent === 'string' ? msgData.agent : null),
    subagent_name: subagentName,
    subagent_session_id: subagentSessionId,
    subagent_type: null,
    tool_calls: toolCalls.length > 0 ? toolCalls : null,
    usage: v2TokenUsage(msgData),
    model: modelRefString(msgData.model),
    modelID,
    providerID,
    latency,
    finish_reason: typeof msgData.finish === 'string' ? msgData.finish : null,
  };
}

function _readSessionV2(db: Database.Database, sessionId: string): RawInteraction[] {
  const sessionRow = db.prepare(
    'SELECT id, parent_id, title FROM session_v2 WHERE id = ?'
  ).get(sessionId) as { id: string; parent_id: string | null; title: string | null } | undefined;

  if (!sessionRow) return [];

  const isSubagent = Boolean(sessionRow.parent_id && sessionRow.parent_id !== '');

  let subagent_name: string | null = null;
  if (isSubagent && sessionRow.title) {
    const titleMatch = sessionRow.title.match(/@\((\w+)\)\s+subagent/);
    if (titleMatch) {
      subagent_name = titleMatch[1];
    } else {
      const agentFromTitle = sessionRow.title.match(/@(\w+)/);
      if (agentFromTitle) subagent_name = agentFromTitle[1];
    }
  }

  const messages = db.prepare(
    'SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq'
  ).all(sessionId) as { id: string; type: string; seq: number; time_created: number; data: string }[];

  const result: RawInteraction[] = [];

  for (const msg of messages) {
    // 控制面行（idle/shell/*-switched）与未知未来类型都不在可导入白名单内，
    // 与列表 turnCount、自动刷新探针共享同一真身（V2_IMPORTABLE_TYPES）。
    if (!V2_IMPORTABLE_TYPES.includes(msg.type)) {
      continue;
    }

    try {
      const msgData = JSON.parse(msg.data) as Record<string, unknown>;

      if (msg.type === 'assistant' || msg.type === 'compaction') {
        result.push(v2AssistantRow(msg, msg.type, msgData, isSubagent ? subagent_name : null, isSubagent ? sessionId : null));
        continue;
      }

      if (msg.type === 'user' || msg.type === 'synthetic' || msg.type === 'skill' || msg.type === 'system') {
        const timeInfo = v2TimeInfo(msgData, msg.time_created);
        result.push({
          role: msg.type === 'system' ? 'system' : 'user',
          content: typeof msgData.text === 'string' ? msgData.text : null,
          timestamp: new Date(timeInfo.created).toISOString(),
          timeInfo,
          agent: null,
          subagent_name: isSubagent ? subagent_name : null,
          subagent_session_id: isSubagent ? sessionId : null,
          subagent_type: null,
          tool_calls: null,
          usage: null,
          model: null,
          modelID: null,
          providerID: null,
          latency: null,
          finish_reason: null,
        });
        continue;
      }
    } catch {
      result.push({
        role: 'unknown',
        content: null,
        timestamp: new Date(msg.time_created).toISOString(),
        timeInfo: { created: msg.time_created },
        agent: null,
        subagent_name: null,
        subagent_session_id: null,
        subagent_type: null,
        tool_calls: null,
        usage: null,
        model: null,
        modelID: null,
        providerID: null,
        latency: null,
        finish_reason: null,
      });
    }
  }

  return result;
}

// ── WithDb variants: reuse an existing DB connection ──

export function listSubagentSessionsWithDb(db: Database.Database, parentSessionId: string): string[] {
  return _listSubagentSessions(db, parentSessionId);
}

export function readSessionWithDb(db: Database.Database, sessionId: string): RawInteraction[] {
  const schema = opencodeSchemaOf(db);
  if (schema === null) throw new NotOpencodeDbError(listTables(db));
  if (opencodeReaderGeneration(db, sessionId) === 2) return _readSessionV2(db, sessionId);
  return _readSession(db, sessionId);
}

export interface SessionMeta {
  parentId: string | null;
  /** opencode 小模型生成的会话标题（title-gen 产物）。旧版 opencode.db 无此列 → null。 */
  title: string | null;
  version: string | null;
  directory: string | null;
  summaryAdditions: number;
  summaryDeletions: number;
  summaryFiles: number;
}

export function readSessionMeta(db: Database.Database, sessionId: string): SessionMeta {
  if (opencodeReaderGeneration(db, sessionId) === 2) {
    // SELECT * 而非点名列（v1 同款纪律）：opencode 演进加列不炸旧读方
    const rowV2 = db.prepare(
      'SELECT * FROM session_v2 WHERE id = ?'
    ).get(sessionId) as {
      parent_id?: string | null;
      title?: string | null;
      version?: string | null;
      directory?: string | null;
      summary_additions?: number | null;
      summary_deletions?: number | null;
      summary_files?: number | null;
    } | undefined;

    if (!rowV2) return { parentId: null, title: null, version: null, directory: null, summaryAdditions: 0, summaryDeletions: 0, summaryFiles: 0 };

    return {
      parentId: rowV2.parent_id && rowV2.parent_id !== '' ? rowV2.parent_id : null,
      title: rowV2.title ?? null,
      version: rowV2.version ?? null,
      directory: rowV2.directory ?? null,
      summaryAdditions: rowV2.summary_additions ?? 0,
      summaryDeletions: rowV2.summary_deletions ?? 0,
      summaryFiles: rowV2.summary_files ?? 0,
    };
  }

  // SELECT * 而非点名列：title 列是 opencode 较新版本才有的——点名在旧库
  // 上直接 SQL 报错；* 读不存在的列只得 undefined → ?? null 平滑兼容
  const row = db.prepare(
    'SELECT * FROM session WHERE id = ?'
  ).get(sessionId) as {
    parent_id?: string | null;
    title?: string | null;
    version?: string | null;
    directory?: string | null;
    summary_additions?: number | null;
    summary_deletions?: number | null;
    summary_files?: number | null;
  } | undefined;

  if (!row) return { parentId: null, title: null, version: null, directory: null, summaryAdditions: 0, summaryDeletions: 0, summaryFiles: 0 };

  return {
    parentId: row.parent_id && row.parent_id !== '' ? row.parent_id : null,
    title: row.title ?? null,
    version: row.version ?? null,
    directory: row.directory ?? null,
    summaryAdditions: row.summary_additions ?? 0,
    summaryDeletions: row.summary_deletions ?? 0,
    summaryFiles: row.summary_files ?? 0,
  };
}
