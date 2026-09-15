// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverAgentMdFromSystem } from '@/lib/agent-md-session-recover';

/**
 * system 注入恢复测试。fixture = ses_fc73d17d7ffer（cannbot proxy 正常会话，88/88
 * system 注入实测覆盖）的真实子代理样本——19 个 agentType 各一个（gzip 原样，
 * system 保留完整正文 + available_skills 运行时尾部）。
 */
const FIXTURE_DIR = path.resolve(__dirname, './data/agent-md-system-recover');
const FIXTURE_MAIN = path.join(FIXTURE_DIR, 'ses_norm_fixture.jsonl.gz');
const FIXTURE_SID = 'ses_norm_fixture';

describe('recoverAgentMdFromSystem（system 注入恢复——正常会话主路径）', () => {
  it('19 个 agentType 全部恢复成功（真实会话样本，meta 定位 + 标题守卫 + 剥尾部）', () => {
    const agentTypes = new Set<string>();
    for (const f of fs.readdirSync(path.join(FIXTURE_DIR, 'ses_norm_fixture', 'subagents'))) {
      if (!f.endsWith('.meta.json')) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'ses_norm_fixture', 'subagents', f), 'utf-8'));
      const at = meta.x_cannbay?.data?.agentType ?? meta.agentType;
      if (at) agentTypes.add(at);
    }
    expect(agentTypes.size).toBe(19);

    let recovered = 0;
    for (const at of agentTypes) {
      const r = recoverAgentMdFromSystem(
        FIXTURE_MAIN,
        FIXTURE_SID,
        at
      );
      if (!r) continue;
      recovered++;
      // 声明形态：首行标题 = agent 名；尾部运行时块已剥
      expect(r.content.startsWith(`# ${at}`)).toBe(true);
      expect(r.content).not.toContain('<available_skills>');
      expect(r.source).toMatch(/^subagent:ses_/);
    }
    expect(recovered).toBe(19); // 正常会话：全部经 system 注入恢复（不依赖 Read）
  });

  it('恢复的正文是远端运行时版本（designer 8,606 字 ≠ 磁盘 demo 4,771 / glacier 6,793）', () => {
    const r = recoverAgentMdFromSystem(
      FIXTURE_MAIN,
      FIXTURE_SID,
      'designer'
    );
    expect(r).not.toBeNull();
    expect(r!.content.length).toBeGreaterThan(8000); // 真身 8,606 字
    expect(r!.content).toContain('## 你的角色');
  });

  it('x_cannbay.data.system 优先于 legacy 顶层 system（双轨契约）', () => {
    // fixture 的 assistant 行同时带两个字段且值一致（x_cannbay 是权威源）——
    // 构造一个 x_cannbay 与 legacy 不一致的用例验证优先级
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-recover-'));
    const subDir = path.join(tmp, 'ses_x', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'sub-1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        system: '# legacy-should-lose\n\nlegacy 正文。',
        x_cannbay: { schema: 'cc-wire-round', version: 1, data: { system: '# winner\n\n权威正文。' } },
      }) + '\n'
    );
    fs.writeFileSync(
      path.join(subDir, 'sub-1.meta.json'),
      JSON.stringify({ agentType: 'winner' })
    );
    fs.writeFileSync(path.join(tmp, 'ses_x.jsonl'), '');
    const r = recoverAgentMdFromSystem(path.join(tmp, 'ses_x.jsonl'), 'ses_x', 'winner');
    expect(r?.content).toBe('# winner\n\n权威正文。');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('opencode 通用 system prompt（"You are opencode…"）→ null（该形态无声明，降级）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-recover-'));
    const subDir = path.join(tmp, 'ses_g', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'sub-g.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        system: 'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
      }) + '\n'
    );
    fs.writeFileSync(
      path.join(subDir, 'sub-g.meta.json'),
      JSON.stringify({ agentType: 'designer' })
    );
    fs.writeFileSync(path.join(tmp, 'ses_g.jsonl'), '');
    expect(recoverAgentMdFromSystem(path.join(tmp, 'ses_g.jsonl'), 'ses_g', 'designer')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('标题 ≠ 请求的 agent 名 → null（防 meta 与正文错位）', () => {
    expect(
      recoverAgentMdFromSystem(
        FIXTURE_MAIN,
        FIXTURE_SID,
        'nonexistent-agent'
      )
    ).toBeNull();
  });

  it('无子代理目录 / 文件缺失 → null 不抛错', () => {
    expect(recoverAgentMdFromSystem('/tmp/definitely-missing.jsonl', 'whatever', 'x')).toBeNull();
  });
});
