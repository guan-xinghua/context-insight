// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 本地 bare 数据湖 fixture：按 spec §2 布局造仓（<paradigm>/<sid>/、baseline、
// sessions/ 存量区），meta 走 cc-session-meta v1 信封。uploadpack.allowFilter
// 保证 partial clone --filter=blob:none 生效（--no-local 下必须显式开）。
// jsonl 内容按 claude-jsonl 适配器可完整解析的形态书写（e2e 导入链会真跑）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface LakeSeedSession {
  sid: string;
  paradigm: string;
  baseline?: boolean;
  legacy?: boolean;
  /** 双记录布局：native → 目录落 <sid>.native/（目录内文件仍用真实 sid 命名） */
  recording?: 'capture' | 'native';
  framework?: string;
  ccVersion?: string;
  producer?: string;
  workflow?: string;
  opGen?: 'success' | 'failure';
  jsonlLines?: number;
  /** 上传时刻指标快照（spec §4.4 可选字段）：两者齐备时派生 durationMs */
  startTime?: string;
  endTime?: string;
  totalTokens?: number;
  /** 会话主模型（同指标快照一道写 meta） */
  model?: string;
}

export interface LakeSeedCommit {
  sessions: LakeSeedSession[];
  time: string;
  message: string;
  /** 本 commit 前删除的仓内目录（相对 seed 根），表达位置迁移（others→范式）*/
  rmDirs?: string[];
}

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

export function makeBareLake(bareDir: string, commits: LakeSeedCommit[]): void {
  const seed = `${bareDir}.seed`;
  fs.rmSync(bareDir, { recursive: true, force: true });
  fs.rmSync(seed, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bareDir), { recursive: true });
  execSync(`git init --bare -b main "${bareDir}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', bareDir);
  git('git config uploadpack.allowAnySHA1InWant true', bareDir);
  execSync(`git clone --quiet "${bareDir}" "${seed}"`, { stdio: 'pipe' });

  for (const commit of commits) {
    for (const rel of commit.rmDirs ?? []) {
      fs.rmSync(path.join(seed, ...rel.split('/')), { recursive: true, force: true });
    }
    for (const s of commit.sessions) {
      const dir = s.legacy
        ? path.join(seed, 'sessions', s.sid)
        : path.join(seed, s.paradigm, s.baseline ? 'baseline' : '', s.recording === 'native' ? `${s.sid}.native` : s.sid);
      fs.mkdirSync(dir, { recursive: true });
      const lines = Math.max(1, s.jsonlLines ?? 2);
      const body = Array.from({ length: lines - 1 }, (_, i) =>
        JSON.stringify({
          type: 'user',
          timestamp: `2026-01-01T00:00:0${i}Z`,
          message: { role: 'user', content: `数据湖 fixture 冒烟输入 ${i}` },
        })).join('\n');
      fs.writeFileSync(path.join(dir, `${s.sid}.jsonl`), `${body}\n${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:01:00Z',
        message: {
          id: `msg_${s.sid}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'fixture 完成' }],
          model: 'test-model',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      })}\n`);
      const data: Record<string, unknown> = {
        producer: s.producer ?? 'cpx',
        framework: s.framework ?? 'claude-code',
        protocol: 'anthropic',
        ccVersion: s.ccVersion ?? '1.0.0',
        sid: s.sid,
      };
      if (s.workflow) data.workflow = s.workflow;
      if (s.opGen) data.opGen = s.opGen;
      if (s.startTime) data.startTime = s.startTime;
      if (s.endTime) {
        data.endTime = s.endTime;
        const d = Date.parse(s.endTime) - Date.parse(s.startTime ?? '');
        if (s.startTime && Number.isFinite(d) && d > 0) data.durationMs = d;
      }
      if (s.totalTokens != null) data.totalTokens = s.totalTokens;
      if (s.model) data.model = s.model;
      fs.writeFileSync(path.join(dir, `${s.sid}.meta.json`), JSON.stringify({
        x_cannbay: { schema: 'cc-session-meta', version: 1, data },
      }, null, 2));
    }
    fs.writeFileSync(path.join(seed, `touch-${Date.now()}-${Math.random().toString(36).slice(2)}.stamp`), commit.time);
    git('git add .', seed);
    git(`git -c user.name=seeder -c user.email=seed@t commit -q -m "${commit.message}" --date="${commit.time}"`, seed);
    git('git push -q origin main', seed);
  }
  fs.rmSync(seed, { recursive: true, force: true });
}
