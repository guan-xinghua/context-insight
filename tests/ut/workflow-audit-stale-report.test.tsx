// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

import { createElement } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auditStore = vi.hoisted(() => ({
  state: {
    taskId: "session-stale",
    generating: false,
    genError: null as string | null,
    progress: [] as Array<{ stage: string; msg: string }>,
    elapsed: 0,
    startedAt: null as number | null,
    result: null,
  },
}))

vi.mock("@/lib/audit-job", () => ({
  subscribeAuditJob: () => () => {},
  getAuditJobSnapshot: () => auditStore.state,
  getAuditJobServerSnapshot: () => auditStore.state,
  startAuditJob: vi.fn(),
}))

vi.mock("@/lib/agent-version", () => ({
  subscribeAgentVersion: () => () => {},
  getAgentVersionSnapshot: () => "v4",
  getAgentVersionServerSnapshot: () => "v4",
  saveAgentVersion: vi.fn(),
}))

vi.mock("@/lib/ai-provider-config", () => ({
  loadProviderConfig: () => ({ apiKey: "key", baseUrl: "http://llm.test/v1", model: "test" }),
  subscribeProviderConfig: () => () => {},
  getProviderConfigSnapshot: () => JSON.stringify({ apiKey: "key", baseUrl: "http://llm.test/v1", model: "test" }),
  getProviderConfigServerSnapshot: () => null,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => createElement("button", props, children),
}))

vi.mock("@/components/observe/AIProviderConfigPanel", () => ({ AIProviderConfigPanel: () => null }))
vi.mock("@/components/observe/WorkflowFlowChart", () => ({
  WorkflowFlowChart: ({ analysis }: { analysis: { sessionSummary?: string } }) =>
    createElement("div", { "data-testid": "report" }, analysis.sessionSummary),
}))
vi.mock("@/components/observe/WorkflowAgentAudit", () => ({
  isV4Analysis: (value: unknown) =>
    !!value && typeof value === "object" && Array.isArray((value as { agents?: unknown }).agents),
  WorkflowAgentAudit: ({ analysis }: { analysis: { sessionSummary?: string } }) =>
    createElement("div", { "data-testid": "report" }, analysis.sessionSummary),
}))

import { WorkflowAnalyseTab } from "@/components/observe/WorkflowAnalyseTab"

describe("Workflow Audit 历史报告状态", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem("wf-analysis-session-stale", JSON.stringify({
      sessionSummary: "旧审计报告",
      agents: [],
      _auditMeta: { generatedAt: "2026-08-26T12:43:27.000Z" },
    }))
    auditStore.state = {
      taskId: "session-stale",
      generating: false,
      genError: null,
      progress: [],
      elapsed: 0,
      startedAt: null,
      result: null,
    }
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    localStorage.clear()
  })

  function render(): void {
    act(() => root.render(createElement(WorkflowAnalyseTab, { taskId: "session-stale" })))
  }

  it("生成新报告时明确标记下方仍是历史报告", () => {
    auditStore.state = { ...auditStore.state, generating: true, elapsed: 12 }
    render()

    expect(container.textContent).toContain("新报告生成中；下方暂时展示历史报告，成功后会自动替换。")
    expect(container.textContent).toContain("旧审计报告")
  })

  it("收到失败状态时明确说明失败报告已写入", () => {
    auditStore.state = { ...auditStore.state, genError: "LLM API error: 429" }
    localStorage.setItem("wf-analysis-session-stale", JSON.stringify({
      reportKind: "audit-failure",
      status: "failed",
      taskId: "session-stale",
      agentVersion: "v4",
      startedAt: "2026-08-28T02:00:00.000Z",
      generatedAt: "2026-08-28T02:02:03.000Z",
      elapsedSec: 123,
      error: "LLM API error: 429",
      progress: [
        { stage: "extract-done", msg: "agent-IO 就绪：3 个 agent" },
        { stage: "llm-start", msg: "并行审计 3 个 agent" },
      ],
      partialAnalysis: null,
    }))
    render()

    expect(container.textContent).toContain("生成失败：LLM API error: 429")
    expect(container.textContent).toContain("本次失败报告已写入浏览器，可查看进度详情或导出排查。")
    expect(container.textContent).toContain("审计报告生成失败")
    expect(container.textContent).toContain("耗时 123s")
    expect(container.textContent).toContain("agent-IO 就绪：3 个 agent")
    expect(container.textContent).not.toContain("旧审计报告")
  })
})
