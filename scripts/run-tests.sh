#!/usr/bin/env bash
# insight 单元用例入口（供仓顶 scripts/run-tests.sh 转调，也可单独执行）。
# 依赖缺失时自动 npm install（fresh clone / 流水线一条命令可跑；postinstall
# 会生成 Prisma client）。CANNBOT_TEST_SKIP_SLOW=1：跳过慢速/环境敏感用例
# （见 vitest.config.ts 项目级 exclude）。
#
# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software, you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -x node_modules/.bin/vitest ]; then
  echo "==> [insight] deps missing, running npm install (first run may take minutes)"
  npm install --no-audit --no-fund || exit 1
fi
if [ ! -x node_modules/.bin/vitest ]; then
  echo "vitest still missing after npm install" >&2
  exit 1
fi

CANNBOT_TEST_SKIP_SLOW=1 npm run test
