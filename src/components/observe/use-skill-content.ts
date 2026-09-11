// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useCallback } from "react"

export interface SkillContentResponse {
  skillName: string
  content: string | null
  source: string | null
  length: number
  fullRead: boolean
  maxLine: number | null
  /** agent .md 来源：system=会话恢复（子代理运行时 system 注入的声明原文，主路径），disk=磁盘扫描（兜底） */
  via?: "system" | "disk" | null
}

export function useSkillContent(taskId: string) {
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [content, setContent] = useState<Map<string, SkillContentResponse>>(new Map())
  const [error, setError] = useState<Map<string, string>>(new Map())

  const fetchOne = useCallback(async (skillName: string) => {
    setLoading(prev => new Set(prev).add(skillName))
    setError(prev => { const n = new Map(prev); n.delete(skillName); return n })
    try {
      const r = await fetch(
        `/api/observe/session/skill-content?taskId=${encodeURIComponent(taskId)}&skillName=${encodeURIComponent(skillName)}`
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d: SkillContentResponse = await r.json()
      setContent(prev => new Map(prev).set(skillName, d))
    } catch (e) {
      setError(prev => new Map(prev).set(skillName, e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading(prev => { const n = new Set(prev); n.delete(skillName); return n })
    }
  }, [taskId])

  /** Skills tab subagent 行"全文"按钮：取 agent .md。单一入口——会话恢复（system
   *  注入）为主数据、磁盘扫描兜底，两级优先由服务端 agent-content 路由内置；
   *  key 带 agent: 前缀防与同名 skill 的内容互覆。 */
  const fetchAgent = useCallback(async (agentName: string, framework?: string) => {
    const key = `agent:${agentName}`
    setLoading(prev => new Set(prev).add(key))
    setError(prev => { const n = new Map(prev); n.delete(key); return n })
    try {
      const q = new URLSearchParams({
        taskId,
        agentName,
        ...(framework ? { framework } : {}),
      })
      const r = await fetch(`/api/observe/session/agent-content?${q.toString()}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d: SkillContentResponse = await r.json()
      setContent(prev => new Map(prev).set(key, d))
    } catch (e) {
      setError(prev => new Map(prev).set(key, e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading(prev => { const n = new Set(prev); n.delete(key); return n })
    }
  }, [taskId])

  const clear = useCallback((skillName: string) => {
    setContent(prev => { const n = new Map(prev); n.delete(skillName); return n })
    setError(prev => { const n = new Map(prev); n.delete(skillName); return n })
  }, [])

  const download = useCallback((skillName: string) => {
    const data = content.get(skillName)
    if (!data?.content) return
    const blob = new Blob([data.content], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement("a")
    a.href = url
    a.download = `${skillName.replace(/[^a-zA-Z0-9_-]/g, "_")}.SKILL.md`
    window.document.body.appendChild(a)
    a.click()
    window.document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [content])

  return { loading, content, error, fetchOne, fetchAgent, clear, download }
}
