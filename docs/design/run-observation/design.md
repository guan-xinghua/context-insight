# Run 观测（workflow-bundle 导入与展示）— 设计

> 对应需求：[requirements.md](requirements.md)。
> 核心思路：在 Insight 内部新增一个与 Session 域并列的 **Run 域**——manifest 是
> 冻结快照、量级小（60KB/76 成员），落数据主目录由 API 层实时组装，**零 Prisma
> schema 变更**；会话正文照旧走现有导入管线进 Session 域，turn 观测全量复用。

## 一、领域模型

### 1.1 概念定义

| 概念 | 定义 | 来源（Opsbot 运行时） |
|------|------|----------------------|
| **Run** | 一次 graph 执行的完整历史 = manifest 根 workflow | `graph_id` 的一次运行 |
| **逻辑节点（nodeId）** | YAML 里的节点 id，跨代不变 | `dag.nodes[].id` |
| **代（generation）** | 回滚批次号；`new_gen = max_gen + 1`，同批 reset 的节点共用 | `state.nodes[].gen` / `retired_instances["{nid}#{gen}"]` |
| **尝试（attempt）** | 同代内节点执行的序号；回滚后归零、同号跨代重现 | `increment_attempts` + `node_history` 事件（按 `(gen, attempt)` 折叠） |
| **角色（role）** | execute（执行）/ verify（验收）——同节点同次尝试的两个成员 | `opsbot_session_id` / `verify_session_id` |
| **成员（member）** | manifest 的原子单元：process（bash/script 验收，无会话）/ session（agent 成员，指向会话正文）/ workflow（动态子图） | 上述三者的序列化投影 |
| **关系（relation）** | 成员间有向边：`depends_on`（依赖）/ `rollback`（回滚，不参与拓扑）/ `gen-sub-graph`（生成器→子图） | `dag.edges` / `rollback_edges` / 子图合并记录 |

**五键定位**（成员 → 会话的唯一寻址）：`根 workflow id + nodeId + generation + attempt + role`。

### 1.2 两域关系

```
   Run 域（新增）                       Session 域（已有，零改动）
┌────────────────────────┐            ┌──────────────────────────┐
│ Run(manifest 文件)      │            │ Session (Prisma)          │
│  ├─ 逻辑节点            │    sid     │  ├─ Turn                  │
│  │  ├─ 代               │───弱关联──►│  ├─ ToolCall              │
│  │  │  ├─ 尝试          │  (taskId + │  ├─ SkillEvent            │
│  │  │  │  └─ 成员 ──────┼─framework  │  └─ Execution/...         │
│  │  └─ 关系边           │   消歧)    │                           │
└────────────────────────┘            └──────────────────────────┘
  API: /api/observe/run*               API: /api/observe/*（现有 22 端点）
```

**为什么是弱关联而不是外键**：仓库铁律「feature work 零 Prisma schema 变更」；
manifest 本身已携带成员 → sid 的映射，反向归属靠扫描（run 数量级小，扫描代价可忽略）。

## 二、总体架构（分层）

```
┌─ Serving 读层 ──────────────────────────────────────────────────────┐
│  GET /api/observe/runs · /run/[runId] · /run/by-session/[taskId]     │
│  Web：/runs 列表页 + /run/[runId] 详情页 + session 页归属徽标          │
│  CLI/TUI：分期（API 已备）                                            │
├─ ★ Run 域（新增，src/lib/run/）─────────────────────────────────────┤
│  model.ts        领域类型（manifest schema ↔ 内部模型，信封冻结）      │
│  reader.ts       解析 + 校验 + 全树索引 + 五键定位（纯函数）           │
│  view-model.ts   manifest → 展示模型（代带/回滚边/子图/carried，纯函数）│
│  run-store.ts    runs/ 目录管理：落盘/列表/读取/删除                   │
│  session-link.ts 成员 ↔ Prisma 会话 join + 反向归属                   │
├─ Ingest 写层 ───────────────────────────────────────────────────────┤
│  POST /api/ingest/import-bundle（job 化）                             │
│  → import-service.ts 编排：校验 → 落 manifest → 逐会话导入             │
│  → 复用现有 importSession 管线（adapters/registry 分发，零改动）        │
├─ Pipeline 管线层（不动）────────────────────────────────────────────┤
│  readSession → normalize → turn-split → bridge → execution-split → 写库│
├─ Session 域 Serving（不动）──────────────────────────────────────────┤
│  22 个 /api/observe/* 端点 + Web/TUI/CLI 三端                         │
└──────────────────────────────────────────────────────────────────────┘
```

**依赖方向**：`api/ingest`、`api/observe`、前端组件 → `lib/run/*` → （仅
`session-link.ts`）→ Prisma。reader/view-model/run-store 为纯函数或薄文件层，
`session-link` 是唯一触碰 DB 的模块——域内分层与 agent-source-framework 的
「注册层单点、内核不改」同构。

## 三、存储设计（run-store）

### 3.1 目录布局（数据主目录下新增 `runs/`）

```
~/.cannbot-insight/
├── lake-config.json …（现有）
└── runs/                              # 新增
    └── <runId>/                       # runId = manifest 根 workflow id
        ├── manifest.json              # manifest 原样落盘（统一命名）
        └── import.json                # 导入元数据（sidecar，见 3.2）
```

选择 per-run 目录而非单文件的理由：后续扩展（如 run 级派生缓存、缩略图、
导出的关联文件）有独立命名空间，不破坏现有文件。

### 3.2 导入元数据 `import.json`

```json
{
  "schema": "insight-run-import",
  "version": 1,
  "data": {
    "importedAt": "2026-10-14T09:00:00+08:00",
    "sourceDir": "/path/to/d01dfbaa-bundle",
    "manifestFile": "workflow.json",
    "exportDataComplete": false,
    "sessions": { "total": 183, "imported": 180, "skipped": 3, "failed": 0 },
    "warnings": ["3 个会话目录未被 manifest 引用（照常导入）"]
  }
}
```

### 3.3 管理语义

| 操作 | 语义 |
|------|------|
| 列表 | 扫描 `runs/*/manifest.json` + `import.json`（无 index 文件；run 量级小，扫描 + 内存缓存） |
| 重复导入 | 同 runId 覆盖落盘；会话按 `(taskId, framework)` 唯一索引天然幂等跳过——**重导入安全** |
| 删除 run | 删 `runs/<runId>/` 目录；**不级联删除已导入会话**（会话是独立资产，仍留在 Sessions 列表） |
| 半途失败 | manifest 先落盘、会话导入可重入：run 视图对缺正文成员渲染"正文缺失"，重导入补齐 |

## 四、核心契约（`src/lib/run/`）

### 4.1 `model.ts` — 领域类型（信封冻结原则，对齐 cannbay-schema-spec）

```ts
export type MemberKind = 'process' | 'session' | 'workflow';
export type MemberRole = 'execute' | 'verify';

export interface RunGraphAnnotation {
  nodeId: string;
  generation: number;          // 0 起；回滚批次
  attempt: number;             // 0 = 未执行空占位
  role: MemberRole;
  attemptResult?: 'succeeded' | 'failed';
  verification?: { status: 'passed' | 'failed' } & Record<string, unknown>;
  executionState?: 'executed' | 'not_run' | 'carried';
  retryPolicy?: Record<string, unknown>;
  [k: string]: unknown;        // 未知字段透传，不丢数据
}

export interface RunMember {
  id: string;                  // 全树唯一
  kind: MemberKind;
  name?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  sessionId?: string | null;   // session 成员指向正文
  location?: string | null;
  output?: { text?: string } | null;
  annotation?: { graph?: RunGraphAnnotation } & Record<string, unknown>;
  data?: RunWorkflowData;      // workflow 成员递归（子图）
}

export interface RunRelation {
  from: string;                // 引用成员 id，可跨层级
  to: string;
  annotation?: { type?: 'depends_on' | 'rollback'; kind?: 'gen-sub-graph' } & Record<string, unknown>;
}

export interface RunWorkflowData {
  exportDataComplete?: boolean;
  members: RunMember[];
  relations: RunRelation[];
}

export interface RunManifest {
  schema: 'cannbot.workflow-bundle';
  version: number;             // 1；>1 时 reader 拒绝并给出可行动错误
  id: string; kind: string; name?: string | null;
  startedAt?: string | null; finishedAt?: string | null;
  data: RunWorkflowData;
}
```

**演进策略**：`(schema, version)` 声明式分发（同 cannbay 信封冻结）；加可选字段
不升版，未知字段一律透传；改语义/类型必升版——v2 出现时在 reader 入口按版本
分发转换器，域内下游零感知。

### 4.2 `reader.ts` — 解析 + 校验 + 索引（纯函数，无 fs/DB）

```ts
export interface IndexedMember {
  member: RunMember;
  parentWorkflowId: string;     // 所属（子）workflow 的成员 id；根为 null
  graph: RunGraphAnnotation;    // 归一后的五键（缺省补 0/execute）
}

export interface RunIndex {
  runId: string;
  manifest: RunManifest;
  membersById: Map<string, IndexedMember>;          // 全树扁平
  graphMembers: IndexedMember[];                    // 带 graph 注解的成员
  relations: ResolvedRelation[];                    // from/to 已解析为成员引用
  warnings: string[];                               // 容忍性问题（不阻断）
}

export function parseManifest(json: unknown): RunManifest;        // 严格校验，抛带 reason 的错误
export function buildIndex(manifest: RunManifest): RunIndex;      // 全树遍历 + 关系解析
export function memberKey(m: IndexedMember): string;              // `${nodeId}|${gen}|${attempt}|${role}`
export function lookupMember(index: RunIndex, key: string): IndexedMember | undefined;
```

**校验规则**（错误 = 拒绝导入；警告 = 容忍、透传到 UI）：

| 级别 | 规则 |
|------|------|
| 错误 | `schema !== 'cannbot.workflow-bundle'`；`version > 当前支持`；根 `data.members` 缺失/非数组；成员 `id` 全树重复；关系 `from/to` 引用不存在的成员 |
| 警告 | session 成员 `location` 在包内不存在（`exportDataComplete=false` 合法态）；`sessions/` 存在未被引用的目录；无 `graph` 注解的成员（计为 process 语义） |

### 4.3 `view-model.ts` — 展示模型（纯函数，移植 HTML 原型逻辑）

```ts
export interface AttemptRecord {
  ordinal: number; status: string;              // succeeded/failed/…
  startedAt / finishedAt / failureReason / outputText;
  verification?: { status: string; reason?: string };
  executeSession?: SessionRef; verifySession?: SessionRef;  // session-link join 结果
}
export interface NodeInstance {
  key: string;                  // `n-<nodeId>-g<gen>`
  nodeId: string; generation: number;
  label: string; taskType: 'agent' | 'bash' | 'generator';
  status: 'passed' | 'failed' | 'running' | 'pending' | 'carried';
  executionState: 'executed' | 'not_run' | 'carried';
  carriedFromGeneration: number | null;
  attempts: AttemptRecord[];
  predecessorIds: string[];     # 同代依赖
  parentInstanceId: string | null;   # gen-sub-graph 挂接
}
export interface RunViewModel {
  runId / name / status / generations: number[];
  nodes: NodeInstance[];                 # 主图节点实例（子图节点剥离）
  edges: { from: string; to: string }[];
  rollbackEdges: { from: { nodeId; generation }; to: { nodeId; generation }; trigger?: string }[];
  subgraphs: SubgraphView[];             # 每个 generator × 每代一个视图
  warnings: string[];
}
export function buildViewModel(index: RunIndex): RunViewModel;
```

**计算规则**：

1. **分组**：`graphMembers` 按 `(nodeId, generation)` 分组 → NodeInstance；组内按
   `attempt × role` 组装 `attempts[]`
2. **子图剥离**：`gen-sub-graph` 关系的 to 端（workflow 成员）整体移入
   `subgraphs`，其内成员递归同规则；子图成员的 gen 继承父 generator 代（格式约定）
3. **carried**：优先读 `executionState === 'carried'` 注解；注解缺失时推导——
   节点在更早代有终态成员、本代无成员且不在回滚 reset 影响 story 内 → 本代带内
   显示 carried（沿用旧代）
4. **空占位**：`attempt === 0`（sessionId/location 为 null）→ 灰态"未执行"
5. **代带**：`generations` 升序；标签「第 1 次运行 / 回滚 #N」；同批回滚节点对齐
   同一带（Opsbot 全局代计数器保证）
6. **回滚边**：`type=rollback` 关系按 from/to 成员的五键还原 `{nodeId, generation}`，
   画红虚线，不参与拓扑分层

### 4.4 `session-link.ts` — 两域 join（唯一触 DB 模块）

```ts
export interface SessionRef {
  taskId: string; framework: string;          # 消歧后的落库行
  turns: number; totalTokens: number; durationMs: number | null;
  present: boolean;                           # 正文是否已导入
}
export function joinSessions(index: RunIndex, prisma: PrismaClient): Promise<Map<string, SessionRef>>;
   # key = memberKey(member)；按 sessionId 批量查 Session（taskId in [...]）
export function findRunMembership(taskId: string, prisma?: ...): Promise<RunMembership[]>;
   # 反向归属：扫描 runs/*/manifest.json，返回 {runId, nodeId, generation, attempt, role}
```

**消歧铁律**：同 sid 双记录（wire 捕获 vs 原生）必须带 framework 维度——bundle
会话全部是原生记录（`.native`），匹配时走 `agentFrameworkOf` 谓词族，**禁止对
framework 裸等值**。

### 4.5 `import-service.ts` — 导入编排

```
validateBundle(dir) ─► parseManifest ─► run-store 落盘 ─► 逐会话导入 ─► 写 import.json
```

会话枚举：遍历包内 `sessions/` 下的 `<sid>.native/` 目录（lake 双记录布局约定，
目录内文件用真实 sid 命名，不手拼后缀），对每个目录调用现有管线：

```ts
await importSession(jsonlPath, sid, prisma, jsonlPath, 'claude-jsonl');
```

**复用点**（现有能力，零改动）：`data-service.importSession` 的
`exportDeclaredFramework` 通路——bundle 会话 meta 为 `producer=insight-export`，
framework 声明（如 opencode）会回原生行而不是新建 claude-code 重复行；
`(taskId, framework)` 唯一索引保证重导入幂等。

## 五、导入链路设计（job 化）

183 会话 × 每个数百毫秒 ≈ 全量导入可达分钟级——**不做同步长请求**，采用
opsbot `upload-to-cannbay` 已验证的 job 模式：

```
POST /api/ingest/import-bundle  { dirPath }
  ├─ 白名单守卫（checkImportablePath，先于一切文件读取——对齐三条 ingest 路由现状）
  ├─ validateBundle + parseManifest（错误立即 4xx 返回，不起 job）
  └─ 生成 jobId，后台任务启动 → 返回 { ok, jobId }

GET /api/ingest/import-bundle/status?jobId=
  → { step: 'validate'|'store'|'import'|'done'|'error',
      total, imported, skipped, failed, currentSid?, error?, runId? }
```

| 设计点 | 方案 |
|--------|------|
| job 注册表 | 进程内 `Map<jobId, JobState>`（单实例部署模型与 multi-user 每人一实例一致）；完成态保留 10 分钟 |
| 崩溃/重启 | job 状态丢失可接受：manifest 已落盘、会话导入幂等——重新发起即续传 |
| 导入顺序 | manifest 引用的会话优先（保证 run 视图尽快完整），未引用目录随后 |
| 失败隔离 | 单会话失败记录并继续（failed 计数 + 原因进 import.json），不阻断整包 |
| 入口 | P0：API + CLI `cbi import-bundle <dir>`（轮询进度）；P1：Web 导入弹窗加 bundle 分支 |

## 六、API 设计（观测端点）

| 端点 | 方法 | 形状 |
|------|------|------|
| `/api/observe/runs` | GET | `{ runs: [{ runId, name, status, generations, nodeCount, memberCount, sessionCount, importedAt, warnings }] }` |
| `/api/observe/run/[runId]` | GET | `RunViewModel` + 每成员 `SessionRef` join 结果 + import 元数据 |
| `/api/observe/run/[runId]/member` | GET | `?nodeId&generation&attempt&role` 五键 → 成员详情（attempts 逐条 + SessionRef） |
| `/api/observe/run/by-session/[taskId]` | GET | `{ memberships: [{ runId, nodeId, generation, attempt, role }] }`（徽标数据源） |
| `/api/observe/run/[runId]` | DELETE | 删 run 目录（不删会话） |

CLI client（`src/cli/client.ts`）扩展 5 方法：`importBundle / getImportBundleStatus /
listRuns / getRun / getRunBySession`；命令 `cbi import-bundle` / `cbi runs` /
`cbi run <runId>`（P0 仅 import-bundle，runs/run 随 P3）。

## 七、前端设计

### 7.1 导航重构（AppHeader 单点）

现状：首页 header（品牌 + LocalFileImport + Bay Viewer + 设置）内联在 `page.tsx`，
每页自拼。Runs 成为一级域后，提取共享导航组件：

```
src/components/layout/AppHeader.tsx
  ├─ 品牌名 + 版本（现有逻辑迁移）
  ├─ 域导航：Sessions(/) · Runs(/runs)        ← 新增一级入口（用户决策 #1）
  ├─ LocalFileImport（Sessions 域动作，仅 / 显示）
  └─ Bay Viewer / 设置（现有链接）
```

`page.tsx`、`/runs`、`/run/[runId]`、`compare` 等页面复用——导航从此单点，
后续加域（如未来 Audit 独立页）不再散改。

### 7.2 页面与组件树

```
src/app/runs/page.tsx                    Run 列表（服务端组件 + 直读 run-store）
src/app/run/[runId]/page.tsx             Run 详情（client 组件 + observe API）
src/components/run/
  ├─ RunGraph.tsx                        主 DAG（纯 SVG，对齐 TraceView 风格——禁图表库）
  │   ├─ GenerationBands                 代带分栏（横向：第 1 次运行/回滚 #N）
  │   ├─ DependencyEdges / RollbackEdges  实线依赖 / 红虚线回滚
  │   └─ SubgraphView                    子图（generator 每代一个）
  ├─ RunNodeDetail.tsx                   侧栏：运行历史（attempts 逐条）
  │   ├─ AttemptCard                     状态/时间/验收/输出/成员链接
  │   └─ RollbackRecord                  回滚触发记录
  └─ RunBadge.tsx                        session 详情页归属徽标（反向 API）
```

**成员点击三态**（体现"只有 agent 成员有 turn"）：

| 成员类型 | 行为 |
|----------|------|
| session 成员（execute / agent 型 verify） | 跳转 `/session/<taskId>?framework=…`，现有 10 tab 全量复用 |
| process 成员（bash / script 验收） | 侧栏内展开输出文本与起止时间，无跳转 |
| 空占位 / carried | 灰态说明（"未执行" / "沿用第 N 代结果"） |

**Session 详情页改动（Session 域唯一触点）**：头部加 `RunBadge`——显示
`run 名 · 节点 · 第 N 代 · 第 M 次 · 角色`，点击回 `/run/[runId]`。数据来自
反向归属 API；无归属的普通会话零渲染开销。

## 八、对现有代码的重构清单

| # | 重构 | 理由 |
|---|------|------|
| R1 | 提取 `AppHeader` 共享导航组件 | 多域并存后导航必须单点；`page.tsx` header 内联不可持续 |
| R2 | 新建 `src/lib/run/` 域模块 | 新增即分层；不迁移现有代码，Session 域零扰动 |
| R3 | bundle 导入直接复用 `importSession` 管线 | 无新散点；source 分发走 registry 单点 |
| R4 | CLI client +5 方法 | 三前端架构惯例 |
| R5 | `docs/design/README.md` 索引更新 | 设计文档管理规范 |

**不动的部分**（OCP 红线）：Prisma schema、normalize/turn-split 管线、
adapters 内核、现有 22 个 observe 端点、proxy 扩展层。

## 九、测试策略

| 层 | 用例 | fixture |
|----|------|---------|
| reader IT | 结构全量断言：76 成员/82 关系/3 代/2 回滚/1 子图/五键定位/未知字段透传/坏 manifest 拒绝矩阵 | `tests/data/run/graph-demo-rollback-manifest.json`（结构样例入库） |
| view-model IT | 代带对齐、carried、空占位、回滚边还原、子图剥离与 gen 继承、attempts 组装 | 同上 |
| run-store IT | 落盘/列表/覆盖幂等/删除不触会话 | 临时目录 |
| session-link IT | join + framework 消歧 + 缺正文容忍 + 反向归属 | mini-bundle 导入后的 test.db |
| import 端到端 IT | mini-bundle → job → 进度 → Prisma 断言（会话行/turns）→ runs API 可读 | `tests/data/run/mini-bundle/`（合成小包：3 会话 + 1 process + 空占位 + carried 各覆盖） |
| UI | /runs 列表渲染、run 详情图基础交互、徽标（API 层驱动，对齐仓库 Integration over unit 原则） | 同上 |

真实大包（d01dfbaa，55MB）不入库：本地手工验收流程（导入 → 图 → 下钻 turn）。

## 十、实施切分

| 阶段 | 内容 | 出口标准 |
|------|------|---------|
| **P0** | `lib/run`（model/reader/run-store/import-service）+ import-bundle API + CLI `import-bundle` + 全套 IT | rollback manifest 与 mini-bundle 全量断言绿；183 会话真实包本地导入成功且幂等 |
| **P1** | AppHeader 重构 + `/runs` 列表 + `/run/[runId]` 详情（DAG/代带/回滚边/子图/侧栏） | 交互对齐 HTML 原型；图上节点状态/尝试历史准确 |
| **P2** | Turn 下钻闭环：成员跳转 + RunBadge + 反向返回 | session 页徽标正确；往返导航闭环 |
| **P3** | 打磨与分期端：carried/空占位视觉细化、CLI `runs`/`run`、TUI 评估 | 按需 |

## 十一、风险与开放问题

| 风险 | 缓解 |
|------|------|
| 大包导入时长（分钟级） | job 化 + 进度轮询 + 幂等重入（见五） |
| 同 sid 双记录误 join | session-link 强制 framework 谓词消歧（4.4） |
| manifest 无正文成员（设计样例即如此） | 视图容忍渲染"正文缺失"；验收用真实包覆盖 turn 路径 |
| job 注册表随重启丢失 | manifest 落盘先行 + 会话导入幂等 = 重发起即续传 |
| schema v2 演进 | 信封冻结 + 版本分发转换器（4.1） |

**开放问题**（后续评审拍板）：
1. run 删除时是否提供"连带删除导入会话"的显式选项（P0 明确不做，防误删独立资产）；
2. 未来 lake 分享时 manifest 随仓分发的格式定位（本期非目标）；
3. TUI 的 run 视图形态（P3 评估）。
