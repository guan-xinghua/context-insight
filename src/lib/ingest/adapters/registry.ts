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
import {
  listSessions as dshNativeListSessions,
  readSession as dshNativeReadSession,
  readSubagentInteractions as dshNativeReadSubagents,
  extractVersion as dshNativeExtractVersion,
  isDshSessionLogName,
} from '../dsh-bridge/native';

// ── 源注册表 ─────────────────────────────────────────────────────────
// 每个源在这里声明一次（字段见 contract.ts 的 SourceDescriptor）。导入接口、
// 文件识别、UI 都从这里读，不用在别处再抄一份；新增一个源 = 写一个
// SourceDescriptor + 在下面 SOURCES 里加一行（清单见
// docs/design/agent-source-framework/design.md §2.6）。
//
// SOURCES 的先后顺序 = 文件识别的优先级：按具体名字匹配的（cannbot_session_、
// rollout- 前缀）必须排在只按扩展名匹配的（.db、.jsonl）前面，否则 codex 的
// rollout-*.jsonl 会被当成 claude 的 .jsonl 文件。

const SQLITE_EXTS = ['.db', '.sqlite', '.sqlite3'];
const isSqliteName = (fileName: string): boolean => SQLITE_EXTS.some(e => fileName.toLowerCase().endsWith(e));
const isJsonlName = (fileName: string): boolean => {
  const lower = fileName.toLowerCase();
  // 不能用 extname：'x.jsonl.7z' 的 extname 是 '.7z'，所以这里只看结尾是不是这三种
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
  // 按 rollout- 前缀认 codex 文件：必须排在 claude-jsonl（按 .jsonl 认）前面，
  // 否则 codex 的 rollout-*.jsonl 会被当成 claude 文件
  sniffFile: (fileName) => isRolloutFileName(fileName),
};

const dshNativeSource: SourceDescriptor = {
  sourceType: 'dsh-native',
  framework: 'dsh',
  listSessions: dshNativeListSessions,
  readSession: dshNativeReadSession,
  readSubagents: dshNativeReadSubagents,
  extractVersion: dshNativeExtractVersion,
  // 按固定文件名认 DSH 文件（session.v4.jsonl / session.v4.jsonl.zstd）：必须排在
  // claude-jsonl（按 .jsonl 认）前面，否则 .jsonl 那种会被当成 claude 文件
  sniffFile: (fileName) => isDshSessionLogName(fileName),
};

const claudeJsonlSource: SourceDescriptor = {
  sourceType: 'claude-jsonl',
  framework: 'claude-code',
  listSessions: claudeJsonlListSessions,
  readSession: claudeJsonlReadSession,
  readSubagents: claudeJsonlReadSubagents,
  collectSubagentToolUseMap: collectSubagentToolUseMappings,
  extractVersion: extractClaudeVersion,
  // 按 .jsonl 结尾认文件：任何 jsonl 都先按 claude 格式试着解析。放最后，
  // 前面按名字匹配的源（rollout- 等）会先命中
  sniffFile: (fileName) => isJsonlName(fileName),
};

const cannbotInsightSource: SourceDescriptor = {
  sourceType: BRAND_SOURCE_TYPE,
  framework: BRAND_SOURCE_TYPE,
  listSessions: cannbotInsightListSessions,
  readSession: cannbotInsightReadSession,
  sniffFile: (fileName) => isSqliteName(fileName) && fileName.startsWith('cannbot_session_'),
};

// 顺序 = 文件识别优先级（从上到先命中先用）：
//   cannbot_session_*.db > 其它 .db > rollout-*.jsonl > session.v4.jsonl[.zstd] > 其它 .jsonl
export const SOURCES: SourceDescriptor[] = [
  cannbotInsightSource,
  opencodeDbSource,
  codexJsonlSource,
  dshNativeSource,
  claudeJsonlSource,
];

export const KNOWN_SOURCE_TYPES: string[] = SOURCES.map(s => s.sourceType);

const SUPPORTED_LIST = KNOWN_SOURCE_TYPES.join(', ');

export function getSource(sourceType: string): SourceDescriptor | null {
  return SOURCES.find(s => s.sourceType === sourceType) ?? null;
}

// 报错时把支持的类型一起列出来（以前这段文案散在三处，容易写得不一致）
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

/** sourceType → framework（写进 Session.framework 的值）。
 *  带 -proxy 后缀的不在这里处理（那是 cpx 捕获，由 data-service 加上后缀）。 */
export function frameworkOfSource(sourceType: string): string | null {
  return getSource(sourceType)?.framework ?? null;
}

/** framework → sourceType 的反查（deltaRefresh 用）。只认不带后缀的原生值；
 *  带 -proxy 后缀的要调用方先去掉后缀（cpx 抓下来的文件固定是 claude 格式）。 */
export function sourceOfFramework(framework: string): string | null {
  return SOURCES.find(s => s.framework === framework)?.sourceType ?? null;
}

/** 按文件名判断属于哪个源（browse-directory 用它填 importableType）。
 *  返回 sourceType，认不出返回 null；是不是目录由调用方自己判断。 */
export function sniffImportableFile(fileName: string): string | null {
  for (const source of SOURCES) {
    if (source.sniffFile?.(fileName)) return source.sourceType;
  }
  return null;
}
