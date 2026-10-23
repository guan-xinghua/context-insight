// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// LLM 评分器基建：四种通用形状（打分 / 清单对账 / 消息分类 / 目标覆盖）。
// LLM 只打分和分类；平均、加权、合计、触发否决全部代码算（§9 分工）。
// 未配 LLM → not-applicable（不报 error）；解析失败 → error 态，流程不断。

import type { AssembledInput, JudgeCallMeta } from './assembler/types';
import { Scorer, okResult, notApplicable, errorResult, round2, type ScorerContext } from './scorer';
import type { ScoreItemSchema } from './schema';
import type { SubItemResult } from './types';
import { GENERIC_JUDGE_SYSTEM, buildBandJudgeAsk, clampToBandScore, completeParsedJson, verdictText, validEvidenceTurns, validEvidenceItems } from './llm';

const NO_LLM_NOTE = '未开启 LLM 评审，无法评判';

/** 消息拼装：轨迹摘要在前（15 次调用共享同一前缀，命中网关前缀缓存），子项要求在尾 */
const judgeMessage = (digest: string, ask: string, material = ''): string =>
  `${digest}${material}${material ? '\n\n---\n\n' : ''}\n\n---\n\n${ask}`;

/** 调用方上下文（过程日志关联维度/子项） */
const judgeMeta = (ctx: ScorerContext): JudgeCallMeta => ({
  dimensionId: ctx.def.dimension, itemId: ctx.def.id, itemName: ctx.def.name,
});

function validTurnIndexes(input: AssembledInput): number[] {
  return input.turns.map(t => t.turnIndex);
}

// ── 1. 打分型（0-10 五档锚定）──────────────────────────────

export interface BandJudgeConfig {
  focus: string;
  /** 追加进 user 材料的节（如 D3 的产出文件节已含在 digest 里） */
  material?: (input: AssembledInput) => string;
  notApplicableWhen?: (input: AssembledInput) => string | null;
}

export class BandJudgeScorer extends Scorer {
  readonly id: string;
  readonly needs = ['trajectoryDigest'] as const;

  constructor(private readonly def: ScoreItemSchema, private readonly cfg: BandJudgeConfig) {
    super();
    this.id = def.id;
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const na = this.cfg.notApplicableWhen?.(ctx.input);
    if (na) return notApplicable(ctx.def, na);
    if (!ctx.llm) return notApplicable(ctx.def, NO_LLM_NOTE, { naKind: 'gap' });

    try {
      const user = judgeMessage(ctx.input.trajectoryDigest, buildBandJudgeAsk(ctx.def, this.cfg.focus), this.cfg.material?.(ctx.input));
      const { parsed, retried } = await completeParsedJson(ctx.llm, GENERIC_JUDGE_SYSTEM, user, judgeMeta(ctx));
      const scoreRaw = parsed?.['score'];
      if (parsed == null || (scoreRaw != null && typeof scoreRaw !== 'number')) {
        return errorResult(ctx.def, `评审输出解析失败${retried ? '（已自动重评一次仍失败）' : ''}（需 {"reason":str,"score":0-10|null,"evidence":["§N"]}）`);
      }
      if (scoreRaw == null) {
        // 区分「显式弃权 score:null」与「输出被截断导致 score 字段缺失」：
        // 后者是通道问题，不该落成"证据不足"的假弃权（会带着充分理由却不得分）。
        if (!('score' in parsed)) {
          return errorResult(ctx.def, '评审输出缺 score 字段（疑似输出被截断，reason 不完整，不计为证据不足）');
        }
        return okResult(ctx.def, {
          status: 'not-applicable',
          note: `证据不足：${typeof parsed['reason'] === 'string' ? parsed['reason'] : '评审弃权'}`,
        });
      }
      const clamped = clampToBandScore(scoreRaw, ctx.def.bands ?? []);
      const items = validEvidenceItems(parsed['evidence'], validTurnIndexes(ctx.input));
      return okResult(ctx.def, {
        value: clamped,
        unit: 'score/10',
        score: clamped / 10,
        formula: `LLM 评审 ${clamped}/10${clamped !== scoreRaw ? `（原始 ${scoreRaw} 拉回最近档）` : ''}`,
        evidence: items.map(it => ({ turnIndex: it.turnIndex, label: it.note || '评审依据', impact: it.impact })),
        note: typeof parsed['reason'] === 'string' ? parsed['reason'] : undefined,
      });
    } catch (err) {
      return errorResult(ctx.def, err instanceof Error ? err.message : 'LLM 调用失败');
    }
  }
}

// ── 1b. 两档判定型（binary：LLM 是非题——达成 1 / 未达成 0 / 判不了弃权）──────

export class BinaryJudgeScorer extends Scorer {
  readonly id: string;
  readonly needs = ['trajectoryDigest'] as const;

  constructor(private readonly def: ScoreItemSchema, private readonly cfg: { criteria: string }) {
    super();
    this.id = def.id;
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    if (!ctx.llm) return notApplicable(ctx.def, NO_LLM_NOTE, { naKind: 'gap' });

    const ask = `## 本次评审任务：${ctx.def.name}（两档判定）

判定标准：${this.cfg.criteria}

这是是非题，不是程度题——只回答三选一：
- met：材料中有明确证据表明达成（必须给出 §N 证据）
- unmet：材料表明未达成（给出依据）
- na：材料不足，判不了（宁弃权不硬判）

严格输出 JSON：
{"verdict":"met|unmet|na","reason":"一句话依据","evidence":[{"turn":12,"note":"一句话依据"}]}`;

    try {
      const { parsed, retried } = await completeParsedJson(ctx.llm, GENERIC_JUDGE_SYSTEM, judgeMessage(ctx.input.trajectoryDigest, ask), judgeMeta(ctx));
      const verdict = parsed?.['verdict'];
      if (verdict !== 'met' && verdict !== 'unmet' && verdict !== 'na') {
        return errorResult(ctx.def, `两档判定输出解析失败${retried ? '（已自动重评一次仍失败）' : ''}（需 {"verdict":"met|unmet|na",...}）`);
      }
      if (verdict === 'na') {
        return okResult(ctx.def, { status: 'not-applicable', note: `判不了：${typeof parsed?.['reason'] === 'string' ? parsed['reason'] : '材料不足'}` });
      }
      const items = validEvidenceItems(parsed?.['evidence'], validTurnIndexes(ctx.input));
      return okResult(ctx.def, {
        verdict: verdict === 'met' ? 'pass' : 'fail',
        value: verdict === 'met' ? 1 : 0,
        unit: '达成/未达成',
        score: verdict === 'met' ? 1 : 0,
        formula: `LLM 两档判定：${verdict === 'met' ? '达成 → 1' : '未达成 → 0'}`,
        evidence: items.map(it => ({ turnIndex: it.turnIndex, label: it.note || '判定依据' })),
        note: typeof parsed?.['reason'] === 'string' ? parsed['reason'] : undefined,
      });
    } catch (err) {
      return errorResult(ctx.def, err instanceof Error ? err.message : 'LLM 调用失败');
    }
  }
}

// ── 2. 清单对账型（D1.acceptance 验收清单 / D2.redlines 红线）──────────────
// 三道保险：① LLM 只逐条判、结论代码算；② 证据轮次校验对不上降级；③ 计数优先代码解析

export interface ChecklistJudgeConfig {
  /** 从装配产物取清单原文；null → not-applicable */
  declaration: (input: AssembledInput) => string | null;
  /** 顺带产出完成度分（met/总数）——D1.acceptance 用；D2.redlines 红线不用 */
  completionScore?: boolean;
  declarationLabel: string;          // '验收清单' / '红线声明'
  itemStatuses: string[];            // 合法状态值，如 ['met','unmet','not-run','unidentifiable']
  /** 任一子项命中这些状态 → 聚合结论（代码算，如 'unmet'） */
  failStatuses: string[];
  failVerdict: string;               // '未完成' / 'violation'
  passVerdict: string;               // '完成' / 'clean'
  fallbackVerdict: string;           // 全部无法识别时
}

/** 清单原文拆条目（- / * / 数字编号行）；拆不出整段当一条 */
export function splitChecklist(text: string): string[] {
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && l.length < 300);
  const items = lines.filter(l => /^([-*•]|\d+[.、)])\s+/.test(l));
  if (items.length >= 2) return items.map(l => l.replace(/^([-*•]|\d+[.、)])\s+/, ''));
  return [text.trim().slice(0, 500)];
}

export class ChecklistJudgeScorer extends Scorer {
  readonly id: string;
  readonly needs = ['trajectoryDigest', 'workflowDecl'] as const;

  constructor(private readonly def: ScoreItemSchema, private readonly cfg: ChecklistJudgeConfig) {
    super();
    this.id = def.id;
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const decl = this.cfg.declaration(ctx.input);
    if (!decl) return notApplicable(ctx.def, `缺少${this.cfg.declarationLabel}，无法评判`);
    if (!ctx.llm) return notApplicable(ctx.def, NO_LLM_NOTE, { naKind: 'gap' });

    const items = splitChecklist(decl);
    const ask = `## 本次评审任务：${this.cfg.declarationLabel}逐条对账

判断步骤（严格按顺序）：

判断步骤（严格按顺序）：
1. 逐条阅读清单项，在轨迹材料中找对应的执行证据（§N 轮次引用）
2. 每条判一个状态，只能取这些值：${this.cfg.itemStatuses.join(' / ')}
3. 找不到对应证据的条目判 "${this.cfg.itemStatuses[this.cfg.itemStatuses.length - 1]}"，不要猜
4. evidence 只填材料中真实存在的 turn 序号

清单（共 ${items.length} 条）：
${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}

严格输出 JSON：
{"items":[{"index":1,"note":"一句话依据","evidence":["§12"],"status":"${this.cfg.itemStatuses[0]}"}]}
每条清单项都必须出现，index 与清单编号一致。`;

    try {
      const { parsed, retried } = await completeParsedJson(ctx.llm, GENERIC_JUDGE_SYSTEM, judgeMessage(ctx.input.trajectoryDigest, ask), judgeMeta(ctx));
      const arr = parsed?.['items'];
      if (!Array.isArray(arr) || arr.length === 0) {
        return errorResult(ctx.def, `对账输出解析失败${retried ? '（已自动重评一次仍失败）' : ''}（需 {"items":[{index,status,evidence,note}]}）`);
      }
      const evidence: SubItemResult['evidence'] = [];
      const failed: string[] = [];
      const unidentifiable: string[] = [];
      for (const r of arr) {
        if (!r || typeof r !== 'object') continue;
        const rr = r as { index?: unknown; status?: unknown; note?: unknown };
        const idx = typeof rr.index === 'number' ? rr.index : 0;
        const status = typeof rr.status === 'string' && this.cfg.itemStatuses.includes(rr.status) ? rr.status : null;
        const text = items[idx - 1] ?? `第 ${idx} 条`;
        const evTurns = validEvidenceTurns((r as { evidence?: unknown }).evidence, validTurnIndexes(ctx.input));
        if (status && this.cfg.failStatuses.includes(status)) failed.push(text);
        if (status == null || status === this.cfg.itemStatuses[this.cfg.itemStatuses.length - 1]) unidentifiable.push(text);
        if (evTurns.length > 0 || status) {
          evidence.push({ turnIndex: evTurns[0] ?? null, label: `#${idx} ${text} → ${status ? verdictText(status) : '无法识别'}`, quote: typeof rr.note === 'string' ? rr.note : undefined });
        }
      }
      const verdict = failed.length > 0
        ? this.cfg.failVerdict
        : unidentifiable.length === items.length ? this.cfg.fallbackVerdict : this.cfg.passVerdict;
      const metCount = arr.reduce((s, r) => {
        if (!r || typeof r !== 'object') return s;
        return s + ((r as { status?: unknown }).status === 'met' ? 1 : 0);
      }, 0);
      return okResult(ctx.def, {
        verdict,
        value: `${failed.length === 0 ? 0 : failed.length}/${items.length} 未达标`,
        ...(this.cfg.completionScore ? { score: round2(metCount / items.length) } : {}),
        formula: `逐条对账 ${items.length} 条：未达标 ${failed.length}，无法识别 ${unidentifiable.length} → ${verdict}`,
        evidence,
        note: failed.length > 0 ? `未达标：${failed.slice(0, 5).join('；')}` : undefined,
      });
    } catch (err) {
      return errorResult(ctx.def, err instanceof Error ? err.message : 'LLM 调用失败');
    }
  }
}

// ── 3. 消息分类型（D6 九分类）──────────────────────────────

export interface MessageClassificationConfig {
  categories: Array<{ key: string; label: string; deduct: 'major' | 'minor' | 'none' }>;
  discipline: string[];   // 防误判纪律（写进提示词）
}

export class MessageClassificationScorer extends Scorer {
  readonly id: string;
  readonly needs = ['userMessages', 'trajectoryDigest'] as const;

  constructor(private readonly def: ScoreItemSchema, private readonly cfg: MessageClassificationConfig) {
    super();
    this.id = def.id;
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const msgs = ctx.input.userMessages.filter(m => m.text.trim().length > 0);
    if (msgs.length === 0) return notApplicable(ctx.def, '缺少用户消息，无法评判');
    if (!ctx.llm) return notApplicable(ctx.def, NO_LLM_NOTE, { naKind: 'gap' });

    const ask = `## 本次评审任务：用户消息分类（自主性）

结合前后轨迹判断每条用户消息的意图。

分类只能取这些值：
${this.cfg.categories.map(c => `- ${c.key}（${c.label}）`).join('\n')}

判定纪律（必须遵守）：
${this.cfg.discipline.map(d => `- ${d}`).join('\n')}

分类步骤：
1. 逐条读消息，先过一遍"不扣"的类别，再判是否属于扣分类别
2. 证据两可时判不扣的类别——宁可漏判，不可冤枉
3. category 只填上面列表里的 key

用户消息（共 ${msgs.length} 条，含轮次号）：
${msgs.map(m => `§${m.turnIndex} ${m.text.slice(0, 300)}`).join('\n')}

严格输出 JSON：
{"messages":[{"turnIndex":3,"category":"correction"}]}
每条消息都必须出现，turnIndex 与输入一致。`;

    try {
      const { parsed, retried } = await completeParsedJson(ctx.llm, GENERIC_JUDGE_SYSTEM, judgeMessage(ctx.input.trajectoryDigest, ask), judgeMeta(ctx));
      const arr = parsed?.['messages'];
      if (!Array.isArray(arr)) return errorResult(ctx.def, `分类输出解析失败${retried ? '（已自动重评一次仍失败）' : ''}（需 {"messages":[{turnIndex,category}]}）`);

      const catMap = new Map(this.cfg.categories.map(c => [c.key, c]));
      const counts: Record<string, number> = {};
      const evidence: SubItemResult['evidence'] = [];
      for (const r of arr) {
        if (!r || typeof r !== 'object') continue;
        const rr = r as { turnIndex?: unknown; category?: unknown };
        const cat = typeof rr.category === 'string' ? catMap.get(rr.category) : undefined;
        if (!cat || cat.deduct === 'none') continue;
        counts[cat.key] = (counts[cat.key] ?? 0) + 1;
        evidence.push({
          turnIndex: typeof rr.turnIndex === 'number' ? rr.turnIndex : null,
          label: `${cat.label}（扣 ${cat.deduct === 'major' ? '重' : '轻'}）`,
        });
      }
      // value = 扣重次数（count-deduction 主档）；分类统计进 evidence/note
      const majorCount = this.cfg.categories
        .filter(c => c.deduct === 'major')
        .reduce((s, c) => s + (counts[c.key] ?? 0), 0);
      const minorCount = this.cfg.categories
        .filter(c => c.deduct === 'minor')
        .reduce((s, c) => s + (counts[c.key] ?? 0), 0);
      const stats = this.cfg.categories
        .filter(c => (counts[c.key] ?? 0) > 0)
        .map(c => `${c.label} ${counts[c.key]} 次`)
        .join(' / ');
      return okResult(ctx.def, {
        value: majorCount + minorCount * 0.5,
        unit: 'events',
        formula: `LLM 分类：扣重 ${majorCount} 次 + 扣轻 ${minorCount} 次`,
        evidence,
        note: stats || '全部消息均为不扣类别',
      });
    } catch (err) {
      return errorResult(ctx.def, err instanceof Error ? err.message : 'LLM 调用失败');
    }
  }
}

// ── 4. 目标覆盖型（D1.goalCoverage）───────────────────────────────────

export class CoverageJudgeScorer extends Scorer {
  readonly id: string;
  readonly needs = ['userMessages', 'trajectoryDigest'] as const;

  constructor(private readonly def: ScoreItemSchema, private readonly cfg: { completionScore?: boolean } = {}) {
    super();
    this.id = def.id;
  }

  async run(ctx: ScorerContext): Promise<SubItemResult> {
    const first = ctx.input.userMessages[0];
    if (!first) return notApplicable(ctx.def, '缺少首轮用户消息，无法评判');
    if (!ctx.llm) return notApplicable(ctx.def, NO_LLM_NOTE, { naKind: 'gap' });

    // 工作流范围声明（全源 DB 恢复）：会话实质工作开始前载入的工作流 skill
    // 规程里声明了交付物范围时，验收口径以声明为准——首条消息的超范围条目
    // 不是 agent 的失职（如设计阶段工作流只交付 DESIGN.md，首条消息"开发
    // 完整版本"的超范围部分不得作为扣分依据），除非后续真人消息明确要求
    const scope = ctx.input.workflowScope;
    const scopeSection = scope
      ? `

工作流范围声明（本会话载入的工作流规程，${scope.skillName ? `skill：${scope.skillName}，` : ''}来源：${scope.source}）：
${scope.regulation}

范围裁定规则（优先于下面步骤 3 的常规判定）：
- 声明了交付物范围时，验收口径以声明范围为准；首轮消息里超出声明范围的条目标 out-of-scope（范围外），不计入 missing、不作为扣分依据
- 仅当后续真人消息明确要求范围外交付而轨迹未响应时，才可按该条目扣分（子代理派发/回传不算真人消息）
`
      : '';

    const ask = `## 本次评审任务：目标覆盖对账

从首轮用户消息抽取关键目标点，再逐项判断轨迹完成情况。
${scopeSection}
步骤（严格按顺序）：
1. 从下面的首轮消息里抽出 3~8 个可验证的关键目标点（隐含的常规要求如"代码要能跑"不算，抽任务特有的）
2. 逐项在轨迹材料里找完成证据（§N 轮次引用）
3. 每项判 covered（完成）/ partial（部分）/ missing（未做）${scope ? '/ out-of-scope（范围外——仅当上方给出了范围裁定规则、且该条目超出声明交付物范围时才可用）' : ''}
4. 找不到证据时不要猜成 covered

首轮用户消息：
§${first.turnIndex} ${first.text.slice(0, 2000)}

严格输出 JSON：
{"goals":[{"goal":"…","evidence":["§12"],"status":"covered"}]}
goal 用一句话；status 只能取 covered/partial/missing${scope ? '/out-of-scope' : ''}。`;

    try {
      const { parsed, retried } = await completeParsedJson(ctx.llm, GENERIC_JUDGE_SYSTEM, judgeMessage(ctx.input.trajectoryDigest, ask), judgeMeta(ctx));
      const arr = parsed?.['goals'];
      if (!Array.isArray(arr) || arr.length === 0) {
        return errorResult(ctx.def, `目标覆盖输出解析失败${retried ? '（已自动重评一次仍失败）' : ''}（需 {"goals":[{goal,status,evidence}]}）`);
      }
      const evidence: SubItemResult['evidence'] = [];
      let covered = 0;
      let partial = 0;
      let missing = 0;
      let outOfScope = 0;
      for (const r of arr) {
        if (!r || typeof r !== 'object') continue;
        const rr = r as { goal?: unknown; status?: unknown };
        const goal = typeof rr.goal === 'string' ? rr.goal : '（未命名目标）';
        // out-of-scope 仅在有工作流范围声明时成立；无声明会话 LLM 违规输出该
        // 状态时按未做（missing）计——分母不被静默剔出（review 意见）
        const status = rr.status === 'covered' ? 'covered' : rr.status === 'partial' ? 'partial' : rr.status === 'missing' ? 'missing'
          : rr.status === 'out-of-scope' && scope ? 'out-of-scope' : null;
        if (status === 'covered') covered++;
        else if (status === 'partial') partial++;
        else if (status === 'out-of-scope') outOfScope++;
        else missing++;
        const evTurns = validEvidenceTurns((r as { evidence?: unknown }).evidence, validTurnIndexes(ctx.input));
        evidence.push({ turnIndex: evTurns[0] ?? null, label: `${goal} → ${status ? verdictText(status) : '无法识别'}` });
      }
      // 范围外不计入覆盖分母（工作流声明的交付物范围优先；见 prompt 范围裁定规则）
      const denom = covered + partial + missing;
      if (denom === 0) {
        // 全部目标点范围外：会话无可评判的范围内目标——na 而非 0 分
        // （verdict 落 partial + score 0 会拉低完成度均值，review 意见）
        return notApplicable(ctx.def,
          `目标点 ${arr.length} 个全部为范围外（工作流声明的交付物范围不含首条消息任何条目），无范围内目标可评`,
          { evidence });
      }
      const verdict = missing > 0 ? 'missing' : covered > 0 ? 'covered' : 'partial';
      return okResult(ctx.def, {
        verdict,
        value: `${covered}✓/${denom}`,
        ...(this.cfg.completionScore ? { score: round2((covered + partial * 0.5) / Math.max(1, denom)) } : {}),
        formula: `目标点 ${arr.length} 个：已覆盖 ${covered} / 部分覆盖 ${partial} / 未覆盖 ${missing}${outOfScope > 0 ? ` / 范围外 ${outOfScope}（工作流声明范围，不计入）` : ''}`,
        evidence,
      });
    } catch (err) {
      return errorResult(ctx.def, err instanceof Error ? err.message : 'LLM 调用失败');
    }
  }
}
