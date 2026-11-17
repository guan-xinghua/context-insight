# Context-Insight

LLM 编码 Agent 的 Session 级可观测工具：导入 agent 会话日志，逐轮分析 token、上下文、子代理与技能使用。

**[English Documentation](README.md)**

## 功能介绍

导入 SQLite（opencode.db）或 JSONL（Claude 原生 / Codex 原生 `rollout-*.jsonl` / DSH 原生 `session.v4.jsonl`（含 `.zstd`）/ cpx proxy 捕获，明文与 `.jsonl.7z`、存量 `.jsonl.gz` 均可，`cpx-` 前缀自动处理），进入 run 统一工作台的分析 Tab——会话即 solo run，与 Opsbot 工作流 run 共用同一详情面。JSONL 是单一「JSONL (auto)」入口，按文件内容自动识别 Claude / Codex / DSH，无需按框架选择：

- **Token 与费用** — 每轮 token 五项拆解，按模型上下文窗口显示占比，估算费用
- **上下文增长** — 恒定满铺画布承载逐 agent 上下文增长曲线，缩放为 Perf 同款时间窗语义（Ctrl/⌘+滚轮光标锚定、拖拽平移只作用于时间轴——图框永不整体放缩，刻度与 y 量程随窗口自适应、窗口内曲线重采样，曲线点选聚焦），画布内快捷显隐分段控件，图例胶囊司显隐高亮、Agent 概览多列卡片司数字（全名不截断，命名出自 run-actor 参与者目录单一源），动画回放与 `/compact` 压缩点标注
- **活跃 / 墙钟** — 会话详情 Wall Clock 拆分（活跃 + 非活跃 = 墙钟）与首页 Active / Wall 列：事件聚类口径（间隔 >5min 计非活跃、API 调用进行中计活跃）
- **上下文治理** — 查看每轮 LLM 输入构成：可见消息 + 稳定 System 开销
- **Subagent 追踪** — 识别子代理会话与 dispatch→response 链路，时间线内联展示
- **Turn 播放器** — run 是一卷胶片：节点状态时间线压顶（状态段一览全程健康 + 活动节点加高锚定与标识簇 + 代际发丝分隔），代分组节点列表（成员会话懒加载、子代理泳道嵌套），选中轮进传输条播放器（胶片轨 + 跨节点连续走查）与 Δ 优先输入卡
- **Wire 轮次**（proxy 捕获）— 逐轮重组完整 wire 输入/输出，与 DB 重建对照；`-a` 启动显示
- **system 行噪声治理**（proxy 捕获）— wire 的 system 组件无消息 id，捕获侧逐请求原样落盘：token 预算倒计时（`<total_tokens>N tokens left</total_tokens>`，纯 wire 簿记）随处剥除、剥后为空整行跳过；逐请求随行的静态注入按剥除后内容去重（同文首现保留一次）。真实系统事件（上下文告警、hook 注入、CLAUDE.md、日期/环境变更）全保留；wire 保真不受影响（回放 / 技能全集 / 全文上下文均读原始捕获，不经 Turn 表）；存量会话重导入即自愈（位次漂移触发全量替换）
- **工具耗时保真**（proxy 捕获）— wire 历史重放不再覆盖首现 tool_result 载体行：completedAt 锚定真实完成时刻（首条载体），工具时长不再被后续请求的历史重放撑到小时级（真机现场：42ms 的 Bash 被记成 50653.9s）；重放行不产生额外轮次；存量会话重导入即自愈
- **单轮耗时**（Turns 左列）— 每行时间从「模型耗时」改为「单轮耗时」：一轮从开始到自身工作完成的墙钟口径，claude 格式（proxy wire 捕获 + claude 原生）与 codex 原生 = 生成 + 最慢并行工具（opencode 原生消息时长已含工具执行，保持原值防双计），工具有贡献时悬停出「模型 + 工具」分解
- **工具窗口双模型**（cc-db-turn 原生导出）— lake bundle `.native` 成员的工具时长推导：该形态 assistant 行 ts = 请求发出、duration_ms = 请求→响应、工具结果载体行与之同戳——wire 轮间隙窗口按时间戳模型逐窗判别（同戳窗口取 [ts + duration_ms, 下一请求行 ts]），137 成员 bundle 4168 个带工具轮恢复毫秒级真实窗口
- **Skill 事件 / 覆盖度 / 全文** — 每轮 skill 事件（双 wire 形态：claude-code 的 Read 读 SKILL.md 协议与 codex 的 skills_instructions 协议——后者模型用 `exec_command` 读类命令自行读文件，链式命令 `echo …; cat …/SKILL.md` 按分段独立判定）、事件关联真实工具调用（真实时长，不合成 `skill/<name>` 工具行污染工具统计）、可用 skills 全集对照使用情况、SKILL.md 全文重建（Skill 工具注入 / read 类工具 / shell 读类命令三通道，带行范围截断标记）
- **Agent 定义恢复** — 子代理 `.md` 定义一键取全文：会话内 system 注入优先，磁盘扫描兜底
- **概念追踪** — 跨轮关键词搜索、传播链路与 DAG 图，结果可按来源/thinking/工具过滤
- **文件读取分析 / 内容复卷 / 重编汇册** — 重复读取检测、单文件逐行重建、整目录重建打包下载
- **Session 对比** — 两个会话（solo run，按 taskId 选取）的 token / 费用 / 耗时 / 工具 / 子代理对比
- **轨迹评分** — 六维评分卡（完成度否决维 / 行为可信 / 质量 / 效率 / 冗余 / 自主性 + 自定义维度），支持基线对比与评分配置 profile；评测数据可导出版本化 JSON（`insight-score-export@1`）——全员评分卡 + 维度定义快照（维度↔子项↔权重↔聚合策略，匹配关系自解释）+ 溯源信息（版本/口径/时刻），供自循环演进（RSI）管线消费，Score 板块内导出按钮与 API 端点同款载荷；除网页「Mate Agent 评审」（规则层进程内直算 + 本地 claude/opencode CLI 判 LLM 子项）外，同一套评分可完全脱离服务进程独立执行：`ctxi score --session <taskId> --tool claude|opencode [--framework fw] [--out result.jsonl] [--no-store]` 直接读本机库，NDJSON 事件流（meta / progress / done / error）写 stdout 或文件，终端同步呈现友好评分视图（色条总分、逐维分数与逐子项明细），默认与网页路径落同一张评分卡；不带 `--session` 直接进入**左配置 / 右输出**统一双栏 TUI（`npm run score` 一键进入）：左栏跨分区连续光标（来源：本机库 / 目录（常用 agent 目录快捷项 + 手动路径）→ 会话清单 → agent 工具 → 运行），`[Space]` 勾选、`[T]` 全选、`/` 跨列过滤；右栏预览 / 逐维进度 / 评分卡三态常驻，批量运行给逐会话汇总可进详情；目录扫描自动发现全部会话（jsonl / opencode db / codex rollout），未导入的先走标准管线导入再依次评分；`[O]` 打开 insight 评分页（端口登记 → env → 21025，WSL 用 wslview）；评完的会话结果**默认即时落盘**（`~/.context-insight/score-results/<原会话名>.score.jsonl`，状态行回显路径），重开 TUI「已完成」区自动回载历史（↺ 行，Enter 直接看评分卡，重评即覆盖）；键位不分大小写
- **Audit** — run 级三域审计（左侧域导航 + 目标列表，右侧对账报告）：Skill / Agent 声明对账涉事成员全体 transcript（Agent 域目标覆盖全派发工具族——claude Task/Agent、opencode task、codex spawn_agent——事件名与泳道标注一致；源 bundle 在盘时走 sift `--run` 原生对账——成员枚举/目标匹配/原生调用溯源交给 sift，报告带命中会话与调用数；否则回落多 transcript 单次跨成员聚合，finding 均带成员归因）、Workflow（主 agent 编排组合声明）按成员 root 段对账——报告由 sift JSON 自渲染为五态瓦片、指令分组与成员徽标，运行态进度条只按已完成批计数（跨成员切片不回落），报告含声明覆盖原文快照折叠面板（对账时刻的声明原文整篇呈现，绿=已触达 / 黄=未验证 / 灰=未建模直接涂在文本上）与失败置顶的指令排序
- **密钥脱敏**（proxy 捕获）— API key 永不落盘：落盘入口统一打码（`前4…后4`）
- **数据仓上传** — 统一工作台行内 / 页头把会话与 run 上传数据仓：密钥治理后按范式目录归档，支持 baseline 基准位与任务结果标注；proxy 捕获行可勾选「同步上传本机原生会话」——自动定位同一场对话的原生记录（已导入行直取；本机磁盘按框架发现：Claude / opencode / DSH 按会话 id，Codex 按捕获时间窗 + 首问锚点），未导入的先自动导入，与捕获一并落 `<sid>.native/` 同 sid 双记录（Codex 原生会话 id 不同，以自己的 id 落位）；CLI 同款 `--with-native`；数据仓未配置（无地址 / 令牌）时上传弹窗打开即弹「连接数据仓」引导——填远端地址与推送凭据，保存后范式目录自动加载、直接继续上传，免绕道设置页，全上传面（主页 / run 页）一致；git-lfs 缺失时自动安装——任一数据仓动作即在后台预热自举（GitHub 直连慢时自动回退公共镜像，sha256 pin 校验），LFS 模式上传/导入零手工安装；上传完成后顶置结果 HUD 即时反馈（毛玻璃卡）：成功绿勾自动退场并关弹窗（原生会话同步结果作副文）、失败红叉错误驻留弹窗内可读可复制、run 包缺正文告警琥珀警示且完整清单驻留弹窗，全上传面（主页 / run 页）一致

主页是统一工作台（资料库形态）：大标题页头之下，总览条把 Sessions / Tokens / Cost / Duration / Errors 五项指标合成一块毛玻璃横幅（大号 tabular 数字、Errors 非零红色强调），资产列表为分组列表——会话与 Opsbot run 混排，每行 = 框架渐变 App 图标（一眼可扫的类型位，右上角常显小勾选角标：空心/实心对勾）+ 标题与元信息行 + 右侧 Tokens / Cost / Active·Wall 微型统计列（列宽固定、跨行纵向对齐），行操作（删除 / 上传）悬停浮现（DB 导出在详情页页头）；「类型」分段控件是行过滤器（滑动指示条，纯 CSS）——全部 / 会话 / Run——不是视图切换；支持关键词 / sessionID 搜索（防抖自动 + 回车立即）；多选批量操作收进底部浮动毛玻璃条（已选计数、两会话对比、批量删除），单一「导入」向导覆盖全部来源——选择即类型：本地 SQLite/JSONL 文件、workflow-bundle 目录、或 contextBay 数据仓（目录即注册表——先选顶层目录，目录内会话与 Run 包同格呈现，可混选导入）；同一统一入口（行内 / 页头）负责上传到数据仓；最近导入以同款分组列表常驻页底（文件路径 / 查询 / 状态点）。

**Run 观测** — Opsbot graph 运行以行形态混入统一工作台（「类型」下拉过滤）：通过单一「导入」向导（选择即类型——本地含 `workflow.json`/`manifest.json` 的 bundle 目录高亮、点击即导入）或 `ctxi import-bundle <dir>` 导入 workflow-bundle 目录（`workflow.json` + `workflow.schema.json` + `sessions/`——结构契约随包分发，导入时哈希验真）；同一向导也可直接从 contextBay 数据仓导入（先选数据仓顶层目录、再在目录内过滤/勾选 bundle 包，批量导入并逐项显示进度）；成员会话即时全量走标准管线入库——**run 导入的会话只在 run 详情内查看，不进统一资产列表**（删除 run 会同时删除由它导入的会话，导入前已存在的会话不受影响）；run 详情页是 11 tab 观测工作台（Overview / Graph / Turns / Context / Audit / Perf / Skills / Files / Wire / Replay / Score；Wire 与 Replay 为高级 tab，经 URL `?a` 或 `NEXT_PUBLIC_SHOW_ADVANCED_TABS` 展开），全局 chrome 顶行为品牌区（渐变图标 + 双色字标 + 版本徽标，坐镇最左上角，点击回工作台首页）+ 仅活动时可见的同步 chip（同步中/自动同步）+ 动作簇：单一三态刷新控件（自动同步 / 同步中 spinner / 手动刷新）+ Markdown 导出（solo 专属）与离线 HTML 导出（全部 run 可用——导出文件内嵌真实 run 工作台，全员成员、与 live 默认视图同款 tab 面，单文件离线可交互），上传为实心主操作药丸；返回钮坐镇导航行最左（与 tab 同行）——圆头 chevron（工作台内有可回退历史时亮出残影双 chevron，悬停轻推、按压回缩，纯 CSS 动效），语义为回退上一个工作台动作：tab 切换、turn 深链、成员钻取逐步回退（tab 内调整不入栈）——每个工作台动作是真实浏览器历史条目，鼠标侧键/浏览器返回钮与本钮同一出口逐步回退、前进键重放，栈空时回上页（直开深链回工作台首页）；run 身份归入 Overview 首卡——三区结构（发丝分隔）：身份区 = prompt 派生的 run 名按句读截短成首分句（全文与 runId 悬停可达）+ 状态点药丸、会话/工作流徽标、数据完整性与省略显示的可复制 runId（solo 前缀省去、中段省略，悬停/复制给全文）；元信息区 = 键值网格（小标签上/值下：框架、模型、成员、时间窗[同年省年、同日省重复日期]、代码统计、来源[中段省略 + 复制]）；指标区 = 单行自适应的紧凑 inset 指标瓦片（容器够宽时一行铺开、窄窗口自动折行——Tokens / Cost / Wall Clock[活动圆环 + 活跃时长，完整拆分悬停] / LLM Active[时长按量级进位] / LLM Calls / Skills[去重技能数，与下方 Skills 列表头同口径] / Subagents / Turns / 红色错误深链——工具调用不在此重复，由下方 Tool Calls 分组承载）——session 视图保持框架名为卡内大标题，同享元信息网格与指标瓦片排版（离线 HTML 导出即 run 工作台自身，首卡同样是 run 名）；浏览器标签页标题镜像 run 名，多 run 并开时可区分。加载态与错误态与加载后同壳：chrome 即时成型（返回/品牌可用，动作簇以等宽占位），导航药丸与首卡按真实形状给骨架（三区结构 + 泳道，占位逐项错峰 pulse，网格类与真实卡片一致），加载完成只有内容区填充、无整页跳变；加载失败在面板区居中给错误卡（返回/重试）。导航为凹槽分段控件——与返回钮同行，居中收束的凹槽轨道（宽屏居中成主控台位、窄屏自动占满整行，药丸永不折行挤压，可滚动时边缘渐隐提示），活跃项为浮起卡舌（白卡 + 发丝环 + 分层投影，与域导航/成员轨道同一语法）在药丸间滑动、图标彩色常驻（非活跃压暗、激活点亮），活跃项自动滚入视野、面板切换带淡入，session 能观测的维度 run 全部可观测：Overview 以仪表盘开场——分组画布上的大标题身份卡 + 内嵌指标瓦片（Wall Clock 带活跃占比活动圆环；服务端聚合数值即刻渲染、客户端派生瓦片先 shimmer），随后泳道（标题拆出子代理数）与技能/工具调用/错误轮的 inset 分组列表逐项延迟入场；面板数据在页面挂载瞬间与 run 详情请求并行预取（五端点齐发、lanes 在内——零请求瀑布、零误导空态，骨架屏撑住版面直至真实数据落位）；Graph 在与全站一致的工作台内以纯 SVG 渲染多代 DAG（回滚代带、重试历史、carried/未运行占位、生成器子图）——正交电路风走线（统一右行/下行，不向左折）——交叉处 PCB 半圆跳线（交叉不相连）、点击节点点亮关联边跑马灯（状态色加粗 + 流动光点，其余边压暗静止，点击空白熄灭）、Ctrl/⌘+滚轮以光标为锚缩放、拖拽平移与一键适配——节点侧栏提供逐次尝试（验收结论、Bash 输出）与成员会话 turn 下钻；Turns 把 run 读作一卷胶片：顶部 Run 轨 = 节点状态时间线（状态色段一览全程健康，活动节点加高锚定 + 标识簇常驻，代际发丝分隔，节点详情悬停可达；单行容纳任意节点数），下方代分组节点列表——节点实例按需展开为成员会话（执行/验收标注、按成员两段式自动拉齐——首页小页快出首屏、剩余自动补齐到全集，手动「加载更多」仅在补拉中断时作为重试入口出现，Bash 尝试直显输出、未运行/沿上代占位），轮次为紧凑单行（子代理泳道按桥嵌套照旧），左列顶部常驻角色多选筛选条——胶囊 chips 带角色点与计数（user/assistant/system/命令/续接/压缩等，按已加载轮次实际出现的角色列出），点选即多选并集、「全部」一键清空；主链与子代理泳道行同口径过滤，派发行被滤掉时其泳道有匹配轮仍留原位、无匹配的泳道整块让位；选中轮打开 Turn 播放器——毛玻璃导航条（圆形走查钮 + 标题/位置 + 身份药丸）下衬 token 标度胶片轨（聚桶、O(1) 走查），←/→ 跨节点边界自动加载连续走查；指标区三张圆角瓦片（小标签上/大数字下：模型/工具耗时分解含 TTFT、token 流向、窗口水位带同 agent 维度 Δ）；叙事舞台为灰画布上的无边框分组卡（Δ 优先输入卡——本轮新增默认展开、历史与 System 开销各一行收纳；thinking 引用、markdown 正文、工具/技能调用合并）；选中轮的节点归属经 turn 详情的成员 taskId 单点解析（深链与跨 tab 跳转同路），solo run 退化为单节点自动展开，离线导出内嵌的正是这套工作台；Run 轨右端常驻搜索胶囊，跨成员全域一框全能查询语法（空格多词 AND、引号短语、`-词` 排除噪声，可组合结构化算子：`role:`/`member:`/`agent:`/`tool:` 按角色/成员/子代理/工具筛轮、`error:true` 不猜错误文本直列出错轮、`thinking:>5k`/`dur:>10s`/`tokens:>10k` 阈值筛长思维链/慢轮/大轮、`after:15:30`/`before:` 时间窗；纯文本词搜正文/摘要/工具参数·结果·错误·工具名六路，`#N` 轮次直达（run 级解析：敲下 `#` 即时提示；单命中直接跳，多会话同号轮弹下钻选择——当前会话置顶带徽标，键盘 ↑↓/Enter 与点击皆可、Esc/外点关闭；全 run 无该轮才提示未找到），⌘K 聚焦）——命中全量返回全量展示，以毛玻璃浮层覆盖左列（节点列表在玻璃后常驻虚化、滚动位置保留；浮层即命中索引：首行起源标记、成员徽标、匹配字段标签、已读降透明、↑↓+Enter 连续走查，可按来源×thinking×工具名多维组合过滤（跨维相与、维内多选、带计数）、「全部」复位），与播放器并排同屏、点开命中不消失，仅用户主动退出（✕/Esc/点 Run 轨）才撤下浮层回节点列表；离线导出同款胶囊，对内嵌轮次档案做客户端搜索（同一查询语法）；Context 按 agent 追踪上下文用量（成员会话即 root agent、子代理池化）：单张趋势卡（页面只留曲线形状，数字全归各 agent 的下钻档案弹窗）——增长曲线自初始轮（0-token 派发消息）从 0 生长到初始上下文再逐轮爬升（无独立初始轮的 agent 在首数据轮处零宽起步，曲线读作「0 → 初始上下文 → 增长」而非从首个测量值凭空起步），落在 Graph 同款画布（相机模型：拖拽平移、Ctrl/⌘+滚轮光标锚定缩放、一键适配、玻璃缩放工具条，世界尺寸随视口自适应铺满全宽，永不出现滚动条），画布内自带 全部/仅 Root 快捷分段控件与曲线点选聚焦（原地点击曲线选中该 agent——其余变灰、选中加亮，再点同线或点空白取消）；图例胶囊纯图例化（root 一键 + 子代理类型条目计数，点类型整组收起/展开；默认可见阈值自适应——agent ≤ 12 全显，超出聚焦峰值 Top-K，胶囊区折叠为预览 + 展开滚动并带搜索框按名过滤）只司显隐与瞬时高亮，点胶囊下钻箭头从右侧滑出该 agent 的上下文档案——为「一眼回答」设计的常驻阅读面：身份行（组名 + root/subagent 或派发徽标 + 轮次；多实例组附 Σ 汇总与实例清单，行即切换器）、关键四数一次扫读（峰值 / 窗口水位——Context 风险主指标，>50% 琥珀、>80% 红着色 / 逐轮增速 / 缓存命中）、该 agent 自己的增长趋势小图（逐轮轴、缓存读份额带、80/100% 窗口参考线、/compact 标记；多实例组以灰线同框对比）、风险时刻胶囊（只留可操作项——/compact 落差 pre→post 百分比与越限警告，无风险整节隐去）、缓存效率卡（峰值轮构成解释命中率 + 命中/节省/无缓存倍数），收尾 → Turns 跳转带成员归因；命名一律出自 run-actor 参与者目录单一源——成员按工作流节点短名、子代理按类型（别名归一）+ 同名编号、无类型子代理回落派发步骤并带「派发」徽标，两种命名群体不再裸混一列——含 /compact 标记与动画回放；Audit 为 run 级三域审计板（左域导航 + 目标列表、右对账报告）——Skill / Agent 声明 × 涉事成员全体 transcript（源 bundle 在盘时走 sift `--run` 原生对账并带命中会话/调用数溯源，否则单次多 transcript 对账；finding 恒带成员归因）、Workflow 各成员主 agent 编排声明对账，报告由 sift JSON 自渲染为五态瓦片、指令分组与成员徽标（finding 深链成员轮次；成员分布行可点选收窄到单成员），solo run 退化为同款单成员板；Perf 按成员性能全景（执行切片 / TPS·TPOT / 子代理开销）+ 工具维度耗时卡（左右排版：左工具耗时统计、右下钻详情面板——master-detail，窄视口面板沉底，默认选中 Σ 最高工具）——左列与热点排行同门语法（inset 分组列表、行悬停浮层、chevron 弹性选中、标签上/值下统计列、悬停浮现的下钻角标）：逐工具行（调用/错误计数与错误类型悬浮；居中统计列 = 总耗时 + 最大耗时——均值会撒谎，最大是长尾的直觉读法，p50/p95 分位保留在悬停读数；成员构成归右栏分解面板单一出口）；右栏成员分解面板（全量成员按 Σ 降序 + 比例条 + 搜索框双匹配显示名/原始 taskId——成员是无界维度，solo 1 个到大 run 数百个，纵向清单 + 搜索是高基数观测的收敛形态，超限折叠「展开全部」）；下钻三级：工具行选中 → 成员分解 → 成员行展开逐轮调用清单（`#N` 轮次序号与 Turns `#N` 直达同口径、同轮多次调用聚合一行 ×N、Σ 降序找慢轮、无计时轮如实标注、卡片内滚动窗——多调用成员不撑长面板）→ 轮次行点击跳转该轮（`?turn=` 深链 + 轮详情深钻；逐轮数据由 tool-stats 单一源嵌入矩阵格，离线导出同款可用）；计时轴诚实（DB 真实值优先，cpx/wire 捕获的零计时按 wire 轮间隙推导回填，无计时不进分位，Task/agent 派发窗口带「派发」徽标另计防双计；skill 族元调用——skill / load_skill 等提示词注入类技能加载——带紫色「技能」徽标，悬停解释耗时语义：非工具执行）；点工具行下钻角标以 `tool:` 搜索语法深链 Turns（命中索引即调用清单），`?q=` URL 镜像可分享；Skills 跨成员技能聚合与归因过滤；Files 跨成员文件读取分析（重叠/冗余）与恢复重编（单文件/整目录 zip），排版对齐工作台卡片语法——头卡（文件名搜索胶囊 + 过滤分段 + 类型筛选 chips + 标签上/值下的指标瓦片 + teal 重编汇册及其回执）下接类型分组的发丝分隔文件列表：文件名优先（路径/读取量为次级信息、读取量以中性比例条示意），行展开即行级指标与成员 × 子代理读取明细（#序号 turn 深链），单文件循迹复卷逐行重建原文（gap 行如实斜体标注、可下载、屏外行跳过渲染）；文件行与复卷长文本均 memo——展开或复卷某个文件不再引起全表重渲；Wire 按 按成员回放原始 wire 轮次，Score 按成员跑六维轨迹评分卡——浅灰画布壳 + 单行凹槽胶囊轨道选成员（浮起卡舌，成员再多不折行），雷达与维度卡按面板宽自适应分列（容器查询，不再随视口宽度误落单列），轨道右端带评分 JSON 导出（版本化评测数据——全员评分卡 + 维度定义快照 + 溯源信息，自循环演进管线的语料入口；live 与离线导出内均可用）；会话以 solo run 形态打开同一工作台（会话徽标），run 页头可导出 Markdown 与离线可交互 HTML bundle。`ctxi runs` 列出已导入 run。导入后可从统一工作台的 run 行把持久化 bundle run 上传到 contextBay；solo run 页头则上传其底层会话（taskId，不走 bundle）：填提交人/内容描述与范式目录，整包（manifest、体检报告、成员会话）由 insight 装配（成员会话从本地库重导出、统一压缩、全量密钥清洗，同名包重传整体替换）推到所选范式目录 `<范式>/<runId>/`——数据仓不按资产类型分区，会话与 run 都可上传到任意顶层目录，换目录重传自动迁移旧位置；数据仓源视图的各目录内可浏览其中的 Run 包并一键导入本地。详情页观测端点全面轻量化：合并轮次恒显式投影（contentSummary 缺失的正文回退以 substr 下推 SQLite，全文不再整列进内存/响应）、Overview 的错误摘要由服务端预算（`includeErrorDigest`——错误计数与消息提取和客户端计算同一实现，工具结果原文 18MB 级不再进响应）、wire 工具时长在服务端启动期后台预热（7z 捕获冷读是秒级同步阻塞，预热后首个详情请求不再为其买单）。

**数据仓源视图** — contextBay Viewer 已并入统一工作台成为数据源视图（页头数据仓按钮切换，URL `?src=lake`；旧 `/lake_viewer` 链接重定向到新位置）：范式侧栏以数据仓顶层目录为注册表（统一布局——每个目录同时呈现会话运行与工作流包，不按资产类型分区），运行表支持筛选（框架 / cc 版本 / 任务结果 / 已评分 / 已导入 / 关键词 / 日期区间），任意 run 一键导入本地库，逐 run 的实验记录存数据仓（备注、评分卡快照（带冲突检测）、任务结果标注——经 git 团队共享），任务耗时优化图可编辑基线/期望目标，首次克隆显示数据仓同步进度。

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
- `npm run build` 会先停掉本仓运行中的服务器（构建重写 `.next` 后，存活实例会新旧代码混跑）；构建后用 `./start.sh` 重启
- 浏览器打开 `http://localhost:21025`

日志文件位置：
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/`（目录自动扫描）
- Codex: `~/.codex/sessions/`（rollout 文件；子代理会话自动并入主会话）
- DSH: `~/.dsh/sessions/`（`session.v4.jsonl` / `.jsonl.zstd`；子代理会话自动并入主会话）

Web UI 还支持：导出 session 为独立 SQLite 或 Markdown，以及从 run 工作台页头导出完全离线可交互的 HTML bundle（内嵌真实 run 工作台——solo 与多成员 run 均可导出）。LLM 接入面板内置常见提供商 Base URL 速查。

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
