// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

import { useEffect, useState } from 'react';
import { formatDuration } from '@/app/lake_viewer/_lib/format';

interface LakeStatus {
  phase: 'idle' | 'fetch' | 'clone' | 'list';
  detail: string;
  since: number;
  elapsedMs: number;
}

const PHASE_TEXT: Record<LakeStatus['phase'], string> = {
  idle: '连接数据湖…',
  fetch: '同步数据湖元数据…',
  clone: '首次克隆数据湖镜像（大仓需数分钟，完成后自动进入）…',
  list: '读取范式与会话清单…',
};

export function LakeProgressView() {
  const [status, setStatus] = useState<LakeStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/lake_viewer/api/lake-status');
        const data = await res.json() as LakeStatus;
        if (!cancelled) setStatus(data);
      } catch { /* 轮询失败保留上次状态 */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const phase = status?.phase ?? 'idle';
  const busy = phase !== 'idle';

  return (
    <div className="flex flex-col items-center gap-3">
      <span className={`inline-block h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700 ${busy ? '' : 'opacity-60'}`} />
      <p className="text-sm text-neutral-600">{PHASE_TEXT[phase]}</p>
      {status && busy && status.detail && (
        <p className="max-w-xl truncate font-mono text-xs text-neutral-400" title={status.detail}>
          {status.detail}
        </p>
      )}
      {status && busy && (
        <p className="text-xs text-neutral-400">已进行 {formatDuration(status.elapsedMs)}</p>
      )}
      {!busy && (
        <p className="text-xs text-neutral-400">正在连接数据湖…（首拉镜像可能需要数分钟）</p>
      )}
    </div>
  );
}
