// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 用包内 workflow.schema.json（draft-07）校验 workflow.json 结构。
// 结构/枚举/条件必填交给 ajv——单一权威随包分发，insight 不再手写结构
// 与 opsbot 比对着漂移；reader 只保留 JSON Schema 表达不了的跨节点检查
// （成员 id 全树唯一、关系端点解析）与 version 闸。包内缺 schema 文件
// 直接失败（不回落手写）——旧导出件不支持。

import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { WORKFLOW_SCHEMA_FILE } from './model';

export interface BundleSchemaResult {
  ok: boolean;
  errors: string[];
}

// draft-07（ajv 6 默认 meta-schema）；allErrors 展开 oneOf 分支错误，下钻叶子定位真因
const AJV = new Ajv({ allErrors: true });

/** 用包内 schema 校验；缺 schema 文件或结构不符都返回 ok:false。 */
export function validateWithBundleSchema(
  dirPath: string,
  manifest: unknown,
): BundleSchemaResult {
  const schemaPath = path.join(dirPath, WORKFLOW_SCHEMA_FILE);
  if (!fs.existsSync(schemaPath)) {
    return {
      ok: false,
      errors: [`缺少 ${WORKFLOW_SCHEMA_FILE}（结构权威随包分发，旧导出件不支持）`],
    };
  }

  let schemaJson: unknown;
  try {
    schemaJson = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  } catch (e) {
    return {
      ok: false,
      errors: [`workflow.schema.json 不可解析: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  let validate: Ajv.ValidateFunction;
  try {
    validate = AJV.compile(schemaJson as object);
  } catch (e) {
    return {
      ok: false,
      errors: [`workflow.schema.json 编译失败: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (validate(manifest)) return { ok: true, errors: [] };
  return { ok: false, errors: summarizeErrors(validate.errors) };
}

/** oneOf 展开大量分支错误：按 (dataPath, keyword) 去重、按路径深度降序取最具体的前若干条。 */
function summarizeErrors(errors: Ajv.ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['结构校验失败'];
  const seen = new Set<string>();
  const flat: Array<{ depth: number; text: string }> = [];
  for (const e of errors) {
    const at = e.dataPath || '(root)';
    const key = `${at}\u0000${e.keyword}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flat.push({ depth: at.split('/').length, text: `${at} ${e.message ?? 'invalid'}` });
  }
  flat.sort((a, b) => b.depth - a.depth);
  return flat.slice(0, 10).map(f => f.text);
}
