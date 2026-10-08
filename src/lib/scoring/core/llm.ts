// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// LLM 通道（角色② LLM 侧）：复用现有语义评审的配置与调用形态。
// URL 归一唯一权威源 buildChatUrl（仓库红线，禁调用方内联拼）；json_object 硬约束。
// 评审自身成本记账：每次调用记 calls/tokens——评别人的账自己也要记账（§9）。

import { buildChatUrl, stripJsonFence, type AIProviderConfig } from '@/lib/ai/analyzer';
import type { JudgeCallMeta, LlmClient } from './assembler/types';
import type { JudgeJournal } from './judge-log';
import type { Band, ScoreItemSchema } from './schema';

export class TrackedLlmClient implements LlmClient {
  readonly model: string;
  calls = 0;
  tokens = 0;

  constructor(private readonly provider: AIProviderConfig, private readonly journal?: JudgeJournal, private readonly sessionId = '?') {
    this.model = provider.model;
  }

  async complete(system: string, user: string, meta: JudgeCallMeta = { dimensionId: '?', itemId: '?', itemName: '?' }): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    const chatUrl = buildChatUrl(this.provider.baseUrl);
    // 传输层异常只重试一次：超时（并行×3 后网关排队，重 judge 单次可超 180s）与
    // 空正文/截断（推理型模型把预算花在思考上，finish_reason=length）——预算按
    // 挡位逐级上调（4k → 16k → 32k，覆盖长思考模型）。有正文但解析失败不在此列
    // ——那是格式问题，按 §9 记错误态不猜不凑数。
    const TOKEN_LADDER = [4096, 16384, 32768] as const;
    const TIMEOUT_MS = 300000;
    for (let attempt = 1; attempt <= TOKEN_LADDER.length; attempt++) {
      const maxTokens = TOKEN_LADDER[attempt - 1];
      let res: Response;
      const promptChars = system.length + user.length;
      this.journal?.request(meta, attempt, system, user);
      const t0 = Date.now();
      try {
        res = await fetch(chatUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.provider.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.7,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || /aborted.*timeout/i.test(e.message));
        this.journal?.response(this.sessionId, meta, { attempt, maxTokens, latencyMs: Date.now() - t0, promptChars, error: e instanceof Error ? e.message : String(e), ...(timedOut ? { retryReason: 'timeout' as const } : {}) });
        if (timedOut && attempt === 1) continue;
        if (timedOut) throw new Error(`LLM 调用超时（${TIMEOUT_MS / 1000}s · model=${this.provider.model}），重试一次仍超时`);
        throw e;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        const urlForError = chatUrl.replace(/\?.*$/, '');
        const msg = `LLM ${res.status}（${urlForError} · model=${this.provider.model}）: ${body || '无响应体'}`;
        this.journal?.response(this.sessionId, meta, { attempt, maxTokens, latencyMs: Date.now() - t0, promptChars, status: res.status, error: msg });
        throw new Error(msg);
      }
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // 记账按「每次真实消耗」累计：梯级重试（截断升预算/空正文升挡）的前几
      // 次响应同样花钱，只在最终成功 attempt 记账会系统性少记（journal 全有、
      // 卡上没有）。超时 attempt 无响应无 usage，不计
      this.calls++;
      this.tokens += (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      const finish = choice?.finish_reason;
      // 截断（finish_reason=length）：推理型模型把输出预算花在思考上、正文被腰斩——
      // 按挡位逐级升预算重试；末挡仍截断则照返正文，由调用方按缺失字段报错，
      // 而不是落成"证据不足"的假弃权。
      if (content && finish === 'length' && attempt < TOKEN_LADDER.length) {
        this.journal?.response(this.sessionId, meta, { attempt, maxTokens, latencyMs: Date.now() - t0, promptChars, content, promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0, status: res.status, stopReason: finish, retryReason: 'truncated' });
        continue;
      }
      if (content) {
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;
        this.journal?.response(this.sessionId, meta, { attempt, maxTokens, latencyMs: Date.now() - t0, promptChars, content, promptTokens, completionTokens, status: res.status, stopReason: finish });
        return { content, promptTokens, completionTokens };
      }
      if (attempt === TOKEN_LADDER.length) {
        const finishName = finish ?? 'unknown';
        const reasoning = choice?.message?.reasoning_content ? '（reasoning_content 非空——疑似思考耗尽 token 配额）' : '';
        const msg = `LLM 响应正文为空（finish_reason=${finishName}）${reasoning}`;
        this.journal?.response(this.sessionId, meta, { attempt, maxTokens, latencyMs: Date.now() - t0, promptChars, status: res.status, stopReason: finish, error: msg, retryReason: 'empty-content' });
        throw new Error(msg);
      }
      this.journal?.response(this.sessionId, meta, { attempt, maxTokens, latencyMs: Date.now() - t0, promptChars, status: res.status, stopReason: finish, error: `空正文（finish_reason=${finish ?? 'unknown'}）`, retryReason: 'empty-content' });
    }
    throw new Error('LLM 响应正文为空（未收到有效 content）');
  }

  cost(): { calls: number; tokens: number } {
    return { calls: this.calls, tokens: this.tokens };
  }
}

// ── 输出三层约束（§9）：格式硬校验 / 说明进提示词 / 解析失败明说 ──

/** 解析失败返回 null——不猜一个凑数、不静默重试，调用方记错误态 */
export function parseJudgeJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonFence(content)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/** 子项 verdict 的中文显示文案：权威源在 verdict-text.ts（服务端与客户端组件共读），此处转出口 */
export { VERDICT_TEXT, verdictText } from './verdict-text';

/**
 * 保底重试（最多两次）：正文解析不出 JSON 对象时再评一次——强化「只输出一个 JSON
 * 对象」（重试指令拼在 user 尾部，轨迹摘要前缀不变，网关前缀缓存仍命中）。
 * 重试仍解析失败返回 parsed=null（调用方记错误态，不猜不凑数，§9 不变）。
 */
export async function completeParsedJson(
  llm: LlmClient,
  system: string,
  user: string,
  meta: JudgeCallMeta,
): Promise<{ parsed: Record<string, unknown> | null; retried: boolean }> {
  const first = await llm.complete(system, user, meta);
  const parsed = parseJudgeJson(first.content);
  if (parsed) return { parsed, retried: false };
  const retryUser = `${user}\n\n—— 本次是重试：上一次的输出不是合法的 JSON 对象，无法解析。本次回复必须是一个单独的 JSON 对象——不要 markdown 围栏、不要在 JSON 前后加任何文字，字段结构按上面要求。`;
  const second = await llm.complete(system, retryUser, meta);
  return { parsed: parseJudgeJson(second.content), retried: true };
}

/** 分数落在档位外（0-10 档给了 7.3）→ 代码自动拉回最近的合法档（取档中值）；整数分（0-10）直接采用不塌缩 */
export function clampToBandScore(score: number, bands: Band[]): number {
  const s = Math.max(0, Math.min(10, score));
  if (Number.isInteger(s)) return s;
  const values = bands.map(b => {
    const m = b.range.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    return { lo, hi, mid: (lo + hi) / 2 };
  }).filter((v): v is { lo: number; hi: number; mid: number } => v != null);
  if (values.length === 0) return Math.round(score);
  const nearest = values.reduce((a, b) => (Math.abs(s - b.mid) < Math.abs(s - a.mid) ? b : a));
  return Math.round(nearest.mid);
}

/** §N 证据校验：对不上材料里真实轮次的引用剔除（设计 D1.acceptance 三道保险之二） */
export function validEvidenceTurns(evidence: unknown, validTurnIndexes: number[]): number[] {
  if (!Array.isArray(evidence)) return [];
  const valid = new Set(validTurnIndexes);
  const out: number[] = [];
  for (const e of evidence) {
    if (typeof e !== 'string') continue;
    const m = e.match(/§?(\d+)/);
    if (!m) continue;
    const n = Number(m[1]);
    if (valid.has(n)) out.push(n);
  }
  return out;
}

/** 证据项（带一句话依据）——打分型 judge 用它让每个 §N chip 带上下文，而不是裸 turn 号 */
export interface EvidenceItem {
  turnIndex: number;
  note: string;
  impact?: 'good' | 'bad';
}

/** 解析证据轮次并保留 note：新格式 [{turn,note}] 为主，兼容旧格式 ["§N"]（note 为空回退）。 */
export function validEvidenceItems(evidence: unknown, validTurnIndexes: number[]): EvidenceItem[] {
  if (!Array.isArray(evidence)) return [];
  const valid = new Set(validTurnIndexes);
  const out: EvidenceItem[] = [];
  for (const e of evidence) {
    if (e != null && typeof e === 'object' && !Array.isArray(e)) {
      const raw = (e as { turn?: unknown; note?: unknown }).turn;
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isInteger(n) || !valid.has(n)) continue;
      const imp = (e as { impact?: unknown }).impact;
      out.push({
        turnIndex: n,
        note: typeof (e as { note?: unknown }).note === 'string' ? (e as { note: string }).note : '',
        impact: imp === 'good' || imp === 'bad' ? imp : undefined,
      });
      continue;
    }
    if (typeof e === 'string') {
      const m = e.match(/§?(\d+)/);
      if (!m) continue;
      const n = Number(m[1]);
      if (valid.has(n)) out.push({ turnIndex: n, note: '' });
    }
  }
  return out;
}

/**
 * 通用评审 system：全部 LLM 子项共享同一 system + 消息前部（轨迹摘要），
 * 只有消息尾部的子项要求不同——支持的网关可命中前缀缓存，15 次调用只
 * 全价处理一遍长摘要（并行改造的另一半）。
 */
export const GENERIC_JUDGE_SYSTEM =
  '你是 workflow 轨迹的评审员（取证型 judge）。只依据给定材料中的可见证据作答，证据不足时弃权，禁止臆测。严格输出 JSON（无 markdown 代码块标记）。输出一律先写推理字段再写结论字段（reason/note 在前，score/status 在后）——推理没写完不得下结论。reason/note/evidence 写给人看：简明中文短句直说事实（哪一轮做了什么）；不用 AI 腔（如"总体而言""值得注意的是"这类套话），不自造词语、术语或缩写。';

// ── Prompt 装配：评分定义一源多用（名称/档位说明 → prompt / 校验 / 文案）──

export function bandListText(bands: Band[]): string {
  return bands.map(b => `- ${b.range}（${b.label}）：${b.description}`).join('\n');
}

/** 单维评分型子项要求（D3 五项 / D5 熟练度 / D7 自定义）——拼接在轨迹摘要之后 */
export function buildBandJudgeAsk(item: ScoreItemSchema, focus: string): string {
  return `## 本次评审任务：${item.name}

考察点：${focus}

评分步骤（严格按顺序执行）：
1. 通读材料，找出与该维度相关的证据轮次（§N 引用格式）
2. reason 以「逐步核对：」开头，逐条列出依据（引用 §N），推理完再定位档位
3. 按下面的档位标准定位分数（0-10 整数）
4. 只依据材料中可见的证据评分；证据不足时 score 填 null，reason 说明缺什么证据——禁止臆测
5. 不满分必须说扣分点：score 低于满分时至少给一条 impact:"bad" 的证据（或 reason 明说扣在哪）；找不出扣分点就给满分——不许无理由扣分

档位标准：
${bandListText(item.bands ?? [])}

严格输出 JSON（无 markdown 代码块标记）：
{"reason": "逐步核对：…依据与推理…", "score": 8, "evidence": [{"turn": 12, "note": "一句话依据", "impact": "bad"}, {"turn": 45, "note": "一句话依据", "impact": "good"}]}
reason 必须写在 score 之前完成（先推理后结论）；score 为 0-10 整数或 null；evidence 只填材料中真实存在的 turn 序号，每条 note 用一句话说清该轮证据是什么（禁止只写"评审证据/依据"这类空话）；impact 标该条证据的倾向——支持加分/表现好填 "good"，是问题/扣分原因填 "bad"，中性过程事实可省略。`;
}
