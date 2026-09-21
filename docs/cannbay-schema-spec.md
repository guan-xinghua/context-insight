# CANNBay 捕获/导出格式标准（x_cannbay v1）

适用范围：cpx 捕获文件、insight DB 导出件、CANNBay 仓内 `sessions/<sid>/` 布局的全部 jsonl/meta 数据。

## 0. 什么场景要看本文档

判定标准：数据离开当前进程、可能被另一个版本的代码或另一台机器读取的时刻。

| 场景 | 时刻 | 义务 |
|---|---|---|
| **生产** | cpx 捕获落盘（每 wire 轮）；cpx normalize；CANNBay 上传（直拷 / DB 导出）；任何写 `sessions/<sid>/` 布局的新工具 | 写方义务：信封不碰、扩展进口袋、带声明 |
| **消费** | cpx 退出自动导入 / 手动导入 / CANNBay 导入；turns API 读 Full Context 与 wire enrichment；任何解析这些文件的新代码 | 读方义务：按 `(schema, version)` 分发，不认识整块跳过，禁止字段嗅探 |
| **演进** | 加扩展字段、改字段语义、加新 payload schema | 见 §1 修改规则 |

不需要遵循的边界：无 `x_cannbay` 的老文件（legacy fallback，永久容忍）；纯 native claude jsonl；v1 CANNBay 的 `.db`；进程内数据结构（Prisma DB、RawInteraction 等）。

## 1. 修改规则（什么情况可以改、怎么改）

| 想做的事 | 允许？ | 怎么做 |
|---|---|---|
| data 里**加可选字段** | ✅ | 不升 version；读方必须容忍未知可选字段；同步更新本文档字段表与形状校验测试 |
| **改语义 / 改类型 / 删字段** | ✅ 但必升 version | `version` +1；读方注册表同时支持新旧版本；老 version 永久可读（不回收） |
| **加新 payload schema** | ✅ | 补齐本文档字段表、类型定义、形状校验、混排测试四项后合入 |
| **改信封层字段的含义**（`type` / `timestamp` / `message{role,content,id,model,usage}`） | ❌ 永久禁止 | 信封是 claude 原生语义，冻结是本标准的存在前提 |
| **复用信封字段装别的数据**（如 `duration_ms` 装 wire latency） | ❌（存量例外见 §6 双轨说明） | 一律进 `x_cannbay.data` |
| **改物理布局**（`sessions/<sid>/` 文件树） | ⚠️ 谨慎 | 布局是 adapter 发现约定（子代理目录、meta 命名），改动需同步 adapter 发现逻辑 |

加字段不升版本、改语义不升版本均视为破坏契约。每次 payload 改动须同步更新形状校验测试。

## 2. 物理布局

```
<paradigm>/<sid>/            # 范式目录（顶层目录即范式注册表，默认仓上传必选）
  <sid>.jsonl.7z           # 主会话行流（信封 + x_cannbay；7z at rest，存量 .jsonl.gz 与旧件明文 .jsonl 永续可读）
  <sid>.meta.json          # 主会话元数据（cc-session-meta，永远明文）
  subagents/
    <subId>.jsonl.7z       # 子代理行流（同上行格式；存量 .gz 同理永续可读）
    <subId>.meta.json      # 子代理关联元数据（cc-subagent-meta，明文）
<paradigm>/baseline/<sid>/   # 范式基准会话（workflow 评分基准；位置即身份：
  …                          # baseline/ 下唯一 <sid>/ 即该范式当前基准，无标记文件）
sessions/<sid>/             # 存量区（范式目录上线前的布局，只读保留，导入照常）
```

范式目录 = 数据仓顶层目录（`elementwise` / `contraction` / `others` …，25 个
算子计算范式 category + `others`，见 `CANNBot_算子计算范式_v2.0.md`）。
**目录即注册表**：新增范式只需在数据仓新建顶层目录，insight 零范式知识；
主范式由目录承载（单一归属），meta 不重复声明。同 sid 全仓唯一，换范式
重传 = 同 commit 删旧目录写新目录。`baseline/` 为范式级保留目录名：设为
基准的会话住进 `<paradigm>/baseline/<sid>/`，更换基准 = 一次 commit 原子
交换（新会话进 baseline、原基准移回范式普通目录）——结构即状态，无声明
文件。自定义数据湖远端不启用范式目录（维持 `directory` 单根机制）。

压缩（7z at rest，见 `proxy/COMPRESSION-DESIGN.md`；存量 gz 同理）是**传输编码**：解压后
行流与明文形态逐字节一致，信封与 `x_cannbay` 契约不变；治理（密钥清洗/复检）
只对明文域做，治理通过后才压缩出仓。

cpx 本地目录（`~/.cannbot-insight/proxy/`）与 norm/ 镜像同一约定（顶层捕获文件带 `cpx-` 前缀，meta 与主文件同 stem 并列）。
insight 评分过程日志（`~/.cannbot-insight/score-judge-logs/`）为本地明文 jsonl，走同一信封规范（`cc-judge-round`），仅本机留存，不属于 cannbay 仓布局。

## 3. 行格式与信封规则

```jsonl
{"type":"user","timestamp":"...","message":{"role":"user","content":[...]}}
{"type":"assistant","timestamp":"...","message":{"role":"assistant","id":"...","content":[...],"model":"...","usage":{...}},
 "x_cannbay":{"schema":"cc-wire-round","version":1,"data":{...}}}
```

字段类型记法：`int?` / `string?` = **可选字段**——没有该数据时 JSON 里该键不出现（缺失 ≠ 0，读方遇缺失跳过、不按 0 处理）；无 `?` = 必填。

四条规则：

1. **信封冻结**：`type` / `timestamp` / `message{role,content,id,model,usage}` 是 claude 原生语义，永不重解释。`message.usage` 为 anthropic 原生 usage 对象（`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`），属信封层
2. **单一归属**：每个信息单元只有一个家。扩展一律进 `x_cannbay: {schema, version, data}`，信封不复用
3. **声明式分发**：读方按 `(schema, version)` 路由；不认识的声明整块跳过（行本体照常按信封处理）；禁止依据 data 内容或字段存在性判定身份
4. **双向兼容**：无 `x_cannbay` 的行 = native（现有路径逐字节不变）；新行被老代码读 = 忽略未知顶层字段

## 4. Payload Schema 定义

### 4.1 `cc-wire-round` v1（assistant 行，生产者 = cpx）

| 字段 | 类型 | 含义 | 导入归宿 |
|---|---|---|---|
| `roundIndex` | int | 该上下文的 wire 轮次号，从 0 连续 | wire 轮次对齐权威键 |
| `protocol` | `'anthropic'\|'openai'` | 线路协议 | session framework / 徽标 |
| `system` | verbatim | 该轮请求 `body.system` 原文 | Full Context（API 层扩展读） |
| `tools` | verbatim[] | 该轮请求 `body.tools` 原文 | Full Context |
| `requestParams` | `{temperature?, maxTokens?, model?}` | 请求侧参数（model 可与响应侧不同） | Turn.temperature/maxTokens（post-patch） |
| `latencyMs` | int | wire 往返耗时 | Turn.latencyMs |
| `ttftMs` | int? | 首 token 耗时（流式） | Turn.ttftMs（post-patch） |
| `stopReason` | string? | 响应 stop_reason | Turn.finishReason |
| `status` | int | wire 响应状态码 | 错误响应可观测 |
| `ccVersion` | string? | 计费头提取的 claude-code 版本 | Session.version |

### 4.2 `cc-wire-input` v1（user/system 行，生产者 = cpx）

| 字段 | 类型 | 含义 |
|---|---|---|
| `roundIndex` | int | 该增量消息所属 wire 轮 |
| `kind` | `'user'\|'tool-result'\|'injection'\|'system'\|'command-message'\|'dedup-placeholder'` | 结构化分类 |
| `dedup` | `{originalChars:int, fingerprint:string}` | 仅 `dedup-placeholder`：原文长度 + md5 指纹（占位文本保留在 content，UI 兼容） |

### 4.3 `cc-db-turn` v1（assistant 行，生产者 = insight-export）

| 字段 | 类型 | 含义 | 导入归宿 |
|---|---|---|---|
| `latencyMs` | int | DB 记录的轮耗时 | Turn.latencyMs |
| `ttftMs` | int? | DB 记录的 TTFT | Turn.ttftMs（post-patch） |
| `stopReason` | string? | finishReason | Turn.finishReason |
| `reasoningTokens` | int? | 推理 token（anthropic usage 无此字段） | Turn.reasoningTokens（`TokenUsage.reasoning` 既有通道） |
| `modelId` / `providerId` | string? | 模型/供应商标识 | Turn 同名列（post-patch） |
| `temperature` / `maxTokens` | number? | 请求参数 | Turn 同名列（post-patch） |
| `toolCalls` | `[{toolUseId, state?, errorType?, errorMessage?, durationMs?, startedAt?}]` | 工具调用明细 | ToolCall 明细列（post-patch） |
| `turnKind` | `'normal'\|'system'` | system 轮还原标记 | system turn 分类 |

### 4.4 `cc-session-meta` v1（`<sid>.meta.json`，主会话）

```json
{ "x_cannbay": { "schema": "cc-session-meta", "version": 1,
  "data": { "producer": "cpx|insight-export|insight-upload", "framework": "...", "protocol": "anthropic|openai", "ccVersion": "...", "sid": "..." } } }
```

文件级声明：生产者、原会话 framework、协议、版本。导入时恢复 Session.framework/version。

`framework` 开放字符串，现值：`claude-code` / `opencode` / `codex` / `cannbot`
（opencode 系 CANN fork，openai 协议，UA `cannbot/<ver>` 驱动，见
`proxy/CANNBOT-DESIGN.md`；`ccVersion` 取 UA 版本）。加新值不升 schema 版本
（读方未认识的值走非权威路径回退）。

`producer` 取值：
- `cpx`：cpx 代理捕获落盘，framework/ccVersion 权威（分类器/导入消费）
- `insight-export`：insight DB 导出件，framework/ccVersion 权威（重导入 patch 消费）
- `insight-upload`：上传时从 insight DB 合成（源文件无伴生 meta 的直传场景），
  **仅作展示（cannbay2 列表 type 列），分类器与重导入 patch 均不消费**——对
  导入行为零影响（加枚举值不升 schema 版本：读方对未知 producer 一律走非权威路径）

`governed`（可选 bool，仅 producer=cpx 携带）：cpx 会话关闭压缩时打的信任
标记，语义 = "字节流已经 cpx 落盘咽喉 redactor 全量清洗"（与 insight 治理
正则 parity 锁定同源）。cannbay2 上传据此走**直传快路径**（免解压重洗重压，
保留白名单与大小限检）；无标记 / 明文源 / 其他 producer 一律走治理兜底路径。
加可选字段不升 schema 版本

`opGen`（可选 `'success' | 'failure'`，上传时人工勾选写入）：算子生成任务
结果标注——本会话的算子是否生成成功。缺省/未勾选 = 未标注（读方只认
success/failure，其余值按未标注处理）。insight 上传链在 staging 的
`<sid>.meta.json` 补丁写入（cpx 伴生 / insight-upload 合成 / insight-export
导出三条路径全覆盖），cannbay2 列表「算子生成」列消费。加可选字段不升
schema 版本

`startTime` / `endTime` / `durationMs` / `totalTokens` / `model`（可选，上传
时刻从 insight DB 会话行快照，与 annotateSessionMeta 同一补丁点三条路径全
覆盖）：会话指标快照——开始/结束时间（ISO 8601 字符串）、耗时（`endTime −
startTime` 毫秒数）、token 总量、会话主模型（首条 assistant 轮的 model，
即 Session.model）。消费方为 cannbay viewer 列表/实验记录面板
与算子生成耗时优化图：**未导入 insight 的行也能直接展示**这些指标，无需先
下载会话本体。会话已导入时展示以 DB 为权威（两者同源同值）；存量旧 meta
无这些字段，读方按缺省处理（时间退化为 commit 时间近似）。加可选字段不升
schema 版本

### 4.5 `cc-subagent-meta` v1（`subagents/<subId>.meta.json`）

```json
{ "toolUseId": "...", "name": "...", "agentType": "...",
  "x_cannbay": { "schema": "cc-subagent-meta", "version": 1,
  "data": { "toolUseId": "...", "name": "...", "agentType": "...", "subagentSessionId": "<subId>" } } }
```

顶层旧字段与 `x_cannbay.data` 同值双写（老代码读顶层，新代码读 data）。

### 4.6 `cc-judge-round` v1（assistant 行，生产者 = insight-scoring）

评分 LLM 评审的过程日志：insight 评分器每次评审运行落在 `~/.cannbot-insight/score-judge-logs/<被评sessionId>/<时间戳>-<runId>/`（明文，本地用户目录，不入 cannbay 仓布局），用于超时/空正文等偶发问题的事后复现。**并发评审按捕获的 subagent 形态存放**（交错写单流会把 request/response 配对打乱）：

```
<ts>-<runId>/
  <ts>-<runId>.jsonl              # 主流：run 头、逐子项 派发(Agent tool_use)/结果(tool_result)、footer
  <ts>-<runId>/
    subagents/
      <itemId>.jsonl              # 每个评审子项一个子代理流：全部 attempt 顺序配对
      <itemId>.meta.json          # cc-subagent-meta（agentType='scoring-judge'，subagentSessionId=<itemId>）
```

行结构：

- **请求行**（子代理流）= native user 行（无 `x_cannbay`），content = `system 原文 + <<<judge-system|judge-user>>> 分隔标记 + user 原文`（按标记拆回可原样重放）
- **响应行**（子代理流）= assistant 行 + 本 payload；失败 attempt 的信封 content 为 `[judge-error] <诊断>`，token 用量走信封 `message.usage`（单一归属，不重复进 data）
- 主流的头/尾摘要行是 native user 行，content 为**人话摘要**（Turns 里直接可读），机器载荷在 `x_cannbay`（`cc-judge-run` v1，见 §4.7）；**派发行 = assistant 的 `Agent` tool_use**（`tool_use_id = j-<runId>-<itemId>`，`input.subagent_session_id = <itemId>`——bridge-builder 据此建 InteractionBridge，导入后页面才能按 subagent 组织；惰性：子项首次真实调用才写，弃权子项不派发不建流），**结果行 = 配对的 tool_result**（content 为 JSON `kind: judge-item-result`，与评分卡同源，日志侧即可对上"这次调用得了什么结论"；弃权子项无派发，结果走普通 user 行留痕）

| 字段 | 类型 | 含义 |
|---|---|---|
| `runId` | string | 一次评分运行 id（8 位 hex，与文件名一致） |
| `sessionId` | string | 被评会话 id |
| `dimensionId` / `itemId` / `itemName` | string | 评分维度 / 子项标识与名称 |
| `attempt` | int | 1 或 2（传输层异常只重试一次：超时 / 空正文） |
| `maxTokens` | int | 该 attempt 的请求配额（4096 / 8192） |
| `latencyMs` | int | 该 attempt 往返耗时 |
| `promptChars` | int | 请求字符量（system + user） |
| `contentChars` | int? | 响应正文字符量 |
| `status` | int? | HTTP 状态码（超时无响应则缺省——缺失 ≠ 0） |
| `stopReason` | string? | 响应 finish_reason |
| `error` | string? | 失败诊断 |
| `retryReason` | `'timeout'\|'empty-content'` | 仅触发重试的失败 attempt 携带 |

读方未认识本 schema 时按声明式分发整块跳过、行按信封导入。导入主流即按 subagent 布局自动挂上全部子代理轮次（`subagentSessionId` = 子项 id，如 `D1.6`），结果与调用过程一一对应，可直接在 insight 里观测分析。

### 4.7 `cc-judge-run` v1（user 行，生产者 = insight-scoring）

评分运行的头/尾摘要行（主流 jsonl 的第一行与最后一行）。content 为人话（如「评分运行 75da2c61 结束 · 耗时 324.6s · 评审调用 12 次 · token 289,909 · 子项 出分 30 / 无法评判 5」），机器可读字段在 `data`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `kind` | `'judge-run-header' \| 'judge-run-footer'` | 头 / 尾 |
| `phase` | `'header' \| 'footer'` | 同上的冗余声明（与 kind 二选一消费） |
| `runId` | string | 一次评分运行 id（8 位 hex，与目录名一致） |
| `sessionId` | string | 被评会话 id（仅头） |
| `model` / `concurrency` / `scorerVersion` / `withSemantic` | - | 运行参数（仅头） |
| `startedAt` / `finishedAt` | ISO 时间 | 起 / 止 |
| `durationMs` / `judgeCalls` / `judgeTokens` | int? | 尾：总耗时 / LLM 调用次数 / token 用量 |
| `items` | `Record<string, int>`? | 尾：子项状态计数（ok / not-applicable / error） |

## 5. 信息承载映射

每个信息单元恰好属于一类：

| 信息单元 | 落点 |
|---|---|
| 逐轮消息增量（user / tool_result / 注入原文）、响应 blocks、model、usage 四段 | 信封 verbatim |
| reasoning / latency / ttft / stopReason / system / tools / protocol / ccVersion / roundIndex / dedup / toolCall 明细 / 请求参数 / wire status | `x_cannbay` 直载（§4 各表） |
| subagent 关联（toolUseId / name / type） | `cc-subagent-meta` |
| session framework / version / producer | `cc-session-meta` |
| 评分 judge 调用上下文/重试链（attempt、latency、maxTokens、错误） | `cc-judge-round` |
| 评分运行头/尾摘要（运行参数、耗时、调用/token 汇总） | `cc-judge-run` |
| Turn.inputMessagesJson / contextWindowPct、Execution 聚合、SkillEvent、InteractionBridge、Session totals / label / query | **重推导**——导入管线从行内容重建，语义等价但不保证逐字节相同，schema 不直载 |

## 6. 读方分发规则（含双轨优先级）

```
行/文件解析：
  有 x_cannbay？
    ├─ 是 → 按 (schema, version) 查注册表
    │        ├─ 认识 → 按 payload schema 消费 data
    │        └─ 不认识 → 整块跳过（行本体照常按信封处理）
    └─ 否 → legacy 路径（现有 sniffing，永久保留）
meta.json：有 x_cannbay → 用声明式 data；无 → 读顶层旧字段
优先级：x_cannbay > legacy 字段 > 推断
```

**双轨说明（存量例外）**：过渡期 legacy 顶层字段（`source` / `duration_ms` / `stopReason` / `system` / `tools` / `ttftMs` / `version` / `deduped` / `originalChars`）与 `x_cannbay` 并存写、同值。其中 `duration_ms` 是历史遗留的**信封字段复用**（claude 原生语义为会话时长，本格式用它装 wire latency）——它是本标准唯一的规则 2 例外，收敛期结束后停止写入，读方优先 `x_cannbay.latencyMs`。

**收敛里程碑**：双生产者（claude-emitter + opencode-emitter）已对齐双轨写（P0-1 落地）。**下一个大版本**（v2 schema 上线时）停止写入 legacy 顶层字段（保留 `source` 作来源徽标例外），读方届时可只读 `x_cannbay`。在 v2 之前，双轨同值是硬性约束（由 `tests/cannbay-schema.test.ts` ②双写一致锁 + ⑥opencode-producer 形状锁守卫）。
