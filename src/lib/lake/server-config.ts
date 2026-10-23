// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据湖服务端偏好存储（address/branch/directory）：~/.context-insight/lake-config.json
// （0600 + 原子写；与 lake-auth.json 同目录纪律——CONTEXT_PROXY_DIR 重定向优先，
// 测试/多实例隔离）。动机：viewer 等服务端消费面（defaultLakeRemote）没有请求体
// 配置通道，此前只能吃 env——用户在设置页配好的远端对 viewer 不可见（"一次配置
// 全机生效"只兑现了凭据一半）。设置页保存时地址/分支/目录同时落服务端文件 +
// 浏览器 localStorage（后者仍是带凭据请求体的即时通道），解析链为
// 请求体 > 服务端配置 > env。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerLakeConfig {
  address: string;
  branch?: string;
  directory?: string;
  /** LFS 模式（数据仓须启用 LFS）：.jsonl.7z/.jsonl.gz 走 LFS 指针出仓；缺省 true */
  lfs?: boolean;
}

// 与 lake-auth.json 同目录（'.context-insight' 引号字面量是 pack-cannbot 品牌翻转点）
export function serverConfigPath(): string {
  return path.join(
    path.dirname(process.env.CONTEXT_PROXY_DIR ?? path.join(os.homedir(), '.context-insight', 'proxy')),
    'lake-config.json',
  );
}

function sanitize(raw: unknown): ServerLakeConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { address?: unknown; branch?: unknown; directory?: unknown; lfs?: unknown };
  if (typeof r.address !== 'string' || !r.address.trim()) return null;
  const cfg: ServerLakeConfig = { address: r.address.trim() };
  if (typeof r.branch === 'string' && r.branch.trim()) cfg.branch = r.branch.trim();
  if (typeof r.directory === 'string' && r.directory.trim()) cfg.directory = r.directory.trim();
  if (typeof r.lfs === 'boolean') cfg.lfs = r.lfs;
  return cfg;
}

// 损坏/缺文件 → null（未配置），绝不抛——消费方按 fail-fast 链走下一候选
export function readServerLakeConfig(): ServerLakeConfig | null {
  try {
    return sanitize(JSON.parse(fs.readFileSync(serverConfigPath(), 'utf8')));
  } catch {
    return null;
  }
}

// 原子写（tmp+rename）+ 0600：与 lake-auth.json 同款权限纪律。
// 脏输入（address 空/非字符串）显式抛错而非静默兜底——兜底会写出一个只剩
// 空 address 的文件并悄悄丢掉 branch/directory/lfs，调用方拿到的是「字段
// 被吞」而非可感知的失败（当前 PUT 路由已先拦，此处防御任何未来调用方）；
// 合法输入写归一化形态（trim 后的干净字段）
export function writeServerLakeConfig(cfg: ServerLakeConfig): void {
  const clean = sanitize(cfg);
  if (!clean) {
    throw new Error('writeServerLakeConfig: invalid config (address must be a non-empty string) — refusing to write, other fields would be silently dropped');
  }
  const file = serverConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

export function clearServerLakeConfig(): void {
  try { fs.rmSync(serverConfigPath(), { force: true }); } catch { /* ignore */ }
}
