// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 目录浏览共享形状与排序（/api/ingest/browse-directory 响应消费侧）：
// LocalFileImport（会话捕获文件）与 BundleImport（workflow-bundle 目录）同一
// 通路，此处单点维护，避免两个导入入口各自复制排序语义。

export interface DirEntry {
  name: string
  fullPath: string
  isDir: boolean
  size: number
  mtime?: number | null
  isImportableFile: boolean
  importableType: string | null
  /** run 域提示（增量字段）：目录内含 workflow.json/manifest.json（bundle） */
  isBundleDir?: boolean
}

/** 目录浏览排序：目录置顶（导航优先），组内按修改时间升/降序（默认降序=最新
 *  在前，方便按时间找会话捕获文件；asc=false 降序 / asc=true 升序）。mtime
 *  缺失（旧后端响应）按 0 兜底——降序排尾 / 升序排头（紧跟目录）。导出供
 *  IT 直接验证两个方向。 */
export function sortDirEntries(entries: DirEntry[], asc: boolean): DirEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const am = a.mtime ?? 0
    const bm = b.mtime ?? 0
    if (am === bm) return a.name.localeCompare(b.name)
    return asc ? am - bm : bm - am
  })
}
