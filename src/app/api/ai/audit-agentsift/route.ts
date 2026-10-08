// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextResponse } from "next/server"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { prisma } from "@/lib/db"
import { buildStructuredRecords, buildTranscriptArgs } from "@/lib/sift-audit"
import { resolveScanRoot, scanAgentDirs, resolveAgentMd } from "@/lib/agent-md-scan"
import { recoverAgentMdFromSystem } from "@/lib/agent-md-session-recover"
import { makeStreamingAuditResponse } from "@/lib/sift-runner"
import { logError } from "@/lib/logger"

/**
 * 对当前 session 的某个被 dispatch 的 agent 跑 sift 对账（审"真实执行 vs agent .md 声明"）。
 *
 * 声明恢复两级（与 agent-content 全文展示同链路，保证审的 = 看的）：
 * 1. **system 注入**（主路径）：proxy 捕获的子代理 jsonl 顶层 system 字段 = 运行时
 *    注入的 agent .md 正文（显式 agent 派发形态，正常会话 88/88 覆盖）。运行时
 *    真正生效的那份——远端机器当时的版本、多插件同名天然无歧义。不依赖子代理
 *    Read 过该文件。物化临时 .md 并注入 frontmatter `name: <agentName>`（sift
 *    parse_skill_md 需 frontmatter；--kind agent 拿 name 当切片 target 匹配
 *    records.agent=角色名）。
 * 2. **磁盘扫描**（兜底）：AGENTS_SCAN_ROOT 下 agents/ 目录（多插件按 session 覆盖率
 *    消歧）——适用于会话内无该 agent 声明数据的形态（opencode 工作流派发 general）。
 *
 * session 侧走结构化 records（--transcript），sift 切片器按 agent 归属切段（--kind agent）。
 * sift 自带 LLM（claude -p），不透传 provider。
 */
const AGENT_NAME_RE = /^[A-Za-z0-9._-]+$/

export async function POST(req: Request) {
  const { taskId, agentName, framework } = await req.json()
  if (!taskId || !agentName) {
    return NextResponse.json({ error: "Missing taskId or agentName" }, { status: 400 })
  }
  if (!AGENT_NAME_RE.test(String(agentName))) {
    return NextResponse.json(
      { error: `非法 agentName "${agentName}"（仅允许字母/数字/._-）` },
      { status: 400 },
    )
  }

  const session = await prisma.session.findFirst({
    where: { taskId, ...(framework ? { framework } : {}) },
  })
  if (!session) {
    return NextResponse.json({ error: `找不到 taskId=${taskId} 的 session` }, { status: 404 })
  }

  // ── 声明两级恢复（system 注入 > 磁盘扫描）──
  // ① system 注入：proxy 捕获子代理 jsonl 的运行时 system prompt（正常形态主路径）
  const viaSystem = session.sourcePath
    ? recoverAgentMdFromSystem(session.sourcePath, session.taskId, String(agentName))
    : null

  // ② 磁盘扫描兜底（会话内无该 agent 的 system 注入时）
  let diskMdPath: string | null = null
  if (!viaSystem) {
    const scanRoot = resolveScanRoot()
    if (!scanRoot) {
      return NextResponse.json(
        { error: "本会话子代理 system 无该 agent 的声明注入，且未配 AGENTS_SCAN_ROOT 且自动探测 skills-dev 根失败。配置扫描根可启用磁盘兜底。" },
        { status: 503 },
      )
    }
    // 本 session 被派发的 agent 名集合（用于多插件覆盖率消歧）
    const bridges = await prisma.interactionBridge.findMany({
      where: { sessionId: session.id },
      select: { subagentName: true, subagentType: true },
    })
    const sessionAgentNames = new Set<string>()
    for (const b of bridges) {
      const n = b.subagentName ?? b.subagentType
      if (n) sessionAgentNames.add(n)
    }
    const dirs = scanAgentDirs(scanRoot)
    const resolved = resolveAgentMd(String(agentName), dirs, sessionAgentNames)
    if (!resolved) {
      return NextResponse.json(
        { error: `本会话子代理 system 无该 agent 的声明注入，且扫描根下找不到 agent "${agentName}" 的 .md（扫描了 ${dirs.length} 个 agents/ 目录）。` },
        { status: 404 },
      )
    }
    diskMdPath = resolved.mdPath
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sift-agent-audit-"))
  try {
    const transcriptPath = path.join(tmp, "session.json")
    fs.writeFileSync(transcriptPath, JSON.stringify(await buildStructuredRecords(session.id, prisma)))

    const outputDir = path.join(tmp, "out")
    fs.mkdirSync(outputDir, { recursive: true })
    // 声明路径：system 源物化临时 .md + 注入 frontmatter name（sift parse_skill_md 要
    // frontmatter 才解析指令；--kind agent 拿 name 当切片 target 匹配 records.agent=角色名）。
    // 磁盘源直传原文件（自带 frontmatter）。
    let skillPath: string
    if (viaSystem) {
      skillPath = path.join(tmp, "agent.md")
      fs.writeFileSync(skillPath, `---\nname: ${agentName}\ndescription: recovered from session system injection\n---\n${viaSystem.content}\n`)
    } else {
      skillPath = diskMdPath!
    }
    const args = buildTranscriptArgs({ skillPath, transcriptPath, outputDir, kind: "agent" })

    // 流式 NDJSON：spawn sift，stdout 解析进度回传 progress 事件，结束回传 result/error。
    // tmp 清理放进流的 finally（等 sift 跑完），不能在路由 return 时删。
    return makeStreamingAuditResponse(args, outputDir, () =>
      fs.rmSync(tmp, { recursive: true, force: true }),
    )
  } catch (e) {
    logError("route:ai/audit-agentsift", "准备 agent 对账失败", { error: e instanceof Error ? e.message : String(e) })
    fs.rmSync(tmp, { recursive: true, force: true })
    return NextResponse.json(
      { error: `准备 agent 对账失败：${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
}
