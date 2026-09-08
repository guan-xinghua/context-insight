# CANNBot-Insight 开发进展报告

> ⚠️ **已归档**：早期 Step 计划进展报告，停在 2026-06-13，本文不再维护。

更新时间：2026-06-13

---

## Step 1：项目骨架 + 测试框架 ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S1-01 | ✅ | 初始化 Next.js 项目 (App Router + TypeScript + Tailwind v4 + ESLint) | `npm run dev` 可启动 (port 3002) |
| S1-02 | ✅ | 安装依赖：Prisma 6, better-sqlite3 11, shadcn/ui, vitest 3 | `npm install` 无报错 |
| S1-03 | ✅ | Prisma schema 8 models (Session, Turn, ToolCall, SkillEvent, Execution, ExecutionSkill, SessionSkill, InteractionBridge) | `npx prisma migrate dev --name init` 成功，8 tables 创建 |
| S1-04 | ✅ | vitest 配置 | `npm run test` 可运行 (14 tests pass) |
| S1-05 | ✅ | 基础 UI shell + shadcn/ui 初始化 | 页面可访问 |
| S1-06 | ✅ | 测试数据：真实 DB (30MB, 39 sessions, 3011 messages) + 合成 JSON (7 RawInteractions) | 文件存在于 `tests/data/` |

**注意**: Phase2 设计文档 Turn model 有两个 `createdAt` 字段，Prisma 不允许重复，第一个重命名为 `createdAt_ts`。

---

## Step 2：数据源适配器 — opencode-db ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S2-01 | ✅ | 测试 `opencode-db.test.ts` (12 tests) | 覆盖 listSessions + readSession + 边界情况 |
| S2-02 | ✅ | 实现 `opencode-db.ts` | 12 tests 全部通过 |
| S2-03 | ✅ | 手工验证真实 DB | 36 root sessions, 3 subagent sessions 正确识别 |

### 数据格式发现

- 用户消息 content 在 `part` 表 (type="text"), 不在 message.data
- Assistant 内容在 reasoning + text parts
- Tool calls 在 `part` 表 type="tool", 结构: {callID, tool, state:{status}, input, output}
- Subagent 通过 session.parent_id 识别，title 含 @agentName subagent 模式
- 无 system messages 存在于此 DB
- Finish reasons: "tool-calls" 和 "stop"

### 样例输出

**listSessions (top 5)**:
| id | createdAt | firstQuery | turnCount | modelName |
|---|---|---|---|---|
| ses_1e612bfb... | 2026-05-12T02:03:59Z | 阅读下设计文档batch_to_space.md... | 47 | alibaba-cn/glm-5 |
| ses_1e8f35f4... | 2026-05-11T12:39:24Z | 阅读下设计文档batch_to_space.md | 156 | alibaba-cn/glm-5 |
| ses_1f46bcf3... | 2026-05-09T07:12:01Z | 读一下设计文档batch_to_space.md... | 510 | alibaba-cn/glm-5 |

**readSession (sample RawInteraction)**:
- User: role="user", content from part text, agent="build", model="alibaba-cn/glm-5"
- Assistant: role="assistant", content from reasoning+text parts, tool_calls=[{toolName:"glob"}], usage={input:10129, output:16, cost:0.0088}, latency=18927ms
- Subagent: role="user", subagent_name="explore", subagent_session_id populated

---

## Step 3：适配器注册表 + normalize ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S3-01 | ✅ | 写测试 `adapters/index.test.ts` (5 tests) | getAdapter 路由 opencode-db/claude-jsonl/unknown |
| S3-02 | ✅ | 实现 `adapters/index.ts` (Adapter 接口 + getAdapter 注册) | claude-jsonl 返回 null stub |
| S3-03 | ✅ | 写测试 `normalize.test.ts` (14 tests) | 字段映射、默认值、时间戳验证、真实+合成数据 |
| S3-04 | ✅ | 实现 `normalize.ts` (NormalizedInteraction 接口 + normalize 函数) | role/timeInfo/usage 默认值填充 |

### 关键设计决策
- `getAdapter("claude-jsonl")` 返回 null (stub, 不抛异常)
- `getAdapter("unknown")` 抛异常
- `normalize()` 填充默认值: role→"unknown", timeInfo→{created:0}, usage 缺失字段→0
- `NormalizedInteraction` 是独立接口 (与 RawInteraction 同形但语义验证后)

---

## Step 4：turn-split 核心拆解 ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S4-01 | ✅ | 写测试 `turn-split.test.ts` (55 tests: 35 synthetic + 10 real + 7 edge) | tokens/times/skills/inputMessages/contentSummary/contextWindowPct 全覆盖 |
| S4-02 | ✅ | 实现 `turn-split.ts` (327 行) | 55 tests 全部通过 |
| S4-03 | ✅ | 用真实 DB 验证 (47 interactions→47 turns, 27 tool calls) | 真实数据拆解输出可检视 |

### 核心功能
- **Token 五项**: total/input/output/reasoning/cacheRead/cacheWrite 从 usage 提取
- **时间字段**: createdAt_ts (timeInfo.created), completedAt (timeInfo.completed), latencyMs (差值)
- **Skill 识别**: skill/load_skill→"load", skill/invoke→"invoke", skill/*→"use"
- **inputMessagesJson**: assistant turn 收集前面所有 user/assistant/system 的 {role, content}
- **contentSummary**: ≤200 字截断; 等于 content 时不截断
- **contextWindowPct**: inputMessagesTokens / 128000 * 100 (默认 128K)
- **Subagent**: subagent_session_id 标记, role="subagent"→"assistant"

### 样例输出 (真实 DB session)
- Turn 0: user, 0 tokens, contentSummary preserved
- Turn 1: assistant, 10569 tokens (10129 input + 16 output + 27 reasoning + 397 cacheRead), latency=18927ms, contextWindowPct=7.91%
- Turn 2: assistant, 10620 tokens, contextWindowPct=8.09%, inputMessagesCount=2

---

## Step 5：bridge-builder + execution-split ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S5-01 | ✅ | 写测试 `bridge-builder.test.ts` (18 tests) | 单/多 subagent, 未匹配, 状态判定, 时间匹配 |
| S5-02 | ✅ | 实现 `bridge-builder.ts` | task()→InteractionBridgeRow, 匹配 subagent_session_id |
| S5-03 | ✅ | 写测试 `execution-split.test.ts` (29 tests) | root+subagent 聚合, 无 subagent, 边界, 真实 DB |
| S5-04 | ✅ | 实现 `execution-split.ts` | root+subagent ExecutionRow, parentExecutionId, 聚合指标 |
| S5-05 | ✅ | 真实 DB 全链路验证 | 47 turns + bridges + executions 输出可检视 |

### 关键设计决策
- bridge-builder: 匹配逻辑 subagent_session_id → resultJson "task_id:" pattern → 时间就近原则
- 执行拆分: root execution aggregates 非子代理回合; 每个子代理获得独立 ExecutionRow with parentExecutionId=root.id, depth=1
- TurnRow 新增 `cost` 字段 (从 usage.cost) 用于 ExecutionRow.cost 聚合

---

## Step 6：cost-calculator + merge + data-service ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S6-01 | ✅ | 写测试 `cost-calculator.test.ts` (12 tests) + 实现 | glm-5 定价表, 前缀匹配, null 处理 |
| S6-02 | ✅ | 写测试 `merge.test.ts` (15 tests) + 实现 | dedup by turnIndex+role, toolCallId, turnId:skillName:eventType |
| S6-03 | ✅ | 实现 `data-service.ts` (全链路编排) | readSession→normalize→split→bridges→executions→Prisma 写入 |

### 关键设计决策
- MODEL_PRICING: 硬编码 6 模型定价 (glm-5, claude-3.5-sonnet, claude-3-opus, gpt-4o)
- merge: 增量合并按 composite key dedup, 不删除已有行
- data-service: 完整写入 pipeline, Session 聚合指标从 turns SUM 派生
- bridge-builder/execution-split 动态 import 带回退 (兼容性)

---

## Step 7：导入 API + CLI + 全链路集成测试 ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S7-01 | ✅ | 集成测试 `import-opencode.test.ts` (3 tests) | listSessions + importSession + DB 行验证 + dedup |
| S7-02 | ✅ | API routes + Prisma singleton | `/api/ingest/import-file` + `/sessions` |
| S7-03 | ✅ | CLI `scripts/import-opencode.ts` | 交互式 session 选择 + 导入 |
| S7-04 | ✅ | dedup: 第二次导入 imported=false, 无重复行 | 测试通过 |

### 集成测试验证结果
- Session 行创建, taskId = opencode session ID
- Turn 行数 = RawInteraction 数
- ToolCall 行数 = session.totalToolCallCount
- totalTokens = SUM(turn.totalTokens) ✓
- Execution: root execution 存在, rootExecutionId = self.id
- 第二次导入同一 session: imported=false, 0 新行

---

## Step 8：读取 API + Session 列表页 ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S8-01 | ✅ | `/api/observe/data` + `/api/observe/session` + `/api/observe/stats` | 分页、详情聚合、统计 |
| S8-02 | ✅ | `SessionList.tsx` + `MetricCards.tsx` + shadcn card/table | Session 列表页可查看 |

---

## Step 9：Turn 详情 + 上下文治理 UI ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S9-01 | ✅ | `/api/observe/session/turns` + `/api/observe/session/turns/[turnId]` | API 返回 turn + toolCalls + skillEvents |
| S9-02 | ✅ | `TurnTimeline.tsx` + `TurnDetail.tsx` | 时间线+详情面板 |
| S9-03 | ✅ | `LlmContextView.tsx` — 默认折叠+逐条展开 | 上下文治理核心功能 |
| S9-04 | ✅ | `LlmOutputView.tsx` — 默认折叠+thinking/text分区 | 输出区可用 |
| S9-05 | ✅ | `TokenBarChart.tsx` + `ToolCallList.tsx` + `SkillEventList.tsx` | 详情面板完整 |

### Session 详情页结构
- `/session/[taskId]`: 顶部 session 元数据 + 7 指标卡 → 左侧 TurnTimeline → 右侧 TurnDetail → LlmContextView + LlmOutputView + Token/Tool/Skill

---

## Step 10：Timeline + Subagent + 交互链路 ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S10-01 | ✅ | `/api/observe/executions` + `/api/observe/session/bridges` | API 返回 root+subagent executions + bridges |
| S10-02 | ✅ | `TimelineGantt.tsx` | 甘特图时间线 (root全宽 + subagent比例定位) |
| S10-03 | ✅ | `SubagentCards.tsx` | 卡片网格展示 (name/status/tokens/cost/latency) |
| S10-04 | ✅ | `InteractionGraph.tsx` | SVG连线图 (root→subagent dispatch/response) |
| S10-05 | ✅ | `SkillDetail.tsx` | Skill汇总表 + 可展开明细 |

---

## Step 11：UI 导入入口 + 整合完善 ✅

| 编号 | 状态 | 任务 | 结果 |
|-|-|-|-|
| S11-01 | ✅ | `LocalFileImport.tsx` (3步modal: 输入路径→选session→导入) | UI导入流程完整 |
| S11-02 | ✅ | Session详情6 Tab (Overview/Turns/Timeline/Subagents/Skills/Interactions) | Tab切换完整 |
| S11-03 | ✅ | Turn过滤: role/agent/skill/tool 搜索 | 客户端过滤可用 |
| S11-04 | ✅ | 边界: 空 session/无 subagent/长 content/长 inputMessages | 不崩溃 |

### 修复
- 修复 .ts 扩展名 import (21 个文件) → next build 通过
- tsconfig.json exclude scripts/ 防止 CLI 脚本影响构建
- data-service.ts TurnRow 缺失 cost 字段修复

---

## 全项目完成状态

**187 tests pass | 11 Steps all ✅ | 端到端全链路跑通**

opencode DB 导入 → Session/Turn/ToolCall/SkillEvent/InteractionBridge/Execution 写入 → Session 列表 → Turn 详情 → 上下文治理 (LlmContextView) → 输出查看 (LlmOutputView) → Timeline/Subagent/Skill/交互链路 UI

---

## 关键文件

| 文件 | 说明 |
|---|---|
| `src/lib/shared/types.ts` | SessionListItem, RawInteraction, ToolCallInfo, TokenUsage 接口定义 |
| `src/lib/ingest/adapters/opencode-db.ts` | listSessions() + readSession() 适配器实现 |
| `src/lib/ingest/adapters/index.ts` | Adapter 接口 + getAdapter() 注册表 |
| `src/lib/ingest/normalize.ts` | normalize() 归一化函数 + NormalizedInteraction 接口 |
| `src/lib/ingest/turn-split.ts` | splitIntoTurns() → TurnRow/ToolCallRow/SkillEventRow |
| `src/lib/ingest/bridge-builder.ts` | buildBridges() → InteractionBridgeRow[] |
| `src/lib/ingest/execution-split.ts` | splitExecutions() → ExecutionRow[] |
| `src/lib/ingest/cost-calculator.ts` | MODEL_PRICING + calculateCost() |
| `src/lib/ingest/merge.ts` | dedupSession/mergeTurns/mergeToolCalls/mergeSkillEvents |
| `src/lib/ingest/data-service.ts` | importSession() 全链路编排 + Prisma 写入 |
| `tests/adapters/opencode-db.test.ts` | 12 个单元测试 |
| `tests/adapters/index.test.ts` | 5 个注册表测试 |
| `tests/normalize.test.ts` | 14 个归一化测试 |
| `tests/turn-split.test.ts` | 55 个拆解测试 |
| `tests/bridge-builder.test.ts` | 18 个 bridge 测试 |
| `tests/execution-split.test.ts` | 29 个 execution 测试 |
| `tests/cost-calculator.test.ts` | 12 个 cost 测试 |
| `tests/merge.test.ts` | 15 个 merge 测试 |
| `tests/data/opencode-sessions.db` | 真实 opencode DB (39 sessions, 3011 messages) |
| `tests/data/synthetic-opencode.json` | 合成 RawInteraction[] (7 条) |
| `prisma/schema.prisma` | 8 models Prisma schema |
