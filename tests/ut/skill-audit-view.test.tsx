// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

/**
 * AuditReportView 测试。无 @testing-library/react：纯函数（sort/filter/group/counts）
 * 直接测；叶子组件（Badge-only，不依赖 base-ui）用 renderToStaticMarkup 断言关键文本。
 * AuditReportView 组合由 typecheck + 手动验（同 compare-perf/render-smoke 模式）。
 */
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import sample from "./data/audit-report-sample.json"
import multi from "./data/audit-report-multi.json"
import covReport from "./data/audit-report-coverage.json"
import type { AuditFinding, AuditReport, SkillAuditStoredResult } from "@/lib/sift-audit-types"
import {
  ALL_VERDICTS,
  CATEGORY_LABEL,
  filterFindings,
  groupFindingsByInstruction,
  groupFindingsByVerdict,
  hasNonPass,
  isMultiTranscript,
  LAYER_BADGE,
  matchFindingLayers,
  METHOD_TAG,
  sortFindings,
  VERDICT_DISPLAY,
  EMPTY_FILTER,
} from "@/components/observe/skill-audit/verdictConfig"
import { verdictCounts } from "@/components/observe/skill-audit/FindingFilters"
import { FindingCard } from "@/components/observe/skill-audit/FindingCard"

const SAMPLE = sample as unknown as AuditReport
const MULTI = multi as unknown as AuditReport
const FAIL = SAMPLE.findings[0]
const PASS = SAMPLE.findings[2]

describe("verdictConfig 纯函数", () => {
  it("VERDICT_DISPLAY/METHOD_TAG/CATEGORY_LABEL 覆盖全枚举值", () => {
    for (const v of ALL_VERDICTS) expect(VERDICT_DISPLAY[v].label).toBeTruthy()
    expect(METHOD_TAG.PROGRAMMATIC.label).toBe("程序")
    expect(METHOD_TAG.LLM.label).toBe("LLM")
    expect(CATEGORY_LABEL.step).toBe("步骤")
    expect(CATEGORY_LABEL.output).toBe("输出")
  })

  it("sortFindings: FAIL 最前，PASS 最后（稳定）", () => {
    const shuffled = [PASS, FAIL, SAMPLE.findings[4], SAMPLE.findings[1]]
    const sorted = sortFindings(shuffled)
    expect(sorted[0].verdict).toBe("FAIL")
    expect(sorted[sorted.length - 1].verdict).toBe("PASS")
  })

  it("filterFindings: 空 filter 全显", () => {
    expect(filterFindings(SAMPLE.findings, EMPTY_FILTER).length).toBe(SAMPLE.findings.length)
  })

  it("filterFindings: 按 verdict 集合过滤（点掉 PASS → 只留非 PASS）", () => {
    const onlyFail = filterFindings(SAMPLE.findings, {
      ...EMPTY_FILTER,
      verdicts: new Set(["FAIL", "UNRESOLVED", "N/A"]),
    })
    expect(onlyFail.every((f) => f.verdict !== "PASS")).toBe(true)
    expect(onlyFail.length).toBe(4)
  })

  it("filterFindings: 按 category 过滤", () => {
    const steps = filterFindings(SAMPLE.findings, { ...EMPTY_FILTER, categories: new Set(["step"]) })
    expect(steps.every((f) => f.category === "step")).toBe(true)
    expect(steps.length).toBe(2)
  })

  it("filterFindings: 按 method 过滤（只程序对账）", () => {
    const prog = filterFindings(SAMPLE.findings, { ...EMPTY_FILTER, method: "PROGRAMMATIC" })
    expect(prog.every((f) => f.method === "PROGRAMMATIC")).toBe(true)
    expect(prog.length).toBe(2)
  })

  it("filterFindings: 文本搜指令/证据（不区分大小写）", () => {
    const r = filterFindings(SAMPLE.findings, { ...EMPTY_FILTER, text: "tool_trace" })
    expect(r.length).toBe(1)
    expect(r[0].seq).toBe(3)
  })

  it("filterFindings: 多维度叠加", () => {
    const r = filterFindings(SAMPLE.findings, {
      ...EMPTY_FILTER,
      verdicts: new Set(["FAIL"]),
      categories: new Set(["prohibition"]),
    })
    expect(r.length).toBe(1)
    expect(r[0].seq).toBe(2)
  })

  it("verdictCounts: 全枚举键 + 计数正确", () => {
    const c = verdictCounts(SAMPLE.findings as AuditFinding[])
    expect(c.FAIL).toBe(2)
    expect(c.PASS).toBe(2)
    expect(c["N/A"]).toBe(1)
    expect(c.UNRESOLVED).toBe(1)
    expect(c.INDETERMINATE).toBe(0)
  })

  it("groupFindingsByInstruction: 同指令聚合 + 组内 FAIL 优先", () => {
    const groups = groupFindingsByInstruction(MULTI.findings as AuditFinding[])
    expect(groups.length).toBe(2)
    const g = groups[0]
    expect(g.findings.length).toBe(2)
    expect(g.findings[0].verdict).toBe("FAIL")
    expect(g.findings[1].verdict).toBe("PASS")
  })

  it("groupFindingsByVerdict: 按 verdict 分组(FAIL 在前 / PASS 在末),跳空组,总数守恒", () => {
    const groups = groupFindingsByVerdict(SAMPLE.findings as AuditFinding[])
    expect(groups.length).toBeGreaterThan(1)
    // 无空组
    expect(groups.every((g) => g.findings.length > 0)).toBe(true)
    // 顺序由 VERDICT_ORDER 决定:首组 FAIL(问题在前)、末组 PASS
    expect(groups[0].verdict).toBe("FAIL")
    expect(groups[groups.length - 1].verdict).toBe("PASS")
    // 组内 verdict 一致
    expect(groups.every((g) => g.findings.every((f) => f.verdict === g.verdict))).toBe(true)
    // 总数守恒(所有 finding 都进组,无丢)
    expect(groups.reduce((n, g) => n + g.findings.length, 0)).toBe(SAMPLE.findings.length)
  })

  it("isMultiTranscript / hasNonPass", () => {
    expect(isMultiTranscript(MULTI.transcripts)).toBe(true)
    expect(isMultiTranscript(SAMPLE.transcripts)).toBe(false)
    expect(hasNonPass(MULTI.findings as AuditFinding[])).toBe(true)
    expect(hasNonPass([{ ...PASS } as AuditFinding])).toBe(false)
  })
})

describe("matchFindingLayers（root 组合声明归层）", () => {
  const layers = [
    { kind: "regulation" as const, label: "编排规程", source: "task-prompts.md", content: "每次派发前必须读取 STATE.md 并检查依赖状态。不要自己写代码。" },
    { kind: "plan" as const, label: "任务计划", source: "STATE.md", content: "- [ ] 1. 派发 developer 完成目录创建\n- [ ] 2. 派发 st-verifier 验收" },
  ]

  it("instruction_text 命中规程层正文 → 归规程层", () => {
    const m = matchFindingLayers({ instruction_text: "每次派发前必须读取 STATE.md 并检查依赖状态。", source_excerpt: undefined }, layers)
    expect(m).toHaveLength(1)
    expect(m[0].kind).toBe("regulation")
  })

  it("source_excerpt 兜底匹配（instruction_text 被 extractor 改写时）", () => {
    const m = matchFindingLayers({ instruction_text: "派发 developer", source_excerpt: "- [ ] 1. 派发 developer 完成目录创建" }, layers)
    expect(m.some((l) => l.kind === "plan")).toBe(true)
  })

  it("空白漂移容忍（压空白 + 小写后子串匹配）", () => {
    const m = matchFindingLayers({ instruction_text: "每次派发前  必须\n读取 STATE.md 并检查依赖状态。", source_excerpt: undefined }, layers)
    expect(m).toHaveLength(1)
    expect(m[0].kind).toBe("regulation")
  })

  it("同文命中多层 → 返回多层（双徽章）", () => {
    const both = [{ ...layers[0], content: "必须先验收再合并" }, { ...layers[1], content: "必须先验收再合并" }]
    expect(matchFindingLayers({ instruction_text: "必须先验收再合并", source_excerpt: undefined }, both)).toHaveLength(2)
  })

  it("匹配不上 / 无 layers / 空指令 → 空数组（不打徽章）", () => {
    expect(matchFindingLayers({ instruction_text: "不存在的指令", source_excerpt: undefined }, layers)).toHaveLength(0)
    expect(matchFindingLayers({ instruction_text: "x", source_excerpt: undefined }, undefined)).toHaveLength(0)
    expect(matchFindingLayers({ instruction_text: "", source_excerpt: undefined }, layers)).toHaveLength(0)
  })

  it("LAYER_BADGE 覆盖两层枚举", () => {
    expect(LAYER_BADGE.regulation.hint).toContain("编排纪律")
    expect(LAYER_BADGE.plan.hint).toContain("任务承诺")
  })
})

describe("FindingCard render smoke", () => {
  it("FAIL finding 渲染 verdict 徽章 + №seq + 指令 + 证据 + transcript + noise + related 跳转按钮", () => {
    const html = renderToStaticMarkup(createElement(FindingCard, { f: FAIL as AuditFinding }))
    expect(html).toContain("✗")
    expect(html).toContain("失败")
    expect(html).toContain("№1")
    expect(html).toContain("改动前必须先读相关源码")
    expect(html).toContain("未先 Read")
    expect(html).toContain("ses_cuid_abc")
    expect(html).toContain("疑似工具噪声")
    expect(html).toContain("↔ 同源")
    expect(html).toContain("№9") // related 按钮（finding 序号，用 № 不用 #）
    expect(html).toContain("LLM") // method
  })

  it("有 turn_refs + onJumpToTurn 时 №seq 渲染为可点击 button（跳 turn_refs[0]）", () => {
    // FAIL finding (seq=1, step) has turn_refs: [2]
    const html = renderToStaticMarkup(
      createElement(FindingCard, { f: FAIL as AuditFinding, onJumpToTurn: () => {} }),
    )
    // №seq 是 button（含 onClick），title 提示跳转（turn 用 #）
    expect(html).toContain("№1")
    expect(html).toContain("跳转到 turn #2")
    // 不再有独立 turn chips 段
    expect(html).not.toContain(">turn<")
  })

  it("turn_refs 多个时 title 列出全部 turn（seq=2 有 turn_refs: [5, 6]）", () => {
    const f2 = SAMPLE.findings[1] as AuditFinding
    const html = renderToStaticMarkup(
      createElement(FindingCard, { f: f2, onJumpToTurn: () => {} }),
    )
    expect(html).toContain("№2")
    expect(html).toContain("共 2 个")
    expect(html).toContain("#5") // turn 序号用 #
    expect(html).toContain("#6")
  })

  it("有 turn_refs 但无 onJumpToTurn 时 №seq 不可点击（灰显 span）", () => {
    const html = renderToStaticMarkup(createElement(FindingCard, { f: FAIL as AuditFinding }))
    expect(html).toContain("№1")
    // 是 span 不是 button
    expect(html).not.toContain("跳转到 turn")
  })

  it("无 turn_refs 的 finding №seq 不可点击（conditional PASS）", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { f: PASS as AuditFinding, onJumpToTurn: () => {} }),
    )
    expect(html).toContain("№3")
    expect(html).not.toContain("跳转到 turn")
  })

  it("N/A finding 渲染场景不触发 hint", () => {
    const na = SAMPLE.findings[4] as AuditFinding
    const html = renderToStaticMarkup(createElement(FindingCard, { f: na }))
    expect(html).toContain("不适用")
    expect(html).toContain("场景不触发")
  })

  it("PASS finding 渲染程序 method 标签", () => {
    const html = renderToStaticMarkup(createElement(FindingCard, { f: PASS as AuditFinding }))
    expect(html).toContain("✓")
    expect(html).toContain("通过")
    expect(html).toContain("程序")
  })

  it("root 组合声明：layers 传入且指令命中层正文 → 渲染归层徽章（规程/计划）", () => {
    const layers = [
      // FAIL (seq=1) 的 instruction_text = "改动前必须先读相关源码再动手" → 命中规程层
      { kind: "regulation" as const, label: "编排规程", source: "task-prompts.md", content: "改动前必须先读相关源码再动手。" },
      { kind: "plan" as const, label: "任务计划", source: "STATE.md", content: "- [ ] 1. 派发 developer 完成开发" },
    ]
    const html = renderToStaticMarkup(
      createElement(FindingCard, { f: FAIL as AuditFinding, layers }),
    )
    expect(html).toContain("编排规程")
    expect(html).not.toContain("任务计划")
  })

  it("root 组合声明：指令不命中任何层 → 不渲染徽章", () => {
    const layers = [
      { kind: "regulation" as const, label: "编排规程", source: "task-prompts.md", content: "无关内容" },
    ]
    const html = renderToStaticMarkup(
      createElement(FindingCard, { f: FAIL as AuditFinding, layers }),
    )
    expect(html).not.toContain("编排规程")
  })
})

describe("AuditReportView render smoke (base-ui 组合)", () => {
  // base-ui Button/Checkbox/Input 在 renderToStaticMarkup 下应产出 markup（SSR 兼容）。
  // verdict 计数已并入 FindingFilters 过滤条（每 toggle 带计数），不再有独立 AuditSummary 行。
  it("渲染 skill_name + warnings + findings + 图例 + 计数行（含 refine 折叠）", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const result = { ...SAMPLE, findings: SAMPLE.findings as AuditFinding[] } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).toContain("opdef-developer")
    expect(html).toContain("缺少 assistant 收尾 turn")
    expect(html).toContain("改动前必须先读相关源码")
    expect(html).toContain("判定图例")
    expect(html).toContain("显示")
    expect(html).toContain("refine 砍 3 伪指令")
  })

  it("无 _html 时不渲染逃生口链接", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const result = { ...SAMPLE, findings: SAMPLE.findings as AuditFinding[] } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).not.toContain("原始 HTML")
  })

  it("多 transcript 渲染 by_instruction 表 + 按指令分组", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const result = { ...MULTI, findings: MULTI.findings as AuditFinding[] } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).toContain("违规 FAIL")
    expect(html).toContain("跨 2 transcript")
    expect(html).toContain("fail%")
    expect(html).toContain("待确认")
  })

  it("单 transcript 也渲染 by_instruction 概要表(去跨会话列 fail%/in transcripts,标题不带「跨」)", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    // SAMPLE 单 transcript、原 by_instruction 空 → 注入 1 fail 行 + 1 na 行
    const result = {
      ...SAMPLE,
      findings: SAMPLE.findings as AuditFinding[],
      by_instruction: [
        { instruction_text: "改动前必须先读相关源码", source: "CONSTRAINT", category: "prohibition",
          pass_count: 0, fail_count: 1, na_count: 0, total: 1, fail_rate: 1.0,
          fail_in_transcripts: ["ses_cuid_abc"], fail_seqs: [1],
          noise_label: "uncertain", noise_reasons: ["r"] },
        { instruction_text: "Use ref: x.md", source: "REFERENCE_USAGE", category: "conditional",
          pass_count: 0, fail_count: 0, na_count: 1, total: 1, fail_rate: 0.0,
          fail_in_transcripts: [], na_in_transcripts: ["ses_cuid_abc"], na_seqs: [4] },
      ],
    } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).toContain("违规 FAIL")
    expect(html).toContain("场景不适用 N/A")
    // 单 transcript 精简:标题不带「跨 N transcript」、无跨会话列
    expect(html).not.toContain("（跨 ")
    expect(html).not.toContain("fail%")
    expect(html).not.toContain("fail/total")
    expect(html).not.toContain("in transcripts")
  })
})

describe("声明覆盖视图（CoverageView · 声明 vs 实际触达——旧报告回退路径）", () => {
  it("渲染总比率 + 三态计数 + 进度条 + 分节明细（未触发/未知行、全覆盖节、其余已覆盖）", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const covSample = covReport as unknown as AuditReport
    const result = {
      ...covSample,
      // 剥掉 text_coverage：走旧报告回退路径（无原文投影数据时保持 CoverageView 指令视角）
      text_coverage: undefined,
      findings: covSample.findings as AuditFinding[],
    } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).toContain("声明覆盖")
    expect(html.indexOf("声明覆盖")).toBeLessThan(html.indexOf("opdef-developer"))
    expect(html).toContain("3/6")
    expect(html).toContain("（50%）")
    expect(html).toContain("未覆盖")
    expect(html).toContain("未知")
    expect(html).toContain("已覆盖")
    expect(html).toContain("width:50%")
    expect(html).toContain("验收标准")
    expect(html).toContain("1/3")
    expect(html).toContain("每个算子必须提供单测用例")
    expect(html).toContain("提交前跑全量回归门禁")
    expect(html).toContain("其余 1 条已覆盖")
    expect(html).toContain("二、任务计划")
    expect(html).toContain("全部声明已覆盖")
    expect(html).toContain("#3")
  })

  it("组合声明（legacy 路径）：未触发指令命中规程层 → CoverageView 指令行打层徽章", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const covSample = covReport as unknown as AuditReport
    const result = {
      ...covSample,
      // 剥掉 text_coverage：走 CoverageView 回退路径（总览的归层由总览 describe 单独锁）
      text_coverage: undefined,
      findings: covSample.findings as AuditFinding[],
      _layers: [
        {
          kind: "regulation",
          label: "编排规程",
          source: "turn0 (注入编排规程)",
          content: "## 编排纪律\n关键节点必须向用户确认后方可继续；改动前必须先读相关源码。",
        },
        {
          kind: "plan",
          label: "任务计划",
          source: "STATE.md",
          content: "- [ ] 完成 AdaptivePoolMax 算子开发",
        },
      ],
    } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).toContain("关键节点必须向用户确认")
    expect(html).toContain("编排规程")
    expect(html).toContain("规程层：编排纪律")
    expect(html).toContain("（来源：turn0 (注入编排规程)）")
  })

  it("旧报告（无 coverage 字段）→ 不渲染覆盖视图", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const result = { ...SAMPLE, findings: SAMPLE.findings as AuditFinding[] } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).not.toContain("声明覆盖")
  })
})

describe("声明覆盖总览（DeclarationCoverageOverview · 原文快照 + 文本着色）", () => {
  it("整篇原文呈现（间隙/代码围栏原样保留）+ 三色直接涂在文本上 + 双指标 + hover 指令摘要", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const covSample = covReport as unknown as AuditReport
    const result = {
      ...covSample,
      findings: covSample.findings as AuditFinding[],
    } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).toContain("声明覆盖总览")
    expect(html).toContain("原文声明快照")
    // 单一区块：不再渲染原 CoverageView 分节明细（两块合一）
    expect(html).not.toContain("其余 1 条已覆盖")
    expect(html).not.toContain("全部声明已覆盖")
    // 头部双指标：指令覆盖 3/6（50%，未覆盖 2 · 未知 1）+ 可评文本覆盖 3/6（50%）+ 建模完整度 6/8（75%）+ 未建模 2
    expect(html).toContain("指令覆盖")
    expect(html).toContain("3/6")
    expect(html).toContain("（50%）")
    expect(html).toContain("未覆盖")
    expect(html).toContain("未知")
    expect(html).toContain("可评文本覆盖")
    expect(html).toContain("6/8")
    expect(html).toContain("（75%）")
    // 三色图例
    expect(html).toContain("绿 已触达")
    expect(html).toContain("黄 未验证")
    expect(html).toContain("灰 未建模")
    // 原文快照逐字呈现：bullet 原文、说明文字、代码块围栏（``` 只存在于 skill_body 间隙——
    // 间隙原样保留是「原文」语义的回归锁）
    expect(html).toContain("- 关键节点必须向用户确认")
    expect(html).toContain("- 提交前跑全量回归门禁")
    expect(html).toContain("以上规则如有疑问,先与维护者确认再行动。")
    expect(html).toContain("状态:✅完成/❌未完成")
    expect(html).toContain("```")
    // 颜色直接涂在文本上（三个状态 class 都出现）
    expect(html).toContain("bg-emerald-500/15")
    expect(html).toContain("bg-amber-500/20")
    expect(html).toContain("bg-muted/60")
    // hover 摘要：色块 title 带该段指令逐条（covered 段的指令也在 title 里）
    expect(html).toContain("title=")
    expect(html).toContain("改动前必须先读相关源码")
    // 无内联明细行污染原文：verdict 证据只出现在下方 findings 表（header 之后），不在总览快照里
    expect(html.indexOf("turn 3 直接改了 pool.py")).toBeGreaterThan(html.indexOf("opdef-developer 工作流"))
    // unmapped 折叠行（诚实计数不静默吞）
    expect(html).toContain("另有 1 条指令未落回原文")
    expect(html).toContain("Consult reference material (2 alternative category references)")
  })

  it("组合声明：hover 摘要带 root 归层（指令命中规程层 → title 含「编排规程」）", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const covSample = covReport as unknown as AuditReport
    const result = {
      ...covSample,
      findings: covSample.findings as AuditFinding[],
      _layers: [
        {
          kind: "regulation" as const,
          label: "编排规程",
          source: "turn0 (注入编排规程)",
          content: "关键节点必须向用户确认后方可继续。",
        },
      ],
    } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).toContain("声明覆盖总览")
    expect(html).toContain("（编排规程）")
  })

  it("旧报告（无 text_coverage / skill_body 字段）→ 回退 CoverageView，不渲染总览", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const result = { ...SAMPLE, findings: SAMPLE.findings as AuditFinding[] } as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).not.toContain("声明覆盖总览")
    expect(html).not.toContain("可评文本覆盖")
  })

  it("total_units=0 的空 text_coverage → 不误显总览（回退 CoverageView 指令视角）", async () => {
    const { AuditReportView } = await import("@/components/observe/skill-audit/AuditReportView")
    const covSample = covReport as unknown as AuditReport
    const result = {
      ...covSample,
      text_coverage: { total_units: 0, covered: 0, uncovered: 0, unmodeled: 0, coverage_rate: 0, modeled_ratio: 0, units: [] },
      findings: covSample.findings as AuditFinding[],
    } as unknown as SkillAuditStoredResult
    const html = renderToStaticMarkup(createElement(AuditReportView, { result }))
    expect(html).not.toContain("声明覆盖总览")
    expect(html).toContain("声明覆盖")
  })
})
