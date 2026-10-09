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

# 启动器统一日志：与 TS 侧 logger 同款格式 [time][level][module]:message。
# 屏幕恒显（启动器 UX 不受日志开关影响）；同时追加统一日志文件
# （~/.cannbot-insight/logs 或 CANNBOT_LOG_DIR），env CANNBOT_LOG /
# CANNBOT_LOG_FILE 置 0/off/false/no 时不落文件（与运行期同语义）
LAKE_LOG_DIR="${CANNBOT_LOG_DIR:-$HOME/.cannbot-insight/logs}"
# %3N 是 GNU 扩展：BSD/macOS date 输出字面 '3N'，探测一次决定带不带毫秒
SLOG_MS=""
[ "$(date -u +%3N 2>/dev/null)" != "3N" ] && SLOG_MS=".%3N"
# off 判定（trim + 大小写归一，与 TS 侧 OFF_RE 同语义）
slog_is_off() {
  case "$(printf '%s' "$1" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in
    0|off|false|no) return 0 ;;
  esac
  return 1
}
slog() { # level module message
  local line="[$(date -u +%Y-%m-%dT%H:%M:%S${SLOG_MS}Z)][$1][$2]:$3"
  # WARN/ERROR 走 stderr（与 TS 侧 console.error 同通道），INFO 走 stdout
  if [ "$1" = "WARN" ] || [ "$1" = "ERROR" ]; then echo "$line" >&2; else echo "$line"; fi
  if slog_is_off "${CANNBOT_LOG:-}" || slog_is_off "${CANNBOT_LOG_FILE:-}"; then return 0; fi
  mkdir -p "$LAKE_LOG_DIR" 2>/dev/null || return 0
  echo "$line" >> "$LAKE_LOG_DIR/insight-$(date -u +%F).log" 2>/dev/null || true
}

# Node.js version check (>= 22.12.0 required; better-sqlite3@13 / commander@14 need Node 22+)
NODE_NUM=$(node -e "const [M,m]=process.versions.node.split('.').map(Number);console.log(M*100+(m||0))" 2>/dev/null || echo "0")
if [ "$NODE_NUM" -lt 2212 ]; then
  NODE_VERSION=$(node -v 2>/dev/null || echo "unknown")
  slog WARN setup "Node.js $NODE_VERSION is not supported. Requires >= 22.12.0." >&2
  slog WARN setup "better-sqlite3@13 needs Node >= 22; older versions segfault at runtime." >&2

  # Try auto-switch via nvm if available
  if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
    [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
    NVM_LTS=$(nvm ls-remote --lts=22 2>/dev/null | tail -1 | awk '{print $1}')
    if [ -n "$NVM_LTS" ]; then
      slog INFO setup "Found nvm — installing Node.js $NVM_LTS..."
      nvm install "$NVM_LTS" && nvm use "$NVM_LTS"
      NODE_NUM=$(node -e "const [M,m]=process.versions.node.split('.').map(Number);console.log(M*100+(m||0))")
      if [ "$NODE_NUM" -ge 2212 ]; then
        slog INFO setup "Switched to Node.js $(node -v) ✓"
      else
        slog WARN setup "nvm install failed, please run: nvm install 22 && nvm use 22" >&2
        exit 1
      fi
    else
      slog WARN setup "nvm found but no Node 22 LTS available. Run: nvm install 22" >&2
      exit 1
    fi
  else
    slog WARN setup "No nvm detected. Quick fix:" >&2
    slog WARN setup "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash" >&2
    slog WARN setup "  source ~/.nvm/nvm.sh && nvm install 22 && nvm use 22" >&2
    slog WARN setup "Or install Node 22+ directly: https://nodejs.org" >&2
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
# --stop：长参 getopts 不识别（会落进 *) 分支报 usage），先扫描剥离再走正常解析
STOP_REQUESTED=false
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--stop" ]; then
    STOP_REQUESTED=true
  else
    ARGS+=("$arg")
  fi
done
set -- "${ARGS[@]}"

while getopts "uc:kfadp" opt; do
  case $opt in
    u) UPDATE=true ;;
    c) CLI=true; CLI_CMD="$OPTARG" ;;
    k) : ;;  # -k：历史别名——默认已是"杀旧重启"单实例语义，无需分支
    f) FRESH=true ;;
    a) ADVANCED=true ;;
    d) PROD=false ;;
    p) PROD=true ;;
    *) echo "Usage: $0 [-u] [-f] [-a] [-d] [-c <command|tui>] [--stop]  (-u: update; -f: force rebuild; -a: show advanced tabs; -d: dev mode — default is production; -c: CLI mode)" >&2
       echo "       -k 仍被接受（历史别名，语义=默认：杀已有自家实例后从 BASE_PORT 单实例重启）" >&2
       echo "       --stop 显式停止自家实例（击杀 next + smart-agent 并确认端口释放后退出；不启动新实例）" >&2; exit 1 ;;
  esac
done

if [ "$CLI" = true ]; then
  valid=false
  for cmd in $ALLOWED_CLI_COMMANDS; do
    if [ "$CLI_CMD" = "$cmd" ]; then valid=true; break; fi
  done
  if [ "$valid" = false ]; then
    slog WARN start "ERROR: Invalid CLI command '$CLI_CMD'. Allowed: $ALLOWED_CLI_COMMANDS" >&2
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
    slog INFO setup "Installing dependencies..."
    if npm install; then
      return 0
    fi
    if [ "$deps_ready" = false ]; then
      slog WARN setup "npm install failed — deps incomplete, build would fail (Module not found). Check network/registry or run: npm ci" >&2
      return 1
    fi
    slog WARN setup "npm install failed (non-fatal — existing deps still usable)" >&2
  fi
  return 0
}
# --stop 只做击杀回收：跳过依赖/代理安装与迁移——全新 checkout 上 stop 一个
# 不存在的实例，不该先跑几分钟 npm install
if [ "$STOP_REQUESTED" != true ]; then
  install_deps_if_needed || exit 1
fi

# Proxy (cpx) setup — delegated to the standalone proxy installer, so both
# `./start.sh` (integrated) and `../cpx/install.sh` (standalone, capture works
# without insight) share one code path. Non-fatal: if it fails, insight still
# starts (just without a fresh cpx wrapper).
PROXY_INSTALL="$SCRIPT_DIR/../cpx/install.sh"
if [ "$STOP_REQUESTED" != true ] && [ -f "$PROXY_INSTALL" ]; then
  PROXY_INSTALL_ARGS=()
  if [ "$UPDATE" = true ]; then PROXY_INSTALL_ARGS+=("-u"); fi
  mkdir -p "$SCRIPT_DIR/tmp"
  PROXY_LOG="$SCRIPT_DIR/tmp/cpx-install.log"
  if bash "$PROXY_INSTALL" "${PROXY_INSTALL_ARGS[@]}" > "$PROXY_LOG" 2>&1; then
    slog INFO setup "cpx ready"
  else
    slog WARN setup "proxy install failed (non-fatal):"
    tail -n 20 "$PROXY_LOG"
  fi
fi

# Ensure better-sqlite3 native module matches the running Node ABI.
# node_modules is per-machine (gitignored); switching Node (e.g. 20 <-> 24)
# leaves the previously-compiled .node with a mismatched ABI and crashes at
# runtime. Auto-rebuild so the same script works across Node versions.
if [ -d "node_modules/better-sqlite3" ]; then
  if ! node -e "require('better-sqlite3')" 2>/dev/null; then
    slog WARN setup "better-sqlite3 native module mismatched for Node $(node -v) — rebuilding..."
    npm rebuild better-sqlite3
    if ! node -e "require('better-sqlite3')" 2>/dev/null; then
      slog WARN setup "better-sqlite3 rebuild failed. If build tools are missing, install them or run: npm ci" >&2
      exit 1
    fi
    slog INFO setup "better-sqlite3 rebuilt for Node $(node -v) ✓"
  fi
fi

if [ "$FRESH" = true ]; then
  slog INFO setup "Clearing .next cache for fresh build..."
  rm -rf .next
fi

# Ensure .env exists with DATABASE_URL
if [ ! -f ".env" ]; then
  slog INFO setup "Creating .env with DATABASE_URL..."
  echo 'DATABASE_URL="file:./dev.db"' > .env
fi

# Advanced tabs toggle (subagents, interactions, AI workflow)
export NEXT_PUBLIC_SHOW_ADVANCED_TABS="${ADVANCED}"
[ "$ADVANCED" = true ] && slog INFO setup "Advanced tabs enabled"

if [ "$STOP_REQUESTED" != true ] && { [ "$UPDATE" = true ] || [ ! -f "prisma/dev.db" ]; }; then
  slog INFO setup "Running Prisma migration..."
  npx prisma migrate dev --name init
fi

# 单实例收口：dev 锁记录的 dev server 同在击杀范围（默认即收口，无 -k 门槛）
LOCK_FILE=".next/dev/lock"
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(python3 -c "import json; print(json.load(open('$LOCK_FILE'))['pid'])" 2>/dev/null || cat "$LOCK_FILE" | grep -o '"pid":[0-9]*' | grep -o '[0-9]*')
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    slog INFO start "Stopping existing dev server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$LOCK_FILE"
fi

# 单实例收口（2026-09-21 决策翻转）：此前的"多开常态"（并行实例各占端口）
# 是端口漂移与僵尸实例累积的根源——默认路径改为杀已有自家实例后固定绑
# BASE_PORT。PID 文件仅作记录（launch 段写入最新实例）。
PROD_PID_FILE="$SCRIPT_DIR/tmp/next-prod.pid"

# 多人服务器（每用户一实例，docs/design/multi-user/）：端口按用户固定分配，
# CANNBOT_INSIGHT_PORT 覆盖默认 21025——单人本机不设 env 行为不变。
# 端口固定不漂移是单实例收口的既有决策，多人化只是把「一台机一个」精确化
# 为「一个用户一个」。
BASE_PORT="${CANNBOT_INSIGHT_PORT:-21025}"
PORT=$BASE_PORT

# 实例端口登记（发现契约，写入端）：服务就绪后把实际端口落到用户级登记文件，
# cpx 自动导入 / cbi CLI 默认连接按 env → 本登记文件 → 21025 兜底解析
# （读侧实现在 cpx src/cli/insight-discovery.ts 与 insight src/cli/config.ts）。
# 登记目录与 lake-config.json 同目录锚定（'.cannbot-insight' 字面量是
# pack-context 品牌翻转点，与 src/lib/lake/server-config.ts 口径一致）。
# 锚定与读侧及 npm 启动器严格一致：dirname(CANNBOT_PROXY_DIR) →
# CANNBOT_INSIGHT_HOME → $HOME/.cannbot-insight。
# 登记文件持久保留、不随实例退出删除——删除会在「实例未运行」窗口期让
# cpx 回落 21025，把捕获静默导入别人（占 21025 的那个）的实例。
CANNBOT_HOME_DIR="$(dirname "${CANNBOT_PROXY_DIR:-${CANNBOT_INSIGHT_HOME:-$HOME/.cannbot-insight}/proxy}")"
INSIGHT_PORT_REGISTRY="$CANNBOT_HOME_DIR/insight-port"

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
      holder_cmd=$(ps -o command= -p "$holder_pid" 2>/dev/null || echo "unknown (may have exited, port in TIME_WAIT)")
      slog WARN start "ERROR: port $BASE_PORT still occupied after ${waited}s." >&2
      slog WARN start "  held by PID ${holder_pid}: ${holder_cmd}" >&2
      slog WARN start "Single-instance mode does not port-drift. Kill it (kill ${holder_pid}) or change BASE_PORT." >&2
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
      pids="$pids $pid"
    fi
  done
  [ -z "$pids" ] && return 0
  slog INFO start "Stopping old instances (PID$pids)"
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
      slog INFO start "Force killing PID $pid (ignored SIGTERM)"
      kill -9 "$pid" 2>/dev/null || true
      killed=1
    fi
  done
}

# 单实例收口：杀掉所有自家实例（kill_all_insight：SIGTERM→3s 宽限→SIGKILL
# 补刀，cwd 锚定跨平台走 proc_cwd——/proc readlink / macOS lsof -d cwd，
# 只杀本包 next-server + smart-agent）→ 等 BASE_PORT 释放（10s 上限）。
# 超时仍被占 = 占用者是无关进程 → fail-fast 报占用者诊断——绝不端口漂移
# （漂移会断 cpx 自动导入的 INSIGHT_BASE=21025 探测与浏览器书签，静默换
# 址比明确报错更伤）
# --stop：显式停止自家实例——击杀（kill_all_insight：cwd 锚定，只杀本
# checkout 的 next 系 + smart-agent，SIGTERM→3s 宽限→SIGKILL 补刀）→ 等
# BASE_PORT 释放确认死透 → 退出。端口校验用的 BASE_PORT 需与实例启动时
# 一致：自定义端口的用户 stop 时要带同样的 CANNBOT_INSIGHT_PORT 环境。
if [ "$STOP_REQUESTED" = true ]; then
  kill_all_insight
  ensure_base_port_free
  echo "[stop] stopped (port $BASE_PORT free)"
  exit 0
fi

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
        slog INFO start "smart-agent ready (port $AGENT_PORT)"
        break
      fi
      sleep 0.5
    done
  else
    slog WARN start "smart-agent skipped (no free candidate port in $((BASE_PORT + 1))-$((BASE_PORT + 3)) after avoiding PORT=$PORT)"
  fi
fi

# 随会话清理（多人服务器核心诉求：关闭即零残留）：无论哪条退出路径——
# Ctrl+C(INT)、终止(TERM)、终端/SSH 会话结束(HUP)、正常退出(EXIT)——都把
# 本次拉起的子进程收干净。HUP 是此前泄漏的主洞：trap 原来只挂
# EXIT INT TERM，而 bash 默认 huponexit=off + 后台子进程不随控制终端死 →
# SSH 断开后 next/smart-agent 双双存活（实测 smart-agent 曾从上午活到晚间）。
# cleanup 幂等（kill -0 守卫），EXIT 与信号 trap 连跑无副作用；kill_all_insight
# 扫尾兜住「杀掉 npx 壳但 next-server 成孤儿」的边缘（cwd 锚定不伤他人实例）。
# SIGKILL 等暴力路径 trap 天然无效 → 由下次启动的 kill_all_insight 兜底。
# 语义组合：tmux 里跑 = 会话存续（kill tmux session 才触发清理）；
# nohup ./start.sh = 显式脱离会话语义（nohup 拦截 HUP），用户自担。
cleanup() {
  local pid label
  for label in BACKEND_PID NEXT_PID AGENT_PID; do
    pid=${!label}
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      slog INFO start "cleanup: stopping $label (PID $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
  done
  kill_all_insight
}
trap cleanup EXIT INT TERM HUP

# 端口已由上方 ensure_base_port_free 定死为 BASE_PORT（单实例不漂移）；
# smart-agent 端口由 pick 脚本避让 PORT 自选。
slog INFO start "Launching on port $PORT..."

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
      slog INFO start "Build cached — skip"
    fi
  fi
  if [ "$NEED_BUILD" = true ]; then
    mkdir -p "$SCRIPT_DIR/tmp"
    BUILD_LOG="$SCRIPT_DIR/tmp/next-build.log"
    if ! npm run build > "$BUILD_LOG" 2>&1; then
      slog WARN start "ERROR: build failed — tail of $BUILD_LOG:" >&2
      tail -n 40 "$BUILD_LOG" >&2
      exit 1
    fi
    COMPILED=$(grep -o 'Compiled successfully in [0-9.]*m\?s' "$BUILD_LOG" | head -1 | sed 's/Compiled successfully in //')
    slog INFO start "Build OK${COMPILED:+ ($COMPILED)}"
  fi
  NEXT_CMD="start"
fi

# Build the embedded export-view bundle (self-contained interactive HTML export)
npm run build:export-view >/dev/null 2>&1 || slog WARN start "export-view build failed — HTML export disabled"

if [ "$CLI" = true ]; then
  SERVER_URL="http://localhost:$PORT"

  # Start backend in background (stdout→file: avoid VSCode auto port-forward hijacking
  # the printed URL and assigning a random local port instead of 21025)
  npx next $NEXT_CMD -H 127.0.0.1 --port $PORT > "$SCRIPT_DIR/tmp/next-$NEXT_CMD.log" 2>&1 &
  BACKEND_PID=$!
  # Wait for backend to be ready
  slog INFO start "Waiting for backend (port $PORT)..."
  for i in $(seq 1 60); do
    if curl -s "$SERVER_URL/api/observe/data?pageSize=1" > /dev/null 2>&1; then
      slog INFO start "Backend ready (port $PORT)"
      # 发现契约登记：CLI 模式后端同样是可导入的实例，登记口径一致
      mkdir -p "$CANNBOT_HOME_DIR"
      echo "$PORT" > "$INSIGHT_PORT_REGISTRY"
      break
    fi
    sleep 1
  done

  slog INFO start "Launching CLI: $CLI_CMD"
  npx tsx src/cli/index.ts -- "$CLI_CMD" --server "$SERVER_URL"
  kill $BACKEND_PID 2>/dev/null || true
  slog INFO start "CLI exited, backend stopped"
else
  # 服务端输出直接上屏（终端实时看 next 自身输出与统一日志的 stdout 通道）；
  # 持久化由统一日志文件通道承担（~/.cannbot-insight/logs/），tmp/next-*.log
  # 不再留服务期副本（用户选择：文件日志已有，屏幕直出即可）
  npx next $NEXT_CMD -H 127.0.0.1 --port $PORT 2>&1 &
  NEXT_PID=$!
  if [ "$NEXT_CMD" = "start" ]; then echo "$NEXT_PID" > "$PROD_PID_FILE"; fi

  slog INFO start "Waiting for server..."
  for i in $(seq 1 30); do
    if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
      slog INFO start "Server ready (port $PORT)"
      # 发现契约登记：写入本次实例端口（持久保留，语义见定义处注释）
      mkdir -p "$CANNBOT_HOME_DIR"
      echo "$PORT" > "$INSIGHT_PORT_REGISTRY"
      # WSL: use Windows cmd.exe to open browser
      if grep -qi microsoft /proc/version 2>/dev/null && [ -x /mnt/c/Windows/System32/cmd.exe ]; then
        /mnt/c/Windows/System32/cmd.exe /c start "http://localhost:$PORT" 2>/dev/null || true
      elif [ -n "$DISPLAY" ] && command -v xdg-open > /dev/null 2>&1; then
        xdg-open "http://localhost:$PORT" 2>/dev/null || true
      elif [ "$(uname)" = "Darwin" ] && command -v open > /dev/null 2>&1; then
        open "http://localhost:$PORT" 2>/dev/null || true
      elif [ -n "$DISPLAY" ] && command -v sensible-browser > /dev/null 2>&1; then
        sensible-browser "http://localhost:$PORT" 2>/dev/null || true
      else
        slog INFO start "No graphical session — open in your local browser: http://localhost:$PORT"
      fi
      break
    fi
    sleep 1
  done

  wait $NEXT_PID
fi
