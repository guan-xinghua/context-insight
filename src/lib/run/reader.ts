// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// manifest 解析 + 校验 + 全树索引（纯函数，无 fs/DB）。对应原型引用的
// graph-workflow-reader.js 的 TS 落地（collectRelations / lookupSessions 的
// 索引基础在此，按 attempt/role 取成员见 view-model 的 attempts 组装）。
// 校验分级（design.md §4.2）：错误 = 抛 ManifestParseError（导入拒绝）；
// 警告 = 收进 index.warnings 透传到 UI（容忍态）。

import {
  BUNDLE_SCHEMA,
  type MemberRole,
  type RunGraphAnnotation,
  type RunManifest,
  type RunMember,
  type RunRelation,
  type RunWorkflowData,
  fiveKeyOf,
  type MemberFiveKey,
} from './model';

export type ManifestRejectReason =
  | 'not-an-object'
  | 'dup-member-id'
  | 'dangling-relation';

export class ManifestParseError extends Error {
  constructor(
    public readonly reason: ManifestRejectReason,
    message: string,
  ) {
    super(message);
    this.name = 'ManifestParseError';
  }
}

export interface IndexedMember {
  member: RunMember;
  /** 所属（子）workflow 的成员 id；根 data 的直接成员为 null。子图挂接
   * （gen-sub-graph）按「ownerWorkflowId + 成员代数」找生成器实例。 */
  ownerWorkflowId: string | null;
  /** 归一后的 graph 注解；null = 无/坏注解（不进图，process 语义容忍） */
  graph: RunGraphAnnotation | null;
}

export interface ResolvedRelation {
  raw: RunRelation;
  from: IndexedMember;
  to: IndexedMember;
}

export interface RunIndex {
  runId: string;
  manifest: RunManifest;
  /** 全树扁平（含 workflow 成员） */
  members: IndexedMember[];
  membersById: Map<string, IndexedMember>;
  /** 带 graph 定位字段的成员 */
  graphMembers: IndexedMember[];
  relations: ResolvedRelation[];
  warnings: string[];
}

// ── 解析与校验 ────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nullableString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** 解析 + 类型归一。结构/枚举/条件必填已由受信任 schema 校验（validateBundleDir
 * 先行），此处不再手写结构校验。 */
export function parseManifest(json: unknown): RunManifest {
  if (!isObj(json)) {
    throw new ManifestParseError('not-an-object', 'workflow.json 根必须是 JSON 对象');
  }
  const rawData = (json.data ?? {}) as Record<string, unknown>;

  return {
    ...json,
    schema: json.schema as typeof BUNDLE_SCHEMA,
    version: json.version as number,
    id: json.id as string,
    kind: 'workflow',
    name: nullableString(json.name),
    startedAt: nullableString(json.startedAt),
    finishedAt: nullableString(json.finishedAt),
    // 缺失保留 undefined（区别于显式 false），由 buildIndex 产出「缺失」警告
    data: {
      ...parseWorkflowData(rawData),
      exportDataComplete: rawData.exportDataComplete === undefined
        ? undefined
        : rawData.exportDataComplete === true,
    },
  } as RunManifest;
}

function parseWorkflowData(raw: Record<string, unknown>): RunWorkflowData {
  return {
    ...raw,
    members: Array.isArray(raw.members) ? raw.members as RunMember[] : [],
    relations: Array.isArray(raw.relations) ? raw.relations as RunRelation[] : [],
  } as RunWorkflowData;
}

interface WalkResult {
  members: IndexedMember[];
  relations: RunRelation[];
  warnings: string[];
}

/** 全树遍历：收集扁平结构、跨节点不变量（id 唯一）与警告。成员/关系结构
 * 已由包内 schema 保证，此处不做结构复检。 */
function walkTree(data: RunWorkflowData, ownerWorkflowId: string | null, out: WalkResult): void {
  for (const raw of data.members) {
    if (out.members.some(m => m.member.id === raw.id)) {
      throw new ManifestParseError('dup-member-id', `成员 id "${raw.id}" 在整棵树中重复`);
    }
    const kind = raw.kind;

    // 图定位字段位于 member 顶层，role 位于自由 annotation。
    let graph: RunGraphAnnotation | null = null;
    const ann = isObj(raw.annotation) ? raw.annotation : undefined;
    if (raw.nodeId !== undefined || raw.generation !== undefined || raw.attempt !== undefined) {
      const g = normalizeGraphAnnotation({
        nodeId: raw.nodeId, generation: raw.generation, attempt: raw.attempt,
        role: ann?.role, attemptResult: raw.attemptResult, verification: raw.verification,
        retryPolicy: raw.retryPolicy, runOnFailure: raw.runOnFailure,
        executionState: raw.executionState, resultFromGeneration: raw.resultFromGeneration,
      });
      if (g) {
        graph = g;
      } else {
        out.warnings.push(`成员 ${raw.id} 的图定位字段或 annotation.role 不合法，按无图定位成员对待`);
      }
    }

    // session 成员：sessionId/location 须同空同有（格式手册 §4）
    if (kind === 'session') {
      const hasSid = typeof raw.sessionId === 'string' && raw.sessionId.length > 0;
      const hasLoc = typeof raw.location === 'string' && raw.location.length > 0;
      if (hasSid !== hasLoc) {
        out.warnings.push(
          `session 成员 ${raw.id} 的 sessionId/location 须同时非空或同时为 null（实际 sessionId=${JSON.stringify(raw.sessionId ?? null)} location=${JSON.stringify(raw.location ?? null)}）`,
        );
      }
      if (raw.output !== undefined) {
        out.warnings.push(`session 成员 ${raw.id} 不应携带 output（正文经会话查看），已忽略`);
      }
    }

    const member: RunMember = {
      ...raw,
      kind,
      name: nullableString(raw.name),
      startedAt: nullableString(raw.startedAt),
      finishedAt: nullableString(raw.finishedAt),
      sessionId: nullableString(raw.sessionId),
      location: nullableString(raw.location),
    };
    out.members.push({ member, ownerWorkflowId, graph });

    // 子图递归：嵌套 workflow 的成员 ownerWorkflowId 指向该 workflow 成员
    if (kind === 'workflow') {
      walkTree(parseWorkflowData(raw.data as Record<string, unknown>), raw.id, out);
    }
  }
  for (const raw of data.relations) {
    out.relations.push(raw);
  }
}

function normalizeGraphAnnotation(raw: Record<string, unknown>): RunGraphAnnotation | null {
  if (
    typeof raw.nodeId !== 'string' || raw.nodeId.length === 0
    || typeof raw.generation !== 'number' || !Number.isInteger(raw.generation) || raw.generation < 0
    || typeof raw.attempt !== 'number' || !Number.isInteger(raw.attempt) || raw.attempt < 0
    || (raw.role !== 'execute' && raw.role !== 'verify')
  ) {
    return null;
  }
  return { ...raw, nodeId: raw.nodeId, generation: raw.generation, attempt: raw.attempt, role: raw.role } as RunGraphAnnotation;
}

// ── 索引构建 ──────────────────────────────────────────────────

/** 解析 + 全树索引。关系端点在此解析（dangling = 错误）。 */
export function buildIndex(manifest: RunManifest): RunIndex {
  const out: WalkResult = { members: [], relations: [], warnings: [] };
  walkTree(manifest.data, null, out);

  if (manifest.data.exportDataComplete === undefined) {
    out.warnings.push('根 data.exportDataComplete 缺失（按 false 对待）');
  }

  const membersById = new Map(out.members.map(m => [m.member.id, m]));
  const relations: ResolvedRelation[] = [];
  for (const raw of out.relations) {
    const from = membersById.get(raw.from);
    const to = membersById.get(raw.to);
    if (!from || !to) {
      throw new ManifestParseError(
        'dangling-relation',
        `关系 ${raw.from} → ${raw.to} 引用了不存在的成员（缺失端点应令 exportDataComplete=false 而非猜测补齐）`,
      );
    }
    relations.push({ raw, from, to });
  }

  return {
    runId: manifest.id,
    manifest,
    members: out.members,
    membersById,
    graphMembers: out.members.filter(m => m.graph !== null),
    relations,
    warnings: out.warnings,
  };
}

/** 从 JSON 未知值一步到位：解析 + 索引（导入与测试的便捷入口）。 */
export function parseAndIndex(json: unknown): RunIndex {
  return buildIndex(parseManifest(json));
}

export function memberKey(m: IndexedMember): string {
  return m.graph ? fiveKeyOf(m.graph) : m.member.id;
}

/** 五键查成员（同键多成员时返回全部，调用方自行择优）。 */
export function lookupByFiveKey(index: RunIndex, key: MemberFiveKey): IndexedMember[] {
  const wanted = fiveKeyOf(key);
  return index.graphMembers.filter(m => memberKey(m) === wanted);
}

export function roleOf(m: IndexedMember): MemberRole | null {
  return m.graph?.role ?? null;
}
