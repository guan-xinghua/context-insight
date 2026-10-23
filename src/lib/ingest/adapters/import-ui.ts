// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 导入 UI 元数据（agent-source-framework）：纯数据模块，无 node 依赖，
// 客户端组件（LocalFileImport）可安全 import。此前 source 选项/快捷路径/
// placeholder 硬编码在组件里，新源接入还要动 UI——现在数据在这声明。

export interface ImportSourceQuickDir {
  label: string;
  path: string;
}

export interface ImportSourceUi {
  /** 源按钮文案（tab 级；sqlite 双库共享一个 tab） */
  buttonLabel: string;
  /** 路径输入框 placeholder */
  placeholder: string;
  /** 快捷路径（服务端 ~ 展开） */
  quickDirs: ImportSourceQuickDir[];
  /** jsonl 单文件直导：路径指向单个会话文件时跳过列表直接导入 */
  directFileImport: boolean;
  /** 浏览列表里的类型徽标文案 */
  badgeLabel: string;
}

export const IMPORT_SOURCES_UI: Record<string, ImportSourceUi> = {
  // 伞形入口（SOURCE_FAMILIES.jsonl）：claude 布局 / codex rollout / DSH 原生
  // 按文件内容自动识别（registry.resolveSource 探测），UI 不再按框架分键
  jsonl: {
    buttonLabel: 'JSONL (auto)',
    placeholder: '/path/to/*.jsonl(.7z/.gz) or sessions-dir — claude/codex/dsh 自动识别',
    quickDirs: [
      { label: 'cpx proxy 捕获', path: '~/.context-insight/proxy' },
      { label: 'Claude 原生', path: '~/.claude/projects' },
      { label: 'Codex 原生', path: '~/.codex/sessions' },
      { label: 'DSH 原生', path: '~/.dsh/sessions' },
    ],
    directFileImport: true,
    badgeLabel: 'JSONL',
  },
  'claude-jsonl': {
    buttonLabel: 'JSONL',
    placeholder: '/path/to/session.jsonl(.7z/.gz) or /path/to/sessions-dir',
    quickDirs: [
      { label: 'cpx proxy 捕获', path: '~/.context-insight/proxy' },
      { label: 'Claude 原生', path: '~/.claude/projects' },
    ],
    directFileImport: true,
    badgeLabel: 'JSONL',
  },
  'codex-jsonl': {
    buttonLabel: 'Codex',
    placeholder: '/path/to/rollout-*.jsonl or ~/.codex/sessions',
    quickDirs: [
      { label: 'Codex 原生', path: '~/.codex/sessions' },
    ],
    directFileImport: true,
    badgeLabel: 'Codex',
  },
  'opencode-db': {
    buttonLabel: 'SQLite',
    placeholder: '/path/to/sessions.db',
    quickDirs: [
      { label: 'opencode 数据', path: '~/.local/share/opencode' },
    ],
    directFileImport: false,
    badgeLabel: 'SQLite DB',
  },
  // context-insight 导出库与 opencode-db 同属 sqlite tab（浏览点击
  // context_session_*.db 时 sourceType 被设为本值），UI 数据对齐
  'context-insight': {
    buttonLabel: 'SQLite',
    placeholder: '/path/to/sessions.db',
    quickDirs: [
      { label: 'opencode 数据', path: '~/.local/share/opencode' },
    ],
    directFileImport: false,
    badgeLabel: 'SQLite DB',
  },
};
