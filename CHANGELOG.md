# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [Unreleased]

### Fixed
- 【私有数据仓分支下拉 / 测试连接修复】分支列表与「测试连接」改为与服务端已存凭据（`cannbay-auth.json`）同通道鉴权（401 挑战-应答）：表单留空也能列出私有仓分支、有效已存凭据不再被误报「连接失败」；gitcode 上无法确认令牌属主时如实提示「凭据未能验证」而非伪称已验证；无凭据指引由已移除的 `cpx auth` 更正为 `cbi auth`

## [v0.2.37] - 2026-09-22

### Added
- 【数据仓推送凭据引导式配置弹窗】上传/导入遇凭据缺失或失败时自动弹出引导配置，配完即可直接重试，无需绕道设置页
- 【压缩格式升级 gzip → 7z（与 cpx 同步）】`.jsonl.7z` 捕获可直接导入，上传出仓统一新格式，存量 `.gz` 永续可读且上传时自动迁移

### Changed
- 【数据之湖凭据管理重构（**breaking**）：推送凭据改为用户自配】内置共享凭据全部移除，用户在设置页配置推送凭据并落服务端（与 cpx 同机共享）；无凭据上传提前快速失败并给配置引导。迁移：默认仓推送需仓主加协作者
- 【默认数据仓迁址（组织仓）】默认远端迁至新组织仓，存量配置自动重映射；已存凭据需对新仓重新保存一次
- 【start.sh 单实例收口】默认启动固定绑定 21025 并自动收口旧实例，不再端口漂移；端口被无关进程占用时明确报错
- 【首页 Sessions 列表 Duration 列 → LLM Active】改为展示模型推理时间（并行去重叠），一眼区分"会话经历时长"与"模型真正忙时"；CLI/TUI 维持墙钟口径
- 【LFS 上传默认开启——与 cpx 对齐】会话文件默认以 LFS 指针出仓，容量脱离数据仓 git 配额

### Fixed
- 【Turn 时间线】子代理显示完整调用名称；缺少完成时间时恢复真实耗时，已导入会话无需重新导入即可生效。
- 【默认仓迁址后镜像静默读写旧仓】本地镜像可能仍指向旧仓导致列表/上传串仓——镜像改按远端哈希隔离并拉取前校验来源
- 【用户场景上传鲁棒性两连】缺 git-lfs 时首次上传自动安装；失败上传残留的脏镜像缓存下次自动修复，不再卡死后续上传
- 【首页 Query 语义修复】Query 改为会话标题优先、跳过后台任务通知，长会话不再显示"Background task completed"类噪音
- 【git pull 后直接 `./start.sh` 构建失败】启动前校验生产依赖实装状态，旧安装拉新代码后自动补装缺失依赖
- 【7z 导入在生产构建下产出空会话】打包器内联 7zip-bin 导致运行时找不到二进制的问题修复
- 【数据仓治理快路径从未生效】cpx 捕获上传恢复免解压直传快路径，上传耗时显著下降
- 【start.sh 启动被 git-lfs 自举阻塞约 2 分钟】启动关键路径不再等待网络，重启停机窗口恢复秒级
- 【-k 重启后浏览器一直转圈】旧实例连接收尾死锁的问题修复

## [v0.2.36] - 2026-09-20

### Added
- 【LLM Active 指标】详情页 / compare / CLI session·compare·stats--session / TUI Overview·Compare 新增 "LLM Active"——所有 assistant turn 在途窗口的区间并集（root + subagent 合并去重叠），即"大模型真正在工作的时间"。并行 subagent 重叠只计一次（不再双计，≤ 墙钟）；proxy 捕获行无 completedAt 时用 `createdAt − latencyMs` 推窗口起点。性质：区分"会话经历时长"与"模型忙时"——长会话含大量用户空闲时 LLM Active ≪ 墙钟；并行密集会话 LLM Active ≈ 墙钟。服务端对该会话 Turn 行算一次（列表不加，N 会话×全 turns 太重）。

### Fixed
- 【导入】超 512MiB 的大捕获（长会话 wire 全量）此前导入必败且**假成功**——整读文件撞 V8 字符串上限、错误被吞成"空文件"走占位路径；现改 Buffer 逐行解码（现场 631MB 捕获 15.7s 导入成功），读取/解压/单行超限错误真实上抛
- 【会话列表】混合模型长会话的 Model 显示改为**最频次**模型（此前取首条，长会话换模型后被首条边缘样本代表）
- 【Session Duration 虚高（并行子代理双计）】列表 / CLI / TUI / compare 的 Duration 此前取 Σ turn latency（root 与全部子代理直接相加，并行执行时间重叠双计，实测可达墙钟 2.1 倍），且与详情页 Wall Clock、Markdown 导出互相打架。现统一为会话墙钟时长（endTime − startTime，客户端用已有 start/end/Σ 三字段自算，API 不派生冗余 durationMs）；全局 Avg Duration 同步改墙钟口径。存储的 totalLatencyMs 保留原语义（Σ turn latency），评分 D4 等内部消费方不受影响。
- 【启动即崩（Node 24 客户现场回归）】`better-sqlite3@11` 手写 V8 绑定的 `Database` 析构在 GC 回收已 close 对象时直接调 `node::RemoveEnvironmentCleanupHook`——Node ≥24 部分版本在 GC 线程无环境上下文，触发原生断言 `(env) != nullptr` **abort 整个进程**（启动器 `ensureNative()` 探针必踩：打印数据目录后 core dump；测试 worker 退出期同栈）。升级 **better-sqlite3@13**（上游 N-API/node-addon-api 重写，cleanup hook 改经 Napi 管理）根因消除；附带收益：预编译二进制随 npm 包分发（prebuilds/ 全平台目录），**安装不再从 GitHub Releases 下载**（国内安装慢/回退 node-gyp 编译的问题一并解决，`npm_config_better_sqlite3_binary_host` 镜像配置不再需要）。tests/setup.ts 的探针强引用 workaround 随根因修复一并退役（对照验证：v13 + 摘除 workaround 全量 191 文件零 abort）。

## [v0.2.35] - 2026-09-20

### Fixed
- 【Overview 泳道】同泳道短任务条互相压盖、只有最顶层可点（分行机制长期失效）——现按渲染位置分行；悬停补显该 execution 的首个任务 prompt（同名 subagent 可区分各自任务）

### Removed
- 【上下文监控】特性整体移除（`/monitor` 页、`/api/breather` 路由与首页入口）

## [v0.2.34] - 2026-09-20

### Fixed
- 【导入失败报错一闪而过不可见】导入对话框完成后此前无论成败 1s 自动关闭（`allSuccessOrError` 统一触发 `handleDone`）、有成功时又整页 reload——失败项报错被截断/秒关，用户看不到错误原因。修复：拆 `allDone`/`hasError`，**全部成功才自动关闭**；任一失败驻留结果视图（报错完整展示：失败行 `Failed` 徽标 + 报错正文独立换行 `break-words` 不截断），用户看清后手动 Done（toast 补失败计数，含失败项时用 `toast.warning` 而非成功样式）。IT：`tests/ut/local-import-error-persist.test.tsx`（本地 JSONL 导入链路：失败驻留、报错可见、越过 1s 不自动关闭、无 reload/无 history、手动 Done）

### Changed
- 【Perf 页】Task Duration / Token consumption 横轴每根柱子下直接标注 agent 名（按 agent 固定色，长名断行/截断），无需悬停即可定位具体 agent；#N 序号保留用于 Task Detail 交叉引用
- 【Perf 页】两图 legend 从图底部移到卡片右上角，不再与横轴标签拥挤，图表横向滚动时 legend 始终可见

## [v0.2.33] - 2026-09-18

### Fixed
- 适配同 sid 双记录布局：native 会话（`<sid>.native/`）此前 meta 读不出（工具/模型列为空）且导入失败，现列表 / 导入全链路按记录类定位

## [v0.2.32] - 2026-09-18

### Fixed（自查审查：code-review skill 全维度检视）
- 【旧 history 条目（framework 缺失）删除双行全删无提示（数据丢失）】旧版前端写入的条目无 framework → 无消歧参数的删除命中同 sid 全部行级联清除。现在删除前按行数探测（挂载时已拉取的 /api/observe/data 顺便计数），旧条目且该 taskId 多行时弹 Dialog 明示「将删除全部 N 份记录」，用户确认后才执行（ui/dialog，非 browser confirm）。IT ④：弹窗内容/取消保留/确认后执行
- 【导入列表类型徽标归一】success 徽标白名单经 `agentFrameworkOf` 剥 `-proxy` 后缀（捕获条目 claude-code-proxy 不再缺徽标，与 ImportHistory 同款）
- 【多行删除确认改服务端事实源（PR #20 审查复核）】前端 `rowCounts` 探测源 `/api/observe/data?limit=500` 实际只认 `pageSize`（缺省 20）——DB 会话一多，旧条目 taskId 落窗口外 → 确认弹窗永不触发、无消歧删除照旧级联全删。改为 **delete-session 服务端守卫**：无 framework 且命中多行返回 409 + rowCount（`findMany` 事实源判定，不受列表截断影响），前端据此弹确认、用户确认后带 `confirmAll: true` 重发放行。IT：delete-session-api 双行 409/消歧删单行/confirmAll 全删三态 + 组件级 409 驱动弹窗全流程（首删 409 → 取消保留 → 再删 409 → 确认全删）

### Security
- 【安全加固批】修复服务端多类输入校验缺失问题（命令执行 / 路径越权 / 请求伪造类）：本地 git 调用全部改为无 shell 的数组参数模式；taskId、smart-agent 输出与 prompt 参数统一白名单收敛（导入/浏览路径与 breather 连接目标为本地自用功能，刻意不设白名单）。新增环境变量：`CANNBOT_AGENT_OUTPUT_ROOTS`（追加 smart-agent 输出根）。**建议所有部署尽快升级；旧版本请勿将服务端口暴露给不可信网络**
- 【测试】新增守卫 IT（`security-guards` 等，vitest + pytest 共 20+ 用例），存量用例适配新校验口径

## [v0.2.31] - 2026-09-17

### Fixed
- 【评分卡查询失败被 300s TTL 放大（MR !19 review）】`getScorecard` 原把异常也吞成 null 且 null 照常入缓存——一次瞬态 DB 故障让受影响会话 5 分钟内一直「未评分」、`scored=false` 筛选误判，与 `listInsightSessions` 的失败不缓存策略不一致；修复：查询失败上抛（区别于「确定无卡」的 null），`fetchScorecard` 降级为未评分但不落缓存，下次请求立即重试
- 【日期筛选裸日期按服务器时区解析、跨时区部署边界平移（MR !19 review）】`Date.parse('2026-09-16T00:00:00')` 无时区后缀按服务器本地时区——UTC 服务器上 +08 用户的「当天」平移 8 小时；修复：客户端随 from/to 附带浏览器时区偏移（`tz=±HH:MM`），服务端拼偏移解析（非法/缺省回退服务器本地，边界解析失败回退无界），URL 仍保持可读的 YYYY-MM-DD

## [v0.2.30] - 2026-09-17

### Added
- 【claude-code ≥2.1 handback 协议适配】新版 claude-code 在捕获中注入四类框架消息（transcript 回放 / 背景事件 / label 请求 / 状态查询）——逐条指纹识别重分类 system 并摘要化，原文留在捕获文件、DB 不再双份存储子代理内容。会话标题改用首真人查询（主会话行、跳过文档注入、assistant 回落）——中途接入捕获不再拿注入文本当标题。**transcript 指纹加自声明护栏**：`</transcript>` 之后须带 block rules 审查指令（"Err on the side of blocking" / `<block>`）——用户粘协议样本提问（`<transcript>` 开头但无指令尾）不判注入、user turn 原文保留。IT：`tests/ut/adapters/claude-agent-injection.test.ts`（146 行 + transcript 护栏负例）
- 【方案一：同 sid 双会话共存——先导 wire 捕获、再导同 sid 的原生会话文件，各建一行互不吞并】proxy 捕获行的 framework 追加 `-proxy` 记录后缀，与原生会话在 (taskId, framework) 唯一索引下各占一行；导入匹配按「记录类」对齐（同类 merge、异类各建新行），存量数据按版本标记幂等迁移；导入/导出/刷新等 API 全链路带 framework 消歧
### Fixed
- 【展开收起交互统一推广至全部面板（上轮仅 TurnContextPanel/LlmContextView 两处）】整体审视 14 个含折叠交互的组件，修复 8 文件 10 处「点击行空白处即触发展开」的误触面：LLM Output（面板头 + thinking 段，三角纯化右置——原「▼ hide/▶ show」文字混合体）、Tool Calls（skill 行 + 普通行）、Wire Rounds（Round 头三角与 chars 统计拆绑 + 消息行三角左→右移位，删「点击展开全文」误导文案）、Skill 事件列表、TurnTimeline bridge 展开头（三角左→右）；表格/网格范式的两处（SkillDetail 技能聚合表、perf-shared subagent grid）保留首列/名字侧 expander 位置（各自范式内的统一），仅收窄交互到三角本身；ComparePanorama 区块头旋转三角从标题左侧移至头尾。不在修复范围（非行空白问题）：独立文字开关（WorkflowAgentAudit 诊断/I/O/动作、TokenTrendChart 展示全部、LlmContextView 显示全部）、播放控制（ChatReplay/ContextReplay 的 ▶ Play）、WireRounds 原生 `<details>`、TurnTimeline 折叠态 pill（紧凑 chip，点击即按钮本体）。IT：`tests/ut/panels-expand-toggle.test.tsx`（Output/Tools/Wire 三面板的空白不触发 + 三角展开收起 + 行尾锚定；Wire 消息行为视觉裁剪型展开，以 max-h class 断言）；既有 `tool-call-skill-expand.test.tsx` 点击目标同步改三角
- 【上下文面板展开收起交互统一（TurnContextPanel + LlmContextView）】① 三角按钮（▶/▼）统一锚定行最右侧：原先 LlmContextView 消息行三角跟在 token 后（copy 图标反而在最右）、TurnContextPanel「Show full context」是三角在文字前的文字链——统一为「行内容居左、三角 ml-auto 居右」；② **仅三角可触发展开/收起**：原先整行（button/role=button）可点，阅读时点空白处误触——改为行是普通 div、三角是 `span role=button`（tabIndex + Enter/Space 键盘支持、px-2 py-1 独立点击热区与 hover 反馈、行不再有误导性高亮）；③ TurnContextPanel 消息行三角显示条件扩展为「长内容**或**有 tool_calls」（原先仅 >80 字符——短内容带 tool_calls 的消息收窄交互后将无三角可展开，功能丢失）；④ CopyButton 垂直对齐修复：size-4 固定盒内的内联 SVG 按基线排版、被继承行高顶出盒子（与三角文本字形错位的根源）——组件改为 `inline-flex items-center justify-center` 居中，caller className 经 cn 叠加、全部 12 处调用点统一受益。IT：`tests/ut/context-expand-toggle.test.tsx`（两面板的行空白不触发/三角展开收起/右锚定/copy 对齐断言）；`llm-context-injection-render.test.tsx` 点击辅助同步改为点三角（并区分同为 role=button 的 CopyButton）
## [v0.2.29] - 2026-09-16

### Added
- 【双名发布：context 品牌变体】同一套代码打包期品牌变换——显示名 / CLI 别名 / 数据目录随之翻转，格式契约与环境变量名保留不变（两品牌数据互通）；与主包同版本号双发

## [v0.2.28] - 2026-09-14

### Added
- 【增量刷新漂移检测：源回溯性变化自动降级全量替换】`deltaRefreshSession` 的位次匹配（ranked key）合法性前提是"每个上下文的既有轮次 = 新读序列的前缀"（append-only）——opencode 升级引入 step 部件后旧消息多产空轮，前缀关系破裂 → 位次全盘错位 → user/assistant 角色互相覆写、空轮膨胀计数（已导入 > 源数，countChanged 恒 false，同步判死；现场靠手动删库重导恢复）。现在增量前逐上下文校验既有段：源回缩 / 身份字段（role/agentName/subagentSessionId）错位 / 内容改写（非前缀延长；尾部增长合法）任一命中即放弃带病增量，删光本会话轮次后一次性插入本次全量读入（与初导同源同序，位次关系重建，本地库秒级）；**替换事务后同步重算 Session 聚合并回写**（与 merge 路径共用 `recomputeAndApplySessionAggregates`——漂移替换曾跳过此步，Session 行残留位次错乱期的脏聚合，且漂移典型场景一次性触发后 countChanged/timeChanged 均不再变化、无后续刷新可矫正）；返回值增 `fullRebuild`/`rebuiltTurns` 标识，`addedTurns` 改为相对替换前的净增（不再把总轮数报成「新增 N 轮」，toast/route 提示「源已回溯变化，全量重建 N 轮」）。claude-jsonl 路径同享防护

### Fixed
- 【opencode 自动同步被遗弃消息永久堵塞（客户现场）】`auto-refresh-probe` 的 `streaming` 判定原为"存在未完成 assistant 消息"——被遗弃的未完成消息（用户 Esc 打断 / opencode 崩溃 / VM 时钟回拨留下的超前 `time_updated`，`time.completed` 永远缺失）会把 `settled` 永久置 false，轮询每 5 秒都提前返回，轮次间歇也不再同步（现场：一条遗弃消息堵塞 54 分钟、积压 7 条消息不导入）。修复：流式判定加**新鲜度窗口**——未完成消息只有"最近 5 分钟内有更新且时间戳不超前系统时钟"才算活跃；遗弃残留不再堵塞，响应落定后 5 秒内恢复同步
- 【活跃会话自动同步打断阅读（客户场景）】导入仍在对话的会话后查看某 turn，会话持续写入触发自动同步——此前每次同步 `setLoading(true)` 整页闪回 "Loading session…" 并 unmount 全部面板（时间线/turn 详情/上下文面板），活跃会话几秒一次，正在读的 turn 上下文被反复冲掉。修复：自动同步（SSE 与轮询两条路径）改走 `loadAllData(background)`——原地更新状态，列表/滚动/选中详情全程不打断；手动刷新按钮保留前台反馈。配套：turn 详情新增「⟳ 刷新」按钮与"再点同一 turn 即重取"自然交互（自动同步刻意不碰详情，live 写入中的 turn 由用户择时取最新）

### Added
- 【Turns tab 点击 turn 加载慢优化（实测最坏 turn 424ms/444KB；首击 dev 编译秒级）】三层治理：
  - **生产模式成为默认**：`./start.sh` = `next build` + `next start`（dev 按需编译是"某 turn 首次点击数秒"的主因，生产模式请求零编译）。构建产物缓存于 `.next/BUILD_ID`，**源码（src/prisma/public/配置）比缓存新时自动重建**——无需记任何 flag；`-f` 强制重建；改 insight 源码要热重载时 `-d` 回 dev；生产实例 PID 文件防新旧并存端口漂移；`-c` CLI 模式保持 dev（免构建快速拉起）
  - **读侧热路径缓存**（`src/lib/lru-cache.ts` 进程内 LRU）：① `readFullContext` / `readTurnRequestParams` 按 `path+mtime+size` 键控（此前每次点击各整文件 gunzip+逐行 parse 一遍，数 MB 会话每击两遍全量解析；捕获 resume/追加自动失效）② `computeSystemOverhead` 永久缓存（只依赖首 assistant turn，落库后不可变）③ `inputMessagesJson` 重建按 turnId 键控 + 60s TTL（O(前序全量) DB 扫描，turns append-only 下历史重建结果不变）
  - **loading 骨架**：点击后 fetch 期间中间面板显示脉冲骨架，消灭空白期体感

### Fixed
- 【测试误报：npm-publish「lockfile 单轨不漂移」用例删除（issue #5）】insight 的 package-lock.json 被 .gitignore 忽略（各机器本地生成、不入库），该用例读本地 lockfile 断言与 package.json 同值——版本升级后重装前所有拉取新提交的机器必红一次（环境过期被误报为代码错误）；且 pack/publish 均不读 lockfile，对发布物零影响。删除该用例及模块顶层 lockfile 读取（附带消除全新 clone 未 install 时 readFileSync throw 致整测试文件崩的边界）；真正入库的单轨（version.ts ↔ package.json）与 CLI bundle --version 校验保留。注：cpx 的 lockfile 入库，其同款用例语境成立，不受影响

## [v0.2.27] - 2026-09-10

### Added
- 【Import Session · 目录浏览时间列排序】JSONL 目录浏览表（Browse 步）新增 **Modified 时间列 + 排序箭头**——默认降序（最新在前，方便按时间找会话捕获文件，如 `~/.cannbot-insight/proxy` 下的 cpx 捕获），点击箭头切换升/降序；目录恒置顶（导航优先），mtime 缺失（旧后端响应）兜底排尾，同时间按文件名稳定排序。配套：`browse-directory` API entries 增返 `mtime`（fs stat）；排序逻辑抽为可测的 `sortDirEntries` 导出。IT：`tests/local-import-dir-time-sort.test.tsx` 3 用例（真实 DOM 全链路 input→browse：默认降序+目录置顶+时间文本渲染、点击箭头翻转到升序、纯排序语义两方向+兜底+稳定序）

### Fixed
- 【smart-agent 端口选择与击杀安全（start.sh dev 流程）】两类"运行中被杀/撞车"事故修复：
  - 【无差别击杀】start.sh 启动时对 AGENT_PORT(21026) 占用者无条件 kill → kill -9——无关服务占了该端口就会被误杀（`已杀死` 事故来源之一）。修复：抽出 `scripts/pick-smart-agent-port.sh`（独立可测），占用者先经 `/health` 应答体**服务标识**验明正身（server.py `/health` 增返 `service: cannbot-smart-agent`；仅 2xx 不认——Actuator、k8s 探针、dev server 等带通用 /health 的无关服务同样不杀不认）：是上次运行的存量 smart-agent 才杀旧重启（原"加载 *.py 变更"语义保留）；无关进程绝不击杀、错开到下一候选；BASE+1~BASE+3 全被占满则跳过 smart-agent（主服务不受影响）。`port_pid` 的 lsof 分支加 `-sTCP:LISTEN` 过滤——`lsof -ti tcp:$port` 默认匹配连接两端，ESTABLISHED 客户端（残留 next、浏览器等）PID 可能被取到而杀错进程（macOS 正走 lsof 分支）
  - 【撞车】smart-agent 端口曾钉死 BASE+1，BASE(21025) 被占时 next 滚进 BASE+1 与之相撞（EADDRINUSE，npm 启动器同款 bug 的 dev 版）。修复：候选端口避让 next 实选 PORT
  - 【探测挂死】/health 验明 curl 加 `-m 2` 超时——哑端口（TCP 连上不回 HTTP）不再阻塞启动探测
  - 【网络暴露】smart-agent server.py 由 `0.0.0.0` 全网卡监听改绑 `127.0.0.1`（与 next 一致；localhost 后端无远程消费场景，消除局域网暴露）
  - IT：`tests/start-sh-agent-port.test.ts` 8 用例（行为级：空闲选 BASE+1、PORT 避让、无关进程不杀+错开+存活断言、带通用 /health 的无关服务不杀+错开、存量 agent〔/health 带服务标识〕杀旧重启+子进程退出断言、全占返回空、server.py 绑定+服务标识+lsof LISTEN 源码断言）
- 【npm/tgz 安装态启动崩溃 EADDRINUSE 21026（客户实测）】`bin/cannbot-insight.mjs` 端口编排缺陷：BASE_PORT(21025) 被占时 next 经 findFreePort 滚到 BASE+1(21026)，而 smart-agent 端口钉死 BASE+1 且先于 next spawn——python 抢先绑定 21026 后 `next start -p 21026` 即 EADDRINUSE 崩溃。修复：抽出 `bin/ports.mjs`（isTcpFree / isHttpHealthy / isSmartAgent / findFreePort{skip} 纯端口工具），smart-agent 端口自 BASE+1 起 3 个候选中探测空闲并**避让 next 实占端口**，无空闲则降级跳过；先探测存活实例**直接复用**不再重复 spawn——复用正身判定用 `isSmartAgent`（/health 2xx 且响应体带 `cannbot-smart-agent` 服务标识，通用 /health 服务绝不复用，否则 CANNBOT_AGENT_URL 会指向陌生后端）；健康检查与就绪探测改内置 fetch（去 curl 依赖，最小系统无 curl 时不再误判未就绪）；findFreePort 无空闲返回 null 由调用方显式退出。IT：`tests/launcher-ports.test.tsx` 5 用例（占用/释放判定、健康探测含非 2xx、isSmartAgent 正身判定——通用 /health 三形态不认+带标识才认、回归场景——BASE 被占 → next=BASE+1 且 agent 分配 skip 后落 BASE+2 永不撞车 + 无 skip 负向对照、全占返回 null）；真机 E2E：单占 21025 → next 21026 HTTP 200 + agent 21027 ready，双占 21025/26 → next 21027 + 复用存活 agent，均无崩溃
- 【Turns tab · 并行派发 subagent 展示重构】同一 turn 并行派发多个 subagent 时（如 #634/#1078 双派发）原 grid 2/3 列并排布局有两层问题：① grid 子项默认 `min-width:auto`，窄列被 lane 内 turn 行（#N 徽章 + role + "1 tools" + token 数）的最小内容宽撑破，横向溢出到框外覆盖相邻内容（#635、#1079 等行移出框外）；② lane 长短不齐时 grid 行高取最高者，短 lane 侧大片留白、观感差。重构为**并行组（ParallelSubagentGroup）= 紧凑 chip 行 + 展开区全宽堆叠**：折叠态每个 subagent 一个单行 chip（名/turns 数/时延/错误态，flex-wrap 换行排布）等高天然齐整；点击 chip 该 lane 在 chip 行下方**全宽展开**（独占整行宽，turn 行不再挤窄列——从根上消除溢出），可多个同时展开（保持跨 tab 导航祖先链的多桥展开语义）；组头 `⇄ N parallel subagents` 标识 + turns/token 汇总。配套卫生：lane 根节点与容器 `min-w-0`、turn 行 `flex-wrap` + 固定元素 `shrink-0` + 摘要 `min-w-[60px] max-w-[200px] truncate`、lane 头 agent 名 `max-w-[60%] truncate`、时间线滚动容器 `overflow-x-hidden` 兜底、根 turn 徽章行同步 `flex-wrap`。IT：`tests/turn-timeline-parallel-overflow.test.tsx` 3 用例（并行组 ⇄/双 chip/无并排 grid、展开 lane 全宽完整渲染 + chip 高亮/错误态、SubagentLaneView 行级卫生）

### Changed
- 【Skills tab · root/llm 行显示名收敛】顶部合成 root 行显示名由「主 agent 编排」（或扫盘反查的 workflow 真名）改为固定「workflow」，行下方的声明来源小字（来源: 规程: turn0 (注入编排规程) + 计划: STATE.md 等）移除（真名保留在悬浮 tooltip，对账跳转/内容取数的功能标识符不变）；llm 行显示名「{真名}（LLM）」改为「workflow（LLM提取）」；展开面板标题同步（「workflow 声明」/「workflow（LLM提取）· 组合声明」）；mainAgentWorkflowSource prop 链路整体清理（接口/解构/page.tsx 状态与传参）
- 【Skills tab · agent .md 全文按钮配色】归一后的「全文」按钮配色由 orange 换回原「全文·磁盘」的 purple（内容行仍按 via 自适应标识实际命中来源）
- 【Skills tab · agent .md 全文按钮合并】subagent 行的「全文·磁盘」「全文·会话」两个并排按钮合并为**单一「全文」按钮**——会话恢复（子代理运行时 system 注入）作为主数据，磁盘扫描降级为兜底（会话内无该 agent 注入数据时才走，如 opencode 工作流派发的 general 子代理）。两级优先由 agent-content 路由缺省行为提供（v2.1x 起已是 system 优先 + 磁盘兜底），本次是 UI 收敛：
  - use-skill-content：fetchAgent 去掉 source 强制单源参数；key 统一 `agent:<name>` 前缀（防与同名 skill 内容互覆）；SkillContentResponse.via 类型对齐实际响应（"system" | "disk"）
  - SkillDetail：两按钮 → 一按钮（orange）；两个内容行 → 一个自适应行（via=system 橙色〔会话恢复〕/ via=disk 紫色〔磁盘兜底〕，说明文案与下载文件名后缀随来源区分，双路都无数据时给出合并提示）
  - agent-content 路由：行为不变（缺省两级优先），头注释同步单入口语义；source 参数保留 'system'|'disk' 显式单源（测试/调试用），旧 UI 的 'session' 值按缺省处理（兼容缓存中的旧前端）
  - README 双语「Agent 定义恢复」特性描述同步改写
  - IT：agent-content-api.test.ts 补 source=session（旧 UI 值）按缺省两级优先的兼容用例；既有缺省/降级用例继续锁定主行为
- 【版本策略按包迭代】版本号迭代规则明确为 PR 粒度按包升降：每次合 PR +0.0.1，只升 PR 实际触达的包（insight 触达才升 insight、cpx 触达才升 cpx，未触达不动），AGENTS.md/CLAUDE.md 双语四处同步

## [v0.2.26] - 2026-09-09

### Added
- 【npm registry 一键安装】发布到公共 npmjs（包名 `cannbot-insight`），用户 `npm install -g cannbot-insight` / `npx cannbot-insight` 一条命令安装，替代"npm pack 导出 tgz → 人工传文件 → 对端 npm install -g ./xxx.tgz"的离线分发链路（tgz 方式保留为离线/内网备选，README「方式零」同步改写，国内可走 npmmirror 镜像）
  - 【版本单轨化】`package.json` version 自独立双轨的 `1.83.0` 对齐至展示版本 `0.2.26`（`src/lib/version.ts` 单一源不变；后续升版本两处同步改，package-lock.json 随之），去掉 `private:true`（pack 不受影响、放行 publish）
  - `.npmignore` 清理过时 `proxy/` 条目（cpx 已独立为兄弟包 `packages/cpx`，不再位于 insight 目录内）
  - IT：`tests/npm-publish.test.ts`——`npm pack --dry-run` 产物清单断言（bin 启动器/postinstall/src/prisma/export-view bundle/CLI bundle 在包内，tests/docs 排除）+ package.json 发布就绪（无 private、版本与 version.ts 单轨一致、bin/postinstall/license 齐备）+ CLI bundle 实跑 `--version`

### Fixed
- 【tgz/npm 安装态 CLI 子命令炸（v1.84 预存 bug）】`cannbot-insight <cli-subcmd>` 在全局安装位置（包位于 `lib/node_modules/<name>` 内）报 `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`——tsx 对 node_modules 内的文件硬性禁用 tsconfig paths（isDependencyPath 判定，`TSX_TSCONFIG_PATH` 亦无法绕过），`@/lib/...` 别名导入全部失效（Web UI 路径不受影响：next build 是打包期解析别名）。修复：新增 `scripts/build-cli.mjs`（npm `prepack` 钩子自动执行）把 `src/cli/index.ts` 用 esbuild 打成单文件 `dist/cli.mjs`（打包期解析 `@/` 别名，`packages:"external"` 只打自有 src、依赖运行时照常从包内 node_modules 解析），bin 启动器 CLI 透传优先 `dist/cli.mjs`、仓内开发态（无 dist）回退 tsx 直跑源码——两态行为一致。`dist/` 入 .gitignore（构建产物不入库）

## [v0.2.25] - 2026-09-09

### Added
- 【原仓 v2.21~v2.25 + 未提交改动一次性同步】skill-dev 原仓（tests/cannbot-insight）自 v2.20 分叉点以来的全部演进整版本合入本仓，与本地 0.2.21~0.2.24 演进（scoring profiles / op-bench）无冲突合并（代码文件 0 冲突，README/AGENTS 人工合并），包含：
  - 【主页 Sessions 搜索与翻页客户端化】`?q=` keyword / sessionID 搜索（服务端过滤 taskId/query/label，回车或按钮提交、Clear 回全量、命中显示 N of M）+ 首屏 SSR 数据之后翻页/搜索走客户端 `/api/observe/data` 无整页刷新（首页/末页/前后页按钮）；SQLite 载入后的会话选择表同款 keyword/sessionID 过滤（全选作用于当前过滤视图）。IT：`tests/home-session-search.test.tsx` + `tests/local-import-session-search.test.tsx`
  - 【S3 形态（opencode ≥1.17 首条 skill 注入）双修复】提取侧 `recoverMainAgentWorkflowBody` 只认 role=user 而注入体带 Base directory 标记被 adapter 重分类 system → 规程层丢失，扩 in [user,system]；归一侧 claude-jsonl adapter 会话首条 skill 注入不再重分类、保持 user（同内容会话 turn0 角色不随 opencode 版本漂移），user prompt 之后的注入仍 system+合并；新增 `stripSkillRuntimeTail` 行级剥运行时注入尾部（Base directory/Relative paths/Note 行 + `<skill_files>` 块），LLM 路 turn0 候选同款保持两路产出一致。IT：adapter 首条/中段 2 例 + 提取层 S3/剥尾 5 例 + LLM 候选 1 例
  - 【sift 层3 派发回报对】`buildStructuredRecords` 的 dispatch 类（task/agent）tool_calls 带 result（截断 4096）——派发的 tool_result 是子代理最终报告，sift 层3 用它构建"派发-回报对"喂 step 判官（缺席式误判的洗冤证据 + "传递≠达成"的验收结论依据）
- README / README-zh 特性清单同步上述条目

## [v0.2.20] - 2026-09-04

### Changed
- 【版本号改三段式】展示版本从两段 `v2.20` 改为三段 `v0.2.20`（前补 `0.` 主段，`package.json` version 仍不作展示版本）。版本源 `src/lib/version.ts` 单一源不变，CLI `--version` / TUI StatusBar·HelpScreen / Web 页头·设置页全端自动跟随，无硬编码处需改；升版本策略同步 `+0.01 → +0.0.1`（CLAUDE.md 两处）。历史两段式条目（v2.07 及以前）按发布当时原样保留，不改写
- 【cpx 独立为独立组件工具】cpx 捕获网关自 `cannbot-insight/proxy` 独立成 `packages/cpx` 包（git mv 保留历史），成为可独立安装、独立使用的组件工具：捕获不依赖 insight 运行（`packages/cpx/install.sh` 独立安装，`cpx <agent>` 独立捕获），insight 只保留导入/分析职责（运行时捕获退出自动导入 + Web UI「Import Session → JSONL」）。独立后 cpx 拥有自身版本号 v0.1.0（`packages/cpx/src/version.ts` 单一源，`cpx --version | -v` 可查版本 + 生效代码路径）与独立 CHANGELOG（`packages/cpx/CHANGELOG.md`）——后续 cpx 变更在该处记录，本文件不再重复

## [v2.06] - 2026-08-30

### Changed
- 【subagent 声明恢复重设计——system 注入为主路径，不依赖 Read】依托真实会话（proxy 显式派发形态）实测定型：子代理运行时 system prompt（捕获扩展字段，agent .md 正文 + 运行时尾部 ~62%）即**运行时真正生效的声明**。旧 Read 恢复路径在该形态天然无数据——声明已注入上下文，子代理不会再去磁盘读一遍自己的 md；磁盘扫描给的是本机另一版本 + 多插件歧义退化字母序。落地：
  - `agent-md-session-recover.ts`（server-only，proxy 扩展层）：`recoverAgentMdFromSystem`——meta.json agentType 定位子代理（免逐个解压）→ 扩展字段/legacy 双读 system → 剥运行时尾部得纯正文。守卫：opencode 通用 prompt 排除、首行标题 ≠ agent 名排除（防 meta 错位）
  - `agent-content` 路由：两级恢复——**system 注入（主路径）> 磁盘扫描（兜底：会话内无声明数据的形态）**；`source=system|disk` 显式指定。移除 Read 恢复依赖（`agent-md-recover.ts` 保留未删，调用点已撤）
  - `audit-agentsift` 路由：声明同链路（审的 = 看的）；system 源物化临时 .md 注入 frontmatter `name: <agentName>`
  - `agent-role-name-map.ts`（client-safe）+ `buildStructuredRecords`：子代理 turn 的 `rec.agent` 改用**角色名**（bridge.subagentType 优先，general 时 join dispatchTurnId→SkillEvent）——修 agent 对账切片匹配断点：`Turn.agentName` 是任务标题（"Task29 修复Kernel崩溃"），sift `--kind agent` 按声明 name 匹配 records.agent 永远对不上
- 测试：fixture = 真实会话 19 agentType 子代理样本 + 恢复 6 用例（全恢复 / 真身长度断言 / 扩展字段优先 / 通用 prompt 排除 / 标题守卫 / 缺目录容错）+ 角色名映射 5 用例 + agent-content IT 5 用例 + audit IT +1 + 构建记录 +2；客户端可达性静态锁覆盖角色名映射

## [v2.03] - 2026-08-29

### Fixed
- 【sift audit "卡 95%"】根因三层（实测复现：root 组合声明 54 指令 → 30 个 LLM 判定批，单批 52s~21min，thinking 顶满 max_tokens 触发整批 0-解析重试；期间曾出现 sift 进程死亡、claude 判官孤儿化、前端永远 95%）。修复：① **进度模型改全局批计数**——判定段 15→95% 按"所有类完成批数/总批数"推进（旧"3 类各自平均"在步骤类 24 批、禁令/条件性各 3 批的真实分布下，快类完成后进度高位僵住；未见过批号的类不虚增分母）；95→100% 留给报告落盘，无静默段。② **静默看门狗**——连续 12min 无任何 stdout 输出（进程崩溃/close 丢失/LLM 无响应）→ SIGKILL + error 事件（带最后一条进度上下文），流不再无限悬挂；单批慢不误杀（批间"判定/重试"提示持续喂狗）。③ **总时限超时补 error 事件**（旧 SIGKILL 后静默）。④ 前端 store 增加 `lastProgressAt`（进度停滞时长），EntryPanel 停滞超 5min 显示慢告警文案（"单批最长可达 20 分钟，超 12min 静默自动终止"）。`tests/sift-runner.test.ts` 新增 7 用例：全局批计数进度模型（快类完成不再僵住 / 全完成恰 95 / 未见过 total 不虚增分母 / 95 上限）、看门狗（静默杀 + 喂狗不误杀 + 总时限）

## [v2.02] - 2026-08-28

### Fixed
- 【LLM 提取"永远提取中"死循环】三层叠加：① claude CLI 认证失败（403 invalid api-key，环境问题）每次约 1s 即 exit 1；② `getOrStartLlmExtract` 对失败 job 的策略是"下次 GET 删缓存重启"（本意给重试用），而前端 loading 期间每 5s 轮询 GET → 每次轮询都重启 CLI → 前端永远看到 loading=true；③ `runClaudeCli` 非 0 退出丢弃 stdout（错误信息在里面）→ 用户只看到"提取中"不见原因。修复：失败 job 不再自动重启（显式重试走 `?restart=1`，重试按钮由空操作改为真重试）；runner 契约改 `{text, error}`，CLI 失败消息（含 403 详情）上抛直达 UI；audit-skillsift llm-root 对 CLI 失败返回 502 + 具体原因（不再吞成笼统 404）
- 【LLM 提取性能】prompt 从 78KB 降到 19KB（实测同一 session）：计划候选 40→16、预览 2000→1200 字；候选收集查询两步走——先取轻量 argsJson 判定哪些调用需要正文，再按 id 批量取 resultJson（此前整列拉 resultJson 会把全 session Read 大结果〔单条 MB 级〕全部载入内存）
- 【客户端 bundle 炸裂（自检视）】插件加载器 `workflow-extract-config.ts` 顶层 import `node:fs` 被 `sift-audit.ts`（客户端可达：session page → SkillDetail/SkillAuditTab）拖进 client bundle，Turbopack 报 "Code generation for chunk item errored … does not support external modules (node:fs)"、session 页白屏。修复：镜像 agent-md-scan 的隔离模式拆两半——`workflow-extract-plugin.ts`（客户端安全核心：类型 + cann-ops 默认值 + 纯合并 + 生效插件 holder，零 node 内建 import）与 `workflow-extract-config.ts`（server-only fs 加载器，API 路由入口调 `ensureWorkflowExtractPluginLoaded()` 激活，幂等）；`sift-audit.ts` 只引前者。新增**客户端可达性静态锁** IT（sift-audit / plugin 核心 / skill-audit-job / types 四文件源码级禁止 import node:fs|path|child_process 及 server-only 加载器）——同类回归测试期即红，不必等 dev server 构建报错

### Added
- 【主 agent 组合声明提取插件化】确定性提取（`recoverCombinedWorkflowDeclaration`）内置的算子生成任务启发式——计划文件名白名单（STATE.md 等）/ plan-like 标题集 / skill 打包目录（resources、templates）/ turn0 与正文阈值——抽成可插拔 plugin（`src/lib/workflow-extract-config.ts` + 根目录 `workflow-extract-plugins.json`，schema 见 `.example`，部署文件 gitignore 镜像 context-windows.json 惯例）：默认 cann-ops 插件与重构前硬编码值逐一相等（native 行为逐字节不变），换领域复制 example 改约定即零代码切换；提取管线本身（两层模型 / 四桶优先级 / 首次实质读取）保持领域无关不进配置。`tests/workflow-extract-config.test.ts` 锁定：默认值不变 + 换插件后 MILESTONES.md 进 named 桶 / 标题集分岔 / 排除目录变更生效
- 【llm-root 泛化路径重构（选择式契约）】`src/lib/llm-workflow-extract.ts` 从「LLM 抄写编排规程原文」改为「LLM 只做选择」：① 确定性收集候选（规程：dispatch 前窗口的 turn0 注入 / skill `<skill_content>` / Read 正文；计划：全 session todowrite + .md/.txt 读写快照，每文件取首次实质读取，零领域启发）；② 选择式 prompt（两层定义 + 候选预览 + 镜像确定性优先级的规则 + 严格 JSON 输出）；③ 解析只认候选 ID，正文一律取 DB 原文，机械归一化（Read 剥行号 / todowrite 格式化 / 计划层 [x]→[ ]）与最终装配共享确定性提取的 `assembleCombinedDeclaration`——「提取拼接可以、篡改不可以」由构造保证（LLM 无从改写正文），识别正确的场景两条路产出字节级一致。llm-root 对账结果现在也带层信息（finding 归层徽章对 llm-root 生效）；Skills tab LLM 行显示组合声明与来源。`tests/llm-workflow-extract.test.ts` 15 用例：候选收集（双列候选 / 剥行号 / todowrite 格式化 / 非 md 排除 / 同文件合并 readCount / 部分读取标记）、prompt 契约、选择解析（跨层引用作废 / 容忍代码块包裹）、端到端（**与确定性提取字节一致** / 单层直出 / runner 注入 / LLM 夹带伪造正文不生效）

### Changed
- `sift-audit.ts` 导出共享件：`assembleCombinedDeclaration`（两路装配）、`extractFileContent` / `extractTodosFromToolCall` / `extractFilePath` / `formatTodosAsPlan` / `pickFirstSubstantial`（两路候选归一化同源）；`PLAN_FILE_NAMES` / `STATE_MD_MIN_LEN` / `MAIN_AGENT_WORKFLOW_MIN_LEN` 常量改为引用 DEFAULT_PLUGIN（单一事实源）

## [v2.01] - 2026-08-27

### Added
- 【主 agent 组合声明审计——root 声明分层对账】root 对账声明从单层编排规程改为**规程层 + 计划层组合**：`recoverCombinedWorkflowDeclaration`（规程：skill resources > SKILL.md body > turn0 注入；计划：named-Read > todowrite > named-Write > scan），双层带分层标题拼接、单层原文直出、皆无则 null。修复计划文件桶的自证缺陷（取最长终态 → `pickFirstSubstantial` 首次实质读取=承诺态，≥桶内最长 60%）；skill 打包目录（resources/templates）文件不进计划层（防与规程层同文双计、归层徽章全命中）。`_layers` 随 NDJSON result 事件流经 skill-audit-job store + sessionStorage，FindingCard 按指令原文（删空白+小写归一）匹配层正文打徽章（teal=规程编排纪律 / purple=计划任务承诺）；判定图例展示组合声明来源。STATE.md-only session（无规程层）root 目标回归可用（`main-agent-workflow` 端点 available 语义放宽为任一层可恢复）

## [v1.84] - 2026-08-20

### Fixed
- 【hydration】Settings 页 `AIProviderConfigPanel` 渲染期直接读 localStorage（`loadProviderConfig()`）——SSR 无 localStorage、客户端 hydration 首渲染读到已存配置，`✓ 已保存` 标记与三个 Input 值双重 mismatch，整树客户端重建。修复：渲染期零读，已存配置由挂载后 effect 填充；新增 hydration 契约 IT（mock loader 强制有值 + renderToString 断言渲染路径零调用与默认值输出，旧实现必红）

## [v1.83] - 2026-08-19

### Added
- 【数据格式 schema 契约】捕获/导出 jsonl 引入声明式扩展命名空间——claude 原生字段为冻结信封，全部扩展进 `{schema, version, data}` 口袋，读方按声明分发（不认识整块跳过），终结魔法值与字段嗅探；五种 payload 覆盖 wire 轮次 / wire 输入 / DB 导出行 / 会话 meta / 子代理 meta；双轨期 legacy 顶层字段并存写，读方一律扩展字段优先
- 【导出丢失修复 ×6】`Turn.reasoningTokens`（接口有字段但从未写出）、`Turn.ttftMs`（导出未取列，且管线侧恒 null——现经 post-patch 补列成为活数据）、`ToolCall` 明细（errorType/errorMessage/durationMs/startedAt，原只剩 is_error 布尔）、`Session.framework/version`（重导入不再错变 claude-code）、`Turn.modelId/providerId/temperature/maxTokens`、wire `response.status`/`request.model`（此前捕获未记录）
- 【验证】schema 契约四把锁：形状一致（声明 ∈ 注册表且版本一致）、双写一致（legacy ≡ 扩展字段）、列清单对账 round-trip（富夹具全列 → 导出 → 再导入 → 逐列多重集比对 **0 丢失 0 损造**）、混排容错（native / legacy-proxy / 纯声明式三通道同文件互不污染）；emitter 侧 4 条双写断言

### Fixed
- 【adapter 分组缺陷】带 `message.content` 的 system 行（system 轮/注入约定）夹在两个不同 message.id 的 assistant 行之间时，后一个 assistant 被并入前组且两行整体静默丢失——现带内容的 system 行破组（原生 claude 元数据 system 行无 message.content，行为不变）
- 【徽标回归（自检视）】再导入时 cc-session-meta 的纯 ccVersion 会把 `Session.version` 的 `-proxy` 后缀徽标覆盖掉——meta patch 现仅对 DB 导出行生效（cpx 捕获的 version/framework 由导入管线按行标记计算）；IT 锁定再导入徽标保留

## [v1.81] - 2026-08-18

### Fixed
- proxy 捕获的详情页自动刷新从未生效（三层修复）— ① probe 分支顺序：claude-format 判定提到 opencode-db 之前，opencode-proxy 捕获不再被当 sqlite 打开退化为 NO_CHANGE（`ProbeSession` 补 `version` 字段，两个路由传入）；② probe 完结标记读 `message.stop_reason ?? 顶层 stopReason`，proxy 格式（顶层扩展字段）此前永远判 streaming；③ opencode-emitter assistant 行补 `duration_ms/stopReason/ttftMs` 三件套——opencode 捕获此前从未落盘 wire timing（v1.74/v1.75 的 wire timing 保真对 opencode 一直缺失，Turn.latencyMs/finishReason 一并补齐）。真机验证：两种 proxy 捕获 probe 均 `settled:true`，自动同步链路（5s 轮询 + SSE）可触发


## [v1.80] - 2026-08-18

### Added
- 【proxy】密钥不落盘（`redactor` 模块）— 捕获文件永不落任何 API key：结构层按键名全等打码（`api_key`/`authorization`/`x-api-key`/…），字符串层按厂家键形打码（`sk-ant-`/`sk-proj-`/`gsk_`/`AIza`/`xai-`/`GL-`/`LTAI`/泛 `sk-`、`Bearer` 凭据、`XX_API_KEY=` 回显、URL query 键）；接入 `dispatchEmit` 唯一落盘咽喉，cpx 启动行同源打码；掩码 `前4…后4`，`max_tokens`/`input_tokens`/裸 `key` 零误伤。真机 `cpx claude`（bigmodel）/`cpx opencode`（dashscope）双链路验证 0 泄漏。设计见 `proxy/DESIGN.md` §7

## [v1.79] - 2026-08-18

### Fixed
- 重复导入 dedup 键漂移（社区检视 Bug #7）— dedup 键从全局 turnIndex 改为上下文内 rank，修复 resume 后 subagent turn 重复堆积、新增 main turn 静默丢失；import-file merge 与 refresh-session 两条路径同步修复
- merge 路径不重建 execution/bridge（Bug #5/#6）— resume 新增的 subagent 此前只 merge Turn、无 Execution/InteractionBridge（执行树断头）；抽共享 `buildExecutionGraph`/`replaceExecutionGraph`，三条写入路径统一重建；顺带修复已存在 turn 的 toolCall 聚合计 0、bridge responseTurnId 悬空
- opencode proxy 捕获的 agent 归属 — 行内 `source:'opencode-proxy'` 标记的捕获 framework 归 `opencode`（此前误显示为 Claude）；判定收敛到 `isClaudeFormatSession` 谓词

### Added
- agent 版本号保留 — claude 取 system 计费头 `cc_version`，opencode 取 UA `opencode/<ver>`；`version` 存 `"<版本>-<marker>"`，详情页显示 `v2.1.234.467 [proxy]`

## [v1.78] - 2026-08-18

### Added
- 导入入口重整 — 入口按文件格式归并为 JSONL（Claude 原生 / cpx proxy 捕获）与 SQLite（按 schema 自动识别 opencode.db / CANNBot-Insight 导出库）；Import History 按 agent 归属显示徽标；cpx 退出输出捕获文件路径 + agent 原生日志路径

## [v1.77] - 2026-08-18

### Added
- proxy 按请求头真实 session id 分流 — claude 走 `x-claude-code-session-id`、opencode 走 `x-session-id`/`x-parent-session-id`，`/resume` 自动对齐；捕获文件加 `cpx-` 前缀防归档撞名；退出按 `.sids` manifest 多文件导入

### Fixed
- 会话详情显示 — proxy 来源渲染为 `[proxy]` 徽标（不再显示 "vclaude-proxy"）；Source 路径中段截断 + 一键复制

## [v1.76] - 2026-08-18

### Added
- turn 详情可读渲染 — wire 消息块数组按 block 展开渲染，不再裸显转义 JSON；`<bash-input>/<bash-stdout>/<bash-stderr>` 渲染为终端样式；cpx 启动日志 key 首尾掩码

## [v1.75] - 2026-08-18

### Fixed
- wire latency/finishReason 走标准管线进 DB — latencyMs/ttftMs/finishReason 从 proxy 扩展层转入 Turn 标准字段，不触碰 OCP 红线

## [v1.74] - 2026-08-18

### Added
- proxy wire timing 保真 — latencyMs/ttftMs/stopReason 随捕获行落盘（扩展层），Perf 分析可看到首 token 时延

## [v1.73] - 2026-08-18

### Fixed
- proxy compact 边界 enrichment 错位 — 按稳定键对齐修复 /compact 后输入消息重组错位

## [v1.40] - 2026-07-27

### Added
- File Reads · 重编汇册（Gather & Rebuild Directory）— 一键按时间戳逐行重建本会话工作目录下全部被读/写过的文件，保留路径树；点击直接打包下载 zip，服务端构建二进制响应，不在页面展开全部内容
- `dir-restore` API（`GET /api/observe/session/dir-restore?taskId=`）服务端批量恢复全部文件并返回 `application/zip`，响应头带 `X-Restored-Count/Total-Lines/Gap-Lines`
- 纯函数库 `src/lib/zip-store.ts`（buildZip / crc32 / normalizeZipPath），STORE 无压缩 + UTF-8 文件名标志位（bit 11）以兼容 Windows 资源管理器中文路径
- 单测 `tests/zip-store.test.ts`（11 项）与 API 级集成测试 `tests/dir-restore-api.test.ts`（4 项，二进制校验）

## [v1.39] - 2026-07-27

### Added
- Skills · SKILL.md 全文 — Skill Summary 与 Skills per Agent 每个 skill 均可点击展示该 skill 的全部内容；优先取原生 `Skill` 工具注入的 resultJson（剥 `Base directory for this skill:` 前导），回退 Read of `*/SKILL.md` 的 resultJson（剥行号），多次加载取最长版本；支持下载与收起；共用 `useSkillContent` hook
- `skill-content` API（`GET /api/observe/session/skill-content?taskId=&skillName=`）与纯函数库 `src/lib/skill-content.ts`
- 单测 `tests/skill-content.test.ts`（20 项）与 API 级集成测试 `tests/skill-content-api.test.ts`（6 项）

## [v1.38] - 2026-07-27

### Added
- File Reads · 循迹复卷 — 每个文件行一个按钮，按时间顺序拼合本会话内的 read/write 片段重建全文（后写入者覆盖先前），未被读取的行标注 `--line N not found --`，支持下载与收起；兼容 claude（`N\t`）与 opencode（`<content>` 信封 + `N: `）两种 Read 结果格式
- `file-restore` API（`GET /api/observe/session/file-restore?taskId=&filePath=`）与纯函数库 `src/lib/file-restore.ts`
- 单测 `tests/file-restore.test.ts`（26 项）与 API 级集成测试 `tests/file-restore-api.test.ts`（8 项）

### Changed
- FileReadAnalysis 文件行改用 perf 风格 grid 布局（左：路径 + 读取次数轴；右：预留 badge 与按钮），轴色与 Turns Overview 统一为 `bg-blue-500`

## [v1.37] - 2026-07-27

### Added
- Audit v4 — agent 中心三维度审计（完成 / 效率 / 质量）：先确定性提取每个 agent 的输入/输出/信封，再由 LLM 评完成度与质量，效率维度由信封确定性计算，渲染 agent 树

## [v0.96] - 2026-06-29

### Changed
- README 面向用户重写 — 功能介绍 + 方式一（Web UI）+ 方式二（CLI 导入 + Web 分析），日志路径说明
- README 去除技术栈/运行测试/许可等开发者信息（保留在 CLAUDE.md）

## [v0.95] - 2026-06-29

### Added
- CLI 导入命令 — `upload --file <path>` 一步完成本地导入，支持 opencode .db 和 Claude JSONL
- 源类型自动识别 — 根据文件扩展名自动选择 adapter，无需 `--source` 参数
- 多 session 交互式选择 — 源文件包含多个 session 时自动列出并让用户选择
- 后端自动管理 — CLI 导入命令自动启动后端（如未运行），导入完成后自动关闭

## [v0.76] - 2026-06-19

### Changed
- TurnContextPanel 新增 "Cached" 类别 — cacheReadTokens + cacheWriteTokens 单独展示为黄色 Cached 区段，不再混入 "Other context"
- ContextInfo 接口增加 cacheReadTokens/cacheWriteTokens 字段
- deltaTokens/unclassifiedTokens 计算排除 cacheInputTokens，避免 "Other context" 虚大

## [v0.75] - 2026-06-19

### Changed
- Input 统一 — TokenBarChart/Overview/ContextTracker 不再分开显示 Input/Cache Read/Cache Write，统一为 "Input" (= inputTokens + cacheReadTokens + cacheWriteTokens)
- inputMessagesTokens 公式从 `inputTokens + cacheReadTokens` 改为 `inputTokens + cacheReadTokens + cacheWriteTokens`（cache_write 也是模型输入的一部分）
- Skill injection system turns 合入前一个 assistant turn 的 Skill tool_call resultJson，不再作为独立 turn 显示

## [v0.74] - 2026-06-19

### Fixed
- Claude Code JSONL 流式行合并 — 同一 API 调用的 thinking/text/tool_use 多行合并为一个 turn，消除 context 0%跳变和重复 usage
- context-window-config 增加 qwen3.7-max (1M) — 修复 qwen3.7-max 被 includes fallback 匹配到 qwen3→128K 导致 contextPct>200%
- DB 修复 — 已入库 qwen3.7-max turns 的 contextWindowPct 用 1M 重新计算（207%→25.9%）

### Changed
- claude-jsonl adapter: 连续 assistant 行合并为 AssistantGroup，取最后一行含 cache 字段的 usage 数据
- context-window-config: 新增 qwen3-235b、qwen3.7-max 条目

## [v0.73] - 2026-06-19

### Added
- Claude Code subagent 导入 — listSubagentSessions 路径修正，Agent 工具 dispatch 检测，toolUseId→subagentSessionId 精确映射
- Claude Code 版本号提取 — JSONL line.version 字段解析，Overview 显示 "Claude Code v2.1.143"
- 费用估算 — Claude Code JSONL 无 cost_usd 字段，从 token 使用量和模型定价估算（Opus/Sonnet/Haiku）
- 耗时推断 — Claude Code JSONL 无 duration_ms，从相邻轮次 timestamp 差值推算 latency
- 单条 session 删除 — 每行 TrashIcon 按钮 + 确认对话框，仅删除 Insight DB 数据，原始文件不受影响
- JSONL 一键导入 — 单个 .jsonl 文件跳过 session 选择步骤，直接导入
- import-file API 返回 query 字段 — 直接导入场景下 ImportHistory 正确记录首条查询内容

### Fixed
- Skill 工具检测大小写 — Claude Code 用 "Skill"（大写 S），改为 toLowerCase() 匹配
- Skill 名称提取 — Claude Code args.skill 格式支持
- Tokens 负数 — Overview 计算 totalTokens - cacheReadTokens 在 claude-code 场景产生负值，改为直接显示 totalTokens
- totalTokens 含缓存 — claude-jsonl mapUsage total 从 input+output 改为 input+output+cacheRead+cacheWrite
- Latency 累加范围 — 仅累加 assistant turns 的 latency，排除 user turns
- 删除确认文案 — 从"不可撤销/永久删除"改为"原始文件不受影响，可随时重新导入"
- ImportHistory 列顺序 — File Path → Query → Import Time → Type → Status → 删除按钮
- 删除图标统一 — ImportHistory 与 SessionList 均使用 TrashIcon

### Changed
- RawInteraction 增加 subagent_type 字段
- TurnRow 增加 subagentType 字段（Prisma 写入前剔除）
- bridge-builder 支持 Agent 工具名 + toolUseIdToSubagentSessionId 参数
- execution-split 从 turn.subagentType 优先提取 subagent 类型

## [v0.72] - 2026-06-18

### Added
- Node.js 版本校验 — start.sh 启动时检查 Node >= 20.x，v18.19.x 无法安装 better-sqlite3 / Prisma 6
- nvm 自动切换 — 有 nvm 时自动安装 Node 20 LTS 并切换，无 nvm 时提示安装指引
- export-service 测试用例 — 10 个测试覆盖 INSERT 列名/占位符/run() 参数三方匹配、DDL 可执行性、Session 30-vs-31 回归守卫

### Fixed
- Import 完成后需手动点 Done — 导入完成后 1.5 秒自动跳回主页并刷新

### Changed
- .gitignore 新增 `.claude/`（per-user 设置）、`package-lock.json`（平台相关生成文件）、`docs/dev-log.md` 和 `docs/report.md`（临时开发日志）
- 从 git 追踪移除 `package-lock.json`、`docs/dev-log.md`、`docs/report.md`

## [v0.69] - 2026-06-17

### Added
- inputMessagesJson 重建包含 prior assistant turns 的 tool_call args + result（按正确顺序嵌入）
- LlmContextView 和 TurnContextPanel 展开 assistant 消息时显示 tool calls（橙色 badge + args/result + token 数）
- System (hidden) 拆为稳定值 + Other context delta，数字可闭合
- computeSystemOverhead 计算 now 包含 prior tool call args tokens

### Fixed
- 8.1kt context gap — prior assistant tool_call argsJson 未计入 visible tokens
- ImportHistory 单条删除无论 DB 是否存在都移除 localStorage 条目
- LlmOutputView badge 直接显示 DB 原始值不再拆分估算
- SkillEventList token 改为 skill tool call args+result 估算
- TurnContextPanel System (hidden) 与 LlmContextView 使用一致逻辑
- LlmContextView 删除 per-category 百分比和底部 Total 行

## [v0.68] - 2026-06-17

### Changed
- LlmOutputView badge 直接显示 DB 原始值 `reasoningTokens + outputTokens`，不再拆分估算 tool args
- LlmContextView 删除 per-category 百分比和底部 Total 汇总行（冗余）
- SkillEventList token 改为 skill 相关 tool call 的 args+result 估算（与 Tool Calls 区段一致）
- TurnContextPanel System (hidden) 使用 API 返回的稳定 systemOverheadTokens（与中间 LlmInput 一致）

### Fixed
- ImportHistory 单条删除：无论 DB session 是否存在都移除 localStorage 条目（解决先删 session 后删 import 卡死的问题）
- LlmOutputView text 区段增加 labeled header（text badge + token 数）

## [v0.67] - 2026-06-17

### Added
- LLM Input 自动展开 — 可见 token < 6000 时全部消息默认展开显示完整内容
- TokenBarChart 按模型上下文窗口显示 Input/Output/Tool Calls 三段占比
- Overview 合并 Timing & Model + Token Usage 为一张卡片
- System (hidden) 稳定值 — 从首轮 assistant turn 计算，per-agent（root/subagent 各自独立）
- Tool Calls 标题格式 `Tool Calls (N, M skill)`
- SkillEventList 显示单条 token 数量

### Fixed
- inputMessagesJson 重建不再截断消息内容（之前硬编码 200 字符截断，前端永远看不到完整内容）
- inputMessagesJson 重建按 agent 隔离 — subagent 只用同 subagentSessionId 的 prior turns
- inputMessagesCount 按作用域计算 — subagent 只计算同 subagentSessionId 的 prior turns
- computeSystemOverhead per-agent 计算 — subagent 使用自身首轮 assistant，不再混入 root 数据
- subagent turn 选中时 root context 使用 rootTurn 数据（不再被 subagent 详情覆盖）
- LlmContextView 消息按钮行去掉摘要预览（CSS truncate 截断导致看不全），改为 role + token 数
- setHighlightSubagentSessionId → setHighlightSubagentTurnId（构建失败修复）

## [v0.66] - 2026-06-17

### Added
- LlmContextView 分离 visible messages 与 hidden system context
- TurnDetail 概览卡片合并（Token Usage + Timing & Model）
- TokenBarChart 三段 Input/Output/Tool Calls 显示

## [v0.65] - 2026-06-17

### Added
- start.sh `-f` flag — 清除 .next 缓存重新编译（Turbopack 缓存不生效时使用）

### Fixed
- `contextWindowPct` 和 `inputMessagesTokens` 现在包含 cacheReadTokens（真实 LLM 输入，不含 cache 时数据严重失真）
- TurnDetail "in: XXk" 显示模型真实输入（inputTokens + cacheReadTokens）
- ContextTracker / ContextReplay / GrowthChart 使用真实输入作为 context size
- subagent turn Context panel 加载 inputMessagesJson（之前只为 root turn 加载）
- inputMessagesJson 重建添加每条消息的 estimated tokenCount（之前显示 0t 0%）
- inputMessagesJson 重建逻辑修复：subagent turn 使用全局 prior turns 而非仅 subagent 内部 turns

## [v0.64] - 2026-06-16

### Added
- ESLint `no-mixed-operators` 规则 — 拦截 `&&`/`||`/`??` 混用，防止运算符优先级歧义导致的运行时解析错误

### Fixed
- Import Browse 输入文件路径后点击 Browse 打开父目录（之前停留在 input 步骤无反馈）
- LocalFileImport `??`/`||` 混用加括号（Next.js 解析器要求）
- CompareView `&&`/`||` 混用加括号

## [v0.63] - 2026-06-16

### Added
- Session 导出 — 导出 session 为独立 SQLite 文件 (`cannbot_session_<taskId>.db`)，Web UI 导出按钮 + CLI `cbin export` 命令
- CANNBot Insight 导入适配器 — 导出的 SQLite 文件可重新导入回 Insight（`import --source cannbot-insight`）
- 复合唯一键 `@@unique([taskId, framework])` — 同一 session 从不同源（opencode-db vs cannbot-insight）并存为两条记录
- Session Compare 改用 sessionId（Prisma cuid）选取和对比，支持同一 taskId 不同源的 session 对比
- 所有 observe API 端点新增可选 `framework` 参数用于多源 session 精确查找
- session API 端点新增 `sessionId` 参数用于 compare 页直接 cuid 查找
- ImportHistory / SessionList 新增 CANNBot 紫色 badge 显示 cannbot-insight 类型
- Agent Timeline 图表 — token heatmap + 点击导航到对应 Turn
- Agent firstPrompt — execution 列表显示每个 agent 的首条用户提示词

### Fixed
- start.sh 自动创建 `.env` 文件（修复首次运行 Prisma migration 报 `DATABASE_URL` 缺失，Issue #1）
- File Reads 点击 Agent 跳转到对应 Turn
- Workflow phase 渲染使用 unique phaseSequence 防止重复

## [v0.62] - 2026-06-16

### Fixed
- Subagent Tab 跳转和名称显示问题 — 使用 agentName 替代 subagentName
- computeEndPct 提升到组件级别（避免在 renderTurns 内重复创建闭包）

## [v0.61] - 2026-06-16

### Added
- Context panel 双指标条 — 显示 start→end pct（上下文窗口起始和结束占比）

## [v0.60] - 2026-06-16

### Added
- Import 性能优化（23.5s → 1.6s）— batch write + 并发导入
- Import Session 对话框默认路径 `/`
- start.sh `-k` flag — 杀掉占用 21025 端口的进程
- start.sh 自动打开浏览器（WSL: cmd.exe / macOS: open / Linux: xdg-open）

### Fixed
- WSL 自动打开浏览器 — 通过 cmd.exe 全路径（interop 不在 PATH 时也能工作）

## [v0.59] - 2026-06-16

### Added
- CLI 功能对齐 — Interactions tab、search、ToolCalls 统计、detail 增强

## [v0.58] - 2026-06-16

### Added
- CLI 功能对齐 — Overview cards、Turn detail、Trace tab、Context trend、Subagent hierarchy

## [v0.57] - 2026-06-16

### Added
- CLI WorkflowTab 交互 — cursor 导航、展开/折叠、context 显示

## [v0.56] - 2026-06-16

### Added
- Workflow tab 右侧 Context panel
- Token 拆分为两个卡片 — Tokens + Cache Read

## [v0.55] - 2026-06-16

### Added
- Context Replay 动画 — subagent spawn/death 标记可视化

## [v0.54] - 2026-06-16

### Added
- WorkflowTreeView 重设计
- opencode-db adapter 重构
- TurnContextPanel 组件

### Fixed
- subagent 显示使用 agentName

## [v0.51] - 2026-06-16

### Added
- TurnTimeline 重设计 — root turns 主时间线 + subagent 并行车道

## [v0.50] - 2026-06-16

### Fixed
- Workflow phase 去重 — 同 phaseIndex 不创建重复 phase
- strip `<thinking>` 标签从 phase 名称

## [v0.49] - 2026-06-16

### Fixed
- Workflow phases 填补 turn 间隙 — phase 边界之间 turns 连续分配

## [v0.48] - 2026-06-16

### Added
- Skill badge 显示 skill 名称（而非数量）
- Overview 会话摘要 + agents/tools 两列布局

### Fixed
- Context page RangeError — allSessions unchecked 时 GrowthChart 空 allPoints 处理

## [v0.45] - 2026-06-16

### Added
- Turns tab 左右面板独立滚动 + turn 切换自动滚动到顶部

## [v0.44] - 2026-06-16

### Added
- Step node 展开 subagent turns（thinking/tool calls/skills）
- turns API subagentSessionId filter + includeDetail param
- Prep phase turn range 包含所有 root turns

## [v0.43] - 2026-06-15

### Added
- Workflow 准备阶段 — 阶段一之前的 turns 自动归入"准备阶段"(phaseIndex=0)，包含 content 摘要
- WorkflowTurnNode 类型 — 新增 turn 类型节点，用于展示纯文本 turn（无 subagent dispatch）

## [v0.42] - 2026-06-15

### Added
- Session Compare Turn-by-Turn tab — 每轮 turn 左右对比，显示完整提示词/输入/输出/thinking 内容
- Turns API `includeContent=true` 参数 — compare 页面切换 Turns tab 时按需加载 turn content
- Compare 页面 tab 切换（Overview / Turn-by-Turn）
- 首页 Compare 入口提示 — 显示"Select 2 sessions to compare"/"1 selected — select 1 more"

## [v0.41] - 2026-06-15

### Added
- Tool Calls 卡片显示 token 消耗（total/in/out + latency）
- opencode-db 适配器 N+1 优化 — listSessions 从 ~200+ 次查询减少到 5-6 次批量查询
- opencode-db 适配器 readSession N+1 优化 — 从 N×3 次 part 查询减少到 3 次批量查询
- 导入计时日志 — console.log 打印各阶段耗时便于排查

### Changed
- LlmOutputView 始终传递完整 content — 不再因 content > 10K 而隐藏

## [v0.40] - 2026-06-15

### Added
- Thinking 内容显示 — opencode-db 适配器 reasoning 内容用 `<thinking>` 标签包裹，Web UI 自动识别并折叠展示
- Tool call 截断提升 — argsJson/resultJson 显示截断从 500 字符提升至 2000 字符，标注总长度

### Fixed
- LlmOutputView 始终传递完整 content — 不再因 content > 10K 而隐藏 thinking/输出内容
- isLongContent 警告移除 — 内容不再被抑制，由组件内滚动条自然处理

## [v0.39] - 2026-06-15

### Fixed
- 导入事务超时 — $transaction timeout 从默认 5s 提升至 60s，maxWait 从 2s 提升至 30s，解决大 session 导入报错 "Transaction already closed"

## [v0.38] - 2026-06-15

### Added
- Web UI 目录浏览器 — Import Session 对话框新增 Browse 按钮，交互式浏览目录选择文件
- API 端点 `/api/ingest/browse-directory` — 服务端目录列表，自动标记可导入文件（.db/.jsonl）及 importableType
- CLI FilePicker 组件 — TUI ImportPanel 输入目录路径后显示目录浏览器

## [v0.37] - 2026-06-15

### Changed
- 导入性能优化 — create → createMany + $transaction 批量写入，单 session 35-100x 加速
- 新建路径：8 条 createMany 替代 ~104 条 create（turns/toolCalls/skillEvents/bridges/executions/executionSkills/sessionSkills + session）
- 增量路径：3 条 createMany 替代逐条 merge 写入
- batchCreateMany 分批保护（500 条/批），防止 SQLite 变量限制溢出

## [v0.36] - 2026-06-15

### Added
- CLI 前端迭代5 — ImportPanel 交互修复（filePath/source 可输入）、SessionList 搜索修复、TUI 快捷键（Space/c/i/d）
- analyze 命令 — AI workflow 分析（--base-url/--api-key/--model/--json）
- DataTable 标记对比功能（◉ prefix + markedIds/idKey）
- start.sh `-c` flag — 后台启动后端并等待就绪

### Fixed
- ContextTab 移除重复 MODEL_CONTEXT_WINDOWS，使用共享 context-window-config
- App.tsx 传递 onCompare/onImport/onDelete，delete 有 ConfirmDialog

## [v0.34] - 2026-06-14

### Added
- CLI 前端迭代3 — TUI 交互模式（Ink + React），SessionList/SessionDetail/TurnDetail/CompareView/ImportPanel 五屏
- StatusBar/KeyBar/DataTable/MetricCards/TextInput 等自建组件

## [v0.33] - 2026-06-13

### Added
- CLI 前端迭代2 — 核心命令实现（sessions/session/turn/search/compare/stats/import/delete/config）

## [v0.32] - 2026-06-12

### Added
- CLI 前端迭代1 — 地基模块（Commander.js 入口、API client 15 端点、类型定义、hooks）

## [v0.30] - 2025-06-14

### Added
- Session Compare — 首页选取两个 session 对比（token、费用、耗时、工具调用、subagent）

## [v0.20] - 2025-06-14

### Added
- Claude Code JSONL 适配器 — 导入 Claude Code session JSONL 文件
- 多适配器架构（opencode-db + claude-jsonl）

## [v0.15] - 2025-06-07

### Added
- Context 📊 Tab — 上下文追踪，按 subagent session 展示增长曲线
- AI Workflow (beta) — LLM 驱动的 workflow 分析

## [v0.13] - 2025-06-05

### Added
- Trace 🔍 Tab — 概念溯源追踪，关键词搜索、传播链路、DAG 图

## [v0.12] - 2025-06-04

### Added
- Interactions 页面重构 + 时间轴

## [v0.09] - 2025-06-01

### Added
- Workflow ✦ Tab — phase-split 核心算法 + WorkflowTreeView
- Subagents Top3 消耗标识

## [v0.01] - 2025-05-24

### Added
- 初始版本：Opencode DB 导入、Turn 级存储、Token 五项拆解
- 上下文治理、Subagent 追踪、Skill 事件、交互链路图
- Web UI（9 个 Tab）
