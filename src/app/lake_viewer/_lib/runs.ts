// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 运行聚合层：数据湖镜像（清单/范式/meta）× insight 本地库（指标/评分卡）→
// 范式视图与运行清单。混合口径：清单来自镜像，指标优先本地库，未导入运行
// 指标列空、开始时间退化为数据仓最后触碰 commit 时间（近似）。
// 过程内 TTL 缓存（镜像列表 60s / 本地会话 30s / 评分卡 300s）。
import { getActiveDurationMs, getScorecard, listInsightSessions, mapBounded, type InsightScorecard, type InsightSession } from './insight-data';
import { readRecords, type SessionLoc } from '@/lib/lake/notes';
import { readLakeSessions, readParadigmDirs, revParseMain, ensureMirrorAsync, sessionFolderOf } from '@/lib/lake/mirror';
import { defaultLakeRemote } from '@/lib/lake/remote';
import { parseSubmitInfo } from '@/lib/lake/notes';
import type { LakeSession } from '@/lib/lake/mirror';
import { normalizeScore } from './format';
import { agentFrameworkOf } from '@/lib/shared/session-format';

export interface ParadigmSummary {
  name: string;
  runCount: number;
  hasBaseline: boolean;
  latestTime: string;
}

export interface RunItem {
  sid: string;
  paradigm: string;
  isBaseline: boolean;
  /** 记录类：capture（裸目录）/ native（<sid>.native/ 原生会话位）——导入与记录按类定位 */
  recording: 'capture' | 'native';
  framework: string | null;
  ccVersion: string | null;
  workflow: string | null;
  producer: string | null;
  /** 上传时填写的「内容描述」，取自该会话原始上传 commit 的 subject */
  description: string | null;
  /** 上传时填写的「提交人」，同 description 来源 */
  author: string | null;
  opGen: 'success' | 'failure' | null;
  startTime: string | null;
  startTimeApprox: boolean;
  /** 活跃时长（事件聚类口径）：已导入现算，未导入取 meta activeMs 快照；不可算时回落 wallMs */
  durationMs: number | null;
  /** durationMs 是否为真实活跃值：false = 活跃不可得（回落墙钟，渲染 — / wall） */
  activeKnown: boolean;
  /** 墙钟（endTime − startTime）：已导入取 DB，未导入取 meta durationMs 快照 */
  wallMs: number | null;
  totalTokens: number | null;
  /** 会话主模型：已导入取 DB Session.model，未导入取 meta 快照 */
  model: string | null;
  imported: boolean;
  totalScore: number | null;
  /** 质量分来源：local = 本机评分卡；lake-note = 仓内评审记录快照（本机未导入，重算无从谈起）；null = 无分 */
  scoreSource: 'local' | 'lake-note' | null;
  dimensions: Array<{ dimensionId: string; name: string; score: number | null }>;
  baselineDelta: number | null;
  insightUrl: string;
  /** 消歧后 insight DB 行的真实 framework（-proxy 形态）——评分卡/活跃时长取数用；
   * lake meta 命名归一后是裸 agent 名，与 native 行同名，直取会错行 */
  insightFramework: string | null;
}

export interface RunQuery {
  paradigm: string;
  framework?: string[];
  ccVersion?: string[];
  opGen?: 'success' | 'failure';
  scored?: boolean;
  imported?: boolean;
  q?: string;
  from?: string;
  to?: string;
  /** 日期边界时区偏移（±HH:MM，客户端浏览器偏移）：from/to 裸日期按此解释 */
  tz?: string;
}

export interface RunsResult {
  paradigm: string;
  total: number;
  baselineSid: string | null;
  /** 本地库可读（进程内直查，false 仅代表 DB 故障降级） */
  insightReachable: boolean;
  facets: { frameworks: string[]; ccVersions: string[] };
  items: RunItem[];
}

// 站内相对路径：viewer 已并入 insight，会话详情页同源同窗口可达（返回键回到
// viewer，URL 记住范式与筛选状态）
export function insightSessionUrl(sid: string, framework: string | null): string {
  const fw = framework ? `?framework=${encodeURIComponent(framework)}` : '';
  return `/session/${encodeURIComponent(sid)}${fw}`;
}

// ── TTL 缓存 ───────────────────────────────────────────────────────────

interface CacheEntry<T> { at: number; value: T }

const LAKE_TTL_MS = 60_000;
const INSIGHT_TTL_MS = 30_000;
const SCORECARD_TTL_MS = 300_000;

let lakeCacheAt = 0;
let lakeCachePromise: Promise<LakeListing> | null = null;
let lakeInflight: Promise<LakeListing> | null = null;
let insightCache: CacheEntry<Map<string, InsightSession[]> | null> | null = null;
const scorecardCache = new Map<string, CacheEntry<InsightScorecard | null>>();

interface LakeListing {
  sessions: LakeSession[];
  paradigms: ParadigmSummary[];
  baselineByParadigm: Map<string, string>;
  head: string | null;
}

async function buildLakeListing(): Promise<LakeListing> {
  const remote = defaultLakeRemote();
  const dir = await ensureMirrorAsync(remote);
  const head = revParseMain(dir, remote);
  const sessions = head ? await readLakeSessions(dir, remote) : [];
  // 根级会话目录（缺省上传位 <sid>/，paradigm=''）不是范式——从侧栏目录
  // 清单剔除（否则每个根级会话都会以 sid 名义混进范式注册表）。目录名推导
  // 走 sessionFolderOf（CLAUDE.md 红线：不得手拼 .native 后缀）
  const rootFolders = new Set(sessions.filter(s => !s.paradigm).map(s => sessionFolderOf(s.sid, s.recording)));
  const dirs = new Set(readParadigmDirs(dir, remote).filter(d => !rootFolders.has(d)));
  const byParadigm = new Map<string, ParadigmSummary>();
  const baselineByParadigm = new Map<string, string>();
  for (const s of sessions) {
    if (!s.paradigm || !dirs.has(s.paradigm)) continue;
    if (s.isBaseline) {
      if (!baselineByParadigm.has(s.paradigm)) baselineByParadigm.set(s.paradigm, s.sid);
      continue;
    }
    let p = byParadigm.get(s.paradigm);
    if (!p) {
      p = { name: s.paradigm, runCount: 0, hasBaseline: false, latestTime: '' };
      byParadigm.set(s.paradigm, p);
    }
    p.runCount += 1;
    if (s.commitTime > p.latestTime) p.latestTime = s.commitTime;
  }
  for (const [name, p] of byParadigm) {
    p.hasBaseline = baselineByParadigm.has(name);
  }
  const paradigms = [...byParadigm.values()].sort((a, b) => b.runCount - a.runCount || a.name.localeCompare(b.name));
  // 空范式目录（有目录无会话）也出现在侧栏：目录即注册表；只含 baseline 的
  // 范式走不到 byParadigm 建条目，hasBaseline 从 baselineByParadigm 取真值
  for (const dir of dirs) {
    if (!byParadigm.has(dir)) paradigms.push({ name: dir, runCount: 0, hasBaseline: baselineByParadigm.has(dir), latestTime: '' });
  }
  return { sessions, paradigms, baselineByParadigm, head };
}

export function getLakeListing(): Promise<LakeListing> {
  if (lakeCachePromise && Date.now() - lakeCacheAt <= LAKE_TTL_MS) return lakeCachePromise;
  if (!lakeInflight) {
    lakeInflight = buildLakeListing()
      .then(value => {
        lakeCachePromise = Promise.resolve(value);
        lakeCacheAt = Date.now();
        return value;
      })
      .finally(() => { lakeInflight = null; });
  }
  return lakeInflight;
}

export function invalidateCaches(): void {
  lakeCacheAt = 0;
  lakeCachePromise = null;
  insightCache = null;
  scorecardCache.clear();
  lakeNoteScoreCache.clear();
  activeCache.clear();
}

async function getInsightSessions(): Promise<Map<string, InsightSession[]> | null> {
  const now = Date.now();
  if (!insightCache || now - insightCache.at > INSIGHT_TTL_MS) {
    const value = await listInsightSessions();
    if (value == null) return null; // 失败不缓存，下次请求立即重试
    insightCache = { at: now, value };
  }
  return insightCache.value;
}

// 同 sid 双记录在 DB 是两行（capture = <agent>-proxy / native = 真实框架）。lake
// 命名归一后 meta framework 是裸 agent 名（与 native 行同名），exact 命中会错配到
// 另一记录——recording 优先消歧：capture → -proxy 行、native → 非 -proxy 行；
// 其余按 framework 精确匹配。回落仅限「确实同一记录」：仅一行且基座框架一致
// （agentFrameworkOf 剥 -proxy）或行 framework 缺失才命中；两行无法消歧 / 另一
// 记录的单行一律 null（按未导入处理——重导幂等，且避免借显他行指标与「查无
// 会话」的直达 URL）。
function matchInsightRow(
  index: Map<string, InsightSession[]> | null,
  sid: string,
  framework: string | null,
  recording?: 'capture' | 'native',
): InsightSession | null {
  if (!index) return null;
  const rows = index.get(sid);
  if (!rows || rows.length === 0) return null;
  if (recording === 'capture' || recording === 'native') {
    const wantProxy = recording === 'capture';
    const byRecording = rows.find(r =>
      (r.framework?.endsWith('-proxy') ?? false) === wantProxy
      && (!framework || agentFrameworkOf(r.framework ?? '') === agentFrameworkOf(framework)));
    if (byRecording) return byRecording;
  }
  if (framework) {
    const hit = rows.find(r => r.framework === framework);
    if (hit) return hit;
    const only = rows.length === 1 ? rows[0] : null;
    if (only && (only.framework == null || agentFrameworkOf(only.framework) === agentFrameworkOf(framework))) return only;
    return null;
  }
  // lake meta 无 framework（存量裸目录形态）：单行沿用旧 sid 命中语义
  return rows.length === 1 ? rows[0]! : null;
}

async function fetchScorecard(taskId: string, framework?: string | null): Promise<InsightScorecard | null> {
  // 缓存键带 framework：同 sid 双记录两行的卡各自缓存互不覆盖
  const cacheKey = framework ? `${taskId}@${framework}` : taskId;
  const now = Date.now();
  const hit = scorecardCache.get(cacheKey);
  if (hit && now - hit.at < SCORECARD_TTL_MS) return hit.value;
  let value: InsightScorecard | null;
  try {
    value = await getScorecard(taskId, framework);
  } catch {
    return null; // 查询失败不缓存（TTL 内下次请求立即重试），本次降级为未评分
  }
  scorecardCache.set(cacheKey, { at: now, value });
  return value;
}

// 仓内评审记录快照缓存（未导入行的质量分回落源）：<sid>@<recording> 键控，
// 与 scorecardCache 同 TTL；瞬态读取失败不缓存（本次降级为无分）
const lakeNoteScoreCache = new Map<string, CacheEntry<{ totalScore: number | null; dimensions: InsightScorecard['dimensions'] } | null>>();

async function fetchLakeNoteScore(loc: SessionLoc): Promise<{ totalScore: number | null; dimensions: InsightScorecard['dimensions'] } | null> {
  const key = `${loc.sid}@${loc.recording ?? 'capture'}`;
  const hit = lakeNoteScoreCache.get(key);
  if (hit && Date.now() - hit.at < SCORECARD_TTL_MS) return hit.value;
  try {
    // notes 只追加：末条 scorecard 即最新一次评审结论
    const records = await readRecords(loc);
    const last = [...records].reverse().find(r => r.type === 'scorecard');
    const value = last
      ? { totalScore: last.totalScore, dimensions: last.dimensions.map(d => ({ dimensionId: d.dimensionId, name: d.name, score: d.score })) }
      : null;
    lakeNoteScoreCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;   // 读取失败不缓存，本次降级为无分
  }
}

// 活跃时长缓存（与会话详情 Wall Clock 拆分同口径）：lean turn 查询 +
// 聚类，清单每次请求最多 MAX_ITEMS 条已导入行——TTL 内复用
const activeCache = new Map<string, CacheEntry<number | null>>();

async function fetchActiveDurationMs(taskId: string, framework: string | null): Promise<number | null> {
  const cacheKey = framework ? `${taskId}@${framework}` : taskId;
  const now = Date.now();
  const hit = activeCache.get(cacheKey);
  if (hit && now - hit.at < SCORECARD_TTL_MS) return hit.value;
  let value: number | null;
  try {
    value = await getActiveDurationMs(taskId, framework);
  } catch {
    return null; // 查询失败不缓存，本次回落墙钟
  }
  activeCache.set(cacheKey, { at: now, value });
  return value;
}

// ── 范式视图 ───────────────────────────────────────────────────────────

export async function listParadigms(): Promise<ParadigmSummary[]> {
  return (await getLakeListing()).paradigms;
}

// ── 运行清单 ───────────────────────────────────────────────────────────

const SCORE_FETCH_LIMIT = 8;
const MAX_ITEMS = 200;

// 开始时间排序键：startTime 混两种口径（本地库 UTC '.000Z' / meta 快照与 git
// %aI 的 '+08:00'），字符串比较会把同日 '+08' 晨间行排在 'Z' 午后行前面——
// 一律 epoch 数值比较（无法解析按最旧 0）
const startTimeKey = (s: string | null): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const byStartTimeDesc = (a: RunItem, b: RunItem): number => startTimeKey(b.startTime) - startTimeKey(a.startTime);

export async function listRuns(query: RunQuery): Promise<RunsResult> {
  const lake = await getLakeListing();
  const insightSessions = await getInsightSessions();
  const remoteSessions = lake.sessions.filter(s => s.paradigm === query.paradigm);

  const baselineSid = lake.baselineByParadigm.get(query.paradigm) ?? null;
  let baselineScore: number | null = null;
  if (baselineSid) {
    // 双记录消歧：baseline sid 的 capture/native 两行都可能在库，裸 taskId
    // 取卡是任意的——按 baseline lake 行的 framework 缩到本记录的行
    const baselineSess = lake.sessions.find(s => s.sid === baselineSid && s.isBaseline);
    const card = insightSessions
      ? await fetchScorecard(baselineSid, baselineSess?.framework ?? null)
      : null;
    if (card) {
      baselineScore = normalizeScore(card.totalScore ?? null);
    } else {
      // 本机无卡（未导入/未评）→ 仓内评审记录快照兜底：评分发生过就该可比
      const note = await fetchLakeNoteScore({
        sid: baselineSid, paradigm: query.paradigm, isBaseline: true,
        recording: baselineSess?.recording ?? 'capture',
      });
      baselineScore = normalizeScore(note?.totalScore ?? null);
    }
  }

  let rows: RunItem[] = [];
  for (const s of remoteSessions) {
    const insight = matchInsightRow(insightSessions, s.sid, s.framework, s.recording);
    if (insight) {
      const start = insight.startTime ? new Date(insight.startTime).getTime() : NaN;
      const end = insight.endTime ? new Date(insight.endTime).getTime() : NaN;
      rows.push({
        sid: s.sid,
        paradigm: s.paradigm as string,
        isBaseline: s.isBaseline,
        recording: s.recording,
        framework: s.framework,
        ccVersion: s.ccVersion,
        workflow: s.workflow,
        producer: s.producer,
        description: parseSubmitInfo(s.commitSubject).description,
        author: parseSubmitInfo(s.commitSubject).author,
        opGen: s.opGen,
        startTime: insight.startTime ?? (s.commitTime || null),
        startTimeApprox: !insight.startTime,
        durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
        activeKnown: false,
        wallMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
        totalTokens: insight.totalTokens,
        model: insight.model,
        imported: true,
        totalScore: null,
        scoreSource: null,
        dimensions: [],
        baselineDelta: null,
        // 深链用 insight 行的真实框架（lake meta 的 agent 名与 DB 行的 -proxy 形态
        // 可能不同——用 meta 名会被详情页 framework 过滤挡成 404）
        insightUrl: insightSessionUrl(s.sid, insight.framework ?? s.framework),
        insightFramework: insight.framework ?? null,
      });
    } else {
      rows.push({
        sid: s.sid,
        paradigm: s.paradigm as string,
        isBaseline: s.isBaseline,
        recording: s.recording,
        framework: s.framework,
        ccVersion: s.ccVersion,
        workflow: s.workflow,
        producer: s.producer,
        description: parseSubmitInfo(s.commitSubject).description,
        author: parseSubmitInfo(s.commitSubject).author,
        opGen: s.opGen,
        // 未导入行：优先用上传时刻写进 meta 的指标快照（精确）；存量旧 meta
        // 无快照时退化为 commit 时间（≈近似），耗时/Token 为空。耗时优先
        // activeMs 快照（活跃口径），旧 meta 回落墙钟 durationMs
        startTime: s.startTime ?? (s.commitTime || null),
        startTimeApprox: s.startTime == null,
        durationMs: s.activeMs ?? s.durationMs,
        activeKnown: s.activeMs != null,
        wallMs: s.durationMs,
        totalTokens: s.totalTokens,
        model: s.model,
        imported: false,
        totalScore: null,
        scoreSource: null,
        dimensions: [],
        baselineDelta: null,
        insightUrl: insightSessionUrl(s.sid, s.framework),
        insightFramework: null,
      });
    }
  }

  // 评分卡 + 活跃时长：仅对排序后前 MAX_ITEMS 条已导入运行拉取（有界并发）。
  // 耗时列统一活跃时长口径：已导入行按 turns 聚类现算（无 turns 回落墙钟），
  // 未导入行用上传时刻写进 meta 的 activeMs 快照（旧 meta 无此字段回落墙钟
  // durationMs）——算子生成耗时优化图同源切换
  rows.sort(byStartTimeDesc);
  const scoreTargets = rows.filter(r => r.imported).slice(0, MAX_ITEMS);
  await mapBounded(scoreTargets, SCORE_FETCH_LIMIT, async (r) => {
    // 取数用消歧后的 DB 行 framework（meta 裸名会错配同 sid 另一记录的卡/时长）
    const fw = r.insightFramework ?? r.framework;
    const card = await fetchScorecard(r.sid, fw);
    r.totalScore = normalizeScore(card?.totalScore ?? null);
    r.scoreSource = r.totalScore != null ? 'local' : null;
    r.dimensions = card?.dimensions.map(d => ({ ...d, score: d.score == null ? null : normalizeScore(d.score) })) ?? [];
    r.baselineDelta = r.totalScore != null && baselineScore != null
      ? Math.round((r.totalScore - baselineScore) * 10) / 10
      : null;
    const activeMs = await fetchActiveDurationMs(r.sid, fw);
    if (activeMs != null) {
      r.durationMs = activeMs;
      r.activeKnown = true;
    }
    return null;
  });

  // 质量分回落（未导入行）：仓内评审记录快照——评分发生过（记录已推仓）就该
  // 显示，不要求每台机器先导入一遍重算。仅前 MAX_ITEMS 条（与本地 pass 同界），
  // 有界并发读 notes（readRecords 走鉴权 git show）
  const noteTargets = rows.filter(r => !r.imported).slice(0, MAX_ITEMS);
  await mapBounded(noteTargets, SCORE_FETCH_LIMIT, async (r) => {
    const note = await fetchLakeNoteScore({ sid: r.sid, paradigm: r.paradigm, isBaseline: r.isBaseline, recording: r.recording });
    if (!note) return null;
    r.totalScore = normalizeScore(note.totalScore);
    // 记录存在但 totalScore 为 null：按无分处理，不挂「仓」角标显示 "—"
    r.scoreSource = r.totalScore != null ? 'lake-note' : null;
    r.dimensions = note.dimensions.map(d => ({ ...d, score: d.score == null ? null : normalizeScore(d.score) }));
    r.baselineDelta = r.totalScore != null && baselineScore != null
      ? Math.round((r.totalScore - baselineScore) * 10) / 10
      : null;
    return null;
  });

  // facet 选项取过滤前的全集（筛选器数据源，避免"选了 A 就看不到 B 选项"）
  const facets = {
    frameworks: [...new Set(rows.map(r => r.framework).filter((f): f is string => !!f))].sort(),
    ccVersions: [...new Set(rows.map(r => r.ccVersion).filter((v): v is string => !!v))].sort(),
  };

  if (query.framework?.length) rows = rows.filter(r => r.framework != null && query.framework!.includes(r.framework));
  if (query.ccVersion?.length) rows = rows.filter(r => r.ccVersion != null && query.ccVersion!.includes(r.ccVersion));
  if (query.opGen) rows = rows.filter(r => r.opGen === query.opGen);
  if (query.scored !== undefined) rows = rows.filter(r => (r.totalScore != null) === query.scored);
  if (query.imported !== undefined) rows = rows.filter(r => r.imported === query.imported);
  if (query.q) {
    const q = query.q.toLowerCase();
    rows = rows.filter(r => r.sid.toLowerCase().includes(q));
  }
  // 日期筛选按 epoch 比较：startTime 混两种口径（本地库 UTC 'Z' / git %aI
  // '+08:00'），字符串比较会把东八区 00:00–08:00 的运行归错天。日期边界带
  // 请求方时区（tz=±HH:MM）：裸日期按服务器本地时区解析，UTC 服务器上 +08
  // 用户的「当天」会平移 8 小时。设了任一边界即要求已知开始时间（无时间的
  // 行不参与日期筛选）。
  if (query.from || query.to) {
    const tz = /^[+-]\d{2}:\d{2}$/.test(query.tz ?? '') ? query.tz : '';
    const parseBound = (day: string, time: string): number => {
      const t = Date.parse(`${day}T${time}${tz}`);
      return Number.isFinite(t) ? t : (time === '00:00:00' ? -Infinity : Infinity);
    };
    const fromMs = query.from ? parseBound(query.from, '00:00:00') : -Infinity;
    const toMs = query.to ? parseBound(query.to, '23:59:59') : Infinity;
    rows = rows.filter(r => {
      if (!r.startTime) return false;
      const t = Date.parse(r.startTime);
      return Number.isFinite(t) && t >= fromMs && t <= toMs;
    });
  }

  rows.sort(byStartTimeDesc);
  return {
    paradigm: query.paradigm,
    total: rows.length,
    baselineSid,
    insightReachable: insightSessions != null,
    facets,
    items: rows.slice(0, MAX_ITEMS),
  };
}
