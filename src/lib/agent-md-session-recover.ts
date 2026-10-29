// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import { listSubagentSessions, parseJsonlLines } from '@/lib/ingest/adapters/claude-jsonl';
import { readEnvelope, readEnvelopeWithLegacy } from '@/lib/shared/envelope';

/**
 * agent .md 的**会话内 system 注入恢复**（proxy 扩展层，server-only）。
 *
 * 依据（ses_fc73d17d7ffer 正常会话实测，88/88 覆盖）：显式 agent 派发
 * （Task(subagent_type=xxx)，cannbot proxy 形态）的子代理，运行时把 agent .md 作为
 * system prompt 注入——proxy 捕获的子代理 jsonl 里每条 assistant 行带顶层 `system`
 * 字段（legacy）= `x_lake.data.system`（cc-wire-round），内容 = agent .md 正文 +
 * 运行时附加块（`<available_skills>` 技能清单等，实测占 system 的 ~62%）。
 *
 * 这是声明恢复的**主路径**：运行时真正生效的那份（远端机器当时的版本——本机磁盘
 * 扫描对不上：实测 designer 实际内容 8,606 字 vs 磁盘 demo 4,771 / glacier 6,793 字，
 * 均非同版本；多插件同名时磁盘只能按覆盖率+字母序猜）。旧 Read 恢复路径
 * （agent-md-recover.ts）在此形态会话上天然无数据——声明已注入上下文，子代理
 * 不会（也不需要）再去磁盘 Read 一遍自己的 md（实测 88 个子代理仅 3 个验收类
 * Read 过【别人的】md）。
 *
 * opencode 工作流派发形态（agentType=general，角色句在 prompt）的 system 是
 * opencode 通用 prompt（"You are opencode…"，无 agent .md）——靠首行标题守卫
 * 排除，调用方降级磁盘扫描。
 *
 * 红线对齐：只读 proxy 扩展字段（system / cc-subagent-meta），仅被
 * agent-content / audit-agentsift 路由按需调用，核心管线不感知（模式同
 * claude-jsonl-full-context.ts）。
 */

export interface SessionRecoveredAgentMd {
  /** 纯 agent .md 正文（已剥运行时附加块；无 frontmatter——物化给 sift 时由调用方注入）。 */
  content: string;
  /** 来源标识（UI/对账日志显示），如 "subagent:ses_xxx（system 注入）"。 */
  source: string;
}

/** opencode 通用 system prompt 首句（该形态无 agent .md，直接排除）。 */
const GENERIC_SYSTEM_PREFIX = 'You are opencode';

/** 运行时附加块起点标记：正文截到这里为止（后面是技能清单/工具描述，非声明）。 */
const RUNTIME_TAIL_MARKERS = ['<available_skills>', '<available_agents>'];

/** 声明首行标题（`# <agentName>`）匹配——标题即身份，防 meta 与正文错位。 */
function isAgentHeading(systemBody: string, agentName: string): boolean {
  const first = systemBody.split('\n').find(l => l.trim());
  if (!first) return false;
  const heading = first.trim().replace(/^#+\s*/, '');
  return heading === agentName;
}

/** 从子代理 jsonl 首条带 system 的 assistant 行提取 system 文本（x_lake 优先，legacy 兜底）。 */
function extractSystemFromSubagentJsonl(filePath: string): string | null {
  let lines: ReturnType<typeof parseJsonlLines>;
  try {
    lines = parseJsonlLines(filePath);
  } catch {
    return null;
  }
  for (const line of lines) {
    if (line.type !== 'assistant') continue;
    const l = line as { system?: unknown };
    const sysAny = readEnvelope(line)?.data?.system ?? l.system;
    if (typeof sysAny === 'string' && sysAny.trim()) return sysAny;
    if (Array.isArray(sysAny)) {
      // ContentBlock[] 形态：拼接 text 块
      const text = sysAny
        .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text ?? '') : ''))
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return null;
}

/** 剥运行时附加块（available_skills 等）取纯正文。 */
function stripRuntimeTail(system: string): string {
  let cut = -1;
  for (const marker of RUNTIME_TAIL_MARKERS) {
    const idx = system.indexOf(marker);
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx;
  }
  const body = cut > 0 ? system.slice(0, cut) : system;
  return body.replace(/\s+$/, '');
}

/** 读子代理 meta.json 的 agentType（meta 与 jsonl 同目录、恒明文；x_lake 优先、legacy 兜底）。 */
function readMetaAgentType(subFilePath: string): string | null {
  const metaPath = subFilePath.replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
      agentType?: unknown;
    };
    const at = readEnvelopeWithLegacy(meta)?.data?.agentType ?? meta.agentType;
    return typeof at === 'string' && at ? at : null;
  } catch {
    return null;
  }
}

/**
 * 从会话子代理 jsonl 的 system 注入恢复 agent .md 正文。
 *
 * 两步定位（meta 优先，免逐个解压全部子代理 jsonl）：
 * 1. meta.json agentType === agentName 的子代理 → 读其 jsonl 验证 system 首行标题；
 * 2. meta 缺失/不匹配 → 兜底逐个读 jsonl 首行标题（首个命中即止，大 session 防爆）。
 *
 * 守卫：system 首句 "You are opencode"（通用 prompt，无 agent .md）→ 跳过；
 * 首行标题 ≠ agentName → 跳过（防 meta 与正文错位）。
 *
 * 返回 null = 本会话无该 agent 的 system 注入（opencode 工作流形态等，调用方降级）。
 */
export function recoverAgentMdFromSystem(
  sourcePath: string,
  sessionId: string,
  agentName: string
): SessionRecoveredAgentMd | null {
  if (!sourcePath) return null;
  let subs: { id: string; filePath: string }[];
  try {
    subs = listSubagentSessions(sourcePath, sessionId);
  } catch {
    return null;
  }
  if (subs.length === 0) return null;

  const tryRecover = (sub: { id: string; filePath: string }): SessionRecoveredAgentMd | null => {
    const system = extractSystemFromSubagentJsonl(sub.filePath);
    if (!system) return null;
    if (system.startsWith(GENERIC_SYSTEM_PREFIX)) return null; // opencode 通用 prompt
    if (!isAgentHeading(system, agentName)) return null; // 标题 ≠ 目标 agent
    const body = stripRuntimeTail(system);
    if (body.length === 0) return null;
    return { content: body, source: `subagent:${sub.id}（system 注入）` };
  };

  // 步骤 1：meta agentType 命中 → 只解压这些子代理的 jsonl
  for (const sub of subs) {
    if (readMetaAgentType(sub.filePath) !== agentName) continue;
    const hit = tryRecover(sub);
    if (hit) return hit;
  }
  // 步骤 2：meta 缺失/错位兜底——逐个读（首个命中即止，大 session 防爆）
  for (const sub of subs) {
    const hit = tryRecover(sub);
    if (hit) return hit;
  }
  return null;
}
