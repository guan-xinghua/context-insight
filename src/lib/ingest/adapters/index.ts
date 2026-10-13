// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 门面：注册表迁往 registry.ts（agent-source-framework），本文件保持既有
// import 路径与 getAdapter/Adapter 兼容导出。新代码直接 import registry。

import type { SessionListItem, RawInteraction } from '../../shared/types';
import { requireSource } from './registry';

export type { SourceDescriptor, SubagentRef } from './contract';
export {
  SOURCES,
  KNOWN_SOURCE_TYPES,
  getSource,
  requireSource,
  isKnownSource,
  frameworkOfSource,
  sourceOfFramework,
  sniffImportableFile,
} from './registry';

/** @deprecated 旧 Adapter 形状（仅 listSessions/readSession）。新代码用
 * SourceDescriptor（contract.ts）——身份/子代理/嗅探等能力声明都在那边。 */
export interface Adapter {
  listSessions(dbPath: string): SessionListItem[];
  readSession(dbPath: string, sessionId: string): RawInteraction[];
}

/** @deprecated 用 registry.getSource / requireSource。 */
export function getAdapter(sourceType: string): Adapter {
  // 旧契约：未知源抛错（requireSource 单点产出支持清单），不返回 null
  const found = requireSource(sourceType);
  return { listSessions: found.listSessions, readSession: found.readSession };
}
