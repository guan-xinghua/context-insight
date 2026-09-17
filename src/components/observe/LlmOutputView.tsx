"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useEffect, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { CopyButton } from "./CopyButton"
import { BashEscapeView, parseBashEscape } from "./BashEscapeView"
import { highlightKeyword, type TurnHighlight } from "@/lib/shared/highlight"
import { stripThinkingAndReminder } from "@/lib/shared/text-strip"

interface LlmOutputViewProps {
  content: string | null
  contentJson: string | null
  contentSummary: string | null
  outputTokens: number
  reasoningTokens?: number
  role?: string | null
  highlight?: TurnHighlight | null
  toolCallCount?: number
  finishReason?: string | null
}

function formatTokenCount(n: number): string {
  if (n === 0) return ""
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

interface ContentSection {
  type: "thinking" | "text"
  content: string
}

function parseContentSections(content: string | null, contentJson: string | null): ContentSection[] {
  const sections: ContentSection[] = []

  let rawContent = content ?? ""

  if (contentJson) {
    try {
      const parsed = JSON.parse(contentJson)
      if (typeof parsed === "string") {
        rawContent = parsed
      } else if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === "thinking" || block.type === "reasoning") {
            sections.push({ type: "thinking", content: block.thinking ?? block.content ?? block.text ?? String(block) })
          } else if (block.type === "text") {
            sections.push({ type: "text", content: block.text ?? block.content ?? String(block) })
          }
        }
        if (sections.length > 0) return sections
      } else if (typeof parsed === "object" && parsed.content) {
        rawContent = parsed.content
      }
    } catch {
      rawContent = content ?? ""
    }
  }

  if (sections.length === 0 && rawContent) {
    const thinkingPattern = new RegExp("<thinking>(.*?)<\\/thinking>", "gs")
    const matches = [...rawContent.matchAll(thinkingPattern)]

    if (matches.length > 0) {
      let remaining = rawContent
      for (const match of matches) {
        sections.push({ type: "thinking", content: match[1] })
        remaining = remaining.replace(match[0], "")
      }
      const trimmed = remaining.trim()
      if (trimmed) {
        sections.push({ type: "text", content: trimmed })
      }
    } else {
      sections.push({ type: "text", content: rawContent })
    }
  }

  return sections
}

export function LlmOutputView({
  content,
  contentJson,
  contentSummary,
  outputTokens,
  reasoningTokens,
  role,
  highlight,
  toolCallCount,
  finishReason,
}: LlmOutputViewProps) {
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(false)
  const [prevKw, setPrevKw] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const sections = parseContentSections(content, contentJson)
  // 异常完成原因显式化（正常类 stop/tool_calls/end_turn/tool_use 不标——
  // Overview 的 finish: 小字足够，加徽标是噪音）：截断/审查/拒答类的输出
  // 不完整或为空，静默吞掉会被读成"突然结束/没输出"。两套线缆约定都认
  //（OpenAI 'length'/'content_filter'；Claude 透传 'max_tokens'/'refusal'，
  // claude-emitter 原样透传 stop_reason，scoring collect 同款判定）。
  // 两档：有部分文本只挂徽标（正文可见）；全空的再加强制展开 + 解释文案
  const ABNORMAL_FINISH: Record<string, { label: string; emptyNote: string }> = {
    length: { label: "⛔ max_tokens 截断", emptyNote: `本轮输出被 max_tokens 上限截断（stopReason = ${finishReason}）：{TOKENS}t 输出已消耗，但没有文本落盘（content 为空）。该轮不是正常收尾——若需完整结果，请提高该 agent 的输出上限或缩小单轮任务后重试。` },
    max_tokens: { label: "⛔ max_tokens 截断", emptyNote: `本轮输出被 max_tokens 上限截断（stopReason = ${finishReason}）：{TOKENS}t 输出已消耗，但没有文本落盘（content 为空）。该轮不是正常收尾——若需完整结果，请提高该 agent 的输出上限或缩小单轮任务后重试。` },
    content_filter: { label: "⛔ 内容过滤截断", emptyNote: `本轮输出被内容审查策略截断（stopReason = content_filter）：生成中途被拦截，落盘内容不完整或为空。请检查提示词或调整审查策略。` },
    refusal: { label: "⛔ 模型拒答", emptyNote: `模型拒绝了本次请求（stopReason = refusal）：无有效输出落盘。请检查任务描述是否触发拒答策略。` },
  }
  const abnormal = finishReason != null ? ABNORMAL_FINISH[finishReason] : undefined
  const abnormalEmpty = abnormal != null && sections.every(s => !s.content.trim())
  // 短输出默认展开（直接可读）；长输出默认折叠（标题行 + token 数概览，
  // 点击展开）。与 LLM Input 的两级折叠习惯一致。全空异常轮强制展开——解释
  // 必须直接可见，不能再让用户点一层才看到"为什么是空的"
  const [isExpanded, setIsExpanded] = useState(
    abnormalEmpty || ((outputTokens ?? 0) <= 2000 && (content?.length ?? 0) <= 6000)
  )

  // Trace-search jump: when the highlight keyword changes, auto-expand so the
  // highlighted match is visible. Uses the render-phase prop-change pattern
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // instead of setState-in-effect.
  const currentKw = highlight?.keyword ?? null
  if (currentKw !== prevKw) {
    setPrevKw(currentKw)
    if (currentKw && highlight) {
      const isContentMatch = !highlight.matchField || highlight.matchField === "content" || highlight.matchField === "contentSummary"
      if (isContentMatch) {
        setIsExpanded(true)
        const lower = currentKw.trim().toLowerCase()
        if (sections.some(s => s.type === "thinking" && s.content.toLowerCase().includes(lower))) {
          setIsThinkingExpanded(true)
        }
      }
    }
  }

  // Scroll the first highlighted match into view once expanded.
  useEffect(() => {
    if (!highlight?.keyword || !isExpanded) return
    const t = setTimeout(() => {
      rootRef.current?.querySelector("mark")?.scrollIntoView({ behavior: "smooth", block: "center" })
    }, 60)
    return () => clearTimeout(t)
  }, [highlight, isExpanded])

  if (!content && !contentJson && !abnormalEmpty) return null

  // 折叠态预览优先展示正文（text section）开头：thinking 块会吃掉 200 字符
  // 摘要预算（contentSummary 生成于 ingest 期），导致预览全是思考过程、
  // 正文一字不见，被误读为"output 没展示"。thinking 有独立折叠块与 token 徽标。
  // 剥离与 ingest 同口径：user turn 的 <system-reminder> 前缀同样不进预览。
  const textPreview = stripThinkingAndReminder(sections.find(s => s.type === "text")?.content ?? null)
  const summary = (textPreview
    ? (textPreview.length > 200 ? textPreview.substring(0, 200) + "..." : textPreview)
    : null)
    ?? contentSummary
    ?? (content ? (content.length > 200 ? content.substring(0, 200) + "..." : content) : null)

  const HEADER_LABELS: Record<string, string> = {
    user: "User Input",
    assistant: "LLM Output",
    system: "System Message",
    tool_result: "Tool Result",
  }
  const headerLabel = HEADER_LABELS[role ?? ""] ?? "Content"

  return (
    <div ref={rootRef} className="border rounded-lg">
      <div className="w-full flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{headerLabel}</span>
          {abnormal ? (
            <Badge variant="red">{abnormal.label}</Badge>
          ) : finishReason ? (
            <Badge variant="outline">finish: {finishReason}</Badge>
          ) : null}
          {summary && (
            <span className="text-muted-foreground truncate max-w-[400px]">{summary}</span>
          )}
          {((outputTokens + (reasoningTokens ?? 0)) > 0) && (
            <Badge variant="outline">
              {(reasoningTokens ?? 0) > 0
                ? `${formatTokenCount(reasoningTokens ?? 0)}t reasoning + ${formatTokenCount(outputTokens)}t output`
                : `${formatTokenCount(outputTokens)} tokens`
              }
            </Badge>
          )}
        </div>
        <span
          role="button"
          tabIndex={0}
          className="shrink-0 px-2 py-1 -mr-2 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer select-none"
          onClick={() => setIsExpanded(!isExpanded)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded) }}
        >
          {isExpanded ? "▼" : "▶"}
        </span>
      </div>

      {isExpanded && abnormalEmpty && abnormal && (
        <div className="border-t px-3 py-3 text-sm text-red-600 dark:text-red-400">
          {abnormal.emptyNote.replace("{TOKENS}", formatTokenCount(outputTokens))}
        </div>
      )}

      {isExpanded && sections.length > 0 && (
        <div className="border-t px-3 py-2 space-y-3">
          {sections.map((section, index) => {
            // shell 转义显示糖：有关键字高亮时退回普通渲染，保住 <mark> 跳转
            const bashEscape = parseBashEscape(section.content)
            if (section.type === "thinking") {
              return (
                <div key={index} className="border rounded-md">
                  <div className="w-full flex items-center gap-2 px-2 py-1.5 text-sm">
                    <Badge variant="purple">thinking</Badge>
                    {(reasoningTokens ?? 0) > 0 && (
                      <span className="text-muted-foreground text-xs">{formatTokenCount(reasoningTokens ?? 0)}t</span>
                    )}
                    <CopyButton text={section.content} className="ml-auto size-4 text-muted-foreground hover:text-foreground" />
                    <span
                      role="button"
                      tabIndex={0}
                      className="shrink-0 px-2 py-1 -mr-2 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer select-none"
                      onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsThinkingExpanded(!isThinkingExpanded) }}
                    >
                      {isThinkingExpanded ? "▼" : "▶"}
                    </span>
                  </div>
                  {isThinkingExpanded && (
                    <div className="px-2 pb-2 text-sm whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto bg-purple-50/30 dark:bg-purple-500/5">
                      {highlightKeyword(section.content, highlight?.keyword)}
                    </div>
                  )}
                </div>
              )
            }

            return (
              <div key={index} className="border rounded-md overflow-hidden">
                <div className="flex items-center gap-2 px-2 py-1.5 bg-emerald-50/30 dark:bg-emerald-500/5">
                  <Badge variant="green">text</Badge>
                  {outputTokens > 0 && (
                    // usage 的 output 不分块：带工具调用时参数 token 计入
                    // outputTokens，记在 text 头上会像"token 去哪了"——注明构成
                    <span className="text-muted-foreground text-xs">
                      {formatTokenCount(outputTokens)}t{(toolCallCount ?? 0) > 0 ? ` · 含 ${toolCallCount} 个工具调用参数` : ""}
                    </span>
                  )}
                  <CopyButton text={section.content} className="ml-auto size-4 text-muted-foreground hover:text-foreground" />
                </div>
                <div className="px-2 pb-2 text-sm max-h-[600px] overflow-y-auto">
                  {!highlight?.keyword && bashEscape ? (
                    <BashEscapeView esc={bashEscape} />
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{highlightKeyword(section.content, highlight?.keyword)}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
