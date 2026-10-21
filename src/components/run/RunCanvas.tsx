"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { RunGraph } from "./RunGraph";
import type { NodeInstance, RunView } from "@/lib/run/view-model";
import type { LensKey } from "@/lib/run/run-metrics";

// 画布容器（相机模型，性能地基）：viewport（overflow-hidden + contain 隔离）
// × camera（平移单元素 transform，GPU 合成）× RunGraph（memo）。
//
// 高清与顺滑的混合栅格策略（静态模糊的根因是 will-change 合成层缓存了
// zoom=1 的纹理，CSS scale 放大 = 拉伸缓存位图）：
// - 手势中（滚轮/按钮连击）：CSS scale 相对已栅格化尺寸拉伸——GPU 顺滑，
//   允许瞬时轻微模糊（地图类产品惯例）
// - 手势落定（静默 160ms / 离散操作立即）：SVG 按 viewBox 重设 width/
//   height = 内容尺寸 × 缩放，浏览器按最终显示分辨率矢量重栅格——静止
//   状态任意缩放档位下文字线条始终高清；CSS scale 归 1，平移保持纯 translate
//
// 手势期间暂停流动画（CSS）与水位 SMIL（pauseAnimations，特性检测降级）。
// 缩放百分比命令式直更 textContent（不经 React，避免无关重渲染）。
// 对外 props 契约与 v1（scroll+scale）完全一致。

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const toDomPrecision = (v: number) => Math.round(v * 1e4) / 1e4;
const clampZoom = (z: number) => Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);

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
  const viewportRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLButtonElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const camera = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 1 });
  /** SVG 最近一次矢量重栅格时的缩放档位（CSS scale 相对它做手势期拉伸） */
  const rasterZRef = useRef(1);
  const panMovedRef = useRef(false);
  const gestureTimerRef = useRef<number | null>(null);
  const pausedRef = useRef(false);
  // 布局尺寸镜像到 ref：相机操作回调保持引用稳定（memo/监听器依赖不抖）。
  // 声明在 commitCamera effect 之前——视图切换时先更新尺寸再重设 SVG
  const dimsRef = useRef({ w: 0, h: 0 });
  useLayoutEffect(() => {
    dimsRef.current = { w: Math.max(view.layout.width, 200), h: view.layout.height };
  });

  const applyCamera = useCallback(() => {
    const { x, y, z } = camera.current;
    const s = z / rasterZRef.current;
    const el = cameraRef.current;
    if (el) {
      el.style.transform =
        `translate(${toDomPrecision(x)}px, ${toDomPrecision(y)}px)` +
        (Math.abs(s - 1) > 1e-4 ? ` scale(${toDomPrecision(s)})` : "");
    }
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(z * 100)}%`;
  }, []);

  /** 相机落定：SVG 尺寸对齐逻辑缩放 → 矢量重栅格（高清），CSS scale 归 1 */
  const commitCamera = useCallback(() => {
    const { z } = camera.current;
    rasterZRef.current = z;
    const svg = svgRef.current;
    if (svg) {
      svg.setAttribute("width", String(toDomPrecision(dimsRef.current.w * z)));
      svg.setAttribute("height", String(toDomPrecision(dimsRef.current.h * z)));
    }
    applyCamera();
  }, [applyCamera]);

  // 挂载/视图切换：内容尺寸变化后立即重设 SVG 尺寸（渲染同步、无闪帧）
  useLayoutEffect(() => {
    commitCamera();
  }, [commitCamera, view]);

  // 手势标记：抓取光标 + 暂停流动画（CSS）；水位 SMIL 走 SVG 根元素原生
  // pauseAnimations（老引擎无该 API 则静默跳过，功能不受损）
  const setGesture = useCallback((on: boolean) => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.classList.toggle("run-gesture", on);
    if (on === pausedRef.current) return;
    pausedRef.current = on;
    if (on) svgRef.current?.pauseAnimations?.();
    else svgRef.current?.unpauseAnimations?.();
  }, []);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number, immediate = false) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const { x, y, z } = camera.current;
    const next = clampZoom(z * factor);
    if (next === z) return;
    const px = cx ?? vp.clientWidth / 2;
    const py = cy ?? vp.clientHeight / 2;
    // 光标锚点：缩放后保持视口点 (px, py) 下的内容点不动
    camera.current = {
      x: px - (px - x) * (next / z),
      y: py - (py - y) * (next / z),
      z: next,
    };
    // 离散操作（工具条按钮）立即矢量重栅格；连击手势（滚轮）先 GPU 拉伸，
    // 静默 160ms 后落定重栅格
    if (immediate) {
      commitCamera();
    } else {
      applyCamera();
    }
    setGesture(true);
    if (gestureTimerRef.current !== null) window.clearTimeout(gestureTimerRef.current);
    gestureTimerRef.current = window.setTimeout(() => {
      commitCamera();
      setGesture(false);
      gestureTimerRef.current = null;
    }, 160);
  }, [applyCamera, commitCamera, setGesture]);

  const resetCamera = useCallback(() => {
    camera.current = { x: 0, y: 0, z: 1 };
    commitCamera();
  }, [commitCamera]);

  const onCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 节点（含子图 chip）上的按下不触发取消选中——由节点自身 click 处理
    const onNode = (e.target as Element).closest?.(".run-node") != null;
    const start = { x: e.clientX, y: e.clientY };
    const startCam = { ...camera.current };
    panMovedRef.current = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!panMovedRef.current && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        panMovedRef.current = true;
        setGesture(true);
      }
      if (panMovedRef.current) {
        camera.current.x = startCam.x + dx;
        camera.current.y = startCam.y + dy;
        applyCamera();
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (panMovedRef.current) {
        setGesture(false);
      } else if (!onNode) {
        // 原地点击空白（非拖拽、非节点）→ 取消选中，跑马灯熄灭
        onSelectNode(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [applyCamera, setGesture, onSelectNode]);

  const fitToView = useCallback((w: number, h: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const availW = vp.clientWidth - 24;
    const availH = vp.clientHeight - 24;
    if (availW <= 0 || availH <= 0 || w <= 0 || h <= 0) {
      resetCamera();
      return;
    }
    const z = clampZoom(Math.min(availW / w, availH / h));
    camera.current = {
      x: (vp.clientWidth - w * z) / 2,
      y: (vp.clientHeight - h * z) / 2,
      z,
    };
    commitCamera();
  }, [commitCamera, resetCamera]);

  // Ctrl/⌘+滚轮缩放（native listener，passive: false 才能 preventDefault）。
  // 依赖 view：loading 态无画布时 effect 空跑，数据到达/切换视图后重挂监听
  useEffect(() => {
    const el = viewportRef.current;
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

  useEffect(() => () => {
    if (gestureTimerRef.current !== null) window.clearTimeout(gestureTimerRef.current);
  }, []);

  const handleNodeSelect = useCallback((key: string) => {
    if (panMovedRef.current) return;
    onSelectNode(selectedKey === key ? null : key);
  }, [onSelectNode, selectedKey]);

  return (
    <div className={`relative min-h-0 min-w-0 flex-1 ${className}`}>
      <div
        ref={viewportRef}
        onPointerDown={onCanvasPointerDown}
        className="run-canvas run-viewport absolute inset-0 select-none overflow-hidden"
      >
        <div ref={cameraRef} className="run-camera" style={{ transformOrigin: "0 0" }}>
          <RunGraph
            view={view}
            nodesByKey={nodesByKey}
            selectedKey={selectedKey}
            onSelectNode={handleNodeSelect}
            onOpenSubgraph={onOpenSubgraph}
            lens={lens}
            svgRef={svgRef}
          />
        </div>
      </div>

      <div className="run-glass absolute bottom-3 right-3 flex items-center rounded-xl">
        <button
          type="button"
          title="缩小（Ctrl + 滚轮）"
          aria-label="缩小"
          onClick={() => zoomAt(1 / 1.15, undefined, undefined, true)}
          className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
        >
          <ZoomOutIcon className="size-3.5" />
        </button>
        <button
          type="button"
          title="重置缩放"
          aria-label="重置缩放"
          ref={zoomLabelRef}
          onClick={resetCamera}
          className="run-tool-btn w-11 text-center text-[11px] tabular-nums text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
        />
        <button
          type="button"
          title="放大（Ctrl + 滚轮）"
          aria-label="放大"
          onClick={() => zoomAt(1.15, undefined, undefined, true)}
          className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
        >
          <ZoomInIcon className="size-3.5" />
        </button>
        <span className="h-3.5 w-px bg-black/10" aria-hidden />
        <button
          type="button"
          title="适配画布"
          aria-label="适配画布"
          onClick={() => fitToView(Math.max(view.layout.width, 200), view.layout.height)}
          className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
        >
          <MaximizeIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
