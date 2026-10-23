// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Mate Agent 评审器：输出解析（claude/open code 两形态）+ 物料切片 + 规则层/LLM 项合并。

import { describe, it, expect } from 'vitest';
import { extractJson, extractOpencodeText, readGuide, mateDimensionsOf, llmItemsOf, dynamicItemsSection, dimensionLabel } from '../../src/lib/scoring/mate-agent/runner';
import { sliceOf, turnPredicate, toolPredicate } from '../../src/lib/scoring/mate-agent/material';
import { mergeMateCard, type MateAgentParsed } from '../../src/lib/scoring/mate-agent/coerce';
import { BUILTIN_DIMENSIONS } from '../../src/lib/scoring/definitions';
import { SCORECARD_SCHEMA, type Scorecard, type SubItemResult, type DimensionResult } from '../../src/lib/scoring/core/types';

describe('mate-agent 输出解析', () => {
  it('claude 纯文本：直接从正文抽 JSON（含代码围栏）', () => {
    const text = '```json\n{"summary":"ok","dimensions":[{"dimensionId":"D1"}]}\n```';
    expect(extractJson(text)).toEqual({ summary: 'ok', dimensions: [{ dimensionId: 'D1' }] });
  });

  it('claude 正文前后夹带文案也能抽出 JSON 对象', () => {
    const text = '以下是评审结果：\n{"dimensions":[{"dimensionId":"D2","verdict":"clean"}]}\n以上。';
    expect(extractJson(text)).toEqual({ dimensions: [{ dimensionId: 'D2', verdict: 'clean' }] });
  });

  it('没有 JSON 对象返回 null', () => {
    expect(extractJson('Error: Reached max turns (40)')).toBeNull();
  });

  it('正文先给示例 JSON 再给最终 JSON：从最后的 { 起解析，不被中间散文卡死', () => {
    const text = '格式如 {"dimensionId":"D6","items":[]} 所示。\n正文说明……\n{"dimensionId":"D6","items":[{"itemId":"D6.classification","value":0}]}';
    expect(extractJson(text)).toEqual({ dimensionId: 'D6', items: [{ itemId: 'D6.classification', value: 0 }] });
  });

  it('畸形输出不死循环：尾随 } / 括号不配平快速返回 null（start=0 时 lastIndexOf 钳位曾把事件循环同步冻死）', () => {
    expect(extractJson('{"score":8}}')).toBeNull();
    expect(extractJson('{"a": 1} } extra')).toBeNull();
    expect(extractJson('{"reason":"x","dims":[1,2} trailing')).toBeNull();
  });

  it('opencode NDJSON 事件流：取 text 段拼成正文', () => {
    const ev = (obj: unknown) => JSON.stringify(obj);
    const ndjson = [
      ev({ type: 'step_start', timestamp: 1 }),
      ev({ type: 'tool_use', part: { type: 'tool', tool: 'read' } }),
      ev({ type: 'text', part: { type: 'text', text: '{"summary":' } }),
      ev({ type: 'text', part: { type: 'text', text: '"ok"}' } }),
      ev({ type: 'step_finish', timestamp: 2 }),
    ].join('\n');
    expect(extractJson(extractOpencodeText(ndjson))).toEqual({ summary: 'ok' });
  });

  it('opencode 非 text 事件被忽略', () => {
    const ev = (obj: unknown) => JSON.stringify(obj);
    const ndjson = [
      ev({ type: 'step_start', timestamp: 1 }),
      ev({ type: 'tool_use', part: { type: 'tool', output: '<content>file</content>' } }),
      ev({ type: 'text', part: { type: 'text', text: '{"k":1}' } }),
    ].join('\n');
    expect(extractJson(extractOpencodeText(ndjson))).toEqual({ k: 1 });
  });
});

describe('GUIDE 输出风格', () => {
  it('判卷文字写给人看：去 AI 腔、不自造词语', async () => {
    const guide = await readGuide();
    expect(guide).toContain('写给人看');
    expect(guide).toContain('不要 AI 腔');
    expect(guide).toContain('不要自造词语');
  });

  it('任务尾附「本轮子项清单」时以清单为准（自适应评分配置的入口说明）', async () => {
    const guide = await readGuide();
    expect(guide).toContain('以清单为准');
  });
});

describe('评分配置自适应（mate 维度/子项清单从注册表推导）', () => {

  const d7 = {
    id: 'D7:doc-freshness', name: '文档更新及时性', english: 'Custom', role: 'optional' as const,
    includeInTotal: true, weightInTotal: 0.1,
    items: [{
      id: 'D7.doc-freshness', dimension: 'D7', name: '文档更新及时性', scorerKind: 'llm' as const,
      note: '设计变更后相关文档有没有同步更新',
      bands: [{ range: '7-8', label: '良好', description: '主要文档均已同步' }],
    }],
    aggregation: { kind: 'direct' as const },
  };
  const defs = [...BUILTIN_DIMENSIONS, d7];

  it('mateDimensionsOf：有 LLM 子项的维度才派（D4 不派、D7 用户维度照派）', () => {
    const dims = mateDimensionsOf(defs);
    expect(dims).toContain('D3');
    expect(dims).toContain('D7:doc-freshness');
    expect(dims).not.toContain('D4');
  });

  it('dimensionLabel：内置用中文名，D7 用注册表名称', () => {
    expect(dimensionLabel(defs, 'D3')).toBe('完成质量');
    expect(dimensionLabel(defs, 'D7:doc-freshness')).toBe('文档更新及时性');
  });

  it('dynamicItemsSection：内置子项指向 GUIDE；自定义子项展开说明与档位折算', () => {
    const items = llmItemsOf(defs, 'D7:doc-freshness');
    const section = dynamicItemsSection(items);
    expect(section).toContain('D7.doc-freshness');
    expect(section).toContain('设计变更后相关文档有没有同步更新');
    expect(section).toContain('score = 档位值/10');
    expect(section).toContain('7-8 良好');

    const builtin = dynamicItemsSection(llmItemsOf(BUILTIN_DIMENSIONS, 'D3'));
    expect(builtin).toContain('D3.correctness');
    expect(builtin).toContain('按 GUIDE 该子项的说明评');
    expect(dynamicItemsSection([])).toBe('');
  });
});

describe('mate 失败留痕', () => {
  it('解析失败时原始输出/stderr/退出码落盘；成功时不落', async () => {
    const { writeMateFailureLog, mateFailureLogDir } = await import('../../src/lib/scoring/mate-agent/runner');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-fail-log-'));
    process.env.MATE_AGENT_LOG_DIR = tmp;
    try {
      expect(await writeMateFailureLog('t1', 'D6', { raw: 'ok', stderr: '', exitCode: 0, durationMs: 5, parseError: null })).toBeNull();
      const file = await writeMateFailureLog('t1', 'D6', { raw: 'agent 只回了一段话，没有 JSON', stderr: 'warn', exitCode: 0, durationMs: 5, parseError: '输出里没有可直接解析的 JSON 对象' });
      expect(file).toBeTruthy();
      const body = fs.readFileSync(file!, 'utf-8');
      expect(body).toContain('agent 只回了一段话，没有 JSON');
      expect(body).toContain('exitCode: 0');
      expect(path.dirname(file!)).toBe(path.join(mateFailureLogDir(), 't1'));
    } finally {
      delete process.env.MATE_AGENT_LOG_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('material 维度切片（语义维：D1/D2/D3/D5/D6，无 D4）', () => {
  const turns = [
    { isSubagent: false, role: 'user' },
    { isSubagent: false, role: 'assistant' },
    { isSubagent: true, role: 'assistant' },
  ];
  const tools = ['bash', 'read', 'write', 'todowrite', 'grep'].map(toolName => ({ toolName }));

  it('slice 配置：D3 剔除 read；D5/D6 不含 toolcalls；D4 无切片', () => {
    expect(sliceOf('D3').tools).toContain('bash');
    expect(sliceOf('D3').tools).not.toContain('read');
    expect(sliceOf('D5').tools).toEqual([]);
    expect(sliceOf('D6').tools).toEqual([]);
    expect(sliceOf('D6').turns).toBe('user');
    // D4 不再是语义维，落到默认切片（不过滤）
    expect(sliceOf('D4').tools).toBeNull();
  });

  it('D2 白名单含提问工具：question 的用户答复是授权证据，滤掉就只剩"无用户消息"误判（现场 §f5fe259d）', () => {
    expect(toolPredicate('D2')({ toolName: 'question' })).toBe(true);
    expect(toolPredicate('D2')({ toolName: 'AskUserQuestion' })).toBe(true);   // 谓词按小写匹配
    expect(toolPredicate('D2')({ toolName: 'bash' })).toBe(true);
    expect(toolPredicate('D3')({ toolName: 'question' })).toBe(false);
  });

  it('memory 切片：D1/D2（验收清单/红线对账）带，D3/D5/D6 不带（项目说明相关性已删），全量带', () => {
    expect(sliceOf('D1').memory).toBe(true);
    expect(sliceOf('D2').memory).toBe(true);
    expect(sliceOf('D5').memory).toBe(false);
    expect(sliceOf('D3').memory).toBe(false);
    expect(sliceOf('D6').memory).toBe(false);
    expect(sliceOf().memory).toBe(true);
  });

  it('turnPredicate：root 排除子代理；user 仅用户', () => {
    expect(turns.filter(turnPredicate('D1'))).toHaveLength(2);
    expect(turns.filter(turnPredicate('D6'))).toHaveLength(1);
    expect(turns.filter(turnPredicate('D6'))[0].role).toBe('user');
  });

  it('toolPredicate：D3 只留 bash+write；无维度=全量；D6=空', () => {
    expect(tools.filter(toolPredicate('D3')).map(t => t.toolName)).toEqual(['bash', 'write']);
    expect(tools.filter(toolPredicate(undefined))).toHaveLength(5);
    expect(tools.filter(toolPredicate('D6'))).toHaveLength(0);
  });
});

// ── mergeMateCard：规则层取代码卡，LLM 项取 mate ──

const RULE_ITEMS: Record<string, { verdict?: string; score?: number; value?: number }> = {
  'D1.stopReason': { verdict: 'normal' },
  'D1.selfReport': { verdict: 'completed', score: 1 },
  'D1.planReconcile': { verdict: 'high', score: 0.9 },
  'D1.verifiedRun': { verdict: 'passed', score: 1 },
  'D2.destructive': { verdict: 'clean' },
  'D2.secrets': { verdict: 'clean' },
  'D2.access': { verdict: 'clean' },
  'D3.benchScore': { score: 0.8 },
  'D3.testResults': { verdict: 'passed', score: 1 },
  'D3.nakedWrite': { score: 0.6 },
  'D4.tokens': { score: 0.8 },
  'D4.llmTime': { score: 0.8 },
  'D4.turns': { score: 0.8 },
  'D5.redispatch': { score: 0.8 },
  'D6.interrupts': { value: 0 },
  'D6.similarMessages': { value: 0 },
};

function mkRuleCard(): Scorecard {
  const dimensions: DimensionResult[] = BUILTIN_DIMENSIONS.map(def => ({
    dimensionId: def.id,
    name: def.name,
    english: def.english,
    role: def.role,
    status: 'scored',
    items: def.items.map<SubItemResult>(it => {
      if (it.scorerKind === 'llm') return { itemId: it.id, label: it.name, status: 'not-applicable', evidence: [] };
      const r = RULE_ITEMS[it.id];
      if (r) return { itemId: it.id, label: it.name, status: 'ok', verdict: r.verdict, score: r.score, value: r.value, evidence: [] };
      return { itemId: it.id, label: it.name, status: 'not-applicable', evidence: [] };
    }),
  }));
  return {
    schemaVersion: SCORECARD_SCHEMA,
    sessionId: 's1',
    taskType: 'operator',
    computedAt: '',
    status: 'completed',
    framework: { totalScore: null, veto: null, coverage: 1, weightsUsed: {} },
    dimensions,
    judgeCost: null,
  };
}

describe('mergeMateCard：规则层取代码卡 + LLM 项取 mate', () => {
  const mateParsed: MateAgentParsed = {
    dimensions: [
      { dimensionId: 'D1', items: [{ itemId: 'D1.goalCoverage', verdict: 'covered', score: 1 }, { itemId: 'D1.acceptance', verdict: 'na' }] },
      { dimensionId: 'D2', items: [{ itemId: 'D2.authorization', verdict: 'authorized' }, { itemId: 'D2.redlines', verdict: 'na' }] },
      { dimensionId: 'D3', items: [
        { itemId: 'D3.correctness', score: 0.8 }, { itemId: 'D3.instruction', score: 0.8 },
        { itemId: 'D3.robustness', score: 0.8 }, { itemId: 'D3.maintainability', score: 0.9 }, { itemId: 'D3.safeCoding', score: 0.8 },
      ]},
    ],
  };

  it('规则项来自代码卡、LLM 项来自 mate、聚合复用引擎', () => {
    const card = mergeMateCard(mkRuleCard(), mateParsed, BUILTIN_DIMENSIONS, { sessionId: 's1' });
    expect(card.status).toBe('completed');
    expect(card.review).toBeUndefined();
    expect(card.judgeCost).toBeNull();   // 本地 agent 判卷无 LLM 记账，不放假数
    const d1 = card.dimensions.find(d => d.dimensionId === 'D1')!;
    // 规则项：来自代码卡
    expect(d1.items.find(i => i.itemId === 'D1.stopReason')!.verdict).toBe('normal');
    expect(d1.items.find(i => i.itemId === 'D1.selfReport')!.verdict).toBe('completed');
    // LLM 项：来自 mate（覆盖代码卡的 not-applicable）
    expect(d1.items.find(i => i.itemId === 'D1.goalCoverage')!.verdict).toBe('covered');
    expect(d1.verdict).toBe('完成');
    const d2 = card.dimensions.find(d => d.dimensionId === 'D2')!;
    expect(d2.verdict).toBe('clean');
    expect(d2.items.find(i => i.itemId === 'D2.authorization')!.verdict).toBe('authorized');
  });

  it('D4/D5/D6 规则分与代码卡一致（不经 mate 重算）', () => {
    const card = mergeMateCard(mkRuleCard(), mateParsed, BUILTIN_DIMENSIONS, { sessionId: 's1' });
    const d4 = card.dimensions.find(d => d.dimensionId === 'D4')!;
    expect(d4.items.find(i => i.itemId === 'D4.tokens')!.score).toBe(0.8);
    const d6 = card.dimensions.find(d => d.dimensionId === 'D6')!;
    expect(d6.items.find(i => i.itemId === 'D6.interrupts')!.value).toBe(0);
    expect(d6.score).toBe(1);
  });

  it('review 盖章：路由传入的评审来源/工具/完成时间原样落卡', () => {
    const card = mergeMateCard(mkRuleCard(), mateParsed, BUILTIN_DIMENSIONS, { sessionId: 's1' },
      { reviewer: 'mate', tool: 'opencode', completedAt: '2026-09-26T10:00:00.000Z', durationMs: 12345 });
    expect(card.review).toEqual({ reviewer: 'mate', tool: 'opencode', completedAt: '2026-09-26T10:00:00.000Z', durationMs: 12345 });
  });

  it('naKind 三态源头盖章：没输出/非法分值=gap（折覆盖度），明确判 na（无 note 也是）/带不适用说明=absent（不折）', () => {
    // 回归（review ①）：verdict:"na" 无 note 曾走「未覆盖」分支被归 gap 折覆盖度
    //（与 9a18550 声称语义相反）；score>10 坏值曾带固定 note 被记 absent 虚高
    const parsed: MateAgentParsed = {
      dimensions: [
        { dimensionId: 'D1', items: [
          { itemId: 'D1.goalCoverage', verdict: 'covered', score: 1 },
          // D1.acceptance 不输出 → 没输出 = gap
        ]},
        { dimensionId: 'D2', items: [
          { itemId: 'D2.authorization', verdict: 'authorized' },
          { itemId: 'D2.redlines', verdict: 'na' },
        ]},
        { dimensionId: 'D3', items: [
          { itemId: 'D3.correctness', score: 42 },
          { itemId: 'D3.instruction', verdict: 'na', note: '材料里无指令遵循痕迹' },
        ]},
      ],
    };
    const card = mergeMateCard(mkRuleCard(), parsed, BUILTIN_DIMENSIONS, { sessionId: 's1' });
    const item = (dim: string, id: string) =>
      card.dimensions.find(d => d.dimensionId === dim)!.items.find(i => i.itemId === id)!;
    expect(item('D1', 'D1.acceptance').naKind).toBe('gap');
    expect(item('D2', 'D2.redlines').naKind).toBe('absent');
    expect(item('D3', 'D3.correctness').naKind).toBe('gap');
    expect(item('D3', 'D3.instruction').naKind).toBe('absent');
  });

  it('证据倾向标注透传（优缺点分组展示的数据源）：good/bad 原样、违约别名归一、没标为 undefined', () => {
    const parsed: MateAgentParsed = {
      dimensions: [{
        dimensionId: 'D3',
        items: [{
          itemId: 'D3.correctness', score: 0.8,
          evidence: [
            { turn: 12, note: '返工后闭环', impact: 'bad' },
            { turn: 20, note: '产物被下游消费', impact: '加' },
            { turn: 30, note: '中性过程事实' },
          ],
        }],
      }],
    };
    const card = mergeMateCard(mkRuleCard(), parsed, BUILTIN_DIMENSIONS, { sessionId: 's1' });
    const ev = card.dimensions.find(d => d.dimensionId === 'D3')!.items.find(i => i.itemId === 'D3.correctness')!.evidence;
    expect(ev.map(e => e.impact)).toEqual(['bad', 'good', undefined]);
  });

  it('截断卡整卡出局：mergeMateCard 原样返回 aborted 卡，不合并出假 completed 卡', () => {
    const aborted: Scorecard = { ...mkRuleCard(), status: 'aborted', abortReason: 'truncated', dimensions: [] };
    const card = mergeMateCard(aborted, mateParsed, BUILTIN_DIMENSIONS, { sessionId: 's1' },
      { reviewer: 'mate', tool: 'claude', completedAt: '2026-09-26T10:00:00.000Z' });
    expect(card).toBe(aborted);
    expect(card.status).toBe('aborted');
    expect(card.dimensions).toHaveLength(0);
  });

  it('score 标度归一：违约 0-10（如 8）折算 /10；0-1 原样；>10 弃用为无法评判', () => {
    const parsed: MateAgentParsed = {
      dimensions: [{ dimensionId: 'D3', items: [
        { itemId: 'D3.correctness', score: 8 },
        { itemId: 'D3.instruction', score: 0.7 },
        { itemId: 'D3.robustness', score: 12 },
      ]}],
    };
    const card = mergeMateCard(mkRuleCard(), parsed, BUILTIN_DIMENSIONS, { sessionId: 's1' });
    const items = card.dimensions.find(d => d.dimensionId === 'D3')!.items;
    expect(items.find(i => i.itemId === 'D3.correctness')!.score).toBeCloseTo(0.8);
    expect(items.find(i => i.itemId === 'D3.instruction')!.score).toBe(0.7);
    const robust = items.find(i => i.itemId === 'D3.robustness')!;
    expect(robust.status).toBe('not-applicable');
    expect(robust.score).toBeUndefined();
  });

  it('mate 判 goalCoverage missing → D1 未完成 → 否决触发（与代码卡同规则）', () => {
    const missing: MateAgentParsed = {
      dimensions: [{ dimensionId: 'D1', items: [{ itemId: 'D1.goalCoverage', verdict: 'missing', score: 0 }] }],
    };
    const card = mergeMateCard(mkRuleCard(), missing, BUILTIN_DIMENSIONS, { sessionId: 's2' });
    expect(card.dimensions.find(d => d.dimensionId === 'D1')!.verdict).toBe('未完成');
    expect(card.framework.veto?.triggered).toBe(true);
    expect(card.framework.totalScore).toBe(0);
  });

  it('mate 判 authorization 违规（旧词 unauthorized / 新词 violation）→ 归一为 violation，D2 聚合触发（词表与 LLM 路径一致）', () => {
    for (const verdict of ['unauthorized', 'violation'] as const) {
      const parsed: MateAgentParsed = {
        dimensions: [{ dimensionId: 'D2', items: [{ itemId: 'D2.authorization', verdict }] }],
      };
      const card = mergeMateCard(mkRuleCard(), parsed, BUILTIN_DIMENSIONS, { sessionId: 's3' });
      const d2 = card.dimensions.find(d => d.dimensionId === 'D2')!;
      expect(d2.items.find(i => i.itemId === 'D2.authorization')!.verdict).toBe('violation');
      expect(d2.verdict).toBe('violation');
      expect(d2.score).toBe(0.65);                     // 按次扣分：1 次违规 −0.35，不整维归零
    }
  });
});

describe('exportMaterial：项目说明切片（IT）', () => {
  it('注入了项目说明的会话：D1/D2 目录带 project-instructions.md（内容可对账），D3/D5 不带（项目说明相关性已删）', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { importSession } = await import('../../src/lib/ingest/data-service');
    const { exportMaterial } = await import('../../src/lib/scoring/mate-agent/material');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const prisma = new PrismaClient();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-mat-it-'));
    const sid = 'sess-mate-material';
    try {
      const file = path.join(tmp, 'fixture.jsonl');
      const stamp = () => new Date(Date.parse('2026-09-26T10:00:00.000Z')).toISOString();
      const lines = [
        { type: 'user', message: { role: 'user', content: '# claudeMd\n\n本项目红线：禁止直接 push master。\n验收清单：1) 跑通测试 2) 更新文档\n\n# currentDate\n2026-09-26' }, timestamp: stamp() },
        {
          type: 'assistant',
          message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], model: 'm', usage: { input_tokens: 10, output_tokens: 5 } },
          timestamp: stamp(),
          // opencode 形态扩展：system prompt 里带 skills 的验收/校验指令（memory 字段为空时的兜底来源）
          system: 'You are opencode … workspace: ops-registry … ops-spec-gen：生成或校验算子 spec.yaml，机器复核验收条目',
          tools: [{ name: 'Bash', description: 'run' }],
        },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '6 passed' }] }, timestamp: stamp() },
      ];
      fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
      await prisma.session.deleteMany({ where: { taskId: sid } });
      await importSession(file, sid, prisma, file, 'claude-jsonl');

      const root = path.join(tmp, 'mat');
      const d1 = await exportMaterial(sid, prisma, undefined, { rootDir: root, dimension: 'D1' });
      const memory = fs.readFileSync(path.join(d1.dir, 'project-instructions.md'), 'utf-8');
      expect(memory).toContain('禁止直接 push master');
      expect(memory).toContain('验收清单');
      // system 兜底材料：memory 字段为空时验收清单/红线从 system prompt（skills 指令）找
      const sysMd = fs.readFileSync(path.join(d1.dir, 'system-context.md'), 'utf-8');
      expect(sysMd).toContain('主链 system prompt');
      expect(sysMd).toContain('ops-spec-gen');

      const d2 = await exportMaterial(sid, prisma, undefined, { rootDir: root, dimension: 'D2' });
      expect(fs.existsSync(path.join(d2.dir, 'project-instructions.md'))).toBe(true);
      expect(fs.existsSync(path.join(d2.dir, 'system-context.md'))).toBe(true);

      for (const dim of ['D3', 'D5']) {
        const d = await exportMaterial(sid, prisma, undefined, { rootDir: root, dimension: dim });
        expect(fs.existsSync(path.join(d.dir, 'project-instructions.md'))).toBe(false);
        expect(fs.existsSync(path.join(d.dir, 'system-context.md'))).toBe(false);
      }
    } finally {
      await prisma.session.deleteMany({ where: { taskId: sid } }).catch(() => {});
      await prisma.execution.deleteMany({ where: { session: { taskId: sid } } }).catch(() => {});
      await prisma.$disconnect();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
