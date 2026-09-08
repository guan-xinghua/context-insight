// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { spawn } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { AuditLayerInfo } from "./sift-audit-types";
import {
  assembleCombinedDeclaration,
  extractFileContent,
  extractFilePath,
  isSkillInvokeToolCall,
  pickFirstSubstantial,
  stripSkillContent,
} from "./sift-audit";
import { extractSkillNameFromArgs } from "./skill-event-grouping";

/**
 * LLM 提取主 agent 组合声明（泛化路径，不依赖 workflow-extract-plugins 的领域启发式）。
 *
 * **选择式契约（不可篡改 by construction）**：LLM 不抄写正文——只从确定性收集的候选列表里
 * 选出「规程层用哪份、计划层用哪份」（输出候选 ID 的 JSON）；正文一律取 DB 原文，
 * 机械归一化（Read 剥行号 / 计划层 [x]→[ ]）在代码里做，
 * 最终与确定性提取（recoverCombinedWorkflowDeclaration）**共享同一个装配函数**
 * assembleCombinedDeclaration——两条路产出字节级同构（"提取拼接可以，篡改不可以"）。
 *
 * 两层分工（与确定性提取一致）：
 * - 规程层（编排纪律，"怎么干"）：skill 注入的编排规程 / 编排模板文件 / turn0 注入
 * - 计划层（任务承诺，"干什么"）：任务清单文件（STATE/TODO/PLAN 类）的读写快照
 *
 * 与确定性提取的关系：确定性 = 领域插件（cann-ops 启发式，快而准但限领域）；
 * LLM = 泛化兜底（识别交给模型理解，任何领域可用，慢但通用）。识别正确的常见场景下
 * 两者选同一批候选 → 产出一致；确定性取不到的场景（非 ops 命名/结构）LLM 仍能工作。
 */

const MAX_TURNS = 10;
const CLAUDE_TIMEOUT_MS = 300_000;

/** 候选正文的机械下限（过滤空/残片，非领域启发）。 */
const CANDIDATE_MIN_CHARS = 100;
/** turn0 user 注入候选的下限（低于视为短任务噪声，不入候选）。 */
const USER_CANDIDATE_MIN_CHARS = 200;
/** prompt 内候选正文预览上限（选择只需可辨认的开头结构）。 */
const PREVIEW_MAX_CHARS = 1200;
/** 计划候选总数上限（防爆 prompt；实测 40 候选 × 2000 字预览撑到 78KB，选不动还慢）。 */
const MAX_PLAN_CANDIDATES = 16;
/** 规程候选总数上限。 */
const MAX_REG_CANDIDATES = 8;
/** 计划候选的文件扩展名白名单（任务清单/计划文档的实际载体）。 */
const PLAN_FILE_EXTENSIONS = [".md", ".txt"];
/** 计划候选查询的 take 上限（与确定性提取的 PLAN_FILE_SCAN_TAKE 对齐）。 */
const PLAN_SCAN_TAKE = 1000;

/** 一份可被 LLM 选择的声明候选（正文为 DB 原文，归一化见各收集点）。 */
export interface WorkflowExtractCandidate {
  /** 候选 ID（"R1".."Rn" 规程 / "P1".."Pn" 计划），LLM 输出引用它。 */
  id: string;
  layer: "regulation" | "plan";
  /** 来源标识（与确定性提取的 source 口径一致：basename / "skillName (SKILL.md)" / "turn0 (注入编排规程)"）。 */
  source: string;
  /** 原文（Read 已剥行号；计划层 [x] 归一在选择命中时做）。 */
  content: string;
  /** Read 带 offset/limit（部分读取，prompt 里降权提示）。 */
  partialRead: boolean;
  /** 同一文件被读的次数（多次读取 = 活跃计划文件信号，仅排序提示）。 */
  readCount?: number;
}

export interface WorkflowExtractCandidates {
  regulation: WorkflowExtractCandidate[];
  plan: WorkflowExtractCandidate[];
  /** dispatch 前引导区的 turn 骨架（prompt 语境用，非候选）。 */
  contextLines?: string[];
}

/**
 * 服务端模块级缓存：GET 端点立即返回（不阻塞 HTTP 连接），前端轮询。
 * key = taskId, value = { loading, content, source, error, promise }
 */
interface LlmExtractJob {
  loading: boolean;
  content: string | null;
  source: string | null;
  error: string | null;
  promise: Promise<void> | null;
}
const extractJobs = new Map<string, LlmExtractJob>();

/**
 * 启动或查询 LLM 提取任务。非阻塞：
 * - 无 job → 后台启动 claude CLI，立即返回 { loading: true }
 * - 已在运行 → 返回同一 job（loading: true）
 * - 已完成（成功或失败）→ 原样返回 content 或 error。**失败不自动重启**——前端轮询会
 *   反复 GET，若失败即重启会变成"每 5s 重spawn CLI、loading 永远 true"的死循环
 *   （v2.02 修过的坑）。显式重试走 opts.force（重试按钮 → restart=1）。
 * - opts.force：job 已失败/已完成且不在跑 → 丢弃旧 job 重新启动；在跑 → 原样返回。
 */
export function getOrStartLlmExtract(
  taskId: string,
  sessionId: string,
  prisma: PrismaClient,
  opts?: { force?: boolean },
): LlmExtractJob {
  const existing = extractJobs.get(taskId);
  if (existing) {
    if (existing.loading) return existing;
    if (!opts?.force) return existing;
    // force 且已 settle：丢弃重启（在跑的上面已 return）
  }

  const job: LlmExtractJob = { loading: true, content: null, source: null, error: null, promise: null };
  extractJobs.set(taskId, job);

  job.promise = (async () => {
    try {
      const decl = await llmExtractWorkflowDeclaration(sessionId, prisma);
      if (decl) { job.content = decl.content; job.source = decl.source; }
      else { job.error = "LLM 提取无输出（无候选/选择无效）"; }
    } catch (e) { job.error = e instanceof Error ? e.message : String(e); }
    finally { job.loading = false; }
  })();

  return job;
}

/** 测试用：清空 job 缓存。 */
export function __resetLlmExtractForTests(): void {
  extractJobs.clear();
}

/** LLM 运行器结果：text=正常输出；error=CLI 基础设施失败（认证 403/非 0 退出/超时/启动失败），
 * 调用方须把 error 上抛给用户（此前被吞成"提取中"死循环的正是这类失败）。 */
export interface LlmRunnerResult {
  text: string | null;
  error: string | null;
}

/** LLM 运行器（prompt → 结果）；生产走 claude CLI，测试可注入。 */
export type LlmRunner = (prompt: string) => Promise<LlmRunnerResult>;

/**
 * LLM 提取组合声明：收集候选 → 选择式 prompt → LLM 选 → 共享装配。
 * 返回与 recoverCombinedWorkflowDeclaration 同构（content/source/layers）。
 *
 * CLI 基础设施失败（认证/退出/超时）→ **throw**（消息直达用户，如 "claude CLI 退出码 1：
 * Failed to authenticate. API Error: 403 invalid api-key"）；无候选/选择无效 → null。
 */
export async function llmExtractWorkflowDeclaration(
  sessionId: string,
  prisma: PrismaClient,
  runner: LlmRunner = runClaudeCli,
): Promise<{ content: string; source: string; layers: AuditLayerInfo[] } | null> {
  const candidates = await collectWorkflowExtractCandidates(sessionId, prisma);
  if (candidates.regulation.length === 0 && candidates.plan.length === 0) {
    console.log('[llm-workflow-extract] no candidates collected');
    return null;
  }

  const prompt = buildCandidatePrompt(candidates);
  console.log('[llm-workflow-extract] prompt length:', prompt.length,
    'reg candidates:', candidates.regulation.length, 'plan candidates:', candidates.plan.length);

  const result = await runner(prompt);
  if (!result.text) {
    const reason = result.error ?? "无输出";
    console.error('[llm-workflow-extract] LLM runner failed:', reason, 'prompt length:', prompt.length);
    throw new Error(reason);
  }

  const layers = parseCandidateSelection(result.text, candidates);
  if (layers.length === 0) {
    console.error('[llm-workflow-extract] selection parsed to no layers. output:', result.text.slice(0, 300));
    return null;
  }
  return assembleCombinedDeclaration(layers);
}

/**
 * 确定性收集候选（LLM 只在此之上做选择）：
 *
 * - 规程候选（dispatch 前的引导区，与旧实现同窗口）：turn0 user 注入、skill invoke 的
 *   `<skill_content>` 正文、Read 的文件正文（覆盖 skill resources 编排模板）。
 * - 计划候选（全 session）：.md/.txt 文件读写（每文件取首次实质读取快照，同文件多次读
 *   不重复占位）。todowrite 不入候选（主 agent 自我维护的 todos 是自评循环，不作为计划层）。
 *
 * 收集零领域启发（文件名白名单/内容特征全交给 LLM 判断）——这是泛化路径；
 * 排序仅用中性信号（读次数、时序）帮助候选进入名单。
 *
 * 查询两步走（性能）：先只取 argsJson（小）判定哪些调用需要正文，再按 id 批量取
 * resultJson——直接 select resultJson 会把全 session 的 Read 大结果（单条可达 MB 级）
 * 整列拉进内存，大 session 收集就要几十秒。
 */
export async function collectWorkflowExtractCandidates(
  sessionId: string,
  prisma: PrismaClient,
): Promise<WorkflowExtractCandidates> {
  // ── 规程候选：dispatch 前窗口（首个 dispatch 的 turnIndex 作 cutoff）──
  const firstDispatch = await prisma.skillEvent.findFirst({
    where: { eventType: "dispatch", turn: { sessionId, isSubagent: false } },
    orderBy: { createdAt: "asc" },
    select: { turnId: true },
  });
  let cutoff: number | undefined;
  if (firstDispatch) {
    const dispatchTurn = await prisma.turn.findUnique({
      where: { id: firstDispatch.turnId },
      select: { turnIndex: true },
    });
    cutoff = dispatchTurn?.turnIndex ?? undefined;
  }

  const turns = await prisma.turn.findMany({
    where: {
      sessionId,
      isSubagent: false,
      ...(cutoff != null ? { turnIndex: { lt: cutoff } } : {}),
    },
    orderBy: { turnIndex: "asc" },
    take: MAX_TURNS,
    select: { id: true, turnIndex: true, role: true, content: true, agentName: true },
  });

  const regCandidates: WorkflowExtractCandidate[] = [];
  const contextLines: string[] = [];
  if (turns.length > 0) {
    // 步骤 1：窗口内工具调用的轻量元数据（不含 resultJson）
    const regMeta = await prisma.toolCall.findMany({
      where: { turnId: { in: turns.map((t) => t.id) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, turnId: true, toolName: true, argsJson: true },
    });
    // 步骤 2：只为"skill invoke + Read(.md/.txt)"批量取 resultJson
    const regNeedIds = regMeta
      .filter((tc) => {
        const tn = tc.toolName.toLowerCase();
        if (isSkillInvokeToolCall(tc.toolName)) return true;
        if (tn !== "read") return false;
        const base = basenameOf(extractFilePath(tc.argsJson));
        return PLAN_FILE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e));
      })
      .map((tc) => tc.id);
    const resultById = await fetchResultJsonByIds(prisma, regNeedIds);

    const tcByTurn = new Map<string, Array<{ toolName: string; argsJson: string | null; resultJson: string | null }>>();
    for (const tc of regMeta) {
      const arr = tcByTurn.get(tc.turnId) ?? [];
      arr.push({ toolName: tc.toolName, argsJson: tc.argsJson, resultJson: resultById.get(tc.id) ?? null });
      tcByTurn.set(tc.turnId, arr);
    }

    for (const t of turns) {
      // 引导区语境（供 LLM 理解，非候选）
      contextLines.push(`- Turn ${t.turnIndex} (${t.role}${t.agentName ? `, agent=${t.agentName}` : ""}): ${firstLine(t.content)}`);

      if (t.role === "user" && t.turnIndex === 0 && (t.content ?? "").length >= USER_CANDIDATE_MIN_CHARS) {
        regCandidates.push({
          id: "", // 编号在收集完成后统一定
          layer: "regulation",
          source: "turn0 (注入编排规程)",
          content: t.content!,
          partialRead: false,
        });
      }
      for (const tc of tcByTurn.get(t.id) ?? []) {
        const tn = tc.toolName.toLowerCase();
        if (isSkillInvokeToolCall(tc.toolName) && tc.resultJson) {
          const body = stripSkillContent(tc.resultJson);
          if (body && body.length >= CANDIDATE_MIN_CHARS) {
            const name = extractSkillNameFromArgs(tc.argsJson) ?? "skill";
            regCandidates.push({
              id: "",
              layer: "regulation",
              source: `${name} (SKILL.md)`,
              content: body,
              partialRead: false,
            });
          }
        } else if (tn === "read") {
          const ex = extractFileContent(tc);
          if (ex && ex.content.length >= CANDIDATE_MIN_CHARS && ex.basename) {
            regCandidates.push({
              id: "",
              layer: "regulation",
              source: ex.basename,
              content: ex.content,
              partialRead: hasReadOffsetOrLimit(tc.argsJson),
            });
          }
        }
      }
    }
  }

  // ── 计划候选：全 session 的 read/write ──
  // 步骤 1：轻量元数据；write 的正文在 argsJson 里，无需 resultJson
  const planMeta = await prisma.toolCall.findMany({
    where: {
      turn: { sessionId },
      toolName: { in: ["read", "Read", "write", "Write"] },
    },
    orderBy: { createdAt: "asc" },
    take: PLAN_SCAN_TAKE,
    select: { id: true, toolName: true, argsJson: true },
  });
  // 步骤 2：只为"Read(.md/.txt)"批量取 resultJson（write 用 argsJson 即可）
  const planReadIds = planMeta
    .filter((tc) => {
      if (tc.toolName.toLowerCase() !== "read") return false;
      const base = basenameOf(extractFilePath(tc.argsJson));
      return PLAN_FILE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e));
    })
    .map((tc) => tc.id);
  const planResultById = await fetchResultJsonByIds(prisma, planReadIds);
  const planTcs = planMeta.map((tc) => ({
    toolName: tc.toolName,
    argsJson: tc.argsJson,
    resultJson: planResultById.get(tc.id) ?? null,
  }));

  const fileGroups = new Map<string, Array<{ content: string; partialRead: boolean }>>();
  for (const tc of planTcs) {
    const ex = extractFileContent(tc);
    if (!ex || ex.content.length < CANDIDATE_MIN_CHARS) continue;
    const fp = extractFilePath(tc.argsJson);
    const base = ex.basename ?? basenameOf(fp);
    if (!base || !PLAN_FILE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e))) continue;
    const key = fp ?? base;
    const arr = fileGroups.get(key) ?? [];
    arr.push({ content: ex.content, partialRead: hasReadOffsetOrLimit(tc.argsJson) });
    fileGroups.set(key, arr);
  }

  // 每文件取首次实质读取（与确定性提取同语义：早读=承诺态，非终态）
  const fileCandidates: WorkflowExtractCandidate[] = [];
  for (const [fp, snaps] of fileGroups) {
    const best = pickFirstSubstantial(snaps);
    if (!best) continue;
    fileCandidates.push({
      id: "",
      layer: "plan",
      source: basenameOf(fp),
      content: best.content,
      partialRead: best.partialRead,
      readCount: snaps.length,
    });
  }
  // 排序：文件按读取次数降序（反复读 = 活跃计划）+ 名字序稳定
  fileCandidates.sort((a, b) => (b.readCount ?? 1) - (a.readCount ?? 1) || a.source.localeCompare(b.source));

  const planCandidates = fileCandidates.slice(0, MAX_PLAN_CANDIDATES);
  const regulation = dedupeCandidates(regCandidates).slice(0, MAX_REG_CANDIDATES);

  return {
    regulation: regulation.map((c, i) => ({ ...c, id: `R${i + 1}` })),
    plan: planCandidates.map((c, i) => ({ ...c, id: `P${i + 1}` })),
    contextLines,
  };
}

function firstLine(content: string | null): string {
  const l = (content ?? "").split("\n").find((x) => x.trim()) ?? "";
  return l.slice(0, 120);
}

/**
 * 按 id 批量取 ToolCall.resultJson（两步查询的第二步）。
 * 空列表 → 空 Map（不发查询）。
 */
async function fetchResultJsonByIds(
  prisma: PrismaClient,
  ids: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = await prisma.toolCall.findMany({
    where: { id: { in: ids } },
    select: { id: true, resultJson: true },
  });
  for (const r of rows) out.set(r.id, r.resultJson);
  return out;
}

function basenameOf(p: string | null): string {
  if (!p) return "";
  return p.split(/[\\/]/).pop() ?? p;
}

function hasReadOffsetOrLimit(argsJson: string | null): boolean {
  if (!argsJson) return false;
  try {
    const a = JSON.parse(argsJson);
    return (a.offset != null && a.offset > 0) || a.limit != null;
  } catch { return false; }
}

/** 同正文候选去重（turn0 注入常与 skill 注入同文）。 */
function dedupeCandidates(cands: WorkflowExtractCandidate[]): WorkflowExtractCandidate[] {
  const seen = new Set<string>();
  const out: WorkflowExtractCandidate[] = [];
  for (const c of cands) {
    const key = c.content.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * 选择式 prompt：两层定义 + 候选预览 + 选择规则（镜像确定性提取的优先级）+ 严格 JSON 输出。
 */
export function buildCandidatePrompt(candidates: WorkflowExtractCandidates): string {
  let text = `你是 workflow 声明选择器。任务：为「主 agent（编排者）」的 workflow 对账从下列候选中选出两部分声明。你只输出选择结果（候选 ID），不抄写正文。

背景：主 agent 的 workflow 声明分两层——
- 规程层（编排规程，"怎么干"）：主 agent 的角色定位、职责边界、阶段推进规则、派发纪律、验收要求等编排规程。常见形态：skill 注入的编排规程正文、编排模板文件（教每阶段怎么派发、带验收标准的模板）、注入首条 user 消息的系统级指令。
- 计划层（任务计划，"干什么"）：本 session 要完成的具体任务清单/里程碑/检查单。常见形态：任务清单文件（如 STATE/TODO/PLAN/TASKS 类命名的文档）。

引导区语境（dispatch 之前的 turn 骨架）：
${(candidates.contextLines ?? []).join("\n") || "（无）"}

## 规程层候选

`;
  for (const c of candidates.regulation) {
    text += formatCandidateBlock(c);
  }
  if (candidates.regulation.length === 0) text += "（无候选）\n";

  text += `
## 计划层候选

`;
  for (const c of candidates.plan) {
    text += formatCandidateBlock(c);
  }
  if (candidates.plan.length === 0) text += "（无候选）\n";

  text += `
## 选择规则

1. 规程层选最完整、最具体的编排规程：含每阶段派发参数/验收标准的编排模板 > 编排规程骨架（原则/边界/阶段）> 泛化指令。同内容多份时选字数最多、结构最全的。
2. 计划层选本 session 的任务承诺：列明要完成任务的清单/检查单。不要把源代码、API 文档、参考资料、需求原文当计划。
3. 两层互斥：同一候选内容不得同时选为两层。编排模板（教怎么干，即使含检查单）归规程层；任务清单（列干什么）归计划层。
4. 标注「部分读取」的候选尽量避免（内容不完整）；有完整候选时优先完整。
5. 某层确实不存在时填 null（例如纯问答 session 无计划层；无任何编排规程时规程层为 null）。

输出要求：严格输出一个 JSON 对象，不要包裹代码块，不要任何解释文字：
{"regulation": "R1", "plan": "P1"}
某层缺失时该字段为 null，例如：{"regulation": "R2", "plan": null}`;
  return text;
}

function formatCandidateBlock(c: WorkflowExtractCandidate): string {
  const preview = c.content.slice(0, PREVIEW_MAX_CHARS);
  const ellipsis = c.content.length > PREVIEW_MAX_CHARS ? `…（节选，全文 ${c.content.length} 字）` : "";
  const marks = [
    c.partialRead ? "部分读取" : null,
    c.readCount && c.readCount > 1 ? `被读 ${c.readCount} 次` : null,
  ].filter(Boolean).join("，");
  return `### [${c.id}] 来源：${c.source}${marks ? `（${marks}）` : ""}\n${preview}${ellipsis}\n\n`;
}

/**
 * 解析 LLM 选择输出 → 层列表（正文取候选原文，不信任 LLM 抄写）：
 * - 容忍代码块包裹/前后杂文（提取首个 JSON 对象）
 * - 字段引用不存在/跨层引用的 ID → 该层作 null 处理
 * - 计划层正文做 [x]→[ ] 归一（与确定性提取同规则：声明=该干什么，非执行结果）
 */
export function parseCandidateSelection(
  output: string,
  candidates: WorkflowExtractCandidates,
): AuditLayerInfo[] {
  const jsonText = extractJsonObject(output);
  if (!jsonText) return [];
  let sel: { regulation?: unknown; plan?: unknown };
  try {
    sel = JSON.parse(jsonText) as { regulation?: unknown; plan?: unknown };
  } catch {
    return [];
  }
  if (sel === null || typeof sel !== "object") return [];

  const layers: AuditLayerInfo[] = [];
  const reg = candidates.regulation.find((c) => c.id === sel.regulation);
  if (reg) {
    layers.push({ kind: "regulation", label: "编排规程", source: reg.source, content: reg.content });
  }
  const plan = candidates.plan.find((c) => c.id === sel.plan);
  if (plan) {
    layers.push({
      kind: "plan",
      label: "任务计划",
      source: plan.source,
      content: plan.content.replace(/\[x\]/g, "[ ]"),
    });
  }
  return layers;
}

/** 从 LLM 输出提取首个 JSON 对象文本（容忍 ```json 包裹与前后解释文字）。 */
function extractJsonObject(output: string): string | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : output;
  const start = body.indexOf("{");
  if (start === -1) return null;
  const end = body.lastIndexOf("}");
  if (end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * claude CLI（-p 非交互）。失败时把 CLI 的真实输出（如 "Failed to authenticate. API
 * Error: 403 invalid api-key"）作为 error 带回——此前非 0 退出直接丢 stdout，认证类
 * 失败被吞成"提取中"死循环。
 */
function runClaudeCli(prompt: string): Promise<LlmRunnerResult> {
  return new Promise((resolve) => {
    const claudeBin = process.env.CLAUDE_CLI_PATH || "/usr/local/bin/claude";
    const proc = spawn(claudeBin, ["-p", "--output-format", "text"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: LlmRunnerResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      finish({ text: null, error: `claude CLI 超时（${CLAUDE_TIMEOUT_MS / 1000}s，可能未认证或网络不通）` });
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        finish({ text: stdout.trim(), error: null });
      } else {
        const detail = (stdout.trim() || stderr.trim() || "无输出").slice(0, 300);
        console.error('[llm-workflow-extract] claude CLI exit code:', code, 'stdout:', stdout.slice(0, 300), 'stderr:', stderr.slice(0, 300));
        finish({ text: null, error: `claude CLI 退出码 ${code ?? "null"}：${detail}` });
      }
    });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      console.error('[llm-workflow-extract] spawn error:', err.message);
      finish({ text: null, error: `claude CLI 启动失败（${claudeBin}）：${err.message}` });
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
