// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据仓导入 UI 共享 helper：会话导入（LocalFileImport）与 bundle 导入
// （BundleImport）共用——导入入口归一基础。

/** lake 路由错误（带结构化 code）：凭据类错误附弹窗指引，其余原样。 */
export function lakeErrorMessage(data: { error?: string; code?: string }): string {
  const base = String(data.error ?? "Import failed");
  if (["no-credentials", "auth-failed", "forbidden"].includes(data.code ?? "")) {
    return `${base} —— 请在弹窗中配置凭据后重试`;
  }
  return base;
}
