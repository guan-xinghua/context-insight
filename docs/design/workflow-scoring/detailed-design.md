# 评分体系 v2 · 详细设计

> 创建：2026-08-31 · 状态：初稿
> 层级：[design.md](design.md)（评什么）→ [architecture.md](architecture.md)（七个角色）→ **本文（接口、数据结构、目录、落地映射）**
> 前提：v1 代码日落（architecture.md §6）

---

## 0. 两个前提决定（已定，2026-08-31）

| # | 问题 | 采用的方案 | 理由 |
|---|------|----------------|------|
| 1 | 评分卡存哪 | **文件存储**：`data/scorecards/` 目录，一个 session 一个 JSON（自包含整卡），存取收在 `store.ts` 一个接口后面 | 评分卡是自包含文档、不与其它表关联（无 JOIN、无外键），文件够用且有先例（捕获 jsonl、`context-windows.json`、`skill-families.json` 都走文件）；**完全不动 Prisma schema，红线不破例**。将来真要上库只换 store.ts 一个实现 |
| 2 | 模块怎么切 | **按维度切顶层目录**：每维一个目录（定义实例＋专属评分器放一起），跨维度的公共骨架收在 `core/` | 改哪个维度就进哪个目录，自包含好找；装配/聚合引擎/基线/执行器/存储是全维度共用的角色，收在 core/ 不重复 |

---

## 1. 目录结构

```
src/lib/scoring/                  # v2 全新实现（v1 移入 src/lib/scoring-sunset/）
├── core/                         # 公共骨架（跨维度的角色模块）
│   ├── schema.ts                 #   评分项 Schema + 类型（角色④的"标准"）
│   ├── scorer.ts                 #   评分器基类 + needs 声明 + 结果类型（角色②接口）
│   ├── llm.ts                    #   LLM 通道：配置复用 + buildChatUrl + 解析（角色② LLM 侧）
│   ├── shell-parser.ts           #   自研轻量 shell 拆分（D2.destructive 用）
│   ├── test-parser.ts            #   测试输出解析（D1.verifiedRun / D3.testResults 共用）
│   ├── assembler/                #   输入装配（角色①）：九种料
│   │   ├── types.ts              #     AssembledInput / WireSummary / Measures 等
│   │   ├── digest.ts             #     轨迹摘要（不截尾规则在这）
│   │   ├── toolcalls.ts / messages.ts / measures.ts
│   │   ├── workflow-decl.ts      #     从 context 扩展层读工作流声明（CLAUDE.md/system）
│   │   └── task-classifier.ts    #     任务类型判定（声明标签 → 文件路径启发）
│   ├── aggregator.ts             #   通用聚合引擎（角色③，策略是数据）
│   ├── baseline/                 #   基线服务（角色⑤）：service.ts + default-baseline.json
│   ├── profile/                  #   评分配置 profile：types/presets（客户端安全）+ store/apply
│   ├── runner.ts                 #   执行器（角色⑥）：装配→逐项→聚合→store.put
│   └── store.ts                  #   评分卡存取（data/scorecards/ 文件实现）
├── d1-completion/                # 每维一个目录：定义实例 + 专属评分器
│   ├── definition.ts             #   评分项 + 聚合策略（数据）
│   └── scorers.ts                #   本维度专属评分器实现
├── d2-trust/ d3-quality/ d4-efficiency/ d5-redundancy/ d6-autonomy/   # 同构
├── user/                         # D7 加载器：data/scoring/user-definitions/ 的用户实例
├── registry.ts                   # 汇总：内置六维 + D7 用户实例 → 供执行器取全部定义
└── index.ts                      #   对外出口（API 层只 import 这里）
```

**呈现（角色⑦）不在此目录**：API 路由在 `src/app/api/observe/session/scorecard/`，页面组件在 `src/components/scoring/`（v1 已有位置，改造）。

---

## 2. 核心数据结构（TS）

### 2.1 评分项 Schema（definition/schema.ts）

```ts
type ScorerKind = 'rule' | 'llm' | 'baseline-compare'
type DimensionRole = 'veto' | 'weighted' | 'optional'

interface ScoreItemSchema {
  id: string                    // 'D1.verifiedRun' / 'D3.correctness' / 自定义维度用用户起名
  dimension: string             // 'D1' ~ 'D7'（D7 为 'D7:<用户定义id>'）
  name: string                  // 展示名：'验证证据' / '正确性'
  scorerKind: ScorerKind
  role: DimensionRole
  // —— LLM 评分项才有：档位说明（一源多用，生成 prompt 和页面文案）——
  bands?: Array<{ range: string; label: string; description: string }>
  // —— 聚合策略：数据，引擎解释执行 ——
  aggregation: AggregationPolicy
  // —— 加权维才有 ——
  weight?: number               // 占本维度内的权重
}

type AggregationPolicy =
  | { kind: 'three-state'; rules: ThreeStateRule[] }              // D1/D2：组合表作为数据
  | { kind: 'average-with-floor'; floorItemId: string }           // D3：平均 + 指定项封顶
  | { kind: 'weighted-average' }                                  // D4：80/20、D5：平均
  | { kind: 'count-deduction'; perEvent: Record<string, number> } // D6：按子项定扣分（纠正扣 X、不该问的问扣 Y 两档）
  | { kind: 'direct' }                                            // D7：直接分

interface ThreeStateRule {   // 组合规则是数据不是代码——例：自报完成+无验证+大量无痕迹 → 未完成
  when: Record<string, string>   // 子项 id → 期望值/判定
  then: string                   // '完成'|'未完成'|'无法判定' / 'violation'|'suspected'|'clean'
}
```

### 2.2 装配产物（assembler/types.ts）

```ts
interface AssembledInput {
  trajectoryDigest: string       // 轨迹摘要（喂 LLM，不截尾）
  toolCalls: ScoreToolCall[]     // 工具调用表（喂规则评分器）
  userMessages: ScoreTurn[]      // 用户消息表（喂 D6 分类）
  measures: Measures             // 测量值（喂基线对比评分器）
  taskType: 'operator' | 'general' | 'unknown'
  workflowDecl: WorkflowDeclaration | null
  finishReason: 'normal' | 'truncated' | 'error' | 'unknown'  // D1.stopReason 前置门的原料
  interrupts: Array<{ turnIndex: number }>                     // D6 打断信号（第几轮被打断）
  wire: WireSummary | null            // D5 五类的原料；非 proxy 的 session 为 null
  redactionEvents: RedactionEvent[]   // D2.secrets proxy 路：脱敏命中事件；非 proxy 为空数组
}

interface WireSummary {          // 上下文构成（v1 WireCharsSummary 迁移 + 扩展）
  declaredTools?: Array<{ name: string; approxTokens: number }>    // 工具说明全集
  availableSkills?: Array<{ name: string; approxTokens: number }>  // skill 全集
  dupCopyTokens: number             // 重复注入（轮内口径）
  staleResultTokens: number         // 过期工具结果滞留
  memoryTokens?: number             // 项目说明（CLAUDE.md 等）注入量
}

interface RedactionEvent {       // 捕获层脱敏命中（只记类型/位置/轮次，不含原文）
  turnIndex: number
  pattern: string                 // 厂商格式（实锤）/ 泛格式（疑似）
  location: 'request' | 'tool-args' | 'file-write'
}

interface Measures {
  totalTokens: number
  toolTimeMs: number             // 工具执行时间之和
  llmTimeMs: number              // 只展示用
  inputTokens: number            // 供 D5 比率的分母
}

interface WorkflowDeclaration {  // 工作流声明：统一一个来源
  acceptance?: string            // 验收清单原文（自然语言）
  redlines?: string              // 红线声明原文
  taskTypeTags?: string[]        // 任务类型标签
}
```

### 2.3 评分器统一接口（scorers/base.ts）

```ts
interface ScorerContext {
  input: AssembledInput
  llm?: LlmClient               // 未配语义评审时为 undefined（LLM 评分器据此弃权）
  samples?: number              // 多次采样次数，默认 1（留口）
}

abstract class Scorer {
  abstract readonly id: string
  /** 声明要什么料——执行器按此注入（TS 无运行时签名反射，显式声明） */
  abstract readonly needs: (keyof AssembledInput)[]
  abstract run(ctx: ScorerContext): Promise<SubItemResult>
}

interface SubItemResult {        // 统一结果：所有评分器产出同一形状
  itemId: string
  label: string
  status: 'ok' | 'not-applicable' | 'error'
  value?: number | string | boolean
  baselineScore?: number         // 基线对比分（双轨显示：绝对值与对比分并排）
  verdict?: string               // 三态判定：'完成'|'未完成'|'无法判定' / 'violation'|'suspected'|'clean'
  evidence: Evidence[]           // §N 证据
  attribution?: Array<{ label: string; tokens?: number }>   // 归因明细（D4/D5）
  error?: { message: string }    // 错误态：失败也是一条记录
}

interface Evidence { turnIndex: number | null; quote?: string }
```

### 2.4 评分卡（scorecard/types.ts）——列表结构，不写死维度

```ts
interface Scorecard {
  schemaVersion: string          // 'workflow-scorecard@2'
  sessionId: string
  computedAt: string
  status: 'completed' | 'aborted'   // 截断 → aborted；中止的卡**不写盘**，API 直接返回并说明原因
  abortReason?: 'truncated'
  framework: {
    totalScore: number | null
    veto: { triggered: boolean; reasons: string[] } | null
    coverage: number             // 覆盖度折扣
    weightsUsed: Record<string, number>   // 权重快照（可追溯）
  }
  dimensions: DimensionResult[]  // ← 维度结果列表（新维度=多一个元素）
  judgeCost: { calls: number; tokens: number } | null
}

interface DimensionResult {
  dimensionId: string            // 'D1'...'D6'，D7 为 'D7:<id>'
  role: DimensionRole
  status: 'scored' | 'not-applicable' | 'error'
  score?: number | null
  verdict?: string               // 否决维的三态判定
  items: SubItemResult[]
}
```

### 2.5 持久化（文件存储，不动 Prisma）

```
data/scorecards/
├── <sessionId>.json                    # 最新一张卡（自包含：框架层+维度列表+成本）
└── archive/<sessionId>/<computedAt>.json   # 重算时旧卡归档，保留历史
```

**存取收在一个接口后面**（`scorecard/store.ts`），其余代码不碰文件系统：

```ts
interface ScorecardStore {
  get(sessionId: string): Promise<Scorecard | null>          // 读最新
  put(scorecard: Scorecard): Promise<void>                   // 写最新 + 旧卡挪 archive
  listForBaseline(f: BaselineFilter): Promise<Scorecard[]>   // 基线语料：按任务类型过滤、
                                                             //   排除否决卡、排除旧 schemaVersion
}
```

**关键决定**：

- **为什么文件不上库**：评分卡是自包含 JSON 文档，无 JOIN、无外键、无跨表约束——塞进 SQLite 的 JSON 列不赚任何东西；文件方案完全不动 Prisma schema，"零 Prisma schema 改动"红线**不破例**。项目已有文件数据先例：捕获 jsonl、`context-windows.json`、`skill-families.json`；MLflow 默认 tracking store 也是文件目录（`mlruns/`）。
- **基线扫描的成本**：`listForBaseline` 是扫目录+解析+过滤。本地工具 session 量级为百~千，全扫一次远小于一次 LLM 评审（秒级 vs 分钟级），不是瓶颈。
- **并发写**：先写 `<sessionId>.json.tmp` 再 rename，原子替换；单用户本地工具，足够。
- **历史保留**：重算不删旧卡，挪 `archive/`（趋势、对比、远期人工修正都要历史）；基线只取最新。
- **可逆性**：将来若要跨大集合任意查询（如全量趋势看板），换掉 store.ts 一个实现即可，其它模块零改动。

### 2.6 评分配置 Profile（core/profile/types.ts）

```ts
interface CustomItemSpec {
  id: string                    // '<dim>.<kebab-suffix>'，如 'D3.doc-sync'（不与内置子项 id 冲突）
  targetDimension: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6'
  name: string                  // ≤40
  note?: string
  kind: 'llm' | 'rule'          // 与 D7 同一套：LLM 档位评分 / 规则判定
  bands?: Band[]                // kind='llm' 必填（≥2 档，同 isValidUserDimension 档位规则）
  rule?: RuleSpec               // kind='rule' 必填（user/rule-scorer 的 11 信号）
  weight?: number               // D4/D5 目标必填（内置子项标尺合计≈1）；D3 可选默认 1；D1/D2/D6 无意义
}

interface ScoringProfile {
  schema: 'scoring-profile'
  version: 1
  id: string                    // 用户 kebab-case；'preset:*' 为内置模板保留前缀
  name: string                  // ≤40
  note?: string
  dimensionWeights?: Partial<Record<'D2'|'D3'|'D4'|'D5'|'D6', number>>   // D1 否决维/D7 拒绝
  excludedItems?: string[]      // 内置子项 id；D1 规则四项拒绝；未知 id 剥离进 warnings
  itemWeights?: Record<string, number>
  customItems?: CustomItemSpec[]
}
```

**存储**：`~/.cannbot-insight/scoring-profiles/`（`SCORING_PROFILE_DIR` → `SCORING_DATA_DIR/scoring-profiles` 三级回退），`<id>.json` 一个 profile 一个文件 + `active.json` 记激活 id（null = 默认口径）；tmp+rename 原子写，坏文件跳过不阻塞。

---

## 3. 各模块设计要点

### 3.1 装配器（assembler/）

| 料 | 产出规则 | 关键点 |
|----|---------|--------|
| 轨迹摘要 | 轮次列表：序号/角色/时间/token/工具/摘要 | **不截尾**（§9 通用纪律）；摘要规则复用 v1 语义评审的 digest 逻辑 |
| 工具调用表 | 全量 toolCalls（args/result） | 规则评分器全量扫描零抽样 |
| 用户消息表 | role=user 的轮次 | 供 D6 逐条分类 |
| 测量值 | token/时间/输入 token | 从 Session + toolCalls 聚合，v1 collect.ts 迁移 |
| 任务类型 | 工作流声明标签 → 否则改文件路径启发 | D1.acceptance/D3 基准测试评分共用；基准测试评分仅作门控，值来自用户填报（不评轨迹） |
| 结束原因 | wire stop_reason / 末轮状态 → normal/truncated/error | D1.stopReason 前置门的原料 |
| 打断信号 | turn 状态/中断标记 → 打断轮次列表 | D6 规则层 |
| 上下文构成（wire） | proxy：工具说明/skill 全集/重复注入/过期滞留/项目说明的 token 量；非 proxy 为 null | D5 五类的全部原料 |
| 脱敏命中事件 | proxy 扩展字段读取（类型/位置/轮次，无原文）；非 proxy 为空 | D2.secrets proxy 路 |
| **留口** | 缺字段时 LLM 补抽 | 只留接口（`extractFallback?: LlmClient`），暂不实现 |

### 3.2 三类评分器

**规则评分器**（scorers/rule/）：纯函数，输入 toolCalls/消息/测量值。实现清单见 §4 映射表。要点：
- 全量扫描；`not-applicable` 只在数据缺失时出现
- 测试结果解析器独立成 `core/test-parser.ts`（D1.verifiedRun 与 D3.testResults 共用）
- 危险命令：**自研轻量 shell 拆分**（已定，2026-08-31）——按 `&&` `||` `;` `|` 断句，每段取首词+flag 匹配危险清单；断不了的（嵌套引号、命令替换、变量）**不硬判**，标疑似只披露；确凿违规走否决。LLM 层（D2.redlines/authorization）可对疑似项复核升级。不引解析库

**LLM 评分器**（scorers/llm/）：从 Schema 实例生成一切——

```
ScoreItemSchema.bands ──→ system prompt（评分步骤显式 + 每档标准 + 输出格式说明）
                      ──→ Zod schema（structured output 校验）
                      ──→ 解析失败 → SubItemResult(status:'error')，不猜测不重试
```

- LLM 调用一律走 `buildChatUrl`（`src/lib/ai/analyzer.ts` 唯一权威源，仓库红线）
- 复用现有语义评审的 LLM 通道与配置（不另建配置入口）
- `samples` 参数：N 次取多数（默认 1，留口）
- 逐项判定 + §N 证据引用；Prompt 中强制证据轮次

**基线对比评分器**（scorers/baseline-compare.ts）：查表运算——

```
measure + 指标 key + cohort → baseline 服务查 P25/P50/P75 → 位置映射 0-1（方向感知）
```

基线缺失该指标 → `not-applicable`（不硬评）。

### 3.3 聚合引擎（aggregator/engine.ts）——伪代码

```ts
function aggregate(dimResults: DimensionResult[], defs: ScoreItemSchema[]): Framework {
  // 1. 否决检查（只认角色，不认维度）
  const veto = dimResults.find(d => d.role === 'veto' && d.verdict === '未完成' || d.verdict === 'violation')
  // 2. 逐维算分：按该维声明的 aggregation 策略解释执行
  //    three-state / average-with-floor / weighted-average / count-deduction / direct
  // 3. 覆盖度折扣 = 已评项 / 应评项（not-applicable 和 error 都不入分子）
  // 4. 总分 = veto ? null : Σ(加权维分 × 权重) × 覆盖度
  // 5. 权重快照记进 framework.weightsUsed
}
```

引擎里**没有** 'D1' 'D7' 字样——策略是数据，新增维度零改引擎。

### 3.4 基线服务（baseline/）

- v1 `baseline.ts` 迁移：查分位、方向感知映射、导入/恢复默认
- 新增：cohort 判定（起步 = 工作流类型 → 基线文件的分组 key）
- 远期：基线生成器（批量跑分，复用执行器 + 确定性采样 + 断点），本设计只预留 `baseline/regen.ts` 空位

### 3.5 执行器（runner/run.ts）

```
runScorecard(taskId, { withSemantic }): Promise<Scorecard>
  1. collect + 装配；前置检查：finishReason=truncated → 产出 status:'aborted' 的评分卡**直接返回，不写盘**（也不进基线语料）
  2. 取全部评分定义（内置 + D7 用户实例）
  3. 逐维逐项：按 needs 注入 → scorer.run() → try/catch（异常转 error 态，流程不断）
  4. withSemantic=false 时 LLM 评分器整体 skip（不报 error，标 not-applicable）
  5. 聚合 → 评分卡 → store.put() → 返回
  6. judgeCost 累计（LLM 调用次数与 token）
```

### 3.6 呈现（角色⑦）

**API**（沿用 v1 路径，语义不变）：

| 端点 | 行为 |
|------|------|
| `GET /api/observe/session/scorecard?taskId=` | 读最新一张（store.get）；无则 404 |
| `POST /api/observe/session/scorecard` | 触发执行器（确定性层），body `{taskId}` |
| `POST /api/observe/session/scorecard/semantic` | 触发 LLM 层（需已配 LLM），合并写盘 |
| `GET /api/observe/scoring/profiles` | 模板 + 用户配置 + activeId + 当前口径应用 warnings |
| `PUT /api/observe/scoring/profiles` | upsert 用户 profile（validateAndSanitize；非法 400） |
| `POST /api/observe/scoring/profiles` | 激活/恢复默认，body `{ activeId: string \| null }` |
| `DELETE /api/observe/scoring/profiles?id=` | 删用户 profile（模板 400；删激活项回落 null） |

**前端组件**（`src/components/scoring/` 改造）：

```
ScorecardView（遍历 dimensions 列表，通用渲染）
├── DimensionCard（按 role 出头：否决徽标/分数/不适用）
│   ├── VerdictBadge（完成/未完成/无法判定 · 违规/疑似/无发现）
│   ├── SubItemCard（每个子项：值/判定/证据§N 可点开跳轮次）
│   └── AttributionCard（归因明细，D4/D5 有则显示）
├── FrameworkBar（总分·否决标记·覆盖度·权重快照）
└── JudgeCostTag（评审花了多少）
```

维度卡是通用组件——不认识具体维度，D7 用户自定义维度自动有完整呈现。

### 3.7 评分配置 profile（core/profile/）

**apply.ts**：`applyProfile(builtins, profile) → { defs, scorers, warnings }`

```
structuredClone(BUILTIN_DIMENSIONS)     # 模块级常量绝不原地改
→ 过滤 excludedItems（未知 id / D1 规则四项运行时宽容剥离 + warning）
→ 套 itemWeights（未知 id + warning）；dimensionWeights 覆盖 weightInTotal（D1/D7 键忽略 + warning）
→ 注入 customItems：ScoreItemSchema（D2/D6 目标标 diagnostic: true 只展示）
   评分器复用 BandJudgeScorer / UserRuleScorer（与 D7 同一套）
→ D1 目标的 customItem id 追加进 policy.completionScoreOf（进完成度均值，不碰三态规则）
```

**presets.ts**（纯数据，客户端可 import）：`preset:quick / preset:operator / preset:minimal`；quick/minimal 的 excludedItems 从 BUILTIN_DIMENSIONS 按 `scorerKind === 'llm'` 程序化生成（id 演进免疫），minimal 追加 `D5.dup`/`D5.stale`。

**registry 接入**：`loadRegistry()` 读 active profile → applyProfile → 再追加 D7 用户维度 → join；Registry 多出 `profile?: { id; name } | null` 与 `warnings: string[]`。runner 把 `registry.profile` 写进 `framework.profile`（旧缓存卡无此字段按「默认」显示）。

**聚合器两处适配**：average-with-floor 改加权均值（`weight ?? 1`，未设权重行为不变）；count-deduction 加 `perEvent[itemId] ?? 0` 防 D6 自定义项 NaN。权重归一化两级原本就按 wSum 归一，覆盖零额外改动。

**UI**：`ProfileManager.tsx`（评分配置对话框，吸收原「自定义维度」入口）：模板区（使用/复制）→ 用户配置列表（激活/编辑/导出/删除）→ 编辑面板（维度权重 D2–D6 / 每维子项勾选+权重 / 自定义项表单）/ 导入 / 恢复默认口径；底部入口跳 D7 管理器（独立系统保留）。

---

## 4. 维度 → 实现映射表（design.md 的落地对照）

| 子项 | 评分器 | 输入 | v1 复用 / 新建 |
|------|--------|------|----------------|
| D1.stopReason 结束原因 | 规则 | wire stop_reason / 末轮状态 | ❌ 新建（数据已有） |
| D1.selfReport 自报完成态 | 规则 | TodoWrite 末态 status | 🔶 extractTodoSteps 迁移改造（status 已提取未用） |
| D1.planReconcile 计划对账 | 规则 | Todo + 工具调用 | ✅ computePlanDeviation 迁移 |
| D1.verifiedRun 验证证据 | 规则 | 工具调用（白名单+时序） | ❌ 新建，与 D3.testResults 共用 test-parser |
| D1.acceptance 验收清单对账 | LLM | 声明.验收清单 + 轨迹摘要 | ❌ 新建 |
| D1.goalCoverage 目标覆盖 | LLM | 首轮消息 + 轨迹摘要 | 🔶 G4 rubric 改造为逐项制 |
| D2.destructive 破坏性操作 | 规则 | 工具调用（正则+shell 解析） | ❌ 新建 |
| D2.secrets 敏感信息 | 规则 | proxy: redactor 命中事件；native: 写入/外发参数 | ❌ 新建（proxy 侧需导出命中事件到扩展字段） |
| D2.access 越权访问 | 规则 | 读写路径 | ❌ 新建 |
| D2.redlines 红线对账 | LLM | 声明.红线 + 轨迹摘要 | ❌ 新建 |
| D2.authorization 授权与规避 | LLM | 用户消息 + 轨迹摘要 | ❌ 新建 |
| D3.testResults 测试结果 | 规则 | 工具输出（test-parser） | ❌ 新建 |
| D3.nakedWrite 不读就写 | 规则 | 工具调用 | ✅ computeNakedWrite 迁移 |
| D3 通用五项 | LLM | 轨迹摘要 + diff 材料 | 🔶 semantic-rubric 五项重组 |
| D3 基准测试评分 | 用户填报 | 基准测试总分 0-100 → 0-10；未填报默认 0.8 持平档（明标）；非算子任务不适用 | ❌ 新建（BenchReportScorer + 填报存储/API/对话框；不走 LLM） |
| D4 token | 基线对比 | measures.totalTokens | 🔶 collect.ts 迁移 |
| D4 工具时间 | 基线对比 | measures.toolTimeMs | 🔶 durationMs 求和 |
| D4 浪费归因 | 规则（只诊断） | 返工/重复读/重试/缓存/隐性开销 | 🔶 metrics.ts 多函数迁移 |
| D5 重派/原样重复/工具调用出错 | 规则 | 工具调用序列（loop-detect 一源多用；toolErrors 自 D3 迁入，原样重复段内只计首错） | 🔶 迁移改造 |
| D5 五类比率 | 基线对比 | wire/proxy 数据 + 调用差集 | 🔶 dupInjectionCopies/staleToolResults 迁移；工具说明/skill/memory 差集新建 |
| D5 工作过程熟练度 | LLM | 轨迹摘要 | 🔶 S2 rubric 改名改造 |
| D6 代码直算层 | 规则 | 打断标记/纠正关键词/相似消息 | ❌ 新建 |
| D6 消息九分类 | LLM | 用户消息逐条 | ❌ 新建（Phoenix 豁免清单+三纪律进 prompt） |
| D7 自定义 | LLM | 用户定义实例 | ❌ 新建（复用 LLM 评分器 + Schema） |
| profile 覆盖层（勾选/权重/自定义项/模板/导入导出） | 规则 + LLM（自定义项复用 BandJudge/UserRule） | ScoringProfile 文件 | ❌ 新建（core/profile/ + profiles API + ProfileManager） |

---

## 5. 测试计划（按仓库惯例：集成测试 + 数据驱动）

| 层 | 测试 | 数据 |
|----|------|------|
| 评分器 | 每类规则评分器单测：构造 toolCalls/消息 fixture 断言判定 | `tests/data/scoring/` 下 JSON fixture |
| 装配器 | 截断检测、不截尾、任务类型判定 | 复用现有 tests/data 会话样本 |
| 聚合引擎 | 五种策略各一例 + 否决 + 折扣 + **加新维度零改引擎**的回归例 | 维度结果 fixture |
| 端到端 IT | JSONL 导入 → 跑分 → API 读卡 → 断言七维结构（含错误态注入用例） | `tests/scoring-v2-*.test.ts` |
| LLM 层 | mock LLMClient：解析失败→error 态、证据校验、采样参数 | mock |
| 基线对比 | 有/无该指标基线 → 分 / not-applicable | 基线 fixture |

---

## 6. 实施顺序（里程碑）

| 阶段 | 内容 | 产出 |
|------|------|------|
| M1 地基 | 目录骨架、Schema 与类型、统一评分器接口、评分卡结构、聚合引擎、评分卡文件存储（store.ts）、v1 日落+资产迁移 | 框架可跑空维度 |
| M2 免费层 | 全部规则评分器 + 基线对比评分器（D1 规则四项（stopReason/selfReport/planReconcile/verifiedRun）、D2 规则三项（destructive/secrets/access）、D3.testResults/nakedWrite、D4、D5 五类、D6 直算） | 不配 LLM 也有完整六维免费评分 |
| M3 LLM 层 | LLM 评分器基建（Schema→prompt→解析）+ D1.acceptance/goalCoverage、D2.redlines/authorization、D3 五维、D5 熟练度、D6 九分类 | 语义评审全量升级 |
| M4 收尾 | 呈现完善（通用维度卡/下钻/归因卡）、D7 自定义维度（定义 UI + 存取）、报告导出 | 完整交付 |
| 远期 | 基线生成器（批量+采样+断点）、人工修正、多次采样启用 | — |

---

## 7. 本设计的一个待确认点

1. **D7 用户实例存在哪**：localStorage / 数据文件——M4 前定（影响 definition 加载器；倾向数据文件 `data/scoring/user-definitions/`，评分是后端执行的，定义必须后端可读）

> 已定四项：
> - **评分卡存哪**（2026-08-31）：文件存储 `data/scorecards/`，见 §2.5——不动 Prisma，红线不破例。
> - **模块怎么切**（2026-08-31）：**按维度切顶层目录**，公共骨架收在 `core/`，见 §1。
> - **shell 命令解析器**（2026-08-31）：**自研轻量拆分 + LLM 兜底**（确凿→否决；断不了→疑似只披露，LLM 层复核），不引解析库。竞品无先例：MLflow 红线类检查全走 LLM judge。
> - **工作流声明从哪读**（2026-08-31）：**从 context 读**。proxy 捕获的 system prompt 与 memory（CLAUDE.md）里已有声明内容，`claude-jsonl-full-context` 扩展层已在提取（`systemPrompt`/`memoryFiles`）；装配器只做"声明段落 → WorkflowDeclaration"的解析。无捕获数据的 session（如 opencode native）→ D1.acceptance/D2.redlines 标 not-applicable，任务类型退回文件路径启发。
