// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/runs —— Run 列表（runs/ 目录扫描 + 索引派生统计）。

import { NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { listRuns } from '@/lib/run/run-store';

export const GET = withRouteLog('observe/runs', async () => {
  const { runs, warnings } = listRuns();
  return NextResponse.json({ runs, warnings });
});
