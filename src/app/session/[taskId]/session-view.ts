// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话页视图状态层：单点管理「你在看会话的哪个位置」及其两种表达（React
// state 权威 + URL 镜像）的全部读写路径。
//
// 双源契约（选中态权威在用户）：
// - state 是渲染权威；URL 是深链/分享/刷新的入口快照，不是权威源——手动
//   选中不被 URL 弹回（turn 深链 once-per-value，防 5s 自动同步 setTurns
//   重放），tab 内选中也不回写 URL
// - navigate() 写 URL；select() 不碰 URL
//
// history 策略（单点）：会话页整体只占一条浏览器历史——切 tab / 跨 tab
// 跳转一律 router.replace（URL 原位更新，地址栏仍反映当前视图），Back
// （页内按钮与浏览器返回键）直接回到上一个大页面，而非在 tab 间逐级回退。
// 若未来某类跳转需要成为「地方」（如 turn 详情独立 history 条目），只改
// navigate 的策略，不动调用方。
//
// export bundle 兼容：仅依赖 next/navigation 的 useRouter/useSearchParams
// 接口（嵌入式 shim 为 no-op/静态实现），不引入其他 router 能力。
//
// 职责边界：本层只管跨 tab 的「位置」（tab/turn 定位/高亮/滚动动作），不管
// tab 内受控状态（如 Audit 板块的子 tab/选中项）与任何数据态——数据经
// resolveTurn/resolveTurnIndex 注入，本层不感知数据形态。

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import type { TurnHighlight } from "@/lib/shared/highlight"

export type TabKey =
  | "overview"
  | "turns"
  | "wireRounds"
  | "trace"
  | "skills"
  | "workflowAnalyse"
  | "performance"
  | "context"
  | "scoring"
  | "fileReads"
  | "replay"

/** 全量 tab 键（含默认隐藏的调试视图）：深链/恢复的合法值域，与 page 的
 * ALL_TABS 渲染表同源——新增 tab 时 TabKey 联合类型强制两处同步 */
export const KNOWN_TABS: readonly TabKey[] = [
  "overview",
  "turns",
  "wireRounds",
  "trace",
  "context",
  "workflowAnalyse",
  "performance",
  "skills",
  "fileReads",
  "replay",
  "scoring",
]

export const DEFAULT_TAB: TabKey = "overview"

export function isKnownTab(v: string | null | undefined): v is TabKey {
  return v != null && (KNOWN_TABS as readonly string[]).includes(v)
}

/** 视图状态。tab 与 turnId 进 URL 镜像（?tab= / ?turn=），其余为纯 state */
export type SessionView = {
  tab: TabKey
  /** 受控选中轮（Turns 时间线 / Trace 共用）；URL ?turn= 的镜像源 */
  turnId: string | null
  /** 子代理 lane 高亮。双形态契约（TurnTimeline）：turnId 或
   * subagentSessionId 皆可，消费侧两种都认 */
  subagentHighlightId: string | null
  /** Trace→Turns 跳转携带的来源高亮 */
  traceHighlight: TurnHighlight | null
  /** 滚动定位动作（粘滞到下一次导航/选中，由选中路径清除；
   * TurnTimeline effect 消费） */
  scrollTargetTurnId: string | null
}

/** 跳转补丁：「去某处看」。tab/turnId 写 URL 镜像（replace）。
 * 字段语义：undefined = 不动；turnId 只接受 string（跳转定位必带目标，
 * 「清选中」不属于跳转语义）；subagentHighlightId 显式给出时覆盖派生值
 * （AgentCallGraph 按 lane 定位的场景） */
export type NavigatePatch = {
  tab?: TabKey
  turnId?: string
  subagentHighlightId?: string | null
  traceHighlight?: TurnHighlight | null
}

/** 选中补丁：「tab 内调整」。纯 state，URL 不动 */
export type SelectPatch = {
  turnId?: string
  subagentHighlightId?: string | null
  traceHighlight?: TurnHighlight | null
  scrollTargetTurnId?: string | null
}

/** 视图层需要的最小数据投影：数据（turns 数组）留在页面 */
export type TurnRef = { isSubagent: boolean }

export type SessionViewHandle = {
  view: SessionView
  navigate: (patch: NavigatePatch) => void
  select: (patch: SelectPatch) => void
}

export function useSessionView(opts: {
  resolveTurn: (turnId: string) => TurnRef | undefined
  resolveTurnIndex: (turnIndex: number) => (TurnRef & { turnId: string }) | undefined
  turnsReady: boolean
}): SessionViewHandle {
  const { resolveTurn, resolveTurnIndex, turnsReady } = opts
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get("tab")
  const turnParam = searchParams.get("turn")
  const errorTurnParam = searchParams.get("errorTurn")

  const [view, setView] = useState<SessionView>(() => ({
    tab: isKnownTab(tabParam) ? tabParam : DEFAULT_TAB,
    turnId: null,
    subagentHighlightId: null,
    traceHighlight: null,
    scrollTargetTurnId: null,
  }))

  // —— 写路径①：跳转（state 合并 + URL replace，history 策略单点）——
  const navigate = useCallback((patch: NavigatePatch) => {
    setView(v => {
      const next = { ...v }
      if (patch.tab != null) next.tab = patch.tab
      if (patch.turnId != null) {
        next.turnId = patch.turnId
        next.scrollTargetTurnId = patch.turnId
        const t = resolveTurn(patch.turnId)
        next.subagentHighlightId = patch.subagentHighlightId !== undefined
          ? patch.subagentHighlightId
          : t?.isSubagent === true
            ? patch.turnId
            : null
      } else if (patch.subagentHighlightId !== undefined) {
        next.subagentHighlightId = patch.subagentHighlightId
      }
      if (patch.traceHighlight !== undefined) next.traceHighlight = patch.traceHighlight
      return next
    })
    const p = new URLSearchParams(searchParams.toString())
    if (patch.tab != null) p.set("tab", patch.tab)
    if (patch.turnId != null) p.set("turn", patch.turnId)
    else p.delete("turn")
    router.replace(`?${p.toString()}`, { scroll: false })
  }, [router, searchParams, resolveTurn])

  // —— 写路径②：tab 内选中（纯 state，URL 不动）——
  const select = useCallback((patch: SelectPatch) => {
    setView(v => {
      const next = { ...v }
      if (patch.turnId !== undefined) next.turnId = patch.turnId
      if (patch.subagentHighlightId !== undefined) next.subagentHighlightId = patch.subagentHighlightId
      if (patch.traceHighlight !== undefined) next.traceHighlight = patch.traceHighlight
      if (patch.scrollTargetTurnId !== undefined) next.scrollTargetTurnId = patch.scrollTargetTurnId
      return next
    })
  }, [])

  // —— 读路径①：tab 随 URL 恢复（popstate/换参/深链；非法值回落 overview）——
  useEffect(() => {
    const next = isKnownTab(tabParam) ? tabParam : DEFAULT_TAB
    setView(v => (v.tab === next ? v : { ...v, tab: next }))
  }, [tabParam])

  // —— 读路径②：turn 深链，同一深链值只应用一次。turnsReady 留在依赖里是
  // 为等数据加载完成，但 5s 自动同步的 setTurns 会重放本 effect——appliedRef
  // 挡住重放，把选中态/高亮/滚动弹回 URL 旧轮；换一个 turn 深链（值变化）
  // 才重新应用 ——
  const appliedTurnParamRef = useRef<string | null>(null)
  useEffect(() => {
    if (!turnParam || !turnsReady) return
    if (appliedTurnParamRef.current === turnParam) return
    const t = resolveTurn(turnParam)
    if (t) {
      appliedTurnParamRef.current = turnParam
      select({
        turnId: turnParam,
        subagentHighlightId: t.isSubagent ? turnParam : null,
        scrollTargetTurnId: turnParam,
      })
    }
  }, [turnParam, turnsReady, resolveTurn, select])

  // —— 读路径③：errorTurn 深链（turnIndex 形态，Overview 错误卡入口）：
  // 数据就绪后跳 turns 并定位；已有选中（如 turn 深链先到）不抢。统一走
  // navigate——地址栏订正为真实视图（?tab=turns&turn=），replace 零 history
  // 条目，对读路径①②幂等。view.turnId 在依赖里：选中变化会重放本 effect，
  // 但 appliedRef/选中守卫使其成为 no-op（不抢用户已选） ——
  const appliedErrorTurnRef = useRef(false)
  useEffect(() => {
    if (!errorTurnParam || !turnsReady || appliedErrorTurnRef.current) return
    if (view.turnId != null) return
    const t = resolveTurnIndex(Number(errorTurnParam))
    if (t) {
      appliedErrorTurnRef.current = true
      navigate({ tab: "turns", turnId: t.turnId })
    }
  }, [errorTurnParam, turnsReady, resolveTurnIndex, navigate, view.turnId])

  return { view, navigate, select }
}
