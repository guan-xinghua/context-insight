// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一运行日志（服务端专用——勿在 client 组件引入；node:fs 依赖会让客户端
// bundle 构建期直接报错，护栏天然存在）。
// 设计要点：
// - 懒初始化：模块顶层零副作用（CLI 经 auth/server-config/data-service 传递
//   引入时 import 即安全），首条日志才 mkdir / 读配置
// - 双通道：文件 + stdout 默认同开（CANNBOT_LOG_FILE / CANNBOT_LOG_STDOUT
//   置 0/off 关对应通道；CANNBOT_LOG=off 全关）
// - 按天滚动：<CANNBOT_LOG_DIR ?? ~/.cannbot-insight/logs>/insight-YYYY-MM-DD.log
//   （UTC），不清理旧文件；目录 0700、文件 0600（与 lake-auth.json 同级权限
//   纪律——日志含错误原文，不应比凭据文件更可读）
// - 配置链 env（每次调用现读——vitest 晚赋值即生效，judge-log 同语义）>
//   logger-config.json（TTL 5s + mtime+size 缓存热重读，设置页保存后免重启
//   生效）> 默认（开 / info / 双开）
// - 单行格式：[<ISO 时间>][<LEVEL>][<scope>]:<message> k=v——值转义、消息与
//   值超长截断、敏感 key（token/password/secret/auth/api[_-]key）打码、
//   URL 内嵌凭据（://user:pass@）剥除；写文件逐行 appendFileSync 不持 fd、
//   单行 try/catch 吞错（日志失败绝不阻断业务，judge-log 同款纪律），
//   目录被外部删除（ENOENT）时重建一次再写——文件通道不因目录消失静默失效
import fs from 'node:fs';
import path from 'node:path';
import { CANNBOT_HOME } from './scoring/core/store';
import { loggerConfigPath, normalizeLoggerLevel, readLoggerConfigFile, type LoggerConfigFile, type LoggerLevel } from './logger-config';

export type LogLevel = LoggerLevel;
export type LogFields = Record<string, string | number | boolean | null | undefined | Error>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const OFF_RE = /^(0|off|false|no)$/i;
const REDACT_KEY_RE = /token|password|secret|auth|api[_-]?key/i;
// URL 内嵌凭据（git/LLM 网关错误串常见形态）://user:token@ → ://<creds>@
const URL_CREDS_RE = /(https?:\/\/)[^/\s"'@]+@/g;
const VALUE_MAX = 2000;
const CFG_TTL_MS = 5000;

export interface ScopedLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** scope 绑定工厂（lake/import 等高频 scope 用，免每行重复传） */
export function createLogger(scope: string): ScopedLogger {
  return {
    debug: (message, fields) => logDebug(scope, message, fields),
    info: (message, fields) => logInfo(scope, message, fields),
    warn: (message, fields) => logWarn(scope, message, fields),
    error: (message, fields) => logError(scope, message, fields),
  };
}

// ── 配置解析（env > 设置文件 > 默认）────────────────────────────────────

// 设置文件缓存：TTL 5s + mtime+size 混合——窗口内直接用缓存；过期后先 stat，
// mtime+size 均未变只刷新时间窗（免一次 read），任一变了才重新读 + sanitize。
// size 参与：低精度 mtime（FAT 2s / 部分网络挂载 1s）下同 mtime 重写会永远
// 命中旧缓存（turn-detail-cache 的 mtime+size 键控同款教训）
let cfgCache: { atMs: number; mtimeMs: number | null; size: number | null; cfg: LoggerConfigFile | null } | null = null;

function cachedFileConfig(): LoggerConfigFile | null {
  const now = Date.now();
  if (cfgCache && now - cfgCache.atMs < CFG_TTL_MS) return cfgCache.cfg;
  let st: { mtimeMs: number; size: number } | null = null;
  try {
    const s = fs.statSync(loggerConfigPath());
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch { /* 缺文件 */ }
  if (cfgCache && st && cfgCache.mtimeMs === st.mtimeMs && cfgCache.size === st.size) {
    cfgCache = { ...cfgCache!, atMs: now };
    return cfgCache.cfg;
  }
  const cfg = readLoggerConfigFile();
  cfgCache = { atMs: now, mtimeMs: st?.mtimeMs ?? null, size: st?.size ?? null, cfg };
  return cfg;
}

function envLevel(): LogLevel | null {
  return normalizeLoggerLevel(process.env.CANNBOT_LOG_LEVEL);
}

// env 三态：未设/空 → null（走下一候选）；设了 → off 模式为 false、其余为 true
function envFlag(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v == null || v === '') return null;
  return !OFF_RE.test(v);
}

export interface LoggerRuntimeConfig { enabled: boolean; level: LogLevel; file: boolean; stdout: boolean; dir: string }

function resolveConfig(): LoggerRuntimeConfig {
  const file = cachedFileConfig();
  return {
    enabled: envFlag(process.env.CANNBOT_LOG) ?? file?.enabled ?? true,
    level: envLevel() ?? file?.level ?? 'info',
    file: envFlag(process.env.CANNBOT_LOG_FILE) ?? file?.file ?? true,
    stdout: envFlag(process.env.CANNBOT_LOG_STDOUT) ?? file?.stdout ?? true,
    dir: process.env.CANNBOT_LOG_DIR?.trim() || path.join(CANNBOT_HOME, 'logs'),
  };
}

/** 当前生效配置快照（instrumentation 启动自报 / 测试用），只读不落盘 */
export function loggerConfigSnapshot(): LoggerRuntimeConfig {
  return resolveConfig();
}

// ── 行格式化（先过滤后格式化：级别不够时零字符串拼接）────────────────────

function clip(s: string): string {
  return s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX)}…` : s;
}

function fmtValue(v: string | number | boolean | Error): string {
  const raw = v instanceof Error ? v.message : typeof v === 'string' ? v : String(v);
  const clipped = clip(raw.replace(URL_CREDS_RE, '$1<creds>@'));
  // 含空白/引号/等号的值 JSON 转义保住 k=v 结构（JSON.stringify 出双引号串）
  return /[\s"=]/.test(clipped) ? JSON.stringify(clipped) : clipped;
}

function formatLine(ts: string, level: LogLevel, scope: string, message: string, fields?: LogFields): string {
  let line = `[${ts}][${level.toUpperCase()}][${scope}]:${clip(message.replace(/\r?\n/g, ' ').replace(URL_CREDS_RE, '$1<creds>@'))}`;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      const val = REDACT_KEY_RE.test(k) ? '[redacted]' : fmtValue(v);
      line += ` ${k}=${val}`;
    }
  }
  return line;
}

// ── 输出（文件 + stdout 双通道，各自独立吞错）────────────────────────────

let ensuredDir: string | null = null;

function appendLine(dir: string, now: Date, line: string): void {
  if (ensuredDir !== dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensuredDir = dir;
  }
  // mode 仅在创建时生效——目录 0700 已挡旁读，新建文件再落 0600
  fs.appendFileSync(path.join(dir, `insight-${now.toISOString().slice(0, 10)}.log`), `${line}\n`, { mode: 0o600 });
}

export function logLine(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  // 廉价短路：env 显式关日志时零配置解析（全静默态如测试每行只付一次 env 读）
  if (envFlag(process.env.CANNBOT_LOG) === false) return;
  const cfg = resolveConfig();
  if (!cfg.enabled) return;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[cfg.level]) return;
  const now = new Date();
  const line = formatLine(now.toISOString(), level, scope, message, fields);
  if (cfg.file) {
    try {
      appendLine(cfg.dir, now, line);
    } catch (e) {
      // 目录被外部删除/搬走：重置标记重建一次再写——否则文件通道静默失效到重启
      if ((e as { code?: string })?.code === 'ENOENT') {
        try {
          ensuredDir = null;
          appendLine(cfg.dir, now, line);
        } catch { /* 仍失败就丢这条，不阻断业务 */ }
      }
      /* 其他写失败就丢这条，不阻断业务 */
    }
  }
  if (cfg.stdout) {
    if (level === 'warn' || level === 'error') console.error(line);
    else console.log(line);
  }
}

/** 设置文件写后调用：清配置缓存让新配置立即生效（不等 5s TTL）。 */
export function resetLoggerConfigCache(): void {
  cfgCache = null;
}

/** 当前日志目录（env CANNBOT_LOG_DIR > 默认 ~/.cannbot-insight/logs）——设置页展示用 */
export function logsDir(): string {
  return resolveConfig().dir;
}

/** 仅测试用：清配置缓存与目录初始化标记（换 CANNBOT_LOG_DIR/配置文件后重置） */
export function resetLoggerForTest(): void {
  resetLoggerConfigCache();
  ensuredDir = null;
}

export function logDebug(scope: string, message: string, fields?: LogFields): void { logLine('debug', scope, message, fields); }
export function logInfo(scope: string, message: string, fields?: LogFields): void { logLine('info', scope, message, fields); }
export function logWarn(scope: string, message: string, fields?: LogFields): void { logLine('warn', scope, message, fields); }
export function logError(scope: string, message: string, fields?: LogFields): void { logLine('error', scope, message, fields); }
