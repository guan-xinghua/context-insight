// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 运行日志服务端配置（enabled/level/file）：~/.context-insight/logger-config.json
// （0600 + 原子写，与 lake-config.json 同款纪律）。设置页「运行日志」块读写
// 此文件；env（CONTEXT_LOG*）优先于本文件——部署层约束不被 Web 设置页放开。
// CONTEXT_LOG_CONFIG：整文件路径覆盖（测试隔离缝，SCORING_JUDGE_LOG_DIR 同语义）。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONTEXT_HOME } from './scoring/core/store';

export type LoggerLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfigFile {
  enabled: boolean;
  level: LoggerLevel;
  file: boolean;
  stdout: boolean;
}

const LEVELS: readonly LoggerLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLoggerLevel(v: unknown): v is LoggerLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

/** 级别归一唯一真身（env 解析 / 设置文件 sanitize / PUT 校验 / 启动自报共用）：
 *  大小写不敏感，'warning' → 'warn' 别名；非法返回 null。此前四处各写一份，
 *  'warning' 出现过 env 接受、设置文件判废整份、自报原样透传三种分歧 */
export function normalizeLoggerLevel(v: unknown): LoggerLevel | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'warning') return 'warn';
  return (LEVELS as readonly string[]).includes(s) ? (s as LoggerLevel) : null;
}

export function loggerConfigPath(): string {
  // || + trim：显式空串回默认（?? 会得到路径 '' → dirname('.') + rename ENOENT 500）
  return process.env.CONTEXT_LOG_CONFIG?.trim() || path.join(CONTEXT_HOME, 'logger-config.json');
}

// 布尔/级别字段宽松回填默认（缺 stdout 的存量文件按开读，不整份判废）；
// PUT 路由写入前另有严格白名单校验，脏输入到不了这里
// 逐字段宽松回填（缺 stdout 的存量文件按开读）；坏值降级为该字段默认而非
// 整份判 null——enabled:false 被一个坏 level 连坐丢掉会让用户以为已关日志
function sanitize(raw: unknown): LoggerConfigFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { enabled?: unknown; level?: unknown; file?: unknown; stdout?: unknown };
  const level = normalizeLoggerLevel(r.level);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    level: level ?? 'info',
    file: typeof r.file === 'boolean' ? r.file : true,
    stdout: typeof r.stdout === 'boolean' ? r.stdout : true,
  };
}

// 损坏/缺文件 → null（未配置 = 全默认），绝不抛——消费方按默认链走
export function readLoggerConfigFile(): LoggerConfigFile | null {
  try {
    return sanitize(JSON.parse(fs.readFileSync(loggerConfigPath(), 'utf8')));
  } catch {
    return null;
  }
}

// 原子写（tmp+rename）+ 0600；脏输入显式抛错而非静默兜底（server-config 同款纪律）
export function writeLoggerConfigFile(cfg: LoggerConfigFile): void {
  const clean = sanitize(cfg);
  if (!clean) {
    throw new Error('writeLoggerConfigFile: invalid config (enabled/level/file/stdout) — refusing to write');
  }
  const file = loggerConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // tmp 名带随机段：同毫秒并发 PUT（两个 tab 同时保存）不会共享同名 tmp 互覆
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

export function clearLoggerConfigFile(): void {
  try { fs.rmSync(loggerConfigPath(), { force: true }); } catch { /* ignore */ }
}
