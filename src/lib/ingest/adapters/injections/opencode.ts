// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details.
// You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 家族（opencode / cannbot，CANN fork 同源）的 user 行注入指纹。
// opencode 把 skill 规程作为 user 消息注入（≥1.17 也会注入首条），指纹与
// claude-code Skills 同格式——复用 injections/claude-code.ts 的谓词。
// 任务派发/完成通知在 opencode 体系走 tool 结果而非独立 user 行，无
// task-notification 类指纹。
import type { UserInjectionClassifier } from '../contract';
import { isSkillInjectionText } from './claude-code';

export const classifyOpencodeFamilyUserInjection: UserInjectionClassifier = (raw, ctx) => {
  if (ctx.isFirstTurn || !isSkillInjectionText(raw)) return null;
  return { action: 'system-turn', kind: 'skill', content: raw };
};
