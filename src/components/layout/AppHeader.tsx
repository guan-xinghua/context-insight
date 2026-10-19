// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 一级域导航单点（design.md §7.1）：Sessions(/) · Runs(/runs)。此前 header
// 内联在 page.tsx，多域并存后每页自拼不可持续——本组件供 /、/runs、
// /run/[runId] 等页复用，右侧动作（导入按钮/数据仓/设置）由各页以 actions
// 注入（Sessions 域动作只在 / 出现）。

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BRAND_NAME } from "@/lib/branding";
import { VERSION_DISPLAY } from "@/lib/version";

export type AppHeaderDomain = "sessions" | "runs";

const NAV_ITEMS: { key: AppHeaderDomain; href: string; label: string }[] = [
  { key: "sessions", href: "/", label: "Sessions" },
  { key: "runs", href: "/runs", label: "Runs" },
];

export function AppHeader({ actions }: { actions?: ReactNode }) {
  const pathname = usePathname();
  const active: AppHeaderDomain =
    pathname === "/runs" || pathname.startsWith("/run/") ? "runs" : "sessions";

  return (
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{BRAND_NAME}</h1>
          <span className="text-xs text-muted-foreground">{VERSION_DISPLAY}</span>
        </div>
        <nav className="flex items-center gap-1" aria-label="一级域导航">
          {NAV_ITEMS.map(item => (
            <Link
              key={item.key}
              href={item.href}
              className={cn(
                "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                active === item.key
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      {actions ? <div className="flex items-center gap-3">{actions}</div> : null}
    </div>
  );
}
