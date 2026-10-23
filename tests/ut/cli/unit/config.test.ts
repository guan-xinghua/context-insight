// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { loadConfig, saveConfig, resetConfig, DEFAULT_CONFIG, DEFAULT_SERVER_URL } from '@/cli/config';
import { BRAND_CONFIG_DIR_SUFFIX } from '@/lib/branding';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate HOME to a tmpdir so the config tests never touch the REAL
// ~/.context-insight (which holds the proxy/ capture dir + session jsonl).
// config.ts reads os.homedir() lazily, so setting HOME here (before any
// loadConfig/saveConfig call in the it-blocks) redirects CONFIG_DIR to the
// tmpdir. Without this, fs.rmSync(CONFIG_DIR, recursive) below would nuke
// the real ~/.context-insight on every test run — the recurring "proxy dir
// vanishing" root cause.
let CONFIG_DIR = '';
let CONFIG_FILE = '';
let tmpHome = '';
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbot-config-test-'));
  process.env.HOME = tmpHome;
  CONFIG_DIR = path.join(tmpHome, BRAND_CONFIG_DIR_SUFFIX);
  CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe('config', () => {
  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
  });

  describe('DEFAULT_CONFIG', () => {
    it('has correct default server URL', () => {
      expect(DEFAULT_CONFIG.server).toBe(DEFAULT_SERVER_URL);
    });

    it('has correct default timeout', () => {
      expect(DEFAULT_CONFIG.timeout).toBe(15000);
    });

    it('has default keybindings', () => {
      expect(DEFAULT_CONFIG.keybindings.quit).toBe('q');
      expect(DEFAULT_CONFIG.keybindings.help).toBe('?');
    });
  });

  describe('loadConfig', () => {
    it('returns defaults when no config file exists', () => {
      const config = loadConfig();
      expect(config.server).toBe(DEFAULT_SERVER_URL);
      expect(config.timeout).toBe(15000);
    });

    it('overrides defaults with command line opts', () => {
      const config = loadConfig({ server: 'http://custom:8080', timeout: '5000' });
      expect(config.server).toBe('http://custom:8080');
      expect(config.timeout).toBe(5000);
    });

    it('overrides defaults with environment variables', () => {
      process.env.CONTEXT_SERVER = 'http://env-server:9999';
      process.env.CONTEXT_TIMEOUT = '30000';
      const config = loadConfig();
      expect(config.server).toBe('http://env-server:9999');
      expect(config.timeout).toBe(30000);
      delete process.env.CONTEXT_SERVER;
      delete process.env.CONTEXT_TIMEOUT;
    });

    it('command line opts override environment variables', () => {
      process.env.CONTEXT_SERVER = 'http://env-server:9999';
      const config = loadConfig({ server: 'http://cli-server:8080' });
      expect(config.server).toBe('http://cli-server:8080');
      delete process.env.CONTEXT_SERVER;
    });

    it('reads os.homedir() lazily so an after-import HOME change redirects CONFIG_DIR', () => {
      // Regression guard: config.ts must NOT capture CONFIG_DIR at module
      // load. If it did, the test's HOME isolation would fail and
      // fs.rmSync(CONFIG_DIR) would nuke the real ~/.context-insight (the
      // recurring "proxy capture dir vanishing" root cause).
      const altHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbot-config-alt-'));
      const prev = process.env.HOME;
      process.env.HOME = altHome;
      try {
        saveConfig({ server: 'http://alt-home:5555' });
        const altConfigFile = path.join(altHome, BRAND_CONFIG_DIR_SUFFIX, 'config.json');
        expect(fs.existsSync(altConfigFile)).toBe(true);
        const cfg = loadConfig();
        expect(cfg.server).toBe('http://alt-home:5555');
      } finally {
        process.env.HOME = prev;
        fs.rmSync(altHome, { recursive: true, force: true });
      }
    });

    it('loads saved config from file', () => {
      saveConfig({ server: 'http://saved:7777', theme: 'dark' });
      const config = loadConfig();
      expect(config.server).toBe('http://saved:7777');
      expect(config.theme).toBe('dark');
    });

    it('ignores invalid config file', () => {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, 'not json');
      const config = loadConfig();
      expect(config.server).toBe(DEFAULT_SERVER_URL);
    });
  });

  describe('saveConfig', () => {
    it('creates config directory if not exists', () => {
      if (fs.existsSync(CONFIG_DIR)) {
        fs.rmSync(CONFIG_DIR, { recursive: true });
      }
      saveConfig({ server: 'http://new:1234' });
      expect(fs.existsSync(CONFIG_DIR)).toBe(true);
      expect(fs.existsSync(CONFIG_FILE)).toBe(true);
    });

    it('merges with existing config', () => {
      saveConfig({ server: 'http://first:1111' });
      saveConfig({ timeout: 5000 });
      const config = loadConfig();
      expect(config.server).toBe('http://first:1111');
      expect(config.timeout).toBe(5000);
    });
  });

  describe('resetConfig', () => {
    it('removes config file', () => {
      saveConfig({ server: 'http://test:1234' });
      expect(fs.existsSync(CONFIG_FILE)).toBe(true);
      resetConfig();
      expect(fs.existsSync(CONFIG_FILE)).toBe(false);
    });

    it('does nothing when config file does not exist', () => {
      resetConfig();
      expect(fs.existsSync(CONFIG_FILE)).toBe(false);
    });
  });

  // 发现契约（多人服务器）：flag > env > config.json > 端口登记文件 > 默认。
  // 设计决策：登记文件持久保留、saveConfig 只持久化显式值——否则登记端口
  // 会被冻结进 config.json，换端口/删登记不再生效（docs/design/multi-user/）。
  // 注意路径必须调用时求值：describe 体在收集期执行，此时 tmpHome 尚为 ''
  // （beforeAll 未跑），收集期求值会得到相对路径写进包目录。
  describe('port registry discovery', () => {
    function registryFile(): string {
      return path.join(tmpHome, BRAND_CONFIG_DIR_SUFFIX, 'insight-port');
    }

    function writeRegistry(content: string): void {
      const file = registryFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }

    afterEach(() => {
      fs.rmSync(registryFile(), { force: true });
      delete process.env.CONTEXT_SERVER;
      delete process.env.CONTEXT_PROXY_DIR;
      delete process.env.CONTEXT_INSIGHT_HOME;
    });

    it('falls back to registry port when no explicit source exists', () => {
      writeRegistry('21226\n');
      const config = loadConfig();
      expect(config.server).toBe('http://localhost:21226');
    });

    it('explicit config.json server suppresses registry', () => {
      writeRegistry('21226\n');
      saveConfig({ server: 'http://saved:7777' });
      expect(loadConfig().server).toBe('http://saved:7777');
    });

    it('CONTEXT_SERVER env suppresses registry', () => {
      writeRegistry('21226\n');
      process.env.CONTEXT_SERVER = 'http://env-server:9999';
      expect(loadConfig().server).toBe('http://env-server:9999');
    });

    it('command line flag suppresses registry', () => {
      writeRegistry('21226\n');
      expect(loadConfig({ server: 'http://cli:8080' }).server).toBe('http://cli:8080');
    });

    it('malformed registry falls back to default port', () => {
      for (const bad of ['abc\n', '0\n', '65536\n', '']) {
        writeRegistry(bad);
        expect(loadConfig().server, `registry=${JSON.stringify(bad)}`).toBe(DEFAULT_SERVER_URL);
      }
    });

    it('registry anchor follows CONTEXT_PROXY_DIR parent', () => {
      const custom = path.join(tmpHome, 'custom-root', 'proxy');
      fs.mkdirSync(custom, { recursive: true });
      fs.writeFileSync(path.join(path.dirname(custom), 'insight-port'), '23000\n');
      process.env.CONTEXT_PROXY_DIR = custom;
      expect(loadConfig().server).toBe('http://localhost:23000');
      fs.rmSync(path.dirname(custom), { recursive: true, force: true });
    });

    it('registry anchor follows CONTEXT_INSIGHT_HOME (no CONTEXT_PROXY_DIR)', () => {
      const dataDir = path.join(tmpHome, 'relocated-data');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'insight-port'), '24000\n');
      process.env.CONTEXT_INSIGHT_HOME = dataDir;
      expect(loadConfig().server).toBe('http://localhost:24000');
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it('legacy default server in config.json does not suppress registry', () => {
      // 升级迁移：旧 saveConfig 恒把 DEFAULT_CONFIG.server 并进 config.json，
      // 任何一次 config set 都把默认 21025 冻结成「显式值」——存量默认值
      // 并非用户有意设置，不应压制端口登记（多人服务器升级用户不被错钉在 21025）
      writeRegistry('21226\n');
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ server: DEFAULT_SERVER_URL }));
      expect(loadConfig().server).toBe('http://localhost:21226');
    });

    it('saveConfig does not freeze registry-derived server into config.json', () => {
      writeRegistry('21226\n');
      saveConfig({ theme: 'dark' });
      const persisted = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as { server?: string };
      expect(persisted.server).toBeUndefined();
      expect(loadConfig().server).toBe('http://localhost:21226');
      expect(loadConfig().theme).toBe('dark');
    });
  });
});
