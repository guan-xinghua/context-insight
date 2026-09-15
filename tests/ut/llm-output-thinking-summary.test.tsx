// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// thinking 吃掉 200 字符摘要预算（客户现场：turn 143 "22t reasoning + 340t
// output" 折叠预览全是 <thinking> 开头，被误读为 output 未展示；正文实际在
// 下方 text 块完整可见）。两层修复的 IT：
//   ① 显示层——LlmOutputView 标题行预览优先取 text section（存量数据立即
//      生效），thinking 折叠块与正文 text 块行为不变
//   ② ingest 层——splitIntoTurns 的 contentSummary 剥 <thinking>/<system-reminder>
//      后再截 200；content 全文保真不截
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { LlmOutputView } from '@/components/observe/LlmOutputView'
import { splitIntoTurns } from '@/lib/ingest/turn-split'
import type { RawInteraction } from '@/lib/shared/types'

// 现场 turn 143 原样（ses_f986a318…，854 字符 = thinking + 完整报告正文）
const TURN143_CONTENT = `<thinking>The report has been written. Give the final reply: report path + status + summary of the issue list.</thinking>

**报告路径**: \`/workspace/reduction/fusion_paradigm_xsx/plugins-official/ops-registry-invoke-IR/op-design-with-ir-flow/output/bn3d_training_update_grad/reviews/P1/requirements_review.md\`

**状态**: ✅通过

**问题清单摘要**：
- **MED-1 ⚠**（不阻塞）：行号虚指——属出处虚指而非结论无据，建议返工时改为如实表述。
- **LOW-1 已订正**（订正单范围）：ops_legacy 编译产物清单错误 → 已就地改为实测清单。

抽样复现 7 组均复现；核心结论独立证实成立。`

// 修复前的存量 contentSummary（ingest 期生成，thinking 占掉预算，正文只剩路径开头）
const LEGACY_SUMMARY = TURN143_CONTENT.substring(0, 200)

describe('① LlmOutputView：预览优先正文，thinking 不再霸占折叠行', () => {
  it('标题行预览以 **报告路径** 开头（含正文），不再显示 <thinking>（存量数据立即生效）', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: TURN143_CONTENT,
      contentJson: null,
      contentSummary: LEGACY_SUMMARY,
      outputTokens: 340,
      reasoningTokens: 22,
      role: 'assistant',
    }))
    // 预览 = text section 前 200 字符（**报告路径** 开头）
    expect(html).toContain('**报告路径**')
    expect(html).not.toContain('<thinking>')
    // thinking 折叠块默认收起 → 思考正文不出现在静态输出
    expect(html).not.toContain('The report has been written')
    // 正文 text 块完整渲染（初始展开：340t ≤ 2000 且 854 ≤ 6000）
    expect(html).toContain('核心结论独立证实成立')
    expect(html).toContain('22t reasoning + 340t output')
  })

  it('无 thinking 的普通 turn 预览行为不变（等价旧 fallback）', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: 'plain reply body',
      contentJson: null,
      contentSummary: null,
      outputTokens: 10,
      role: 'assistant',
    }))
    expect(html).toContain('plain reply body')
  })

  it('带工具调用时 text 徽标注明 token 构成（outputTokens 含工具参数，现场 turn 142）', () => {
    // 现场 ses_f986a318… turn 142：thinking 3K 字符 + text 一句话 + write 调用
    // （参数 7059 字符 = 报告全文）。outputTokens 大头是工具参数，记在 text
    // 头上会被读成"这么点 token 的输出怎么只有一句话"。静态渲染初始折叠
    // （outputTokens > 2000），用阈值内等价数据验证同一徽标逻辑
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: '<thinking>订正完成并复验。现在写审核报告。</thinking>\n\n所有检查完成。写审核报告：',
      contentJson: null,
      contentSummary: null,
      outputTokens: 1500,
      reasoningTokens: 1650,
      role: 'assistant',
      toolCallCount: 1,
    }))
    expect(html).toContain('1.5kt · 含 1 个工具调用参数')
    expect(html).toContain('所有检查完成。写审核报告：')
  })

  it('无工具调用时 text 徽标保持原样（纯 text 输出 token 准确）', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: '完成',
      contentJson: null,
      contentSummary: null,
      outputTokens: 340,
      role: 'assistant',
    }))
    expect(html).toContain('340t')
    expect(html).not.toContain('工具调用参数')
  })

  it('user turn 的 <system-reminder> 前缀不进折叠预览（与 ingest 剥离同口径）', () => {
    // review 回归锁：textPreview 恒优先后，无 thinking 的 user turn 其 text
    // section = 原文（含 reminder），若不剥离预览会退回 XML 标签噪音。
    // 展开区显示全文（wire 保真，reminder 保留）
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: '<system-reminder>internal noise</system-reminder>真实提示内容',
      contentJson: null,
      contentSummary: null,
      outputTokens: 0,
      role: 'user',
    }))
    // 折叠预览 span 的文本 = 正文（reminder 不进预览）
    expect(html).toContain('max-w-[400px]">真实提示内容</span>')
    // 展开区全文保真
    expect(html).toContain('internal noise')
  })
})

describe('② splitIntoTurns：contentSummary 剥 thinking/reminder，content 全文保真', () => {
  it('assistant 摘要以正文开头，thinking 只留在 content', () => {
    const interactions: RawInteraction[] = [{
      role: 'assistant',
      content: TURN143_CONTENT,
      timestamp: new Date('2026-09-15T10:00:00Z').getTime(),
      usage: { input: 10, output: 340, reasoning: 22, total: 372 },
    } as unknown as RawInteraction]
    const { turns } = splitIntoTurns(interactions, 'test-session')
    const t = turns[0]
    expect(t.content).toBe(TURN143_CONTENT)
    expect(t.contentSummary).toBeTruthy()
    expect(t.contentSummary).not.toContain('<thinking>')
    expect(t.contentSummary).not.toContain('The report has been written')
    expect(t.contentSummary!.startsWith('**报告路径**')).toBe(true)
  })

  it('user turn 的 <system-reminder> 前缀剥除行为保留', () => {
    const interactions: RawInteraction[] = [{
      role: 'user',
      content: '<system-reminder>internal noise</system-reminder>真实提问内容',
      timestamp: new Date('2026-09-15T10:00:00Z').getTime(),
    } as unknown as RawInteraction]
    const { turns } = splitIntoTurns(interactions, 'test-session')
    expect(turns[0].content).toContain('<system-reminder>')
    expect(turns[0].contentSummary).toBe('真实提问内容')
  })
})
