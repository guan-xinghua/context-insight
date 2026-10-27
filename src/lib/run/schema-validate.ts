// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { WORKFLOW_SCHEMA_FILE } from './model';

export interface BundleSchemaResult {
  ok: boolean;
  errors: string[];
}

const TRUSTED_SCHEMA_SHA256 = '96e1849c164abed1163a08fef866c8c204caa70'
  + 'a2812ed91c13ac38d8c9c8d07';

const validators = new Map<string, Ajv.ValidateFunction>();

/** 只使用哈希已登记的包内 schema 校验 manifest。 */
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

  let schemaText: string;
  let schemaJson: unknown;
  try {
    schemaText = fs.readFileSync(schemaPath, 'utf-8');
    schemaJson = JSON.parse(schemaText);
  } catch (e) {
    return {
      ok: false,
      errors: [`workflow.schema.json 不可解析: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const digest = createHash('sha256').update(schemaText, 'utf-8').digest('hex');
  if (digest !== TRUSTED_SCHEMA_SHA256) {
    return { ok: false, errors: ['workflow.schema.json 与 Insight 信任的 schema 哈希不一致'] };
  }

  let validate = validators.get(digest);
  if (!validate) {
    try {
      validate = new Ajv({ allErrors: true }).compile(schemaJson as object);
      validators.set(digest, validate);
    } catch (e) {
      return {
        ok: false,
        errors: [`workflow.schema.json 编译失败: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
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
