"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useCallback, useEffect, useRef, useState } from "react";
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { RunGraph } from "./RunGraph";
import type { NodeInstance, RunView } from "@/lib/run/view-model";
import type { LensKey } from "@/lib/run/run-metrics";

// 画布容器：点阵画布（缩放 0.25–2.5、Ctrl/⌘+滚轮以光标为锚缩放、左键拖拽
// 平移）+ 浮动缩放工具条。选中语义由外部控制（selectedKey 受控）：
// 点击节点切换选中（点亮关联边跑马灯）、点击空白取消；fitKey 变化时自动
// 适配画布（子图弹窗打开/切换代际）。
export function RunCanvas({
  view,
  nodesByKey,
  selectedKey,
  onSelectNode,
  onOpenSubgraph,
  fitKey,
  lens,
  className = "",
}: {
  view: RunView;
  nodesByKey: Map<string, NodeInstance>;
  selectedKey: string | null;
  onSelectNode: (key: string | null) => void;
  onOpenSubgraph?: (key: string) => void;
  fitKey?: string;
  lens?: LensKey;
  className?: string;
}) {
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const panMovedRef = useRef(false);
  const [panning, setPanning] = useState(false);

  const setZoom = useCallback((z: number) => {
    const next = Math.min(Math.max(z, 0.25), 2.5);
    zoomRef.current = next;
    setZoomState(next);
  }, []);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = canvasRef.current;
    const prev = zoomRef.current;
    const next = Math.min(Math.max(prev * factor, 0.25), 2.5);
    if (next === prev) return;
    if (el && cx !== undefined && cy !== undefined) {
      const PAD = 12;
      const contentX = (el.scrollLeft + cx - PAD) / prev;
      const contentY = (el.scrollTop + cy - PAD) / prev;
      el.scrollLeft = contentX * next + PAD - cx;
      el.scrollTop = contentY * next + PAD - cy;
    }
    zoomRef.current = next;
    setZoomState(next);
  }, []);

  const onCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = canvasRef.current;
    if (!el) return;
    // 节点（含子图 chip）上的按下不触发取消选中——由节点自身 click 处理
    const onNode = (e.target as Element).closest?.(".run-node") != null;
    const start = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    panMovedRef.current = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        panMovedRef.current = true;
        setPanning(true);
      }
      if (panMovedRef.current) {
        el.scrollLeft = start.sl - dx;
        el.scrollTop = start.st - dy;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setPanning(false);
      // 原地点击空白（非拖拽、非节点）→ 取消选中，跑马灯熄灭
      if (!panMovedRef.current && !onNode) onSelectNode(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [onSelectNode]);

  const fitToView = useCallback((w: number, h: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const availW = el.clientWidth - 24;
    const availH = el.clientHeight - 24;
    if (availW <= 0 || availH <= 0 || w <= 0 || h <= 0) {
      setZoom(1);
      return;
    }
    setZoom(Math.min(availW / w, availH / h));
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, [setZoom]);

  // Ctrl/⌘+滚轮缩放（native listener，passive: false 才能 preventDefault）。
  // 依赖 view：loading 态无画布时 effect 空跑，数据到达/切换视图后重挂监听
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, view]);

  // 自动适配（fitKey 变化 = 子图弹窗打开或切换代际）
  useEffect(() => {
    if (fitKey === undefined) return;
    fitToView(Math.max(view.layout.width, 200), view.layout.height);
  }, [fitKey, view, fitToView]);

  return (
    <div className={`relative min-h-0 min-w-0 flex-1 ${className}`}>
      <div
        ref={canvasRef}
        onPointerDown={onCanvasPointerDown}
        className={`run-canvas absolute inset-0 select-none overflow-auto p-3 ${panning ? "cursor-grabbing" : "cursor-grab"}`}
      >
        <div style={{ width: Math.max(view.layout.width, 200) * zoom, height: view.layout.height * zoom }}>
          <div style={{ transform: `scale(${zoom})`, transformOrigin: "0 0" }}>
            <RunGraph
              view={view}
              nodesByKey={nodesByKey}
              selectedKey={selectedKey}
              onSelectNode={key => {
                if (panMovedRef.current) return;
                onSelectNode(selectedKey === key ? null : key);
              }}
              onOpenSubgraph={onOpenSubgraph}
              lens={lens}
            />
          </div>
        </div>
      </div>

      <div className="absolute bottom-3 right-3 flex items-center rounded-lg border border-black/10 bg-white/95 shadow-lg">
        <button
          type="button"
          title="缩小（Ctrl + 滚轮）"
          aria-label="缩小"
          onClick={() => zoomAt(1 / 1.15)}
          className="flex size-7 items-center justify-center text-[#57606a] transition-colors hover:bg-black/[0.05] hover:text-[#1f2328]"
        >
          <ZoomOutIcon className="size-3.5" />
        </button>
        <button
          type="button"
          title="重置缩放"
          aria-label="重置缩放"
          onClick={() => setZoom(1)}
          className="w-11 text-center text-[11px] tabular-nums text-[#57606a] transition-colors hover:bg-black/[0.05] hover:text-[#1f2328]"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          title="放大（Ctrl + 滚轮）"
          aria-label="放大"
          onClick={() => zoomAt(1.15)}
          className="flex size-7 items-center justify-center text-[#57606a] transition-colors hover:bg-black/[0.05] hover:text-[#1f2328]"
        >
          <ZoomInIcon className="size-3.5" />
        </button>
        <span className="h-3.5 w-px bg-black/10" aria-hidden />
        <button
          type="button"
          title="适配画布"
          aria-label="适配画布"
          onClick={() => fitToView(Math.max(view.layout.width, 200), view.layout.height)}
          className="flex size-7 items-center justify-center text-[#57606a] transition-colors hover:bg-black/[0.05] hover:text-[#1f2328]"
        >
          <MaximizeIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
