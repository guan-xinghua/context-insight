// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// D7 用户自定义维度加载器（组模型）：~/.cannbot-insight/user-definitions/<groupId>.group.json，
// 一个组 = 一套标准（如「文档质量组」「算子专项组」），组内维度一条条增删改。
// enabled=false 的组只留存不参评。旧版扁平 <id>.json 首次读取时一次性并入「默认组」。
// 评分是后端执行的，定义必须后端读得到（已定；localStorage 后端不可见，排除）。
// 用户只写标准（名称 + 每档大白话 + 进不进总分），prompt/校验/页面文案全从它生成——
// 一源多用，学 MLflow make_judge 的路子。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CANNBOT_HOME, migrateLegacyDir } from '../core/store';
import type { Band, DimensionDefinition, ScoreItemSchema } from '../core/schema';
import { Scorer } from '../core/scorer';
import { BandJudgeScorer } from '../core/judge';
import { UserRuleScorer, validateRuleSpec } from './rule-scorer';

export interface UserDimensionFile {
  id: string;                 // 短横线 kebab-case，跨组全局唯一（D7.<id> 是评分键）
  name: string;               // '文档更新及时性'
  description?: string;       // 一句话评什么
  /** 维度类型：llm（默认，旧文件无 kind 即此）= 写标准由 LLM 评审；rule = 声明式规则判定（零 LLM） */
  kind?: 'llm' | 'rule';
  bands?: Band[];             // kind=llm：0-10 五档，每档大白话
  rule?: import('./rule-scorer').RuleSpec;   // kind=rule：信号 × 比较
  includeInTotal?: boolean;   // 默认 false 只展示
  weight?: number;            // includeInTotal 时的权重
}

export interface UserGroup {
  id: string;                 // 短横线 kebab-case
  name: string;               // '文档质量组'
  description?: string;
  enabled?: boolean;          // 默认 true；false = 只留存不参评
  dimensions: UserDimensionFile[];
}

let legacyUserDefsMigrated = false;

export function userDefinitionsDir(): string {
  if (process.env.SCORING_USER_DEF_DIR) return process.env.SCORING_USER_DEF_DIR;
  if (!legacyUserDefsMigrated) {
    legacyUserDefsMigrated = true;
    migrateLegacyDir(path.join(process.cwd(), 'data', 'scoring', 'user-definitions'), path.join(CANNBOT_HOME, 'user-definitions'));
  }
  return path.join(CANNBOT_HOME, 'user-definitions');
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function isValidUserDimension(v: unknown): v is UserDimensionFile {
  if (!v || typeof v !== 'object') return false;
  const u = v as Partial<UserDimensionFile>;
  if (typeof u.id !== 'string' || !ID_RE.test(u.id)) return false;
  if (typeof u.name !== 'string' || u.name.length === 0 || u.name.length > 40) return false;
  if (u.kind === 'rule') {
    return validateRuleSpec(u.rule);
  }
  // llm（默认）：需 ≥2 档且每档有大白话
  if (!Array.isArray(u.bands) || u.bands.length < 2) return false;
  for (const b of u.bands) {
    if (!b || typeof b !== 'object') return false;
    const bb = b as Partial<Band>;
    if (typeof bb.range !== 'string' || typeof bb.label !== 'string' || typeof bb.description !== 'string') return false;
    if (bb.description.length < 4) return false;
  }
  return true;
}

export function isValidUserGroup(v: unknown): v is UserGroup {
  if (!v || typeof v !== 'object') return false;
  const g = v as Partial<UserGroup>;
  if (typeof g.id !== 'string' || !ID_RE.test(g.id)) return false;
  if (typeof g.name !== 'string' || g.name.length === 0 || g.name.length > 40) return false;
  if (!Array.isArray(g.dimensions)) return false;
  return g.dimensions.every(isValidUserDimension);
}

/** 旧版扁平 <id>.json（一文件一维度）→ 并入「默认组」，一次性 */
async function migrateFlatFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const flats = names.filter(n => n.endsWith('.json') && !n.endsWith('.group.json'));
  if (flats.length === 0) return;
  const defaultGroup: UserGroup = { id: 'default', name: '默认组', description: '旧版扁平定义自动并入', dimensions: [] };
  // 已有默认组则追加（按维度 id 去重）
  const groupFile = path.join(dir, 'default.group.json');
  try {
    const prev = JSON.parse(await fs.readFile(groupFile, 'utf-8')) as UserGroup;
    if (isValidUserGroup(prev)) defaultGroup.dimensions.push(...prev.dimensions);
  } catch { /* 无既有默认组 */ }
  const existing = new Set(defaultGroup.dimensions.map(d => d.id));
  for (const name of flats) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8')) as unknown;
      if (isValidUserDimension(parsed) && !existing.has(parsed.id)) {
        defaultGroup.dimensions.push(parsed);
        existing.add(parsed.id);
      }
      await fs.rm(path.join(dir, name), { force: true });
    } catch { /* 单文件损坏跳过 */ }
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(groupFile, JSON.stringify(defaultGroup, null, 2), 'utf-8');
}

/** 全部组（含未启用的）；旧扁平文件自动迁移 */
export async function loadUserGroups(dir: string = userDefinitionsDir()): Promise<UserGroup[]> {
  await migrateFlatFiles(dir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: UserGroup[] = [];
  for (const name of names) {
    if (!name.endsWith('.group.json')) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8')) as unknown;
      if (isValidUserGroup(parsed)) out.push(parsed);
    } catch { /* 单文件损坏跳过 */ }
  }
  return out;
}

/** 参评的维度（启用组的全部维度，注册表消费） */
export async function loadUserDefinitions(dir: string = userDefinitionsDir()): Promise<UserDimensionFile[]> {
  const groups = await loadUserGroups(dir);
  return groups.filter(g => g.enabled !== false).flatMap(g => g.dimensions);
}

/** 保存组（整组 upsert）；校验：组与维度合法、维度 id 跨组全局唯一（D7.<id> 是评分键） */
export async function saveUserGroup(group: UserGroup, dir: string = userDefinitionsDir()): Promise<void> {
  if (!isValidUserGroup(group)) throw new Error('自定义组格式不合法（需 id/name，每个维度需 id/name/bands 且每档有大白话说明）');
  const others = (await loadUserGroups(dir)).filter(g => g.id !== group.id);
  const seen = new Set(others.flatMap(g => g.dimensions.map(d => d.id)));
  for (const d of group.dimensions) {
    if (seen.has(d.id)) throw new Error(`维度 id 冲突：「${d.id}」已在其他组存在（D7.<id> 是评分键，需全局唯一）`);
    seen.add(d.id);
  }
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${group.id}.group.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(group, null, 2), 'utf-8');
  await fs.rename(tmp, file);   // 原子替换
}

export async function deleteUserGroup(id: string, dir: string = userDefinitionsDir()): Promise<void> {
  if (!ID_RE.test(id)) throw new Error('非法组 id');
  await fs.rm(path.join(dir, `${id}.group.json`), { force: true });
}

// ── 导入/导出（换环境不带不走重录）：一份 JSON 带走全部组，导入按 id 合并 ──

export interface UserGroupsBundle {
  schema: 'workflow-user-dimension-groups';
  version: 1;
  exportedAt: string;
  groups: UserGroup[];
}

export interface ImportSummary {
  addedGroups: number;    // 新建的组
  mergedGroups: number;   // 并入已有组的次数
  addedDims: number;      // 新增维度
  skippedDims: number;    // 跳过（维度 id 已存在——本地版本保留，不被导入覆盖）
  invalidGroups: number;  // 格式不合法被忽略的组
}

/**
 * 导入组。mode：
 * - merge（默认）——组 id 不存在 → 整组建；已存在 → 只补组内缺失的维度，
 *   同 id 维度以本地为准（导入不覆盖已有定义）
 * - replace——清空本地全部组，以导入文件为准（团队统一下发标准/换环境对齐用）
 * 两种模式都做格式校验与组内去重；无效组忽略并计数。
 */
export async function importUserGroups(
  incoming: unknown[],
  dir: string = userDefinitionsDir(),
  mode: 'merge' | 'replace' = 'merge',
): Promise<ImportSummary> {
  const summary: ImportSummary = { addedGroups: 0, mergedGroups: 0, addedDims: 0, skippedDims: 0, invalidGroups: 0 };
  let existing = await loadUserGroups(dir);
  if (mode === 'replace') {
    for (const g of existing) await deleteUserGroup(g.id, dir);
    existing = [];
  }
  const byId = new Map(existing.map(g => [g.id, g] as const));
  const taken = new Set(existing.flatMap(g => g.dimensions.map(d => d.id)));
  for (const raw of incoming) {
    if (!isValidUserGroup(raw)) { summary.invalidGroups++; continue; }
    const cur = byId.get(raw.id);
    if (!cur) {
      const dims: UserDimensionFile[] = [];
      for (const d of raw.dimensions) {
        if (taken.has(d.id)) { summary.skippedDims++; continue; }
        taken.add(d.id);
        dims.push(d);
      }
      await saveUserGroup({ ...raw, dimensions: dims }, dir);
      byId.set(raw.id, { ...raw, dimensions: dims });
      summary.addedGroups++;
      summary.addedDims += dims.length;
    } else {
      const newDims: UserDimensionFile[] = [];
      for (const d of raw.dimensions) {
        if (taken.has(d.id) || cur.dimensions.some(c => c.id === d.id)) { summary.skippedDims++; continue; }
        taken.add(d.id);
        newDims.push(d);
      }
      if (newDims.length > 0) {
        await saveUserGroup({ ...cur, dimensions: [...cur.dimensions, ...newDims] }, dir);
        byId.set(cur.id, { ...cur, dimensions: [...cur.dimensions, ...newDims] });
        summary.addedDims += newDims.length;
      }
      summary.mergedGroups++;
    }
  }
  return summary;
}

// ── 转成注册表能吃的形状：一个自定义维度 = 一个 direct 维 + 一个 LLM 评分项 ──

export function userDimensionToDef(user: UserDimensionFile): DimensionDefinition {
  const item: ScoreItemSchema = {
    id: `D7.${user.id}`,
    dimension: 'D7',
    name: user.name,
    scorerKind: user.kind === 'rule' ? 'rule' : 'llm',
    ...(user.kind === 'rule' ? {} : { bands: user.bands }),
    note: user.description,
  };
  return {
    id: `D7:${user.id}`,
    name: user.name,
    english: 'Custom',
    role: 'optional',
    includeInTotal: user.includeInTotal === true,
    weightInTotal: user.includeInTotal === true ? (user.weight ?? 0.1) : 0,
    items: [item],
    aggregation: { kind: 'direct' },
  };
}

/** 按类型分派评分器：rule → 零 LLM 规则判定；llm（默认）→ BandJudge */
export function userDimensionScorers(user: UserDimensionFile): Scorer[] {
  if (user.kind === 'rule' && user.rule) {
    return [new UserRuleScorer(
      { id: `D7.${user.id}`, dimension: 'D7', name: user.name, scorerKind: 'rule', note: user.description },
      user.rule,
    )];
  }
  return [
    new BandJudgeScorer(
      { id: `D7.${user.id}`, dimension: 'D7', name: user.name, scorerKind: 'llm' },
      { focus: `${user.name}（用户自定义维度）${user.description ? '：' + user.description : ''}` },
    ),
  ];
}
