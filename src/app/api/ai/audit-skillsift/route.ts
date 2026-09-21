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
import {
  recoverSkillBody,
  recoverCombinedWorkflowDeclaration,
  buildAuditArgs,
  buildStructuredRecords,
  buildTranscriptArgs,
} from "@/lib/sift-audit"
import { llmExtractWorkflowDeclaration } from "@/lib/llm-workflow-extract"
import { makeStreamingAuditResponse } from "@/lib/sift-runner"
import { ensureWorkflowExtractPluginLoaded } from "@/lib/workflow-extract-config"
import type { AuditLayerInfo } from "@/lib/sift-audit-types"

/**
 * 对当前 session 的某个 skill 跑 sift 对账（审"真实执行 vs SKILL.md 声明"）。
 *
 * 数据流：taskId → 解出 session.id + sourcePath(opencode .db) → 恢复该 skill 正文
 * （invoke ToolCall.resultJson 的 <skill_content>）→ 物化临时 SKILL.md →
 * `sift audit <tmp> --db <sourcePath> --session <taskId> -o <out>` → 读 audit-report.json。
 *
 * sift 自带 LLM（走它自己的 claude CLI，注入 529 绕过 env），所以这里不透传 provider。
 * 输出读文件不读 stdout（--format json 的 stdout 被 rich 折行 + 尾行污染）。
 */
export async function POST(req: Request) {
  // 激活部署根的 workflow-extract-plugins.json（server-only fs 加载；幂等，进程内一次）
  ensureWorkflowExtractPluginLoaded()
  const { taskId, skillName, kind, framework, extract } = await req.json()
  if (!taskId) {
    return NextResponse.json({ error: "Missing taskId" }, { status: 400 })
  }
  // kind: "skill"(默认)| "root"(审顶层主 agent 编排 vs 组合声明)。组合声明 = 规程层(编排规程) +
  //        计划层(STATE.md 等任务计划) 分层拼接，一次对账同时审"编排纪律"与"任务完成度"。
  //        "llm-root" = root + 用 LLM（claude CLI）从 session 行为提取编排规程。
  // root 的声明按 recoverCombinedWorkflowDeclaration 恢复（skillName 被忽略）；
  // extract: "llm" → 同 llm-root（兼容直接传 extract 参数）。
  const auditKind: "skill" | "root" = kind === "root" || kind === "llm-root" ? "root" : "skill"
  const useLlmExtract = kind === "llm-root" || extract === "llm"
  // skill 路需 skillName（恢复该 skill 正文）；root 路不用 skillName（声明组合恢复）。
  if (auditKind !== "root" && !skillName) {
    return NextResponse.json({ error: "Missing skillName" }, { status: 400 })
  }

  const session = await prisma.session.findFirst({
    where: { taskId, ...(framework ? { framework } : {}) },
  })
  if (!session?.sourcePath) {
    return NextResponse.json(
      { error: "该 session 无 sourcePath（非从 .db 导入？sift --db 需要 .db）" },
      { status: 404 },
    )
  }

  let body: string | null = null
  // root 组合声明的层信息（规程/计划），随 result 事件回传前端做 finding 归层徽章。
  // llm-root 与确定性 root 共享装配（assembleCombinedDeclaration）→ 都有层信息。
  let rootLayers: AuditLayerInfo[] | undefined
  if (auditKind === "root") {
    if (useLlmExtract) {
      try {
        const llmDecl = await llmExtractWorkflowDeclaration(session.id, prisma)
        body = llmDecl?.content ?? null
        rootLayers = llmDecl?.layers
      } catch (e) {
        // CLI 基础设施失败（认证 403 / 非 0 退出 / 超时）→ 带具体原因返回，不再吞成笼统 404
        return NextResponse.json(
          { error: `LLM 提取失败：${e instanceof Error ? e.message : String(e)}` },
          { status: 502 },
        )
      }
    } else {
      const combined = await recoverCombinedWorkflowDeclaration(session.id, prisma)
      body = combined?.content ?? null
      rootLayers = combined?.layers
    }
  } else {
    body = await recoverSkillBody(session.id, skillName, prisma)
  }
  if (!body) {
    return NextResponse.json(
      auditKind === "root"
        ? { error: useLlmExtract
          ? "LLM 提取无输出（无候选/选择无效）"
          : "此 session 无可对账的 workflow 声明（规程层：无主 agent Skill invoke / 无 skill resources / 无 SKILL.md body / 无 turn0 注入；计划层：无 STATE.md 等计划文件的 Read）" }
        : { error: `在此 session 恢复不到 skill "${skillName}" 的正文（无 invoke 事件 / resultJson）` },
      { status: 404 },
    )
  }

  const skillTmp = fs.mkdtempSync(path.join(os.tmpdir(), "sift-audit-"))
  try {
    const safeName = auditKind === "root"
      ? (useLlmExtract ? "llm-workflow" : "main-agent-workflow")
      : String(skillName).replace(/[^a-zA-Z0-9._-]/g, "_")
    const skillPath = path.join(skillTmp, safeName)
    fs.mkdirSync(skillPath, { recursive: true })
    // 恢复的正文无 YAML frontmatter，而 sift 的 parse_skill_md 要 `---\nname:` 才能
    // 得名（--kind skill 切段用它匹配 transcript 里 input.skill；--kind root 不按 name 切、
    // name 无意义，但 parse_skill_md 仍需 frontmatter 才解析指令）。注入：root 用固定名，
    // skill 用真实 skillName（与 transcript input.skill 对得上）。
    const declName = auditKind === "root" ? "main-agent-workflow" : skillName
    fs.writeFileSync(
      path.join(skillPath, "SKILL.md"),
      `---\nname: ${declName}\ndescription: recovered from session\n---\n${body}\n`,
    )

    const outputDir = path.join(skillTmp, "out")
    fs.mkdirSync(outputDir, { recursive: true })

    // 喂法按 sourcePath 形态分流（framework 与捕获格式正交，见 session-format.ts）：
    // .db → --db（直读 opencode 原生 sessions.db）；
    // .jsonl / .jsonl.7z / .jsonl.gz（proxy 捕获、cannbay 导入的 insight-export 再导出）→
    //   --transcript（结构化 records JSON）——framework=opencode 但 sourcePath 是
    //   jsonl 的会话走 --db 会被 sift 当 sqlite 打开直接 OpencodeDbError。
    const useTranscript = !/\.db$/i.test(session.sourcePath ?? "")
    let args: string[]
    if (useTranscript) {
      const transcriptPath = path.join(skillTmp, "session.json")
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify(await buildStructuredRecords(session.id, prisma)),
      )
      args = buildTranscriptArgs({ skillPath, transcriptPath, outputDir, kind: auditKind })
    } else {
      args = buildAuditArgs({
        skillPath,
        dbPath: session.sourcePath,
        sessionId: taskId,
        outputDir,
        kind: auditKind,
      })
    }

    // 流式 NDJSON：spawn sift，stdout 解析进度回传 progress 事件，结束回传 result/error。
    // root 组合声明把层信息（规程/计划）随 result 事件回传（前端 finding 归层徽章）。
    // tmp 清理放进流的 finally（等 sift 跑完），不能在路由 return 时删。
    return makeStreamingAuditResponse(args, outputDir, () =>
      fs.rmSync(skillTmp, { recursive: true, force: true }),
    { _layers: rootLayers })
  } catch (e) {
    fs.rmSync(skillTmp, { recursive: true, force: true })
    return NextResponse.json(
      { error: `准备 skill 对账失败：${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
}
