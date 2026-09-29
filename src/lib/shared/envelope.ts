// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 捕获/导出 jsonl 的扩展字段信封（声明式分发口袋）：新键 x_lake，旧键
// x_cannbay 读兜底（线上存量数据零迁移——P3 双名决议）。写侧双写过渡
// （老版本读方不丢），下个大版本退役旧键。中立位置（shared/）——ingest
// 与 lake 两域都可引，无环。

export const ENVELOPE_KEY = 'x_lake';
export const ENVELOPE_KEY_LEGACY = 'x_cannbay';

export interface Envelope {
  schema: string;
  version: number;
  data: Record<string, unknown>;
}

function asEnvelope(v: unknown): Envelope | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const e = v as Partial<Envelope>;
  if (typeof e.schema !== 'string' || typeof e.version !== 'number' || !e.data || typeof e.data !== 'object') {
    return undefined;
  }
  return e as Envelope;
}

/** 双名读：x_lake 优先，x_cannbay 兜底；形态不合法按无信封处理 */
export function readEnvelope(holder: unknown): Envelope | undefined {
  if (!holder || typeof holder !== 'object') return undefined;
  const h = holder as Record<string, unknown>;
  return asEnvelope(h[ENVELOPE_KEY]) ?? asEnvelope(h[ENVELOPE_KEY_LEGACY]);
}

/** 双名写：同一信封对象挂两个键（返回写好的口袋对象，调用方展开进行对象） */
export function envelopeFields(envelope: Envelope): Record<string, Envelope> {
  return { [ENVELOPE_KEY]: envelope, [ENVELOPE_KEY_LEGACY]: envelope };
}
