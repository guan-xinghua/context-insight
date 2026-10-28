// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一 logger 机制单测：级别过滤 / 总开关 / 懒初始化 / 文件+stdout 双写 /
// 按天滚动 / env>设置文件优先级 / 热重读 / 单行格式与脱敏。
// 断言一律打在文件内容上（vitest silent passed-only 会静默 stdout）。
// 隔离：CONTEXT_LOG_DIR + CONTEXT_LOG_CONFIG 指 mkdtemp（judge-log 晚赋值先例），
// beforeAll 删掉 setup.ts 的全局静音 CONTEXT_LOG，afterAll 恢复。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-logger-'));
const LOG_DIR = path.join(TMP, 'logs');
const CFG_FILE = path.join(TMP, 'logger-config.json');
process.env.CONTEXT_LOG_DIR = LOG_DIR;
process.env.CONTEXT_LOG_CONFIG = CFG_FILE;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['CONTEXT_LOG', 'CONTEXT_LOG_LEVEL', 'CONTEXT_LOG_FILE', 'CONTEXT_LOG_STDOUT', 'CONTEXT_LOG_DIR', 'CONTEXT_LOG_CONFIG'] as const;

const logger = await import('../../src/lib/logger');
const cfg = await import('../../src/lib/logger-config');

function todayFile(): string {
  return path.join(LOG_DIR, `insight-${new Date().toISOString().slice(0, 10)}.log`);
}

function readLog(): string {
  try { return fs.readFileSync(todayFile(), 'utf8'); } catch { return ''; }
}

function rmLogs(): void {
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
}

beforeAll(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; }
  delete process.env.CONTEXT_LOG;   // 抵消 tests/setup.ts 的全局静音
  delete process.env.CONTEXT_LOG_LEVEL;
  delete process.env.CONTEXT_LOG_FILE;
  delete process.env.CONTEXT_LOG_STDOUT;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  rmLogs();
  fs.rmSync(CFG_FILE, { force: true });
  logger.resetLoggerForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger 核心机制', () => {
  it('懒初始化：仅 reset 不写日志 → 目录不创建（CLI 传递引入安全）', () => {
    expect(fs.existsSync(LOG_DIR)).toBe(false);
  });

  it('默认 info：debug 行被过滤、info/warn/error 落盘，文件按天命名', () => {
    logger.logDebug('t', 'hidden');
    logger.logInfo('t', 'visible-info');
    logger.logWarn('t', 'visible-warn');
    logger.logError('t', 'visible-error');
    const out = readLog();
    expect(fs.existsSync(todayFile())).toBe(true);
    expect(out).not.toContain('hidden');
    expect(out).toContain('[INFO][t]:visible-info');
    expect(out).toContain('[WARN][t]:visible-warn');
    expect(out).toContain('[ERROR][t]:visible-error');
  });

  it('级别过滤：CONTEXT_LOG_LEVEL=error 时 info 不落盘（env 每调用现读，晚赋值生效）', () => {
    logger.logInfo('t', 'before-switch');
    process.env.CONTEXT_LOG_LEVEL = 'error';
    logger.logInfo('t', 'after-switch');
    logger.logError('t', 'still-there');
    const out = readLog();
    expect(out).toContain('before-switch');
    expect(out).not.toContain('after-switch');
    expect(out).toContain('still-there');
    delete process.env.CONTEXT_LOG_LEVEL;
  });

  it('总开关：CONTEXT_LOG=off → 一行不输出、目录连建都不建', () => {
    process.env.CONTEXT_LOG = 'off';
    logger.logError('t', 'nothing');
    expect(fs.existsSync(LOG_DIR)).toBe(false);
    delete process.env.CONTEXT_LOG;
  });

  it('双写：CONTEXT_LOG_FILE=0 → 文件不建、stdout 通道仍在（console spy 命中）', () => {
    process.env.CONTEXT_LOG_FILE = '0';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.logInfo('t', 'stdout-only');
    expect(fs.existsSync(LOG_DIR)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('stdout-only');
    delete process.env.CONTEXT_LOG_FILE;
  });

  it('warn/error 走 console.error、info/debug 走 console.log', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.logInfo('t', 'to-log');
    logger.logWarn('t', 'to-err');
    logger.logError('t', 'to-err-2');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(2);
  });

  it('env > 设置文件 > 默认：config level=warn 滤掉 info；env LEVEL=debug 压过设置文件', () => {
    cfg.writeLoggerConfigFile({ enabled: true, level: 'warn', file: true, stdout: true });
    logger.resetLoggerForTest();
    logger.logInfo('t', 'filtered-by-file');
    expect(readLog()).not.toContain('filtered-by-file');

    process.env.CONTEXT_LOG_LEVEL = 'debug';
    logger.logInfo('t', 'env-overrides-file');
    expect(readLog()).toContain('env-overrides-file');
    delete process.env.CONTEXT_LOG_LEVEL;
  });

  it('设置文件 enabled=false 关日志；env CONTEXT_LOG=1 压过设置页重新打开', () => {
    cfg.writeLoggerConfigFile({ enabled: false, level: 'info', file: true, stdout: true });
    logger.resetLoggerForTest();
    logger.logError('t', 'off-by-file');
    expect(fs.existsSync(LOG_DIR)).toBe(false);

    process.env.CONTEXT_LOG = '1';
    logger.logError('t', 'env-reopens');
    expect(readLog()).toContain('env-reopens');
    delete process.env.CONTEXT_LOG;
  });

  it('热重读：改设置文件 + reset 后新级别即时生效（设置页保存路径）', () => {
    logger.logInfo('t', 'warm-up');
    cfg.writeLoggerConfigFile({ enabled: true, level: 'error', file: true, stdout: true });
    logger.resetLoggerForTest();
    logger.logInfo('t', 'now-filtered');
    logger.logError('t', 'still-logged');
    const out = readLog();
    expect(out).toContain('warm-up');
    expect(out).not.toContain('now-filtered');
    expect(out).toContain('still-logged');
  });

  it('单行格式：k=v、含空格值转义、多行消息压平、Error 值取 message、敏感 key 打码、undefined/null 丢弃', () => {
    logger.logInfo('fmt', 'multi\nline message', {
      ms: 2140,
      interactions: 3891,
      ok: true,
      who: 'bat man',
      err: new Error('boom happened'),
      token: 'super-secret-value',
      apiKey: 'k-123',
      nothing: undefined,
      absent: null,
    });
    const line = readLog().trimEnd().split('\n').pop() ?? '';
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]\[INFO\]\[fmt\]:multi line message /);
    expect(line).toContain('ms=2140');
    expect(line).toContain('interactions=3891');
    expect(line).toContain('ok=true');
    expect(line).toContain('who="bat man"');
    expect(line).toContain('err="boom happened"');
    expect(line).toContain('token=[redacted]');
    expect(line).not.toContain('super-secret-value');
    expect(line).toContain('apiKey=[redacted]');
    expect(line).not.toContain('nothing=');
    expect(line).not.toContain('absent=');
    expect(line).not.toMatch(/\n/);
  });

  it('warning 别名：env CONTEXT_LOG_LEVEL=warning 等价 warn（归一唯一实现）', () => {
    logger.logInfo('t', 'before-alias');
    process.env.CONTEXT_LOG_LEVEL = 'warning';
    logger.logInfo('t', 'filtered-by-alias');
    logger.logWarn('t', 'warn-passes-alias');
    const out = readLog();
    expect(out).toContain('before-alias');
    expect(out).not.toContain('filtered-by-alias');
    expect(out).toContain('warn-passes-alias');
    delete process.env.CONTEXT_LOG_LEVEL;
  });

  it('设置文件坏 level 不连坐：enabled=false 仍生效（逐字段降级，曾整份判废）', () => {
    fs.writeFileSync(CFG_FILE, JSON.stringify({ enabled: false, level: 'verbose', file: true, stdout: true }));
    logger.resetLoggerForTest();
    logger.logError('t', 'should-be-silent');
    expect(fs.existsSync(LOG_DIR)).toBe(false);
  });

  it('热重读真实路径（不 reset）：改配置文件 + TTL 过期后下一行生效', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      logger.logInfo('t', 'ttl-warmup');   // 填缓存
      cfg.writeLoggerConfigFile({ enabled: true, level: 'error', file: true, stdout: true });
      // 强制 mtime 与 size 变化可辨（writeFileSync 通常足够，utimes 兜底同拍写入）
      fs.utimesSync(CFG_FILE, new Date(Date.now() / 2), new Date(Date.now() / 2));
      logger.logInfo('t', 'within-ttl-filtered-or-not');
      vi.setSystemTime(Date.now() + 6000);   // TTL 过期 → 下一行触发 stat+重读
      logger.logInfo('t', 'after-ttl-filtered');
      logger.logError('t', 'after-ttl-error-passes');
      const out = readLog();
      expect(out).toContain('ttl-warmup');
      expect(out).toContain('after-ttl-error-passes');
      expect(out).not.toContain('after-ttl-filtered');
    } finally {
      vi.useRealTimers();
    }
  });

  it('消息超长截断保单行（VALUE_MAX）', () => {
    logger.logInfo('t', `x`.repeat(5000));
    const line = readLog().trimEnd();
    expect(line.length).toBeLessThan(2200);
    expect(line.endsWith('…')).toBe(true);
  });

  it('URL 内嵌凭据剥除：message 与字段值都不落 token', () => {
    logger.logInfo('t', 'fetch 失败 https://user:secret-token@gitcode.com/x.git', { url: 'https://oauth2:tk-123@host/api' });
    const out = readLog();
    expect(out).not.toContain('secret-token');
    expect(out).not.toContain('tk-123');
    expect(out).toContain('https://<creds>@gitcode.com/x.git');
  });

  it('目录被外部删除后自愈：下一行重建目录继续落盘（曾静默失效到重启）', () => {
    logger.logInfo('t', 'before-rm');
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    expect(fs.existsSync(LOG_DIR)).toBe(false);
    logger.logInfo('t', 'after-rm-recovered');
    expect(readLog()).toContain('after-rm-recovered');
  });

  it('createLogger 工厂：scope 绑定后各行带同一 [scope]', () => {
    const lakeLog = logger.createLogger('lake');
    lakeLog.info('clone done', { ms: 8600 });
    expect(readLog()).toContain('[INFO][lake]:clone done ms=8600');
  });

  it('stdout 开关：CONTEXT_LOG_STDOUT=0 → 文件照写、console 静默；设置页关屏显同链', () => {
    process.env.CONTEXT_LOG_STDOUT = '0';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.logInfo('t', 'file-only-line');
    logger.logError('t', 'file-only-err');
    expect(readLog()).toContain('file-only-line');
    expect(readLog()).toContain('file-only-err');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    delete process.env.CONTEXT_LOG_STDOUT;

    // 设置页链路：配置文件 stdout=false 同效（热重读后生效）
    cfg.writeLoggerConfigFile({ enabled: true, level: 'info', file: true, stdout: false });
    logger.resetLoggerForTest();
    logger.logInfo('t', 'file-only-by-config');
    expect(readLog()).toContain('file-only-by-config');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('写文件失败不抛（目录不可写），stdout 照发', () => {
    // 占位文件挡住递归建目录：mkdirSync ENOTDIR → 吞错 → 文件通道失效
    fs.writeFileSync(path.join(TMP, 'not-a-dir'), 'occupied');
    process.env.CONTEXT_LOG_DIR = path.join(TMP, 'not-a-dir', 'deeper');
    logger.resetLoggerForTest();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logger.logError('t', 'survives-io-failure')).not.toThrow();
    expect(String(errSpy.mock.calls[0][0])).toContain('survives-io-failure');
    process.env.CONTEXT_LOG_DIR = LOG_DIR;
    logger.resetLoggerForTest();
  });
});
