// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/** 子代理身份双字段统一解析：subagent_type（如 design-tiling-splitter）+
 *  派发步骤（Task description，如「⑦ group 同步」）。
 *
 *  四形态（claude/opencode × cpx/原生）可靠源不同：
 *  - subagentType：唯一运行时源是 root 派发 toolCall args 的 subagent_type，
 *    已结构化落 Bridge.subagentType（cpx meta.agentType 进过 TurnRow 但写库
 *    前被剥，DB 无列）。
 *  - 步骤：proxy 形态 Turn.subagentName 即 cpx meta.name = Task description，
 *    自证身份、不依赖桥锚定（桥锚定错位时仍正确）；原生形态 subagentName
 *    泛化（claude native 为 "design"、opencode title 正则截断），取
 *    Bridge.dispatchContent（= args.description ?? summary ?? prompt）。
 */
export interface SubagentIdentity {
  subagentType: string | null;
  step: string | null;
}

function flatten(v: string | null | undefined): string | null {
  const cleaned = v?.replace(/[\n\r]+/g, ' ').trim();
  return cleaned ? cleaned : null;
}

/** 派发是否后台异步。两条判据（任一命中）：
 *  ①参数侧（调用方显式指定）：opencode task/subagent 的 background
 *    （1.18/2.x 均支持）、claude Agent 的 run_in_background（2025-12 起
 *    async subagents 一等公民，SDK 侧默认后台）。
 *  ②result 侧（claude 2.1 现场实测：args 无参数也异步，标志只在 result）：
 *    "Async agent launched successfully. (This tool result is internal
 *    metadata …)"——立即返回、无产物。opencode 后台形态（<task id
 *    state="running"> / "(sessionID: …)"）同理由 result 判。
 *  异步生命周期：派发立即返回，完成后以通知消息喂回父会话。 */
export function isBackgroundDispatch(
  argsJson: string | null | undefined,
  resultJson?: string | null | undefined,
): boolean {
  if (argsJson) {
    try {
      const a = JSON.parse(argsJson) as { background?: unknown; run_in_background?: unknown }
      const bg = a?.background ?? a?.run_in_background
      if (bg === true || bg === "true") return true
    } catch { /* fallthrough */ }
  }
  if (!resultJson) return false
  // JSON 内容块数组形态里引号转义成 \" —— 与 dispatch-tools 的 task-id-xml
  // 同款双引号容忍
  return /Async agent launched/.test(resultJson)
    || /working in the background/.test(resultJson)
    || /<task\s+id=[^>]*state=\\?"running/.test(resultJson);
}

export function resolveSubagentIdentity(src: {
  subagentName?: string | null;
  bridge?: { subagentType?: string | null; dispatchContent?: string | null } | null;
  isProxy?: boolean;
}): SubagentIdentity {
  const name = flatten(src.subagentName);
  const dispatch = flatten(src.bridge?.dispatchContent);
  return {
    subagentType: src.bridge?.subagentType ?? null,
    step: src.isProxy && name ? name : (dispatch ?? name),
  };
}
