// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分体系 v2 对外出口：API 层只 import 这里。
// 分层：design.md（评什么）→ architecture.md（七角色）→ detailed-design.md（接口）。

export type { DimensionDefinition, ScoreItemSchema, Band, DimensionRole, AggregationPolicy, ThreeStateRule } from './core/schema';
export type { AssembledInput, Measures, WireSummary, WorkflowDeclaration, RedactionEvent, LlmClient, ScoreToolCall, ScoreTurn } from './core/assembler/types';
export type { Scorecard, DimensionResult, SubItemResult, Evidence } from './core/types';
export { SCORECARD_SCHEMA } from './core/types';
export { runScorecard, SCORER_VERSION, type RunScorecardOptions } from './core/runner';
export { scorecardStore, FileScorecardStore, type ScorecardStore, type BaselineFilter } from './core/store';
export { loadRegistry, type Registry } from './registry';
export { BUILTIN_DIMENSIONS } from './definitions';
export { aggregateCard, aggregateDimension, deriveItemScores, itemEffScoreOf, isNaReviewGap, VETO_VERDICTS } from './core/aggregator';
export { isValidBaseline, positionScore, gradeOf, lookupMetric, displayBaselineValue, type BaselineFile, type BaselineMetric, type BaselineGrade } from './core/baseline/service';
export { loadSessionBaseline, writeSessionBaseline, ratioScore, ratioGrade, isValidSessionBaseline, sessionBaselinesDir, type SessionBaselineFile } from './core/baseline/session-baseline';
export { BASELINE_MEASURES } from './core/baseline/measures';
export { loadSessionBenchReport, writeSessionBenchReport, isValidSessionBenchReport, benchReportDir, benchToScore10, type SessionBenchReportFile } from './core/bench-report/session-bench-report';
export { loadUserGroups, loadUserDefinitions, saveUserGroup, deleteUserGroup, importUserGroups, isValidUserDimension, isValidUserGroup, userDimensionToDef, userDimensionScorers, type UserDimensionFile, type UserGroup, type UserGroupsBundle, type ImportSummary } from './user/loader';
export { SIGNALS, validateRuleSpec, compareVerdict, type RuleSpec } from './user/rule-scorer';
export { splitShell, hasFlag } from './core/shell-parser';
export { parseTestOutput, isVerifyCommand } from './core/test-parser';
export { TrackedLlmClient } from './core/llm';
export { profilesDir, sanitizeProfile, loadProfiles, saveProfile, deleteProfile, getActiveId, setActiveId, loadActiveProfile, activeApplyWarnings, type SanitizeResult } from './core/profile/store';
export { applyProfile, type AppliedProfile } from './core/profile/apply';
export { PRESETS, isPresetId, findPreset } from './core/profile/presets';
export { D1_LOCKED_ITEMS, EXCLUDE_DEGRADES } from './core/profile/types';
export type { ScoringProfile, CustomItemSpec, ProfileDimension } from './core/profile/types';
