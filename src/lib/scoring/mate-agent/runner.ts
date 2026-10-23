// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Mate Agent 执行器：把 GUIDE + 会话物料喂给本地 claude/opencode，读回评审 JSON。

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { exportMaterial, safeId } from './material';
import { logWarn } from '@/lib/logger';
import { CONTEXT_HOME } from '../core/store';
import type { DimensionDefinition, ScoreItemSchema } from '../core/schema';
import type { MateAgentItem } from './coerce';

export type MateAgentTool = 'claude' | 'opencode';

export const MATE_DIMENSIONS = ['D1', 'D2', 'D3', 'D5', 'D6'] as const;

export const DIM_NAMES: Record<string, string> = {
  D1: '完成度', D2: '行为可信', D3: '完成质量', D4: '完成效率', D5: '冗余度', D6: '自主性',
};

/** 有 LLM 子项的维度（自适应评分配置：profile 勾选与 D7 用户维度都反映在注册表 defs 里，D4/整维取消的自然不在） */
export function mateDimensionsOf(defs: DimensionDefinition[]): string[] {
  return defs.filter(d => d.items.some(i => i.scorerKind === 'llm')).map(d => d.id);
}

/** 某维度的 LLM 子项清单（传给 mate 的动态任务说明） */
export function llmItemsOf(defs: DimensionDefinition[], dimensionId: string): ScoreItemSchema[] {
  return defs.find(d => d.id === dimensionId)?.items.filter(i => i.scorerKind === 'llm') ?? [];
}

/** GUIDE 静态说明已覆盖的内置 LLM 子项（动态清单里不再重复展开） */
const GUIDE_COVERED_ITEMS = new Set([
  'D1.goalCoverage', 'D1.acceptance',
  'D2.redlines', 'D2.authorization',
  'D3.correctness', 'D3.instruction', 'D3.robustness', 'D3.maintainability', 'D3.safeCoding',
  'D5.proficiency',
  'D6.classification',
]);

/**
 * 本轮子项清单（自适应评分配置）：以注册表为准——未列出的不评；
 * GUIDE 没说明的子项（profile 维度内自定义项 / D7 用户维度）按此处的说明与档位评。
 */
export function dynamicItemsSection(items: ScoreItemSchema[]): string {
  if (items.length === 0) return '';
  const lines = items.map(it => {
    if (GUIDE_COVERED_ITEMS.has(it.id)) return `- ${it.id}（${it.name}）：按 GUIDE 该子项的说明评`;
    const bands = (it.bands ?? []).map(b => `${b.range} ${b.label}：${b.description}`).join('；');
    return `- ${it.id}（${it.name}）${it.note ? `：${it.note}` : ''}${bands
      ? `\n  score 给 0-1（档位分值 0-10，score = 档位值/10，如 8 → 0.8）：${bands}`
      : '\n  两档判定（是非题）：达成给 score 1，未达成给 0；判不了给 verdict:"na" + note 说缺什么'}`;
  });
  return `\n\n—— 本轮子项清单（以此为准）——\n只评下面列出的子项；GUIDE 提到但本清单没有的不评、不输出。GUIDE 未说明的子项按本清单附带的说明与档位评：\n${lines.join('\n')}`;
}

/** 维度显示名：内置用 DIM_NAMES，D7 用户维度用注册表里的名称 */
export function dimensionLabel(defs: DimensionDefinition[] | undefined, dimensionId: string): string {
  return DIM_NAMES[dimensionId] ?? defs?.find(d => d.id === dimensionId)?.name ?? dimensionId;
}

const KNOWN_TOOLS: MateAgentTool[] = ['claude', 'opencode'];

/** 探测结果进程级缓存：GET 探测每次开评分卡都会来，spawnSync 阻塞事件循环——探测一次够用（装新 CLI 重启生效） */
let mateToolsCache: MateAgentTool[] | null = null;

/** 探测本机可用的 mate agent CLI（command -v），供页面选择器列出 */
export function detectMateAgentTools(): MateAgentTool[] {
  if (mateToolsCache) return mateToolsCache;
  const found: MateAgentTool[] = [];
  for (const t of KNOWN_TOOLS) {
    const cp = spawnSync('sh', ['-c', `command -v ${t}`], { env: { ...process.env, NO_COLOR: '1' }, shell: false });
    if (cp.status === 0 && cp.stdout.toString().trim()) found.push(t);
  }
  mateToolsCache = found;
  return found;
}

export interface MateAgentRunOptions {
  tool: MateAgentTool;
  framework?: string;
  rootDir?: string;
  timeoutMs?: number;
  /** 注册表定义（profile + D7 用户维度）——传入则维度与子项清单自适应评分配置 */
  defs?: DimensionDefinition[];
}

/** mate 失败留痕目录（默认用户数据目录；测试可用 MATE_AGENT_LOG_DIR 覆写） */
export const mateFailureLogDir = (): string =>
  process.env.MATE_AGENT_LOG_DIR ?? path.join(CONTEXT_HOME, 'mate-agent-logs');

/** 解析失败时把原始输出/ stderr /退出码落盘——失败提示只有一句，agent 到底回了什么必须可回查 */
export async function writeMateFailureLog(
  taskId: string,
  scope: string,
  out: { raw: string; stderr: string; exitCode: number | null; durationMs: number; parseError: string | null },
): Promise<string | null> {
  if (!out.parseError) return null;
  const dir = path.join(mateFailureLogDir(), safeId(taskId));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeId(scope)}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const body = [
    `taskId: ${taskId}`,
    `scope: ${scope}`,
    `parseError: ${out.parseError}`,
    `exitCode: ${out.exitCode}`,
    `durationMs: ${out.durationMs}`,
    '── raw（截断 64K）──',
    out.raw.slice(0, 65536),
    '── stderr（截断 4K）──',
    out.stderr.slice(0, 4096),
  ].join('\n');
  await fs.writeFile(file, body, 'utf-8');
  return file;
}

/** 单维运行结果（Mode A）：agent 只评一维，产出该维 items */
export interface DimensionRunResult {
  dimensionId: string;
  items: MateAgentItem[] | null;
  parseError: string | null;
  durationMs: number;
}

const GUIDE_ASSET_PATH = fileURLToPath(new URL('./GUIDE.md', import.meta.url));
// 兜底：new URL('./GUIDE.md') 在 Next 生产构建里被改写到 .next/server/assets/
// GUIDE.<hash>.md——安装包不带 .next（现场首启构建），构建中断/损坏时该
// asset 缺失会让 Mate 评审五维全挂 ENOENT。src/ 随包发布，回落源文件
// （同一份内容）。
const GUIDE_SRC_PATH = path.join(process.cwd(), 'src', 'lib', 'scoring', 'mate-agent', 'GUIDE.md');

export async function readGuideFile(primary: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(primary, 'utf-8');
  } catch (e) {
    // 留痕：构建产物损坏是行动信号（ctxi -f 重建），静默回落会让现场一直带病跑
    logWarn('scoring/mate-agent', 'GUIDE 构建产物缺失，回落随包源文件（建议 ctxi -f 重建）', {
      primary, error: e instanceof Error ? e.message : String(e),
    });
    return fs.readFile(fallback, 'utf-8');
  }
}

export async function readGuide(): Promise<string> {
  return readGuideFile(GUIDE_ASSET_PATH, GUIDE_SRC_PATH);
}

async function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, exitCode: null });
    });
  });
}

export function extractJson(text: string): unknown | null {
  let s = text.trim();
  const f = s.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (f) s = f[1].trim();
  const end = s.lastIndexOf('}');
  if (end < 0) return null;
  // 候选起点从后往前试：正文先给示例 JSON 再给最终 JSON 时，第一个 { 会把中间散文切进来。
  // start=0 时 lastIndexOf(…, -1) 会钳回 0 永远命中 s[0]，必须显式终止——否则
  // 一个尾随 } 的畸形输出把 Node 事件循环同步冻死。
  let start = s.lastIndexOf('{', end);
  while (start >= 0 && start < end) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      const prev = start;
      start = s.lastIndexOf('{', start - 1);
      if (start === prev) break;
    }
  }
  return null;
}

/** opencode --format json 输出的是 NDJSON 事件流，取最后的 assistant text 拼成正文 */
export function extractOpencodeText(ndjson: string): string {
  const texts: string[] = [];
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } };
      if (ev.type === 'text' && ev.part?.type === 'text' && typeof ev.part.text === 'string') {
        texts.push(ev.part.text);
      }
    } catch {
      // 忽略非 JSON 行
    }
  }
  return texts.join('\n');
}

const NO_FILE_ROUNDTRIP = '直接把最终 JSON 写在回复正文里——不要用 bash/Write 把结果写进文件再 read 读回（环境会拒绝跨目录 read，导致回复为空、评分失败）。';

/** 读材料策略：turns.jsonl 倒着读——最后一个 turn 通常就是最终结论/交付状态 */
const READ_REVERSE = '读 turns.jsonl 时**倒着读**：先看最后几条（turnIndex 最大的）——最后一个 turn 通常就是最终结论/交付状态（干完了什么、是否完成），先掌握它，再按需往回查具体步骤和证据；subagent 的逐轮细节在 bridges.jsonl 里，按需看，不要试图从头扫 turns.jsonl。';

/** 单维模式（Mode A）：只评 D{n}，覆盖 GUIDE 里「六维全出」的输出约定；dimsExtra = 本轮子项清单（自适应评分配置） */
function buildDimensionPrompt(guide: string, dimensionId: string, dimName: string, materialDir: string, dimsExtra: string): string {
  return `${guide}

—— 以下是你的实际任务 ——
本轮你**只评审 ${dimensionId}（${dimName}）这一个维度**，其余维度一律不评、不输出。
该维原始数据已按需切好放在目录：${materialDir}（只含 ${dimensionId} 需要的 turn/toolcall/session 元信息）。
请用 Read / Grep / Glob 读这些文件，独立评审 ${dimensionId} 的各个子项。${READ_REVERSE}${dimsExtra}

${NO_FILE_ROUNDTRIP}最终只输出一个 JSON 对象（不要代码块围栏、不要多余文字）：
{"dimensionId":"${dimensionId}","items":[{...}]}
items 按本轮子项清单（或 GUIDE 里 ${dimensionId} 一节）列出的子项逐条给（itemId + verdict/score/value + note + evidence）。`;
}

/** 保底重试（最多两次）的追加指令：强化「正文以单独 JSON 结尾」，附上次输出结尾——结论若已得出直接重出 JSON，不重做分析 */
export function retryInstruction(prevRaw: string): string {
  const tail = prevRaw.trim() ? `\n\n上一次回复的结尾（结论若已得出，直接按它重出 JSON，不必重做分析）：\n${prevRaw.trim().slice(-4096)}` : '';
  return `\n\n—— 本次是重试：上一次运行的回复无法解析出 JSON 对象。完成评审后，回复正文必须以一个单独的 JSON 对象结尾——不要代码块围栏、不要在 JSON 前后加任何文字。${tail}`;
}

interface RunOutcome {
  /** 原始 stdout（claude=正文文本 / opencode=NDJSON 事件流）——落失败日志用 */
  raw: string;
  /** 提取出的 assistant 正文（解析对象用）——重试指令引用它而不是 raw */
  text: string;
  parsed: unknown | null;
  parseError: string | null;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
}

/** 起一个 agent 进程，回统一结果；工具参数差异封装在此 */
async function runAgent(cmd: string, args: string[], cwd: string, tool: MateAgentTool, timeoutMs: number): Promise<RunOutcome> {
  const t0 = Date.now();
  const { stdout, stderr, exitCode } = await runCommand(cmd, args, cwd, timeoutMs);
  const content = tool === 'opencode' ? extractOpencodeText(stdout) : stdout;
  const parsed = extractJson(content);
  return {
    raw: stdout,
    text: content,
    parsed,
    parseError: parsed == null ? '输出里没有可直接解析的 JSON 对象' : null,
    durationMs: Date.now() - t0,
    exitCode,
    stderr: stderr.slice(0, 2000),
  };
}

function spawnArgs(tool: MateAgentTool, prompt: string, dir: string): { cmd: string; args: string[]; cwd: string } {
  if (tool === 'claude') {
    return { cmd: 'claude', args: ['-p', prompt, '--output-format', 'text', '--allowedTools', 'Read,Grep,Glob,Task', '--max-turns', '60'], cwd: dir };
  }
  return { cmd: 'opencode', args: ['run', '--auto', '--format', 'json', '--dir', dir, prompt], cwd: dir };
}

/** Mode A：单维运行（用切片物料 + 单维 prompt）。输出不合格（解析不出 JSON 或 items 缺失）自动重评一次（最多两次） */
export async function runMateAgentDimension(
  taskId: string,
  prisma: PrismaClient,
  dimensionId: string,
  opts: MateAgentRunOptions,
  items: ScoreItemSchema[] = [],
): Promise<DimensionRunResult> {
  const { dir } = await exportMaterial(taskId, prisma, opts.framework, { rootDir: opts.rootDir, dimension: dimensionId });
  try {
  const guide = await readGuide();
  const timeoutMs = opts.timeoutMs ?? 900000;
  const basePrompt = () => buildDimensionPrompt(guide, dimensionId, dimensionLabel(opts.defs, dimensionId), dir, dynamicItemsSection(items));
  const attempt = (suffix: string) => {
    const { cmd, args, cwd } = spawnArgs(opts.tool, basePrompt() + suffix, dir);
    return runAgent(cmd, args, cwd, opts.tool, timeoutMs);
  };
  const hasItems = (o: RunOutcome) =>
    o.parsed != null && typeof o.parsed === 'object' && Array.isArray((o.parsed as { items?: unknown }).items);

  const first = await attempt('');
  let out = first;
  let durationMs = first.durationMs;
  if (!hasItems(out)) {
    const again = await attempt(retryInstruction(out.text || out.raw));
    durationMs += again.durationMs;
    // 重试成功则采用；仍失败则合并两次输出留痕（两次都看得到）
    out = hasItems(again)
      ? again
      : { ...again, raw: `${first.raw}\n\n─── 重试输出 ───\n${again.raw}`, text: `${first.text}\n\n─── 重试输出 ───\n${again.text}`, stderr: `${first.stderr}\n${again.stderr}`.slice(0, 4000) };
  }

  const parsedItems = out.parsed != null && typeof out.parsed === 'object'
    ? (out.parsed as { items?: unknown }).items
    : null;
  let parseError = out.parseError ?? (Array.isArray(parsedItems) ? null : '子项 items 缺失或非数组');
  if (parseError) {
    const log = await writeMateFailureLog(taskId, dimensionId, { ...out, parseError, durationMs });
    if (log) parseError = `${parseError}（重试后仍失败，原始输出见 ${log}）`;
  }
  return {
    dimensionId,
    items: Array.isArray(parsedItems) ? (parsedItems as MateAgentItem[]) : null,
    parseError,
    durationMs,
  };
  } finally {
    // 物料是临时切片（含代码/红线原文），跑完即清——不留 /tmp、不泄漏给同机其他用户
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
