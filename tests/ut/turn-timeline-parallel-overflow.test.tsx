// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

/**
 * TurnTimeline 并行派发 lane 展示 IT。
 *
 * 演进：最初并行 lanes 用 grid 2/3 列并排展开——窄列被 turn 行（#N + role badge +
 * "1 tools" + token 数）的最小内容宽撑破（grid 子项默认 min-width:auto），横向
 * 溢出覆盖相邻内容；items-start 修掉框内拉伸后又暴露并排固有的短侧留白（grid
 * 行高取最高者，矮 lane 下方到行底必然空白）。继而改为「紧凑 chip 行 + 展开区
 * 全宽堆叠」，但又引入体验问题：所有展开 lane 统一渲染在整个 chip 行末尾，
 * 点第一个 chip 详情跑到最后一个 chip 下方（用户现场：三路并行点 empty，
 * 展开区出现在 base 下面）。最终形态：**并行组 = 紧凑 chip 行 + 就地展开**——
 * 展开 lane 紧贴自己的 chip 下方全宽渲染（wrapper basis-full 独占一行），
 * 多个 lane 可同时展开。
 *
 * 断言（happy-dom 无布局引擎，锁结构防回归）：
 *   ① 并行组渲染：⇄ 标识 + 汇总统计 + 两个 agent chip
 *   ② 不再使用多列 grid 并排（grid-cols-2/3 不应出现）
 *   ③ chip 行 flex-wrap、组根 min-w-0（窄容器不撑破）
 *   ④ 展开的 lane 全宽渲染，turn 行卫生（min-w-0/flex-wrap/shrink-0）
 *   ⑤ 点击第一个 chip：lane 内容在 DOM 顺序上先于后续 chip（就地展开）
 */
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { TurnTimeline, SubagentLaneView, ParallelSubagentGroup } from "@/components/observe/TurnTimeline"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeTurn(turnIndex: number, overrides: Record<string, unknown> = {}) {
  return {
    turnId: `t-${turnIndex}`,
    turnIndex,
    role: "assistant",
    contentSummary: `turn ${turnIndex}`,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    parentExecutionId: null,
    totalTokens: 100 * turnIndex,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
    createdAt: null,
    completedAt: null,
    model: null,
    toolCalls: [],
    skillEvents: [],
    ...overrides,
  }
}

function makeBridge(bridgeId: string, dispatchTurnId: string, sessionId: string, agentName: string) {
  return {
    bridgeId,
    dispatchTurnId,
    dispatchContent: `dispatch ${agentName}`,
    subagentSessionId: sessionId,
    subagentType: "general",
    subagentName: agentName,
    agentName,
    status: "completed",
    subagentTokens: 0,
    subagentLatencyMs: 0,
  }
}

const subTurn = (turnIndex: number, sid: string) =>
  makeTurn(turnIndex, {
    isSubagent: true,
    subagentSessionId: sid,
    subagentName: "worker",
    contentSummary: "相当长的摘要内容用于验证窄列下的截断与换行行为不在横向溢出",
    toolCalls: [{ toolCallId: `tc-${turnIndex}`, toolName: "read", state: "completed", durationMs: 10 }],
  })

describe("TurnTimeline 并行派发 lane 展示（chip 行 + 全宽展开）", () => {
  const dispatchTurn = makeTurn(634, {
    toolCalls: [
      { toolCallId: "tc-a", toolName: "task", state: "completed", durationMs: 5 },
      { toolCallId: "tc-b", toolName: "task", state: "completed", durationMs: 5 },
    ],
  })
  const turns = [
    dispatchTurn,
    subTurn(635, "ses_sub_a"),
    subTurn(636, "ses_sub_a"),
    subTurn(1078, "ses_sub_b"),
    subTurn(1079, "ses_sub_b"),
  ]
  const bridges = [
    makeBridge("br-a", "t-634", "ses_sub_a", "agent-one"),
    makeBridge("br-b", "t-634", "ses_sub_b", "agent-two"),
  ]

  it("并行组渲染：⇄ 标识 + 汇总 + 双 chip；不再多列 grid 并排", () => {
    const html = renderToStaticMarkup(
      createElement(TurnTimeline, {
        turns,
        bridges,
        selectedTurnId: null,
        onSelectTurn: () => {},
      })
    )
    expect(html).toContain("parallel subagents")
    expect(html).toContain("⇄")
    // 两个并行 agent 的 chip 均渲染
    expect(html).toContain("agent-one")
    expect(html).toContain("agent-two")
    // 不再并排 grid（grid-cols-2/3 属于被替换的旧布局）
    expect(html).not.toContain("grid-cols-2")
    expect(html).not.toContain("grid-cols-3")
    // chip 行可换行、组根可收缩（窄容器不撑破、不留白基线）
    expect(html).toContain("flex-wrap")
    expect(html).toContain("rounded-lg border border-orange-200/70")
  })

  it("展开的 lane 全宽渲染在 chip 行下方：chip 高亮 + turn 行完整（#N/tools/token）", () => {
    const html = renderToStaticMarkup(
      createElement(ParallelSubagentGroup, {
        lanes: [
          {
            bridgeId: "br-a",
            sessionId: "ses_sub_a",
            name: "agent-one",
            type: "general",
            summary: "dispatch agent-one",
            turns: [subTurn(635, "ses_sub_a"), subTurn(636, "ses_sub_a")],
            status: "completed",
            totalTokens: 12345,
            latencyMs: 45000,
            turnCount: 2,
          },
          {
            bridgeId: "br-b",
            sessionId: "ses_sub_b",
            name: "agent-two",
            type: "general",
            summary: "dispatch agent-two",
            turns: [subTurn(1078, "ses_sub_b")],
            status: "error",
            totalTokens: 3000,
            latencyMs: 12000,
            turnCount: 1,
          },
        ],
        ctx: {
          subagentBlocksByTurnId: new Map(),
          expandedSubagents: new Set(["br-a"]),
          onToggleBridge: () => {},
          selectedTurnId: null,
          onSelectTurn: () => {},
          selectedSubRef: null,
        },
      })
    )
    // 展开的 chip 高亮、未展开的保持折叠态箭头
    expect(html).toContain("bg-orange-100/60")
    expect(html.match(/▶/g)?.length).toBeGreaterThanOrEqual(1)
    // 展开区渲染 lane 盒 + turn 行完整信息
    expect(html).toContain("rounded-lg min-w-0")
    expect(html).toContain("#635")
    expect(html).toContain("1 tools")
    expect(html).toContain("12.3k")
    // 行级卫生标记：wrap + 截断约束
    expect(html).toContain("flex-wrap")
    expect(html).toContain("truncate min-w-[60px] max-w-[200px]")
    // 错误态 chip 有 error 徽章
    expect(html).toContain("error")
  })

  it("SubagentLaneView 直渲染：行级收缩/换行卫生（嵌套子 lane 同样生效）", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentLaneView, {
        lane: {
          bridgeId: "br-a",
          sessionId: "ses_sub_a",
          name: "agent-one",
          type: "general",
          summary: "dispatch agent-one",
          turns: [subTurn(635, "ses_sub_a"), subTurn(636, "ses_sub_a")],
          status: "completed",
          totalTokens: 12345,
          latencyMs: 45000,
          turnCount: 2,
        },
        ctx: {
          subagentBlocksByTurnId: new Map(),
          expandedSubagents: new Set(["br-a"]),
          onToggleBridge: () => {},
          selectedTurnId: null,
          onSelectTurn: () => {},
          selectedSubRef: null,
        },
      })
    )
    expect(html).toMatch(/#\d+[^]*shrink-0|shrink-0[^]*#\d+/)
    expect(html).toContain("#635")
    expect(html).toContain("1 tools")
  })

  it("点击第一个 chip：详情紧跟其下（DOM 顺序先于后续 chip），其他 lane 仍折叠", async () => {
    // 现场场景三路并行（empty/group/base）：点第一个 chip，旧布局把展开区
    // 统一渲染在整个 chip 行末尾，详情视觉上挂在最后一个 chip 下面
    const mk = (idx: number, sid: string, mark: string) =>
      makeTurn(idx, {
        isSubagent: true,
        subagentSessionId: sid,
        subagentName: "worker",
        contentSummary: mark,
      })
    const turns = [
      makeTurn(100, {
        toolCalls: [
          { toolCallId: "tc-a", toolName: "task", state: "completed", durationMs: 5 },
          { toolCallId: "tc-b", toolName: "task", state: "completed", durationMs: 5 },
          { toolCallId: "tc-c", toolName: "task", state: "completed", durationMs: 5 },
        ],
      }),
      mk(101, "ses_empty", "EMPTY-LANE-TURN"),
      mk(102, "ses_group", "GROUP-LANE-TURN"),
      mk(103, "ses_base", "BASE-LANE-TURN"),
    ]
    const bridges = [
      makeBridge("br-empty", "t-100", "ses_empty", "agent-empty"),
      makeBridge("br-group", "t-100", "ses_group", "agent-group"),
      makeBridge("br-base", "t-100", "ses_base", "agent-base"),
    ]

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(TurnTimeline, {
        turns,
        bridges,
        selectedTurnId: null,
        onSelectTurn: () => {},
      }))
    })

    const chipByName = (name: string) =>
      [...container.querySelectorAll("button")].find(b => b.textContent?.includes(name)) as HTMLElement
    // 折叠态：三个 chip 都在，无任何 lane 内容
    expect(chipByName("agent-empty")).toBeTruthy()
    expect(container.textContent).not.toContain("EMPTY-LANE-TURN")

    await act(async () => { chipByName("agent-empty").click() })

    // lane 内容出现，且 DOM 顺序先于后续两个 chip —— 详情在所属 chip 下方，
    // 而不是等在整个 chip 行末尾
    const laneRow = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("EMPTY-LANE-TURN")) as HTMLElement
    expect(laneRow).toBeTruthy()
    expect(chipByName("agent-group").compareDocumentPosition(laneRow) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(chipByName("agent-base").compareDocumentPosition(laneRow) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    // 其他 lane 未连带展开
    expect(container.textContent).not.toContain("GROUP-LANE-TURN")
    expect(container.textContent).not.toContain("BASE-LANE-TURN")

    root.unmount()
    container.remove()
  })
})
