# 多人服务器部署（每用户单实例）— 测试计划

## 单元测试（ut，随 `npm run test` / cpx `run-tests.sh`）

### cpx：发现契约（新 `tests/ut/insight-discovery.test.ts`）

| 用例 | 断言 |
|------|------|
| env 优先 | `CANNBOT_CPX_INSIGHT_BASE` 设置时，即使登记文件存在也用 env 值 |
| 登记文件命中 | 无 env + 登记文件写有效端口 → `http://localhost:<port>` |
| 登记文件锚定 | `CANNBOT_PROXY_DIR` 指向自定义目录 → 从其父目录读登记文件 |
| 登记文件损坏 | 内容非数字 / 0 / 负数 / 65536+ / 空文件 → 回落默认 21025，不抛 |
| 无登记文件 | 缺文件 → 默认 21025 |

（HOME 隔离：`vi.stubEnv` + 临时目录，测后还原；解析函数每次调用现读 env，可安全 stub）

### insight：CLI 配置解析（扩展 `tests/ut/cli/unit/config.test.ts`）

| 用例 | 断言 |
|------|------|
| 分层顺序 | flag > `CANNBOT_SERVER` env > config.json.server > 登记文件 > 默认 21025 |
| 显式值压制登记 | config.json 有 server 时，登记文件不生效（显式 > 隐式） |
| 登记文件回落 | 三层显式来源皆无 + 登记文件有效端口 → 用登记端口 |
| saveConfig 不冻结 | 无显式 server 时 `saveConfig({theme})`，写出的 config.json **不含** server 键（登记端口不被顺带持久化） |
| 损坏登记 | 非法内容 → 默认值，不抛 |

### insight：npm 启动器（新 `tests/ut/launcher-multi-user.test.ts` + 扩展 `tests/ut/launcher-ports.test.ts`）

行为用例（真实进程 + 真实 socket）：

- `findPortOwnerPid`：自建监听 → 属主 = 当前进程；释放后 null（launcher-ports）
- `--stop` 按 PID 文件击杀全家福：`exec -a` 伪造 next/agent（cmdline 形态校验命中）+ 已死 launcher PID（kill-0 守卫跳过不误伤复用者）→ 停止后死透、记录清除
- `--stop` 候选区间孤儿 smart-agent 兜底回收：假 agent 必须**独立子进程**起（测试进程内起会让属主定位指到 vitest worker 自己）
- `--stop` 端口被陌生进程占用 → exit 1 且占用者毫发无损（占用者是 in-test server，误杀 = 测试进程被杀，双重负向锁）
- 默认启动端口被占 → fail-fast exit 1，不 migrate / 不 build / 不漂移

源断言（防回归锁）：SIGHUP 挂载、`registryPath()` 登记、`insight.pid` 全家福、
`findFreePort` 绝迹（固定端口语义）、`startSmartAgentClean`（复用路径绝迹）、
SIGKILL 升级路径。

时序坑（写新用例必读）：`spawnSync` 期间测试进程收不到 SIGCHLD，被杀子进程
先以**僵尸态**存在（`kill(pid, 0)` 仍成功）——死亡断言必须轮询等待收割
（`eventuallyDead`），立刻断言会误判存活。

## e2e（insight `tests/e2e/`，单跑）

### start.sh 行为（新 `start-sh-stop.test.ts`，hermetic：脚本拷贝到临时目录跑）

| 用例 | 断言 |
|------|------|
| `--stop` 击杀自家实例 | 伪造 cwd 在临时目录的 next 系进程（`exec -a next-server`）→ `--stop` 后进程死亡 |
| `--stop` 幂等 | 无实例运行时 exit 0 |
| `--stop` 不触发安装 | 临时目录无 node_modules/package.json，`--stop` 快速返回（不 npm install / migrate） |
| 自定义端口 | `CANNBOT_INSIGHT_PORT=<未占用端口>` 生效（stop 后端口校验通过） |

### start.sh 源断言（同文件，防回归锁）

- `trap cleanup EXIT INT TERM HUP`（随会话语义，HUP 是核心修复）
- `BASE_PORT="${CANNBOT_INSIGHT_PORT:-21025}"`
- cleanup 覆盖 `BACKEND_PID`/`NEXT_PID`/`AGENT_PID` 三变量
- 服务就绪分支写 `"$INSIGHT_PORT_REGISTRY"`
- `--stop` 分支先于 smart-agent 拉起

## 手工验收（不可自动化，部署指南附）

1. 真实 SSH 断开：`./start.sh` → 断网/关终端 → 重连后 `pgrep -f next-server`（cwd 本包）应为空
2. 双用户互不误杀：A 重启实例，B 的实例（不同 checkout/端口）不受影响
3. cpx 零配置对准：B 用户 `cpx status` 显示 `up http://localhost:<B 的端口>`
4. SSH 隧道：本机 `ssh -L 21025:localhost:<远端自己端口>` 后，本机浏览器/cpx/cbi 默认地址直接可用
5. 单人本机回归：不设任何新 env，行为与升级前一致（端口 21025、清理语义增强但无感知差异）
