// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

interface Preview { json: string; truncated: boolean; chars: number }
interface WireMessage { role: string; content: Preview; timestamp: string | null }
interface WireRound {
  index: number;
  timestamp: string | null;
  model: string | null;
  usage: { input?: number; output?: number } | null;
  newFrom: number;
  requestMessages: WireMessage[];
  response: { content: Preview; blocks: string[]; text: string };
}
interface WireRoundsData {
  taskId: string;
  sourcePath: string;
  delta?: boolean;
  totalRounds: number;
  rounds: WireRound[];
  error?: string;
}

// delta 模式还原：服务端只回每轮新增段 requestMessages[newFrom..]（append-only
// 历史的增量，全量快照 O(N²) 会爆 V8 字符串上限），按前缀拼回完整快照后，
// newFrom 分界/字符统计/渲染全部照旧。acc = 上一轮快照；本轮快照 =
// acc 截到 newFrom + 本轮增量（首条增量是上一轮的 assistant 响应）。
function expandDeltaRounds(rounds: WireRound[]): void {
  let acc: WireMessage[] = [];
  for (const r of rounds) {
    const snap = acc.slice(0, r.newFrom).concat(r.requestMessages);
    r.requestMessages = snap;
    acc = snap;
  }
}

const ROLE_VARIANT: Record<string, "blue" | "green" | "purple" | "gray"> = {
  user: "blue",
  assistant: "green",
  system: "purple",
};

export function WireRounds({ taskId, framework }: { taskId: string; framework?: string }) {
  const [state, setState] = useState<{ taskId: string; data: WireRoundsData | null; error: string | null } | null>(null);

  const [open, setOpen] = useState<Set<number>>(new Set());
  const [openMsgs, setOpenMsgs] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/observe/session/wire-rounds?taskId=${encodeURIComponent(taskId)}&delta=1${framework ? `&framework=${encodeURIComponent(framework)}` : ''}`);
        const j = await res.json() as WireRoundsData;
        if (!alive) return;
        if (j.error) setState({ taskId, data: null, error: j.error });
        else {
          if (j.delta) expandDeltaRounds(j.rounds);
          setState({ taskId, data: j, error: null });
        }
      } catch (e) {
        if (alive) setState({ taskId, data: null, error: String(e) });
      }
    })();
    return () => { alive = false; };
  }, [taskId]);

  // 切换会话时旧结果视为无数据（置空态由异步回调驱动，不在 effect 里同步 setState）
  const data = state?.taskId === taskId ? state.data : null;
  const error = state?.taskId === taskId ? state.error : null;

  if (error) {
    return <div className="p-4 text-sm text-muted-foreground">{error}</div>;
  }
  if (!data) {
    return <div className="p-4 text-sm text-muted-foreground">加载中 …</div>;
  }

  const toggleMsg = (key: string) => setOpenMsgs(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const toggle = (i: number) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <Badge variant="orange">Wire 轮次</Badge>
        <span className="text-muted-foreground">
          {data.totalRounds} 轮 · 直接读捕获文件逐轮重组（不经 DB），用于与 LLM Input（DB 重建）对照
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span
            role="button"
            tabIndex={0}
            className="text-xs underline cursor-pointer text-muted-foreground"
            onClick={() => setOpen(prev => prev.size === data.rounds.length ? new Set() : new Set(data.rounds.map((_, i) => i)))}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(prev => prev.size === data.rounds.length ? new Set() : new Set(data.rounds.map((_, i) => i))); }}
          >
            {open.size === data.rounds.length ? "全部折叠" : "全部展开"}
          </span>
        </span>
      </div>
      <div className="text-xs text-muted-foreground truncate">{data.sourcePath}</div>

      {data.rounds.map((r, i) => {
        // key/展开态用数组位置：roundIndex 可能重复（权威 xbRound 与兜底计数混排），
        // r.index 只作显示文案
        const isOpen = open.has(i);
        const totalChars = r.requestMessages.reduce((s, m) => s + m.content.chars, 0);
        const newCount = r.requestMessages.length - r.newFrom;
        return (
          <div key={`${i}-${r.index}`} className="border rounded-md overflow-hidden">
            <div className="w-full flex items-center gap-2 px-3 py-2 text-sm">
              <Badge variant="secondary" className="text-xs">Round {r.index}</Badge>
              <span className="text-xs text-muted-foreground">{(r.timestamp ?? '').slice(11, 19)}</span>
              <Badge variant="blue" className="text-xs">输入 {r.requestMessages.length} 条（新增 {newCount}）</Badge>
              <Badge variant="green" className="text-xs">输出 {r.response.blocks.join(",")}</Badge>
              {r.usage?.output != null && <span className="text-xs text-muted-foreground">{r.usage.output}t</span>}
              {r.model && <Badge variant="outline" className="text-xs">{r.model}</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">{totalChars.toLocaleString()} chars</span>
              <span
                role="button"
                tabIndex={0}
                className="shrink-0 px-2 py-1 -mr-2 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer select-none"
                onClick={() => toggle(i)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') toggle(i); }}
              >
                {isOpen ? "▼" : "▶"}
              </span>
            </div>
            {isOpen && (
              <div className="border-t max-h-[70vh] overflow-y-auto">
                {/* ── 本轮输入：请求的完整 messages（含此前累积） ── */}
                <div className="px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground border-b pb-1 mb-1.5">
                    <Badge variant="blue" className="text-xs">输入</Badge>
                    <span>{r.requestMessages.length} 条消息 · 其中本轮新增 {newCount} 条</span>
                  </div>
                  <div className="space-y-1.5">
                    {r.requestMessages.map((m, i) => {
                      const isNew = i >= r.newFrom;
                      const key = `${r.index}-${i}`;
                      const msgOpen = openMsgs.has(key);
                      return (
                        <div key={key} className={`border rounded bg-muted/20 overflow-hidden ${isNew ? "border-blue-300 dark:border-blue-500/40" : "opacity-70"}`}>
                          <div className="w-full flex items-center gap-2 px-2 py-1">
                            <Badge variant={ROLE_VARIANT[m.role] ?? "gray"} className="text-xs">{m.role}</Badge>
                            {isNew && <Badge variant="blue" className="text-[10px]">新增</Badge>}
                            <span className="text-[10px] text-muted-foreground">{m.content.chars.toLocaleString()} chars</span>
                            <span className="text-[10px] text-muted-foreground">{(m.timestamp ?? '').slice(11, 19)}</span>
                            <span
                              role="button"
                              tabIndex={0}
                              className="ml-auto shrink-0 px-2 py-1 -mr-2 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer select-none"
                              onClick={() => toggleMsg(key)}
                              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') toggleMsg(key); }}
                            >
                              {msgOpen ? "▼" : "▶"}
                            </span>
                          </div>
                          <pre className={`px-2 pb-1.5 text-[11px] whitespace-pre-wrap break-all font-mono text-foreground/75 ${msgOpen ? "max-h-[480px] overflow-y-auto" : "max-h-[54px] overflow-hidden"}`}>{m.content.json}</pre>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* ── 本轮输出：响应 ── */}
                <div className="px-3 py-2 border-t bg-emerald-500/5">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground border-b pb-1 mb-1.5">
                    <Badge variant="green" className="text-xs">输出</Badge>
                    <span>{r.response.blocks.join(",")} · {r.response.content.chars.toLocaleString()} chars</span>
                    {r.usage && <span>tokens: in {r.usage.input ?? '-'} / out {r.usage.output ?? '-'}</span>}
                  </div>
                  {r.response.text && (
                    <pre className="px-1 text-[11px] whitespace-pre-wrap font-mono text-foreground/80 max-h-[240px] overflow-y-auto">{r.response.text}</pre>
                  )}
                  <details className="mt-1">
                    <summary className="text-[10px] text-muted-foreground cursor-pointer select-none">响应原文 JSON（{r.response.content.chars.toLocaleString()} chars）</summary>
                    <pre className="px-1 text-[11px] whitespace-pre-wrap break-all font-mono text-foreground/75 max-h-[480px] overflow-y-auto">{r.response.content.json}</pre>
                  </details>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
