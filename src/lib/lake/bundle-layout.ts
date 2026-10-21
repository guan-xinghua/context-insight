// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// bundle 仓内布局单点（叶子模块，server/client 共用——lake_viewer 特判与
// mirror/编排层同源，禁止散落字面量）。

/** 数据仓顶层 bundle 专区目录名（与会话范式目录并列，首传自动创建）。 */
export const BUNDLE_ROOT_DIR = 'opsbot-bundle';

/** bundle 锚定文件：专区下一级目录含它即 bundle（列表只认锚定目录）。 */
export const BUNDLE_MANIFEST_FILE = 'workflow.json';

/** lake 侧归属快照（cc-bundle-meta，x_cannbay 信封；上传时合成）。 */
export const BUNDLE_META_FILE = 'bundle.meta.json';
