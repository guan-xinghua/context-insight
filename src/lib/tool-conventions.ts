// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how you could use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ── 框架工具调用约定（单一事实源）────────────────────────────────
// 各 agent 框架的同义工具存在参数键与结果负载的版本演进（实测真机数据）：
//   read：opencode 旧版 `path` → 新版 `filePath`；Claude Code `file_path`
//   skill：opencode 旧版 `name` → 新版 `id`；Claude Code `skill`
//   结果负载：opencode 1.x 传字符串 → 2.x 传内容块数组
//   shell 工具名：opencode 1.x `bash` → 2.x `shell`；codex `exec`/`exec_command`
// 识别约定集中于此：摄取侧（ingest/turn-split、adapters）与读取侧
// （file-reads / skill-content / scoring / sift-audit）共用同一词表，消除
// 手工同步的孪生实现（历史缺陷：opencode `path` 键读取在 Files 分析整页
// 不可见、`id` 键技能名回落工具名字面量、2.x 结果壳让行级解析全废、
// `shell` 命令面在 D2 安全评分盲区）。
// 扩展协议：新框架/新版本的键 = 在对应候选表加一项（有序：具体 →
// 通用，先命中先用），全部消费方自动对齐；新工具族 = 新增一节 +
// 解析函数，消费方按需引入。

/** read 工具的文件路径参数键候选（有序：具体 → 通用） */
const READ_PATH_ARG_KEYS = ['filePath', 'file_path', 'path'] as const;

/** read 工具参数的规范化形态（未命中的键为 null） */
export interface ReadToolArgs {
  filePath: string | null;
  offset: number | null;
  limit: number | null;
  summary: string | null;
}

/**
 * 解析 read 工具 argsJson → 规范化形态。
 * 无 args / 非 JSON 返回 null；无路径键命中时 filePath 为 null（调用方
 * 自行跳过）——不整体返回 null，保留 offset/limit 等伴生键的可见性。
 */
export function parseReadToolArgs(argsJson: string | null): ReadToolArgs | null {
  if (!argsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const args = parsed as Record<string, unknown>;

  let filePath: string | null = null;
  for (const key of READ_PATH_ARG_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v) {
      filePath = v;
      break;
    }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    filePath,
    offset: num(args.offset),
    limit: num(args.limit),
    summary: str(args.summary),
  };
}

// ── skill 工具族 ────────────────────────────────────────────────────

/** skill 工具族的裸名（skill/ 前缀族另判） */
const SKILL_TOOL_EXACT_NAMES = new Set(['skill', 'load_skill']);

/** 技能名参数键候选（有序：`id` 最通用放最后——opencode 新版专用） */
const SKILL_NAME_ARG_KEYS = ['skill', 'skill_name', 'name', 'id'] as const;

/** skill 工具族判定（skill / load_skill / skill/xxx 族，大小写不敏感） */
export function isSkillToolCall(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower.startsWith('skill/') || SKILL_TOOL_EXACT_NAMES.has(lower);
}

/** skill 事件类型：load_skill 系 = load；invoke 直名 = invoke；其余族 = use */
export function skillEventTypeOf(toolName: string): 'load' | 'invoke' | 'use' {
  const lower = toolName.toLowerCase();
  if (lower === 'skill/load_skill' || lower === 'load_skill') return 'load';
  if (lower === 'skill/invoke' || lower === 'skill') return 'invoke';
  return 'use';
}

/** skill 注入正文指纹（读侧单源）：classifyUserInjection 把含这些 marker 的
 * 用户行重分类为 system 轮。injections/claude-code.ts 从此处 re-export——
 * claude-jsonl/opencode 分类器（写侧合并）与 turn-split 斜杠命令计数（读侧）
 * 共用同一词表，marker 集合改动必须双侧同步。 */
export function isSkillInjectionText(text: string): boolean {
  return text.includes('Base directory for this skill') ||
    text.includes('<skill-format>') ||
    text.startsWith('Launching skill:') ||
    text.startsWith('Launching skill ');
}

/** opencode 子代理回传 / claude 后台任务完成通知指纹（读侧单源）：异步派发
 *  完成时两家都以 user 行推回主会话——opencode 是 `<subagent sessionID="…"
 *  state="…">` 壳；claude code 是 `<task-notification>` 壳（Agent 工具的
 *  tool_result 只是"Async agent launched"启动回执，完成通知走 user 行）。
 *  wire 角色是 user，说话的是子代理/运行时。Turns 时间线（不显示 user 徽标）
 *  与评分链路（不当真人输入：userMessages 剔除、轨迹摘要打标）共用。 */
export function isSubagentReturnText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trimStart();
  return t.startsWith('<subagent sessionID=') || t.startsWith('<task-notification>');
}

/** claude 形态重分类后的摘要指纹：claude-jsonl 注入分类器把 `<task-notification>`
 *  user 行重分类为 system 轮，内容换写为 parseTaskNotificationSummary 的产出
 *  （`✅ Task: 名字` / `✅ Task 完成`）。该摘要轮同样显示「子代理回传」、
 *  轨迹摘要打标——指纹与 parseTaskNotificationSummary（injections/claude-code.ts）
 *  成对，格式改动必须双侧同步。 */
export function isTaskNotificationSummaryText(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.trimStart().startsWith('✅ Task');
}

/**
 * 提取技能名：依次查参数键候选；无 args / 无命中时回落工具名去
 * skill/ 前缀（如 skill/ops-spec-gen → ops-spec-gen）。
 */
export function extractSkillName(toolName: string, argsJson: string | null): string {
  if (argsJson) {
    try {
      const parsed: unknown = JSON.parse(argsJson);
      if (typeof parsed === 'object' && parsed !== null) {
        const args = parsed as Record<string, unknown>;
        for (const key of SKILL_NAME_ARG_KEYS) {
          const v = args[key];
          if (typeof v === 'string' && v) return v;
        }
      }
    } catch {
      // 非 JSON：回落工具名
    }
  }
  return toolName.replace(/^skill\//i, '');
}

/** 提取技能版本（version 数字键；无则 null） */
export function extractSkillVersion(argsJson: string | null): number | null {
  if (!argsJson) return null;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (typeof parsed === 'object' && parsed !== null) {
      const v = (parsed as Record<string, unknown>).version;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  } catch {
    // 忽略
  }
  return null;
}

// ── 工具结果负载归一 ────────────────────────────────────────────────

/** 内容块数组 → text 块拼接；非该形态 → null（数组无文本块也归 null） */
function textBlocksOf(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const texts: string[] = [];
  for (const el of raw) {
    if (typeof el === 'object' && el !== null) {
      const b = el as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) texts.push(b.text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * 把框架的工具结果负载归一为文本。三种形态（真机核实）：
 *   1. 字符串直通（opencode 1.x / claude 原生）
 *   2. 内容块数组（opencode 2.x part/state.content；claude 协议 tool_result
 *      的 content 数组同形态）→ 取 text 块拼接
 *   3. 「字符串化嵌套」：湖原生导出等上游把 content 数组 stringify 进
 *      tool_result 字符串（真机 ecb 会话 276/276 全此形态）→ 前缀快筛后
 *      解一层剥出文本
 * 无文本块或其他形态回落 JSON 序列化（保持原行为）。
 * 历史缺陷：形态 2/3 被整体 stringify 落库，`\n` 成转义字面量，read 行级
 * 解析 / 文件还原 / skill 内容全链失效。
 * 已知约定碰撞：结果文本恰好以 `[{"type":` 开头且为内容块形态的真输出会被
 * 剥壳（框架协议形态即载荷，视为可接受）。
 */
export function normalizeToolResultPayload(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    if (raw.startsWith('[{"type":')) {
      try {
        const texts = textBlocksOf(JSON.parse(raw));
        if (texts !== null) return texts;
      } catch {
        // 普通文本（碰巧前缀像）直通
      }
    }
    return raw;
  }
  if (Array.isArray(raw)) {
    const texts = textBlocksOf(raw);
    if (texts !== null) return texts;
  }
  return JSON.stringify(raw);
}

// ── skill 结果协议壳 ────────────────────────────────────────────────

const SKILL_CONTENT_WRAPPER_RE = /<skill_content[^>]*>([\s\S]*?)<\/skill_content>/;

/**
 * 剥 skill 工具结果的 `<skill_content name="…">…</skill_content>` 协议壳
 * （trim）。无壳 / 空输入 → null。opencode 2.x 的 skill 结果经负载归一
 * 后即此形态；v1 纯文本形态（Base directory 前言）由消费方自行回落。
 */
export function unwrapSkillContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = content.match(SKILL_CONTENT_WRAPPER_RE);
  return m ? m[1]!.trim() : null;
}

// ── shell 命令工具族 ────────────────────────────────────────────────

/** shell 执行工具裸名：bash（opencode 1.x）/ shell（opencode 2.x）/ exec·exec_command（codex 系） */
export const SHELL_TOOL_NAMES: readonly string[] = ['bash', 'shell', 'exec', 'exec_command'];

const SHELL_TOOL_EXACT = new Set(SHELL_TOOL_NAMES);

/** shell 工具族判定（大小写不敏感） */
export function isShellToolCall(toolName: string): boolean {
  return SHELL_TOOL_EXACT.has(toolName.toLowerCase());
}

/**
 * shell 命令的连接文本（供文本扫描）：`{"command": string}` 直取；数组
 * 形态 join ' '。无 command 键（如 exec 的 input 形态）→ null，调用方
 * 自行回落原始 args。
 */
export function shellCommandOf(argsJson: string | null): string | null {
  const parts = shellCommandArgsOf(argsJson);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * shell 命令的参数段（供逐段文件读提取）：字符串命令 → [整串]；数组
 * 命令 → 各元素（`["bash","-lc","cat a"]` 的载荷在末元素——逐元素尝试
 * 避免连接后头部变 bash 导致漏提取）。无 command 键 → []。
 */
export function shellCommandArgsOf(argsJson: string | null): string[] {
  if (!argsJson) return [];
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const c = (parsed as Record<string, unknown>).command;
    if (typeof c === 'string') return [c];
    if (Array.isArray(c) && c.length > 0 && c.every(x => typeof x === 'string')) return c as string[];
  } catch {
    // 非 JSON
  }
  return [];
}
