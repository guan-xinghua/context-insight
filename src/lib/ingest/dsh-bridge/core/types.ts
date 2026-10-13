// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/** DSH 原生会话日志（`session.v4.jsonl.zstd` 的首行）——会话头，
 *  血缘与归属的权威来源（`parentSession` 只在原生日志里，wire 上没有）。 */
export interface DshSessionHeader {
  type: 'session';
  version: number;
  /** 主会话形如 `session-<uuid>`；子代理为裸 `<uuid>`。 */
  id: string;
  createdAt: number;
  cwd?: string;
  /** 父会话 id —— 子代理建链的权威依据。 */
  parentSession?: string;
  origin?: 'subagent';
  delegationDepth?: number;
  agentPreset?: string;
  isSeeded?: boolean;
  [key: string]: unknown;
}

/** 会话头之后每行一个事件。 */
export interface DshEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  /** 在事件顶层，不在 data 内。 */
  surfaceOp?: 'append' | 'replace';
  sourceEventSeqs?: number[];
  [key: string]: unknown;
}

export interface DecodeDshLogResult {
  header: DshSessionHeader;
  events: DshEvent[];
  warnings: string[];
}
