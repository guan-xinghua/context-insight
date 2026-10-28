// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 设置页「保存配置」的凭据操作决策（planCredentialAction）UT + handleSave
// 接线源级锁。回归背景（PR #38 审查意见）：旧 handleSave 的 else 分支把
// token/password 模式下的空输入一并送 DELETE——用户已存凭据后只想改
// 分支/目录再保存，令牌框留空（placeholder「输入新值可更换」的空值语义 =
// 不动）→ 已存凭据被静默清除，下次上传撞 no-credentials 引导重配。决策
// 语义：留空 = 保留现有；仅显式匿名（none）才清除。组件组合由 typecheck
// + 手动验（同 lake-token-prompt 模式），服务端 PUT/DELETE 行为已有
// lake-auth-it 锁定。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { planCredentialAction, type LakeConfig } from '../../src/lib/lake-config';

function cfg(partial: Partial<LakeConfig>): LakeConfig {
  return {
    address: 'https://example.com/lake.git',
    authMode: 'none',
    account: '',
    password: '',
    token: '',
    branch: 'main',
    directory: '',
    ...partial,
  };
}

describe('planCredentialAction（保存时服务端凭据操作决策）', () => {
  it('token 模式：填了令牌 → save-token；留空（只想改分支/目录再保存）→ keep，绝不落入删除', () => {
    expect(planCredentialAction(cfg({ authMode: 'token', token: 'tok-123456' }))).toBe('save-token');
    expect(planCredentialAction(cfg({ authMode: 'token', token: '' }))).toBe('keep');
    expect(planCredentialAction(cfg({ authMode: 'token', token: '   ' }))).toBe('keep');
  });

  it('password 模式：账号密码齐全 → save-password；任一留空 → keep', () => {
    expect(planCredentialAction(cfg({ authMode: 'password', account: 'u', password: 'p' }))).toBe('save-password');
    expect(planCredentialAction(cfg({ authMode: 'password', account: 'u', password: '' }))).toBe('keep');
    expect(planCredentialAction(cfg({ authMode: 'password', account: '', password: 'p' }))).toBe('keep');
  });

  it('匿名模式（显式切换）→ clear：清除是用户明示意图，不是空输入的兜底归宿', () => {
    expect(planCredentialAction(cfg({ authMode: 'none' }))).toBe('clear');
  });
});

describe('handleSave 接线（源级锁）', () => {
  it('设置页消费 planCredentialAction 四分支；DELETE 只存在于 clear 分支内', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/app/settings/page.tsx'), 'utf8');
    expect(src).toContain('planCredentialAction(config)');
    expect(src).toContain('action === "save-token"');
    expect(src).toContain('action === "save-password"');
    expect(src).toContain('action === "clear"');
    const clearBranch = src.slice(src.indexOf('action === "clear"'));
    expect(clearBranch.slice(0, clearBranch.indexOf('} else {'))).toContain('"DELETE"');
    // clear 分支之外不得出现凭据 DELETE（handleClear 的显式清除入口除外：
    // 锁 handleSave 函数体内——从函数头到 handleClear 定义之间）
    const handleSaveBody = src.slice(src.indexOf('async function handleSave'), src.indexOf('async function handleClear'));
    const beforeClearBranch = handleSaveBody.slice(0, handleSaveBody.indexOf('action === "clear"'));
    expect(beforeClearBranch).not.toContain('"DELETE"');
  });

  it('LFS 开关接线：GET 回显进状态、PUT body 带上 lfs（回归锁：修复前保存会把 lake-config.json 的 lfs 字段洗掉，用户关闭的 LFS 模式被静默复位为 true）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/app/settings/page.tsx'), 'utf8');
    // GET 回显：服务端 lfs 字段进 React 状态（缺省 true）
    expect(src).toContain('setLfs(data.lfs ?? true)');
    // PUT 透传：保存 body 必须带 lfs（handleSave 函数体内）
    const handleSaveBody = src.slice(src.indexOf('async function handleSave'), src.indexOf('async function handleClear'));
    expect(handleSaveBody).toContain('lfs');
    // 开关控件：状态翻转要触发 dirty（保存按钮可用性）
    expect(src).toContain('onCheckedChange={(v) => { setLfs(v === true); dirty() }}');
  });
});
