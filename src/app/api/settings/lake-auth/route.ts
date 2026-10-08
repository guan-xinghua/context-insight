// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 设置页·数据之湖凭据管理 API（服务端存储取代浏览器 localStorage——cpx 与
// insight 同机共读同一份 lake-auth.json，上传/下载两侧统一凭据源）。
// 响应红线：任何分支都不得回传令牌明文（只回脱敏尾段）；错误消息过
// redactRemoteSecrets。写入面：PUT 保存（地址按 normalizeAuthKey 键控），
// DELETE 清除（缺省 = 当前地址；?all=1 全部）。
import { NextRequest, NextResponse } from 'next/server';
import { spawnSync } from 'node:child_process';
import {
  clearStoredCredentials, listStoredRemotes, maskToken, normalizeAuthKey,
  setStoredCredentials,
} from '@/lib/lake/auth';
import { FORBIDDEN_ADDRESS_CHARS } from '@/lib/lake/remote';
import { withRouteLog } from '@/lib/api-route';
import { logError, logInfo } from '@/lib/logger';

export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ remotes: listStoredRemotes() });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, username, token } = body as { url?: string; username?: string; token?: string };
    const remoteUrl = url?.trim();
    if (!remoteUrl) return NextResponse.json({ error: '缺少远端地址' }, { status: 400 });
    // 元字符前置校验（与 normalizeGitAddress 同款黑名单）：url 是请求体可控
    // 输入，命令替换/管道等元字符既不可作为凭据键、也绝不放进任何 git 调用
    if (FORBIDDEN_ADDRESS_CHARS.test(remoteUrl)) return NextResponse.json({ error: '数据湖地址含非法字符' }, { status: 400 });
    const u = username?.trim();
    const t = token?.trim();
    if (!u || !t) return NextResponse.json({ error: '用户名与推送凭据均不能为空' }, { status: 400 });
    // 连接探测（best-effort）：公开仓匿名可达即通过——令牌真实有效性由首次
    // 上传的 401 挑战-应答确认（错误分类会给重配指引）。探测失败仍保存：
    // 私有仓/网络瞬断不该丢用户刚输入的凭据
    let reachable = true;
    let probeMessage: string | null = null;
    const key = normalizeAuthKey(remoteUrl);
    // 探测零 shell（spawnSync 数组参，与 cpx cpx-auth probeRemote 同款）：
    // url 来自请求体，execSync 模板串拼接会被 $()/; 等元字符注入——new URL
    // 不百分号编码它们，本地路径还走 catch 原样透传，替换引号挡不住命令替换
    const probe = spawnSync('git', ['ls-remote', key, 'HEAD'], { encoding: 'utf8', stdio: 'pipe', timeout: 20_000 });
    if (probe.status !== 0) {
      reachable = false;
      probeMessage = (String(probe.stderr || probe.error?.message || `exit ${probe.status ?? 'null'}`).trim() || `exit ${probe.status ?? 'null'}`)
        .replace(/https:\/\/[^/\s"']+@/g, 'https://<creds>@').slice(0, 200);
    }
    const verifiedAt = reachable ? new Date().toISOString() : undefined;
    setStoredCredentials(remoteUrl, u, t, verifiedAt);
    logInfo('route:settings/lake-auth', '凭据已保存', { url: key, username: u, reachable });
    return NextResponse.json({
      ok: true,
      url: key,
      username: u,
      tokenMasked: maskToken(t),
      verifiedAt: verifiedAt ?? null,
      reachable,
      ...(probeMessage ? { probeMessage } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '保存失败';
    logError('route:settings/lake-auth', '凭据保存失败', { error: message.slice(0, 200) });
    return NextResponse.json({ error: message.replace(/https:\/\/[^/\s"']+@/g, 'https://<creds>@') }, { status: 500 });
  }
}

export const DELETE = withRouteLog('settings/lake-auth', async (request: NextRequest) => {
  const body = await request.json().catch(() => ({}));
  const { url, all } = body as { url?: string; all?: boolean };
  if (all === true) {
    const had = clearStoredCredentials(undefined);
    logInfo('route:settings/lake-auth', '全部凭据已清除', { all: true, had });
    return NextResponse.json({ ok: true, had });
  }
  const remoteUrl = url?.trim();
  if (!remoteUrl) return NextResponse.json({ error: '缺少远端地址（清除全部请传 all: true）' }, { status: 400 });
  const hadOne = clearStoredCredentials(remoteUrl);
  logInfo('route:settings/lake-auth', '凭据已清除', { url: remoteUrl, had: hadOne });
  return NextResponse.json({ ok: true, had: hadOne });
});
