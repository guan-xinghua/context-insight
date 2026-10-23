# 多人服务器部署指南（每用户单实例）

> 一台服务器、多个工程师、各看各的会话。设计依据见 [design/multi-user/](design/multi-user/)。
> 适用规模：≤5 人。更大规模或需要「互相看会话」的共享库场景不在本指南范围（那是单实例多用户的团队服务形态）。

## 模型一句话

**每人 = 一个系统账号 + 一份 git checkout（或一份 npm 全局安装，见 §五）+ 一个固定端口。**
数据（SQLite 库、捕获、评分卡、湖配置与凭据）全部随账号 HOME / checkout 隔离，
互不可见；团队共享的数据走数据湖（contextBay），本来就不依赖 insight 实例共享。

已经天然隔离（无需任何操作）：

| 数据 | 位置 |
|------|------|
| cpx 捕获 | `~/.context-insight/proxy/` |
| 评分卡 | `~/.context-insight/scorecards/` |
| 湖配置+凭据 | `~/.context-insight/lake-config.json` / `lake-auth.json` |
| AI 密钥 | 各自浏览器 localStorage（不落服务器） |
| insight 库 | checkout 形态在各 checkout 内 `prisma/dev.db`；npm 形态在 `~/.context-insight/insight.db` |

## 一、首次部署（管理员做一次）

1. 每人一个系统账号（各自 HOME），`git clone` 一份仓库到各自目录。
2. 商定端口分配并写入每人 shell profile（`~/.bashrc`）：

   | 用户 | 端口 | profile 追加 |
   |------|------|--------------|
   | alice | 21201 | `export CONTEXT_INSIGHT_PORT=21201` |
   | bob | 21206 | `export CONTEXT_INSIGHT_PORT=21206` |
   | … | …（每人间隔 ≥5） | … |

   端口避开常用段即可，**每人固定**（不要自动找空位——端口漂移会断
   cpx 自动导入和浏览器书签）。相邻用户间隔 ≥5：smart-agent 的候选
   区间是 BASE+1~+3，相邻分配会把别人的 next 端口抢掉、导致对方启动
   直接报端口占用。
3. 各自首次启动：`./start.sh`（自动 install/build/迁移）。首次启动成功后，
   端口会登记到 `~/.context-insight/insight-port`，此后 cpx / ctxi 全自动对准
   **你自己的**实例，零配置。

> ⚠️ **先启动、再捕获**：从未启动过自己实例的用户没有端口登记文件，
> `cpx` 会回落默认 21025——那可能是别人的实例，捕获会被导入别人的库。
> 保证「每人先跑过一次 `./start.sh`」即可规避；也可显式
> `export CONTEXT_CPX_INSIGHT_BASE=http://localhost:<你的端口>` 双保险。

## 二、日常使用

```bash
./start.sh            # 启动（前台跑）
Ctrl+C                # 停止：实例 + smart-agent 全部清干净
./start.sh --stop     # 显式停止（效果同上，用于脚本/别名场景）
```

**随会话语义**：实例跟着启动它的终端/SSH 会话走——关终端、断 SSH、
Ctrl+C 都会当场清理全部子进程，不留残留（2026-09 之前 smart-agent
残留半天的病根已堵：清理 trap 现在覆盖 HUP）。想在服务器上「一直开着」，
用 `tmux` 挂着跑（detach 不触发清理，kill 掉 tmux session 才清理），
**不要**用 nohup（脱离会话语义，退出不再自动清理）。

## 三、远程访问（从自己电脑用浏览器）

服务只绑 `127.0.0.1`，**不要改成 0.0.0.0**（API 无鉴权，且导入接口接受
服务器本地任意路径——开到局域网等于裸奔）。用 SSH 隧道：

```bash
ssh -L 21025:localhost:21201 alice@server    # 本地 21025 → 服务器上自己的实例
```

然后本机浏览器开 `http://localhost:21025`——本地 cpx / ctxi 的默认地址
也直接可用，零额外配置。

浏览器跨源防护：服务端对所有 API 请求校验浏览器来源（`src/proxy.ts`），
非本机页面发起的跨源请求一律 403 拒绝（防恶意网页借本地端口触发导入等
写副作用）；CLI / TUI / cpx 自动导入等非浏览器调用不带 Origin 头，不受
影响。SSH 隧道下浏览器地址是 `localhost`，属同源放行范围。

导入路径白名单（可选）：默认任意位置可导入（本地自用功能）。合规要求
收紧时设置环境变量 `CONTEXT_INSIGHT_IMPORT_ROOTS`（逗号分隔的目录，
支持 `~`）——设置后导入/浏览接口只接受白名单根内的路径，数据主目录
（`~/.context-insight`，cpx 捕获落点）恒放行，cpx 自动导入不受影响。

## 四、升级

各自执行：`git pull && ./start.sh -u`（先 `--stop` 或 Ctrl+C 停掉旧实例）。
每人自己的 checkout，互不影响；升级期间别人的实例不受干扰。

## 五、npm 全局安装形态（`context-insight` / `ctxi`）

不想 checkout 源码的用户直接用 npm 包，多人语义与本文完全一致
（固定端口不漂移、随会话清理、端口登记发现、相邻间隔 ≥5 全部同款）：

```bash
npm install -g context-insight   # 或内网 tgz / context-insight 品牌变体
ctxi                              # 启动（首次自动构建，二次启动跳过构建秒起）
Ctrl+C                           # 停止：实例 + smart-agent 全部清干净
ctxi --stop                       # 显式停止；断电/SIGKILL 后的残留也靠它回收
```

与 checkout 形态的差异只有数据落点：

| 关注点 | checkout（`./start.sh`） | npm（`ctxi`） |
|--------|--------------------------|--------------|
| 「各自一份」的是什么 | git checkout | npm 安装目录（各自 HOME 或 NVM——**不要多人共享同一全局目录**，构建产物会互相覆盖） |
| insight 库 | checkout 内 `prisma/dev.db` | `~/.context-insight/insight.db` |
| 构建产物 | checkout 内 `.next/` | 安装目录内 `.next/`（升级重装自动重建，正常现象） |
| 端口被占 | `./start.sh --stop` 清残留；仍占按报错 PID 处理 | 同左（`ctxi --stop`）；端口绝不静默漂移 |

端口登记（`insight-port`）与 PID 记录（`insight.pid`）都在 `~/.context-insight/`，
cpx / ctxi 的自动对准逻辑与 checkout 形态完全共用。注意同一 HOME 只跑一个实例
（`insight.db` 单写者）：想换端口先 `ctxi --stop`；同一 HOME 起第二个端口
= 两套库数据静默分叉，不要。

## 六、常见问题

| 现象 | 处理 |
|------|------|
| 启动报端口被占 | `./start.sh --stop`（npm 形态 `ctxi --stop`）清残留；仍占用说明是无关进程，按报错里的 PID 处理 |
| cpx 显示 up 但捕获进了别人的库 | 你的实例没启动过（无端口登记）→ 先 `./start.sh`，或显式 export `CONTEXT_CPX_INSIGHT_BASE` |
| ctxi 连错实例 | 同上；曾手动 `ctxi config set server <url>` 的话该值优先于端口登记（显式 > 隐式），想恢复自动发现就删掉 config.json 里的 `server` 键（历史版本 `config set` 会误把默认 `http://localhost:21025` 写进 config.json；新版已自动忽略等于默认值的存量 server，不再压制端口登记） |
| 想看别人的会话 | 不要共用实例——上传到数据湖，用 contextBay Viewer 看共享视角 |
