// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BRAND_CONFIG_DIR_SUFFIX } from '@/lib/branding';
import { ConfigError } from './errors';

export const DEFAULT_SERVER_URL = 'http://localhost:21025';

export interface CliConfig {
  server: string;
  timeout: number;
  theme: 'dark' | 'light' | 'auto';
  keybindings: Record<string, string>;
}

export const DEFAULT_CONFIG: CliConfig = {
  server: DEFAULT_SERVER_URL,
  timeout: 15000,
  theme: 'auto',
  keybindings: {
    quit: 'q',
    help: '?',
    search: '/',
    refresh: 'r',
    navigateUp: 'k',
    navigateDown: 'j',
    enter: 'Enter',
    tabSwitch: 'Tab',
  },
};

// Computed lazily (not at module load) so tests can isolate HOME without
// nuking the real ~/.context-insight (which holds the proxy/ capture dir).
function configDir(): string {
  return path.join(os.homedir(), BRAND_CONFIG_DIR_SUFFIX);
}
function configFilePath(): string {
  return path.join(configDir(), 'config.json');
}

// 用户级端口登记文件（发现契约读侧）：insight start.sh 服务就绪后写入、
// 持久保留不随退出删除。多人服务器上每人各自固定端口，工具链零配置对准
// 自己的实例；登记目录与 lake-config.json 同源锚定，与写侧（start.sh /
// npm 启动器 registryPath）严格一致：dirname(CONTEXT_PROXY_DIR) →
// CONTEXT_INSIGHT_HOME → ~/.context-insight。契约细节见
// docs/design/multi-user/design.md。
function registryServerUrl(): string | null {
  try {
    const root = path.dirname(
      process.env.CONTEXT_PROXY_DIR ?? path.join(
        process.env.CONTEXT_INSIGHT_HOME ?? path.join(os.homedir(), BRAND_CONFIG_DIR_SUFFIX),
        'proxy',
      ),
    );
    const raw = fs.readFileSync(path.join(root, 'insight-port'), 'utf-8').trim();
    const port = Number.parseInt(raw, 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) return `http://localhost:${port}`;
    return null;
  } catch {
    return null;
  }
}

export function loadConfig(globalOpts?: { server?: string; timeout?: string }): CliConfig {
  let config = { ...DEFAULT_CONFIG };
  let serverExplicit = false;

  if (fs.existsSync(configFilePath())) {
    try {
      const saved = JSON.parse(fs.readFileSync(configFilePath(), 'utf-8'));
      config = { ...config, ...saved };
      // 升级迁移：旧 saveConfig 恒把 DEFAULT_CONFIG.server（或当时的解析值）
      // 并进 config.json，任何一次 config set 都把默认 21025 冻结成「显式值」。
      // 存量默认值并非用户有意设置 → 不判 explicit，让发现契约仍可生效
      // （多人服务器升级用户才不会被错误钉在 21025 连错实例）。
      const savedServer = (saved as { server?: unknown }).server;
      serverExplicit ||= typeof savedServer === 'string' && savedServer !== DEFAULT_SERVER_URL;
    } catch { /* ignore invalid config */ }
  }

  if (process.env.CONTEXT_SERVER) {
    config.server = process.env.CONTEXT_SERVER;
    serverExplicit = true;
  }

  if (globalOpts?.server) {
    config.server = globalOpts.server;
    serverExplicit = true;
  }

  // 发现契约回落：无任何显式来源（flag/env/config.json）时读端口登记文件；
  // 单人本机无登记文件 → 默认 21025 不变（零感知）
  if (!serverExplicit) {
    config.server = registryServerUrl() ?? DEFAULT_SERVER_URL;
  }

  if (process.env.CONTEXT_TIMEOUT) {
    config.timeout = +process.env.CONTEXT_TIMEOUT;
  }

  if (globalOpts?.timeout) {
    config.timeout = +globalOpts.timeout;
  }

  return config;
}

export function saveConfig(config: Partial<CliConfig>): void {
  const dir = configDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // 只持久化显式值：server 键只在「文件里已有或本次显式设置」时落盘——
  // 基底不铺 DEFAULT.server（否则一次 config set 就把默认/登记端口冻结进
  // config.json，之后换端口/删登记都不再生效）。基底同样不经 loadConfig
  // 的 env 解析，瞬时值（CONTEXT_SERVER）同样不落盘。
  const base: Partial<CliConfig> = { ...DEFAULT_CONFIG };
  delete base.server;
  if (fs.existsSync(configFilePath())) {
    try {
      Object.assign(base, JSON.parse(fs.readFileSync(configFilePath(), 'utf-8')));
    } catch { /* ignore invalid config */ }
  }
  const merged = { ...base, ...config };
  fs.writeFileSync(configFilePath(), JSON.stringify(merged, null, 2));
}

export function resetConfig(): void {
  if (fs.existsSync(configFilePath())) {
    try {
      fs.unlinkSync(configFilePath());
    } catch (e) {
      throw new ConfigError(`Failed to reset config: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
