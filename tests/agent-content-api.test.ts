// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

/**
 * agent-content 路由 IT：声明恢复两级优先（system 注入 > 磁盘扫描）。
 * mock prisma + 真实 fixture（ses_fc73d17d7ffer 正常会话的 19 agentType 子代理样本）。
 */

const fakePrisma = {
  session: { findFirst: vi.fn() },
  skillEvent: { findMany: vi.fn() },
};
vi.mock('@/lib/db', () => ({ prisma: fakePrisma }));

const { GET } = await import('@/app/api/observe/session/agent-content/route');

const FIXTURE_DIR = path.resolve(__dirname, 'data/agent-md-system-recover');

// 路由读 request.nextUrl（NextRequest）——构造带 nextUrl 的最小请求对象（node 环境无 NextRequest 类）
function makeRequest(qs: string): never {
  return {
    nextUrl: new URL(`http://localhost/api/observe/session/agent-content?${qs}`),
  } as never;
}

describe('agent-content route（system 注入优先）', () => {
  beforeEach(() => {
    fakePrisma.session.findFirst.mockReset();
    fakePrisma.skillEvent.findMany.mockReset().mockResolvedValue([]);
  });

  it('正常会话：designer 缺省 source → via=system，返回运行时真身（8,606 字，剥运行时尾部）', async () => {
    fakePrisma.session.findFirst.mockResolvedValue({
      id: 'ses_cuid_1',
      taskId: 'ses_norm_fixture',
      sourcePath: path.join(FIXTURE_DIR, 'ses_norm_fixture.jsonl.gz'),
    });
    const res = await GET(makeRequest('taskId=ses_norm_fixture&agentName=designer'));
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.via).toBe('system');
    expect(d.content.startsWith('# designer')).toBe(true);
    expect(d.length).toBeGreaterThan(8000); // 真身 8,606 字（磁盘 demo 只有 4,771）
    expect(d.content).not.toContain('<available_skills>');
    expect(d.source).toMatch(/^subagent:ses_/);
  });

  it('design-task-generator / developer（此前"恢复不出来"的）同样经 system 恢复', async () => {
    fakePrisma.session.findFirst.mockResolvedValue({
      id: 'ses_cuid_1',
      taskId: 'ses_norm_fixture',
      sourcePath: path.join(FIXTURE_DIR, 'ses_norm_fixture.jsonl.gz'),
    });
    for (const name of ['design-task-generator', 'developer', 'kernel-developer']) {
      const res = await GET(makeRequest(`taskId=ses_norm_fixture&agentName=${name}`));
      const d = await res.json();
      expect(d.via).toBe(name === 'kernel-developer' ? d.via : 'system'); // 全部走 system
      expect(d.via).toBe('system');
      expect(d.content.startsWith(`# ${name}`)).toBe(true);
    }
  });

  it('source=system 显式请求 → 同上', async () => {
    fakePrisma.session.findFirst.mockResolvedValue({
      id: 'ses_cuid_1',
      taskId: 'ses_norm_fixture',
      sourcePath: path.join(FIXTURE_DIR, 'ses_norm_fixture.jsonl.gz'),
    });
    const res = await GET(makeRequest('taskId=ses_norm_fixture&agentName=verifier&source=system'));
    const d = await res.json();
    expect(d.via).toBe('system');
    expect(d.content.startsWith('# verifier')).toBe(true);
  });

  it('system 无数据（agent 名不在会话里）→ 降级磁盘扫描', async () => {
    fakePrisma.session.findFirst.mockResolvedValue({
      id: 'ses_cuid_1',
      taskId: 'ses_norm_fixture',
      sourcePath: path.join(FIXTURE_DIR, 'ses_norm_fixture.jsonl.gz'),
    });
    const res = await GET(makeRequest('taskId=ses_norm_fixture&agentName=nonexistent-agent'));
    const d = await res.json();
    // system 恢复 null（标题守卫）→ 磁盘扫描；本测试环境可能命中 skills-dev 真仓或空
    expect(d.via).not.toBe('system');
  });

  it('缺 taskId/agentName → 400', async () => {
    expect((await GET(makeRequest('agentName=x'))).status).toBe(400);
    expect((await GET(makeRequest('taskId=x'))).status).toBe(400);
  });
});
