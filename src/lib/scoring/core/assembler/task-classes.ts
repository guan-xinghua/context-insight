// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 任务类型词表（task-classes.json 外置）：域词表（算子仓库路径段/文件名/
// 扩展标签）从包根配置加载——cwd 解析、缓存，与 context-windows.json /
// swimlane-lanes.json 同款范式；配置缺失或损坏回落最小词表。类 id 'operator'
// 是存量数据契约（评分卡 taskType / 基线文件名 <taskType>.json），词表可配、
// id 不可改。

import fs from 'node:fs';
import path from 'node:path';

export interface TaskClassPatterns {
  declTagPattern: string;
  taskTextPattern: string;
  pathSegmentPattern: string;
  filePattern: string;
}

export interface TaskClassRegexes {
  declTag: RegExp;
  taskText: RegExp;
  pathSegment: RegExp;
  file: RegExp;
}

// 最小兜底：只保留类概念级通用词（算子/operator/kernel 与对应目录段）——
// 部署环境可在 task-classes.json 里按需增删域词
const MINIMAL_OPERATOR_PATTERNS: TaskClassPatterns = {
  declTagPattern: '算子|operator|kernel',
  taskTextPattern: '算子|operator|kernel',
  pathSegmentPattern: '(^|/)(ops?|operator|operators|kernel)(/|$)',
  filePattern: '(op_|_op\\b|operator|kernel).*\\.(cc|cpp|cu|h|hpp|py|json)$',
};

let cache: Map<string, TaskClassRegexes> | null = null;

function compile(p: TaskClassPatterns): TaskClassRegexes {
  return {
    declTag: new RegExp(p.declTagPattern, 'i'),
    taskText: new RegExp(p.taskTextPattern, 'i'),
    pathSegment: new RegExp(p.pathSegmentPattern, 'i'),
    file: new RegExp(p.filePattern, 'i'),
  };
}

function load(): Map<string, TaskClassRegexes> {
  if (cache) return cache;
  const m = new Map<string, TaskClassRegexes>();
  try {
    const configPath = path.join(process.cwd(), 'task-classes.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, TaskClassPatterns>;
      for (const [id, patterns] of Object.entries(raw)) {
        if (patterns && typeof patterns === 'object'
          && typeof patterns.declTagPattern === 'string' && typeof patterns.taskTextPattern === 'string'
          && typeof patterns.pathSegmentPattern === 'string' && typeof patterns.filePattern === 'string') {
          m.set(id, compile(patterns));
        }
      }
    }
  } catch { /* 配置损坏 → 最小词表 */ }
  if (!m.has('operator')) m.set('operator', compile(MINIMAL_OPERATOR_PATTERNS));
  cache = m;
  return m;
}

export function taskClassRegexes(id: string): TaskClassRegexes | undefined {
  return load().get(id);
}

export function resetTaskClassCache(): void {
  cache = null;
}
