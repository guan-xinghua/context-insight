# CANNBot 使用手册（cpx 捕获代理 + insight 观测平台 + contextBay 数据集仓）

> 本手册覆盖三个组件的安装与完整使用流程：**cpx**（捕获 agent↔模型明文流量，
> 无需 insight 独立可用）、**insight**（导入分析平台，Web/TUI/CLI 三前端）、
> **contextBay**（会话数据集仓，上传/导入/baseline）。架构细节见
> `docs/architecture.md` 与 `proxy/DESIGN.md`。

```
┌─────────────────────────┐  jsonl   ┌──────────────────────────────┐
│  cpx 捕获代理 (proxy/)   │ ───────► │  insight 观测平台 (src/)       │
│  捕获 agent↔模型明文流量  │ insight UI │  导入 → 22 API → Web/TUI/CLI  │
└─────────────────────────┘  / 自动导入 └──────────────┬───────────────┘
                                                     │ 上传（治理后）/ 导入
                                                     ▼
                                      ┌──────────────────────────────┐
                                      │  contextBay 数据集仓（git 仓）  │
                                      │  范式目录 + baseline 基准       │
                                      └──────────────────────────────┘
```

**环境要求**：Node.js >= 20（有 nvm 时安装脚本自动切换）；Python 3 / 编译工具链仅
insight 需要（可选，缺失时 smart-agent 后端静默降级）。

---

## 一、安装

### 1.1 cpx 捕获代理（独立安装）

```bash
cd <insight 包目录>      # 源码仓内（如 packages/insight；npm 安装无需此步）
./proxy/install.sh        # 只装 cpx，捕获无需 insight
# 或 ./start.sh           # 一体化安装 insight 时顺带装 cpx（内部委托上面的脚本）
```

安装器：检查 Node >= 20 → 安装 proxy 自有依赖 → 把 `cpx` symlink 到 PATH。
幂等可重跑；`-u` 强制更新依赖；`CPX_BINDIR=<目录>` 自定义安装位置；不想全局装
可直接用 `./proxy/cpx-cli <命令>`。

```bash
cpx --help                # 验证安装；cpx status 查看状态（无需任何一方在运行）
```

### 1.2 insight 观测平台

```bash
# 方式 A：源码（功能最全）
./start.sh        # 首次自动 npm install + prisma migrate + 启动（约 1 分钟）
                   # 浏览器打开 http://localhost:21025

# 方式 B：npm 一键安装（无需克隆源码）
npm install -g context-insight
context-insight   # 首次自动 build + migrate，随后启动 + 开浏览器；CLI 子命令直接透传
# 国内网络可用镜像：npm install -g context-insight --registry=https://registry.npmmirror.com
# 离线/内网备选：从 GitCode Release 获取 tgz 后 npm install -g ./context-insight-<版本>.tgz
```

`start.sh` 标志：`-u` 更新依赖 / `-f` 清构建缓存 / `-a` 显示高级 tab
（wireRounds/replay）/ `-k` 历史别名（=默认：杀自家旧实例后重启）/ `-c tui`（后端 + TUI，退出即停）。
可写状态：`~/.context-insight/`（npm 形态的 SQLite 库 + 捕获产物 + 端口登记/PID 记录）；
构建缓存在各自 checkout / 安装目录的 `.next/`。两种形态关终端、断 SSH 都会当场
清干净全部子进程；npm 形态显式停止用 `ctxi --stop`（多人服务器见
`docs/multi-user-server.md`）。

---

## 二、cpx 捕获代理使用

### 2.1 捕获

原命令前加 cpx，其余完全不变，示例：

```bash
cpx claude                          # 交互式（/exit 退出）
cpx cannbot                         # CANNBot CLI（网关上游自动发现）
cpx opencode                        # opencode CLI
cpx codex                           # Codex CLI（ChatGPT 登录/API key 自动适配）
cpx claude -p "用一句话介绍自己"     # Claude Code 冒烟（非交互最快验证）
cpx opencode run -m alibaba-cn/glm-5.2 "..."   # opencode（或先 opencode providers login 后裸跑）
cpx -- aichat "..."                 # 任意 OpenAI 兼容客户端
```

工作原理（对用户透明）：cpx 起 per-session 代理并按框架注入 base_url（进程级，
退出即净，不碰 `~/.claude/`、`~/.config/opencode/`）；流量透传真实 upstream
（auth 头透传，**API key 永不落盘**，落盘前统一脱敏）；agent 退出后自动压缩 +
生成 norm/ 规范文件；**insight 在运行则自动导入并开浏览器，未运行则保留捕获**
（之后在 insight Web UI 导入，见 §2.4）。

```bash
tail -F ~/.context-insight/proxy/*.jsonl    # 另一终端实时观察捕获（.gz 用 zcat）
```

### 2.2 产物布局

```
~/.context-insight/proxy/
├── cpx-<sid>.jsonl.gz          verbatim 捕获（gzip at rest，zcat 即用）
├── cpx-<sid>.meta.json         会话级声明（框架/协议/版本，cc-session-meta）
├── <sid>/subagents/            子代理捕获 + meta.json
└── norm/                        规范化导入视图 —— insight 导入这个
    ├── <sid>.jsonl.gz
    └── <sid>/subagents/…
```

所有捕获 jsonl 同时携带声明式 `x_lake` 扩展命名空间（信封冻结 +
`{schema, version, data}` 口袋，规范见 `docs/lake-schema-spec.md`）。

### 2.3 查看捕获会话（cpx list）

```bash
cpx list              # 全部捕获会话，按时间降序（只读，不需要 insight）
```

| 列 | 内容 |
|----|------|
| TIME | 捕获文件最后修改时间（降序排列） |
| SID | 会话 id（= insight 导入后的 taskId） |
| SIZE / FILE | 实际文件与磁盘大小（明文/压缩取真实存在的那份） |
| FRAMEWORK / PROTOCOL | 会话级声明（`cc-session-meta`：claude-code / opencode / cannbot / codex…） |
| SUB | 子代理捕获数（`<sid>/subagents/`） |
| STATE | `live` 明文态（捕获进行中 / 未归档压缩）；`rest` gzip at rest |

同 stem 的明文与 `.gz` 合并显示为一条（明文优先）；空占位文件与
`.pretty.json` 调试产物自动忽略。

### 2.4 导入 insight

导入是 **insight 自身的职责**（cpx 不提供 import 子命令——避免与 insight
导入能力重复）：

- **自动**：insight 在运行时，捕获退出即自动导入并打开浏览器
- **手动**：insight Web UI 首页「Import Session → JSONL」选择
  `~/.context-insight/proxy/` 目录（支持扫描批量导）或单选某个文件；
  先用 `cpx list`（§2.3）确认要导的 sid
- 导入幂等：同 taskId 走增量合并，重复导入安全

### 2.5 状态与配置

```bash
cpx list                          # 捕获会话清单（按时间降序，见 §2.3）
cpx status [--kill [--all]]       # insight/proxy 进程 + 最近捕获 + 压缩率；--kill 清理孤儿 proxy
cpx config [dedup on|off]         # 注入压缩（默认 off，热生效，只压缩捕获不改转发）
cpx normalize [<sid>]             # 重新生成 norm/（缺省=全部，幂等）
```

---

## 三、insight 观测平台使用

### 3.1 导入数据（Web UI 首页「Import Session」）

三种源类型按钮，数据源自动识别：

| 源类型 | 覆盖范围 | 说明 |
|--------|---------|------|
| **JSONL (Claude / Proxy)** | Claude 原生 `.jsonl`（`~/.claude/projects/`，可指定目录扫描）/ cpx 捕获（`~/.context-insight/proxy/cpx-<id>.jsonl`，含目录扫描） | 导入结果带框架徽标 + 黄色 `proxy` 标 |
| **SQLite (auto)** | opencode.db / CANNBot 导出库（按库 schema 自动识别） | 一个文件按钮双覆盖 |
| **contextBay** | 数据集仓（见第五章） | 选范式 → 选会话，无需手动 clone |

### 3.2 会话分析（详情页 10 个 tab）

点击 session 进入详情页，默认 9 个 tab（`./start.sh -a` 或 URL `?a` 展开
隐藏的 2 个高级 tab）：

| Tab | 内容 |
|-----|------|
| **Overview** | 指标卡 + agent 调用图 + Skills/Agents 汇总 |
| **Turns** | 逐轮时间线 + LLM Input 重建；turn 编号（如 `#459`）回车直达；subagent turn 内联展示（带徽章）；proxy 会话按 输入/输出 成对切分 |
| **Wire 轮次**（默认隐藏） | cpx 捕获原文逐轮重组：每轮完整输入（新增高亮）与输出原文，与 DB 重建对照 |
| **Trace** | 交互 DAG（主 agent ↔ subagent 桥接链路） |
| **Context** | 上下文窗口占用曲线（per-agent 增长、模型限制线、`/compact` 压缩标记、动画回放） |
| **Audit** | 两个子 tab：**Workflow audit**（v1-v4 审计：流程框图 + 八维 skill 质量 + agent 中心三维度）与 **Skill audit**（真实执行 vs SKILL.md / agent .md / 主 agent 编排声明对账） |
| **Perf** | 耗时 Gantt + token 趋势（不依赖 LLM 审计输出） |
| **Skills** | Skill 事件、全文（SKILL.md）、覆盖度看板、agent .md 定义恢复（全文·磁盘 / 全文·会话 对照） |
| **Files** | 文件读取冗余分析、单文件复卷、整目录重编汇册（zip 下载） |
| **Replay**（默认隐藏） | 上下文回放 |

### 3.3 其他功能

- **双会话对比**：首页勾选 2 个 session → 对比 token/费用/耗时/工具/子 agent
- **AI 分析**：设置页（右上角）配置 LLM provider（OpenAI 兼容 `/chat/completions`；
  面板内嵌常见提供商 Base URL 速查，点击直接填入）
- **导出**：单 session → 独立 SQLite / 层级 Markdown / 离线 HTML
- **实时刷新**：opencode 走 5s 轮询；claude 格式（含 cpx 捕获）走 SSE，会话
  运行中无需手动刷新
- **搜索**：跨轮次关键词搜索（概念追踪），结果可按 source/thinking/tools 过滤

### 3.4 CLI / TUI

```bash
./start.sh -c tui                        # 交互式 TUI（Ink 7）
./start.sh -c sessions                   # 单次命令
npx tsx src/cli/index.ts <命令>           # 源码方式（需先 npm install + prisma migrate deploy）
```

命令：`sessions` `session` `turn` `search` `compare` `stats` `import` `delete`
`config` `analyze` `export` `export-md` `upload`（contextBay，见 §4.4）`tui`；
全局选项 `--server <url>`。后端未起时导入/上传命令自动拉起。
完整参考见 `docs/cli-commands.md`。

---

## 四、contextBay 数据集仓：上传

### 4.1 数据湖是什么

数据湖是托管会话数据集的 **git 仓**（默认远端 git 仓，
`main` 分支）。仓内布局：

```
lake/  (main)
├── <范式>/                     ← 范式目录：数据仓顶层目录即范式注册表
│   ├── <sid>/                  ← 一个会话一个文件夹（.jsonl.gz + meta + subagents/）
│   │   └── subagents/
│   └── baseline/<sid>/         ← 该范式的评分基准会话（位置即身份）
└── sessions/                   ← 存量未标注区（只读保留，列表显示「未标注」）
```

三个核心概念：

- **范式目录**：默认 25 个算子计算范式 category + `others`。**新增范式 = 在
  数据仓顶层新建一个目录**，insight 侧零范式知识；上传时必选其一（动态白名单，
  防 typo 凭空造目录）
- **baseline**：`<范式>/baseline/` 下的唯一会话即该范式的 workflow 评分基准；
  更换时原 baseline 在同一次 commit 内原子移回范式普通目录
- **同 sid 全仓唯一**：换范式重传 = 同一次 commit 内原子移动会话文件夹
  （覆盖更新语义）；内容无变化时优雅提示

### 4.2 Web UI 上传（首页 Sessions 表格）

入口：会话行操作列的**云上传图标**（Upload to contextBay）→ 弹窗「上传到 contextBay」：

1. **范式目录**（必选下拉）：动态拉取数据仓顶层目录（排除存量 `sessions/`）
2. **baseline 勾选**（可选）：「设为该范式的 baseline 会话」——已有 baseline
   会被移回范式普通目录，本会话成为评分基准
3. **提交人**（必填输入框）：真实姓名或账号
4. **内容描述**（选填输入框，预填会话首问）：一句话说明本会话做了什么；
   日志路径 / 备注（模型、时间）等溯源信息随提交自动附加，无需手填
5. **确认上传**

**三类会话均可上传**（上传格式统一为 claude-jsonl 文件夹）：

| 来源 | 上传方式 | 保真度 |
|------|---------|--------|
| proxy 捕获（cpx，含 opencode-proxy） | 原文件直传（主会话 + subagents） | **全保真**（含 wire 原文、system/tools Full Context） |
| native Claude Code 会话 | `~/.claude/projects/` 原文件直传 | 原生保真 |
| 无 jsonl 源的会话（opencode DB 导入 / v1 快照 / 源文件丢失） | insight DB 自动导出 claude-jsonl | 含 turns/toolCalls/token 级数据，**不含** system prompt / Full Context（重导入后这些面板为空） |

上传性能与库存量无关（O(新会话)，实测单条 push 秒级）；行流 gzip at rest
（仓内存 `.jsonl.gz`，读方透明解压，`zcat` 即用）。commit 提交信息由服务端
按约定格式生成，subject 自动注入「范式: <目录名>」行，`git log` 直接可读。

### 4.3 数据治理（上传强制关口）

公开仓，**密钥出仓即泄露**，故治理 fail-closed、所有待传文件一律视为不可信
输入（不因来源豁免；用户往对话里贴 key、agent 回显 env 都会被拦）：

1. **清洗**：深度遍历结构层键名 + 字符串层厂家特征（`sk-ant-` / `AIza` /
   `gsk_` / `LTAI` / `Bearer` / env 回显 / URL query）→ 只写 staging 副本，
   永不改写原文件
2. **独立复检**：疑似密钥残留 → **熔断拒绝上传**（HTTP 422）

熔断时 Web UI 在 Sessions 表格上方显示红色错误（列出文件/行号/形态，值已
掩码），该行上传按钮变 ✗；CLI/TUI 直接打印错误消息。另外单文件超 100MB
（gzip 后）同样拒绝。同 sid 捕获进行中上传 = 快照不完整，允许（git 可再传覆盖）。

### 4.4 CLI 上传

```bash
# 从 Insight DB 直接上传已导入的会话（推荐）
npx tsx src/cli/index.ts upload --session <taskId> \
  --paradigm elementwise --baseline --yes --json

# 从源文件两步走：先导入本地 Insight DB，再上传 contextBay（成功提示
# "✓ Imported & uploaded session"）
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db \
  --session-id <session-id> --paradigm elementwise \
  --description "描述" --yes --json

# 交互式（不传 --paradigm 时编号选择范式目录；提交人必填，空值循环提示）
npx tsx src/cli/index.ts upload --file ~/.claude/projects/

# 仅列出可选 session
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --list
```

| 参数 | 说明 |
|------|------|
| `--session <taskId>` | 从 Insight DB 上传（按 taskId 服务端定位，无需 framework 推断） |
| `--file <path>` | 源路径：opencode `.db` / Claude `.jsonl` 文件或目录（自动推断，导入 + 上传两步） |
| `--session-id <id>` | 指定源文件里哪个 session |
| `--paradigm <dir>` | 范式目录（不传则交互选择） |
| `--baseline` | 设为该范式 baseline |
| `--description <text>` | 提交描述 |
| `--yes` / `--json` / `--list` | 跳过确认 / JSON 输出 / 仅列举 |

后端未运行时自动拉起，命令结束自动停。tgz 安装方式下把 `npx tsx src/cli/index.ts`
换成 `context-insight` 即可。

#### CLI 上传 baseline（完整示例）

把某个会话设为范式评分基准，一条命令（描述首行 `提交人:` 必填）：

```bash
npx tsx src/cli/index.ts upload --session ses_abc123 \
  --paradigm elementwise --baseline \
  --description "提交人: 张三
内容描述: elementwise 评分基准会话" --yes
```

- 成功输出末尾显示落点：`✓ Uploaded session ses_abc123 → contextBay` /
  `Folder: elementwise/baseline/ses_abc123/`
- **换基准 = 重跑同款命令换 taskId**：新会话进 `<范式>/baseline/`，原
  baseline 在同一次 commit 内原子移回范式普通目录，无需手工干预
- 不带 `--baseline` 时交互流程会问「将 "…" 设为范式 X 的 baseline 会话？
  （已有 baseline 会被移回普通目录）」，答 `y` 效果相同
- baseline 仅默认仓可用（自定义数据湖远端不支持范式，见 §5.4）

---

## 五、contextBay 数据集仓：导入

### 5.1 Web UI 导入（首页「contextBay」源类型）

两步选择，无需手动 clone：

1. **选范式目录**：标题「选择范式目录（数据仓顶层目录）」——每个范式显示
   会话计数与「基准✓」标记；「未标注」入口进存量 `sessions/` 区；
   自定义数据湖远端跳过此步直达会话表
2. **选会话**：勾选一个或多个 → 「Import N Selected」执行导入

会话表列说明：

| 列 | 内容 |
|----|------|
| First Query | 内容描述；**baseline 会话带紫色徽标置顶** |
| Type | 会话类型徽标（OpenCode 蓝 / CANNBot 绿 / Claude 橙）+ `producer=cpx` 的捕获并排黄色 **proxy** 徽标 |
| 用户名 | 提交人（commit 元数据） |
| 时间 | commit 时间 |
| 提交信息 | N files · sid |

顶部显示当前远端 / 分支 / 范式目录，支持搜索过滤。

### 5.2 性能（为什么千级会话也不慢）

列表/下载走 **partial clone**（`--filter=blob:none`）持久镜像：列表只读
元数据秒级返回（blob 一个都不下载）；导入单条才按需下载该会话的 blob；
镜像越用越热（看过的永久缓存）。实测：热列表 <1s、导入单条 ~1s、镜像磁盘
比全量 clone 小 30×。

### 5.3 导入后的数据

导入会话在缓存物化层重排为 proxy 布局后走 claude-jsonl 管线，**比 v1 的 .db
快照多保留 Full Context**（system/tools）。重新导入的会话与普通会话无异：
10 个 tab 全部可用，也可再次上传（覆盖更新）。

### 5.4 自定义数据湖远端（设置页）

设置页「contextBay 数据之湖」区块可把远端从默认仓改为任意 git 地址（如
`https://example.com/trace_corpus`）：

| 字段 | 说明 |
|------|------|
| 地址 | 默认值为内置数据湖仓；平台子域地址自动归一 |
| 认证方式 | 令牌（仅支持 PAT）/ 账户密码 / 匿名，三选一 |
| 分支 | 默认 main；「选择」按钮拉取远端分支列表挑选 |
| 目录 | 替换默认 `sessions/` 前缀；「浏览」逐级选择，列表/导入/上传同步生效 |

- **测试连接**：真实校验地址与凭据（表单留空时验证服务端已存凭据），成功时
  区分「凭据已验证 / 凭据未能验证 / 匿名访问」；选了认证方式但凭据为空直接失败。
  「选择分支」同样消费已存凭据——私有数据仓在表单留空时也能列出分支
- 远端配置单源落服务端 lake-config.json（设置页表单即其写入入口，全机生效）；
  镜像缓存目录可用 `LAKE_CACHE_DIR` 覆盖，多远端镜像缓存按 地址+分支 隔离
- 凭据仅存浏览器 localStorage、每次请求发给本机后端做 git 认证（不入库、
  不入日志，错误消息脱敏）
- 两个限制：自定义远端**不启用范式目录**（维持 directory 单根机制）；
  语料仓现存的平铺布局（`<类别>/<月份>/<提交人>/<uuid>.jsonl`，无会话
  文件夹）不会被列出，列表/导入仅识别 `<目录>/<sid>/` 文件夹约定

### 5.5 旧版 v1（历史数据集仓）

v1 的 `.db` 快照上传/解析 API 后端保留（读取历史数据），界面不再展示。

---

## 六、典型组合场景

| 场景 | 步骤 |
|---|---|
| **只捕获，暂不分析** | `./proxy/install.sh` → `cpx claude`（捕获累积在 `~/.context-insight/proxy/`） |
| **先看看捕了什么** | `cpx list`（按时间降序，含框架/子代理/大小，无需 insight） |
| **捕获完立即看分析** | `./start.sh`（insight 在跑）→ 另一终端 `cpx claude` → 退出自动导入 + 开浏览器 |
| **事后补导入** | `./start.sh` 起 insight → `cpx list` 确认 sid → Web UI「Import → JSONL」选 proxy 目录扫描导入 |
| **SSH 远程无浏览器** | `./start.sh -c tui`；或端口转发后本地浏览器访问 21025 |
| **导入历史日志** | 首页「Import Session」选 `SQLite (auto)`（opencode.db）或 `JSONL`（Claude 原生，目录扫描） |
| **沉淀会话到数据集仓** | 会话行云图标 → 选范式目录 → 填提交人/描述 → 确认上传（治理自动把关） |
| **建范式评分基准** | 上传弹窗勾「设为该范式的 baseline 会话」；或 CLI 加 `--baseline` |
| **从数据集仓取会话** | 首页「contextBay」→ 选范式目录 → 勾会话 → Import Selected |
| **团队共享会话库** | 配置同一 git 远端（设置页「contextBay 数据之湖」，全机生效）→ 各自上传/导入 |

---

## 七、常见问题

| 问题 | 处理 |
|---|---|
| `cpx: command not found` | 新开终端（PATH 经 .bashrc 生效）；或直接 `./proxy/cpx-cli` |
| Node 版本不符 | `nvm install 20 && nvm use 20`（安装脚本有 nvm 时自动切换） |
| opencode 捕获报 "no provider to override" | 带 `-m <provider>/<model>`，或先 `opencode providers login` |
| 捕获成功但想看分析 | `./start.sh` 启动 insight → Web UI「Import Session → JSONL」选 `~/.context-insight/proxy/` 目录导入（下次捕获时 insight 已在跑则退出自动导入） |
| 端口 21025 被占 | `./start.sh -k`，或自动换端口（21025+ 递增） |
| 上传被熔断（422） | 治理检出疑似密钥残留：按错误里的 文件/行号/形态 排查会话内容，去除敏感内容后重传；**这不是 bug，是防线** |
| 上传后重导入，Wire 轮次 / Full Context 面板为空 | 该会话是无 jsonl 源的 DB 导出件（保真边界：不含 system prompt / Full Context）；要全保真请用 cpx 捕获后直传 |
| contextBay 列表/导入不显示某会话 | 检查仓内布局是否符合 `<目录>/<sid>/` 文件夹约定（平铺文件不识别）；自定义远端确认「目录」前缀配置正确 |
| 千级会话仓库会不会很慢 | 不会：列表只读元数据、导入单条按需下载 blob（partial clone），实测 2000 条热列表 ~1s |
| 想换数据仓地址 | 设置页「contextBay 数据之湖」填地址 + 认证 → 测试连接 → 保存（落服务端 lake-config.json，全机生效） |
