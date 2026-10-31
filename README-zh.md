# Context-Insight

LLM 编码 Agent 的 Session 级可观测工具：导入 agent 会话日志，逐轮分析 token、上下文、子代理与技能使用。

**[English Documentation](README.md)**

## 功能介绍

导入 SQLite（opencode.db）或 JSONL（Claude 原生 / Codex 原生 `rollout-*.jsonl` / DSH 原生 `session.v4.jsonl`（含 `.zstd`）/ cpx proxy 捕获，明文与 `.jsonl.7z`、存量 `.jsonl.gz` 均可，`cpx-` 前缀自动处理），进入 session 详情页的多个分析 Tab。JSONL 是单一「JSONL (auto)」入口，按文件内容自动识别 Claude / Codex / DSH，无需按框架选择：

- **Token 与费用** — 每轮 token 五项拆解，按模型上下文窗口显示占比，估算费用
- **上下文增长** — 逐 subagent 的上下文增长曲线与动画回放，`/compact` 压缩点标注
- **活跃 / 墙钟** — 会话详情 Wall Clock 拆分（活跃 + 非活跃 = 墙钟）与首页 Active / Wall 列：事件聚类口径（间隔 >5min 计非活跃、API 调用进行中计活跃）
- **上下文治理** — 查看每轮 LLM 输入构成：可见消息 + 稳定 System 开销
- **Subagent 追踪** — 识别子代理会话与 dispatch→response 链路，时间线内联展示
- **Turn 快速跳转** — Turns 时间线输入 `#459` 回车直达该轮
- **Wire 轮次**（proxy 捕获）— 逐轮重组完整 wire 输入/输出，与 DB 重建对照；`-a` 启动显示
- **Skill 事件 / 覆盖度 / 全文** — 每轮 skill 事件、可用 skills 全集对照使用情况、SKILL.md 全文重建
- **Agent 定义恢复** — 子代理 `.md` 定义一键取全文：会话内 system 注入优先，磁盘扫描兜底
- **概念追踪** — 跨轮关键词搜索、传播链路与 DAG 图，结果可按来源/thinking/工具过滤
- **文件读取分析 / 内容复卷 / 重编汇册** — 重复读取检测、单文件逐行重建、整目录重建打包下载
- **Session 对比** — 两会话的 token / 费用 / 耗时 / 工具 / 子代理对比
- **轨迹评分** — 六维评分卡（完成度否决维 / 行为可信 / 质量 / 效率 / 冗余 / 自主性 + 自定义维度），支持基线对比与评分配置 profile；除网页「Mate Agent 评审」（规则层进程内直算 + 本地 claude/opencode CLI 判 LLM 子项）外，同一套评分可完全脱离服务进程独立执行：`ctxi score --session <taskId> --tool claude|opencode [--framework fw] [--out result.jsonl] [--no-store]` 直接读本机库，NDJSON 事件流（meta / progress / done / error）写 stdout 或文件，默认与网页路径落同一张评分卡
- **Audit** — Workflow 审计（流程框图 + 节点问题 + 优化优先级）与 Skill 审计（真实执行 vs SKILL.md / agent 定义 / workflow 声明对账，含声明覆盖总览——对账时刻的**声明原文快照**整篇呈现，三色直接涂在文本上：绿=已触达、黄=有规则未验证、灰=未抽出指令，hover 色块看该段指令摘要；指令覆盖与文本覆盖双指标同屏分报）
- **密钥脱敏**（proxy 捕获）— API key 永不落盘：落盘入口统一打码（`前4…后4`）
- **数据仓上传** — 主页列表行 / 会话页标题栏把会话上传数据仓：密钥治理后按范式目录归档，支持 baseline 基准位与任务结果标注；proxy 捕获行可勾选「同步上传本机原生会话」——自动定位同一场对话的原生记录（已导入行直取；本机磁盘按框架发现：Claude / opencode / DSH 按会话 id，Codex 按捕获时间窗 + 首问锚点），未导入的先自动导入，与捕获一并落 `<sid>.native/` 同 sid 双记录（Codex 原生会话 id 不同，以自己的 id 落位）；CLI 同款 `--with-native`；git-lfs 缺失时自动安装——任一数据仓动作即在后台预热自举（GitHub 直连慢时自动回退公共镜像，sha256 pin 校验；更名前旧数据目录里的同版本私有件直接复用），LFS 模式上传/导入零手工安装

主页 Sessions 列表支持关键词 / sessionID 搜索；导入对话框提供常用路径一键直达。

**Run 观测** — 与 Sessions 并列的 Runs 一级域，观测 Opsbot graph 运行：网页「导入 Bundle」（与 Import Session 同款弹窗：目录浏览找包，含 `workflow.json`/`manifest.json` 的 bundle 目录高亮、点击即导入）或 `ctxi import-bundle <dir>` 导入 workflow-bundle 目录（`workflow.json` + `sessions/`）；同一弹窗也可直接从数据仓导入（来源切换：本地目录 / 数据仓，与 Import Session 同款两阶段流——先选数据仓顶层目录、再在目录内过滤/勾选 bundle 包，批量导入并逐项显示进度）；成员会话即时全量走标准管线入库——**run 导入的会话只在 run 详情内查看，不进 Sessions 列表**（删除 run 会同时删除由它导入的会话，导入前已存在的会话不受影响）；run 页在与全站一致的工作台内以纯 SVG 渲染多代 DAG（回滚代带、重试历史、carried/未运行占位、生成器子图）——正交电路风走线（统一右行/下行，不向左折）——交叉处 PCB 半圆跳线（交叉不相连）、点击节点点亮关联边跑马灯（状态色加粗 + 流动光点，其余边压暗静止，点击空白熄灭）、Ctrl/⌘+滚轮以光标为锚缩放、拖拽平移与一键适配——节点侧栏提供逐次尝试（验收结论、Bash 输出）与成员会话 turn 下钻；session 页显示 run 归属徽标可反向返回。`ctxi runs` 列出已导入 run。导入后可从 runs 列表行（或 run 详情页头）把 run 上传到数据仓：填提交人/内容描述，整包（manifest、体检报告、成员会话）由 insight 装配（成员会话从本地库重导出、统一压缩、全量密钥清洗，同名包重传整体替换）推到数据仓 `opsbot-bundle/` 专区；数据湖 viewer 侧栏的 opsbot-bundle 分区可浏览数据仓里的包并一键导入本地。

**运行日志** — 服务端过程日志（导入管线、数据之湖同步、API 错误）按天滚动写入 `~/.context-insight/logs/insight-<日期>.log`，可选同时输出到启动终端。级别与「写入文件 / 输出到屏幕」开关在「设置 → 运行日志」即时调整（日志位置同页展示，免重启）；环境变量（`CONTEXT_LOG` / `CONTEXT_LOG_LEVEL` / `CONTEXT_LOG_FILE` / `CONTEXT_LOG_STDOUT` / `CONTEXT_LOG_DIR`）优先于设置页。

## 安装与使用

### 方式零：npm 一键安装（推荐）

```bash
npm install -g context-insight
context-insight            # 首次：自动 build + migrate（约 30s-2min），随后启动 + 开浏览器
```

- 需 Node.js >= 22.12；国内网络可加 `--registry=https://registry.npmmirror.com`
- 离线环境可用 tgz：`npm install -g ./context-insight-<版本>.tgz`
- 可写状态集中在 `~/.context-insight/`；默认端口 21025（占用自动顺延）
- CLI 子命令直接透传：`context-insight upload --file … --list` / `sessions`；短别名 `ctxi`
- Python 3 可选（存在则启动 smart-agent 分析后端，缺失静默降级）
- 别名品牌：`npm install -g cannbot-insight` —— 同一工具以 CANNBot-Insight 品牌名发布（命令 `cannbot-insight` / `cbi`，数据目录 `~/.cannbot-insight/`）；会话数据与 context-insight 完全互通（共享同一格式标识）

| 标志 | 作用 |
|------|------|
| `-a`, `--advanced` | 显示高级 tab（wireRounds/replay） |
| `-k`, `--kill` | 停掉本仓所有 insight/smart-agent 实例后从 21025 启动（被他方占用时顺延下一个空闲端口） |
| `-f`, `--fresh` | 清空构建缓存重建 |
| `-h`, `--help` | 打印完整 CLI 参考 —— 全部子命令与旗标（含 `-v, --version` 版本输出） |

### 方式一：源码运行 Web UI

```bash
./start.sh              # 生产模式（默认）：构建缓存复用 + 请求零编译
./start.sh -u           # 更新依赖后启动
./start.sh -f           # 强制重新构建
./start.sh -d           # dev 模式（改源码热重载时用）
```

- 需 Node.js >= 22.12；`./start.sh` 同时安装 cpx 捕获命令（详见 `../cpx/README.md`）
- 浏览器打开 `http://localhost:21025`

日志文件位置：
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/`（目录自动扫描）
- Codex: `~/.codex/sessions/`（rollout 文件；子代理会话自动并入主会话）
- DSH: `~/.dsh/sessions/`（`session.v4.jsonl` / `.jsonl.zstd`；子代理会话自动并入主会话）

Web UI 还支持：导出 session 为独立 SQLite 或 Markdown。LLM 接入面板内置常见提供商 Base URL 速查。

### 方式二：CLI 导入 + Web 分析

适用于 SSH 远程等无浏览器环境（首次需 `npm install` + `npx prisma migrate deploy`，之后导入命令自动拉起后端）：

```bash
# opencode：列出 / 指定导入 / 交互选择
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --list
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --session-id <id> --yes --json

# Claude Code：目录扫描 / 单文件
npx tsx src/cli/index.ts upload --file ~/.claude/projects/ --list
npx tsx src/cli/index.ts upload --file ~/.claude/projects/<hash>/<uuid>.jsonl --session-id <uuid> --yes --json

# Codex：原生 rollout 文件（子代理会话自动并入主会话）
npx tsx src/cli/index.ts upload --file ~/.codex/sessions/ --source codex-jsonl --list
npx tsx src/cli/index.ts import --source codex-jsonl --dir ~/.codex/sessions/ --all --yes --json

# DSH：原生会话日志（子代理会话自动并入主会话）
npx tsx src/cli/index.ts upload --file ~/.dsh/sessions/ --source dsh-native --list
```

| 参数 | 说明 |
|------|------|
| `--file <path>` | 源路径（.db / .jsonl / 目录，类型自动推断） |
| `--session-id <id>` | 指定 session（跳过交互） |
| `--description <text>` | 提交描述 |
| `--with-native` | 捕获行上传后同步上传本机原生会话（`<sid>.native/` 双记录） |
| `--yes` / `--json` | 跳过确认 / JSON 输出（脚本友好） |
| `--list` | 仅列出可选 session |
