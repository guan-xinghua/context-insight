// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput';
import { BAY_NAME } from '@/lib/branding';
import type { InsightClient } from '@/cli/client';

interface UploadPanelProps {
  client: InsightClient;
  taskId: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}

type Phase = 'paradigm' | 'submitter' | 'uploading';

// 数据仓上传面板：① 范式目录选择（数据仓顶层目录即注册表，↑↓ 移动 Enter
// 确认）→ ② 提交人输入（网关强制非空）→ ③ 上传。Esc 任意阶段取消。
// 修复旧版 ConfirmDialog 直传空 description 被提交人网关拒绝的缺陷。
export function UploadPanel({ client, taskId, onDone, onCancel }: UploadPanelProps) {
  const [phase, setPhase] = useState<Phase>('paradigm');
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [submitter, setSubmitter] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitterTouched, setSubmitterTouched] = useState(false);
  const [isBaseline, setIsBaseline] = useState(false);

  useEffect(() => {
    let alive = true;
    client.listRemoteDirs('')
      .then(r => {
        if (!alive) return;
        const candidates = (r.dirs ?? []).filter(d => d !== 'sessions');
        setDirs(candidates);
        if (candidates.length === 0) setLoadError('数据仓暂无范式目录（请先在数据仓顶层新建）');
      })
      .catch(() => {
        if (alive) setLoadError('范式目录列表加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [client]);

  async function doUpload(paradigm: string, who: string, baseline: boolean): Promise<void> {
    setPhase('uploading');
    setUploadError(null);
    try {
      const result = await client.uploadSession(
        taskId,
        `提交人: ${who}\n内容描述: ${taskId}`,
        paradigm,
        baseline || undefined,
      );
      onDone(`Uploaded ${taskId} → ${BAY_NAME} ${result.folder}${result.unchanged ? ' (unchanged)' : ''}`);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
      setPhase('submitter');
    }
  }

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (phase === 'paradigm' && !loading && dirs.length > 0) {
      if (key.upArrow) setCursor(c => Math.max(0, c - 1));
      else if (key.downArrow) setCursor(c => Math.min(dirs.length - 1, c + 1));
      else if (input === 'b') setIsBaseline(v => !v);
      else if (key.return) setPhase('submitter');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text bold>Upload session &quot;{taskId}&quot; to {BAY_NAME}</Text>
      <Box height={1} />
      {phase === 'paradigm' && (
        loading ? (
          <Text color="gray">加载范式目录中…</Text>
        ) : loadError ? (
          <Text color="red">{loadError}</Text>
        ) : (
          <Box flexDirection="column">
            <Text color="gray">选择范式目录（↑↓ 移动，b 切换 baseline，Enter 确认，Esc 取消）：</Text>
            <Box height={1} />
            {dirs.map((d, i) => (
              <Text key={d} color={i === cursor ? 'cyan' : undefined}>
                {i === cursor ? '❯ ' : '  '}{d}
              </Text>
            ))}
            <Box height={1} />
            <Text color={isBaseline ? 'magenta' : 'gray'}>
              [b] baseline：{isBaseline ? '开（设为该范式基准，原 baseline 移回普通目录）' : '关'}
            </Text>
          </Box>
        )
      )}
      {phase === 'submitter' && (
        <Box flexDirection="column">
          <Text color="gray">范式目录：{dirs[cursor]}{isBaseline ? '（baseline）' : ''} │ 输入提交人（必填，Enter 上传，Esc 取消）：</Text>
          <TextInput
            value={submitter}
            onChange={v => { setSubmitter(v); setSubmitterTouched(true); }}
            onSubmit={v => {
              if (v.trim()) void doUpload(dirs[cursor], v.trim(), isBaseline);
              else setSubmitterTouched(true);
            }}
            placeholder="真实姓名或账号"
          />
          {submitterTouched && !submitter.trim() && <Text color="red">提交人不能为空</Text>}
          {uploadError && <Text color="red">{uploadError}</Text>}
        </Box>
      )}
      {phase === 'uploading' && <Text color="green">上传中…</Text>}
    </Box>
  );
}
