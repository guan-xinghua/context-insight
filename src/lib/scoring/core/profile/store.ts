// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// profile 文件存储：~/.cannbot-insight/scoring-profiles/<id>.json + active.json（激活指针，null=默认口径）。
// 坏文件跳过不阻塞；saveProfile 前统一 sanitizeProfile（硬错抛中文异常 → API 400，软伤进 warnings）。

import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CANNBOT_HOME } from '../store';
import { BUILTIN_DIMENSIONS } from '../../definitions';
import { applyProfile } from './apply';
import { findPreset, isPresetId } from './presets';
import { validateRuleSpec } from '../../user/rule-scorer';
import type { Band } from '../schema';
import type { RuleSpec } from '../../user/rule-scorer';
import { D1_LOCKED_ITEMS, EXCLUDE_DEGRADES } from './types';
import type { CustomItemSpec, ScoringProfile } from './types';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const CUSTOM_ID_RE = /^D[1-6]\.[a-z0-9][a-z0-9-]{0,39}$/;
const WEIGHTED_DIMS = ['D2', 'D3', 'D4', 'D5', 'D6'];
const CUSTOM_WEIGHT_REQUIRED = ['D4', 'D5'];

export function profilesDir(): string {
  if (process.env.SCORING_PROFILE_DIR) return process.env.SCORING_PROFILE_DIR;
  if (process.env.SCORING_DATA_DIR) return path.join(process.env.SCORING_DATA_DIR, 'scoring-profiles');
  return path.join(CANNBOT_HOME, 'scoring-profiles');
}

export interface SanitizeResult {
  profile: ScoringProfile;
  warnings: string[];
}

export function sanitizeProfile(v: unknown): SanitizeResult {
  if (!v || typeof v !== 'object') throw new Error('profile 必须是对象');
  const b = v as Record<string, unknown>;
  if (b['schema'] !== 'scoring-profile' || b['version'] !== 1) throw new Error('profile 格式不符（schema/version）');
  const id = b['id'];
  if (typeof id !== 'string' || isPresetId(id)) throw new Error('id 非法：kebab-case，且不能用 preset: 前缀');
  if (!ID_RE.test(id)) throw new Error('id 非法：小写字母/数字/连字符，2-41 位');
  const name = b['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 40) throw new Error('名称必填且 ≤40 字');

  const warnings: string[] = [];
  const knownIds = new Set(BUILTIN_DIMENSIONS.flatMap(d => d.items.map(i => i.id)));

  const dimensionWeights: Partial<Record<'D2' | 'D3' | 'D4' | 'D5' | 'D6', number>> = {};
  for (const [dim, w] of Object.entries((b['dimensionWeights'] ?? {}) as Record<string, unknown>)) {
    if (!WEIGHTED_DIMS.includes(dim)) {
      warnings.push(`已忽略非法维度权重：${dim}（D1 否决维无权重，D7 归自定义维度自己管）`);
      continue;
    }
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) throw new Error(`维度权重非法：${dim}（须为正数）`);
    dimensionWeights[dim as 'D2'] = w;
  }

  const excludedItems: string[] = [];
  for (const excluded of Array.isArray(b['excludedItems']) ? b['excludedItems'] : []) {
    if (typeof excluded !== 'string') throw new Error('excludedItems 含非字符串项');
    if (!knownIds.has(excluded)) {
      warnings.push(`已忽略失效子项：${excluded}（内置定义里不存在）`);
      continue;
    }
    if ((D1_LOCKED_ITEMS as readonly string[]).includes(excluded)) {
      throw new Error(`不可勾除：${excluded}（D1 否决证据链固定项）`);
    }
    const degrade = EXCLUDE_DEGRADES[excluded];
    if (degrade) warnings.push(degrade);
    if (!excludedItems.includes(excluded)) excludedItems.push(excluded);
  }

  const itemWeights: Record<string, number> = {};
  for (const [itemId, w] of Object.entries((b['itemWeights'] ?? {}) as Record<string, unknown>)) {
    if (!knownIds.has(itemId)) {
      warnings.push(`已忽略失效子项权重：${itemId}`);
      continue;
    }
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) throw new Error(`子项权重非法：${itemId}（须为正数）`);
    itemWeights[itemId] = w;
  }

  const customItems: CustomItemSpec[] = [];
  const suffixes = new Set<string>();
  for (const raw of Array.isArray(b['customItems']) ? b['customItems'] : []) {
    if (!raw || typeof raw !== 'object') throw new Error('customItems 含非对象项');
    const c = raw as Record<string, unknown>;
    const cid = c['id'];
    if (typeof cid !== 'string' || !CUSTOM_ID_RE.test(cid)) throw new Error('自定义项 id 非法：形如 D3.doc-sync（维度前缀 + kebab）');
    if (knownIds.has(cid)) throw new Error(`自定义项 id 冲突：${cid} 与内置子项重名`);
    const suffix = cid.split('.')[1]!;
    if (suffixes.has(suffix)) throw new Error(`自定义项 id 冲突：${suffix}`);
    suffixes.add(suffix);
    const target = cid.split('.')[0] as CustomItemSpec['targetDimension'];
    if (c['targetDimension'] !== target) throw new Error(`自定义项 ${cid} 的 targetDimension 与 id 前缀不一致`);
    const cname = c['name'];
    if (typeof cname !== 'string' || cname.trim().length === 0 || cname.length > 40) throw new Error(`自定义项 ${cid} 名称必填且 ≤40 字`);
    const kind = c['kind'];
    if (kind !== 'llm' && kind !== 'rule') throw new Error(`自定义项 ${cid} kind 必须是 llm 或 rule`);
    let bands: Band[] | undefined;
    let rule: RuleSpec | undefined;
    if (kind === 'llm') {
      const arr = c['bands'];
      if (!Array.isArray(arr) || arr.length < 2) throw new Error(`自定义项 ${cid} 需至少 2 档标准`);
      for (const band of arr) {
        if (!band || typeof band !== 'object') throw new Error(`自定义项 ${cid} 档位格式非法`);
        const bb = band as Record<string, unknown>;
        if (typeof bb['range'] !== 'string' || typeof bb['label'] !== 'string'
          || typeof bb['description'] !== 'string' || (bb['description'] as string).length < 4) {
          throw new Error(`自定义项 ${cid} 档位需 range/label/description（说明 ≥4 字）`);
        }
      }
      bands = arr as Band[];
    } else {
      if (!validateRuleSpec(c['rule'])) throw new Error(`自定义项 ${cid} 规则不合法`);
      rule = c['rule'] as RuleSpec;
    }
    let weight: number | undefined;
    const w = c['weight'];
    if (w != null) {
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) throw new Error(`自定义项 ${cid} 权重非法（须为正数）`);
      if (target === 'D1' || target === 'D2' || target === 'D6') {
        warnings.push(`已忽略自定义项 ${cid} 的权重：${target} 目标不按权重计`);
      } else {
        weight = w;
      }
    }
    if (CUSTOM_WEIGHT_REQUIRED.includes(target) && weight == null) {
      throw new Error(`自定义项 ${cid} 需填权重：${target} 内置子项标尺合计≈1，缺省 1 会喧宾夺主`);
    }
    customItems.push({
      id: cid,
      targetDimension: target,
      name: cname.trim(),
      kind,
      ...(bands ? { bands } : {}),
      ...(rule ? { rule } : {}),
      ...(weight != null ? { weight } : {}),
      ...(typeof c['note'] === 'string' && c['note'].trim().length > 0 ? { note: c['note'].trim() } : {}),
    });
  }

  const profile: ScoringProfile = {
    schema: 'scoring-profile',
    version: 1,
    id,
    name: name.trim(),
    ...(typeof b['note'] === 'string' && b['note'].trim().length > 0 ? { note: b['note'].trim() } : {}),
    ...(Object.keys(dimensionWeights).length > 0 ? { dimensionWeights } : {}),
    ...(excludedItems.length > 0 ? { excludedItems } : {}),
    ...(Object.keys(itemWeights).length > 0 ? { itemWeights } : {}),
    ...(customItems.length > 0 ? { customItems } : {}),
  };
  return { profile, warnings };
}

export async function loadProfiles(): Promise<ScoringProfile[]> {
  try {
    const dir = profilesDir();
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json') && f !== 'active.json');
    const out: ScoringProfile[] = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')) as unknown;
        const b = raw as Record<string, unknown>;
        if (b['schema'] === 'scoring-profile' && b['version'] === 1
          && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
          out.push(raw as ScoringProfile);
        }
      } catch { /* 坏文件跳过，不阻塞 */
      }
    }
    out.sort((a, b2) => a.name.localeCompare(b2.name));
    return out;
  } catch {
    return [];
  }
}

export async function saveProfile(v: unknown): Promise<SanitizeResult> {
  const sanitized = sanitizeProfile(v);
  const dir = profilesDir();
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${sanitized.profile.id}.json`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(sanitized.profile, null, 2), 'utf-8');
  await fs.rename(tmp, target);
  return sanitized;
}

export async function deleteProfile(id: string): Promise<void> {
  if (isPresetId(id)) throw new Error('内置模板不可删除');
  if (!ID_RE.test(id)) throw new Error('非法 profile id');
  await fs.rm(path.join(profilesDir(), `${id}.json`), { force: true });
}

export async function getActiveId(): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(profilesDir(), 'active.json'), 'utf-8')) as unknown;
    const b = raw as Record<string, unknown>;
    if (b['schema'] === 'scoring-profile-active' && b['version'] === 1
      && (typeof b['activeId'] === 'string' || b['activeId'] === null)) {
      return b['activeId'] as string | null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setActiveId(activeId: string | null): Promise<void> {
  const dir = profilesDir();
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'active.json');
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ schema: 'scoring-profile-active', version: 1, activeId }, null, 2), 'utf-8');
  await fs.rename(tmp, target);
}

export async function loadActiveProfile(): Promise<ScoringProfile | null> {
  const activeId = await getActiveId();
  if (activeId == null) return null;
  if (isPresetId(activeId)) return findPreset(activeId);
  const profiles = await loadProfiles();
  return profiles.find(p => p.id === activeId) ?? null;
}

export async function activeApplyWarnings(): Promise<string[]> {
  return applyProfile(BUILTIN_DIMENSIONS, await loadActiveProfile()).warnings;
}
