// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { PrismaClient, Prisma } from '@prisma/client';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { BRAND_SOURCE_TYPE } from '@/lib/branding';
import { getAdapter } from './adapters/index';
import { listSubagentSessionsWithDb, readSessionWithDb, readSessionMeta } from './adapters/opencode-db';
import { listSubagentSessions as listClaudeSubagentSessions, collectSubagentToolUseMappings as collectClaudeToolUseMappings, extractVersion as extractClaudeVersion } from './adapters/claude-jsonl';
import { classifyProxyCapture, readCcSessionMeta, proxyRecordingFrameworkFromVersion } from './proxy-classify';
import { isProxyVersion } from '../shared/session-format';
import { normalize } from './normalize';
import { splitIntoTurns, resetIdCounter } from './turn-split';
import type { TurnRow, ToolCallRow, SkillEventRow } from './turn-split';
import { dedupSession, mergeToolCalls, mergeSkillEvents, diffTurns, diffToolCalls, rankedKeyMap, keyByRankedTurn, detectRankedPrefixDrift } from './merge';
import { buildBridges, resetIdCounter as resetBridgeIdCounter } from './bridge-builder';
import { splitExecutions, resetIdCounter as resetExecIdCounter } from './execution-split';
import type { ExecutionRow } from './execution-split';
import type { InteractionBridgeRow } from './bridge-builder';
import type { RawInteraction } from '../shared/types';

function toDate(v: string | null): Date | null {
  return v ? new Date(v) : null;
}

/** 行的记录类（framework 身份，方案一：同 sid 原生/proxy 各一行）：
 * - proxy 行（version 带 marker）按 version 推导——映射与分类器同源，
 *   framework 误标史不参与判定；insight 导出行（cannbot-insight，可能带
 *   -proxy version——导出自捕获会话）保持导出身份，不参与双类拆分
 * - 非 proxy 行原样 framework */
function recordingClassOfSessionRow(row: { framework: string; version: string | null }): string {
  if (isProxyVersion(row.version)) {
    if (row.framework === BRAND_SOURCE_TYPE) return row.framework;
    return proxyRecordingFrameworkFromVersion(row.version) ?? row.framework;
  }
  return row.framework;
}

// user turn 现保留 <system-reminder> 全文（wire 保真）；label/query 预览
// 剥掉 reminder 前缀块 —— 显示真实提示而非注入上下文。
function previewText(text: string | null | undefined): string | null {
  if (!text) return null;
  const stripped = text.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '').trim();
  return (stripped || text).substring(0, 200);
}

// 首真人查询（会话 label/query 来源）。注入分类后（adapter 侧
// classifyAgentInjection 把 handback 回放/背景事件等重分类为 system），
// user turn 即真人输入。两个补充护栏：
// - 只看主会话行（子代理的任务提示/文档注入不作会话标题）
// - 跳过整篇文档形态的 user 消息（claude-code 把 handoff 交付件/范式文档
//   整篇注入为 user 行，无 wire 自声明可辨——只影响取标题，不动 turn 本身）
// 中途接入的捕获可能全程无 user turn（cpx 只覆盖会话尾部）——回落到首条
// 有实质内容的 assistant 文本（剥 thinking、跳过纯 <block> 安全审查应答），
// 再无则 null。
export function firstHumanQueryText(
  rows: Array<{ role: string; content: string | null; subagent_session_id?: string | null; subagentSessionId?: string | null }>,
): string | null {
  const isMain = (r: { subagent_session_id?: string | null; subagentSessionId?: string | null }) =>
    (r.subagent_session_id ?? r.subagentSessionId) == null;
  // 文档注入判定只看开头 200 字符：注入文档（CLAUDE.md/AGENTS.md 形态）的
  // 块引用紧随标题；而 skill 调用正文（可上万字节）深处偶现的引用块不该
  // 连累整条消息——实测 ses_f4c5b028 的 13.6KB skill 调用说明在第 1402
  // 字符处的块引用被旧"全文任一处含 \n> "整条误杀，Query 落到后台任务
  // 通知上
  const isDocInjection = (text: string) =>
    (text.startsWith('# ') && text.slice(0, 200).includes('\n> ')) || text.startsWith('"""');
  // opencode 后台任务通知（<task id=… state=…>，任务完成/失败时注入的
  // user 消息）不是真人输入——实测单会话可上百条，捕获/续跑恰好从通知
  // 处开始时会被误选为 Query
  const isTaskNotification = (text: string) => text.startsWith('<task ');
  const user = rows.find(r => r.role === 'user' && isMain(r) && r.content
    && !isDocInjection(r.content) && !isTaskNotification(r.content));
  if (user) return previewText(user.content);
  for (const r of rows) {
    if (r.role !== 'assistant' || !r.content || !isMain(r)) continue;
    const stripped = r.content
      .replace(/^<thinking>[\s\S]*?<\/thinking>\s*/, '')
      .replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '')
      .trim();
    if (stripped && !stripped.startsWith('<block>')) return previewText(stripped);
  }
  return null;
}

// 会话 Query 决议：opencode 小模型生成的会话标题优先（对意图的浓缩远准于
// 首条消息截取，续跑/中途捕获场景尤其）；"New session - <ts>" 是标题生成
// 未完成时的缺省占位，不如回落首真人查询。native 行（opencode-db）有
// 标题；proxy 捕获里 title-gen 请求被 cpx 过滤（isTitleGenRecord），
// 天然走回落。
export function resolveSessionQuery(
  meta: { title?: string | null },
  rows: Array<{ role: string; content: string | null; subagent_session_id?: string | null; subagentSessionId?: string | null }>,
): string | null {
  if (meta.title && !meta.title.startsWith('New session - ')) return meta.title;
  return firstHumanQueryText(rows);
}

async function batchCreateMany(
  tx: Prisma.TransactionClient,
  model: string,
  data: unknown[],
  batchSize: number = 500,
): Promise<void> {
  if (!Array.isArray(data) || data.length === 0) return;
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    await (tx as any)[model].createMany({ data: batch });
  }
}

interface ExecutionSkillData {
  skillName: string;
  skillVersion: number | null;
  isPrimary: boolean;
  user: string | null;
}

function computeExecutionSkills(
  executions: ExecutionRow[],
  turns: TurnRow[],
  skillEvents: SkillEventRow[]
): Map<string, ExecutionSkillData[]> {
  const result = new Map<string, ExecutionSkillData[]>();

  for (const execution of executions) {
    const executionTurns = execution.isSubagent
      ? turns.filter(t => t.subagentSessionId === execution.agentSessionId)
      : turns.filter(t => !t.isSubagent);

    const executionTurnIds = new Set(executionTurns.map(t => t.id));
    const executionSkillEvents = skillEvents.filter(se => executionTurnIds.has(se.turnId));

    const uniqueSkillNames = [...new Set(executionSkillEvents.map(se => se.skillName))];
    const skills: ExecutionSkillData[] = uniqueSkillNames.map(skillName => {
      const loadEvent = executionSkillEvents.find(
        se => se.skillName === skillName && se.eventType === 'load'
      );
      return {
        skillName,
        skillVersion: loadEvent?.skillVersion ?? null,
        isPrimary: false,
        user: null,
      };
    });

    result.set(execution.id, skills);
  }

  return result;
}

// Execution / ExecutionSkill / InteractionBridge / SessionSkill 的重建数据。
// 三条写入路径（新建、importSession merge、deltaRefresh）共用：merge 路径
// 早期只 merge turns 不重建派生数据，subagent 有 Turn 无 Execution（Bug #5/#6）。
// turns 的 id 须已换成 DB id（已存在的行），否则聚合挂不上 toolCalls。
interface ExecutionGraphData {
  executionsData: Record<string, unknown>[];
  executionSkillsData: Array<{ executionId: string; skillName: string; skillVersion: number | null; isPrimary: boolean; user: string | null }>;
  bridgesData: Record<string, unknown>[];
  sessionSkillsData: Array<{ sessionId?: string; skillName: string; skillVersion: number | null; invocationCount: number }>;
  rootExecutionId: string | null;
}

function buildExecutionGraph(
  turns: TurnRow[],
  toolCalls: ToolCallRow[],
  skillEvents: SkillEventRow[],
  interactions: RawInteraction[],
  taskId: string,
  toolUseIdMapping?: Map<string, string>,
): ExecutionGraphData {
  const executions = splitExecutions(turns, toolCalls, skillEvents, taskId);
  const rootExecutionId = executions.find(e => !e.isSubagent)?.id ?? null;
  const bridges: InteractionBridgeRow[] = rootExecutionId
    ? buildBridges(interactions, toolCalls, turns, taskId, rootExecutionId, toolUseIdMapping)
    : [];

  const executionsData = executions.map(e => ({
    id: e.id,
    agentName: e.agentName,
    agentSessionId: e.agentSessionId,
    isSubagent: e.isSubagent,
    subagentType: e.subagentType,
    subagentName: e.subagentName,
    parentExecutionId: e.parentExecutionId,
    rootExecutionId: e.rootExecutionId,
    depth: e.depth,
    tokens: e.tokens,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    reasoningTokens: e.reasoningTokens,
    cacheReadInputTokens: e.cacheReadInputTokens,
    cacheCreationInputTokens: e.cacheCreationInputTokens,
    maxSingleCallTokens: e.maxSingleCallTokens,
    cost: e.cost,
    latencyMs: e.latencyMs,
    createdAt: new Date(e.createdAt),
    toolCallCount: e.toolCallCount,
    toolCallErrorCount: e.toolCallErrorCount,
    llmCallCount: e.llmCallCount,
    skillLoadCount: e.skillLoadCount,
    skillInvokeCount: e.skillInvokeCount,
    finalResult: e.finalResult,
    model: e.model,
  }));

  const executionSkillsMap = computeExecutionSkills(executions, turns, skillEvents);
  const executionSkillsData: ExecutionGraphData['executionSkillsData'] = [];
  for (const [execId, skills] of executionSkillsMap) {
    for (const es of skills) {
      executionSkillsData.push({
        executionId: execId,
        skillName: es.skillName,
        skillVersion: es.skillVersion,
        isPrimary: es.isPrimary,
        user: es.user,
      });
    }
  }

  const bridgesData = bridges.map(b => ({
    dispatchExecutionId: b.dispatchExecutionId,
    dispatchTurnId: b.dispatchTurnId,
    dispatchToolCallId: b.dispatchToolCallId,
    dispatchContent: b.dispatchContent,
    dispatchTimestamp: toDate(b.dispatchTimestamp),
    responseExecutionId: b.responseExecutionId,
    responseTurnId: b.responseTurnId,
    responseContent: b.responseContent,
    responseTimestamp: toDate(b.responseTimestamp),
    subagentSessionId: b.subagentSessionId,
    subagentType: b.subagentType,
    subagentName: b.subagentName,
    status: b.status,
    subagentTokens: b.subagentTokens,
    subagentLatencyMs: b.subagentLatencyMs,
  }));

  const uniqueSkillNames = [...new Set(skillEvents.map(se => se.skillName))];
  const sessionSkillsData = uniqueSkillNames.map(skillName => {
    const invocationCount = skillEvents.filter(
      se => se.skillName === skillName && (se.eventType === 'invoke' || se.eventType === 'use' || se.eventType === 'dispatch')
    ).length;
    const loadEvent = skillEvents.find(se => se.skillName === skillName && se.eventType === 'load');
    return {
      skillName,
      skillVersion: loadEvent?.skillVersion ?? null,
      invocationCount,
    };
  });

  return { executionsData, executionSkillsData, bridgesData, sessionSkillsData, rootExecutionId };
}

async function replaceExecutionGraph(
  tx: Prisma.TransactionClient,
  prismaSessionId: string,
  graph: ExecutionGraphData,
): Promise<void> {
  await tx.execution.deleteMany({ where: { sessionId: prismaSessionId } });
  await batchCreateMany(tx, 'Execution' as Prisma.ModelName,
    graph.executionsData.map(e => ({ ...e, sessionId: prismaSessionId })));

  await batchCreateMany(tx, 'ExecutionSkill' as Prisma.ModelName, graph.executionSkillsData);

  await tx.interactionBridge.deleteMany({ where: { sessionId: prismaSessionId } });
  await batchCreateMany(tx, 'InteractionBridge' as Prisma.ModelName,
    graph.bridgesData.map(b => ({ ...b, sessionId: prismaSessionId })));

  await tx.sessionSkill.deleteMany({ where: { sessionId: prismaSessionId } });
  await batchCreateMany(tx, 'SessionSkill' as Prisma.ModelName,
    graph.sessionSkillsData.map(s => ({ ...s, sessionId: prismaSessionId })));
}

export function computeSessionAggregates(
  turns: TurnRow[],
  toolCalls: ToolCallRow[],
  skillEvents: SkillEventRow[],
): {
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCost: number;
  totalLatencyMs: number;
  totalToolCallCount: number;
  totalLlmCallCount: number;
  totalSkillLoadCount: number;
  totalSubagentCount: number;
  startTime: Date;
  endTime: Date | null;
  model: string | null;
} {
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCost = 0;
  let totalLatencyMs = 0;
  let totalLlmCallCount = 0;

  const startTime = turns.length > 0 && turns[0].createdAt_ts
    ? new Date(turns[0].createdAt_ts)
    : new Date();

  let endTime: Date | null = null;
  for (const turn of turns) {
    if (turn.completedAt) {
      const d = new Date(turn.completedAt);
      if (!endTime || d > endTime) endTime = d;
    } else if (turn.createdAt_ts) {
      const d = new Date(turn.createdAt_ts);
      if (!endTime || d > endTime) endTime = d;
    }
  }

  // 最频次模型（并列取先出现——确定性；单模型会话与旧「取首条」行为一致，
  // 混合模型长会话不再被首条边缘样本代表，现场：3.5 天会话首响 glm-4.7 ×1、
  // 主力 claude-sonnet-5 ×1710）
  let model: string | null = null;
  const modelCounts = new Map<string, number>();
  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.model) {
      modelCounts.set(turn.model, (modelCounts.get(turn.model) ?? 0) + 1);
    }
  }
  let modelMaxCount = 0;
  for (const [m, c] of modelCounts) {
    if (c > modelMaxCount) { modelMaxCount = c; model = m; }
  }

  for (const turn of turns) {
    totalTokens += turn.totalTokens;
    totalInputTokens += turn.inputTokens;
    totalOutputTokens += turn.outputTokens;
    totalReasoningTokens += turn.reasoningTokens;
    totalCacheReadTokens += turn.cacheReadTokens;
    totalCacheWriteTokens += turn.cacheWriteTokens;
    if (turn.role === 'assistant') {
      totalLatencyMs += turn.latencyMs;
    }
    if (turn.role === 'assistant' && turn.totalTokens > 0) {
      totalLlmCallCount++;
      totalCost += turn.cost;
    }
  }

  const uniqueSubagentIds = new Set<string>();
  for (const turn of turns) {
    if (turn.isSubagent && turn.subagentSessionId) {
      uniqueSubagentIds.add(turn.subagentSessionId);
    }
  }

  const totalToolCallCount = toolCalls.length;
  const totalSkillLoadCount = skillEvents.length;
  const totalSubagentCount = uniqueSubagentIds.size;

  return {
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalCost,
    totalLatencyMs,
    totalToolCallCount,
    totalLlmCallCount,
    totalSkillLoadCount,
    totalSubagentCount,
    startTime,
    endTime,
    model,
  };
}

export async function importSession(
  dbPath: string,
  sessionId: string,
  prisma?: PrismaClient,
  sourcePath?: string,
  sourceType?: string
): Promise<{ sessionId: string; imported: boolean; query: string | null }> {
  const client = prisma ?? new PrismaClient();
  const srcType = sourceType ?? 'opencode-db';
  const t0 = Date.now();

  // For opencode-db source, open DB once and reuse the connection
  let sharedDb: Database.Database | null = null;
  if (srcType === 'opencode-db') {
    try {
      sharedDb = new Database(dbPath, { readonly: true });
    } catch {
      return { sessionId, imported: false, query: null };
    }
  }

  try {
    const t1 = Date.now();
    const adapter = getAdapter(srcType);
    if (!adapter) {
      throw new Error(`No adapter available for source type: "${srcType}"`);
    }

    const rawInteractions = srcType === 'opencode-db' && sharedDb
      ? readSessionWithDb(sharedDb, sessionId)
      : adapter.readSession(dbPath, sessionId);
    console.log(`[import] readSession: ${Date.now() - t1}ms, ${rawInteractions.length} interactions`);

    let sessionMeta: { parentId: string | null; title: string | null; version: string | null; directory: string | null; summaryAdditions: number; summaryDeletions: number; summaryFiles: number } = { parentId: null, title: null, version: null, directory: null, summaryAdditions: 0, summaryDeletions: 0, summaryFiles: 0 };
    // proxy 来源标记单独留存：merge 路径的 version 回填只用它（原生文件
    // merge 行为保持不变 —— 不回填 version），新 session 路径仍用完整 version
    let proxyVersionMarker: string | null = null;
    // 统一分类器结果（meta > 行级 source > wire 指纹，见 proxy-classify.ts）：
    // framework 是 agent 归属（opencode / claude-code / codex），marker 进 version。
    let proxyClass: ReturnType<typeof classifyProxyCapture> | null = null;
    // insight-export meta 的 framework 声明（DB 导出件）：导出的是既有会话的
    // 再记录，记录类用声明值——重导入并回原生行（如 opencode），而不是按
    // claude-jsonl 缺省新建 claude-code 重复行（(taskId, framework) 唯一索引
    // 下还会让 patchXCannbayColumns 的 meta 恢复撞唯一键）
    let exportDeclaredFramework: string | null = null;
    if (srcType === 'opencode-db' && sharedDb) {
      sessionMeta = readSessionMeta(sharedDb, sessionId);
    } else if (srcType === 'claude-jsonl') {
      const ccMeta = readCcSessionMeta(dbPath);
      const metaCcVersion = ccMeta?.ccVersion ?? null;
      if (ccMeta?.producer === 'insight-export' && ccMeta.framework) {
        exportDeclaredFramework = ccMeta.framework;
      }
      proxyClass = classifyProxyCapture(dbPath);
      proxyVersionMarker = proxyClass.marker;
      // meta.ccVersion 可能已带 -proxy 后缀（cannbay2 合成 meta 从 DB version
      // 原样带出）——再拼 marker 会双重后缀，已含则直接用
      const agentVersion = metaCcVersion ?? extractClaudeVersion(dbPath);
      sessionMeta.version = proxyVersionMarker
        ? (agentVersion
          ? (agentVersion.endsWith(`-${proxyVersionMarker}`) ? agentVersion : `${agentVersion}-${proxyVersionMarker}`)
          : proxyVersionMarker)
        : agentVersion;
    }
    // framework 是 agent 归属：分类器判定（meta/行级/指纹三级信号）优先；
    // 非 proxy 的 claude-jsonl 是 native claude-code。
    // 方案一（同 sid 双会话共存）：proxy 捕获的 framework 带 -proxy 记录后缀
    // （claude-code-proxy / opencode-proxy / codex-proxy / cannbot-proxy）——
    // (taskId, framework) 唯一索引下与同 sid 的原生会话各占一行，互不合并。
    const frameworkForCapture = proxyClass?.isProxy && proxyClass.framework
      ? `${proxyClass.framework}-proxy`
      : (exportDeclaredFramework ?? (srcType === 'claude-jsonl' ? 'claude-code' : srcType));
    // 记录类（方案一：同 sid 原生/proxy 捕获各一行）——空文件占位路径与
    // 正常导入路径共用的匹配身份
    const incomingRecordingClass = srcType === 'claude-jsonl'
      ? (proxyClass?.isProxy && proxyClass.framework
        ? `${proxyClass.framework}-proxy`
        : (exportDeclaredFramework ?? 'claude-code'))
      : (srcType === 'opencode-db' ? 'opencode' : srcType);

    if (rawInteractions.length === 0) {
      if (sharedDb) sharedDb.close();
      // Empty claude capture file: the proxy touches it at cpx startup, so
      // importing right after launch (or while waiting for the first user
      // input) reads zero records. Create a PLACEHOLDER session so it's
      // visible in the list; the merge path (refresh-session / re-import)
      // fills in turns as the file grows.
      // .jsonl.7z/.jsonl.gz 压缩态（7z at rest）也算已存在占位；同 sid 双会话（方案一）
      // 按记录类匹配，避免占位判定打到另一行上
      if (srcType === 'claude-jsonl' && (fs.existsSync(dbPath) || fs.existsSync(`${dbPath}.7z`) || fs.existsSync(`${dbPath}.gz`))) {
        const placeholderRows = await client.session.findMany({ where: { taskId: sessionId } });
        const existing = placeholderRows.find(r => recordingClassOfSessionRow(r) === incomingRecordingClass);
        if (existing) return { sessionId: existing.id, imported: false, query: existing.query ?? null };
        // 返回行 id（非 taskId 形参）：import-file route 以 findUnique({ id })
        // 取回，返回 taskId 会查不到 → 响应 framework/version 落 null（丢徽标）
        const created = await client.session.create({
          data: {
            taskId: sessionId,
            label: '（捕获中，暂无内容）',
            framework: frameworkForCapture,
            startTime: new Date(),
            sourcePath,
          },
        });
        return { sessionId: created.id, imported: true, query: null };
      }
      return { sessionId, imported: false, query: null };
    }

    const t2 = Date.now();
    const allRawInteractions = [...rawInteractions];
    let toolUseIdMapping: Map<string, string> | undefined = undefined;

    if (srcType === 'opencode-db' && sharedDb) {
      const subagentSessionIds = listSubagentSessionsWithDb(sharedDb, sessionId);
      for (const subId of subagentSessionIds) {
        const subInteractions = readSessionWithDb(sharedDb, subId);
        allRawInteractions.push(...subInteractions);
      }
    } else if (srcType === 'claude-jsonl') {
      const subagentFiles = listClaudeSubagentSessions(dbPath, sessionId);
      toolUseIdMapping = collectClaudeToolUseMappings(dbPath, sessionId);
      for (const sub of subagentFiles) {
        // 兼容压缩形态（7z at rest）：x.jsonl.7z/.jsonl.gz → x.meta.json
        const metaPath = sub.filePath.replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
        let subName: string | null = null;
        let subType: string | null = null;
        try {
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            subName = meta.name || meta.agentType || meta.description || null;
            subType = meta.agentType || null;
          }
        } catch {}

        const subInteractions = adapter.readSession(sub.filePath, sub.id);
        for (const interaction of subInteractions) {
          interaction.subagent_session_id = sub.id;
          if (subName) interaction.subagent_name = subName;
          if (subType) interaction.subagent_type = subType;
        }
        allRawInteractions.push(...subInteractions);
      }
    }
    console.log(`[import] subagents: ${Date.now() - t2}ms, ${allRawInteractions.length} total interactions`);

    const t3 = Date.now();
    const normalized = normalize(allRawInteractions, srcType);
    resetIdCounter();
    resetBridgeIdCounter();
    resetExecIdCounter();

    const { turns, toolCalls, skillEvents } = splitIntoTurns(normalized, sessionId);
    console.log(`[import] normalize+split: ${Date.now() - t3}ms, ${turns.length} turns, ${toolCalls.length} toolCalls, ${skillEvents.length} skillEvents`);

    const t4 = Date.now();
    // ── 同 sid 已存会话匹配：按「记录类」对齐（方案一：原生与 proxy 捕获各一行）──
    // 记录类 = framework 身份：claude-code / claude-code-proxy / opencode /
    // opencode-proxy / …。同 sid 同类 → merge（既有行为）；同 sid 异类 → 各建
    // 一行共存。旧数据兼容：早期捕获行 framework 无 -proxy 后缀——按 version
    // 标记推导记录类，framework 误标史（claude-code→opencode 修正）不参与判定。
    const sessionRowsForTask = await client.session.findMany({ where: { taskId: sessionId } });
    const existingSession = sessionRowsForTask.find(r => recordingClassOfSessionRow(r) === incomingRecordingClass) ?? null;

    const dedupResult = dedupSession(existingSession?.id ?? null, sessionId);
    console.log(`[import] dedup check: ${Date.now() - t4}ms, shouldImport=${dedupResult.shouldImport}`);

    // ── 增量导入路径（dedup/merge）──
    if (!dedupResult.shouldImport && dedupResult.existingSessionId) {
      const t5 = Date.now();
      const existingTurns = await client.turn.findMany({
        where: { sessionId: dedupResult.existingSessionId },
      });
      const existingToolCalls = await client.toolCall.findMany({
        where: { turnId: { in: existingTurns.map(t => t.id) } },
      });
      const existingSkillEvents = await client.skillEvent.findMany({
        where: { turnId: { in: existingTurns.map(t => t.id) } },
      });

      const existingSessionPrismaId = dedupResult.existingSessionId!;

      const existingTurnByRankedKey = keyByRankedTurn(existingTurns);
      const incomingRankedKeys = rankedKeyMap(turns);

      const newTurns = turns
        .filter(t => !existingTurnByRankedKey.has(incomingRankedKeys.get(t)!))
        .map(t => ({ ...t, sessionId: existingSessionPrismaId }));

      const turnIdRemap = new Map<string, string>();
      for (const turn of turns) {
        const existingDbId = existingTurnByRankedKey.get(incomingRankedKeys.get(turn)!)?.id;
        if (existingDbId) {
          turnIdRemap.set(turn.id, existingDbId);
        }
      }

      const newTurnsData = newTurns.map(t => {
        const { cost: _turnCost, subagentType: _subagentType, ...rest } = t;
        return { ...rest, createdAt_ts: toDate(rest.createdAt_ts), completedAt: toDate(rest.completedAt) };
      });

      const remapTurnId = (id: string): string => turnIdRemap.get(id) ?? id;

      const remappedToolCalls = toolCalls.map(tc => ({ ...tc, turnId: remapTurnId(tc.turnId) }));
      const remappedSkillEvents = skillEvents.map(se => ({ ...se, turnId: remapTurnId(se.turnId) }));
      const turnsForGraph = turns.map(t => {
        const dbId = turnIdRemap.get(t.id);
        return dbId ? { ...t, id: dbId } : t;
      });
      const executionGraph = buildExecutionGraph(
        turnsForGraph, remappedToolCalls, remappedSkillEvents,
        normalized as unknown as RawInteraction[], sessionId, toolUseIdMapping,
      );

      const mergedToolCallRows = mergeToolCalls(
        existingToolCalls.map(tc => ({
          id: tc.id,
          turnId: tc.turnId,
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
        remappedToolCalls
      );

      const newToolCalls = mergedToolCallRows.filter(
        mc => !existingToolCalls.some(ec => ec.toolCallId === mc.toolCallId)
      ).map(mc => ({ ...mc, turnId: remapTurnId(mc.turnId) }));

      const newToolCallsData = newToolCalls.map(tc => ({
        ...tc,
        startedAt: toDate(tc.startedAt),
        completedAt: toDate(tc.completedAt),
      }));

      const mergedSkillEventRows = mergeSkillEvents(
        existingSkillEvents.map(se => ({
          id: se.id,
          turnId: se.turnId,
          skillName: se.skillName,
          skillVersion: se.skillVersion,
          eventType: se.eventType,
          success: se.success,
          errorMessage: se.errorMessage,
          argsJson: se.argsJson,
          startedAt: se.startedAt?.toISOString() ?? null,
          completedAt: se.completedAt?.toISOString() ?? null,
          durationMs: se.durationMs,
        })),
        remappedSkillEvents
      );

      const newSkillEvents = mergedSkillEventRows.filter(
        ms => !existingSkillEvents.some(es =>
          es.turnId === ms.turnId && es.skillName === ms.skillName && es.eventType === ms.eventType
        )
      ).map(ms => ({ ...ms, turnId: remapTurnId(ms.turnId) }));

      const newSkillEventsData = newSkillEvents.map(se => ({
        ...se,
        startedAt: toDate(se.startedAt),
        completedAt: toDate(se.completedAt),
      }));

      await client.$transaction(async (tx) => {
        await batchCreateMany(tx, 'Turn' as Prisma.ModelName, newTurnsData);
        await batchCreateMany(tx, 'ToolCall' as Prisma.ModelName, newToolCallsData);
        await batchCreateMany(tx, 'SkillEvent' as Prisma.ModelName, newSkillEventsData);
        await replaceExecutionGraph(tx, existingSessionPrismaId, executionGraph);
      }, { maxWait: 30000, timeout: 60000 });

      // Update session aggregates from all turns (old + new)
      const allTurnsAfterMerge = await client.turn.findMany({ where: { sessionId: existingSessionPrismaId } });
      const allToolCallsAfterMerge = await client.toolCall.findMany({
        where: { turnId: { in: allTurnsAfterMerge.map(t => t.id) } },
      });
      const allSkillEventsAfterMerge = await client.skillEvent.findMany({
        where: { turnId: { in: allTurnsAfterMerge.map(t => t.id) } },
      });

      const turnRowsForAgg = allTurnsAfterMerge.map(t => ({
        ...t,
        subagentType: null,
        cost: 0,
        createdAt_ts: t.createdAt_ts ? t.createdAt_ts.toISOString() : null,
        completedAt: t.completedAt ? t.completedAt.toISOString() : null,
      }));
      const updatedAggregates = computeSessionAggregates(
        turnRowsForAgg,
        allToolCallsAfterMerge as unknown as ToolCallRow[],
        allSkillEventsAfterMerge as unknown as SkillEventRow[],
      );

      const query = resolveSessionQuery(sessionMeta, allTurnsAfterMerge);
      const safeNum = (n: number) => (typeof n === 'number' && !isNaN(n)) ? n : 0;
      const safeDate = (d: Date | null) => d instanceof Date && !isNaN(d.getTime()) ? d : null;
      const updateData = {
        // 修复历史脏数据：老代码把 opencode 捕获建成 framework=claude-code，
        // merge 路径此前不回填 framework/version → 列表一直错显 Claude 徽标。
        // proxy 捕获重导入/刷新时用捕获文件内的 source 标记矫正归属。
        ...(srcType === 'claude-jsonl' && proxyVersionMarker ? {
          framework: frameworkForCapture,
          version: sessionMeta.version,
        } : {}),
        totalTokens: safeNum(updatedAggregates.totalTokens),
        totalInputTokens: safeNum(updatedAggregates.totalInputTokens),
        totalOutputTokens: safeNum(updatedAggregates.totalOutputTokens),
        totalReasoningTokens: safeNum(updatedAggregates.totalReasoningTokens),
        totalCacheReadTokens: safeNum(updatedAggregates.totalCacheReadTokens),
        totalCacheWriteTokens: safeNum(updatedAggregates.totalCacheWriteTokens),
        totalCost: safeNum(updatedAggregates.totalCost),
        totalLatencyMs: safeNum(updatedAggregates.totalLatencyMs),
        totalToolCallCount: safeNum(updatedAggregates.totalToolCallCount),
        totalLlmCallCount: safeNum(updatedAggregates.totalLlmCallCount),
        totalSkillLoadCount: safeNum(updatedAggregates.totalSkillLoadCount),
        totalSubagentCount: safeNum(updatedAggregates.totalSubagentCount),
        endTime: safeDate(updatedAggregates.endTime),
        rootExecutionId: executionGraph.rootExecutionId,
        ...(query ? { query } : {}),
        ...(updatedAggregates.model ? { model: updatedAggregates.model } : {}),
      };
      await client.session.update({
        where: { id: existingSessionPrismaId },
        data: updateData,
      });

      console.log(`[import] merge path total: ${Date.now() - t5}ms, overall: ${Date.now() - t0}ms`);
      return { sessionId: dedupResult.existingSessionId, imported: false, query: query };
    }

    // ── 新建 session 路径 ──
    const t6 = Date.now();
    const executionGraph = buildExecutionGraph(
      turns, toolCalls, skillEvents,
      normalized as unknown as RawInteraction[], sessionId, toolUseIdMapping,
    );
    const rootExecutionId = executionGraph.rootExecutionId;

    const aggregates = computeSessionAggregates(turns, toolCalls, skillEvents);
    const sessionQuery = resolveSessionQuery(sessionMeta, rawInteractions);

    const createdSessionId = await client.$transaction(async (tx) => {
      const ts0 = Date.now();
      const sessionRow = await tx.session.create({
        data: {
          taskId: sessionId,
          label: firstHumanQueryText(rawInteractions)?.substring(0, 100)
            ?? rawInteractions[0]?.content?.substring(0, 100) ?? null,
          query: sessionQuery,
          framework: srcType === 'claude-jsonl' ? frameworkForCapture : srcType === BRAND_SOURCE_TYPE ? srcType : 'opencode',
          model: aggregates.model,
          startTime: aggregates.startTime,
          endTime: aggregates.endTime,
          totalTokens: aggregates.totalTokens,
          totalInputTokens: aggregates.totalInputTokens,
          totalOutputTokens: aggregates.totalOutputTokens,
          totalReasoningTokens: aggregates.totalReasoningTokens,
          totalCacheReadTokens: aggregates.totalCacheReadTokens,
          totalCacheWriteTokens: aggregates.totalCacheWriteTokens,
          totalCost: aggregates.totalCost,
          totalLatencyMs: aggregates.totalLatencyMs,
          totalToolCallCount: aggregates.totalToolCallCount,
          totalLlmCallCount: aggregates.totalLlmCallCount,
          totalSkillLoadCount: aggregates.totalSkillLoadCount,
          totalSubagentCount: aggregates.totalSubagentCount,
          rootExecutionId: rootExecutionId,
          sourcePath: sourcePath ?? dbPath,
          parentId: sessionMeta.parentId,
          version: sessionMeta.version,
          directory: sessionMeta.directory,
          summaryAdditions: sessionMeta.summaryAdditions,
          summaryDeletions: sessionMeta.summaryDeletions,
          summaryFiles: sessionMeta.summaryFiles,
        },
      });
      const sid = sessionRow.id;
      console.log(`[import] session.create: ${Date.now() - ts0}ms`);

      const turnsData = turns.map(t => {
        const { cost: _turnCost, subagentType: _subagentType, ...rest } = t;
        return { ...rest, sessionId: sid, createdAt_ts: toDate(rest.createdAt_ts), completedAt: toDate(rest.completedAt) };
      });

      const toolCallsData = toolCalls.map(tc => ({
        ...tc,
        startedAt: toDate(tc.startedAt),
        completedAt: toDate(tc.completedAt),
      }));

      const skillEventsData = skillEvents.map(se => ({
        ...se,
        startedAt: toDate(se.startedAt),
        completedAt: toDate(se.completedAt),
      }));

      const ts1 = Date.now();
      await batchCreateMany(tx, 'Turn' as Prisma.ModelName, turnsData);
      await batchCreateMany(tx, 'ToolCall' as Prisma.ModelName, toolCallsData);
      await batchCreateMany(tx, 'SkillEvent' as Prisma.ModelName, skillEventsData);
      await replaceExecutionGraph(tx, sid, executionGraph);
      console.log(`[import] sessionSkill.createMany: ${executionGraph.sessionSkillsData.length} rows`);

      return sid;
    }, { maxWait: 30000, timeout: 60000 });

    console.log(`[import] new path total: ${Date.now() - t6}ms, overall: ${Date.now() - t0}ms`);
    return { sessionId: createdSessionId, imported: true, query: sessionQuery };
  } finally {
    if (sharedDb) sharedDb.close();
    if (!prisma) await client.$disconnect();
  }
}

// 轮次落库后的 Session 聚合重算 + 回写（merge 路径与漂移全量替换路径共用）。
// 聚合字段（totalTokens/totalCost/endTime/query 预览等）只在此处落库——
// 漂移全量替换若跳过此步，Session 行会永久残留替换前（位次错乱状态下）
// 算出的脏聚合；且漂移典型场景（opencode 升级发生在会话间歇）是一次性
// 触发，替换后轮数已与源相等、安静会话的 maxTimeUpdated 不再变化，没有
// 后续刷新能矫正。返回重算后的总轮数。
async function recomputeAndApplySessionAggregates(
  prisma: PrismaClient,
  session: { id: string; sourcePath: string | null; version: string | null },
  srcType: string,
  rootExecutionId: string | null,
  refreshMeta: { title?: string | null } = {},
): Promise<number> {
  const allTurns = await prisma.turn.findMany({ where: { sessionId: session.id } });
  const allToolCalls = await prisma.toolCall.findMany({
    where: { turnId: { in: allTurns.map(t => t.id) } },
  });
  const allSkillEvents = await prisma.skillEvent.findMany({
    where: { turnId: { in: allTurns.map(t => t.id) } },
  });

  const turnRowsForAgg = allTurns.map(t => ({
    ...t,
    subagentType: null,
    cost: 0,
    createdAt_ts: t.createdAt_ts ? t.createdAt_ts.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
  }));
  const updatedAggregates = computeSessionAggregates(
    turnRowsForAgg,
    allToolCalls as unknown as ToolCallRow[],
    allSkillEvents as unknown as SkillEventRow[],
  );

  const safeNum = (n: number) => (typeof n === 'number' && !isNaN(n)) ? n : 0;
  const safeDate = (d: Date | null) => d instanceof Date && !isNaN(d.getTime()) ? d : null;
  const query = resolveSessionQuery(refreshMeta, allTurns);

  // 同 merge 路径的历史脏数据矫正：proxy 捕获（含无 source 标记的早期产物，
  // 靠 wire 指纹兜底识别）重刷新时回填 framework/version，修复错显归属。
  // 反向矫正：历史上被污染导出件误标的 claude-proxy 徽标清掉（导出件
  // latency 靠 source 行内识别仍生效，不受 version 影响）。
  let refreshProxyFix: { framework?: string; version: string | null } | null = null;
  if (srcType === 'claude-jsonl' && session.sourcePath) {
    const cls = classifyProxyCapture(session.sourcePath);
    if (cls.isProxy) {
      const agentVersion = extractClaudeVersion(session.sourcePath);
      const marker = cls.marker!;
      refreshProxyFix = {
        framework: `${cls.framework}-proxy`,
        version: agentVersion ? `${agentVersion}-${marker}` : marker,
      };
    } else if (isProxyVersion(session.version)) {
      refreshProxyFix = { version: extractClaudeVersion(session.sourcePath) };
    }
  }

  await prisma.session.update({
    where: { id: session.id },
    data: {
      ...(refreshProxyFix ?? {}),
      totalTokens: safeNum(updatedAggregates.totalTokens),
      totalInputTokens: safeNum(updatedAggregates.totalInputTokens),
      totalOutputTokens: safeNum(updatedAggregates.totalOutputTokens),
      totalReasoningTokens: safeNum(updatedAggregates.totalReasoningTokens),
      totalCacheReadTokens: safeNum(updatedAggregates.totalCacheReadTokens),
      totalCacheWriteTokens: safeNum(updatedAggregates.totalCacheWriteTokens),
      totalCost: safeNum(updatedAggregates.totalCost),
      totalLatencyMs: safeNum(updatedAggregates.totalLatencyMs),
      totalToolCallCount: safeNum(updatedAggregates.totalToolCallCount),
      totalLlmCallCount: safeNum(updatedAggregates.totalLlmCallCount),
      totalSkillLoadCount: safeNum(updatedAggregates.totalSkillLoadCount),
      totalSubagentCount: safeNum(updatedAggregates.totalSubagentCount),
      endTime: safeDate(updatedAggregates.endTime),
      rootExecutionId,
      ...(query ? { query } : {}),
      ...(updatedAggregates.model ? { model: updatedAggregates.model } : {}),
    },
  });

  return allTurns.length;
}

export async function deltaRefreshSession(
  sessionId: string,
  prisma: PrismaClient,
  // 消歧（方案一：同 sid 双行）——调用方已解析出目标行时直传行对象，
  // 避免裸 taskId 二次查找打到另一行（refresh-session route 已按 framework
  // 解析出手头的正确行）；未传时按 taskId 回落单行解析（测试/审计场景）
  resolvedSession?: { id: string; taskId: string; framework: string; version: string | null; sourcePath: string | null },
): Promise<{ addedTurns: number; updatedTurns: number; addedToolCalls: number; updatedToolCalls: number; addedSkillEvents: number; fullRebuild?: boolean; rebuiltTurns?: number }> {
  const session = resolvedSession ?? await prisma.session.findFirst({ where: { taskId: sessionId } });
  if (!session || !session.sourcePath) {
    throw new Error(`Session not found or no sourcePath: "${sessionId}"`);
  }

  // sourceType 推断走统一分类器（proxy-classify.ts）：凡 proxy 捕获
  // （claude / opencode / codex，version 带 -proxy 后缀）都是 claude 格式
  // jsonl 变体 → claude-jsonl adapter。native opencode 走 opencode-db。
  const sourceType = isProxyVersion(session.version)
    ? 'claude-jsonl'
    : session.framework?.endsWith('-proxy')
    ? 'claude-jsonl'
    : session.framework === 'opencode' ? 'opencode-db'
    : session.framework === 'claude-code' ? 'claude-jsonl'
    : session.framework;

  const srcType = sourceType === 'opencode-db' ? 'opencode-db'
    : sourceType === 'claude-jsonl' ? 'claude-jsonl'
    : sourceType;

  let sharedDb: Database.Database | null = null;
  if (srcType === 'opencode-db') {
    sharedDb = new Database(session.sourcePath, { readonly: true });
  }

  const oldTurnCount = await prisma.turn.count({ where: { sessionId: session.id } });
  // opencode 标题（Query 决议优先项）：漂移全量替换与快路径两个回写点共用
  let refreshMeta: { title?: string | null } = {};
  if (sharedDb) {
    try { refreshMeta = readSessionMeta(sharedDb, session.taskId); } catch { /* best-effort */ }
  }

  try {
    const adapter = getAdapter(srcType);
    if (!adapter) throw new Error(`No adapter for: "${srcType}"`);

    const rawInteractions = srcType === 'opencode-db' && sharedDb
      ? readSessionWithDb(sharedDb, sessionId)
      : adapter.readSession(session.sourcePath, sessionId);

    const allRawInteractions = [...rawInteractions];
    let toolUseIdMapping: Map<string, string> | undefined = undefined;

    if (srcType === 'opencode-db' && sharedDb) {
      const subIds = listSubagentSessionsWithDb(sharedDb, sessionId);
      for (const subId of subIds) {
        allRawInteractions.push(...readSessionWithDb(sharedDb, subId));
      }
    } else if (srcType === 'claude-jsonl') {
      const subagentFiles = listClaudeSubagentSessions(session.sourcePath, sessionId);
      toolUseIdMapping = collectClaudeToolUseMappings(session.sourcePath, sessionId);
      for (const sub of subagentFiles) {
        const subInteractions = adapter.readSession(sub.filePath, sub.id);
        for (const interaction of subInteractions) {
          interaction.subagent_session_id = sub.id;
        }
        allRawInteractions.push(...subInteractions);
      }
    }

    if (allRawInteractions.length === 0) {
      return { addedTurns: 0, updatedTurns: 0, addedToolCalls: 0, updatedToolCalls: 0, addedSkillEvents: 0 };
    }

    const normalized = normalize(allRawInteractions, srcType);
    resetIdCounter();
    resetBridgeIdCounter();
    resetExecIdCounter();

    const { turns, toolCalls, skillEvents } = splitIntoTurns(normalized, sessionId);

    const existingTurns = await prisma.turn.findMany({ where: { sessionId: session.id } });
    const existingToolCalls = await prisma.toolCall.findMany({
      where: { turnId: { in: existingTurns.map(t => t.id) } },
    });
    const existingSkillEvents = await prisma.skillEvent.findMany({
      where: { turnId: { in: existingTurns.map(t => t.id) } },
    });

    const existingTurnRows: TurnRow[] = existingTurns.map(et => ({
        id: et.id,
        sessionId: et.sessionId,
        turnIndex: et.turnIndex,
        role: et.role,
        content: et.content,
        contentJson: et.contentJson,
        contentSummary: et.contentSummary,
        inputMessagesJson: et.inputMessagesJson,
        inputMessagesCount: et.inputMessagesCount,
        inputMessagesTokens: et.inputMessagesTokens,
        contextWindowPct: et.contextWindowPct,
        agentName: et.agentName,
        subagentName: et.subagentName,
        subagentSessionId: et.subagentSessionId,
        subagentType: null,
        totalTokens: et.totalTokens,
        inputTokens: et.inputTokens,
        outputTokens: et.outputTokens,
        reasoningTokens: et.reasoningTokens,
        cacheReadTokens: et.cacheReadTokens,
        cacheWriteTokens: et.cacheWriteTokens,
        cost: 0,
        createdAt_ts: et.createdAt_ts?.toISOString() ?? null,
        completedAt: et.completedAt?.toISOString() ?? null,
        latencyMs: et.latencyMs,
        ttftMs: et.ttftMs,
        model: et.model,
        modelId: et.modelId,
        providerId: et.providerId,
        temperature: et.temperature,
        maxTokens: et.maxTokens,
        finishReason: et.finishReason,
        isSubagent: et.isSubagent,
        parentExecutionId: et.parentExecutionId,
    }));
    const existingTurnByRankedKey = keyByRankedTurn(existingTurnRows);

    // ── 漂移检测（增量合法性前置校验）──────────────────────────────────
    // 位次匹配（ranked key）的合法性前提：每个上下文的"既有轮次 = 新读序列
    // 的前缀"（append-only）。源侧对旧消息的产出回溯性变化会打破前缀关系——
    // 现场：opencode 升级引入 step 部件后，同一旧消息多产出空轮 → 位次全盘
    // 错位 → user/assistant 角色互相覆写、空轮重复膨胀计数（已导入 > 源数，
    // countChanged 恒 false，同步判死）。检测到漂移即放弃带病增量，降级为
    // 全量替换：删光本会话轮次后一次性插入本次全量读入（与初导同源同序，
    // 位次关系重建，本地库秒级，绝对正确）。
    if (detectRankedPrefixDrift(existingTurnRows, turns)) {
      const newTurnsData = turns.map(t => {
        const { cost: _turnCost, subagentType: _subagentType, ...rest } = t;
        return { ...rest, sessionId: session.id, createdAt_ts: toDate(rest.createdAt_ts), completedAt: toDate(rest.completedAt) };
      });
      const newToolCallsData = toolCalls.map(tc => ({
        ...tc,
        startedAt: toDate(tc.startedAt),
        completedAt: toDate(tc.completedAt),
      }));
      const newSkillEventsData = skillEvents.map(se => ({
        ...se,
        startedAt: toDate(se.startedAt),
        completedAt: toDate(se.completedAt),
      }));
      const executionGraph = buildExecutionGraph(
        turns, toolCalls, skillEvents,
        normalized as unknown as RawInteraction[], sessionId, toolUseIdMapping,
      );
      await prisma.$transaction(async (tx) => {
        await tx.turn.deleteMany({ where: { sessionId: session.id } }); // 级联 toolCalls/skillEvents
        await batchCreateMany(tx, 'Turn' as Prisma.ModelName, newTurnsData);
        await batchCreateMany(tx, 'ToolCall' as Prisma.ModelName, newToolCallsData);
        await batchCreateMany(tx, 'SkillEvent' as Prisma.ModelName, newSkillEventsData);
        await replaceExecutionGraph(tx, session.id, executionGraph);
      }, { maxWait: 30000, timeout: 60000 });
      // 全量替换也必须重算 Session 聚合（与 merge 路径同源）——否则残留替换前
      // 的脏聚合且无后续刷新可矫正（见 recomputeAndApplySessionAggregates）
      const rebuiltCount = await recomputeAndApplySessionAggregates(
        prisma, session, srcType, executionGraph.rootExecutionId, refreshMeta,
      );
      return {
        addedTurns: Math.max(0, rebuiltCount - oldTurnCount),
        updatedTurns: 0,
        addedToolCalls: toolCalls.length,
        updatedToolCalls: 0,
        addedSkillEvents: skillEvents.length,
        fullRebuild: true,
        rebuiltTurns: rebuiltCount,
      };
    }

    const existingTcByToolCallId = new Map<string, ToolCallRow>();
    for (const tc of existingToolCalls) {
      existingTcByToolCallId.set(tc.toolCallId, {
        id: tc.id,
        turnId: tc.turnId,
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
      });
    }

    const incomingRankedKeys = rankedKeyMap(turns);
    const turnIdRemap = new Map<string, string>();
    for (const turn of turns) {
      const existingDbId = existingTurnByRankedKey.get(incomingRankedKeys.get(turn)!)?.id;
      if (existingDbId) {
        turnIdRemap.set(turn.id, existingDbId);
      }
    }

    const remapTurnId = (id: string): string => turnIdRemap.get(id) ?? id;

    const { toInsert: newTurns, toUpdate: turnUpdates } = diffTurns(existingTurnRows, turns);

    const remappedToolCalls = toolCalls.map(tc => ({ ...tc, turnId: remapTurnId(tc.turnId) }));
    const remappedSkillEvents = skillEvents.map(se => ({ ...se, turnId: remapTurnId(se.turnId) }));

    const { toInsert: newToolCalls, toUpdate: tcUpdates } = diffToolCalls(existingTcByToolCallId, remappedToolCalls);

    const existingSeKeys = new Set(
      existingSkillEvents.map(se => `${se.turnId}:${se.skillName}:${se.eventType}`)
    );
    const newSkillEvents = remappedSkillEvents.filter(se => !existingSeKeys.has(`${se.turnId}:${se.skillName}:${se.eventType}`));

    const newTurnsData = newTurns.map(t => {
      const { cost: _turnCost, subagentType: _subagentType, ...rest } = t;
      return { ...rest, sessionId: session.id, createdAt_ts: toDate(rest.createdAt_ts), completedAt: toDate(rest.completedAt) };
    });

    const newToolCallsData = newToolCalls.map(tc => ({
      ...tc,
      startedAt: toDate(tc.startedAt),
      completedAt: toDate(tc.completedAt),
    }));

    const newSkillEventsData = newSkillEvents.map(se => ({
      ...se,
      startedAt: toDate(se.startedAt),
      completedAt: toDate(se.completedAt),
    }));

    const appliedTurnUpdates = turnUpdates.map(u => {
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(u.data)) {
        if (k === 'completedAt' || k === 'createdAt_ts') {
          mapped[k] = toDate(v as string | null);
        } else {
          mapped[k] = v;
        }
      }
      return { dbId: u.dbId, data: mapped };
    });

    const volatileFields: (keyof TurnRow)[] = [
      'inputMessagesCount', 'inputMessagesTokens', 'contextWindowPct',
      'inputMessagesJson', 'contentJson',
    ];
    const matchedTurnVolatileUpdates: Array<{ dbId: string; data: Record<string, unknown> }> = [];
    for (const turn of turns) {
      const existingId = existingTurnByRankedKey.get(incomingRankedKeys.get(turn)!)?.id;
      if (!existingId) continue;
      const alreadyInDiffUpdate = appliedTurnUpdates.some(u => u.dbId === existingId);
      if (alreadyInDiffUpdate) {
        for (const f of volatileFields) {
          appliedTurnUpdates.find(u => u.dbId === existingId)!.data[f] = turn[f];
        }
      } else {
        const volatileData: Record<string, unknown> = {};
        let hasVolatileChange = false;
        const existingTurn = existingTurnByRankedKey.get(incomingRankedKeys.get(turn)!)!;
        for (const f of volatileFields) {
          if (turn[f] !== existingTurn[f]) {
            volatileData[f] = turn[f];
            hasVolatileChange = true;
          }
        }
        if (hasVolatileChange) {
          matchedTurnVolatileUpdates.push({ dbId: existingId, data: volatileData });
        }
      }
    }

    const appliedTcUpdates = tcUpdates.map(u => {
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(u.data)) {
        if (k === 'completedAt' || k === 'startedAt') {
          mapped[k] = toDate(v as string | null);
        } else {
          mapped[k] = v;
        }
      }
      return { dbId: u.dbId, data: mapped };
    });

    const turnsForGraph = turns.map(t => {
      const dbId = turnIdRemap.get(t.id);
      return dbId ? { ...t, id: dbId } : t;
    });
    const executionGraph = buildExecutionGraph(
      turnsForGraph, remappedToolCalls, remappedSkillEvents,
      normalized as unknown as RawInteraction[], sessionId, toolUseIdMapping,
    );
    const rootExecutionId = executionGraph.rootExecutionId;

    await prisma.$transaction(async (tx) => {
      await batchCreateMany(tx, 'Turn' as Prisma.ModelName, newTurnsData);
      for (const u of appliedTurnUpdates) {
        await tx.turn.update({ where: { id: u.dbId }, data: u.data });
      }
      for (const u of matchedTurnVolatileUpdates) {
        await tx.turn.update({ where: { id: u.dbId }, data: u.data });
      }

      await batchCreateMany(tx, 'ToolCall' as Prisma.ModelName, newToolCallsData);
      for (const u of appliedTcUpdates) {
        await tx.toolCall.update({ where: { id: u.dbId }, data: u.data });
      }

      await batchCreateMany(tx, 'SkillEvent' as Prisma.ModelName, newSkillEventsData);

      await replaceExecutionGraph(tx, session.id, executionGraph);
    }, { maxWait: 30000, timeout: 60000 });

    const newTurnCount = await recomputeAndApplySessionAggregates(
      prisma, session, srcType, rootExecutionId, refreshMeta,
    );

    return {
      addedTurns: Math.max(0, newTurnCount - oldTurnCount),
      updatedTurns: appliedTurnUpdates.length,
      addedToolCalls: newToolCallsData.length,
      updatedToolCalls: appliedTcUpdates.length,
      addedSkillEvents: newSkillEventsData.length,
    };
  } finally {
    if (sharedDb) sharedDb.close();
  }
}
