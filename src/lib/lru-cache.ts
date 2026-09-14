// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// 进程内 LRU：Turn 详情等读侧热路径的结果缓存（API 路由每次点击重复整文件
// 解析 / O(前序全量) 重建，值确定性强）。容量 + 可选 TTL；键由调用方保证
// 含失效信号（如 path+mtime+size）。

interface Entry<V> { value: V; expiresAt: number | null }

export class LruCache<K, V> {
  private map = new Map<K, Entry<V>>();

  constructor(
    private capacity: number,
    private ttlMs: number | null = null,
  ) {}

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && Date.now() > e.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e); // 触碰移到最新
    return e.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.ttlMs ? Date.now() + this.ttlMs : null });
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
