// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 设置页·数据之湖远端偏好 API（服务端 lake-config.json：address/branch/
// directory——单源架构的唯一配置源，Web/Viewer/CLI/cpx 同机共读）。GET 回
// 完整偏好（非凭据，最小披露），PUT/DELETE 全量写/清。
import { NextRequest, NextResponse } from 'next/server';
import {
  clearServerLakeConfig, readServerLakeConfig, writeServerLakeConfig,
} from '@/lib/lake/server-config';
import { FORBIDDEN_ADDRESS_CHARS, validateBranch, normalizeDirectory } from '@/lib/lake/remote';
import { logError, logInfo, logWarn } from '@/lib/logger';

export async function GET() {
  const cfg = readServerLakeConfig();
  return NextResponse.json({
    configured: cfg != null,
    address: cfg?.address ?? '',
    branch: cfg?.branch ?? '',
    directory: cfg?.directory ?? '',
    // 生效模式（缺省 true）：设置页 LFS 开关的回显
    lfs: cfg?.lfs ?? true,
  });
}

export async function PUT(request: NextRequest) {
  let payload: { address: string; branch?: string; directory?: string; lfs?: boolean };
  try {
    const body = await request.json();
    const { address, branch, directory, lfs } = body as { address?: string; branch?: string; directory?: string; lfs?: unknown };
    const addr = address?.trim();
    if (!addr) return NextResponse.json({ error: '缺少远端地址' }, { status: 400 });
    if (FORBIDDEN_ADDRESS_CHARS.test(addr)) return NextResponse.json({ error: '数据湖地址含非法字符' }, { status: 400 });
    // 分支/目录过同款白名单（无效值 400 指向字段，与 lake 路由一致）；
    // 接收归一化返回值落盘——存储层即干净形态（strip 首尾空白/斜杠），
    // 消费方（resolveLakeRemote）不必各自再归一
    const branchValue = branch?.trim() ? validateBranch(branch) : undefined;
    const directoryValue = directory?.trim() ? normalizeDirectory(directory) : undefined;
    payload = { address: addr, branch: branchValue, directory: directoryValue };
    // lfs 透传：请求体带布尔 → 写入；缺省 → 保留现有文件值（旧版前端/旧
    // 构建的 PUT 不带 lfs，若直接丢弃会把用户关掉的 LFS 模式悄悄复位为
    // true——平台不开放 LFS 的仓每次保存设置后首次上传必再撞墙）
    if (typeof lfs === 'boolean') payload.lfs = lfs;
    else {
      const prev = readServerLakeConfig();
      if (typeof prev?.lfs === 'boolean') payload.lfs = prev.lfs;
    }
  } catch (e) {
    logWarn('route:settings/lake-config', '无效请求体', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid request' }, { status: 400 });
  }
  try {
    writeServerLakeConfig(payload);
    logInfo('route:settings/lake-config', '数据湖远端已更新', { address: payload.address, branch: payload.branch ?? 'main', directory: payload.directory ?? '' });
    return NextResponse.json({ ok: true });
  } catch (e) {
    logError('route:settings/lake-config', '写盘失败', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Write failed' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    clearServerLakeConfig();
    logInfo('route:settings/lake-config', '数据湖远端已恢复默认（清除配置）', {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    logError('route:settings/lake-config', '清除失败', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Clear failed' }, { status: 500 });
  }
}
