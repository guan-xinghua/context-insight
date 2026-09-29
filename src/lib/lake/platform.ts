// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 托管平台行为适配（P3 平台化收口）：特定托管平台的差异行为唯一
// 居所——引擎其余部分零平台假设（GenericGitLake 语义）。三类适配：
//   ① host 归一：ai.gitcode.com 不提供 git http 服务（302 首页），归一为
//      gitcode.com——不改写则 clone 失败；共用镜像场景下还会因 origin 不匹
//      配被判"镜像不可用"触发破坏性重克隆
//   ② 错误码分诊：CH.00905401 = 凭据无效/密码式认证被拒（auth-failed），
//      CH.00905403 = 凭据有效但对仓无写权限（forbidden）——真机实测文本
//      两者都含 "Authentication failed"/"Access denied" 字样，必须按码精
//      确分诊（错误码是平台行为断言，保留真实值——改了分诊就坏）
//   ③ 令牌属主反查：gitcode 可经 api/v5/user 反查令牌真实属主（端点实测
//      存在，401 = token 无效），用于测试连接时明示令牌属于谁
// 其他平台（GitHub/Gitee/GitLab/自建）无对应行为 = 走引擎通用语义，无需
// 适配文件；新平台差异在此追加。

/** host 归一（URL 对象原地改写）：仅 ai.gitcode.com → gitcode.com */
export function normalizeHost(u: URL): void {
  if (u.host === 'ai.gitcode.com') u.host = 'gitcode.com';
}

/** 平台错误码注入错误消息分类（正则片段，消费方拼进分类正则）：分诊表见文件头 ② */
export const PLATFORM_FORBIDDEN_CODES = /CH\.0090540[2-9]/;
export const PLATFORM_AUTH_FAILED_CODES = /CH\.00905401/;

/** 令牌属主反查（仅 gitcode；其他平台返回 null = 不支持）。
 *  令牌一律走 Authorization header——URL query 参数会进 HTTP 访问日志/反代
 *  日志（凭据侧录反模式），v5 API 官方支持 Bearer 头（本仓工具链同款） */
export async function tokenOwner(pullUrl: string, secret: string): Promise<string | null> {
  if (!secret) return null;
  try {
    const u = new URL(pullUrl);
    if (u.host !== 'gitcode.com') return null;
    const res = await fetch('https://gitcode.com/api/v5/user', {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as Record<string, unknown>;
    if (typeof j.login === 'string' && j.login) return j.login;
    if (typeof j.username === 'string' && j.username) return j.username;
    return null;
  } catch {
    return null;
  }
}
