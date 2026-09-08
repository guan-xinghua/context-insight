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
  /** agent .md 来源：session=会话内 read 结果恢复（运行时真正生效），disk=磁盘扫描兜底 */
  via?: "session" | "disk" | null
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

  /** Skills tab subagent 行"全文"按钮：取 agent .md。source 强制单源（session=会话内
   *  read 结果恢复 / disk=磁盘扫描），分桶 key 防同名互覆，便于两版并排对比。 */
  const fetchAgent = useCallback(async (agentName: string, framework?: string, source?: "session" | "disk") => {
    const key = source ? `${source}:${agentName}` : agentName
    setLoading(prev => new Set(prev).add(key))
    setError(prev => { const n = new Map(prev); n.delete(key); return n })
    try {
      const q = new URLSearchParams({
        taskId,
        agentName,
        ...(framework ? { framework } : {}),
        ...(source ? { source } : {}),
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
