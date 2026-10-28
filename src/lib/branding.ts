// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

const BRAND_NAME = "Context-Insight"
const BRAND_SLUG = BRAND_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")
const BRAND_DESCRIPTION = `${BRAND_NAME} — LLM Agent Session Observability`
const BRAND_CONFIG_DIR_SUFFIX = `.${BRAND_SLUG}`
const BRAND_CLI_ALIAS = "ctxi"

// 数据格式标识 —— 恒为 "context-insight"（cannbot 变体打包期不翻转，
// 见 scripts/pack-cannbot.mjs 的契约保留边界）
const BRAND_SOURCE_TYPE = "context-insight"

// 存量数据读侧兜底：容器身份冒充期落库的 framework 旧值 "cannbot-insight"
// （≤0.2.40 品牌）——只读不写，新数据一律写 BRAND_SOURCE_TYPE。读侧把它与
// 当前值同义识别，避免品牌更名把存量误标行误判为空显示/非已知源。
const BRAND_SOURCE_TYPE_LEGACY = "cannbot-insight"

// 品牌更名前的旧数据目录（≤0.2.40）：git-lfs 私有件跨代复用探测清单——
// 旧目录里 pin 同版本的健康二进制直接拷贝，免去更名后重复下载
const BRAND_LEGACY_CONFIG_DIRS = [".cannbot-insight"]

/** framework/sourceType 是否品牌容器标识（含存量旧值读侧兼容）。 */
function isBrandSourceType(value: string | null | undefined): boolean {
  return value === BRAND_SOURCE_TYPE || value === BRAND_SOURCE_TYPE_LEGACY
}

// 数据湖显示名：context 主体用 "contextBay"，cannbot 变体经 pack-cannbot 翻转为 "CANNbay"
const BAY_NAME = "contextBay"

// viewer 页显示名（首页入口按钮 + viewer 标题）
const BAY_VIEWER_NAME = "contextBay Viewer"

export { BRAND_NAME, BRAND_SLUG, BRAND_DESCRIPTION, BRAND_CONFIG_DIR_SUFFIX, BRAND_CLI_ALIAS, BRAND_SOURCE_TYPE, BRAND_SOURCE_TYPE_LEGACY, BRAND_LEGACY_CONFIG_DIRS, BAY_NAME, BAY_VIEWER_NAME, isBrandSourceType }
