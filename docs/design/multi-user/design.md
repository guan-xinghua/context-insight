# 多人服务器部署（每用户单实例）— 设计

## 一、现状盘点：单例假设在哪

### 已经天然隔离的（HOME 级 / 浏览器级）

服务器上每个 SSH 用户各有 HOME，以下状态挂在 `~/.cannbot-insight/`（或浏览器），
多人场景**零改动天然隔离**：

| 状态 | 落点 |
|------|------|
| cpx 捕获 jsonl | `~/.cannbot-insight/proxy/` |
| 评分卡 | `~/.cannbot-insight/scorecards/` |
| 湖配置+凭据 | `~/.cannbot-insight/lake-{config,auth}.json` |
| AI provider key | 浏览器 localStorage（随请求带给服务端中转） |
| cpx 注入的 claude 配置 | `~/.claude/settings.json` |
| 湖镜像缓存 | HOME 级（`LAKE_CACHE_DIR` 可覆盖；代价：N 人 = N 份镜像） |

### 真正的单例耦合（4 处）

| 耦合点 | 现状 | 本设计处理 |
|--------|------|-----------|
| 端口/进程 | `BASE_PORT=21025` 硬编码（start.sh） | env 化 `CANNBOT_INSIGHT_PORT`，默认不变 |
| DB 位置 | checkout 内 `prisma/dev.db` | 不动（每人 checkout 已隔离；见 requirements 非目标） |
| .next 构建缓存 | checkout 内 | 不动（每人 checkout 已隔离） |
| cpx→insight 发现 | 硬探 `localhost:21025` | 发现契约升级（见 §二） |

### 杀伤逻辑多人安全性（已验证）

start.sh / pick-smart-agent-port.sh 的**所有**杀进程逻辑都有锚定，
每人一份 checkout 形态下 A 的清理碰不到 B：

| 杀伤点 | 锚定 |
|--------|------|
| `kill_all_insight`（next 系扫杀） | cwd 在自己 checkout 内 |
| 同上（smart-agent 扫杀） | cwd = 自己 checkout 的 `smart-agent/` 且 cmdline 为 python |
| `ensure_base_port_free` | 只盯自己的 BASE_PORT |
| pick-smart-agent-port clean 模式 | next-server + cwd 在自己包内才杀，无关进程绝不击杀 |
| 退出 trap `cleanup` | 精确 `$AGENT_PID` 等本次拉起的 PID |

## 二、发现契约（核心）

```
insight start.sh 服务就绪 ──▶ 写 ~/.cannbot-insight/insight-port（端口登记文件）

cpx 找 insight：  CANNBOT_CPX_INSIGHT_BASE env → 端口登记文件 → localhost:21025 兜底
cbi (CLI/TUI)：   --server → CANNBOT_SERVER env → config.json.server → 端口登记文件 → 21025
浏览器：          人肉书签（部署指南给端口分配建议表 + SSH 隧道姿势）
```

- 登记文件目录锚定与 `lake-config.json` 一致，写读两侧四处实现（start.sh / npm 启动器
  `registryPath()` / cpx / cbi）保持同一解析：
  `dirname(CANNBOT_PROXY_DIR)` → `CANNBOT_INSIGHT_HOME` → `~/.cannbot-insight`
  （`CANNBOT_INSIGHT_HOME` 是启动器公开数据目录旋钮，设了它则登记/库/PID 一并随迁）
- **登记文件持久保留，不随实例退出删除**：删除会在「实例未运行」窗口期让 cpx 回落 21025——
  若 21025 被别人占着，捕获会被静默导入**别人的**实例（跨用户污染）
- 残余风险与缓解：从未启动过自己实例的用户没有登记文件 → 回落 21025。
  部署指南明确：首次使用先启动一次自己的实例（写入登记），或显式 export `CANNBOT_CPX_INSIGHT_BASE`。
  （未来可选加固：实例身份指纹校验，本设计不做）
- HOME 隔离把「找到**我的**实例」天然对准；端口每人**固定**（人为约定，非自动分配），
  登记文件只解决「工具链知道我的端口」，不引入漂移

## 三、随会话清理（关闭即零残留）

### 现有双层模型与泄漏路径

退出时 trap（主路径）+ 下次启动扫杀（兜底）。主路径的洞：

| 泄漏路径 | 机制 | 修复 |
|----------|------|------|
| SSH 断开/终端关闭 | trap 只挂 `EXIT INT TERM`，**无 HUP**；且后台子进程不随控制终端死（bash 默认 huponexit=off）——实测 smart-agent 曾存活半天的机制 | trap 加 **HUP** |
| wait 提前返回等边缘 | cleanup 只杀 `$AGENT_PID`，next/CLI 后端不在清理名单 | cleanup 覆盖 `BACKEND_PID`/`NEXT_PID`/`AGENT_PID` + 调 `kill_all_insight` 扫尾 |
| kill -9 暴力杀 | trap 天然不跑 | 无法根治，维持下次启动扫杀兜底（既有） |

### 修复后全景

```
Ctrl+C (INT)        → trap → cleanup：三 PID 显式杀 + kill_all_insight 扫尾 ✅
终端关闭/SSH 断 (HUP) → 同上 ✅（核心修复）
显式停止            → ./start.sh --stop：kill_all_insight → ensure_base_port_free 确认死透 ✅
kill -9 / 断电      → 本次残留，下次启动扫杀回收 ✅（既有兜底）
```

`--stop` 跳过依赖安装/代理安装/prisma migrate（全新 checkout 上 stop 不应触发 npm install），
端口校验用同一 `CANNBOT_INSIGHT_PORT` 环境（自定义端口用户需带同样 env 调 stop）。

### 语义组合

- tmux 里跑 = 会话存续（detach 不触发 HUP，kill session 触发）——「常驻」的自助路径，不产品化
- `nohup ./start.sh` = 显式脱离会话语义（nohup 拦截 HUP），用户自担

## 四、决策记录

| # | 决策 | 理由 |
|---|------|------|
| D1 | 端口人为约定固定值，不做自动分配 | 自动分配 = 端口漂移 = 断 cpx 探测/书签 = 单实例收口（2026-09-21）明确拒绝过的方向 |
| D2 | 登记文件持久保留（退出不删） | 防「实例未运行」窗口期跨用户导入污染（见 §二） |
| D3 | 随会话语义（HUP 即清理） | 用户拍板：会话/终端结束即关闭；比常驻+显式 stop 更符合核心诉求 |
| D4 | DB 位置不动 | 每人 checkout 已隔离；HOME 化是 breaking 迁移，收益（防 git clean 手滑）不抵风险 |
| D5 | cbi 默认解析接登记文件，但 config.json 显式值优先 | 显式 > 隐式；saveConfig 只持久化显式值，防登记端口被冻结进 config.json |
| D6 | CLI 侧 `--server` 去掉 Commander 默认值 | 原默认值使 flag 恒有值 → env/config.json/登记文件永远不生效（配置分层死代码）；去掉后分层真正生效 |
| D7 | 不做实例身份指纹校验 | 登记文件持久化已覆盖主要跨用户导入面；剩余面（从未启动过实例）用部署指南约束；留作未来加固 |
| D8 | 每人一份 checkout（非共享） | 隔离最干净（cwd 锚定、.next、tmp、PID 文件全部分离）；git clone 便宜 |
| D9 | npm 启动器端口钉死 BASE_PORT：被占 fail-fast（带诊断），`-k` 杀自家旧实例再复用；`findFreePort` 退役 | 漂移断 cpx 登记发现与浏览器书签；静默起第二实例 = 同一 HOME 两套库数据静默分叉（旧默认行为最多漂 +128 且用户无感） |
| D10 | npm 形态击杀锚定：`DATA_DIR/insight.pid` 全家福（launcher/next/agents）+ 候选区间（BASE+1~+3）验明正身孤儿兜底 + `findPortOwnerPid`（/proc/net/tcp inode→fd 扫描）定位属主；BASE_PORT 仍被占 → 报错退出 | npm 流无 cwd 锚定（包目录只读）；/proc 定位对他人进程天然返回 null（权限模型）不越权；绝不代杀陌生占用者 |
| D11 | smart-agent 恒 clean：候选区间验明正身的旧 agent 一律击杀回收再起新的，复用分支整体删除 | 复用/keep 是泄漏来源（2026-09-21 实测 21026 python3 残留全天）；与 checkout 流 pick-smart-agent-port 同拍板 |
| D12 | 登记路径 `registryPath()`：`CANNBOT_PROXY_DIR` 取其 dirname、否则 DATA_DIR（= `CANNBOT_INSIGHT_HOME` 或 `~/.cannbot-insight`）；读侧 cpx `insight-discovery` / cbi `config` 同锚定（`CANNBOT_PROXY_DIR` dirname → `CANNBOT_INSIGHT_HOME` → `~/.cannbot-insight`）；PID 文件随会话退出**不删**（断电/SIGKILL 后 `--stop` 仍可凭它回收残留；陈旧无害——击杀前 kill-0 + cmdline 校验），`--stop` 成功后清除；登记持久不删 | 写读两侧锚定一致；删登记会在实例未运行窗口期让 cpx 回落 21025 跨用户导入 |
| D13 | 构建产物固定包目录 `.next`，`CANNBOT_INSIGHT_DIST_DIR` 外置特性退役（含历史垃圾路径一次性清理） | Next 16 Turbopack 强制 distDir 不许逃出项目根（Invalid distDirRoot panic）；绝对路径会被拼进包目录深处成垃圾路径且 BUILD_ID 探测落空 → 每次启动重建（2026-10-08 冒烟实测）；多人隔离靠每人各自 npm 安装 |

## 五、改动清单

| # | 改动 | 文件 |
|---|------|------|
| 1 | `BASE_PORT` env 化（`CANNBOT_INSIGHT_PORT:-21025`） | `insight/start.sh` |
| 2 | 服务就绪后写端口登记文件（web + CLI 两分支） | `insight/start.sh` |
| 3 | trap 加 HUP；cleanup 覆盖三 PID + kill_all_insight 扫尾 | `insight/start.sh` |
| 4 | `--stop` 子命令（跳过 install/proxy/migrate） | `insight/start.sh` |
| 5 | 发现契约：`resolveInsightBase()`（env → 登记 → 兜底） | `cpx/src/cli/insight-discovery.ts`（新）+ `cpx-cli.ts` 接线 |
| 6 | CLI 默认解析接登记文件 + saveConfig 只持久化显式值 + `--server` 去默认值 | `insight/src/cli/config.ts` + `index.ts` |
| 7 | 部署指南（端口分配表、SSH 隧道、红线、升级） | `insight/docs/multi-user-server.md`（新） |
| 8 | 文档同步 | `AGENTS.md`/`CLAUDE.md`/`docs/design/README.md`/两包 CHANGELOG |
| 9 | 固定端口 fail-fast + `-k` 杀自家旧实例（`findFreePort` 退役、`findPortOwnerPid` 新增） | `insight/bin/cannbot-insight.mjs` + `bin/ports.mjs` |
| 10 | `--stop` 子命令：PID 全家福击杀 + 候选区间孤儿兜底 + 端口释放验证（不代杀） | `insight/bin/cannbot-insight.mjs` |
| 11 | spawn 后落 `insight.pid`；就绪后写端口登记（发现契约写侧补齐）；信号清理补 SIGHUP + TERM→KILL 升级；smart-agent 恒 clean | `insight/bin/cannbot-insight.mjs` |
| 12 | distDir 外置退役（构建回包目录 `.next`）+ 历史垃圾路径一次性清理 | `insight/bin/cannbot-insight.mjs` + `next.config.ts` |
| 13 | 启动器多人 IT（--stop 锚定/孤儿回收/不代杀/fail-fast/源断言）+ `findPortOwnerPid` IT | `insight/tests/ut/launcher-multi-user.test.ts`（新）+ `launcher-ports.test.ts` |
| 14 | 品牌翻转补 `/.cannbot-insight` 斜杠形态规则（bash `$HOME/...` 路径漏翻 = 哨兵红） | `insight/scripts/pack-context.mjs` |
| 15 | npm 形态部署章节 + 契约/指南同步 | `insight/docs/multi-user-server.md` + `AGENTS.md`/`CLAUDE.md` + `install-usage-guide.md` |

## 六、红线

- 服务保持 `-H 127.0.0.1`，**禁止绑 0.0.0.0**（API 无鉴权 + import-file 接受任意路径）
- 远程访问一律 SSH 隧道（`ssh -L 21025:localhost:<自己的端口> user@server`——
  本地 21025 映射远端自己端口，浏览器/cpx/cbi 全部零配置继续工作）
- 杀伤逻辑必须保持锚定（cwd / 端口 / 精确 PID；npm 形态：PID 文件 / 端口 / `/proc` 属主），任何新增清理不得无差别 pkill；BASE_PORT 被陌生进程占用时一律报错退出，绝不代杀

## 七、npm 全局形态（cbi 启动器）补齐

checkout 流的击杀锚定（cwd + 端口 + shell 变量 PID）在 npm 全局安装形态全部失效：
包目录只读、无 checkout、启动器退出后无人持有 PID。第二轮补齐把这些锚定换成
「文件 + `/proc`」双锚，并把 checkout 流已验证的语义（固定端口 / `-k` / `--stop` /
随会话清理）原样搬过来：

| 关注点 | npm 形态实现 |
|--------|-------------|
| 击杀锚定 | ① `DATA_DIR/insight.pid` 全家福（launcher/next/agents/port/savedAt，spawn 后立即落盘——SIGKILL/断电后残留子进程仍可凭它回收）② smart-agent 候选区间（BASE+1~+3）验明正身（`/health` 服务标识）+ `findPortOwnerPid`（/proc/net/tcp inode→fd）定位属主的孤儿兜底 ③ 端口释放验证：仍被占 = 别人的实例，报错退出 |
| PID 复用防御 | 击杀前校验 `/proc/<pid>/cmdline` 形态（next / server.py / 启动器名）；他人进程定位不到属主时避让而非击杀（权限模型天然不越权） |
| 信号清理 | INT/TERM/**HUP** 统一异步 cleanup + 防重入；TERM 3s 宽限后 SIGKILL 升级（next-server 无视 SIGTERM 实测）；next 自身退出也走 cleanup |
| smart-agent | 恒 clean（见 D11），`CANNBOT_AGENT_URL` 只指向本次启动的实例 |
| 端口登记 | `registryPath()`（见 D12），与读侧锚定一致 |

冒烟（仿真 npm 安装目录 + 隔离 HOME + 预埋假孤儿 agent）实测修掉三个坑，记录于此防回潮：

1. **killPidList 裸数字条目**：`[nextProc.pid]`（number）被 `{pid, group}` 解构后
   `pid === undefined` 静默跳过 → SIGHUP 后 next 残活。修复：归一化同时接受
   number（单杀）与对象（组杀），跳过时如实告警。
2. **distDir 外置翻车**：Next 16 Turbopack 拒绝项目外 distDir；绝对路径被
   `path.join` 拼进包目录深处（`<PKG>/home/<user>/.cannbot-insight/.next` 这类
   垃圾路径），启动器自己的 BUILD_ID 探测永远落空 → 每次启动全量重建。修复：D13。
3. **品牌翻转斜杠形态漏翻**：bash 里 `$HOME/.cannbot-insight/proxy`（引号/波浪线
   规则都够不到）在 context 变体里原样保留 → 泄漏哨兵红。修复：规则表补
   `/.cannbot-insight` 形态（改动清单 #14）。
