// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// AIProviderConfigPanel 渲染 IT：① 提供商预设行点击 → baseUrl/model 填入
// （无 model 的预设不动 model）；② 带首尾空格的输入保存后 localStorage 里
// 是 trim 过的值（粘贴空格曾致 /v4%20/v1 畸形路径 404，见 buildChatUrl 注释）。
import { describe, it, expect, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { createElement } from "react"
import { AIProviderConfigPanel } from "@/components/observe/AIProviderConfigPanel"
import { AI_PROVIDER_STORAGE_KEY, loadProviderConfig } from "@/lib/ai-provider-config"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const el = Array.from(document.querySelectorAll("input")).find(i => i.placeholder === placeholder)
  if (!el) throw new Error(`input not found: ${placeholder}`)
  return el as HTMLInputElement
}

function presetRow(urlPart: string): HTMLElement {
  const el = Array.from(document.querySelectorAll<HTMLElement>("[data-preset]"))
    .find(el => (el.getAttribute("data-preset") ?? "").includes(urlPart))
  if (!el) throw new Error(`preset row not found: ${urlPart}`)
  return el
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ""
  localStorage.clear()
})

function mount() {
  const host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
}

describe("AIProviderConfigPanel 提供商预设与 trim 保存", () => {
  it("预设行点击填入 baseUrl + model；无 model 的预设（方舟）只改 URL", async () => {
    mount()
    await act(async () => {
      root!.render(createElement(AIProviderConfigPanel, { compact: true }))
    })

    await act(async () => {
      presetRow("bigmodel.cn/api/coding").dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(inputByPlaceholder("https://...").value).toBe("https://open.bigmodel.cn/api/coding/paas/v4")
    expect(inputByPlaceholder("qwen3.7-max").value).toBe("glm-5.3")

    await act(async () => {
      presetRow("volces.com").dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(inputByPlaceholder("https://...").value).toBe("https://ark.cn-beijing.volces.com/api/v3")
    expect(inputByPlaceholder("qwen3.7-max").value).toBe("glm-5.3")
  })

  it("带首尾空格的输入保存后 localStorage 为 trim 值", async () => {
    mount()
    await act(async () => {
      root!.render(createElement(AIProviderConfigPanel, { compact: true }))
    })

    const fillInput = (input: HTMLInputElement, value: string) => {
      act(() => {
        Reflect.apply(nativeValueSetter, input, [value])
        input.dispatchEvent(new InputEvent("input", { bubbles: true }))
      })
    }
    fillInput(inputByPlaceholder("https://..."), " https://open.bigmodel.cn/api/coding/paas/v4 ")
    fillInput(inputByPlaceholder("sk-..."), " sk-test ")
    fillInput(inputByPlaceholder("qwen3.7-max"), " glm-5.3 ")

    const saveBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "保存配置")!
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(JSON.parse(localStorage.getItem(AI_PROVIDER_STORAGE_KEY)!)).toEqual({
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiKey: "sk-test",
      model: "glm-5.3",
    })
    expect(loadProviderConfig()?.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4")
  })
})
