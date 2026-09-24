#!/bin/bash
# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software, you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Node.js version check (>= 20.0.0 required; v18.19.x fails with better-sqlite3 / Prisma 6)
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 20 ]; then
  NODE_VERSION=$(node -v 2>/dev/null || echo "unknown")
  echo "[setup] Node.js $NODE_VERSION is not supported. Requires >= 20.0.0." >&2
  echo "[setup] v18.19.x fails to install better-sqlite3 and Prisma 6 native modules." >&2

  # Try auto-switch via nvm if available
  if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
    [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
    NVM_LTS=$(nvm ls-remote --lts=20 2>/dev/null | tail -1 | awk '{print $1}')
    if [ -n "$NVM_LTS" ]; then
      echo "[setup] Found nvm — installing Node.js $NVM_LTS..."
      nvm install "$NVM_LTS" && nvm use "$NVM_LTS"
      NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
      if [ "$NODE_MAJOR" -ge 20 ]; then
        echo "[setup] Switched to Node.js $(node -v) ✓"
      else
        echo "[setup] nvm install failed, please run: nvm install 20 && nvm use 20" >&2
        exit 1
      fi
    else
      echo "[setup] nvm found but no Node 20 LTS available. Run: nvm install 20" >&2
      exit 1
    fi
  else
    echo "[setup] No nvm detected. Quick fix:" >&2
    echo "[setup]   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash" >&2
    echo "[setup]   source ~/.nvm/nvm.sh && nvm install 20 && nvm use 20" >&2
    echo "[setup] Or install Node 20+ directly: https://nodejs.org" >&2
    exit 1
  fi
fi

export DATABASE_URL="${DATABASE_URL:-file:$SCRIPT_DIR/prisma/dev.db}"

UPDATE=false
CLI=false
CLI_CMD=""
FRESH=false
ADVANCED=false
# 默认生产模式（next build 缓存复用 + 请求零编译——dev 按需编译是 Turns tab
# 首击秒级卡顿的主因）；开发改代码要热重载时用 -d
PROD=true
ALLOWED_CLI_COMMANDS="tui sessions session turn search compare stats import delete config"
while getopts "uc:kfadp" opt; do
  case $opt in
    u) UPDATE=true ;;
    c) CLI=true; CLI_CMD="$OPTARG" ;;
    k) : ;;  # -k：历史别名——默认已是"杀旧重启"单实例语义，无需分支
    f) FRESH=true ;;
    a) ADVANCED=true ;;
    d) PROD=false ;;
    p) PROD=true ;;
    *) echo "Usage: $0 [-u] [-f] [-a] [-d] [-c <command|tui>]  (-u: update; -f: force rebuild; -a: show advanced tabs; -d: dev mode — default is production; -c: CLI mode)" >&2
       echo "       -k 仍被接受（历史别名，语义=默认：杀已有自家实例后从 BASE_PORT 单实例重启）" >&2; exit 1 ;;
  esac
done

if [ "$CLI" = true ]; then
  valid=false
  for cmd in $ALLOWED_CLI_COMMANDS; do
    if [ "$CLI_CMD" = "$cmd" ]; then valid=true; break; fi
  done
  if [ "$valid" = false ]; then
    echo "[start] ERROR: Invalid CLI command '$CLI_CMD'. Allowed: $ALLOWED_CLI_COMMANDS" >&2
    exit 1
  fi
fi

# 依赖实装守卫（cpx install.sh 同款纪律）：node_modules 目录存在 ≠ 依赖齐全
# —— git pull 拉到新依赖声明（如 7z 升级的 7zip-bin）而未跑 npm install 的旧
# node_modules 会缺件，next build 期 Module not found（现场：存量部署机
# Turbopack Can't resolve '7zip-bin'，报错不指向真因）。npm ls 校验生产树
# 实装状态（健康树 ~0.6s），缺件即补装；安装失败仅在依赖确实不完整时
# fail-fast（此时 build 必炸，快死快报），-u 触发的失败不阻断（旧依赖仍
# 完整可用，与既有行为一致）。
install_deps_if_needed() {
  local deps_ready=false
  if [ -d node_modules ] && npm ls --omit=dev --depth=0 >/dev/null 2>&1; then
    deps_ready=true
  fi
  if [ "$UPDATE" = true ] || [ "$deps_ready" = false ]; then
    echo "[setup] Installing dependencies..."
    if npm install; then
      return 0
    fi
    if [ "$deps_ready" = false ]; then
      echo "[setup] npm install failed — deps incomplete, build would fail (Module not found). Check network/registry or run: npm ci" >&2
      return 1
    fi
    echo "[setup] npm install failed (non-fatal — existing deps still usable)" >&2
  fi
  return 0
}
install_deps_if_needed || exit 1

# Proxy (cpx) setup — delegated to the standalone proxy installer, so both
# `./start.sh` (integrated) and `../cpx/install.sh` (standalone, capture works
# without insight) share one code path. Non-fatal: if it fails, insight still
# starts (just without a fresh cpx wrapper).
PROXY_INSTALL="$SCRIPT_DIR/../cpx/install.sh"
if [ -f "$PROXY_INSTALL" ]; then
  echo "[setup] Setting up proxy (cpx)..."
  PROXY_INSTALL_ARGS=()
  if [ "$UPDATE" = true ]; then PROXY_INSTALL_ARGS+=("-u"); fi
  mkdir -p "$SCRIPT_DIR/tmp"
  PROXY_LOG="$SCRIPT_DIR/tmp/cpx-install.log"
  if bash "$PROXY_INSTALL" "${PROXY_INSTALL_ARGS[@]}" > "$PROXY_LOG" 2>&1; then
    echo "[setup] cpx ready ✓ (log: tmp/cpx-install.log)"
  else
    echo "[setup] proxy install failed (non-fatal):"
    tail -n 20 "$PROXY_LOG"
  fi
fi

# Ensure better-sqlite3 native module matches the running Node ABI.
# node_modules is per-machine (gitignored); switching Node (e.g. 20 <-> 24)
# leaves the previously-compiled .node with a mismatched ABI and crashes at
# runtime. Auto-rebuild so the same script works across Node versions.
if [ -d "node_modules/better-sqlite3" ]; then
  if ! node -e "require('better-sqlite3')" 2>/dev/null; then
    echo "[setup] better-sqlite3 native module mismatched for Node $(node -v) — rebuilding..."
    npm rebuild better-sqlite3
    if ! node -e "require('better-sqlite3')" 2>/dev/null; then
      echo "[setup] better-sqlite3 rebuild failed. If build tools are missing, install them or run: npm ci" >&2
      exit 1
    fi
    echo "[setup] better-sqlite3 rebuilt for Node $(node -v) ✓"
  fi
fi

if [ "$FRESH" = true ]; then
  echo "[setup] Clearing .next cache for fresh build..."
  rm -rf .next
fi

# Ensure .env exists with DATABASE_URL
if [ ! -f ".env" ]; then
  echo "[setup] Creating .env with DATABASE_URL..."
  echo 'DATABASE_URL="file:./dev.db"' > .env
fi

# Advanced tabs toggle (subagents, interactions, AI workflow)
export NEXT_PUBLIC_SHOW_ADVANCED_TABS="${ADVANCED}"
echo "[setup] Advanced tabs: ${ADVANCED} (use -a flag to enable)"

if [ "$UPDATE" = true ] || [ ! -f "prisma/dev.db" ]; then
  echo "[setup] Running Prisma migration..."
  npx prisma migrate dev --name init
fi

# 单实例收口：dev 锁记录的 dev server 同在击杀范围（默认即收口，无 -k 门槛）
LOCK_FILE=".next/dev/lock"
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(python3 -c "import json; print(json.load(open('$LOCK_FILE'))['pid'])" 2>/dev/null || cat "$LOCK_FILE" | grep -o '"pid":[0-9]*' | grep -o '[0-9]*')
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[start] Stopping existing dev server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$LOCK_FILE"
fi

# 单实例收口（2026-09-21 决策翻转）：此前的"多开常态"（并行实例各占端口）
# 是端口漂移与僵尸实例累积的根源——默认路径改为杀已有自家实例后固定绑
# BASE_PORT。PID 文件仅作记录（launch 段写入最新实例）。
PROD_PID_FILE="$SCRIPT_DIR/tmp/next-prod.pid"

BASE_PORT=21025
PORT=$BASE_PORT

# 端口占用查询三级 fallback（与 pick-smart-agent-port.sh 同款）：本机 WSL2
# 上 lsof 对部分 LISTEN 套接字失明（ss 可见 21025 占用、lsof 全列表为空，
# 实测）——只信 lsof 会让 -k 恒报 "free"，next start EADDRINUSE 秒死，
# 主脚本 wait 立即返回再被 trap 收尾（"把自己杀掉"的完整链条）。
port_pid() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
  elif command -v lsof >/dev/null 2>&1; then
    # -sTCP:LISTEN 必须：不带则 lsof 匹配连接两端，ESTABLISHED 的客户端
    # （cpx 自动导入 curl、API 探测等）会被一并误杀
    lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$port/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | head -1
  fi
}

port_busy() {
  local port=$1
  [ -n "$(port_pid "$port")" ]
}

# 单实例端口收口：等待 BASE_PORT 释放（杀实例后内核回收套接字需要时间，
# 含 TIME_WAIT 清理；10s 上限覆盖 SIGKILL 补刀后的收尾）。超时仍被占 =
# 占用者是无关进程 → fail-fast 报占用者诊断——绝不端口漂移（漂移会断
# cpx 自动导入的 INSIGHT_BASE=21025 探测与浏览器书签，静默换址比明确报错
# 更伤）。next start EADDRINUSE 秒死会重演"主脚本 wait 立即返回再被 trap
# 收尾"的事故链，硬绑同理不可取。
ensure_base_port_free() {
  local waited=0
  while port_busy "$BASE_PORT"; do
    if [ "$waited" -ge 10 ]; then
      local holder_pid holder_cmd
      holder_pid=$(port_pid "$BASE_PORT")
      holder_cmd=$(ps -o command= -p "$holder_pid" 2>/dev/null || echo "未知（可能已退出，端口处 TIME_WAIT）")
      echo "[start] ERROR: 端口 $BASE_PORT 在击杀自家实例后 ${waited}s 仍被占用。" >&2
      echo "[start]   占用者 PID ${holder_pid}: ${holder_cmd}" >&2
      echo "[start] 单实例模式不做端口漂移。请确认占用者后手动处理（kill ${holder_pid}），或修改 BASE_PORT。" >&2
      exit 1
    fi
    sleep 0.5
    waited=$(awk "BEGIN{print $waited + 0.5}")
  done
}

# 进程 cwd 解析（kill_all_insight 锚定用）：Linux 走 /proc readlink；无 /proc
# 的平台（macOS——单实例收口的主要开发环境）退 lsof -d cwd，锚定语义不变。
# 只在 mac 上 readlink 恒空 → 函数恒不认定自家实例 → 杀旧重启退化为
# ensure_base_port_free 10s 超时硬失败，「杀旧重启」在 mac 上不成立。
proc_cwd() {
  local pid=$1
  if [ -e "/proc/$pid" ]; then
    readlink "/proc/$pid/cwd" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}

# 杀掉所有自家实例（不限端口，扫进程表；单实例收口默认调用，-k 等价）——next 系（cmdline 含
# next-server / next start / npx next）且 cwd 在本包，以及 cwd 在
# smart-agent 的 python 进程（cmdline 锚定解释器：vim/less/grep server.py
# 的命令行也含该字样，只凭 pgrep 会把编辑器一并 SIGTERM）。别人的 Next
# 项目（cwd 不在包内）与无关进程不碰。cwd 解析跨平台走 proc_cwd（/proc →
# readlink；macOS → lsof -d cwd），读取失败（权限/进程已退出）按不认定处理
# ——误杀别人的进程比漏杀更伤，漏杀兜底由 ensure_base_port_free 的占用者
# 诊断 fail-fast 收口。
#
# 击杀升级（SIGTERM → 3s 宽限 → SIGKILL）：next-server 对 SIGTERM 走
# graceful close——释放 LISTEN 但等存量 keep-alive 连接收尾，而浏览器在
# 等响应 → 双等死锁：进程活着、连接永驻不响应，浏览器复用旧连接一直
# 转圈（实测 2026-09-20，新连接打到新实例正常、旧连接挂死）。宽限后
# 必须对残存者 SIGKILL 补刀。
kill_all_insight() {
  local pid cmd cwd killed="" pids=""
  for pid in $(pgrep -f 'next-server|next start|npx next' 2>/dev/null || true); do
    cwd=$(proc_cwd "$pid")
    case "$cwd" in
      "$SCRIPT_DIR"|"$SCRIPT_DIR"/*)
        echo "[start] 单实例收口: stopping insight instance (PID $pid)..."
        pids="$pids $pid"
        ;;
    esac
  done
  for pid in $(pgrep -f 'server\.py' 2>/dev/null || true); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    case "$cmd" in
      python*) ;;
      *) continue ;;
    esac
    cwd=$(proc_cwd "$pid")
    if [ "$cwd" = "$SCRIPT_DIR/smart-agent" ]; then
      echo "[start] 单实例收口: stopping smart-agent (PID $pid)..."
      pids="$pids $pid"
    fi
  done
  if [ -z "$pids" ]; then
    echo "[start] 单实例收口: no existing insight instance found"
    return 0
  fi
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
    killed=1
  done
  for _ in 1 2 3 4 5 6; do
    local alive=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ -z "$alive" ] && break
    sleep 0.5
  done
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "[start] 单实例收口: SIGTERM 未收尾，SIGKILL 补刀 (PID $pid)..."
      kill -9 "$pid" 2>/dev/null || true
      killed=1
    fi
  done
  [ -n "$killed" ] || echo "[start] 单实例收口: no existing insight instance found"
}

# 单实例收口：杀掉所有自家实例（kill_all_insight：SIGTERM→3s 宽限→SIGKILL
# 补刀，cwd 锚定跨平台走 proc_cwd——/proc readlink / macOS lsof -d cwd，
# 只杀本包 next-server + smart-agent）→ 等 BASE_PORT 释放（10s 上限）。
# 超时仍被占 = 占用者是无关进程 → fail-fast 报占用者诊断——绝不端口漂移
# （漂移会断 cpx 自动导入的 INSIGHT_BASE=21025 探测与浏览器书签，静默换
# 址比明确报错更伤）
kill_all_insight
ensure_base_port_free

# Launch Python smart-agent (v2 backend) in background.
# 端口选择与存量进程处置交给 scripts/pick-smart-agent-port.sh（可独立行为测试）：
# 避让 next 实占 PORT（防 EADDRINUSE 撞车）；/health 验明正身才杀旧重启；
# 自家 insight 残留实例（next-server + cwd 在包内）击杀回收；无关进程不杀、
# 错开端口；无可用候选则跳过 smart-agent（主服务不受影响）。
AGENT_PID=""
AGENT_LOG="$SCRIPT_DIR/tmp/smart-agent.log"

if [ -f "$SCRIPT_DIR/smart-agent/server.py" ]; then
  # 恒 clean：单实例语义下旧 smart-agent 总在击杀回收范围（keep 模式是默认
  # 路径 smart-agent 残留泄漏的来源——实测 2026-09-21：21026 python3 从
  # 上午存活到晚间）
  AGENT_PORT=$(bash "$SCRIPT_DIR/scripts/pick-smart-agent-port.sh" "$BASE_PORT" "$PORT" "$SCRIPT_DIR" clean)
  if [ -n "$AGENT_PORT" ]; then
    mkdir -p "$SCRIPT_DIR/tmp"
    (cd "$SCRIPT_DIR/smart-agent" && CANNBOT_AGENT_PORT=$AGENT_PORT python3 server.py) > "$AGENT_LOG" 2>&1 &
    AGENT_PID=$!
    export CANNBOT_AGENT_URL="http://localhost:$AGENT_PORT"
    for i in $(seq 1 10); do
      if curl -s "http://localhost:$AGENT_PORT/health" > /dev/null 2>&1; then
        echo "[start] smart-agent ready (port $AGENT_PORT, PID $AGENT_PID, log $AGENT_LOG)"
        break
      fi
      sleep 0.5
    done
  else
    echo "[start] smart-agent skipped (no free candidate port in $((BASE_PORT + 1))-$((BASE_PORT + 3)) after avoiding PORT=$PORT)"
  fi
fi

cleanup() {
  if [ -n "$AGENT_PID" ] && kill -0 "$AGENT_PID" 2>/dev/null; then
    echo "[start] Stopping smart-agent (PID $AGENT_PID)..."
    kill "$AGENT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 端口已由上方 ensure_base_port_free 定死为 BASE_PORT（单实例不漂移）；
# smart-agent 端口由 pick 脚本避让 PORT 自选。
echo "[start] Launching CANNBot-Insight on port $PORT..."

# 生产模式（默认）：next build + next start。dev 模式对 API 路由按需编译——
# "某个 turn 首次点击数秒"的主因即此；生产模式启动时一次性构建，请求零编译。
# 构建产物复用：源码（src/prisma/public/配置）没有比 .next/BUILD_ID 更新的
# 文件即跳过重建——改代码后自动重建，无需记 -f；-f 仍可强制。
# public/export-view.js 例外：它是 build:export-view 的产物（每次启动重写），
# 且 public/ 由 next start 运行时直读、不进 next build 产物——不排除则每次
# 启动都误判"源码已变"触发无谓全量重建。
NEXT_CMD="dev"
if [ "$PROD" = true ] && [ "$CLI" != true ]; then
  NEED_BUILD=true
  if [ "$FRESH" != true ] && [ -f ".next/BUILD_ID" ]; then
    STALE=$(find src prisma public package.json next.config.ts tsconfig.json -newer .next/BUILD_ID ! -path "public/export-view.js" -print -quit 2>/dev/null || true)
    if [ -z "$STALE" ]; then
      NEED_BUILD=false
      echo "[start] Production build cached (.next/BUILD_ID up to date) — skip"
    else
      echo "[start] Sources changed since last build ($STALE ...) — rebuilding"
    fi
  fi
  if [ "$NEED_BUILD" = true ]; then
    echo "[start] Production build (next build)..."
    mkdir -p "$SCRIPT_DIR/tmp"
    BUILD_LOG="$SCRIPT_DIR/tmp/next-build.log"
    if ! npm run build > "$BUILD_LOG" 2>&1; then
      echo "[start] ERROR: build failed — tail of $BUILD_LOG:" >&2
      tail -n 40 "$BUILD_LOG" >&2
      exit 1
    fi
    COMPILED=$(grep -o 'Compiled successfully in [0-9.]*m\?s' "$BUILD_LOG" | head -1)
    echo "[start] Build OK${COMPILED:+ — $COMPILED} (full log: tmp/next-build.log)"
  fi
  NEXT_CMD="start"
fi

# Build the embedded export-view bundle (self-contained interactive HTML export)
echo "[setup] Building export-view bundle..."
npm run build:export-view >/dev/null 2>&1 || echo "  [warn] export-view build failed — HTML export disabled until npm run build:export-view succeeds"

if [ "$CLI" = true ]; then
  SERVER_URL="http://localhost:$PORT"

  # Start backend in background (stdout→file: avoid VSCode auto port-forward hijacking
  # the printed URL and assigning a random local port instead of 21025)
  npx next $NEXT_CMD -H 127.0.0.1 --port $PORT > "$SCRIPT_DIR/tmp/next-$NEXT_CMD.log" 2>&1 &
  BACKEND_PID=$!
  # Wait for backend to be ready
  echo "[start] Waiting for backend (port $PORT)..."
  for i in $(seq 1 60); do
    if curl -s "$SERVER_URL/api/observe/data?pageSize=1" > /dev/null 2>&1; then
      echo "[start] Backend ready (port $PORT)"
      break
    fi
    sleep 1
  done

  echo "[start] Launching CLI: $CLI_CMD"
  npx tsx src/cli/index.ts -- "$CLI_CMD" --server "$SERVER_URL"
  kill $BACKEND_PID 2>/dev/null || true
  echo "[start] CLI exited, backend stopped"
else
  npx next $NEXT_CMD -H 127.0.0.1 --port $PORT > "$SCRIPT_DIR/tmp/next-$NEXT_CMD.log" 2>&1 &
  NEXT_PID=$!
  if [ "$NEXT_CMD" = "start" ]; then echo "$NEXT_PID" > "$PROD_PID_FILE"; fi

  echo "[start] Waiting for server (port $PORT)..."
  for i in $(seq 1 30); do
    if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
      echo "[start] Server ready (port $PORT)"
      # WSL: use Windows cmd.exe to open browser
      if grep -qi microsoft /proc/version 2>/dev/null && [ -x /mnt/c/Windows/System32/cmd.exe ]; then
        /mnt/c/Windows/System32/cmd.exe /c start "http://localhost:$PORT" 2>/dev/null || true
      # xdg-open / sensible-browser 需图形会话;无 DISPLAY 的远程/无头 VM 会静默失败,故加守卫跳过
      elif [ -n "$DISPLAY" ] && command -v xdg-open > /dev/null 2>&1; then
        xdg-open "http://localhost:$PORT" 2>/dev/null || true
      elif [ "$(uname)" = "Darwin" ] && command -v open > /dev/null 2>&1; then
        open "http://localhost:$PORT" 2>/dev/null || true
      elif [ -n "$DISPLAY" ] && command -v sensible-browser > /dev/null 2>&1; then
        sensible-browser "http://localhost:$PORT" 2>/dev/null || true
      else
        # 无图形会话(远程/无头 VM):服务器开不了你本机浏览器,端口转发后本地访问
        echo "[start] 无图形会话(远程/无头 VM)——服务器无法启动你本机浏览器。"
        echo "[start] 若已端口转发(如 ssh -L $PORT:localhost:$PORT)或走 VS Code Remote,在本地浏览器打开:"
        echo "[start]   http://localhost:$PORT"
      fi
      break
    fi
    sleep 1
  done

  wait $NEXT_PID
fi
