# CANNBot-Insight

LLM 编码 Agent 的 Session 级可观测工具。辅助长上下文分析、模型幻觉问题治理，以及 Agent Session 中上下文窗口增长的监控与优化。

**[English Documentation](README.md)**

## 功能介绍

导入 SQLite（opencode.db / CANNBot-Insight 归档，自动识别）或 JSONL（Claude 原生 / cpx proxy 捕获）日志，逐轮分析 Agent Session。明文 `.jsonl` 与压缩态 `.jsonl.gz`（cpx 退出压缩形态）在文件浏览 / 手输路径 / 目录扫描三处全部放行，proxy 的 `cpx-` 文件名前缀自动剥——手工导入与捕获退出的自动导入落同一 taskId。Import Session 的 File Path 下方提供常用默认路径一键直达按钮（免逐级 Browse）：JSONL 源含「cpx proxy 捕获 → `~/.cannbot-insight/proxy`」「Claude 原生 → `~/.claude/projects`」，SQLite 源含「opencode 数据 → `~/.local/share/opencode`」，另有「主目录」；`~` 由服务端 browse 接口按当前用户展开；主页 Sessions 列表支持 keyword / sessionID 搜索（`?q=` 服务端过滤 taskId/query/label，回车或按钮提交、Clear 回全量、命中显示 N of M）；SQLite 载入后的会话选择表同款过滤（全选作用于当前过滤视图）：

- **Token 与费用** — 每轮 token 五项拆解柱状图，按模型上下文窗口显示占比；根据使用量和模型定价估算费用
- **上下文增长** — 按 subagent session 展示上下文增长曲线；动画回放 context window 变化过程，含 subagent 生成/消亡标记；`/compact` 压缩标记与上下文下降标注，支持多次压缩
- **上下文治理** — 查看 LLM 输入上下文组成：可见消息 + 稳定的 "System (hidden)" 开销；输入窗口在每个 `/compact` 边界正确截断
- **Subagent 追踪** — 识别 subagent session 与 dispatch→response 链路；subagent turn 在 Turns 时间线内联展示（带徽章），数量显示在 Overview 卡片
- **Turn 快速跳转** — 在 Turns 时间线输入 turn 编号（如 `#459`）回车即可直达该轮次并滚动到视图；subagent turn 自动展开祖先 dispatch lane
- **Wire 轮次（proxy 捕获）** — 直接读 cpx 捕获文件逐轮重组：每个 wire round 展示完整输入（累积 messages，本轮新增高亮）与输出（response 原文），与 DB 重建的 LLM Input 对照；tab 默认隐藏，`./start.sh -a` 启动才显示
- **密钥脱敏（proxy 捕获）** — API key 永不落盘：在唯一落盘咽喉对敏感字段与各厂家键形（`sk-ant-` / `AIza` / `gsk_` / `LTAI` / `Bearer` 凭据 / env 回显 / URL query）统一打码（`前4…后4`），cpx 启动日志同源掩码
- **Round-Pair 切分（proxy 捕获）** — proxy session 的 Turns 按每轮 输入/输出 成对切分（时间线带 输入/输出 徽章）：输入 turn 逐条展示本轮新增的 verbatim wire 消息，输出 turn 的 LLM Input 存储并直接返回原始累积请求，wire 顺序（含 tool_result 与 system 注入的先后）精确保留，无需重建
- **Skill 事件** — 跟踪每轮 skill load/invoke/use 事件
- **Skill 覆盖度** — claude 格式来源（claude/opencode/codex 的 proxy 捕获 + native claude-code 会话）展示：落盘的系统注入（捕获件的 wire verbatim 系统提示 / native 会话的 system 行注入）里的可用 skills 全集对照会话实际使用，未使用 skills 置顶强调（圆环中心计数 + 首位排序），已使用的按 调用 / 仅加载 / 子代理派发 / 全集外 区分；native opencode 会话（系统提示不落盘）不显示该看板
- **proxy 捕获分类** — 统一分类器（`src/lib/ingest/proxy-classify.ts`）作为 proxy 判定单一权威源：信号优先级 `cc-session-meta`（文件级权威）> 行级 `source` 标记 > wire 指纹（顶层 `system`/`tools`，兜底早期无标记产物）；agent 归属覆盖 claude-code / opencode / codex / cannbot；一切 proxy 捕获（无论 agent 归属）均按 claude 格式 jsonl 处理 wire 轮次 / full-context / 增量刷新。`cpx cannbot` 一键捕获 CANNBot CLI（opencode 系 fork，网关上游自动发现，`../cpx/CANNBOT-DESIGN.md`）
- **Skill 全文（SKILL.md）** — Skill Summary 与 Skills per Agent 每个 skill 均可点击，取原生 Skill 工具注入内容或 SKILL.md 读取结果重建全文，支持下载
- **Agent 定义恢复（agent .md 全文）** — Skill Summary 每个子代理行提供**单一「全文」按钮**取被派发 agent 的 `.md` 定义，两级优先：**会话恢复为主**（会话捕获的子代理运行时 `system` 注入——即当时真正生效的声明原文，文件事后被改/被删仍逐字节还原历史原貌，多插件同名天然无歧义：注入的就是当时加载的那份），仅当会话内无该 agent 注入数据时（如 opencode 工作流派发的 general 子代理）**兜底磁盘扫描**（`AGENTS_SCAN_ROOT` 当前文件，按会话派发覆盖消歧）。展开面板以〔会话恢复〕/〔磁盘兜底〕徽标标识实际命中路径，支持下载
- **概念追踪** — 跨轮次关键词搜索，查看传播链路和 DAG 图；搜索结果支持按 source（用户/模型/子agent 等）、thinking、tools 二次过滤；点击结果的 View Turn 跳转到 Turns tab，自动展开并高亮关键词至匹配位置（内容 / 工具参数 / 结果 / 错误）
- **文件读取分析** — 分析文件读取冗余，检测重复和不必要读取
- **文件内容复卷（循迹复卷）** — 每个文件行一个按钮，按时间戳逐行重建该文件全部内容（最后写入胜），未采集到的行标注 `--line N not found --`，支持下载
- **重编汇册（Gather & Rebuild Directory）** — 一键按时间戳逐行重建本会话工作目录下全部被读/写文件，保留路径树；打包下载 zip（纯 JS STORE，无第三方依赖）
- **Session 对比** — 对比两个 session 的 token、费用、耗时、工具调用和 subagent
- **轨迹评分 v2（六维评价体系）** — session 详情页「Score」tab（也可直接访问 `/scoring/<taskId>`），按结果导向的六维评分：**D1 完成度**（否决维；结束原因门（截断=整卡中止）+ TodoWrite 自报 + 计划对账 + 白名单验证出三态，LLM 验收清单/目标覆盖只把"无法判定"升级；**未完成 → 总分 0**——是处分不是测量、不进基线语料，其余维度照常评供诊断）、**D2 行为可信**（加权 15%；规则层自研 shell 拆分查破坏性操作、敏感信息只判落盘与外传、越权访问；LLM 层红线对账 + 授权/规避复核——确凿违规**该维归 0 不再翻桌总分**，疑似每次 −0.2 只披露）、**D3 完成质量**（35%；**CANN-Bench 评分**——用户填报 CANN-Bench 总分（cannbench.com，百分制）折算 0-10，未填报默认 80 持平档并明标 + 测试结果/不读就写直算 + LLM 通用五项；"正确性不及格总分不许及格"封顶）、**D4 完成效率**（15%；token 30% / 并行度 30% / LLM 时长 15% / 工具时长 15% / 轮次 10%——四个比值项与同类任务基线会话比（每类一个样例，Score 页「设为基线」一键指定；省 25% 封顶 1.0、2 倍归 0、未设基线默认 80 持平档并明标），并行度走绝对曲线（区间并集，串行 0.8、1.75× 满分，只奖不罚）；浪费归因只解释不扣分）、**D5 冗余度**（15%；**subagent 重派 55%**——同任务派发按 description 编号聚簇（Task29 / Task15.1，容忍"重新/第二次"类修饰词），一次重派记 50 调用当量、一次就显著五次见底，环境类失败重试豁免；原样重复（同工具同参数连续 ≥3 发）15%；工具调用出错（可避免错误率，环境类豁免；原样连发只计首错，重发归原样重复——错一次白干一次，代价归 D4 比值罚）10%；重复注入/过期旧结果/项目说明相关性/熟练度各 5%；没用上的工具说明与 skill **只统计不扣分**——列表每会话全量注入，单会话没用≠浪费）、**D6 自主性**（20%；打断/相似重发按次扣 + LLM 用户消息九分类，真歧义澄清不扣）、**D7 自定义维度**（可选；按组管理、一键导出导入，LLM 评分/规则判定双类型、支持本会话试算）。其上可叠**评分配置 profile**（「评分配置」）：勾选子项参与（D1 规则四项固定保否决证据链；勾除项不进覆盖度分母）、子项与维度权重覆盖（引擎归一化，不要求和凑 1）、任意维度内加自定义 LLM/规则项（只出分不出判定；D2/D6 目标只展示）、内置模板切换（默认全项/快速免评审/算子开发/极简核心）、profile 导入导出与一键恢复默认——卡上记口径快照，跨口径的总分不可直接比。聚合：D1 未完成否决 → 加权（D2 15 / D3 35 / D4 15 / D5 15 / D6 20）× 覆盖度折扣。评审调全部走强制 CoT 契约（reason 先于 score 输出，解析按键名免迁移）、成本记账在卡、解析失败记错误态。评分卡自包含 JSON 落盘 `~/.cannbot-insight/scorecards/`；评审过程日志（逐 attempt 原文、子项各成 subagent 流、人类可读 run 头尾 `cc-judge-run`）落 `~/.cannbot-insight/score-judge-logs/<sessionId>/`，再导入即挂为子代理轮次。
- **Audit** — 粘贴或从文件导入 workflow 分析 JSON（由 Audit 提示词 + Claude Code 产出），渲染实际流程框图 + 每节点问题、G/S 八维 skill 质量看板、优化优先级。证据里的 `§N` turn 引用可点击跳转到对应 turn；并行分支（同 `parallel` id）渲染为同一行；耗时最长的 3 个节点标红；支持从文件导入 JSON，也可把渲染好的分析导出回文件。生成状态跨 tab 切换不丢失（可恢复）；生成失败也会保存可刷新恢复、可导出的完整失败报告，包含错误、耗时和进度轨迹，不再把旧报告误显示为本次结果。**v4**：agent 中心三维度审计（功能完成 / 开发效率 / 开发质量），先确定性提取每个 agent 的输入/输出/信封，再由 LLM 评完成度与质量、效率维度由信封确定性计算，渲染 agent 树。agent 树默认隐藏全部通过的子 agent（勾选开关才显示）；跨 agent 问题与优化优先级每项都给出证据（`agent:<name> #turn`，可点击跳转），审计头部展示本次审计消耗的 token 数。Audit tab 拆两个子 tab：**Workflow audit**（上述 v1-v4 分析）与 **Skill audit**——对当前 session 跑 sift 的 `audit`，对账真实执行 vs 每个被调用 skill 的 SKILL.md（不 re-run），以及 vs 每个被 dispatch 的 agent 的 `.md`（声明恢复两级：proxy 子代理 system 注入〔运行时真正生效的那份——远端当时版本、多插件天然无歧义〕为主路径，本地 `AGENTS_SCAN_ROOT` 磁盘扫描兜底；对账切片按角色名匹配——bridge.subagentType / dispatch 角色句，任务标题不再当 agent 名），以及 vs 主 agent 的 workflow 组合声明（`--kind root`——切顶层主 agent 作用域审主 agent 编排；组合声明 = 规程层（skill resources / SKILL.md body / turn0 ≥500 字注入的编排规程）+ 计划层（STATE.md 等计划文件 Read 的任务承诺；todowrite / Write 产物 / 内容特征 scan 兜底已按设计剔除）分层拼接，任一层可恢复即显示该目标，一次对账同时审编排纪律遵循度与任务完成度）。组合声明的确定性提取是**插件化**的（`workflow-extract-plugins.json`，schema 见 `workflow-extract-plugins.json.example`）：内置 cann-ops 插件的计划文件名白名单 / skill 打包目录 / 各阈值等识别启发式原样保留为默认值，换领域（非算子生成任务）时复制 example 改约定即可零代码切换；另有 **llm-root 泛化路径**（不依赖领域插件）：确定性收集候选（turn0 注入 / skill 正文 / 计划文件快照，零领域启发）→ claude CLI 只输出「选哪份候选」的 JSON → 正文一律取 DB 原文、归一化与装配与确定性提取共享同一函数（`assembleCombinedDeclaration`）——「提取拼接可以、篡改不可以」由构造保证，识别正确的场景两条路产出字节级一致，按 target 出 summary + 原生报告视图（非 iframe）：五态 verdict 徽章、root 组合声明下 findings 按指令原文归层打徽章（规程=teal 编排纪律 / 计划=purple 任务承诺）、findings 可过滤（按 verdict / 类别 / 方法 / 指令或证据文本）、多 transcript 指令级聚合表、按指令可折叠分组（FAIL 优先排序）、verdict/method 图例、保留"在新页打开原始 HTML"逃生口。运行中有实时进度条 + 百分比（解析 sift on_progress 输出）；结果跨 tab 切换不丢失；需装 `sift` + `claude` CLI；agent 对账需 `AGENTS_SCAN_ROOT` env（默认自动探测 skills-dev 仓库根）。

## 方式零：npm 一键安装（推荐）

无需克隆源码、无需手工配环境、无需传文件，一条命令从公共 npm registry 安装：

```bash
npm install -g cannbot-insight
cannbot-insight            # 首次：自动 build + migrate（约 30s-2min），随后启动 + 开浏览器
```

- 运行时依赖（next/prisma/better-sqlite3 等）自动从公共 npmjs 拉取；首次安装会编译 `better-sqlite3` 原生模块（约 1-2 分钟，需 `python3`/`make`/`g++` 或 prebuild 命中）。需 Node.js >= 20。
- 国内网络可用 npmmirror 镜像：`npm install -g cannbot-insight --registry=https://registry.npmmirror.com`（镜像从 npmjs 自动同步）。
- `npx cannbot-insight` 亦可（免全局安装直接运行）。

**离线 / 内网环境备选：tgz 文件安装**（从维护者 / GitCode Release 获取 `cannbot-insight-<版本>.tgz`）：

```bash
npm install -g ./cannbot-insight-<版本>.tgz
```

所有可写状态集中在 `~/.cannbot-insight/`（SQLite 库 + `.next/` 构建缓存），安装包目录保持只读。默认端口 21025（被占则自动找空闲端口）。

| 标志 | 作用 |
|------|------|
| `-a`, `--advanced` | 显示高级 tab（wireRounds/replay） |
| `-k`, `--kill` | 杀掉占用 21025 端口的进程，复用该端口 |
| `-f`, `--fresh` | 清空 `.next` 构建缓存重新构建 |

CLI 子命令直接透传（同方式二，但无需 `cd`/`npx tsx` 前缀）：

```bash
cannbot-insight upload --file ~/.local/share/opencode/opencode.db --list
cannbot-insight sessions
cannbot-insight --help
```

**需 Node.js >= 20。** Python 3 为可选项（自动探测）：存在则启动 smart-agent 后端（breather/v2 分析，端口 21026）；缺失则静默降级，其余功能正常。

## 方式一：Web UI

**需要 Node.js >= 20.x**（v18.19.x 无法安装 better-sqlite3 / Prisma 6）。如果有 nvm，`start.sh` 会自动切换到 Node 20 LTS。

日志文件位置：
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/<hash>/sessions/<id>.jsonl`，也可指定目录自动扫描

Linux系统（Windows系统请使用start.bat代替）：
```bash
./start.sh              # 自动安装 + 迁移 + 启动 Web UI，端口 21025
./start.sh -u           # 更新依赖 + 迁移 + 启动 Web UI
./start.sh -f           # 清除 .next 缓存，重新编译
```

`./start.sh` 同时会安装 cpx 捕获命令（`cpx claude` / `cpx cannbot` / `cpx codex` 捕获 agent↔模型明文流量）；cpx 也可独立安装——`../cpx/install.sh`，捕获无需启动 insight，`cpx list` 查看捕获清单（按时间降序）；导入是 insight 自身的职责——Web UI「Import Session → JSONL」选 proxy 目录，insight 在运行时捕获退出即自动导入（详见 `../cpx/DESIGN.md`）。

浏览器打开 `http://localhost:21025`。导入日志文件后，点击 session 进入 9 个分析 Tab。

Web UI 还支持：导出 session 为独立 SQLite 或层级 Markdown；上传 session 到 CANNBay v2（atomgit 数据集仓，带提交信息对话框 + 必选范式目录下拉：数据仓顶层目录即范式注册表，25 个算子计算范式 category + `others` 兼容非算子会话；新增范式只需在数据仓新建顶层目录，insight 侧零范式知识；存量 `sessions/` 为未标注区，换范式重传在同一次 commit 内原子移动会话文件夹；上传时必选**算子生成结果**标注〔成功/失败〕——随会话 `cc-session-meta` 可选字段 `opGen` 入仓，CANNBay 会话列表「算子生成」列展示成功/失败/—；会话详情页标题栏（Export HTML 旁）也提供上传入口，与主页面上传共用同一弹窗）；可选「设为该范式 baseline 会话」勾选将会话移入 `<paradigm>/baseline/`（workflow 评分基准——位置即身份，更换时原 baseline 在同一次 commit 内原子移回范式普通目录）。上传格式为 proxy 捕获的 claude-jsonl 文件夹（主会话 + subagents），opencode 会话自动从 DB 导出 jsonl；上传前强制数据治理（密钥清洗 + 残留熔断，密钥不出公开仓）；行流 gzip at rest（捕获落盘即压缩、仓内存 .jsonl.gz、读方透明解压，`zcat` 即用，见 ../cpx/COMPRESSION-DESIGN.md）。CANNBay 列表/下载走 partial clone（`--filter=blob:none`）持久镜像：列表只读元数据秒级返回（含从 `cc-session-meta` 批量读取的会话类型列，`producer=cpx` 的 proxy 捕获并排 proxy 徽标），导入单条才按需下载 blob，千级会话仓库也不变慢。旧版 .db 快照上传/解析（gitcode CANNBay）后端保留，用于读取历史数据，界面不再展示。 所有上传/捕获/导出 jsonl 同时携带声明式 `x_cannbay` 扩展命名空间（信封冻结 + `{schema, version, data}` 口袋，规范见 docs/cannbay-schema-spec.md），并修复 6 项导出丢失（reasoningTokens/ttftMs/ToolCall 明细/framework/模型参数/wire 状态码）；列清单对账 round-trip 集成测试证明 DB → 导出 → 再导入零丢失。

v1.88 起数据之湖远端可在设置页配置：地址单一输入框（默认值为内置数据湖仓，可改为任意 git 地址如 `https://ai.gitcode.com/cann_corpus/trace_corpus`，`ai.gitcode.com` 自动归一为 `gitcode.com`；等于默认值时请求不带地址、后端 env 语义保留）、认证可选 无（匿名）/账密/令牌（gitcode 已移除 git 密码认证，仅支持私人访问令牌；「测试连接」按钮在凭据字段后方，会真实校验地址与密码/令牌——选了认证方式但未填写直接失败，成功时区分「凭据已验证 / 匿名访问」）、可选分支（默认 main，可「选择」从远端分支列表挑选）与目录（替换默认 `sessions/` 前缀，列表/导入/上传同步生效，目录可「浏览」逐级选择而无需手填）。配置解析顺序：请求体 > 环境变量（`CANNBAY2_REMOTE_URL/PUSH_URL/BRANCH/CACHE_DIR`）> 内置默认——未配置时行为与之前完全一致，多远端镜像缓存按 地址+分支 隔离。凭据仅存浏览器 localStorage、每次请求发给本机后端做 git 认证（不入库、不入日志，错误消息脱敏）。注意：trace_corpus 现存平铺布局文件（`<类别>/<月份>/<提交人>/<uuid>.jsonl`，无会话文件夹）不会被列出，列表/导入仅识别 `<目录>/<sid>/` 文件夹约定。v1.98 起 LLM 接入面板内嵌「常见提供商 Base URL 填法」速查（阿里云百炼 / 智谱 GLM Plan 订阅端点与按量端点 / 火山方舟 / DeepSeek / OpenAI / Moonshot / 本地 Ollama·vLLM），点击行直接填入地址与示例模型；规则提示：填到版本段（/v1、/v3、/api/paas/v4…）即可自动拼 /chat/completions，首尾空格自动忽略（此前粘贴带入的尾随空格曾致 `/v4%20/v1/…` 畸形路径 404）。

## 方式二：CLI 上传 + Web 分析

适用于 SSH 远程服务器、Web IDE 等无浏览器环境。CLI 一步完成导入和上传，之后在 Web UI 上分析。

日志文件位置：
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/<hash>/sessions/<id>.jsonl`，也可指定目录自动扫描

### 一次性初始化（新环境首次）

```bash
cd cannbot-insight
npm install
echo 'DATABASE_URL="file:./dev.db"' > .env
npx prisma generate
npx prisma migrate deploy
```

约 1 分钟，之后无需重复（除非依赖更新）。CLI 上传命令会自动拉起后端，无需手动跑 `start.sh`。

### 上传 Session

**opencode：**

```bash
# 列出可选 session
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --list

# 指定 session-id 上传（非交互，适合脚本）
npx tsx src/cli/index.ts upload \
  --file ~/.local/share/opencode/opencode.db \
  --session-id <session-id> \
  --description "描述" \
  --yes --json

# 交互式选择 session 并填写描述
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db
```

**Claude Code：**

```bash
# 列出可选 session（指定 projects 目录，自动递归扫描 .jsonl）
npx tsx src/cli/index.ts upload --file ~/.claude/projects/ --list

# 指定 session-id 上传（session-id = .jsonl 文件名，不含扩展名）
npx tsx src/cli/index.ts upload \
  --file ~/.claude/projects/ \
  --session-id <uuid> \
  --description "描述" \
  --yes --json

# 也可直接指定单个 .jsonl 文件
npx tsx src/cli/index.ts upload --file ~/.claude/projects/<hash>/<uuid>.jsonl --list
```

| 参数 | 说明 |
|------|------|
| `--file <path>` | 源路径：opencode `.db` 文件 / Claude Code `.jsonl` 文件或目录，源类型自动推断 |
| `--session-id <id>` | 指定上传哪个 session（跳过交互选择） |
| `--description <text>` | 提交描述（跳过交互填写） |
| `--yes` | 跳过确认提示 |
| `--json` | JSON 输出（非交互，适合脚本） |
| `--list` | 仅列出可选 session，不上传 |
| `--framework <name>` | 框架类型（自动推断：opencode-db → opencode，claude-jsonl → claude-code） |

上传后在 Web UI 上查看分析：导入时点击 **CANNBay** 按钮，先选范式目录（顶层目录即注册表，带各范式会话计数与基准标记）再选择该范式下的会话文件夹导入（baseline 会话带徽标置顶，按需下载该会话文件），无需手动 clone。

## 方式三：零依赖导出 Session DB

从 opencode.db 或 Claude Code JSONL 提取单个 session（含子会话）为独立文件。**零依赖**——只需 Node.js >= 22（内置 `node:sqlite`），无需 `npm install`、无需 Prisma、无需后端。根据 `--file` 自动识别框架：`.db` → opencode，`.jsonl`/目录 → Claude Code。

```bash
# 列出可选 session（自动检测源）
node export-db.mjs --list
node export-db.mjs -f ~/.claude/projects/ --list

# 交互式选择 session 并导出
node export-db.mjs
node export-db.mjs -f ~/.claude/projects/

# 指定 session-id 导出
node export-db.mjs -s ses_xxx                          # opencode
node export-db.mjs -f ~/.claude/projects/ -s <uuid>     # Claude Code

# 指定输出路径
node export-db.mjs -s ses_xxx -o ~/my-session.db
node export-db.mjs -f ~/.claude/projects/ -s <uuid> -o ~/my-session.jsonl

# JSON 输出（脚本友好）
node export-db.mjs -s ses_xxx --json
```

未指定 `-o` 时，默认输出到脚本同目录下：
- opencode → `dbfile/session_<id>.db`
- Claude Code → `jsonlfile/<id>.jsonl`

导出的文件可通过方式二的 `upload --file` 命令重新导入 Insight 或上传 CANNBay：

```bash
npx tsx src/cli/index.ts upload --file /abs/path/to/session_xxx.db  --session-id ses_xxx --yes --json
npx tsx src/cli/index.ts upload --file /abs/path/to/<uuid>.jsonl    --session-id <uuid>  --yes --json
```

| 参数 | 说明 |
|------|------|
| `-f, --file <path>` | 源路径（默认自动检测：opencode.db 或 ~/.claude/projects/） |
| `-s, --session-id <id>` | 指定导出哪个 session（跳过交互选择） |
| `-o, --output <path>` | 输出路径（默认 `dbfile/` 或 `jsonlfile/`） |
| `-l, --list` | 仅列出可选 session，不导出 |
| `-j, --json` | JSON 输出 |
| `-h, --help` | 显示帮助 |
