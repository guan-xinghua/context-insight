// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 自定义维度试算：编辑时对当前 session 立即跑一次——规则维度零 LLM 即时出，
// LLM 维度用页面带来的 provider 配置真调一次评审。标准没写对当场就知道，
// 不用保存后跑完整评分再回来找。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logError } from '@/lib/logger';
import { assembleInput } from '@/lib/scoring/core/assembler';
import { TrackedLlmClient } from '@/lib/scoring/core/llm';
import { isValidUserDimension, userDimensionScorers } from '@/lib/scoring';
import type { ScoreItemSchema } from '@/lib/scoring/core/schema';
import type { LlmClient } from '@/lib/scoring/core/assembler/types';

export const maxDuration = 300;

interface TryBody {
  taskId?: string;
  dimension?: unknown;
  provider?: { baseUrl?: string; apiKey?: string; model?: string };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as TryBody;
    if (!body.taskId || !body.dimension) {
      return NextResponse.json({ error: 'Missing taskId / dimension' }, { status: 400 });
    }
    if (!isValidUserDimension(body.dimension)) {
      return NextResponse.json({ error: '维度定义不完整（规则型查信号/比较/阈值，LLM 型查每档大白话）' }, { status: 400 });
    }
    const dim = body.dimension;

    const assembled = await assembleInput(body.taskId, prisma);
    if (!assembled) return NextResponse.json({ error: `session not found: ${body.taskId}` }, { status: 404 });
    const { input, raw } = assembled;

    let llm: LlmClient | undefined;
    if (dim.kind !== 'rule') {
      const p = body.provider;
      if (!p?.apiKey || !p?.baseUrl || !p?.model) {
        return NextResponse.json({ error: 'LLM 维度试算需要评审模型配置（先在页面上配置 LLM）' }, { status: 400 });
      }
      llm = new TrackedLlmClient({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }, undefined, raw.session.sessionId);
    }

    const item: ScoreItemSchema = {
      id: `D7.${dim.id}`,
      dimension: 'D7',
      name: dim.name,
      scorerKind: dim.kind === 'rule' ? 'rule' : 'llm',
      note: dim.description,
    };
    const scorer = userDimensionScorers(dim)[0];
    if (!scorer) return NextResponse.json({ error: '评分器装配失败' }, { status: 500 });
    const result = await scorer.run({ input, def: item, llm, samples: 1 });
    return NextResponse.json({ result });
  } catch (e) {
    logError('route:observe/scoring/user-definitions/try', '试算失败', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'internal error' }, { status: 500 });
  }
}
