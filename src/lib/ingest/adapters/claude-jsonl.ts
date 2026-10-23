// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import { truncateUtf16Safe } from '@/lib/shared/text-strip';
import path from 'node:path';
import { readCaptureBuffer, readCaptureHead, readCaptureText as readArchivedText } from '@/lib/compression';
import { createLogger } from '@/lib/logger';
import { readEnvelope } from '@/lib/shared/envelope';
import { classifyUserInjection } from './injections/index';
import { isSkillInjectionText } from './injections/claude-code';
import { isRolloutFileName } from './codex-naming';
import { isDshSessionLogName } from '../dsh-bridge/native';
import type { SubagentRef } from './contract';
import type { SessionListItem, RawInteraction, ToolCallInfo, TokenUsage } from '../../shared/types';
import { normalizeToolResultPayload } from '../../tool-conventions';

// Shared scan helpers (claude-format concepts, also reused by the proxy
// extension layer claude-jsonl-full-context.ts).
export function extractSystemText(system: string | ContentBlock[] | undefined): string | null {
  if (!system) return null;
  if (typeof system === 'string') return system || null;
  const parts: string[] = [];
  for (const block of system) {
    if (block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export interface ClaudeJsonlLine {
  type: string;
  timestamp?: string;
  version?: string;
  message?: {
    id?: string;
    role: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: ClaudeUsage;
  };
  /** 子代理链标记（native claude-code 行级字段；true=sidechain 内的行） */
  isSidechain?: boolean;
  subtype?: string;
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  // Proxy extension fields (claude-emitter writes on assistant lines). The
  // adapter reads only the standard-semantics subset (source/stopReason/
  // duration_ms); system/tools/ttftMs/dedup markers are pure extension data
  // consumed by the extension layer (proxy-classify / claude-jsonl-full-context
  // / wire-rounds route). Undefined for native claude-code lines.
  // `duration_ms` is a native claude field the adapter already reads
  // (→ interaction.latency); the emitter repurposes it to carry wire latency
  // so it flows through the standard pipeline.
  source?: string;
  system?: unknown;
  tools?: unknown;
  stopReason?: string;
  ttftMs?: number;
  deduped?: boolean;
  originalChars?: number;
  // Ctrl+X Ctrl+C 插队消息（≥2.1.3xx queue 机制）的 delivery 行：用户原文在
  // attachment.prompt（不在 message.content），rendered 是发给模型的
  // system-reminder 包装。其余 attachment 子类型仍是纯元数据
  attachment?: AttachmentLike;
  // x_lake 信封字段：读方一律经 shared/envelope readEnvelope 解析
  // （键名单一真身），此处不再逐字段声明
}

export interface XLake {
  schema: string;
  version: number;
  data: {
    roundIndex?: number;
    protocol?: string;
    system?: unknown;
    tools?: unknown;
    requestParams?: { temperature?: number; maxTokens?: number; model?: string | null };
    latencyMs?: number;
    ttftMs?: number | null;
    stopReason?: string | null;
    status?: number;
    ccVersion?: string | null;
    kind?: string;
    dedup?: { originalChars: number; fingerprint: string };
    reasoningTokens?: number;
    toolCalls?: Array<{ toolUseId: string; state?: string; errorType?: string; errorMessage?: string; durationMs?: number; startedAt?: string }>;
    turnKind?: string;
    producer?: string;
    framework?: string;
    sid?: string;
    toolUseId?: string | null;
    name?: string | null;
    agentType?: string | null;
    subagentSessionId?: string;
    agentId?: string | null;
  };
}

// cc-wire-round（cpx 捕获）与 cc-db-turn（insight 导出）都声明
// latencyMs/stopReason 承载真实值 —— 等价于 legacy 的 *-proxy / insight-export 标记。
// version 门禁（spec §6）：只接受已知 schema + 已知 version；未知版本整块跳过
// （行本体照常按信封处理），防 v2 数据被旧读方按 v1 语义误读。首个 v2 落地
// 时在此注册表加版本分支即可。
const TURN_PAYLOAD_VERSIONS: Record<string, number[]> = {
  'cc-wire-round': [1],
  'cc-db-turn': [1],
};
export function isTurnPayload(xb: XLake | undefined): boolean {
  if (!xb) return false;
  const vs = TURN_PAYLOAD_VERSIONS[xb.schema];
  return !!vs && typeof xb.version === 'number' && vs.includes(xb.version);
}

// meta 声明式通道的 version 门禁（spec §6）：同款"已知 schema + 已知 version"判定，
// 未知版本 meta 整块跳过 → 落回顶层 legacy 字段。首个 v2 落地时在此注册表加版本。
const META_PAYLOAD_VERSIONS: Record<string, number[]> = {
  'cc-subagent-meta': [1],
  'cc-session-meta': [1],
};
export function isMetaPayload(xb: XLake | undefined, schema: string): boolean {
  if (!xb || xb.schema !== schema) return false;
  const vs = META_PAYLOAD_VERSIONS[schema];
  return !!vs && typeof xb.version === 'number' && vs.includes(xb.version);
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Record<string, unknown> | unknown[];
}

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function extractTextContent(content: string | ContentBlock[] | undefined): string | null {
  if (!content) return null;
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push(`<thinking>${block.thinking}</thinking>`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

// claude-code 系注入指纹（task-notification 解析 / ≥2.1 协议注入 / skill
// 注入谓词）已抽到 injections/claude-code.ts——框架自持，与 codex/
// opencode 家族分类器同层，由 injections/index.ts 按行级 source 分发。

// Remove <system-reminder>...</system-reminder> blocks from a user message,
// returning the real user prompt. Claude Code injects CLAUDE.md / gitStatus /
// currentDate / available-skills as these tags inside user messages — they're
// context, not real user input. Used for the session label / firstQuery
// extraction (the prompt preview should not be reminder noise).
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
}

function extractToolCalls(content: ContentBlock[]): ToolCallInfo[] | null {
  const toolUseBlocks = content.filter(b => b.type === 'tool_use');
  if (toolUseBlocks.length === 0) return null;

  const toolResultBlocks = content.filter(b => b.type === 'tool_result');
  const resultMap = new Map<string, string>();
  for (const r of toolResultBlocks) {
    if (r.tool_use_id && r.content) {
      resultMap.set(r.tool_use_id, normalizeToolResultPayload(r.content) ?? '');
    }
  }

  return toolUseBlocks.map(b => ({
    toolCallId: b.id ?? '',
    toolName: b.name ?? '',
    argsJson: b.input ? JSON.stringify(b.input) : null,
    resultJson: (() => { const v = resultMap.get(b.id ?? '') ?? null; return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)); })(),
    state: 'completed',
  }));
}

function mapUsage(usage: ClaudeUsage | undefined, costUsd?: number): TokenUsage | null {
  if (!usage) return null;
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    total: input + (usage.output_tokens ?? 0) + cacheRead + cacheWrite,
    input,
    output: usage.output_tokens ?? 0,
    reasoning: 0,
    cacheRead,
    cacheWrite,
    cost: costUsd ?? 0,
    inputMessagesTokens: input + cacheRead + cacheWrite,
  };
}

// 文件名 → 会话 id（SourceDescriptor.deriveSessionId 能力的命名层）：.jsonl.7z /
// .jsonl.gz（压缩态）与 .jsonl（明文）三形态取 stem；proxy 捕获文件的
// cpx- 前缀剥掉——目录扫描、单文件直导与服务端缺省推导必须落同一 taskId，
// 否则同一会话以 cpx-<sid>/<sid> 双身份重复入库
export function deriveSessionIdFromName(fileName: string): string {
  return fileName.replace(/\.jsonl(\.7z|\.gz)?$/, '').replace(/^cpx-/, '');
}

// 路径 → 会话 id（SourceDescriptor.deriveSessionId 能力）：deriveSessionId
// 契约收完整路径（DSH 的 id 取日志父目录名，只有 basename 推不出来），
// claude 规则只看文件名，先剥目录
export function deriveSessionIdFromPath(filePath: string): string {
  return deriveSessionIdFromName(path.basename(filePath));
}

// 内容级识别（SourceDescriptor.detectContent 能力）：首 N 条有效 JSON 行中
// 任一命中 claude wire 信封（type + message 对象）即认领——不要求首行命中
// （summary/result 等无 message 的元数据行可能在前）。三形态透明解压；
// 读不出/无有效行 → null（无法判定，解析层信任声明值）。
const DETECT_SCAN_LINES = 10;

export function detectContent(filePath: string): boolean | null {
  let buf: Buffer;
  try {
    buf = readCaptureHead(resolveCaptureForm(filePath));
  } catch {
    return null;
  }
  let valid = 0;
  let matched = false;
  let start = 0;
  const consider = (end: number): void => {
    const t = buf.toString('utf-8', start, end).trim();
    start = end + 1;
    if (!t || t.startsWith('//')) return;
    try {
      const obj = JSON.parse(t) as { type?: unknown; message?: unknown };
      valid += 1;
      if (typeof obj.type === 'string' && obj.message != null && typeof obj.message === 'object') matched = true;
    } catch {
      // 坏行/半写行（活文件尾行）跳过
    }
  };
  for (let i = 0; i < buf.length && !matched && valid < DETECT_SCAN_LINES; i++) {
    if (buf[i] === 0x0a) consider(i);
  }
  if (!matched && valid < DETECT_SCAN_LINES) consider(buf.length);
  if (matched) return true;
  return valid > 0 ? false : null;
}

// 捕获文件行流（7z at rest，docs 见 proxy/COMPRESSION-DESIGN.md）：
// .jsonl.7z / .jsonl.gz → 透明解压；.jsonl 直读；sourcePath 指向明文但盘上已
// 压缩（cpx 退出压缩后 sourcePath 未更新形态）或反之（resume scratch 态）时
// 双向互找。压缩是传输编码，行流内容与明文形态逐字节一致。
function resolveCaptureForm(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    if (filePath.endsWith('.jsonl')) {
      if (fs.existsSync(`${filePath}.7z`)) return `${filePath}.7z`;
      if (fs.existsSync(`${filePath}.gz`)) return `${filePath}.gz`;
    } else if (/\.jsonl\.(7z|gz)$/.test(filePath) && fs.existsSync(filePath.replace(/\.(7z|gz)$/, ''))) {
      return filePath.replace(/\.(7z|gz)$/, '');
    }
  }
  return filePath;
}

function readCaptureText(filePath: string): string {
  return readArchivedText(resolveCaptureForm(filePath));
}

// V8 单字符串上限（0x1FFFFFE8 ≈ 512MiB）：解压后整体 toString 必炸——
// 现场 631MB wire 捕获（3.5 天会话）导入即 RangeError，且旧实现的
// catch { return [] } 把崩溃吞成「空文件」→ 占位行假成功。现在 Buffer 上
// 按字节扫描 \n 逐行解码（0x0a 不出现在 UTF-8 多字节序列内，切片安全），
// 读/解压/单行超限错误一律上抛；仅单行 JSON 解析失败跳过（内容级容错）。
export function parseJsonlLines(filePath: string): ClaudeJsonlLine[] {
  const buf = readCaptureBuffer(resolveCaptureForm(filePath));
  const result: ClaudeJsonlLine[] = [];
  let start = 0;
  let lineNo = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    lineNo++;
    const t = buf.toString('utf-8', start, end).trim();
    if (t && !t.startsWith('//')) {
      try {
        result.push(JSON.parse(t) as ClaudeJsonlLine);
      } catch {
        skipLog.warn('skipping malformed JSON line', { filePath, line: lineNo });
      }
    }
    start = end + 1;
  };
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) flush(i);
  }
  flush(buf.length);
  return result;
}

/** 工具结果登记：内容 + 结果行时间戳（tool_result 完成时刻，工具真实时长的右边界） */
function collectAllToolResults(lines: ClaudeJsonlLine[]): Map<string, { content: string; tsMs: number | null }> {
  const resultMap = new Map<string, { content: string; tsMs: number | null }>();
  for (const line of lines) {
    if (line.type === 'user' && line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id && block.content) {
          const ts = line.timestamp != null && isValidISO(line.timestamp)
            ? new Date(line.timestamp).getTime()
            : null;
          resultMap.set(block.tool_use_id, { content: normalizeToolResultPayload(block.content) ?? '', tsMs: ts });
        }
      }
    }
  }
  return resultMap;
}

function collectJsonlFiles(dirPath: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'subagents') continue;
        results.push(...collectJsonlFiles(full));
      } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.gz') || entry.name.endsWith('.jsonl.7z')) {
        // rollout-*.jsonl / session.v4.jsonl 是 codex / dsh 源的文件名指纹
        // （registry sniff 序：前缀与固定名精确嗅探先于本兜底）——claude 扫描
        // 不得把它们当捕获件列进会话表，否则族扫描产出假条目、导入即失败
        if (isRolloutFileName(entry.name)) continue;
        if (isDshSessionLogName(entry.name)) continue;
        results.push(full);
      }
    }
  } catch {}
  return results;
}

export function listSessions(dirPath: string): SessionListItem[] {
  if (!dirPath || !fs.existsSync(dirPath)) return [];

  const stat = fs.statSync(dirPath);
  let files: string[];

  if (stat.isFile() && (dirPath.endsWith('.jsonl') || dirPath.endsWith('.jsonl.gz') || dirPath.endsWith('.jsonl.7z'))) {
    files = [dirPath];
  } else if (stat.isDirectory()) {
    files = collectJsonlFiles(dirPath);
  } else {
    return [];
  }

  const result: SessionListItem[] = [];
  for (const file of files) {
    const sessionId = deriveSessionIdFromPath(file);
    // 目录扫描会撞上外来/半写坏的捕获件：逐件降级跳过，不炸整个列表
    // （parseJsonlLines 已不吞读取错误，降级责任在消费点）
    let lines: ClaudeJsonlLine[];
    try {
      lines = parseJsonlLines(file);
    } catch (e) {
      skipLog.warn('skipping unreadable capture in listSessions', { file, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (lines.length === 0) continue;

    let firstQuery: string | null = null;
    let modelName: string | null = null;
    // 最频次模型——以 groupAssistantLines 组（= 导入后的 turn）为单位计数，
    // 与 computeSessionAggregates 同口径：原生会话一个 turn 有多条流式分段
    // 行（同 message.id 各带 model），行级计数会把多行 turn 加权放大；
    // 并列取先出现
    const modelCounts = new Map<string, number>();
    for (const g of groupAssistantLines(lines)) {
      const m = g.lines.find(l => l.message?.model)?.message?.model;
      if (m) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
    }
    let createdAt: string;
    let endedAt: string | null = null;
    let totalTokens = 0;

    try {
      createdAt = fs.statSync(file).mtime.toISOString();
    } catch {
      createdAt = new Date(0).toISOString();
    }

    for (const line of lines) {
      if (line.timestamp) {
        endedAt = line.timestamp;
      }
      if (line.type === 'user' && line.message) {
        const text = extractTextContent(line.message.content);
        if (text && !firstQuery) {
          const stripped = stripSystemReminders(text);
          if (stripped) firstQuery = truncateUtf16Safe(stripped, 200);
        }
      }
      if (line.type === 'assistant' && line.message?.usage) {
        const u = line.message.usage;
        totalTokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    }

    let modelMaxCount = 0;
    for (const [m, c] of modelCounts) {
      if (c > modelMaxCount) { modelMaxCount = c; modelName = m; }
    }

    result.push({
      id: sessionId,
      createdAt,
      endedAt,
      firstQuery,
      turnCount: lines.length,
      modelName,
      totalTokens,
    });
  }

  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function findSessionFile(dirPath: string, sessionId: string): string | null {
  // 三形态候选：.jsonl.7z（7z at rest）> .jsonl.gz（存量）> .jsonl（明文）
  for (const candidate of [`${sessionId}.jsonl.7z`, `${sessionId}.jsonl.gz`, `${sessionId}.jsonl`]) {
    const directPath = path.join(dirPath, candidate);
    if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) return directPath;
  }

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'subagents') {
        const found = findSessionFile(path.join(dirPath, entry.name), sessionId);
        if (found) return found;
      }
    }
  } catch {}

  return null;
}

// 发现产出的子代理引用：contract.SubagentRef（id = 规范连接键）+ claude
// meta 契约的 toolUseId 锚定键。meta.json 由发现层单次读取
// （readSubagentMeta），打标/技能归因等下游不再各自开文件。
interface ClaudeSubagentRef extends SubagentRef {
  /** Task tool_use 锚定键（claude meta.json 契约，技能归因用） */
  toolUseId: string | null;
}

// 子代理 meta.json 单读（双名信封优先，顶层旧字段 fallback；兼容压缩形态
// x.jsonl.7z/.gz → x.meta.json）。发现层是子代理 meta 的唯一读者。
function readSubagentMeta(filePath: string): {
  agentId: string | null;
  toolUseId: string | null;
  name: string | null;
  agentType: string | null;
} | null {
  try {
    const metaPath = filePath.replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    const xb = readEnvelope(meta) as XLake | undefined;
    const data = xb && isMetaPayload(xb, 'cc-subagent-meta') ? xb.data : null;
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    return {
      agentId: str(data?.agentId ?? meta.agentId),
      toolUseId: str(data?.toolUseId ?? meta.toolUseId),
      name: str(data?.name ?? meta.name) ?? str(data?.agentType ?? meta.agentType) ?? str(meta.description),
      agentType: str(data?.agentType ?? meta.agentType),
    };
  } catch {
    return null;
  }
}

export function listSubagentSessions(dirPath: string, sessionId: string): ClaudeSubagentRef[] {
  // dirPath can be a file (e.g., /path/to/session.jsonl) or a directory.
  // Subagents live at <parentDir>/sessionId/subagents/
  // proxy 捕获文件带 cpx- 文件名前缀（cpx-<sid>.jsonl），但其子代理目录用
  // 无前缀 sid（<sid>/subagents/）——导入 taskId 继承了文件名前缀时，剥掉
  // 前缀重试一次，否则 subagent 全部漏并（0 turns）。
  // 双形态解析后再 stat：sourcePath 指向明文但盘上仅 .gz（或反之）时
  // statSync ENOENT 抛出会把导入整链炸成 500
  let resolved = dirPath;
  if (!fs.existsSync(resolved)) {
    if (dirPath.endsWith('.jsonl')) {
      if (fs.existsSync(`${dirPath}.7z`)) resolved = `${dirPath}.7z`;
      else if (fs.existsSync(`${dirPath}.gz`)) resolved = `${dirPath}.gz`;
    } else if (/\.jsonl\.(7z|gz)$/.test(dirPath) && fs.existsSync(dirPath.replace(/\.(7z|gz)$/, ''))) {
      resolved = dirPath.replace(/\.(7z|gz)$/, '');
    }
  }
  const isFile = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  const parentDir = isFile ? path.dirname(resolved) : resolved;
  let subagentsDir = path.join(parentDir, sessionId, 'subagents');
  if (!fs.existsSync(subagentsDir) && sessionId.startsWith('cpx-')) {
    subagentsDir = path.join(parentDir, sessionId.slice(4), 'subagents');
  }
  if (!fs.existsSync(subagentsDir)) {
    // taskId ≠ 文件名 stem 的导入（评审日志、改名导入）：捕获布局按 stem 命名
    // 子代理目录，回退按 stem 再找一次——否则子代理全部漏并（0 turns）。
    // stem/判断一律用 resolved（双形态解析后的真实路径）——stat 原始 dirPath 在
    // .jsonl-on-disk-as-.jsonl.gz 场景自己抛 ENOENT，把导入整链炸成 500
    const stem = path.basename(isFile ? resolved : parentDir).replace(/\.jsonl(\.7z|\.gz)?$/, '');
    if (stem && stem !== sessionId) {
      subagentsDir = path.join(parentDir, stem, 'subagents');
    }
  }
  if (!fs.existsSync(subagentsDir) || !fs.statSync(subagentsDir).isDirectory()) return [];

  const results: ClaudeSubagentRef[] = [];
  try {
    const entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
    for (const entry of entries) {
      // .jsonl.7z/.jsonl.gz（压缩态）与 .jsonl（legacy 明文）三形态；filePath
      // 保持真实盘上路径（readCaptureText/parseJsonlLines 透明解压）
      const m = entry.name.match(/^(.+)\.jsonl(\.7z|\.gz)?$/);
      if (entry.isFile() && m) {
        const filePath = path.join(subagentsDir, entry.name);
        const meta = readSubagentMeta(filePath);
        // codex-proxy 身份对齐：文件名 id（sub-<hash>）是 cpx 在 spawn 输出
        // 到达前铸的占位，真身 agentId 由 meta backfill——bridge-builder 按
        // spawn 输出的 agent_id 锚定，规范 id 必须用 agentId 才能和 Bridge/
        // Execution 对上（否则泳道/性能视图全部 0 turns）。claude 捕获无
        // agentId，回退文件名 id（= 真身会话 id，行为不变）。
        results.push({
          id: meta?.agentId ?? m[1],
          filePath,
          name: meta?.name ?? null,
          type: meta?.agentType ?? null,
          toolUseId: meta?.toolUseId ?? null,
        });
      }
    }
  } catch {}

  return results;
}

export function collectSubagentToolUseMappings(dirPath: string, sessionId: string): Map<string, string> {
  // Maps toolUseId (from meta.json) → canonical subagent session ID
  // （subagent_session_id 同键，与打标口径一致）
  const mapping = new Map<string, string>();
  for (const sub of listSubagentSessions(dirPath, sessionId)) {
    if (sub.toolUseId) mapping.set(sub.toolUseId, sub.id);
  }
  return mapping;
}

// 子代理会话读取（SourceDescriptor.readSubagents 能力实现）：目录布局发现
// （<parentDir>/<sid>/subagents/）→ readSession → 打标（subagent_session_id/
// name/type）。data-service 的通用并入循环消费本产出，不再持有 claude 特有
// 逻辑。
export function readSubagentInteractions(dirPath: string, sessionId: string): RawInteraction[] {
  const subagentFiles = listSubagentSessions(dirPath, sessionId);
  const result: RawInteraction[] = [];
  for (const sub of subagentFiles) {
    const subInteractions = readSession(sub.filePath, sub.id);
    // 打标：sub.id 即规范连接键（codex-proxy 的 meta agentId / claude 的
    // 文件名 id），Bridge/Execution 锚定与 Turns 泳道 join 都用它
    for (const interaction of subInteractions) {
      interaction.subagent_session_id = sub.id;
      if (sub.name) interaction.subagent_name = sub.name;
      if (sub.type) interaction.subagent_type = sub.type;
    }
    result.push(...subInteractions);
  }
  return result;
}

function isValidISO(timestamp: string): boolean {
  // 前缀正则快速短路 + 解析校验双保险：正则无尾部锚定，'2026-08-18T10:00:105Z'
  // （秒位三位）等「格式命中但 new Date() 解析为 NaN」的脏值会穿透；NaN 经下游
  // falsy 判定会被替换成 epoch 0（PR #112 review 实证），故解析失败一律判非法
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp)) return false;
  return Number.isFinite(new Date(timestamp).getTime());
}

function extractVersionFromLines(lines: ClaudeJsonlLine[]): string | null {
  for (const line of lines) {
    const xv = (readEnvelope(line) as XLake | undefined)?.data?.ccVersion;
    if (xv) return xv;
    if (line.version) return line.version;
  }
  return null;
}

export function extractVersion(filePath: string): string | null {
  const lines = parseJsonlLines(filePath);
  return extractVersionFromLines(lines);
}

export interface AssistantGroup {
  lines: ClaudeJsonlLine[];
  startLineIndex: number;
}

// Non-substantive line types that shouldn't break assistant grouping
// These are Claude Code metadata lines injected during streaming
const NON_BREAKING_TYPES = new Set([
  'ai-title', 'attachment', 'mode', 'permission-mode',
  'file-history-snapshot', 'last-prompt', 'system',
]);

// 插队消息（attachment/queued_command）升格判据：必须是人类输入——
// humanTurn 显式 false / origin.kind 非 human（hook/MCP/系统注入的队列
// delivery）不冒充用户轮（时间线归属、turn 计数、AI 分析输入都会被污染）。
// 导出给 auto-refresh 探针同口径判定（尾行插队消息 = 有输入待响应）
export interface AttachmentLike {
  type?: string;
  prompt?: string;
  humanTurn?: boolean;
  origin?: { kind?: string };
}
export function isQueuedUserAttachment(line: { type?: string; attachment?: AttachmentLike }): boolean {
  if (line.type !== 'attachment' || line.attachment?.type !== 'queued_command') return false;
  if (line.attachment.humanTurn === false) return false;
  const kind = line.attachment.origin?.kind;
  if (kind !== undefined && kind !== 'human') return false;
  return true;
}
function queuedUserPrompt(line: ClaudeJsonlLine): string | null {
  if (!isQueuedUserAttachment(line)) return null;
  const prompt = typeof line.attachment?.prompt === 'string' ? line.attachment.prompt.trim() : '';
  return prompt || null;
}

// 已知的「无交互产出」行类型（元数据/记账/wire 调试/语义已由他处消费）：
// 跳过属正常，info 级。user = 只含 tool_result 的载体行（内容并入前一条
// assistant 的 tool_calls）；assistant = 无 message 的客户端记账行。未知
// 类型跳过 = 上游格式演进的最早信号（2.1.3xx 的 queued_command 就是这么
// 溜进来的），warn 级——现场排查「丢了条消息」时日志里有线索可查。
// attachment 按子类型普查（queued_command 事故的复发形态正是「已知类型
// 携带新子类型」）：子类型目录来自真机 2.1.303 全量普查。
// 导出供 auto-refresh 探针派生镜像集（单源，消除双清单手工同步漂移）
export const KNOWN_SKIP_TYPES = new Set([
  ...NON_BREAKING_TYPES,
  'user', 'assistant',
  'queue-operation', 'atis-latch', 'progress', 'summary',
  'api-request', 'api-request-blob', 'api-request-shape',
]);
const KNOWN_ATTACHMENT_SUBTYPES = new Set([
  'queued_command', 'environment', 'model', 'agent_listing_delta', 'skill_listing',
  'total_tokens_reminder', 'session_context', 'date', 'remote_session_change',
  'prompt_snapshot', 'nested_memory',
]);
// 门控丢弃的 queued_command（humanTurn=false / origin 非 human / 空 prompt）
// 单独计键且不入白名单：真实用户插队被误标时必须 warn 可查，不能与普通
// 元数据跳过混在 info 里无声
const GATED_QUEUED_KEY = 'attachment/queued_command!gated';
const isKnownSkipKey = (key: string): boolean => {
  if (KNOWN_SKIP_TYPES.has(key)) return true;
  return key.startsWith('attachment/') && KNOWN_ATTACHMENT_SUBTYPES.has(key.slice('attachment/'.length));
};

const skipLog = createLogger('claude-jsonl');

export function groupAssistantLines(lines: ClaudeJsonlLine[]): AssistantGroup[] {
  const groups: AssistantGroup[] = [];
  let current: AssistantGroup | null = null;
  let currentMsgIds: Set<string> | null = null;
  let pendingToolResults: ClaudeJsonlLine[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'assistant' && line.message) {
      const msgId = line.message?.id;

      if (current && pendingToolResults && msgId && currentMsgIds?.has(msgId)) {
        // This assistant line shares the same message.id as the current group,
        // meaning the interleaved tool_result lines belong to the same API response.
        // Absorb them without breaking the group.
        pendingToolResults = null;
      } else if (pendingToolResults) {
        // The next assistant line has a different message.id (or no id),
        // so the pending tool_results are from a different turn. End the group.
        groups.push(current!);
        current = null;
        currentMsgIds = null;
        pendingToolResults = null;
      }

      if (!current) {
        current = { lines: [], startLineIndex: i };
        currentMsgIds = new Set();
      }
      current.lines.push(line);
      if (msgId && currentMsgIds) currentMsgIds.add(msgId);
    } else if (NON_BREAKING_TYPES.has(line.type)
      && !(line.type === 'system' && line.message?.content != null)
      && queuedUserPrompt(line) === null) {
      // Don't break the current assistant group for non-substantive lines.
      // EXCEPTION: a system line carrying message.content is substantive (our
      // proxy/export convention for system turns & injections) — it must break
      // the group, otherwise the next assistant (different response) merges
      // into this one and both the system turn and that assistant line are
      // silently dropped (lineToGroup's contiguous-index assumption breaks).
      // Native claude metadata system lines carry no message.content → unchanged.
      continue;
    } else if (
      current &&
      line.type === 'user' &&
      line.message?.content &&
      Array.isArray(line.message.content) &&
      extractTextContent(line.message.content) === null
    ) {
      // User line contains only tool_result blocks (no real text prompt).
      // Buffer it — we'll decide when we see the next assistant line:
      // if it shares the same message.id, these results are interleaved
      // within the same API response; otherwise they end the group.
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push(line);
      continue;
    } else {
      if (current) {
        groups.push(current);
        current = null;
        currentMsgIds = null;
        pendingToolResults = null;
      }
    }
  }
  if (current) groups.push(current);
  return groups;
}

// Merge one assistant group (consecutive assistant lines sharing a response)
// into a single RawInteraction: joined text, tool_use→tool_calls with results
// attached (via allToolResults), merged usage (max raw input, final-line cache
// fields), model, timestamps and latency. Used by the native split path
// (readSession); proxy captures enter it as normalized native-shape lines.
// Returns null when the group carries neither text nor tool calls.
export function buildAssistantInteraction(
  group: AssistantGroup,
  allToolResults: Map<string, { content: string; tsMs: number | null }>,
  fileMtime: number,
  prevBoundaryMs: number | null = null,
): RawInteraction | null {
  const textParts: string[] = [];
  const allToolCalls: ToolCallInfo[] = [];
  let mergedUsage: TokenUsage | null = null;
  let mergedModel: string | null = null;
  let firstTimestamp: string | null = null;
  let firstTimeCreated: number | null = null;
  let lastTimeCreated: number | null = null;
  let mergedFinishReason: string | null = null;
  let explicitDurationMs: number | null = null;
  // proxy 行带 source:"-proxy"。proxy 单行 assistant 的 timeInfo.completed ==
  // created（都=completedAt）→ turn-split 会算 latency=completed-created=0，
  // 覆盖掉 interaction.latency（=duration_ms=wire latency）。proxy 且有显式
  // duration_ms 时把 completed 置 undefined，让 turn-split fallback 到
  // interaction.latency。native 行不受影响（native byte-identical）。
  let isProxy = false;

  // x_lake cc-db-turn 声明的 reasoning tokens（legacy 通道无此信息，
  // anthropic usage 也没有 reasoning 字段 —— opencode 来源经导出往返的恢复通道）
  let mergedReasoning = 0;

  // Find the line with the most complete usage (has cache fields = final line)
  // Also track the maximum raw input_tokens across all lines (thinking lines report
  // full cumulative input, while final lines report incremental input only)
  let finalUsageLine: ClaudeJsonlLine | null = null;
  let maxRawInputTokens = 0;

  for (let lineIdx = 0; lineIdx < group.lines.length; lineIdx++) {
    const al = group.lines[lineIdx];
    const alLineIndex = group.startLineIndex + lineIdx;
    const contentBlocks = Array.isArray(al.message?.content)
      ? al.message.content as ContentBlock[]
      : [];
    const text = extractTextContent(al.message?.content);
    if (text) textParts.push(text);

    const realTimestamp = al.timestamp || null;
    // 非法时间戳与缺失同路兜底（fileMtime 估计）：回退 epoch 0 会把 turn 时间打成
    // 1970，经 subagentTiming 的 min 聚合放大成毫秒级伪时延（CI 实证 1.78e12 溢出 Int 列）
    const tsValid = realTimestamp != null && isValidISO(realTimestamp);
    const timeCreated = tsValid ? new Date(realTimestamp).getTime() : fileMtime + alLineIndex * 1000;
    const timestamp = tsValid ? realTimestamp : new Date(timeCreated).toISOString();

    const toolCalls = extractToolCalls(contentBlocks);
    if (toolCalls) {
      for (const tc of toolCalls) {
        // startedAt=tool_use 所在行时刻（发起），completedAt=tool_result 行时刻（完成）
        // ——工具真实时长的左右边界；结果行缺失/无时间戳 → null（消费方降级）
        const entry = allToolResults.get(tc.toolCallId);
        const v = entry?.content ?? tc.resultJson ?? null;
        allToolCalls.push({
          ...tc,
          resultJson: v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)),
          startedAt: timeCreated,
          completedAt: entry?.tsMs ?? null,
        });
      }
    }

    const usage = al.message?.usage;
    if (usage) {
      // Track the maximum raw input_tokens (thinking lines report full cumulative)
      if ((usage.input_tokens ?? 0) > maxRawInputTokens) {
        maxRawInputTokens = usage.input_tokens ?? 0;
      }
      // The final line of a streaming response includes cache_read/cache_write fields
      // and has actual output_tokens; earlier lines report cumulative input only
      if (usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null || (usage.output_tokens > 0 && usage.input_tokens < (finalUsageLine?.message?.usage?.input_tokens ?? Infinity))) {
        finalUsageLine = al;
      }
    }

    if (firstTimeCreated == null || timeCreated < firstTimeCreated) {
      firstTimeCreated = timeCreated;
      firstTimestamp = timestamp;
    }
    if (lastTimeCreated == null || timeCreated > lastTimeCreated) {
      lastTimeCreated = timeCreated;
    }

    if (!mergedModel && al.message?.model) mergedModel = al.message.model;
    if (al.subtype) mergedFinishReason = al.subtype;
    // proxy 扩展字段：emitter 把 wire stop_reason 写进 stopReason（subtype 是
    // native 字段，语义不同）。adapter 读它进 interaction.finish_reason →
    // turn-split 写 Turn.finishReason，走标准管线进 DB（非扩展层覆盖）。
    if (al.stopReason) mergedFinishReason = al.stopReason;
    if (al.duration_ms != null) explicitDurationMs = al.duration_ms;
    // 生成文件标记：cpx 捕获（*-proxy）与 lake DB 导出（insight-export）。
    // 两者都声明 duration_ms 承载真实 latency（completed 置 undefined 让
    // turn-split fallback 到 interaction.latency）；仅 *-proxy 计入
    // Session.version（proxySourceOf 只认 -proxy 后缀，导出件不误标代理徽标）。
    if (!isProxy && typeof al.source === 'string'
      && (al.source.endsWith('-proxy') || al.source === 'insight-export')) isProxy = true;
    // 声明式信封通道（优先）：同一信息的权威源 + legacy 没有的 reasoningTokens
    const xbRaw = readEnvelope(al) as XLake | undefined;
    const xbTurn = isTurnPayload(xbRaw) ? xbRaw!.data : null;
    if (xbTurn) {
      isProxy = true;
      if (xbTurn.stopReason != null) mergedFinishReason = xbTurn.stopReason;
      if (xbTurn.latencyMs != null) explicitDurationMs = xbTurn.latencyMs;
      if (xbTurn.reasoningTokens != null) mergedReasoning = xbTurn.reasoningTokens;
    }
  }

  // Build merged usage: use final line's cache data, but for total input use the
  // maximum raw input_tokens across all lines (thinking lines report full cumulative
  // input while final lines report incremental only)
  if (finalUsageLine?.message?.usage) {
    const fu = finalUsageLine.message.usage;
    const incrementalInput = fu.input_tokens ?? 0;
    const cacheRead = fu.cache_read_input_tokens ?? 0;
    const cacheWrite = fu.cache_creation_input_tokens ?? 0;
    // inputMessagesTokens = max of thinking line's full input and incremental+cache
    const inputMessagesTokens = Math.max(maxRawInputTokens, incrementalInput + cacheRead + cacheWrite);
    mergedUsage = {
      total: inputMessagesTokens + (fu.output_tokens ?? 0),
      input: incrementalInput,
      output: fu.output_tokens ?? 0,
      reasoning: mergedReasoning,
      cacheRead,
      cacheWrite,
      cost: 0,
      inputMessagesTokens,
    };
  } else if (group.lines[0]?.message?.usage) {
    // No final line with cache fields — use first line's cumulative input
    const u0 = group.lines[0].message.usage;
    mergedUsage = {
      total: (u0.input_tokens ?? 0) + (u0.output_tokens ?? 0),
      input: u0.input_tokens ?? 0,
      output: u0.output_tokens ?? 0,
      reasoning: mergedReasoning,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      inputMessagesTokens: u0.input_tokens ?? 0,
    };
  }

  const mergedContent = textParts.length > 0 ? textParts.join('\n') : null;
  const mergedToolCalls = allToolCalls.length > 0 ? allToolCalls : null;

  // Detect skill invocations from Read tool_use calls to SKILL.md paths
  // When Claude Code loads a skill, it reads <skill-dir>/SKILL.md — this is the
  // definitive signal that a skill was invoked in this turn.
  const skillInvocations: ToolCallInfo[] = [];
  for (const tc of allToolCalls) {
    if (tc.toolName === 'Read' && tc.argsJson) {
      try {
        const args = JSON.parse(tc.argsJson);
        const filePath = String(args.file_path ?? '');
        if (filePath.endsWith('/SKILL.md')) {
          const skillName = filePath.split('/').slice(-2, -1)[0] || filePath.split('/SKILL.md')[0].split('/').pop() || '';
          skillInvocations.push({
            toolCallId: `skill-${tc.toolCallId}`,
            toolName: `skill/${skillName}`,
            argsJson: JSON.stringify({ skill: skillName, file_path: filePath }),
            resultJson: null,
            state: 'completed',
          });
        }
      } catch { /* ignore */ }
    }
  }

  const finalToolCalls = skillInvocations.length > 0
    ? [...allToolCalls, ...skillInvocations]
    : mergedToolCalls;

  // Skip if no content and no tool calls——但携带 usage/finishReason 的空组保留：
  // 现场回归（vbYQjB #1975 后）：subagent 最后一轮 stopReason=length、content=[]、
  // 32000t output——整组丢弃会把截断事实连同 usage 一起从 insight 消失，时间线
  // 上一轮 read 后"突然结束"、token 统计少算。空 turn 落库（content null），
  // 显示层按 finishReason=length 给出截断解释；真正的空行仍丢
  if (!mergedContent && !mergedToolCalls) {
    const carriesSignal = mergedFinishReason != null
      || (mergedUsage != null && ((mergedUsage.output ?? 0) > 0 || (mergedUsage.input ?? 0) > 0));
    if (!carriesSignal) return null;
  }

  // 单行 native assistant 的跨度是 0——填 0 会短路掉下面的 gap 回填（latency==null
  // 才触发），completed 就永远等于 created（工具区间塌成零长）。跨度为 0 时给 null，
  // 让回填用"到下一轮的间隔"补（下一轮=tool_result 到达时间，正是工具执行区间）。
  const span = lastTimeCreated && firstTimeCreated && lastTimeCreated > firstTimeCreated
    ? lastTimeCreated - firstTimeCreated
    : null;
  // native/无显式 duration：请求时长按上一边界（上一轮末行或其工具结果完成
  // 时刻）到本组末行推导——行跨度只覆盖首行落盘之后的生成尾段，短回复把 tps
  // 虚高数倍（实测 966tok/0.96s→1012tps，边界推导 25.4s→38tps）。有显式
  // duration_ms 的 proxy 行为不变。timeInfo 保持行时间语义（时间线/活跃时长
  // 不受影响），边界时长经 latency 通道传递（turn-split 显式 latency 优先）。
  const explicit = explicitDurationMs != null;
  const endMs = lastTimeCreated ?? null;
  const boundaryLatency = (!explicit && prevBoundaryMs != null && endMs != null && endMs > prevBoundaryMs)
    ? endMs - prevBoundaryMs
    : null;
  const latency = explicitDurationMs ?? boundaryLatency ?? span;

  return {
    role: 'assistant',
    content: mergedContent,
    timestamp: firstTimestamp ?? new Date(fileMtime).toISOString(),
    timeInfo: {
      created: firstTimeCreated ?? fileMtime,
      completed: (isProxy && explicitDurationMs != null) ? undefined : (endMs ?? undefined),
    },
    agent: null,
    subagent_name: null,
    subagent_session_id: null,
    subagent_type: null,
    tool_calls: finalToolCalls,
    usage: mergedUsage,
    model: mergedModel,
    modelID: null,
    providerID: null,
    latency,
    finish_reason: mergedFinishReason,
  };
}

export function readSession(filePath: string, sessionId: string): RawInteraction[] {
  if (!filePath) return [];
  // 双形态解析前置（readCaptureText 同款）：sourcePath 指向明文但盘上已
  // 压缩（或反之）不能在此被 existsSync 守卫拦截
  let resolvedInput = filePath;
  if (!fs.existsSync(resolvedInput)) {
    if (filePath.endsWith('.jsonl')) {
      if (fs.existsSync(`${filePath}.7z`)) resolvedInput = `${filePath}.7z`;
      else if (fs.existsSync(`${filePath}.gz`)) resolvedInput = `${filePath}.gz`;
      else return [];
    } else if (/\.jsonl\.(7z|gz)$/.test(filePath) && fs.existsSync(filePath.replace(/\.(7z|gz)$/, ''))) {
      resolvedInput = filePath.replace(/\.(7z|gz)$/, '');
    } else {
      return [];
    }
  }

  const stat = fs.statSync(resolvedInput);

  let resolvedFilePath: string;
  if (stat.isFile()) {
    resolvedFilePath = resolvedInput;
  } else if (stat.isDirectory()) {
    const found = findSessionFile(resolvedInput, sessionId);
    if (!found) return [];
    resolvedFilePath = found;
  } else {
    return [];
  }

  const lines = parseJsonlLines(resolvedFilePath);
  if (lines.length === 0) return [];

  const allToolResults = collectAllToolResults(lines);
  const fileMtime = fs.statSync(resolvedFilePath).mtime.getTime();

  const result: RawInteraction[] = [];

  // Phase 1: process non-assistant lines and group assistant lines
  const assistantGroups = groupAssistantLines(lines);

  // Build a map of line → assistant group for interleaving. 按对象身份而非
  // startLineIndex+j 下标映射：吸收进分组的 tool_result-only user 行占据
  // 中间下标，连续下标假设会把真实 assistant 行挤出映射（内容已在组内合并
  // 不丢，但会掉进下方 else 分支被误计为跳过行——计数失真误导排查）
  const lineToGroup = new Map<ClaudeJsonlLine, AssistantGroup>();
  for (const g of assistantGroups) {
    for (const ln of g.lines) {
      lineToGroup.set(ln, g);
    }
  }

  // Track which groups we've already emitted
  const emittedGroups = new Set<AssistantGroup>();

  // native 请求边界：上一轮末行与其工具结果完成时刻的较大者（用户输入重置）。
  // 供下一 assistant 组把请求起点回撤到边界——latency 覆盖排队+prefill+生成
  // 全程（TPS/TPOT 物理合理），工具时间天然在界外。子代理文件是独立调用，
  // 边界天然按会话隔离。
  let nativeBoundary: number | null = null;

  // 跳过行计数（按 type）：未知类型 warn（上游格式演进信号），已知元数据 info
  const skippedTypes = new Map<string, number>();
  const noteSkip = (t: string) => { skippedTypes.set(t, (skippedTypes.get(t) ?? 0) + 1); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // If this line belongs to an assistant group, emit the whole group once
    const group = lineToGroup.get(line);
    if (group) {
      if (emittedGroups.has(group)) continue; // already emitted
      emittedGroups.add(group);

      const merged = buildAssistantInteraction(group, allToolResults, fileMtime, nativeBoundary);
      if (merged) {
        // 每组结束推进边界（组末行与其工具结果完成时刻取大者）。子代理文件是
        // 独立的 readSession 调用（各自边界隔离），isSidechain 打标在读取后的
        // 标注 pass——此处无需也不可按 sidechain 跳过：跳过会让边界冻结在早期
        // user 行，子代理后续各组 end−冻结边界 单调累加（实测 turn372-430）。
        const toolEnd = merged.tool_calls?.reduce((m, tc) => Math.max(m, tc.completedAt ?? 0), 0) ?? 0;
        const nb = Math.max(merged.timeInfo?.completed ?? 0, toolEnd);
        if (nb > 0) nativeBoundary = nb;
        result.push(merged);
      }
      continue;
    }

    // Non-assistant lines
    const realTimestamp = line.timestamp || null;
    // 同上：非法时间戳走 fileMtime 兜底，不再产出 epoch 0 / NaN
    const tsValid = realTimestamp != null && isValidISO(realTimestamp);
    const timeCreated = tsValid ? new Date(realTimestamp).getTime() : fileMtime + i * 1000;
    const timestamp = tsValid ? realTimestamp : new Date(timeCreated).toISOString();
    const timeCompleted = line.duration_ms && timeCreated ? timeCreated + line.duration_ms : undefined;

    if (line.type === 'user' && line.message) {
      const raw = extractTextContent(line.message.content);
      // Skip user messages that only contain tool_result (no real text prompt)
      if (!raw) { noteSkip(line.type); continue; }

      // 框架注入分类（contract 原则 1：指纹规则框架自持）：native 会话与
      // insight-export 走 claude-code 指纹（task-notification / ≥2.1 协议
      // 注入 / skill 注入），异框架 proxy 捕获按行级 source 标记分发到原
      // 框架分类器（injections/index.ts）——本适配器是 claude 布局的通用
      // 格式入口，不内联异框架指纹。静态注入 drop 不进时间线（wire 原文
      // 永远在捕获文件，wire-rounds 可查），事件注入重分类 system + 可读
      // 摘要（skill 注入 verbatim，skill-merge 后处理折进前一个 Skill
      // tool_call）。
      const injection = classifyUserInjection(line.source, raw, { isFirstTurn: result.length === 0 });
      if (injection) {
        if (injection.action === 'drop') { noteSkip(line.type); continue; }
        result.push({
          role: 'system',
          content: injection.content ?? raw,
          timestamp,
          timeInfo: { created: timeCreated },
          agent: null, subagent_name: null, subagent_session_id: null, subagent_type: null,
          tool_calls: null, usage: null, model: null, modelID: null, providerID: null,
          latency: null, finish_reason: null,
        });
        continue;
      }

      // <system-reminder>（CLAUDE.md / gitStatus / currentDate 等注入上下文）
      // 在 wire 上是 user 消息内部的 text block —— 与真实提示同属一条消息。
      // 不再拆分成独立 system turn（拆开是过度切分：时间线零碎、LLM Input
      // 重建时还得 toWireOrder 拼回去）。user turn 原样保留全文（wire 保真），
      // 渲染层（LlmContextView.reminderPrefix）把 reminder 块显示为独立子块。
      const content = raw;
      if (content) {
        // 用户输入是新的请求边界（下一 assistant 请求始于用户消息之后）
        nativeBoundary = timeCreated;
        result.push({
          role: 'user',
          content,
          timestamp,
          timeInfo: { created: timeCreated },
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
    } else if (line.type === 'attachment') {
      // Ctrl+X Ctrl+C 插队消息：delivery 落盘为 attachment/queued_command，
      // 用户原文在 attachment.prompt、renderedRole=system 只是发给模型的包
      // 装——升格为 user interaction，时间线上作为独立用户轮可见（排在断开
      // 的两个 assistant 分组之间，与其真实发生时刻一致）
      const prompt = queuedUserPrompt(line);
      if (prompt) {
        nativeBoundary = timeCreated;
        result.push({
          role: 'user',
          content: prompt,
          timestamp,
          timeInfo: { created: timeCreated },
          agent: null, subagent_name: null, subagent_session_id: null, subagent_type: null,
          tool_calls: null, usage: null, model: null, modelID: null, providerID: null,
          latency: null, finish_reason: null,
        });
      } else {
        noteSkip(line.attachment?.type === 'queued_command'
          ? GATED_QUEUED_KEY
          : `attachment/${line.attachment?.type ?? 'none'}`);
      }
    } else if (line.type === 'system' && line.message) {
      // Proxy (cannbot-proxy) relays request messages with role:"system"
      // verbatim — e.g. the "Available agent types" registry claude-code
      // injects into the messages array. The model READS these, so emit a
      // system turn (visible in LLM Input, persisted in DB). Native
      // claude-code type:"system" lines (client-side status/hook events:
      // top-level `content` string, no `message`) are NOT model input and
      // stay skipped.
      const raw = extractTextContent(line.message.content);
      if (!raw) { noteSkip(line.type); continue; }
      result.push({
        role: 'system',
        content: raw,
        timestamp,
        timeInfo: { created: timeCreated },
        agent: null, subagent_name: null, subagent_session_id: null, subagent_type: null,
        tool_calls: null, usage: null, model: null, modelID: null, providerID: null,
        latency: null, finish_reason: null,
      });
    } else if (line.type === 'result') {
      const resultUsage = line.cost_usd != null
        ? { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: line.cost_usd, inputMessagesTokens: 0 }
        : null;
      result.push({
        role: 'result',
        content: line.result ?? null,
        timestamp,
        timeInfo: { created: timeCreated },
        agent: null,
        subagent_name: null,
        subagent_session_id: null,
        subagent_type: null,
        tool_calls: null,
        usage: resultUsage,
        model: null,
        modelID: null,
        providerID: null,
        latency: line.duration_ms ?? null,
        finish_reason: line.subtype ?? null,
      });
    } else {
      // 未知类型：不产出交互直接掉出 if 链——计数，日志层分级告警
      noteSkip(line.type);
    }
  }

  if (skippedTypes.size > 0) {
    const dist: Record<string, number> = Object.fromEntries([...skippedTypes.entries()].sort((a, b) => b[1] - a[1]));
    const unknown = Object.keys(dist).filter(t => !isKnownSkipKey(t));
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    if (unknown.length > 0) {
      skipLog.warn('跳过行含未知类型（疑似上游格式演进，检查是否丢语义）', { sessionId, total, unknown: unknown.join(','), dist: JSON.stringify(dist) });
    } else {
      skipLog.info('跳过行均为已知元数据类型', { sessionId, total, dist: JSON.stringify(dist) });
    }
  }

  // Post-process: merge skill injection system turns into preceding assistant's tool_call result
  // Claude Code emits skill content as a separate user/system line, but it's really the
  // tool_result of the Skill tool_call in the preceding assistant turn.
  for (let i = result.length - 1; i >= 0; i--) {
    const r = result[i];
    if (r.role !== 'system') continue;
    const content = r.content ?? '';
    if (!isSkillInjectionText(content)) continue;

    // Find the preceding assistant turn
    const prev = i > 0 ? result[i - 1] : null;
    if (prev?.role === 'assistant' && prev.tool_calls) {
      // Find a Skill tool_call whose resultJson is short/incomplete
      const skillTc = prev.tool_calls.find(tc =>
        tc.toolName.toLowerCase() === 'skill' &&
        tc.resultJson != null &&
        tc.resultJson.length < content.length
      );
      if (skillTc) {
        skillTc.resultJson = content;
        // Only remove if successfully merged into tool_call
        result.splice(i, 1);
      }
    }
    // If not merged into a Skill tool_call, keep the system turn
    // — it will be handled by the consecutive-merge step below
  }

  // Post-process: merge consecutive skill-injection system turns into one
  // When multiple skills are loaded at once, Claude Code emits separate lines for each.
  // These appear between a user prompt and the assistant response as separate system turns.
  // Merge them into a single consolidated system turn.
  for (let i = result.length - 1; i >= 0; i--) {
    const r = result[i];
    if (!r || r.role !== 'system') continue;
    const content = r.content ?? '';
    if (!isSkillInjectionText(content)) continue;

    // Look backward for consecutive system/skill-injection turns to merge
    const mergeGroup: number[] = [i];
    let j = i - 1;
    while (j >= 0 && result[j]?.role === 'system') {
      const prevContent = result[j].content ?? '';
      const prevIsSkill = prevContent.includes('Base directory for this skill') ||
        prevContent.includes('<skill-format>') ||
        prevContent.startsWith('Launching skill:') ||
        prevContent.startsWith('Launching skill ');
      if (prevIsSkill) {
        mergeGroup.push(j);
        j--;
      } else {
        break;
      }
    }

    if (mergeGroup.length > 1) {
      // Merge: combine all content, keep earliest timestamp
      const allContent = mergeGroup
        .sort((a, b) => a - b)
        .map(idx => result[idx].content ?? '')
        .join('\n\n---\n\n');
      const earliestIdx = Math.min(...mergeGroup);
      const earliest = result[earliestIdx];

      // Update the earliest turn with merged content
      earliest.content = allContent;

      // Remove the rest (in reverse order to preserve indices)
      for (const idx of mergeGroup.sort((a, b) => b - a)) {
        if (idx !== earliestIdx) {
          result.splice(idx, 1);
        }
      }
      // Splicing shrank the array; clamp i to the merged turn so the for-loop's
      // i-- lands on the element just before the group. Without this, i keeps its
      // pre-splice value, goes out of range, and result[i] is undefined (crash).
      i = earliestIdx;
    }
  }

  // Post-process: infer latency from timestamp gaps and estimate cost
  for (let i = 0; i < result.length; i++) {
    const r = result[i];
    // Infer latency: use gap between this turn and the next
    if (r.latency == null && r.timeInfo?.created) {
      const nextTs = result[i + 1]?.timeInfo?.created ?? null;
      if (nextTs && nextTs > r.timeInfo.created) {
        r.latency = nextTs - r.timeInfo.created;
        r.timeInfo.completed = nextTs;
      }
    }
    // Estimate cost if not provided (Claude pricing approximation)
    if (r.usage && r.usage.cost === 0) {
      const model = r.model ?? '';
      const isOpus = model.includes('opus') || model.includes('4.8');
      const isSonnet = model.includes('sonnet') || model.includes('4.6');
      const isHaiku = model.includes('haiku') || model.includes('4.5');
      let inputPrice = 3 / 1_000_000;   // default ~sonnet
      let outputPrice = 15 / 1_000_000;
      let cacheReadPrice = 0.3 / 1_000_000;
      let cacheWritePrice = 3.75 / 1_000_000;
      if (isOpus) {
        inputPrice = 15 / 1_000_000;
        outputPrice = 75 / 1_000_000;
        cacheReadPrice = 1.5 / 1_000_000;
        cacheWritePrice = 18.75 / 1_000_000;
      } else if (isHaiku) {
        inputPrice = 0.8 / 1_000_000;
        outputPrice = 4 / 1_000_000;
        cacheReadPrice = 0.08 / 1_000_000;
        cacheWritePrice = 1 / 1_000_000;
      }
      r.usage.cost =
        r.usage.input * inputPrice +
        r.usage.output * outputPrice +
        r.usage.cacheRead * cacheReadPrice +
        r.usage.cacheWrite * cacheWritePrice;
    }
  }

  return result;
}
