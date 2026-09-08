"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { AIProviderConfig } from "@/lib/ai/analyzer"
import {
  loadProviderConfig,
  saveProviderConfig,
  clearProviderConfig,
} from "@/lib/ai-provider-config"

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const DEFAULT_MODEL = "qwen3.7-max"

// 常见提供商 Base URL 填法速查（点击行直接填入）。URL 归一规则见
// src/lib/ai/analyzer.ts buildChatUrl：填到版本段（/v1、/v3、/api/paas/v4…）
// 即可，系统自动拼 /chat/completions；首尾空格自动忽略。
// 模型名 2026-08-27 对照官方文档核实：智谱（实测，GLM Plan 订阅走 coding 端点，
// 按量端点报 1113）；方舟对话在 /api/v3（/v1 只有 models 列表，会 404）；
// DeepSeek V4 命名见 api-docs.deepseek.com（deepseek-v4-flash/pro）；
// Moonshot 见 platform.moonshot.cn（kimi-k3 旗舰，V1 系列 8/31 下线）；
// OpenAI 按其文档 "Latest: GPT-5.5" 标注。
const PROVIDER_URL_PRESETS: Array<{ name: string; url: string; model?: string; note?: string }> = [
  { name: "阿里云百炼", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max" },
  { name: "智谱 GLM Plan", url: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.3", note: "订阅套餐专用端点" },
  { name: "智谱按量", url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", note: "glm-4-flash 免费，旗舰模型需余额" },
  { name: "火山方舟 Ark", url: "https://ark.cn-beijing.volces.com/api/v3", note: "对话在 /api/v3；专属网关填到网关地址的 /api/v3；model 填模型名或 ep- 接入点" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", note: "旗舰 deepseek-v4-pro；视觉实验版 deepseek-v4-flash-vision-exp" },
  { name: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-5.5" },
  { name: "Moonshot Kimi", url: "https://api.moonshot.cn/v1", model: "kimi-k3", note: "另有 kimi-k2.6 / K2.7 Code；Moonshot V1 系列 8 月底下线" },
  { name: "本地 Ollama", url: "http://localhost:11434/v1", note: "API Key 任意填" },
  { name: "本地 vLLM", url: "http://localhost:8000/v1", note: "API Key 任意填" },
]

interface Props {
  onConfigChange?: (config: AIProviderConfig | null) => void
  compact?: boolean
}

export function AIProviderConfigPanel({ onConfigChange, compact }: Props) {
  // 渲染期不读 localStorage：SSR 无 localStorage，hydration 首渲染必须与
  // 服务端输出一致 —— 已存配置挂载后由 effect 填充
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [savedFlag, setSavedFlag] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    // localStorage 回填放微任务：避免 effect 体内同步 setState 触发级联渲染
    queueMicrotask(() => {
      const saved = loadProviderConfig()
      if (!saved) return
      setBaseUrl(saved.baseUrl)
      setApiKey(saved.apiKey)
      setModel(saved.model)
      setSavedFlag(true)
    })
  }, [])

  // 派生配置时统一 trim：粘贴带入的首尾空格会让 URL 版本段正则失配（/v4␣ → 拼出
  // /v4%20/v1/… 畸形路径 404）、API Key 鉴权失败、模型名解析不到
  const config: AIProviderConfig = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() }
  const isAnthropicPath = baseUrl.includes("/apps/anthropic")

  function handleSave() {
    saveProviderConfig(config)
    setSavedFlag(true)
    setTestResult(null)
    onConfigChange?.(config)
  }

  function handleClear() {
    clearProviderConfig()
    setSavedFlag(false)
    setTestResult(null)
    onConfigChange?.(null)
  }

  function handleTest() {
    setTesting(true)
    setTestResult(null)
    fetch("/api/ai/test-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model }),
      signal: AbortSignal.timeout(45000),
    })
      .then(res => res.json())
      .then(data => setTestResult({ success: data.success, message: data.message }))
      .catch(e => setTestResult({ success: false, message: `❌ ${e.message}` }))
      .finally(() => setTesting(false))
  }

  return (
    <Card>
      <CardContent className={compact ? "py-3 space-y-3" : "p-4 space-y-3"}>
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>LLM API 配置（OpenAI 兼容）</span>
          {savedFlag && <span className="text-xs text-green-600">✓ 已保存</span>}
        </div>

        {isAnthropicPath && (
          <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 px-2 py-1.5 rounded">
            ❌ /apps/anthropic 是 Anthropic Messages 格式，不支持。请改用 /compatible-mode/v1 的 OpenAI 兼容地址
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Base URL</span>
            <Input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setSavedFlag(false) }} className="h-7 text-xs" placeholder="https://..." />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">API Key</span>
            <Input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setSavedFlag(false) }} className="h-7 text-xs" placeholder="sk-..." />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Model</span>
            <Input value={model} onChange={(e) => { setModel(e.target.value); setSavedFlag(false) }} className="h-7 text-xs" placeholder="qwen3.7-max" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" className="text-xs" onClick={handleSave} disabled={!apiKey}>
            保存配置
          </Button>
          <Button size="sm" variant="outline" className="text-xs" onClick={handleTest} disabled={!apiKey || testing}>
            {testing ? "测试中…" : "测试连接"}
          </Button>
          {savedFlag && (
            <Button size="sm" variant="ghost" className="text-xs" onClick={handleClear}>
              清除
            </Button>
          )}
          {testResult && (
            <span className={cn("text-xs", testResult.success ? "text-green-600" : "text-red-600")}>
              {testResult.message}
            </span>
          )}
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            常见提供商 Base URL 填法（点击行填入）
          </summary>
          <div className="mt-1.5 space-y-0.5">
            {PROVIDER_URL_PRESETS.map(p => (
              <button
                key={p.url}
                type="button"
                data-preset={p.url}
                onClick={() => {
                  setBaseUrl(p.url)
                  if (p.model) setModel(p.model)
                  setSavedFlag(false)
                  setTestResult(null)
                }}
                className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1.5 py-1 text-left hover:bg-muted"
              >
                <span className="w-20 shrink-0 text-muted-foreground">{p.name}</span>
                <code className="break-all">{p.url}</code>
                {p.model && <span className="shrink-0 text-muted-foreground">· {p.model}</span>}
                {p.note && <span className="basis-full pl-[5.5rem] text-[11px] leading-tight text-muted-foreground/80">{p.note}</span>}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground/80">
            规则：填到版本段（/v1、/v3、/api/paas/v4…）即可，自动拼 /chat/completions；首尾空格自动忽略。
          </p>
        </details>

        <p className="text-xs text-muted-foreground">配置保存在浏览器本地。Audit 一键审计报告功能需使用此配置。</p>
      </CardContent>
    </Card>
  )
}
