// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 服务端启动自报（Next instrumentation，register 每个服务实例引导时执行一次）：
// 打一行当前生效的日志配置（开关/级别/输出方式/输出位置），经 logger 双通道
// 落文件 + 上屏——启动终端立刻能看到日志去哪了，不用翻配置猜。构建阶段
// （NEXT_PHASE=phase-production-build）也会触发 register，跳过免噪。
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { logInfo, loggerConfigSnapshot } = await import('@/lib/logger');
  const cfg = loggerConfigSnapshot();
  logInfo('logger', 'boot 日志配置', { enabled: cfg.enabled, level: cfg.level, file: cfg.file, stdout: cfg.stdout, dir: cfg.dir });
}
