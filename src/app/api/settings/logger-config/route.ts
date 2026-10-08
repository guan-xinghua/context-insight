// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 设置页「运行日志」块的后端：读写 ~/.cannbot-insight/logger-config.json。
// 写后清 logger 配置缓存——新级别立即生效（不等 5s TTL），免重启。
// envOverrides 列出当前压住设置页的 CANNBOT_LOG* 变量名，前端据此提示。
import { NextRequest, NextResponse } from 'next/server';
import { logError, logInfo, logWarn, logsDir, resetLoggerConfigCache } from '@/lib/logger';
import { clearLoggerConfigFile, normalizeLoggerLevel, readLoggerConfigFile, writeLoggerConfigFile } from '@/lib/logger-config';

export async function GET() {
  const file = readLoggerConfigFile();
  return NextResponse.json({
    configured: file != null,
    enabled: file?.enabled ?? true,
    level: file?.level ?? 'info',
    file: file?.file ?? true,
    stdout: file?.stdout ?? true,
    logDir: logsDir(),
    envOverrides: [
      ...(process.env.CANNBOT_LOG ? ['CANNBOT_LOG'] : []),
      ...(process.env.CANNBOT_LOG_LEVEL ? ['CANNBOT_LOG_LEVEL'] : []),
      ...(process.env.CANNBOT_LOG_FILE ? ['CANNBOT_LOG_FILE'] : []),
      ...(process.env.CANNBOT_LOG_STDOUT ? ['CANNBOT_LOG_STDOUT'] : []),
    ],
  });
}

export async function PUT(request: NextRequest) {
  let body: { enabled?: unknown; level?: unknown; file?: unknown; stdout?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    // malformed JSON 是客户端错误：与校验失败同为 400，不进 500/error 日志
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }
  try {
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled 须为布尔值' }, { status: 400 });
    }
    const level = normalizeLoggerLevel(body.level);
    if (!level) {
      logWarn('route:settings/logger-config', 'invalid payload', { field: 'level', value: String(body.level) });
      return NextResponse.json({ error: '日志级别须为 debug/info/warn/error' }, { status: 400 });
    }
    if (typeof body.file !== 'boolean') {
      return NextResponse.json({ error: 'file 须为布尔值' }, { status: 400 });
    }
    if (typeof body.stdout !== 'boolean') {
      return NextResponse.json({ error: 'stdout 须为布尔值' }, { status: 400 });
    }
    writeLoggerConfigFile({ enabled: body.enabled, level, file: body.file, stdout: body.stdout });
    resetLoggerConfigCache();
    logInfo('route:settings/logger-config', '日志配置已更新', { enabled: body.enabled, level, file: body.file, stdout: body.stdout });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:settings/logger-config', 'write failed', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    clearLoggerConfigFile();
    resetLoggerConfigCache();
    logInfo('route:settings/logger-config', '日志配置已恢复默认', {});
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:settings/logger-config', 'clear failed', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
