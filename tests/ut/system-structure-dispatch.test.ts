// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 系统提示结构框架分发 IT（adapters/system-structure/ 层，agent-source-framework
// 原则 1 的读侧对偶，设计见 §2.5c）：
// cpx 把所有框架捕获归一成 claude 布局，系统提示的结构段（memory/skills）
// 与结构化解析是框架语义——旧实现两处失明：
//   ① readFullContext 只扫 message content 且只认 claude 标记 → proxy 捕获
//     （skills 在扩展 system 字段）恒空（codex 真机会话实测 fc.skills=0）
//   ② readAvailableSkills 按格式试探序嗅探（先 xml 后 claude-list）→
//     codex 的 <skills_instructions> 谁都不匹配 → 覆盖度面板降级
// 本 IT 锁分发矩阵全边：
//   - codex-proxy → codex 提取器（闭合块 + 根表展开 + listFormat codex-list）
//   - opencode-proxy → opencode 家族（xml 块 + Instructions from: 记忆段）
//   - claude-proxy → claude 提取器（ext system 字段，proxy 旧路径恒空的修复）
//   - native 无标记 → claude 默认族（message 行扫描，历史行为保持）
//   - 隔离锁：codex 会话 user 消息里粘贴的 claude skills 文本不被误配
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFullContext, readAvailableSkills } from '../../src/lib/ingest/adapters/claude-jsonl-full-context.ts';
import {
  systemStructureOf,
  frameworkFromLines,
  type SystemStructureExtractor,
} from '../../src/lib/ingest/adapters/system-structure/index.ts';
import { parseJsonlLines } from '../../src/lib/ingest/adapters/claude-jsonl.ts';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'system-structure');
const NATIVE_FIXTURE = path.resolve(__dirname, './data/claude-sessions/skill-coverage-session.jsonl');

describe('system-structure 分发（捕获框架 → 提取器）', () => {
  it('frameworkFromLines：行级 *-proxy 标记 → agentFrameworkOf；native 无标记 → claude-code', () => {
    expect(frameworkFromLines(parseJsonlLines(path.join(DATA_DIR, 'dispatch-codex.jsonl')))).toBe('codex');
    expect(frameworkFromLines(parseJsonlLines(path.join(DATA_DIR, 'dispatch-opencode.jsonl')))).toBe('opencode');
    expect(frameworkFromLines(parseJsonlLines(path.join(DATA_DIR, 'dispatch-claude.jsonl')))).toBe('claude');
    expect(frameworkFromLines(parseJsonlLines(NATIVE_FIXTURE))).toBe('claude-code');
  });

  it('systemStructureOf：分发表全边 + 未列举框架回落 claude 默认族；cannbot 归 opencode 家族', () => {
    const codex = systemStructureOf('codex');
    expect(codex.listFormat).toBe('codex-list');
    expect(systemStructureOf('opencode').listFormat).toBe('opencode-xml');
    expect(systemStructureOf('cannbot').listFormat).toBe('opencode-xml');
    expect(systemStructureOf('claude').listFormat).toBe('claude-list');
    expect(systemStructureOf('claude-code').listFormat).toBe('claude-list');
    // 未列举（legacy 未知 *-proxy 标记 / null）→ 默认族
    expect(systemStructureOf('some-new-framework').listFormat).toBe('claude-list');
    expect(systemStructureOf(null).listFormat).toBe('claude-list');
  });
});

describe('codex 提取器（<skills_instructions> 闭合块，真机 0.161 形态）', () => {
  const extractor: SystemStructureExtractor = systemStructureOf('codex');
  const fc = readFullContext(path.join(DATA_DIR, 'dispatch-codex.jsonl'))!;

  it('readFullContext：ext system 字段 → fc.skills 原文块（含根表与条目，不含 permissions）', () => {
    expect(fc.systemPrompt).toContain('<skills_instructions>');
    expect(fc.skills).toContain('### Skill roots');
    expect(fc.skills).toContain('- imagegen: Generate or edit raster images');
    expect(fc.skills).not.toContain('<permissions instructions>');
    expect(fc.skills.startsWith('<skills_instructions>')).toBe(true);
  });

  it('codex memory 恒空（AGENTS.md 走 user 消息 D1 注入，系统提示无记忆段）', () => {
    expect(fc.memoryFiles).toBe('');
    expect(extractor.findMemorySection('whatever')).toBe('');
  });

  it('readAvailableSkills：结构化全集 + 根表展开为绝对路径 + listFormat codex-list', () => {
    const parsed = readAvailableSkills(path.join(DATA_DIR, 'dispatch-codex.jsonl'))!;
    expect(parsed.format).toBe('codex-list');
    expect(parsed.skills.map(s => s.name)).toEqual(['imagegen', 'openai-docs', 'custom-audit']);
    expect(parsed.skills[0].origin).toBe('/home/dev/.codex/skills/.system/imagegen/SKILL.md');
    expect(parsed.skills[2].origin).toBe('/home/dev/.codex/skills/custom/custom-audit/SKILL.md');
    expect(parsed.skills[2].description).toBe('自定义审计技能，扫描仓库规范与命名一致性。');
  });

  it('纯函数边：未闭合块降级取到文末；未知根保留相对原值', () => {
    const unclosed = '<skills_instructions>\n### Available skills\n- x: 描述。 (file: rZ/x/SKILL.md)';
    expect(extractor.findSkillsSection(unclosed)).toBe(unclosed);
    const parsed = extractor.parseAvailableSkills(unclosed);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].origin).toBe('rZ/x/SKILL.md');
  });
});

describe('opencode 家族提取器（<available_skills> xml + Instructions from: 记忆段）', () => {
  it('readFullContext：fc.skills = xml 块原文；fc.memoryFiles = 记忆段原文（到 skills 块止）', () => {
    const fc = readFullContext(path.join(DATA_DIR, 'dispatch-opencode.jsonl'))!;
    expect(fc.skills.startsWith('<available_skills>')).toBe(true);
    expect(fc.skills).toContain('<name>acme-docs-search</name>');
    expect(fc.memoryFiles.startsWith('Instructions from: /home/dev/project/AGENTS.md')).toBe(true);
    expect(fc.memoryFiles).toContain('# 项目工程指南');
    expect(fc.memoryFiles).not.toContain('<available_skills>');
  });

  it('readAvailableSkills：xml 全集 + listFormat opencode-xml（迁移后行为保持）', () => {
    const parsed = readAvailableSkills(path.join(DATA_DIR, 'dispatch-opencode.jsonl'))!;
    expect(parsed.format).toBe('opencode-xml');
    expect(parsed.skills.map(s => s.name)).toEqual(['acme-docs-search', 'report-writer']);
    expect(parsed.skills[0].origin).toBe('/home/dev/skills/acme-docs-search');
  });
});

describe('claude 提取器（proxy 扩展 system 字段——旧路径恒空的修复 + native 行为保持）', () => {
  it('claude-proxy：ext system 字段产出 memory/skills（旧实现只扫 message，proxy 恒空）', () => {
    const fc = readFullContext(path.join(DATA_DIR, 'dispatch-claude.jsonl'))!;
    expect(fc.memoryFiles).toContain('- 项目构建：npm run build');
    expect(fc.memoryFiles).not.toContain('# claudeMd');
    expect(fc.skills).toContain('The following skills are available');
    expect(fc.skills).toContain('- pr-review: PR 评审技能');
    const parsed = readAvailableSkills(path.join(DATA_DIR, 'dispatch-claude.jsonl'))!;
    expect(parsed.format).toBe('claude-list');
    expect(parsed.skills.map(s => s.name)).toEqual(['pr-review', 'api-design']);
  });

  it('native claude（无标记）：message 行扫描保持历史行为（system-reminder 里的 skills 列表）', () => {
    const fc = readFullContext(NATIVE_FIXTURE)!;
    expect(fc.skills).toContain('The following skills are available');
    expect(fc.skills).toContain('- alpha-workflow: 主工作流技能');
  });
});

describe('隔离锁：异框架结构标记不越界', () => {
  it('codex 会话 user 消息里粘贴的 claude skills 文本不被误配（fc.skills 恒空）', () => {
    const fc = readFullContext(path.join(DATA_DIR, 'dispatch-codex-claude-text.jsonl'))!;
    expect(fc.systemPrompt).toBe('You are a coding agent running in the Codex CLI, a terminal-based coding assistant. 本会话未配置 skills。');
    expect(fc.skills).toBe('');
    // 覆盖度全集同样不受污染
    const parsed = readAvailableSkills(path.join(DATA_DIR, 'dispatch-codex-claude-text.jsonl'));
    expect(parsed).toBeNull();
  });
});
