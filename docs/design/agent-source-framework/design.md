# 多 Agent 源接入框架（Agent Source Framework）— 设计

> 触发需求：insight 适配 codex 原生会话（`~/.codex/sessions/` rollout 文件）。
> 借此把「多源接入」从散点式适配升级为系统性框架，后续新 agent 框架接入
> 只需一个适配器模块 + 一行注册。

## 一、旧架构诊断：接入一个新源要动 7 个散点

| # | 散点 | 位置 | 问题本质 |
|---|------|------|---------|
| 1 | adapter 注册 switch | `adapters/index.ts` | 唯一像注册表的地方，但契约只有 2 个方法 |
| 2 | normalize 分发 switch | `normalize.ts` | 两个现有实现逐字段相同，分发是假需求 |
| 3 | 身份映射内联三元 | `data-service.ts`（`srcType==='claude-jsonl'?'claude-code':srcType` 等 3 处） | sourceType↔framework 双向映射散在导入正向/刷新反向两侧，口径靠人肉同步 |
| 4 | 子代理并入分支 | `data-service.ts`（`srcType === 'claude-jsonl'` 硬编码） | 子代理发现机制没进契约，每个框架是 data-service 的私货 |
| 5 | API source 白名单 | `import-file` + `import-file/sessions` 路由 | 字符串枚举 ×2，新源必改 |
| 6 | 文件嗅探 | `browse-directory` 路由内联三元 | 优先级/兜底藏在路由里；codex 的 `rollout-*.jsonl` 会被误判成 claude-jsonl |
| 7 | UI 源选项 + 快捷路径 | `LocalFileImport.tsx` 硬编码 | QUICK_DIRS / source union 写死在组件 |

**根因**：`Adapter` 接口只声明了解析（`listSessions/readSession`），而一个「源」
实际要声明的全部信息——身份（framework 落库值）、子代理发现、版本提取、
文件识别、UI 呈现——泄漏到了各调用方，散弹枪修改是必然结果。

## 二、目标框架：分层 + 单点注册

```
┌─ Serving 读层（不动）─────────────────────────────────────┐
│ 22 个 /api/observe/* + Web/TUI/CLI 三端                    │
├─ Pipeline 管线层（不动）──────────────────────────────────┤
│ normalize → turn-split → bridge → execution-split → 写库   │
├─ ★ Registry 注册层（新）─────────────────────────────────┤
│ SourceDescriptor 单点声明一切；身份双向映射；文件嗅探       │
├─ ★ Adapter 适配层（每框架一模块，内核不改）────────────────┤
│ 解析内核 + 框架特有逻辑（注入分类/子代理发现/版本提取）    │
└───────────────────────────────────────────────────────────┘
```

### 2.1 核心契约（`adapters/contract.ts`）

```ts
export interface SubagentRef {
  id: string;                  // 子线程 id（= subagent_session_id）
  filePath: string;
  name: string | null;         // claude: meta.json；codex: agent_nickname
  type: string | null;
}

export interface SourceDescriptor {
  // ── 身份（单点声明，消灭内联三元）──
  sourceType: string;          // 文件格式标识：'opencode-db' | 'claude-jsonl' | 'codex-jsonl' | …
  framework: string;           // agent 归属（DB Session.framework 落库值）：'opencode' | 'claude-code' | 'codex' | …
  // ── 解析（原有契约；dbPath 可能是文件或 sessions 根目录——UI「列表
  //    选择→导入」流程传目录，适配器自行按 sessionId 解析，两条路径必须同构）──
  listSessions(dbPath: string): SessionListItem[];
  readSession(dbPath: string, sessionId: string): RawInteraction[];
  // ── 能力（可选，注册表驱动，消灭 data-service 框架分支）──
  readSubagents?(dbPath: string, sessionId: string): RawInteraction[];   // 已打标（subagent_session_id/name/type）
  collectSubagentToolUseMap?(dbPath: string, sessionId: string): Map<string, string>;  // claude 技能归因专用
  extractVersion?(dbPath: string, sessionId?: string): string | null;  // sessionId 用于目录路径解析（UI 列表导入传 sessions 根）
  sniffFile?(fileName: string): boolean;   // browse-directory 文件识别（注册表声明序 = 优先级）
}
```

### 2.2 注册表（`adapters/registry.ts`）

- `SOURCES: SourceDescriptor[]` —— 声明序即嗅探优先级
  （cannbot-insight > opencode-db > codex-jsonl > claude-jsonl，claude-jsonl 兜底）
- `getSource(sourceType)` / `requireSource(sourceType)`（未知源报错带支持清单）
- `isKnownSource(sourceType)` —— API 白名单判定单点
- `frameworkOfSource(sourceType)` / `sourceOfFramework(framework)` —— 身份双向映射单点
- `sniffImportableFile(fileName)` —— 遍历 descriptor.sniffFile 得 importableType
- `adapters/index.ts` 保留为薄门面（re-export），既有 import 路径不破

### 2.3 UI 元数据（`adapters/import-ui.ts`）

纯数据模块（无 node 依赖，客户端组件可安全 import）：源显示名、快捷路径、
placeholder 提示。`LocalFileImport.tsx` 的硬编码 QUICK_DIRS / source 选项由它驱动。

### 2.4 data-service 收敛

| 原分支 | 收敛后 |
|---|---|
| frameworkForCapture 内联三元 | `proxy 装饰 ?? exportDeclared ?? descriptor.framework`（三源行为逐字节等价） |
| incomingRecordingClass 内联三元 | 与 frameworkForCapture 统一（两者语义本就相同） |
| 子代理并入（claude 硬编码分支） | `descriptor.readSubagents?.(dbPath, sessionId)` 一行；claude 特有的 toolUseIdMapping 走可选钩子 |
| deltaRefresh 反向映射三元链 | proxy 判定保留（捕获类恒 claude 格式）+ `sourceOfFramework()` |
| normalize 分发 | 两实现同构 → 合并为单一兜底映射（签名保留 sourceType 做已知源校验） |

唯一保留的特判：`opencode-db` 的 sharedDb 连接复用（连接池优化，与框架注册
正交；jsonl 系源全部走通用路径）。**新框架接入 data-service 零改动**。

### 2.5 框架级归一化原则（跨框架统一语义，写进契约注释）

1. **注入归一**：各框架「wire 上是 user/developer、实际是框架注入」的内容
   （claude 的 system-reminder/task-notification、codex 的 environment_context /
   developer / AGENTS.md 回显 / subagent_notification）分两类处置：**静态注入**
   （环境快照/指令回显/内部上下文，如 codex 的 environment_context、developer
   skills、AGENTS.md、`<codex_internal_context>`）直接丢弃不进时间线——claude
   剥离 system-reminder 同款语义；**事件注入**（子代理通知/轮中止）归一
   `role:'system'` + 可读摘要（✅ 前缀明示事件性质）。指纹规则框架自持，
   产出语义全局一致，serving 层不关心来源
2. **子代理归一**：发现机制框架自持，产出统一打标的 interactions；并入循环
   data-service 只有一份
3. **身份归一**：`descriptor.framework` 是原生落库值；`-proxy` 后缀装饰（捕获
   记录类）由 data-service 统一施加——注册表管身份，data-service 管记录类，正交
4. **原始保真**：未知载荷安全跳过（版本前向兼容）；wire 原文永远在盘上，
   适配器只做解释不做删改

### 2.5b 注入分类层（`adapters/injections/`）：proxy 捕获的框架分发

原则 1 说「指纹规则框架自持」，但 proxy 让这句话多了一个接线问题：cpx 把
所有框架的捕获归一成 **claude 布局**，claude-jsonl 适配器因此成为通用格式
入口——codex/opencode/cannbot 的捕获行也从这里进来。注入指纹是框架语义，
入口若按框架逐个 if 分支，就退化成「框架知识散落通用入口」（codex 的
`<environment_context>` 会被 claude 的 skill 指纹误伤，反之亦然）。

解法：注入指纹独立成层，入口只做分发。

```
adapters/injections/
├── claude-code.ts   claude-code 指纹：task-notification / ≥2.1 协议注入
│                    （handback 回放/背景事件/label/状态查询）/ skill 注入
├── codex.ts         codex 指纹：六类注入（静态 drop / 事件 system+摘要）
├── opencode.ts      opencode 家族（opencode/cannbot）指纹：skill 注入
└── index.ts         分发：行级 source 标记 → agentFrameworkOf → 框架分类器
```

- **两条消费路径同一分类器**：codex-jsonl（原生 rollout）与 claude-jsonl
  （codex-proxy 捕获）都调 `classifyCodexUserInjection`——时间线形状一致靠
  构造，不靠两处实现的约定
- **默认族**：native 无标记 / legacy `claude-proxy` / `insight-export` →
  claude-code 分类器（保守兜底，与历史行为一致；未列举的 `*-proxy` 同）
- **纯函数层**：无 fs/node 依赖，适配器（重 IO）与指纹（纯文本判定）分层
- **新框架**：`injections/<framework>.ts` + `index.ts` 分发表一行
- **隔离即正确性**：异框架指纹不越界是真机缺陷的修复方向（replayA 的 #0
  env_ctx 缺陷即 claude 入口缺 codex 分发）；IT 锁隔离矩阵
  （`tests/ut/user-injection-dispatch.test.ts`）

### 2.5c 系统提示结构层（`adapters/system-structure/`）：读侧的框架分发

原则 1 的读侧对偶（§2.5b 是 user 行注入分类的接线，本层是系统提示结构
解析的接线）。系统提示的结构段（memory / skills）与结构化解析同样是框架
语义：codex 是 `<skills_instructions>` 闭合块（根表 + 条目），opencode 是
`<available_skills>` xml + `Instructions from:` 记忆块，claude 是
`# claudeMd` 段 + `The following skills are available` 列表。旧实现两处
失明：

- `readFullContext` 的 `scanMessageContext` 只扫 message content 且只认
  claude 标记——proxy 捕获的系统提示在扩展 `system` 字段（wire verbatim），
  memoryFiles/skills 恒空（真机 replayA/capA 实测 fc.skills=0）
- `readAvailableSkills`（Skill 覆盖度全集）按格式试探序嗅探（先 xml 后
  claude-list）——codex 格式谁都不匹配 → 覆盖度面板降级；且嗅探序本身是
  「框架知识散落通用读侧」的反模式（每接一个新框架多一次试探分支）

解法与 injections/ 同构：结构提取器独立成层，读侧只做分发。

```
adapters/system-structure/
├── claude-code.ts   claude 结构：# claudeMd 段 / skills 列表段 / 列表解析
│                    （findMemorySection、findSkillsSection 迁自 claude-jsonl.ts，
│                     parseClaudeAvailableSkills 迁自 skill-coverage.ts）
├── codex.ts         codex 结构：<skills_instructions> 闭合块（### Skill roots
│                    根表展开 rN 相对路径）+ 列表解析；memory 恒空（AGENTS.md
│                    走 user 消息 D1 注入，系统提示无记忆段——语义结论）
├── opencode.ts      opencode 家族（opencode/cannbot）：<available_skills> xml
│                    + Instructions from: 记忆段（段语义对齐 cpx 的
│                    opencode-context-parser，受控双实现的读侧对应物）
└── index.ts         分发：行级 source 标记 → agentFrameworkOf → 框架提取器
```

- **两类消费同一提取器**：原文段（`findSkillsSection`/`findMemorySection`
  → `FullContext.skills`/`memoryFiles`，verbatim 呈现）与结构化
  （`parseAvailableSkills` → `AvailableSkill[]`，Skill 覆盖度全集）
- **默认族**：native 无标记 / legacy 未知 `*-proxy` → claude-code 提取器
  （保守兜底，与 injections/ 同口径）
- **候选源顺序**：ext system 字段优先（proxy 捕获），message 行兜底
  （native claude 系统文本在 message 行）——先 ext 后 message，首个非空段胜出
- **skill-coverage.ts 瘦身**：只保留覆盖度域逻辑（aggregate/buildCoverage）
  与 `AvailableSkill` 域词汇，框架格式知识全部归位框架模块
- **新框架**：`system-structure/<framework>.ts` + `index.ts` 分发表一行
- **隔离即正确性**：codex 会话 user 消息里粘贴的 claude skills 文本不被
  误配（IT 锁隔离矩阵，`tests/ut/system-structure-dispatch.test.ts`）

### 2.6 新框架接入清单（重构后）

```
1. adapters/<framework>.ts   解析内核 + 可选能力实现（readSubagents/sniffFile/
                             detectContent/deriveSessionId/…，探测指纹框架自持）
2. adapters/injections/<framework>.ts   注入指纹（有 user 行注入的框架）
3. injections/index.ts       分发表加一行
4. adapters/system-structure/<framework>.ts   系统提示结构（有结构段/结构化全集需求的框架）
5. system-structure/index.ts 分发表加一行
6. registry.ts               加一行注册（jsonl 系自动入族，"(auto)" 入口/嗅探/纠偏自动覆盖）
7. import-ui.ts              加一条 quickDir（可选；无需新增 UI 按键）
—— API 路由、data-service、normalize、refresh 全部零改动
```

### 2.7 源族与解析单点（umbrella source）

「源」分两层：**族**（文件形态：jsonl / sqlite）是 UI 入口与探测的粒度，
**成员**（具体源：claude-jsonl / codex-jsonl / dsh-native / …）是解析的粒度
（dsh-native 是源族落地后首个按「适配器 + 注册一行」接入的新框架，
未新增 UI 按键）。

- **族声明**（`SOURCE_FAMILIES`）：族名即伞形 sourceType（`jsonl` / `sqlite`），
  API 一等值；声明序 = 探测优先级（特异源在前、扩展名兜底源在后，与
  sniffFile 序同一条原则）
- **探测能力框架自持**：`detectContent`（内容级，读首 N 有效行判信封）/
  `deriveSessionId`（命名规则）——与 sniffFile（文件名级）、injections/
  （行级）同一哲学的高一层
- **解析单点**（`resolveSource`）：① 伞形 → 族内按序探测，无人认领抛
  `SourceResolutionError`（路由转 400 可行动报错）② 具体源自身认领 → 零
  干预 ③ 不认领但族内兄弟认领 → 纠偏（detectSqliteSource 先例的泛化）
  ④ 全都认不出 → 信任声明值（与散装时代行为一致）
- **目录扫描族分发**：伞形 + 目录 = 族成员各列各的（条目带成员 sourceType
  标记，批量导入按条目发，混合目录天然正确）；sessionId 推导服务端单点
  （响应回传 `taskId`），UI 不再复制命名规则
- **两级判定分层**：文件格式解析（本层，选适配器）≠ 框架分类
  （injections/proxy-classify，定 Session.framework）——claude 布局里的
  codex-proxy 捕获走 claude-jsonl 适配器、framework 照旧判 codex-proxy


## 三、codex-jsonl 适配器设计（新框架首个客户）

### 3.1 数据源形态（实测 codex 0.161，`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`）

| 行类型 | 频率 | 内容 |
|---|---|---|
| `session_meta` | 1/文件（首行） | id / **parent_thread_id**（子代理才有）/ cwd / cli_version / **thread_source**（user/subagent）/ **agent_nickname** / model_provider |
| `turn_context` | 每用户轮 1 条 | **model** / turn_id / approval_policy / sandbox |
| `response_item` | 核心 | OpenAI Responses API 项：`message`（user/developer/assistant，input_text/output_text，assistant 可带 phase）/ `reasoning`（思考文本）/ `function_call`（name/arguments JSON 串/call_id）/ `function_call_output`（call_id/output）/ `web_search_call` |
| `event_msg` | 多 | UI 线程事件（task_started/task_complete/token_count/item_completed），与 response_item 内容重复——**不作为内容主体** |
| `token_usage_record` | 每 API 响应 1 条 | input / cached_input / cache_write / output / reasoning_output / total |
| `world_state` | 1+ | 上下文快照（agents_md 等），忽略 |

**行交错规律**（状态机依据，实测确认）：

```
message(assistant) → function_call* → token_usage_record → function_call_output*
        ↑ 新一组响应                                    ↑ 输出在 usage 之后到达
```

工具集随版本变化（本机实测 exec_command / spawn_agent / wait_agent / write_stdin /
web_search），适配器**工具名无关**。

### 3.2 readSession 状态机 → RawInteraction[]

| rollout 元素 | 映射 |
|---|---|
| 响应组（assistant message + reasoning + function_call/web_search_call，由 token_usage_record 冲刷） | 一条 assistant turn：message 文本 → content；reasoning → `<thinking>` 前缀；function_call → tool_calls（call_id/名/argsJson=arguments）；usage 挂接（input→input、cached_input→cacheRead、cache_write→cacheWrite、output→output、reasoning_output→reasoning，cost 恒 0）；model 取当前轮 turn_context.model；latency = 组首行→usage 行时间差 |
| `function_call_output` | 经全局 `call_id → 已 flush 工具调用` 映射回填 resultJson（输出晚于组冲刷到达，天然解耦） |
| role=user 且非注入 | user turn |
| `<environment_context>` / `# AGENTS.md instructions` / `<user_instructions>` / `<codex_internal_context` / developer 消息 | **丢弃**（D1 修订：静态注入不进时间线，wire 原文在盘上） |
| `<subagent_notification>` / `<turn_aborted>` | **system turn**（事件注入）；subagent_notification 解析 JSON 摘要化（`✅ 子代理完成: agent [status]` + 200 字预览，claude task-notification 同款） |
| `spawn_agent` / `wait_agent` / `write_stdin` | 普通 tool_calls（wait_agent 输出携带子代理完成摘要，如实呈现） |
| turn_context / task_started / task_complete | 轮边界（更新当前模型）/ 冲刷信号，不产 turn |
| event_msg / world_state | 忽略 |
| 未知 payload | 安全跳过 |

空组（无文本无工具无思考）跳过；带 usage/思考信号的空组保留（截断可观测，同
claude 适配器先例）。

### 3.3 子代理发现（`readSubagents` 能力）

真机样本：主会话 `01a11e79`（TUI）spawn 两个子代理（Euclid / Kepler）。

```
主 rollout：spawn_agent 输出 = {"agent_id":"<子id>","nickname":"Euclid"}
子 rollout：文件名 rollout-*<子id>.jsonl；session_meta 自带
            parent_thread_id / thread_source:"subagent" / agent_nickname
```

发现算法（**只依赖 rollout 文件本身，不读 state_5.sqlite**）：

1. 解析主文件全部 `spawn_agent` function_call_output → 子 id + nickname 列表
2. 定位子文件：先同目录（覆盖绝大多数），未中则向上找 sessions 根
   （目录名 `sessions`，至多上溯 3 层）后递归搜 `rollout-*<id>.jsonl`
3. 交叉验证：子文件 session_meta.parent_thread_id === 主 sessionId（防同 uuid 误配）
4. readSession(子文件) → 打标 `subagent_session_id = 子id`、`subagent_name =
   agent_nickname`；子文件丢失则跳过不阻塞（spawn/wait 工具结果仍在主时间线）
5. 嵌套 spawn（孙代理）同一机制递归（深度上限 5，防环）。真机 0.161 实测：
   codex 子代理的工具集只有 `exec_command`/`write_stdin`，**没有 `spawn_agent`**
   （子代理试图用 shell 跑 `codex exec` 绕过也被只读沙箱挡住），嵌套在当前
   codex 架构上不会发生——递归属防御性实现，为 codex 未来放开或其它框架兜底

listSessions 跳过 `thread_source === 'subagent'` 的文件（不作为顶层会话列出，
与 claude 跳过 subagents 目录同语义）；单独导入子文件仍可作为独立会话。

### 3.4 listSessions

递归扫 `rollout-*.jsonl`（要求首行 session_meta 带 id，防误吞非 codex 文件）；
sessionId = 文件名 uuid；createdAt = session_meta.timestamp（兜底文件名时间戳）；
endedAt = 末行 timestamp；firstQuery = 首条真实 user 提示（跳过注入）；
modelName = 最频 turn_context.model；turnCount = task_started 数；
totalTokens = Σ usage（wire 口径，与 claude 侧一致）；version = cli_version。
大文件安全：Buffer 逐行扫描（V8 单字符串上限防线，claude 侧 631MB 先例）。

### 3.5 落库身份

- framework = `codex`（无 -proxy）；与同 sid 的 `codex-proxy` 捕获行按
  (taskId, framework) 唯一索引双行共存（方案一既有语义）
- `isClaudeFormatSession('codex', …)` = false → wire-rounds/full-context 等
  捕获件专属扩展层正确不启用
- providerID 恒 null；成本恒 0（第三方 provider 定价不可知，估算反而误导）
- 增量刷新：framework 'codex' → sourceOfFramework → 'codex-jsonl'，活文件
  追加后可增量导入

## 四、决策记录

| # | 决策 | 理由 |
|---|------|------|
| D1 | codex 框架注入分两类：静态（environment_context / developer / AGENTS.md 回显 / user_instructions / codex_internal_context）**丢弃**；事件（subagent_notification / turn_aborted）→ system turn | 初版全量 system turn，用户实测后修订：静态注入在时间线是噪音（首条 user 前堆满 skills/env 轮），claude 剥离 system-reminder 同款语义；事件注入是可观测的会话事件保留 |
| D2 | reasoning 双通道：文本 → content `<thinking>` 前缀；token → usage.reasoning | RawInteraction 现有字段足够，冻结红线不破 |
| D3 | 多 agent 支持：rollout 自带父子关联（spawn 输出 + parent_thread_id），不读 state_5.sqlite | 单一数据源依赖；state 库是 codex 内部实现细节，rollout 是公开产物 |
| D4 | 手动导入（UI source 选项 + 快捷路径 `~/.codex/sessions`） | 与 Claude 原生同级；自动发现做后续 |
| D5 | providerID 恒 null | codex 的 model_provider 是配置名非 wire 值；展示有 model 名足够 |
| D6 | 成本恒 0，不做估算 | 第三方 provider（volcano/deepseek/doubao/qwen…）定价不可知 |
| D7 | 嗅探优先级：cannbot > sqlite > codex(rollout- 前缀) > claude-jsonl(扩展名兜底) | rollout-*.jsonl 不误判；claude 通用 jsonl 仍可兜底导入 |
| D8 | normalize 合并同构实现，签名保留 | 两实现逐字段相同；保留 sourceType 校验向后兼容 |
| D9 | opencode-db 的 sharedDb 特判保留 | 连接池优化与框架注册正交；jsonl 系源全走通用路径 |
| D10 | event_msg 不作为内容主体 | 与 response_item 重复，双读会双计 token/轮次 |

## 五、执行计划（单 PR，三阶段提交）

| 阶段 | 提交 | 内容 | 验收 |
|------|------|------|------|
| 1 | `[refactor]` | contract + registry + import-ui + 三源平移 + 6 处散点收编 + normalize 合并 | 全量回归绿，行为零变化（既有 IT 锁） |
| 2 | `[feat]` | codex-jsonl 适配器 + 注册 + 子代理并入（走通用路径）+ UI 接入 | 真实样本（01a11e79 主 + Euclid/Kepler）全链路 IT 绿 |
| 3 | `[test]+[docs]` | 注册表 IT + codex 链路 IT（脱敏样例 tests/data/）+ 本文档 + README 双语 | 门禁全绿 |

## 六、测试计划（IT 纪律：数据驱动 + 全链路）

- `tests/data/codex/` 脱敏样例：主会话（注入 + thinking + 工具轮 + spawn/wait/
  write_stdin + usage + subagent_notification）+ 两个子 rollout（复刻 Euclid/Kepler 结构）
- 全链路 IT：rollout → adapter → normalize → turn-split → DB
  —— 断言 user/system/assistant 轮角色、tool_calls 结果 join、usage 数值、
  模型名、子代理 turns 归属（isSubagent + subagentName）、主会话保留 spawn 摘要
- listSessions IT：subagent 文件不列出、uuid/firstQuery/version 正确
- 注册表 IT：身份双向映射、嗅探优先级、未知源报错
- 增量刷新 IT：文件追加后 addedTurns 正确
- 负向：未知 payload 跳过、子文件丢失不阻塞、损坏行容错、非 codex jsonl 不误吞

## 七、边界与非目标

- 不读 `state_5.sqlite` / `thread_history_*.sqlite`（codex 内部投影，rollout 是公开数据源）
- 不做成本估算（D6）、不做自动发现/退出自动导入（D4）
- `phase='final_answer'` 不特殊处理（普通 assistant 消息）
- cpx 代理捕获通路（codex-proxy，claude 信封）不受影响——与原生通路正交共存
- proxy 扩展层（full-context / wire-rounds / proxy-classify）一律不动（OCP 红线）
