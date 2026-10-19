// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 观测域 CLI：import-bundle（job 轮询）+ runs（列表）。run 详情视图随 P3。

import { Command } from 'commander';
import { InsightClient } from '../client';
import { renderTable, TableColumn } from '../utils/table';
import { formatDate } from '../utils/format';
import { formatHeader, formatSuccess, formatWarning, theme } from '../utils/colors';
import type { ApiImportBundleJob, ApiRunListItem } from '../types';

const RUN_COLUMNS: TableColumn[] = [
  { key: 'runId', label: 'Run ID', width: 20 },
  { key: 'name', label: 'Name', width: 16 },
  { key: 'status', label: 'Status', width: 8 },
  { key: 'gens', label: 'Gens', width: 8 },
  { key: 'nodes', label: 'Nodes', width: 6 },
  { key: 'members', label: 'Members', width: 8 },
  { key: 'rollbacks', label: 'Rollbacks', width: 9 },
  { key: 'importedAt', label: 'Imported', width: 16 },
];

function renderRunRow(row: Record<string, unknown>, key: string): string {
  const run = row as unknown as ApiRunListItem & { gens: string; nodes: number; members: number; rollbacks: number; importedAt: string };
  switch (key) {
    case 'status': return run.exportDataComplete ? run.status : `${run.status}(!)`;
    case 'gens': return run.generations.map(g => (g === 0 ? 'g0' : `g${g}`)).join(' ');
    case 'importedAt': return run.importedAt ? formatDate(run.importedAt) : '—';
    default: return String(run[key as keyof typeof run] ?? '—');
  }
}

export function runsCommand(): Command {
  const cmd = new Command('runs');
  cmd
    .description('List imported workflow runs')
    .option('--json', 'Output as JSON')
    .action(async (opts, command) => {
      const globalOpts = command.parent?.opts() ?? {};
      const client = new InsightClient(globalOpts.server, { timeout: +globalOpts.timeout });
      const data = await client.listRuns();

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (data.runs.length === 0) {
        console.log(theme.muted('No runs imported. Use `cbi import-bundle <dir>` to import a workflow-bundle.'));
        return;
      }
      console.log(formatHeader(`Runs (${data.runs.length})`));
      const rows = data.runs.map(r => ({
        ...r,
        gens: '',
        nodes: r.nodeCount,
        members: r.memberCount,
        rollbacks: r.rollbackCount,
        importedAt: r.importedAt ?? '',
      }));
      console.log(renderTable(RUN_COLUMNS, rows, renderRunRow));
      for (const w of data.warnings) console.log(formatWarning(w));
    });
  return cmd;
}

function jobProgressLine(job: ApiImportBundleJob): string {
  if (job.step === 'done') {
    const parts = [
      `导入 ${job.imported}`,
      `已存在 ${job.existing}`,
      job.missingFile > 0 ? `缺文件 ${job.missingFile}` : '',
      job.failed > 0 ? `失败 ${job.failed}` : '',
    ].filter(Boolean);
    return `${job.runId}: ${parts.join(' / ')}`;
  }
  const pct = job.total > 0 ? ` (${Math.round(((job.imported + job.existing + job.failed) / job.total) * 100)}%)` : '';
  return `${job.step}${pct}: ${job.imported + job.existing}/${job.total}${job.currentSid ? ` 当前 ${job.currentSid}` : ''}`;
}

export function importBundleCommand(): Command {
  const cmd = new Command('import-bundle');
  cmd
    .description('Import an Opsbot workflow-bundle directory (workflow.json + sessions/)')
    .argument('<dir>', 'Bundle directory containing workflow.json')
    .option('--no-wait', 'Start the import job and return immediately (poll via status jobId)')
    .option('--json', 'Output as JSON')
    .action(async (dir: string, opts, command) => {
      const globalOpts = command.parent?.opts() ?? {};
      const client = new InsightClient(globalOpts.server, {
        // 导入 job 启动接口本身很快（校验 + 落盘），但大 manifest 校验留余量
        timeout: Math.max(+globalOpts.timeout, 60000),
      });

      const started = await client.importBundle(dir);
      if (!opts.wait) {
        console.log(JSON.stringify(started, null, 2));
        return;
      }

      let job: ApiImportBundleJob | null = null;
      for (;;) {
        const current = (await client.getImportBundleStatus(started.jobId)).job;
        if (current.step === 'done' || current.step === 'error') {
          job = current;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!job) throw new Error('导入状态查询失败');

      if (opts.json) {
        console.log(JSON.stringify({ ...started, job }, null, 2));
        return;
      }
      if (job.step === 'error') {
        console.error(formatWarning(`导入失败: ${job.error}`));
        process.exitCode = 1;
        return;
      }
      console.log(formatSuccess(`Run ${job.runId} 导入完成`));
      console.log(jobProgressLine(job));
      for (const w of job.warnings) console.log(formatWarning(w));
    });
  return cmd;
}
