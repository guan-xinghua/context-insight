// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/** 泳道车道键解析（纯函数，客户端/服务端皆可用）。
 *
 *  车道是工作流的业务概念（如 op-fusion 的 base/group/empty 三路并行），
 *  声明在 swimlane-lanes.json（范式 → 车道表），insight 不硬编码任何词。
 *  匹配对象 = 派发步骤文本（拆分条取该条桥的 dispatchContent；整段条取
 *  resolveSubagentIdentity().step，语义同源）。词边界匹配防 "database"
 *  误伤 "base"；声明序优先保证确定性；未命中返回 null（调用方回落贪心槽）。
 */
export function resolveLaneKey(step: string | null | undefined, lanes: string[]): string | null {
  if (!step || lanes.length === 0) return null
  for (const lane of lanes) {
    const safe = lane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![A-Za-z0-9_])${safe}(?![A-Za-z0-9_])`, 'i')
    if (re.test(step)) return lane
  }
  return null
}

/** 车道表内容签名推断（纯函数）。范式声明（湖目录）覆盖不了本地会话——
 *  未上湖/根级上传/通用目录（sessions/）的 paradigm 无从谈起，但派发描述
 *  （dispatchContent）是工作流结构的自述。对每张配置表算命中率：
 *  rate = 命中桥数 / 有效描述桥数（null/空白不进分母），双门槛
 *  rate ≥ 0.4 且不同车道 ≥ 2（实测正样本 0.71~0.88，负样本 0.00，
 *  阈值贴负样本侧留稀释余量；单车道命中是词频巧合，不算结构证据）。
 *  打分复用 resolveLaneKey——推断与落位同一把尺子，口径不可能分裂。
 *  多表过阈取 rate 最高，平分比不同车道数，再平按声明序（确定性）。
 */
export function inferLanes(
  contents: Array<string | null | undefined>,
  tables: Record<string, string[]>,
): { paradigm: string; lanes: string[] } | null {
  const texts = contents.filter((c): c is string => !!c?.trim())
  if (texts.length === 0) return null
  let best: { name: string; lanes: string[]; rate: number; distinct: number } | null = null
  for (const [name, lanes] of Object.entries(tables)) {
    const hits = texts.map(t => resolveLaneKey(t, lanes)).filter((l): l is string => l !== null)
    const distinct = new Set(hits).size
    const rate = hits.length / texts.length
    if (rate < 0.4 || distinct < 2) continue
    if (!best || rate > best.rate || (rate === best.rate && distinct > best.distinct)) {
      best = { name, lanes, rate, distinct }
    }
  }
  return best ? { paradigm: best.name, lanes: best.lanes } : null
}
