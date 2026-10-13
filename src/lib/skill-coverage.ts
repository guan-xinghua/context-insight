// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

export interface AvailableSkill {
  name: string
  description: string
  origin: string | null
}

export interface UsedSkillAggregate {
  skillName: string
  invokeCount: number
  loadCount: number
  dispatchCount: number
  success: boolean
}

export type CoverageStatus = 'invoked' | 'loaded' | 'dispatched' | 'unused' | 'extra'

export interface CoverageItem {
  name: string
  description: string
  origin: string | null
  status: CoverageStatus
  invokeCount: number
  loadCount: number
  dispatchCount: number
}

export interface CoverageStats {
  availableTotal: number
  invoked: number
  loaded: number
  dispatched: number
  unused: number
  extra: number
  /** 环状图分母：四态条目之和（invoked+loaded+dispatched+unused）。dispatched
   *  含全集外动态子代理（合法使用），故环不能用 availableTotal 当分母——
   *  子代理数超过全集时会溢出整圈（如 全集6 + 动态子代理12）。 */
  total: number
}

export interface SkillCoverage {
  items: CoverageItem[]
  stats: CoverageStats
}

// 结构化解析（parseClaude/parseOpencode/parseCodex AvailableSkills）已迁至
// adapters/system-structure/（框架自持，按捕获框架分发——本模块只保留
// 覆盖度域逻辑与 AvailableSkill 域词汇，不持有框架格式知识）。

export function aggregateUsedSkills(
  events: Array<{ skillName: string; eventType: string; success: boolean }>
): UsedSkillAggregate[] {
  const byName = new Map<string, UsedSkillAggregate>()
  for (const e of events) {
    let agg = byName.get(e.skillName)
    if (!agg) {
      agg = { skillName: e.skillName, invokeCount: 0, loadCount: 0, dispatchCount: 0, success: true }
      byName.set(e.skillName, agg)
    }
    if (e.eventType === 'invoke' || e.eventType === 'use') agg.invokeCount++
    else if (e.eventType === 'load') agg.loadCount++
    else if (e.eventType === 'dispatch') agg.dispatchCount++
    if (!e.success) agg.success = false
  }
  return Array.from(byName.values())
}

export function buildCoverage(
  available: AvailableSkill[] | null,
  used: UsedSkillAggregate[]
): SkillCoverage {
  const items: CoverageItem[] = []
  const usedByName = new Map(used.map(u => [u.skillName, u]))
  const consumedUsed = new Set<string>()

  if (available) {
    for (const av of available) {
      const u = usedByName.get(av.name)
      if (u) consumedUsed.add(av.name)
      let status: CoverageStatus = 'unused'
      if (u && u.invokeCount > 0) status = 'invoked'
      else if (u && u.loadCount > 0) status = 'loaded'
      else if (u && u.dispatchCount > 0) status = 'dispatched'
      items.push({
        name: av.name,
        description: av.description,
        origin: av.origin,
        status,
        invokeCount: u?.invokeCount ?? 0,
        loadCount: u?.loadCount ?? 0,
        dispatchCount: u?.dispatchCount ?? 0,
      })
    }
    for (const u of used) {
      if (consumedUsed.has(u.skillName)) continue
      // 全集外按事件性质分账：skills 全集只声明 skill，dispatch 型子代理
      // （Task/Agent 工具的 subagent_type，定义来自 agents/ 目录或动态生成）
      // 本就不在 skills 注入段里 —— 纯 dispatch 归"子代理"，不算声明缺失；
      // 只有全集外的 invoke/load（skill 类动作）才是真正的"全集外"。
      const status: CoverageStatus = u.invokeCount > 0 || u.loadCount > 0
        ? 'extra'
        : 'dispatched'
      items.push({
        name: u.skillName,
        description: '',
        origin: null,
        status,
        invokeCount: u.invokeCount,
        loadCount: u.loadCount,
        dispatchCount: u.dispatchCount,
      })
    }
  } else {
    for (const u of used) {
      const status: CoverageStatus =
        u.invokeCount > 0 ? 'invoked' : u.loadCount > 0 ? 'loaded' : 'dispatched'
      items.push({
        name: u.skillName,
        description: '',
        origin: null,
        status,
        invokeCount: u.invokeCount,
        loadCount: u.loadCount,
        dispatchCount: u.dispatchCount,
      })
    }
  }

  // 未使用置顶：覆盖度看板的核心问题是"哪些没用上"
  const statusOrder: Record<CoverageStatus, number> = {
    unused: 0, invoked: 1, loaded: 2, dispatched: 3, extra: 4,
  }
  items.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name))

  const stats: CoverageStats = {
    availableTotal: available ? available.length : 0,
    invoked: items.filter(i => i.status === 'invoked').length,
    loaded: items.filter(i => i.status === 'loaded').length,
    dispatched: items.filter(i => i.status === 'dispatched').length,
    unused: items.filter(i => i.status === 'unused').length,
    extra: items.filter(i => i.status === 'extra').length,
    total: items.filter(i => i.status !== 'extra').length,
  }
  return { items, stats }
}
