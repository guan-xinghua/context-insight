// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configCommand } from '@/cli/commands/config';
import { loadConfig, saveConfig, resetConfig, DEFAULT_CONFIG } from '@/cli/config';
import { formatTokens } from '@/cli/utils/format';
import { getAllContextWindows, getDefaultContextWindow } from '@/lib/context-window-config';

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const savedHome = process.env.HOME;
const savedProxyDir = process.env.CONTEXT_PROXY_DIR;
const savedInsightHome = process.env.CONTEXT_INSIGHT_HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxi-cmd-config-test-'));

beforeAll(() => {
  process.env.HOME = tmpHome;
  delete process.env.CONTEXT_PROXY_DIR;
  delete process.env.CONTEXT_INSIGHT_HOME;
  delete process.env.CONTEXT_SERVER;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProxyDir === undefined) delete process.env.CONTEXT_PROXY_DIR;
  else process.env.CONTEXT_PROXY_DIR = savedProxyDir;
  if (savedInsightHome === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = savedInsightHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { }
});

describe('configCommand', () => {
  beforeEach(() => {
    resetConfig();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    resetConfig();
  });

  it('registers as a Commander sub-command', () => {
    const cmd = configCommand();
    expect(cmd.name()).toBe('config');
    expect(cmd.description()).toContain('configuration');
  });

  it('has sub-commands: set, get, list, context-windows, reset', () => {
    const cmd = configCommand();
    const subCommands = cmd.commands.map(c => c.name());
    expect(subCommands).toContain('set');
    expect(subCommands).toContain('get');
    expect(subCommands).toContain('list');
    expect(subCommands).toContain('context-windows');
    expect(subCommands).toContain('reset');
  });

  it('set sub-command requires key and value arguments', () => {
    const cmd = configCommand();
    const setCmd = cmd.commands.find(c => c.name() === 'set');
    expect(setCmd).toBeDefined();
    expect(setCmd!.registeredArguments.length).toBeGreaterThanOrEqual(2);
  });

  it('get sub-command requires key argument', () => {
    const cmd = configCommand();
    const getCmd = cmd.commands.find(c => c.name() === 'get');
    expect(getCmd).toBeDefined();
    expect(getCmd!.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it('saveConfig and loadConfig work together', () => {
    saveConfig({ server: 'http://custom:8080', timeout: 5000 });
    const config = loadConfig();
    expect(config.server).toBe('http://custom:8080');
    expect(config.timeout).toBe(5000);
  });

  it('DEFAULT_CONFIG has expected keys', () => {
    expect(DEFAULT_CONFIG.server).toBeDefined();
    expect(DEFAULT_CONFIG.timeout).toBeDefined();
    expect(DEFAULT_CONFIG.theme).toBeDefined();
    expect(DEFAULT_CONFIG.keybindings).toBeDefined();
  });

  it('valid config keys match DEFAULT_CONFIG keys', () => {
    const validKeys = Object.keys(DEFAULT_CONFIG);
    expect(validKeys).toContain('server');
    expect(validKeys).toContain('timeout');
    expect(validKeys).toContain('theme');
    expect(validKeys).toContain('keybindings');
  });

  it('context-windows shows model context sizes', () => {
    const allWindows = getAllContextWindows();
    const defaultWindow = getDefaultContextWindow();

    expect(allWindows['gpt-4o']).toBe(128000);
    expect(allWindows['claude-3.5-sonnet']).toBe(200000);
    expect(defaultWindow).toBeGreaterThan(0);

    expect(formatTokens(allWindows['gpt-4o'])).toBe('128.0K');
    expect(formatTokens(allWindows['claude-3.5-sonnet'])).toBe('200.0K');
  });

  it('resetConfig clears saved config', () => {
    saveConfig({ server: 'http://test:1234' });
    resetConfig();
    const config = loadConfig();
    expect(config.server).toBe(DEFAULT_CONFIG.server);
  });
});
