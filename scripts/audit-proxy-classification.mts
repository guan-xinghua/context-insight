// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 存量 proxy 会话分类审计/矫正：对 sourcePath 指向 proxy 捕获目录的会话，
// 用统一分类器 proxy-classify（meta > 行级 source > wire 指纹）核对
// framework/version。期望 framework 直接取分类器结果（单一权威源）——
// 不得在脚本内另建 marker→framework 映射（codex/cannbot 等新代际会漏，历史
// 上 codex 会话曾因此被整体误报 BAD）。
//   node scripts/audit-proxy-classification.mts          # 只审计，打印 BAD 列表
//   node scripts/audit-proxy-classification.mts --fix    # 对 BAD 会话跑 deltaRefreshSession 矫正
import { prisma } from '../src/lib/db';
import fs from 'node:fs';
import { classifyProxyCapture } from '../src/lib/ingest/proxy-classify';
import { deltaRefreshSession } from '../src/lib/ingest/data-service';

async function main() {
  const fix = process.argv.includes('--fix');
  const proxyDirRows = await prisma.session.findMany({
    where: { sourcePath: { contains: '/proxy/' } },
    select: { id: true, taskId: true, framework: true, version: true, sourcePath: true },
  });
  const proxyVersionRows = await prisma.session.findMany({
    where: { version: { endsWith: '-proxy' } },
    select: { id: true, taskId: true, framework: true, version: true, sourcePath: true },
  });
  const byTask = new Map<string, { id: string; taskId: string; framework: string; version: string | null; sourcePath: string | null }>();
  for (const s of [...proxyDirRows, ...proxyVersionRows]) byTask.set(s.taskId, s);
  const sessions = Array.from(byTask.values());
  const bad: string[] = [];
  for (const s of sessions) {
    const cls = fs.existsSync(s.sourcePath) ? classifyProxyCapture(s.sourcePath) : null;
    const marker = cls?.isProxy ? cls.marker : null;
    // 方案一（同 sid 双会话）：proxy 行的 framework 带 -proxy 记录后缀
    // （claude-code-proxy / opencode-proxy / …），期望值与导入侧同构
    const expectFw = cls?.isProxy && cls.framework ? `${cls.framework}-proxy` : null;
    const ok = expectFw
      ? s.framework === expectFw && (s.version ?? '').endsWith('-proxy')
      : s.version == null || !s.version.endsWith('-proxy');
    if (!ok) {
      bad.push(s.taskId);
      console.log(`BAD ${s.taskId} fw=${s.framework} v=${s.version} marker=${marker ?? 'none/file-missing'}`);
    }
  }
  console.log(`total=${sessions.length} bad=${bad.length}`);
  if (fix) {
    for (const id of bad) {
      try {
        await deltaRefreshSession(id, prisma, byTask.get(id));
        const s = await prisma.session.findFirst({ where: { taskId: id }, select: { framework: true, version: true } });
        console.log(`FIXED ${id} -> fw=${s?.framework} v=${s?.version}`);
      } catch (e) {
        console.log(`FIX-FAIL ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
