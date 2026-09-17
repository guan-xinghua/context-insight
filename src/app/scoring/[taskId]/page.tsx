// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { TrajectoryScoring } from "@/components/scoring/TrajectoryScoring"

export default async function ScoringPage({ params, searchParams }: { params: Promise<{ taskId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { taskId } = await params
  const sp = await searchParams
  const fw = typeof sp.framework === 'string' ? sp.framework : undefined
  return <TrajectoryScoring taskId={decodeURIComponent(taskId)} framework={fw} />
}
