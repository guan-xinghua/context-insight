// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 评分标准公示面板（v2 六维）：维度定义直接引用注册表（一源多用——
// 评分器用什么标准，这里就公示什么，永不漂移）。生效口径来自 profiles API。

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BUILTIN_DIMENSIONS } from '@/lib/scoring/definitions';
import { PRESETS } from '@/lib/scoring/core/profile/presets';

export function ScoringCriteria() {
  const [activeName, setActiveName] = useState<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      void (async () => {
        try {
          const res = await fetch('/api/observe/scoring/profiles');
          const data = await res.json() as { activeId?: string | null; profiles?: Array<{ id: string; name: string }> };
          if (!res.ok) return;
          const activeId = data.activeId ?? null;
          if (activeId == null) return;
          setActiveName(PRESETS.find(p => p.id === activeId)?.name
            ?? data.profiles?.find(p => p.id === activeId)?.name
            ?? activeId);
        } catch { /* 口径行拿不到就按默认显示 */
        }
      })();
    });
  }, []);

  return (
    <Card size="sm">
      <CardHeader className="py-3">
        <CardTitle className="text-sm">评分标准（六维公示）</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 space-y-2 text-xs">
        {activeName != null && (
          <p className="text-blue-600 dark:text-blue-400">
            当前生效口径：{activeName}——「评分配置」里的 profile 覆盖层已激活，下方公示为<b>默认口径</b>，实际子项/权重以重算后的评分卡为准。
          </p>
        )}
        <p className="text-muted-foreground">
          总分 = 否决（D1 未完成 → 总分 0，其他维度照常评供诊断）→ 加权（D2 行为可信 15% · D3 质量 35% · D4 效率 15% · D5 冗余度 15% · D6 自主性 20%）× 覆盖度折扣。
          D2 确凿违规该维归 0（不再否决总分），疑似每次 −0.2 轻扣；对错型维度扣分（默认满分出问题才扣），多少型维度与**基线会话**比比值（省 25% 封顶 1.0、持平 0.8、2 倍归 0；未设基线默认 80 持平档并明标）；两套分并排显示不糅成一个数。
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {BUILTIN_DIMENSIONS.map(dim => (
          <details key={dim.id} className="rounded border border-border bg-card/50">
            <summary className="cursor-pointer select-none px-3 py-1.5 flex items-center gap-2 flex-wrap">
              <span className="font-mono text-muted-foreground">{dim.id}</span>
              <span className="font-medium">{dim.name}</span>
              <span className="text-muted-foreground">{dim.english}</span>
              <span className="text-[10px] text-muted-foreground">
                {dim.role === 'veto' ? '否决维' : `加权 ${dim.weightInTotal != null ? Math.round(dim.weightInTotal * 100) + '%' : '—'}`}
                {' · '}{dim.items.length} 个子项
              </span>
            </summary>
            <div className="px-3 pb-2 space-y-1">
              {dim.items.map(item => (
                <div key={item.id} className="flex gap-2 text-[11px]">
                  <span className="font-mono text-muted-foreground w-28 shrink-0">{item.id}</span>
                  <span className="w-24 shrink-0 truncate" title={item.name}>{item.name}</span>
                  <span className="text-muted-foreground flex-1">{item.note ?? ''}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
        </div>
        <p className="text-[10px] text-muted-foreground">
          评审纪律：LLM 只打分和分类，平均/加权/合计/否决全部代码算；证据必须给轮次（§N）且校验轮次真实存在；
          解析失败记错误态（不猜不重试）；每次评审的 token 记在评分卡上（评别人的账自己也要记账）。
        </p>
      </CardContent>
    </Card>
  );
}
