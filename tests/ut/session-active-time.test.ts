// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话详情 Wall Clock 拆分：活跃/非活跃两口（turn 时间戳聚类，间隔 >5min
// 切段）。不变量：activeMs + inactiveMs === wallMs（两口之和恒等于墙钟）。
// 现场背景：3.66 天全自动会话里 81.9% 是非活跃（周末停摆 + 机器休眠 +
// 配额耗尽），单一 wall clock 数字掩盖了这一点。

import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../setup';
import { POST } from '@/app/api/ingest/import-file/route';

const createdSessionIds: string[] = [];

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    try { await prisma.session.delete({ where: { id } }); } catch { /* ignore */ }
  }
});

describe('GET /api/observe/session — Wall Clock 活跃/非活跃拆分', () => {
  const file = path.join(__dirname, './data/claude-sessions/active-time-it.jsonl');

  afterEach(async () => {
    try { fs.unlinkSync(file); } catch { /* */ }
  })

  it('>5min 空档切段、<5min 不断开，两口之和恒等于 wall', async () => {
    const T = (h: number, m: number, s: number) =>
      new Date(Date.UTC(2026, 8, 20, h, m, s)).toISOString()
    const line = (type: 'user' | 'assistant', ts: string, i: number) =>
      type === 'user'
        ? { type, message: { role: 'user', content: `q${i}` }, timestamp: ts }
        : { type, message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `a${i}` }], model: 'test-model' }, timestamp: ts }
    // cluster A: 10:00:00 → 10:04:20（内部 3m50s 间隙 < 5min，不切段）
    // gap: 10:04:20 → 12:00:00（1h55m40s > 5min，切段）
    // cluster B: 12:00:00 → 12:00:30
    fs.writeFileSync(file, [
      line('user', T(10, 0, 0), 0),
      line('assistant', T(10, 0, 10), 0),
      line('user', T(10, 4, 0), 1),
      line('assistant', T(10, 4, 20), 1),
      line('user', T(12, 0, 0), 2),
      line('assistant', T(12, 0, 30), 2),
    ].map(l => JSON.stringify(l)).join('\n') + '\n')

    const sid = 'active-time-it'
    await prisma.session.deleteMany({ where: { taskId: sid } })
    const res = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }))
    expect(res.status).toBe(200)
    const s = await prisma.session.findFirst({ where: { taskId: sid } })
    expect(s).not.toBeNull()
    createdSessionIds.push(s!.id)

    const { GET } = await import('@/app/api/observe/session/route')
    const apiRes = await GET(new NextRequest(`http://localhost/api/observe/session?taskId=${sid}`))
    expect(apiRes.status).toBe(200)
    const data = await apiRes.json()
    expect(data.wallMs).toBe(2 * 3600_000 + 30_000) // 10:00:00 → 12:00:30
    expect(data.activeMs).toBe(260_000 + 30_000) // A 段 10:00:00→10:04:20 + B 段 30s
    expect(data.inactiveMs).toBe(2 * 3600_000 + 30_000 - 290_000)
    expect(data.activeMs + data.inactiveMs).toBe(data.wallMs)
    expect(data.activeClusterCount).toBe(2)
  })

  it('紧邻两 turn（无空档）→ 全活跃，inactiveMs = 0', async () => {
    fs.writeFileSync(file, [
      { type: 'user', message: { role: 'user', content: 'q0' }, timestamp: new Date(Date.UTC(2026, 8, 20, 10, 0, 0)).toISOString() },
      { type: 'assistant', message: { id: 'm0', role: 'assistant', content: [{ type: 'text', text: 'a0' }], model: 'test-model' }, timestamp: new Date(Date.UTC(2026, 8, 20, 10, 0, 5)).toISOString() },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')

    const sid = 'active-time-single-it'
    await prisma.session.deleteMany({ where: { taskId: sid } })
    const res = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }))
    expect(res.status).toBe(200)
    const s = await prisma.session.findFirst({ where: { taskId: sid } })
    expect(s).not.toBeNull()
    createdSessionIds.push(s!.id)

    const { GET } = await import('@/app/api/observe/session/route')
    const apiRes = await GET(new NextRequest(`http://localhost/api/observe/session?taskId=${sid}`))
    expect(apiRes.status).toBe(200)
    const data = await apiRes.json()
    // 2 个不同时间戳 → 可计算；活跃 = 簇跨度 5s，非活跃 = 0
    expect(data.wallMs).toBe(5_000)
    expect(data.activeMs).toBe(5_000)
    expect(data.inactiveMs).toBe(0)
    expect(data.activeMs + data.inactiveMs).toBe(data.wallMs)
  })

  it('慢 API 调用（wire duration_ms > 5min）→ 调用期间计为活跃，不再被阈值切走', async () => {
    // 现场回归：全自动子代理会话（9fd46cc3）9 段 5~23min「非活跃」实际全是
    // 巨上下文单次调用在飞——间隙后的 assistant turn latencyMs ≈ 间隙时长。
    // 方案 A：assistant turn 按 [t-latencyMs, t] 展开成活跃区间再聚类。
    fs.writeFileSync(file, [
      { type: 'user', message: { role: 'user', content: 'q0' }, timestamp: new Date(Date.UTC(2026, 8, 20, 10, 0, 0)).toISOString(), source: 'claude-proxy', tools: [] },
      { type: 'assistant', message: { id: 'm0', role: 'assistant', content: [{ type: 'text', text: 'a0' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: new Date(Date.UTC(2026, 8, 20, 10, 10, 0)).toISOString(), duration_ms: 600_000, source: 'claude-proxy' },
      { type: 'user', message: { role: 'user', content: 'q1' }, timestamp: new Date(Date.UTC(2026, 8, 20, 10, 10, 5)).toISOString(), source: 'claude-proxy' },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a1' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: new Date(Date.UTC(2026, 8, 20, 10, 10, 10)).toISOString(), duration_ms: 5_000, source: 'claude-proxy' },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')

    const sid = 'active-time-slowcall-it'
    await prisma.session.deleteMany({ where: { taskId: sid } })
    const res = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }))
    expect(res.status).toBe(200)
    const s = await prisma.session.findFirst({ where: { taskId: sid } })
    expect(s).not.toBeNull()
    createdSessionIds.push(s!.id)

    const { GET } = await import('@/app/api/observe/session/route')
    const apiRes = await GET(new NextRequest(`http://localhost/api/observe/session?taskId=${sid}`))
    expect(apiRes.status).toBe(200)
    const data = await apiRes.json()
    // 10:00:00 → 10:10:10 = 610s；点聚类会把 10min 间隔切走（活跃仅 10s），
    // 区间展开后 [10:00:00,10:10:00] ∪ [10:10:05,10:10:10]（间隔 5s < 阈值合并）→ 全程活跃
    expect(data.wallMs).toBe(610_000)
    expect(data.activeMs).toBe(610_000)
    expect(data.inactiveMs).toBe(0)
    expect(data.activeMs + data.inactiveMs).toBe(data.wallMs)
  })
})
