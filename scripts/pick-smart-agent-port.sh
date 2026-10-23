#!/bin/bash
# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software, you can redistribute it and/or modify it under the terms of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.

# smart-agent 端口选择器（start.sh 调用，tests/e2e/start-sh-agent-port.test.ts 独立行为测试）。
# 用法：pick-smart-agent-port.sh <BASE_PORT> <NEXT_PORT> [INSIGHT_ROOT] [MODE]；
# stdout 输出选中的端口（无可用则空）。
#
# MODE=keep（默认）：纯避让——任何占用进程都不杀（start.sh 默认路径零杀：
# 只启动一个新的、端口顺延）。
# MODE=clean：允许杀自家旧进程（start.sh -k 语义：杀掉所有自家实例后重启）。
#
# 规则（修三类事故）：
# 1. 避让 next 实占端口 NEXT_PORT——BASE 被占时 next 会滚进 BASE+1 起，smart-agent
#    若钉死 BASE+1 会先绑定导致 next EADDRINUSE 崩溃（npm 启动器同款 bug 的 dev 版）；
# 2. 端口被占时先验明正身：/health 应答体须带服务标识 "context-smart-agent"
#    （server.py 契约）——通用 /health 服务（Actuator、k8s 探针、dev server
#    等）2xx 也绝不认。仅 clean 模式下杀旧重启（加载 *.py 变更，原语义）；
#    无关进程任何模式都绝不击杀——此前无差别 kill → kill -9 会误杀运行中
#    的其他服务（"运行中被杀死"事故来源之一），改为错开到下一候选；
#    BASE+1~BASE+3 全被无关进程占满则返回空（调用方跳过）。
# 3. 自家 insight 残留实例（cmdline 含 next-server 且 cwd 在 INSIGHT_ROOT 下）：
#    仅 clean 模式击杀回收（keep 模式下用户并跑的活跃实例必须存活）。双重
#    限定防误杀：别人的 next-server（cwd 不在包内）与 vitest 等本包进程
#    （cmdline 无 next-server）都不满足。无 /proc 的平台（macOS）读取失败
#    按不认定处理，回退避让。

BASE_PORT=$1
NEXT_PORT=$2
INSIGHT_ROOT=${3:-}
MODE=${4:-keep}

port_pid() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
  elif command -v lsof >/dev/null 2>&1; then
    # -sTCP:LISTEN 必须有：lsof -ti tcp:$port 默认匹配连接两端，会把与该端口
    # ESTABLISHED 的客户端进程（残留 next、浏览器等）也列出来，head -1 可能
    # 取到客户端 PID 导致杀错进程（macOS 走的正是 lsof 分支）
    lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$port/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | head -1
  fi
}

# 正身判定：/health 应答体带 smart-agent 服务标识（server.py 契约）。
# 只看 curl 退出码（2xx）不够——带 /health 的无关服务到处都是。
is_smart_agent() {
  local port=$1
  curl -s -m 2 "http://localhost:$port/health" 2>/dev/null | grep -q 'context-smart-agent'
}

# 自家 insight 残留实例判定（规则 3）：cmdline 含 next-server + cwd 在包内。
is_our_insight() {
  local pid=$1
  [ -n "$INSIGHT_ROOT" ] || return 1
  local cmd cwd
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 1
  case "$cmd" in
    *next-server*) ;;
    *) return 1 ;;
  esac
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || return 1
  case "$cwd" in
    "$INSIGHT_ROOT"|"$INSIGHT_ROOT"/*) return 0 ;;
    *) return 1 ;;
  esac
}

for CAND in $((BASE_PORT + 1)) $((BASE_PORT + 2)) $((BASE_PORT + 3)); do
  if [ "$CAND" = "$NEXT_PORT" ]; then
    echo "[start] smart-agent candidate $CAND skipped (next is using it)" >&2
    continue
  fi
  EXISTING=$(port_pid "$CAND")
  if [ -z "$EXISTING" ]; then
    echo "$CAND"
    exit 0
  fi
  if [ "$MODE" = clean ] && is_smart_agent "$CAND"; then
    echo "[start] Restarting smart-agent (killing stale smart-agent PID $EXISTING on port $CAND; reloading to pick up *.py changes)..." >&2
    kill "$EXISTING" 2>/dev/null || true
    sleep 1
    if kill -0 "$EXISTING" 2>/dev/null; then kill -9 "$EXISTING" 2>/dev/null || true; sleep 0.5; fi
    echo "$CAND"
    exit 0
  fi
  if [ "$MODE" = clean ] && is_our_insight "$EXISTING"; then
    echo "[start] Port $CAND occupied by stale insight instance (PID $EXISTING, next-server under $INSIGHT_ROOT) — killing it..." >&2
    kill "$EXISTING" 2>/dev/null || true
    sleep 1
    if kill -0 "$EXISTING" 2>/dev/null; then kill -9 "$EXISTING" 2>/dev/null || true; sleep 0.5; fi
    echo "$CAND"
    exit 0
  fi
  echo "[start] Port $CAND occupied by non-smart-agent process (PID $EXISTING) — not killing it, trying next..." >&2
done

exit 0
