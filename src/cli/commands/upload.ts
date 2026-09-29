// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { Command } from 'commander';
import { InsightClient } from '../client';
import { renderTable, TableColumn } from '../utils/table';
import { formatDate } from '../utils/format';
import { formatHeader, formatDivider, formatSuccess, formatWarning, theme } from '../utils/colors';
import { BAY_NAME } from '@/lib/branding';
import type { ApiImportableSession, ApiImportableSessionsResponse } from '../types';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const IMPORT_COLUMNS: TableColumn[] = [
  { key: 'id', label: 'Session ID', width: 20 },
  { key: 'firstQuery', label: 'Query', width: 30 },
  { key: 'turnCount', label: 'Turns', width: 8 },
  { key: 'model', label: 'Model', width: 18 },
  { key: 'createdAt', label: 'Created', width: 16 },
];

function renderImportableRow(row: ApiImportableSession, key: string): string {
  switch (key) {
    case 'firstQuery': return row.firstQuery ?? '—';
    case 'model': return row.model ?? '—';
    case 'createdAt': return formatDate(row.createdAt);
    default: return String(row[key as keyof ApiImportableSession] ?? '—');
  }
}

async function confirmPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function inputPrompt(label: string, defaultVal: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${label}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

// 提交人必填：回车跳过（默认值为空）时重复提示 —— 空提交人的 commit author
// 会顶替为机器身份 cannbot-insight（lake/index.ts 网关同样强制拦截）
async function submitterPrompt(defaultVal: string): Promise<string> {
  for (;;) {
    const v = await inputPrompt('提交人（必填）', defaultVal);
    if (v.trim()) return v.trim();
    console.log(theme.danger('提交人不能为空，请填写真实姓名或账号'));
  }
}

// 范式目录必填（默认仓网关强制）：候选 = 数据仓顶层目录（目录即注册表，
// 排除存量区 sessions）。新增范式 = 在数据仓新建顶层目录，这里自动出现。
async function paradigmPrompt(client: InsightClient): Promise<string> {
  const { dirs } = await client.listRemoteDirs('');
  const candidates = (dirs ?? []).filter(d => d !== 'sessions');
  if (candidates.length === 0) {
    throw new Error('数据仓暂无范式目录：请先在数据仓顶层新建范式目录（如 elementwise/contraction/others）后重试');
  }
  console.log('');
  console.log(theme.muted('选择范式目录（数据仓顶层目录，新增范式请在数据仓建目录）：'));
  candidates.forEach((d, i) => console.log(theme.muted(`  ${i + 1}. `) + d));
  for (;;) {
    const v = await inputPrompt('范式目录编号或名称（必填）', '');
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n >= 1 && n <= candidates.length) return candidates[n - 1];
    if (candidates.includes(v)) return v;
    console.log(theme.danger(`无效选择：请输入 1-${candidates.length} 的编号或目录名`));
  }
}

async function collectDescription(sessionInfo: { query?: string; user?: string; model?: string; taskId?: string; framework?: string; sourcePath?: string }): Promise<string> {
  const timeRange = new Date().toISOString().split('T')[0];
  const query = sessionInfo.query ?? '';
  const user = sessionInfo.user ?? '';
  const model = sessionInfo.model ?? '';
  const taskId = sessionInfo.taskId ?? '';
  const framework = sessionInfo.framework ?? '';
  const sourcePath = sessionInfo.sourcePath ?? '';

  console.log('');
  console.log(theme.muted('填写提交信息（提交人必填，其余直接回车使用默认值）：'));
  console.log('');

  const submitter = await submitterPrompt(user || '');
  const contentDesc = await inputPrompt('内容描述', query || '');
  const issueDesc = await inputPrompt('问题说明', '');
  const logPath = await inputPrompt('日志路径', sourcePath || `taskId ${taskId}, 框架 ${framework}`);
  const notes = await inputPrompt('备注', `模型 ${model}, 时间 ${timeRange}`);

  return `提交人: ${submitter}
内容描述: ${contentDesc}
问题说明: ${issueDesc}
日志路径: ${logPath}
备注: ${notes}`;
}

function detectSourceType(filePath: string): 'opencode-db' | 'claude-jsonl' | string {
  const basename = filePath.split('/').pop() ?? '';
  if (basename.endsWith('.db') && basename.startsWith('cannbot_session_')) return 'cannbot-insight';
  if (basename.endsWith('.db')) return 'opencode-db';
  if (basename.endsWith('.jsonl') || basename.endsWith('.json')) return 'claude-jsonl';
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return 'claude-jsonl';
  } catch {}
  return 'claude-jsonl';
}

async function ensureBackend(client: InsightClient): Promise<boolean> {
  try {
    await client.listSessions({ pageSize: 1 });
    return true;
  } catch {
    return false;
  }
}

function spawnBackend(port: number): number {
  const pid = execSync(
    `npx next dev --port ${port} > /dev/null 2>&1 & echo $!`,
    { encoding: 'utf-8', timeout: 10_000 },
  ).trim();
  return parseInt(pid, 10);
}

async function waitForBackend(client: InsightClient, maxWait: number = 60): Promise<boolean> {
  for (let i = 0; i < maxWait; i++) {
    try {
      await client.listSessions({ pageSize: 1 });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

async function selectPrompt(sessions: ApiImportableSession[]): Promise<ApiImportableSession> {
  console.log(formatHeader('Select a session to upload:'));
  console.log(renderTable(
    IMPORT_COLUMNS,
    sessions as unknown as Record<string, unknown>[],
    renderImportableRow as unknown as (row: Record<string, unknown>, key: string) => string,
  ));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question(`Enter session number (1-${sessions.length}): `, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10);
      if (idx >= 1 && idx <= sessions.length) {
        resolve(sessions[idx - 1]);
      } else {
        reject(new Error(`Invalid selection: "${answer}". Enter a number between 1 and ${sessions.length}.`));
      }
    });
  });
}

export function uploadCommand(): Command {
  const cmd = new Command('upload');
  cmd
    .description(`Upload session to ${BAY_NAME} (auto-starts backend if needed)`)
    .option('--session <taskId>', 'Upload from Insight DB by taskId')
    .option('--framework <framework>', 'Framework type (auto-detected from file)')
    .option('--source <type>', 'Source type — auto-detected from --file if omitted')
    .option('--file <path>', 'Source file path for direct upload')
    .option('--list', 'List importable sessions from source file')
    .option('--session-id <id>', 'Upload specific session from source file by ID')
    .option('--description <text>', 'Description text (skip interactive prompt)')
    .option('--paradigm <dir>', `Paradigm directory in ${BAY_NAME} (top-level dir, required for default remote)`)
    .option('--baseline', 'Set this session as the paradigm baseline (<paradigm>/baseline/, replaces the current one)')
    .option('--interactive', 'Interactive prompt for description fields (default when no --description)')
    .option('--yes', 'Skip confirmation prompt')
    .option('--json', 'Output result as JSON')
    .action(async (opts, command) => {
      const globalOpts = command.parent?.opts() ?? {};
      const serverUrl = globalOpts.server ?? 'http://localhost:21025';
      const client = new InsightClient(serverUrl, {
        timeout: +globalOpts.timeout || 120000,
      });

      // Auto-start backend if not running
      const backendRunning = await ensureBackend(client);
      let backendPid: number | null = null;

      if (!backendRunning) {
        if (!opts.json) console.log(theme.muted('Backend not running, starting...'));
        const port = parseInt(serverUrl.split(':').pop() ?? '21025', 10);
        backendPid = spawnBackend(port);
        const ready = await waitForBackend(client);
        if (!ready) {
          console.error(formatWarning('Error: Backend failed to start'));
          if (backendPid) try { process.kill(backendPid); } catch {}
          process.exit(1);
        }
        if (!opts.json) console.log(theme.muted('Backend ready'));
      }

      try {
        let description = opts.description ?? '';
        const needInteractive = !opts.description && !opts.json;
        // 同 sid 双行（方案一）上传消歧：DB 行 framework（--session 交互态取
        // 行详情 / --file 用导入响应里的行 framework）
        let uploadFramework: string | undefined;

        // Mode 1: Upload from Insight DB by taskId
        if (opts.session) {
          const taskId = opts.session;

          if (needInteractive) {
            const sessionDetail = await client.getSession(taskId);
            description = await collectDescription({
              query: sessionDetail.query ?? undefined,
              user: sessionDetail.user ?? undefined,
              model: sessionDetail.model ?? undefined,
              taskId,
              framework: sessionDetail.framework ?? opts.framework ?? 'unknown',
              sourcePath: undefined,
            });
            // 同 sid 双行（方案一）消歧：交互态拿到的行 framework 穿给上传
            uploadFramework = sessionDetail.framework ?? opts.framework ?? undefined;
          } else {
            uploadFramework = opts.framework ?? undefined;
          }
          const paradigm = opts.paradigm ?? (needInteractive ? await paradigmPrompt(client) : undefined);
          const baseline = opts.baseline || (needInteractive && paradigm
            ? await confirmPrompt(`将 "${taskId}" 设为范式 ${paradigm} 的 baseline 会话？（已有 baseline 会被移回普通目录）`)
            : false);

          if (!opts.json) {
            console.log(formatHeader(`Upload Session: ${taskId}`));
            console.log(formatDivider());
            if (paradigm) console.log(theme.muted(`  Paradigm dir: ${paradigm}${baseline ? ' (baseline)' : ''}`));
            console.log(theme.muted('Description:'));
            console.log(theme.muted(description));
          }

          const result = paradigm && baseline
            ? await client.uploadSession(taskId, description, paradigm, true, uploadFramework)
            : paradigm
              ? await client.uploadSession(taskId, description, paradigm, undefined, uploadFramework)
              : await client.uploadSession(taskId, description, undefined, undefined, uploadFramework);

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(formatSuccess(`✓ Uploaded session ${taskId} → ${BAY_NAME}`));
          console.log(theme.muted(`  Folder: ${result.folder}${result.unchanged ? ' (unchanged)' : ''}`));
          return;
        }

        // Mode 2: Upload from source file (import → upload)
        if (opts.file) {
          const source = opts.source ?? detectSourceType(opts.file);
          const filePath = opts.file;

          const importable: ApiImportableSessionsResponse = await client.listImportableSessions(source, filePath);

          if (opts.list) {
            if (opts.json) {
              console.log(JSON.stringify(importable, null, 2));
              return;
            }
            const sessions = importable.sessions as ApiImportableSession[];
            if (sessions.length === 0) {
              console.log(theme.muted('No importable sessions found.'));
              return;
            }
            console.log(formatHeader(`Importable Sessions (${source})`));
            console.log(renderTable(
              IMPORT_COLUMNS,
              sessions as unknown as Record<string, unknown>[],
              renderImportableRow as unknown as (row: Record<string, unknown>, key: string) => string,
            ));
            return;
          }

          const sessions = importable.sessions as ApiImportableSession[];
          let target: ApiImportableSession;

          if (opts.sessionId) {
            const found = sessions.find(s => s.id === opts.sessionId);
            if (!found) {
              console.error(formatWarning(`Error: Session "${opts.sessionId}" not found`));
              process.exit(1);
            }
            target = found;
          } else if (sessions.length === 1) {
            target = sessions[0];
          } else {
            // Multiple sessions — list and let user pick
            try {
              target = await selectPrompt(sessions);
            } catch (e) {
              console.error(formatWarning(e instanceof Error ? e.message : 'Invalid selection'));
              process.exit(1);
            }
          }

          const resolvedFramework = source === 'opencode-db' ? 'opencode' : source === 'claude-jsonl' ? 'claude-code' : source;

          if (needInteractive) {
            description = await collectDescription({
              query: target.firstQuery ?? undefined,
              user: undefined,
              model: target.model ?? undefined,
              taskId: target.id,
              framework: resolvedFramework,
              sourcePath: filePath,
            });
          }
          const paradigm = opts.paradigm ?? (needInteractive ? await paradigmPrompt(client) : undefined);
          const baseline = opts.baseline || (needInteractive && paradigm
            ? await confirmPrompt(`将 "${target.id}" 设为范式 ${paradigm} 的 baseline 会话？（已有 baseline 会被移回普通目录）`)
            : false);

          if (!opts.json) {
            console.log(formatHeader(`Upload from Source: ${source}`));
            console.log(formatDivider());
            console.log(`  Session: ${target.id} — ${target.firstQuery ?? '—'}`);
            console.log(`  File: ${filePath}`);
            if (paradigm) console.log(theme.muted(`  Paradigm dir: ${paradigm}${baseline ? ' (baseline)' : ''}`));
            console.log(theme.muted('Description:'));
            console.log(theme.muted(description));
            console.log('');
          }

          if (!opts.yes) {
            const confirmed = await confirmPrompt(`Import and upload session ${target.id}?`);
            if (!confirmed) {
              console.log(theme.muted('Upload cancelled.'));
              return;
            }
          }

          // Step 1: Import into Insight DB
          if (!opts.json) console.log(theme.muted('  Importing into Insight DB...'));
          const importResult = await client.importSession(source, filePath, target.id);

          // Step 2: 上传到数据仓——framework 用导入响应的行 framework（DB
          // 为准，proxy 捕获导入后是 claude-code-proxy 等——文件源推导的
          // resolvedFramework 与行值不一致，用它会消歧失败）
          if (!opts.json) console.log(theme.muted(`  Uploading to ${BAY_NAME}...`));
          const uploadFw = importResult.framework ?? undefined;
          const uploadResult = paradigm && baseline
            ? await client.uploadSession(target.id, description, paradigm, true, uploadFw)
            : paradigm
              ? await client.uploadSession(target.id, description, paradigm, undefined, uploadFw)
              : await client.uploadSession(target.id, description, undefined, undefined, uploadFw);

          if (opts.json) {
            console.log(JSON.stringify({ import: importResult, upload: uploadResult }, null, 2));
            return;
          }

          console.log(formatSuccess(`✓ Imported & uploaded session ${target.id} → ${BAY_NAME}`));
          console.log(theme.muted(`  Insight taskId: ${importResult.sessionId}`));
          console.log(theme.muted(`  Folder: ${uploadResult.folder}${uploadResult.unchanged ? ' (unchanged)' : ''}`));
          return;
        }

        console.error(formatWarning('Error: Specify --session <taskId> or --file <path>'));
        process.exit(1);
      } finally {
        // Auto-stop backend if we started it
        if (backendPid) {
          if (!opts.json) console.log(theme.muted('Stopping backend...'));
          try { process.kill(backendPid); } catch {}
        }
      }
    });

  return cmd;
}
