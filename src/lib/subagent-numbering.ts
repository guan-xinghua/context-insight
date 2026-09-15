// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 同名 subagent 的统一编号（Context / Turn / Trace 各视图一致）：
// 身份 = subagentSessionId 分组，序 = 同 agentName 内按组首 turn 时间先后，
// #1 最早。0 token 组也参与（Turn 页无图可画也要有身份）。此前 Context 图例
// 按 peak 降序、Replay 按 spawn 序各自 indexOf+1，两处 #1 可能不是同一个
// subagent——统一收敛到本模块。

export interface SubagentNumberingTurn {
  turnIndex: number
  agentName: string | null
  isSubagent: boolean
  subagentSessionId: string | null
  createdAt: string | null
}

export function subagentGroupKey(t: { isSubagent: boolean; subagentSessionId: string | null; turnIndex: number }): string {
  return t.isSubagent ? (t.subagentSessionId ?? `anon-${t.turnIndex}`) : "root"
}

export function buildSubagentNumbers(turns: SubagentNumberingTurn[]): Map<string, number> {
  const groups = new Map<string, { agentName: string; firstAt: number; order: number }>()
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    if (!t.isSubagent) continue
    const key = subagentGroupKey(t)
    if (groups.has(key)) continue
    groups.set(key, {
      agentName: t.agentName ?? "?",
      firstAt: t.createdAt ? new Date(t.createdAt).getTime() : Number.MAX_SAFE_INTEGER,
      order: i,
    })
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[1].agentName !== b[1].agentName) return a[1].agentName < b[1].agentName ? -1 : 1
    if (a[1].firstAt !== b[1].firstAt) return a[1].firstAt - b[1].firstAt
    return a[1].order - b[1].order
  })

  const counters = new Map<string, number>()
  const result = new Map<string, number>()
  for (const [key, g] of ordered) {
    const next = (counters.get(g.agentName) ?? 0) + 1
    counters.set(g.agentName, next)
    result.set(key, next)
  }
  return result
}
