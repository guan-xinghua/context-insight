// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 单源架构测试种子：远端配置只从服务端 lake-config.json 来（env 地址/凭据
// 通道已退役）。CONTEXT_PROXY_DIR 把 lake-config.json + lake-auth.json 都
// 隔离进临时目录（防读到开发机真实配置），writeServerLakeConfig 写入当前
// 远端。在 lake 模块首次调用前执行（测试文件模块顶层）。
import path from 'node:path';
import { writeServerLakeConfig } from '../../src/lib/lake/server-config';

export function seedLakeConfig(tmp: string, cfg: { address: string; branch?: string; directory?: string }): void {
  process.env.CONTEXT_PROXY_DIR = path.join(tmp, 'proxy');
  writeServerLakeConfig(cfg);
}

/** 切换当前远端（同文件多远端场景：每个用例/阶段按需改写服务端配置） */
export function switchLakeConfig(cfg: { address: string; branch?: string; directory?: string }): void {
  writeServerLakeConfig(cfg);
}
