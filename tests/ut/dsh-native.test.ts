// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// DSH 原生导入「读取 + 转义」UT：事件→RawInteraction 语义、发现/列举/子代理建链、
// 两种磁盘布局同构、注册表嗅探、与 normalize/turn-split/bridge 的端到端建桥。

import path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  convertDshSession,
  listSessions,
  readSession,
  readSubagentInteractions,
} from '@/lib/ingest/dsh-bridge/native';
import { sniffImportableFile } from '@/lib/ingest/adapters/registry';
import { isDshSessionPath } from '@/lib/ingest/dsh-detect';
import { normalize } from '@/lib/ingest/normalize';
import { splitIntoTurns, resetIdCounter as resetTurnIdCounter } from '@/lib/ingest/turn-split';
import { buildBridges, resetIdCounter as resetBridgeIdCounter } from '@/lib/ingest/bridge-builder';

const DATA = path.resolve(__dirname, './data/dsh');
const SESSIONS_ROOT = path.join(DATA, 'native/sessions');
const EXPORT_ROOT = path.join(DATA, 'native/export');
const MULTIFRAME_DIR = path.join(DATA, 'multi-frame');

const SID = 'session-aaaa';
const CHILD = '11111111-1111-4111-8111-111111111111';

describe('DSH 原生：事件 → RawInteraction 转义', () => {
  it('用户输入 / assistant（含 reasoning、tool-call、usage）/ 事件注入归一正确', () => {
    const interactions = readSession(SESSIONS_ROOT, SID);
    expect(interactions.map(i => i.role)).toEqual(['user', 'assistant', 'system', 'assistant']);

    const user = interactions[0];
    expect(user.content).toBe('读一下 README');
    expect(user.tool_calls).toBeNull();

    const assistant = interactions[1];
    expect(assistant.content).toContain('<thinking>先看文件</thinking>');
    expect(assistant.content).toContain('好的');
    expect(assistant.model).toBe('deepseek-flash');
    expect(assistant.providerID).toBe('deepseek-official');
    expect(assistant.usage?.total).toBe(12);
    expect(assistant.usage?.input).toBe(10);
    expect(assistant.usage?.output).toBe(2);
    // 时延 = step/start → assistant/message（模型时延，不含工具执行）
    expect(assistant.timeInfo?.created).toBe(1790000000020);
    expect(assistant.timeInfo?.completed).toBe(1790000000100);
    expect(assistant.latency).toBe(80);
    // turn/end.completed → end_turn
    expect(assistant.finish_reason).toBe('end_turn');
    // 派发工具归一：DSH 原生 subagent → Agent；结果经 callId 回填
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls?.[0]).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'Agent',
      state: 'completed',
    });
    expect(assistant.tool_calls?.[0].resultJson).toBe(`started subagent ${CHILD}`);

    // 事件注入：后台子代理结算 → system turn（摘要）
    const settle = interactions[2];
    expect(settle.role).toBe('system');
    expect(settle.content).toContain('finished');

    // turn/end.aborted → stop_sequence
    expect(interactions[3].content).toBe('完成');
    expect(interactions[3].finish_reason).toBe('stop_sequence');
  });

  it('静态注入（runtime-context / skill-catalog / 系统提示词）不进时间线', () => {
    const text = JSON.stringify(readSession(SESSIONS_ROOT, SID));
    expect(text).not.toContain('runtime context snapshot');
    expect(text).not.toContain('skills catalog');
    expect(text).not.toContain('powered by DeepSeek Harness');
  });

  it('工具错误结果 → state=error + <tool_use_error> 前缀', () => {
    const header = { type: 'session', version: 4, id: 'session-err', createdAt: 1 } as const;
    const events = [
      { type: 'step/start', seq: 0, time: 10, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 1,
        time: 20,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'c9', name: 'bash', arguments: '{"command":"false"}' }],
          },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
        },
      },
      {
        type: 'tool/result',
        seq: 2,
        time: 30,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: 'Exit code: 1' }], isError: true },
        },
      },
    ];
    const interactions = convertDshSession(header as never, events as never).interactions;
    expect(interactions[0].tool_calls?.[0].state).toBe('error');
    expect(interactions[0].tool_calls?.[0].resultJson).toBe('<tool_use_error>Exit code: 1');
  });

  it('用户输入没有文本内容时保留空轮次并记警告', () => {
    const header = { type: 'session', version: 4, id: 'session-img', createdAt: 1 } as const;
    const events = [
      {
        type: 'user/message',
        seq: 0,
        time: 10,
        data: { source: { kind: 'user' }, content: [{ type: 'image', url: 'blob:x' }] },
      },
    ];
    const { interactions, warnings } = convertDshSession(header as never, events as never);
    expect(interactions.map(i => i.role)).toEqual(['user']);
    expect(interactions[0].content).toBeNull();
    expect(warnings.join('\n')).toContain('没有文本内容');
  });
});

describe('DSH 原生：发现 / 列举 / 子代理建链', () => {
  it('listSessions 列举顶层会话（子代理不作为顶层条目）', () => {
    const sessions = listSessions(SESSIONS_ROOT);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: SID,
      firstQuery: '读一下 README',
      turnCount: 2,
      modelName: 'deepseek-flash',
      totalTokens: 18,
    });
  });

  it('readSubagents 按 header.parentSession 建链并打标（原生布局）', () => {
    const sub = readSubagentInteractions(SESSIONS_ROOT, SID);
    expect(sub.map(i => i.role)).toEqual(['user', 'assistant']);
    expect(sub.every(i => i.subagent_session_id === CHILD)).toBe(true);
    expect(sub.every(i => i.subagent_name === 'Read README')).toBe(true);
    expect(sub.every(i => i.subagent_type === 'one-shot')).toBe(true);
  });

  it('两种磁盘布局（原生 <cwd>/<sid>/ 与导出 <sid>/subagents/）结果同构', () => {
    expect(readSession(EXPORT_ROOT, SID)).toEqual(readSession(SESSIONS_ROOT, SID));
    expect(readSubagentInteractions(EXPORT_ROOT, SID)).toEqual(readSubagentInteractions(SESSIONS_ROOT, SID));
    expect(listSessions(EXPORT_ROOT)).toEqual(listSessions(SESSIONS_ROOT));
  });

  it('真实多帧 zstd 件可读；同目录两种形态并存时列表按会话去重', () => {
    // 该 fixture 目录同时放了 .jsonl 与 .jsonl.zstd 两形态（同一会话）：
    // listSessions 必须只返回一条（此前会返回两条同 id），readSession 也要能读到
    const sessions = listSessions(MULTIFRAME_DIR);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('session-00000000-0000-4000-8000-000000000001');
    const interactions = readSession(MULTIFRAME_DIR, 'multi-frame');
    expect(interactions.length).toBeGreaterThan(0);
  });
});

describe('DSH 原生：注册表嗅探', () => {
  it('session.v4.jsonl / .zstd 判定为 dsh-native（先于 claude 兜底）', () => {
    expect(sniffImportableFile('session.v4.jsonl.zstd')).toBe('dsh-native');
    expect(sniffImportableFile('session.v4.jsonl')).toBe('dsh-native');
  });

  it('其他 jsonl 仍归 claude 兜底，codex rollout 不受影响', () => {
    expect(sniffImportableFile('abc.jsonl')).toBe('claude-jsonl');
    expect(sniffImportableFile('rollout-2026-01-01T00-00-00-abc.jsonl')).toBe('codex-jsonl');
  });
});

describe('DSH 原生：与 normalize / turn-split / bridge 端到端建桥', () => {
  let bridges: ReturnType<typeof buildBridges>;

  beforeAll(() => {
    resetTurnIdCounter();
    resetBridgeIdCounter();
    const main = readSession(SESSIONS_ROOT, SID);
    const sub = readSubagentInteractions(SESSIONS_ROOT, SID);
    const interactions = [...main, ...sub];
    const normalized = normalize(interactions, 'dsh-native');
    const { turns, toolCalls } = splitIntoTurns(normalized, SID);
    bridges = buildBridges(normalized, toolCalls, turns, SID, 'root-exec-dsh');
  });

  it('subagent 派发经 started subagent <uuid> 精确建桥到子会话', () => {
    expect(bridges).toHaveLength(1);
    expect(bridges[0].subagentSessionId).toBe(CHILD);
    expect(bridges[0].status).toBe('completed');
    expect(bridges[0].dispatchContent).toBe('Read README');
  });
});

describe('DSH 路径识别（JSONL tab 自动分流用）', () => {
  it('DSH 会话文件 / 含它的目录（含多层）判定为 true', () => {
    expect(isDshSessionPath(path.join(SESSIONS_ROOT, '--tmp-demo--', SID, 'session.v4.jsonl'))).toBe(true);
    expect(isDshSessionPath(path.join(SESSIONS_ROOT, '--tmp-demo--', SID))).toBe(true); // <sid>/ 目录
    expect(isDshSessionPath(SESSIONS_ROOT)).toBe(true);                 // sessions 根（两层）
    expect(isDshSessionPath(EXPORT_ROOT)).toBe(true);                   // 导出根（一层）
  });

  it('不是 DSH 的路径 / 不存在的路径判定为 false', () => {
    expect(isDshSessionPath(path.join(DATA, 'no-such-dir'))).toBe(false);
    expect(isDshSessionPath(path.resolve(__dirname, 'dsh-native.test.ts'))).toBe(false);
  });
});
