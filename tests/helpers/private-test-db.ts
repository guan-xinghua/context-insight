// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 全量并行下共享 prisma/test.db 会被其他测试文件的清库/批量删除夹具整库清空
//（现场：score-app 列表随机读到空库连挂 5 用例）——本模块把 DATABASE_URL 指到
// 本进程私有副本（拷 pretest 刚迁移完的 test.db，只带 schema 不带数据），文件内
// 夹具与被测代码同库，对并行污染免疫。必须作为测试文件的第一个 import
//（ESM 副作用按 import 书写顺序执行，晚于 PrismaClient 构造就失效）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-private-db-'));
const dst = path.join(dstDir, 'private.db');
fs.copyFileSync(path.resolve(__dirname, '../../prisma/test.db'), dst);
process.env.DATABASE_URL = `file:${dst}?socket_timeout=60`;

export const privateDbDir = dstDir;
