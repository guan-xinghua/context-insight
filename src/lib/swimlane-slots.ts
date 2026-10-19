// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/** 泳道槽位分配（纯函数，从 AgentSwimlaneV2 抽出便于函数级 IT）。
 *
 *  现状（保留为无车道时的行为）：全部条子按开始时间贪心放进「最早空闲」槽。
 *  车道模式：声明车道按序各占 ⌈车道内部真实并发⌉ 个连续槽（车道池），命中
 *  车道的条子只进本车道池；未分类条在剩余槽贪心装填，不够时追加贪心槽。
 *  车道是工作流业务概念（op-fusion 的 base/group/empty），非车道会话零变化。
 */
export interface SlotSpan {
  key: string
  start: number
  end: number
  laneKey?: string | null
}

export interface LaneSlotAssignment {
  /** 条子 key → 槽下标 */
  slotOf: Map<string, number>
  /** 每槽标签：车道池 = 车道名；贪心槽 = slotN */
  labels: string[]
}

function internalConcurrency(spans: Array<{ start: number; end: number }>): number {
  const evts: Array<{ t: number; d: number }> = []
  for (const s of spans) {
    if (s.end <= s.start) continue
    evts.push({ t: s.start, d: 1 }, { t: s.end, d: -1 })
  }
  evts.sort((a, b) => a.t - b.t || a.d - b.d)
  let cur = 0, max = 0
  for (const e of evts) { cur += e.d; if (cur > max) max = cur }
  return max
}

/** 真实最大并发（端点扫掠；端点相接不算并发——end 先于 start 处理） */
export function computeMaxConcurrency(spans: Array<{ start: number; end: number }>): number {
  return Math.max(internalConcurrency(spans), 1)
}

export function assignLaneSlots(spans: SlotSpan[], lanes: string[]): LaneSlotAssignment {
  const sorted = [...spans].sort((a, b) => a.start - b.start || (a.key < b.key ? -1 : 1))
  const slotOf = new Map<string, number>()
  const labels: string[] = []

  // ① 车道池：声明序，仅对数据中真实出现的车道开池；池紧邻排布
  const poolSpans = new Map<string, Array<SlotSpan>>()
  for (const lane of lanes) {
    const hit = sorted.filter(s => s.laneKey === lane)
    if (hit.length > 0) poolSpans.set(lane, hit)
  }
  let poolCount = 0
  for (const [lane, hit] of poolSpans) {
    const size = Math.max(1, internalConcurrency(hit))
    const poolFreeAt = new Array<number>(size).fill(Number.NEGATIVE_INFINITY)
    for (const s of hit) {
      let idx = poolFreeAt.findIndex(f => f <= s.start)
      if (idx === -1) idx = 0
      poolFreeAt[idx] = s.end
      slotOf.set(s.key, poolCount + idx)
    }
    poolCount += size
    for (let i = 0; i < size; i++) labels.push(lane)
  }

  // ② 未分类条：贪心槽紧随车道池之后装填，不够时追加（标签 slotN 从 1 续编号）
  const rest = sorted.filter(s => !s.laneKey || !poolSpans.has(s.laneKey))
  const greedyFreeAt: number[] = []
  let greedySeq = 1
  for (const s of rest) {
    let idx = greedyFreeAt.findIndex(f => f <= s.start)
    if (idx === -1) {
      idx = greedyFreeAt.length
      greedyFreeAt.push(Number.NEGATIVE_INFINITY)
      labels.push(`slot${greedySeq++}`)
    }
    greedyFreeAt[idx] = s.end
    slotOf.set(s.key, poolCount + idx)
  }
  return { slotOf, labels }
}
