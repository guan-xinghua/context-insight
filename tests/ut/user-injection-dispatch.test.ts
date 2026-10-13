// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 注入分类框架分发 IT（adapters/injections/ 层，agent-source-framework 原则 1）：
// cpx 把所有框架的捕获归一成 claude 布局，claude-jsonl 适配器是通用格式入口
// ——注入指纹框架自持，入口按行级 source 标记分发（injections/index.ts）。
// 本 IT 锁分发矩阵全边：
//   - 默认族（native 无标记 / legacy claude-proxy / insight-export）→ claude-code 指纹
//   - codex-proxy → codex 指纹，且 claude/opencode 指纹不越界（保持 user）
//   - opencode-proxy → opencode 家族指纹（skill + 首条例外），claude 指纹不越界
// 隔离锁方向即修复方向：异框架指纹误伤会把真实输入吞成 system/丢弃（真机
// replayA 的 #0 env_ctx 缺陷即同族问题）。
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSession } from '../../src/lib/ingest/adapters/claude-jsonl.ts';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'user-injection-dispatch');

describe('注入分类框架分发（行级 source → 框架指纹，fixture 驱动）', () => {
  it('默认族（native 无标记）：task-notification → system 摘要，skill 注入 → system verbatim', () => {
    const rows = readSession(path.join(DATA_DIR, 'dispatch-claude-native.jsonl'), 'dispatch-claude-native');
    expect(rows.map(r => r.role)).toEqual(['system', 'assistant', 'system', 'user']);
    expect(rows[0].content).toContain('✅ Task: native-agent [completed]');
    expect(rows[2].content).toContain('Base directory for this skill');
  });

  it('legacy claude-proxy 标记 → 默认族（task-notification → system 摘要）', () => {
    const rows = readSession(path.join(DATA_DIR, 'dispatch-claude-proxy.jsonl'), 'dispatch-claude-proxy');
    expect(rows.map(r => r.role)).toEqual(['system', 'user']);
    expect(rows[0].content).toContain('✅ Task: proxy-agent [completed]');
  });

  it('insight-export 再导出 → 默认族（task-notification → system 摘要）', () => {
    const rows = readSession(path.join(DATA_DIR, 'dispatch-insight-export.jsonl'), 'dispatch-insight-export');
    expect(rows.map(r => r.role)).toEqual(['system', 'user']);
    expect(rows[0].content).toContain('✅ Task: export-agent [completed]');
  });

  it('codex-proxy：env_ctx 丢弃；claude/opencode 指纹不越界（保持 user）；事件注入 system 摘要', () => {
    const rows = readSession(path.join(DATA_DIR, 'dispatch-codex.jsonl'), 'dispatch-codex');
    // env_ctx（L1）被 drop 不进时间线，首条即 assistant（L2）
    expect(rows.map(r => r.role)).toEqual(['assistant', 'user', 'user', 'system', 'user']);
    // 隔离锁 1：opencode skill 指纹不误伤 codex 会话（此前内联块会吞成 system）
    expect(rows[1].content).toContain('Base directory for this skill');
    // 隔离锁 2：claude task-notification 指纹不误伤 codex 会话
    expect(rows[2].content).toContain('<task-notification>');
    // 框架内语义保留：事件注入（子代理通知）摘要化 system turn
    expect(rows[3].content).toContain('✅ 子代理完成: /tmp/agents/demo [completed]');
    expect(rows[3].content).toContain('分析完成：依赖结构无循环。');
  });

  it('opencode-proxy：skill 首条例外保持 user；次条 → system verbatim；task-notification 隔离保持 user', () => {
    const rows = readSession(path.join(DATA_DIR, 'dispatch-opencode.jsonl'), 'dispatch-opencode');
    expect(rows.map(r => r.role)).toEqual(['user', 'assistant', 'system', 'user']);
    // 首条例外：opencode ≥1.17 skill 规程注入为首条，重分类会让 turn0 角色随版本漂移
    expect(rows[0].content).toContain('Base directory for this skill');
    // 次条注入：system + verbatim
    expect(rows[2].content).toContain('Launching skill: demo-skill');
    // 隔离锁：claude task-notification 指纹不误伤 opencode 家族会话
    expect(rows[3].content).toContain('<task-notification>');
  });
});
