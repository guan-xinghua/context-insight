// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Runs 一级入口（服务端组件：直读 run-store，无 API 往返；导入/删除后的
// 刷新由客户端 RunList 触发 router.refresh 回到这里）。

import { AppHeader } from '@/components/layout/AppHeader';
import { RunList } from '@/components/run/RunList';
import { BundleImport } from '@/components/run/BundleImport';
import { listRuns } from '@/lib/run/run-store';
import { SettingsIcon } from 'lucide-react';

// run 数据是 fs 落盘（~/.cannbot-insight/runs/），导入后必须反映到下一次请求：
// 未声明动态渲染时该页会被构建期静态预渲染，把「空列表」烘焙进缓存——
// 导入完成后页面仍显示暂无 Run。强制每请求渲染（同首页 searchParams 语义）。
export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  const { runs, warnings } = listRuns();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex w-full max-w-7xl flex-col gap-6 px-6 py-8 mx-auto">
        <AppHeader
          actions={
            <>
              <BundleImport />
              <a href="/settings" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent/30 transition-colors">
                <SettingsIcon className="size-4 text-muted-foreground" />
                设置
              </a>
            </>
          }
        />
        <RunList initialRuns={runs} warnings={warnings} />
      </main>
    </div>
  );
}
