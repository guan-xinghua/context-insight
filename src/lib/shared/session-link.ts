// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话深链单点（客户端/服务端通用，纯函数）。契约：framework 参数是 DB 行
// 的 recording class（捕获行带 -proxy 后缀），与 observe API 的
// (taskId, framework) 精确消歧同键——合法来源仅 DB 行本身（清单/比较页）
// 与导入结果回读（服务端刚建行）；导入前的源声明（lake meta 的 agent 裸名）
// 禁止预拼：捕获行入库时分类器会加 -proxy 记录类后缀，预拼链接必然 404，
// 而同 sid 双行下解析端模糊回退会静默跳错记录——消歧只能靠链接正确。
export function sessionHref(taskId: string, framework?: string | null): string {
  const fw = framework ? `?framework=${encodeURIComponent(framework)}` : '';
  return `/session/${encodeURIComponent(taskId)}${fw}`;
}

// 同一身份契约的 API 查询串形态（observe API 消歧参数）——凡按
// taskId+framework 取数的 fetch 一律走这里拼参，不内联手拼。
export function sessionQuery(taskId: string, framework?: string | null): string {
  const base = `taskId=${encodeURIComponent(taskId)}`;
  return framework ? `${base}&framework=${encodeURIComponent(framework)}` : base;
}
