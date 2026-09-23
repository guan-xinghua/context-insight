#!/usr/bin/env bash
# insight 单元用例入口（供仓顶 scripts/run-tests.sh 转调，也可单独执行）。
# 依赖缺失时自动 npm install（fresh clone / 流水线一条命令可跑；postinstall
# 会生成 Prisma client）。
# tests 分层：tests/ut 默认跑（npm run test）；tests/e2e（真 CLI/浏览器/环境
# 依赖）显式跑：npm run test:e2e。
# COVERAGE=1 时改跑 npm run test:cov（pretest + vitest --coverage，v8
# provider 统计 src/ 全量；npm 只对 test 名挂 pretest 钩子，test:cov 需显式串）。
# --coverage / -c 参数等价置 COVERAGE=1。
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

for a in "$@"; do
  case "$a" in
    --coverage|-c) COVERAGE=1 ;;
    *) echo "Usage: $0 [--coverage|-c]" >&2; exit 2 ;;
  esac
done

if [ ! -x node_modules/.bin/vitest ]; then
  echo "==> [insight] deps missing, running npm install (first run may take minutes)"
  npm install --no-audit --no-fund || exit 1
fi
if [ ! -x node_modules/.bin/vitest ]; then
  echo "vitest still missing after npm install" >&2
  exit 1
fi

if [ "${COVERAGE:-0}" = "1" ]; then
  # 与 cpx 对称：provider 被单独剥离（如 --omit=dev 装过）时自愈补装
  node -e "require.resolve('@vitest/coverage-v8')" 2>/dev/null \
    || { echo "==> [insight] coverage provider missing (@vitest/coverage-v8), installing"; \
         npm install --no-audit --no-fund || exit 1; }
  npm run test:cov
  rc=$?
  # vitest 默认失败 run 不产报告（reportOnFailure: false），提示行只在
  # 报告实际落盘后才打，避免指向不存在的文件
  [ -f coverage/lcov.info ] \
    && echo "==> [insight] 覆盖率明细: packages/insight/coverage/index.html（浏览器）/ lcov.info"
  exit "$rc"
else
  npm run test
fi
