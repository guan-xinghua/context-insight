// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from "next/server"
import path from "node:path"
import { analyzeTrajectory } from "@/lib/ai/trajectory-analyzer"
import type { AIProviderConfig } from "@/lib/ai/analyzer"
import { withRouteLog } from "@/lib/api-route"
import { logInfo } from "@/lib/logger"

export const POST = withRouteLog("ai/analyze-trajectory", async (request: NextRequest) => {
  const body = await request.json()
  const { trajectoryPath, provider } = body as {
    trajectoryPath: string
    provider: AIProviderConfig
  }

  if (!trajectoryPath) {
    return NextResponse.json({ error: "Missing trajectoryPath" }, { status: 400 })
  }
  if (path.isAbsolute(trajectoryPath)) {
    return NextResponse.json({ error: "trajectoryPath must be relative" }, { status: 400 })
  }
  if (/\.\.\//.test(trajectoryPath)) {
    return NextResponse.json({ error: "trajectoryPath must not traverse parent" }, { status: 400 })
  }
  if (!provider?.baseUrl || !provider?.apiKey || !provider?.model) {
    return NextResponse.json(
      { error: "Missing provider config (baseUrl, apiKey, model)" },
      { status: 400 },
    )
  }

  const resolvedPath = path.resolve(process.cwd(), trajectoryPath)
  const t0 = Date.now()
  logInfo("route:ai/analyze-trajectory", "轨迹分析开始", { model: provider.model })
  const result = await analyzeTrajectory({ trajectoryPath: resolvedPath, provider })
  logInfo("route:ai/analyze-trajectory", "轨迹分析完成", { ms: Date.now() - t0, rounds: result.rounds })

  return NextResponse.json({ outputPath: result.outputPath, rounds: result.rounds })
})
