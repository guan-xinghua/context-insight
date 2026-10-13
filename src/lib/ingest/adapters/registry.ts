// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { BRAND_SOURCE_TYPE } from '@/lib/branding';
import type { SourceDescriptor } from './contract';
import { listSessions as opencodeDbListSessions, readSession as opencodeDbReadSession } from './opencode-db';
import {
  listSessions as claudeJsonlListSessions,
  readSession as claudeJsonlReadSession,
  readSubagentInteractions as claudeJsonlReadSubagents,
  collectSubagentToolUseMappings,
  extractVersion as extractClaudeVersion,
} from './claude-jsonl';
import {
  listSessions as codexJsonlListSessions,
  readSession as codexJsonlReadSession,
  readSubagentInteractions as codexJsonlReadSubagents,
  extractVersion as extractCodexVersion,
} from './codex-jsonl';
import { isRolloutFileName } from './codex-naming';
import { listSessions as cannbotInsightListSessions, readSession as cannbotInsightReadSession } from './cannbot-insight';

// ── 源注册表（agent-source-framework 单点）───────────────────────────
// 声明序即嗅探优先级：前缀精确嗅探（cannbot_session_ / rollout-）必须排在
// 扩展名兜底（opencode-db 的 .db / claude-jsonl 的 .jsonl）之前，否则
// codex 的 rollout-*.jsonl 会被误判成 claude 捕获件。
// 新框架接入清单见 docs/design/agent-source-framework/design.md §2.6：
// 实现一个 SourceDescriptor + 在此加一行，其余触点全部注册表驱动。

const SQLITE_EXTS = ['.db', '.sqlite', '.sqlite3'];
const isSqliteName = (fileName: string): boolean => SQLITE_EXTS.some(e => fileName.toLowerCase().endsWith(e));
const isJsonlName = (fileName: string): boolean => {
  const lower = fileName.toLowerCase();
  // extname 对 'x.jsonl.7z' 返回 '.7z'，压缩三形态必须用 endsWith 判定
  return lower.endsWith('.jsonl') || lower.endsWith('.jsonl.gz') || lower.endsWith('.jsonl.7z');
};

const opencodeDbSource: SourceDescriptor = {
  sourceType: 'opencode-db',
  framework: 'opencode',
  listSessions: opencodeDbListSessions,
  readSession: opencodeDbReadSession,
  sniffFile: (fileName) => isSqliteName(fileName),
};

const codexJsonlSource: SourceDescriptor = {
  sourceType: 'codex-jsonl',
  framework: 'codex',
  listSessions: codexJsonlListSessions,
  readSession: codexJsonlReadSession,
  readSubagents: codexJsonlReadSubagents,
  extractVersion: extractCodexVersion,
  // rollout- 前缀精确嗅探：必须先于 claude-jsonl 的扩展名兜底，否则
  // codex 原生会话被误判成 claude 捕获件
  sniffFile: (fileName) => isRolloutFileName(fileName),
};

const claudeJsonlSource: SourceDescriptor = {
  sourceType: 'claude-jsonl',
  framework: 'claude-code',
  listSessions: claudeJsonlListSessions,
  readSession: claudeJsonlReadSession,
  readSubagents: claudeJsonlReadSubagents,
  collectSubagentToolUseMap: collectSubagentToolUseMappings,
  extractVersion: extractClaudeVersion,
  // 扩展名兜底：任何 jsonl（含压缩三形态）都可按 claude 格式尝试解析，
  // 注册在最后，前缀精确嗅探（rollout- 等）先于本兜底命中
  sniffFile: (fileName) => isJsonlName(fileName),
};

const cannbotInsightSource: SourceDescriptor = {
  sourceType: BRAND_SOURCE_TYPE,
  framework: BRAND_SOURCE_TYPE,
  listSessions: cannbotInsightListSessions,
  readSession: cannbotInsightReadSession,
  sniffFile: (fileName) => isSqliteName(fileName) && fileName.startsWith('cannbot_session_'),
};

// 嗅探优先级：cannbot（前缀+db）> opencode-db（db 兜底）> codex（rollout-
// 前缀）> claude-jsonl（jsonl 兜底）
export const SOURCES: SourceDescriptor[] = [
  cannbotInsightSource,
  opencodeDbSource,
  codexJsonlSource,
  claudeJsonlSource,
];

export const KNOWN_SOURCE_TYPES: string[] = SOURCES.map(s => s.sourceType);

const SUPPORTED_LIST = KNOWN_SOURCE_TYPES.join(', ');

export function getSource(sourceType: string): SourceDescriptor | null {
  return SOURCES.find(s => s.sourceType === sourceType) ?? null;
}

// 未知源报错带支持清单——此前该文案散在 getAdapter/normalize/路由三处，口径靠人肉同步
export function requireSource(sourceType: string): SourceDescriptor {
  const found = getSource(sourceType);
  if (!found) {
    throw new Error(`Unknown source type: "${sourceType}". Supported types: ${SUPPORTED_LIST}`);
  }
  return found;
}

export function isKnownSource(sourceType: string): boolean {
  return getSource(sourceType) != null;
}

/** sourceType → 原生 framework（agent 归属落库值）。-proxy 装饰不在此处
 * （那是捕获记录类，data-service 施加）。 */
export function frameworkOfSource(sourceType: string): string | null {
  return getSource(sourceType)?.framework ?? null;
}

/** framework → sourceType 反向映射（deltaRefresh 用）。只解析原生 framework；
 * proxy 变体（-proxy 后缀）由调用方先行归一到 claude-jsonl（捕获件恒 claude 格式）。 */
export function sourceOfFramework(framework: string): string | null {
  return SOURCES.find(s => s.framework === framework)?.sourceType ?? null;
}

/** 文件级源识别（browse-directory 的 importableType 单点判定）。
 * 返回 sourceType 或 null（不可导入）。目录项判定调用方自查 isDirectory。 */
export function sniffImportableFile(fileName: string): string | null {
  for (const source of SOURCES) {
    if (source.sniffFile?.(fileName)) return source.sourceType;
  }
  return null;
}
