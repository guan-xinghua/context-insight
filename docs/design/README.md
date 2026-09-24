# 需求清单（CANNBot-Insight 设计文档索引）

本目录收录 CANNBot-Insight 的所有需求与设计。**一个需求一个子目录**，内部按需组织：

- `requirements.md` — 需求（原 `docs/requirements/req-XXX` 与根级需求文档并入）
- `design.md` — 设计方案
- `review-decisions.md` / `test-plan.md` — 评审决策 / 测试计划（可选）
- 复杂需求可用 `phase1-requirements-analysis.md` / `phase2-requirements-design.md` / `phase3-development-plan.md` 三阶段命名

> 说明：子目录里的设计文档**只描述设计意图，不记录实现进度**。实现进度记录在根目录 `CHANGELOG.md`；「是否实现」这类执行状态统一在本清单跟踪。

## 清单

| 需求名称 | 目录 | 需求描述 | 类型 | 创建时间 | 是否实现 |
|-|-|-|-|-|-|
| Claude JSONL 适配器 | [claude-jsonl-adapter](claude-jsonl-adapter/) | 解析 Claude Code session JSONL 并导入（原 REQ-001） | Feature | 2026-06-18 | ✅ 已实现（`src/lib/ingest/adapters/claude-jsonl.ts`） |
| Session 对比 | [session-compare](session-compare/) | 首页选两个 session 并排对比 token/费用/耗时/工具/子 agent（原 REQ-002） | Feature | 2026-06-18 | ✅ 已实现（`src/app/compare/`） |
| 实时监控 | [realtime-monitoring](realtime-monitoring/) | 实时监听 session 变化并查看 turn 流（原 REQ-003） | Feature | 2026-06-18 | 🟡 实现中——方案变更：opencode 走 5s 轮询、claude 走 SSE（`auto-refresh` / `auto-refresh-stream`），未按原设计的 WebSocket 落地 |
| 成本异常检测 | [cost-anomaly-detection](cost-anomaly-detection/) | 检测 token 异常飙升的 turn，标记高亮并归因（原 REQ-004） | Feature | 2026-06-18 | ⬜ 未实现（仅有设计） |
| CLI 前端 | [cli-frontend](cli-frontend/) | CLI/TUI 前端（Commander + Ink 7 + React 19，ESM strict） | Feature | 2026-06-18 | ✅ 已实现（`src/cli/`） |
| Context Tracker | [context-tracker](context-tracker/) | context 窗口用量追踪与可视化 | Feature | 2026-06-18 | ✅ 已实现（`src/components/observe/ContextTracker.tsx`） |
| Session 对话级洞察 | [session-turn-insight](session-turn-insight/) | turn/skill/subagent 级可观测 + 主子 agent 交互桥 | Feature | 2026-06-18 | ✅ 已实现——Tab 布局有演进：turn 观测并入 Turns tab、交互桥并入 Trace tab |
| Workflow AI 提取 | [workflow-ai](workflow-ai/) | LLM 提取 session workflow | Feature | 2026-06-18 | ✅ 已实现（`src/lib/llm-workflow-extract.ts` + `/api/observe/session/llm-workflow-extract`） |
| Workflow 树视图 | [workflow-tree-view](workflow-tree-view/) | workflow phase/step/checkpoint 树形展示 | Feature | 2026-06-18 | 🟡 实现中——数据层（`phase-split.ts`）与 TUI（`WorkflowTab`/`TreeView`）已实现，Web session 页未实现 |
| Timeline 并入 Workflow | [merge-timeline-into-workflow](merge-timeline-into-workflow/) | 合并 Timeline tab 到 Workflow tab，减少 Tab 数 | Refactor | 2026-06-18 | ✅ 已实现——Timeline tab 已移除；后续流程图演进并入 Audit tab |
| Performance Tab | [performance-tab](performance-tab/) | 耗时性能 + token 成本分析（不依赖 LLM 审计输出） | Feature | 2026-07-24 | ✅ 已实现（`src/components/observe/PerfPanorama.tsx`） |
| Audit Skill 子 Tab | [audit-skill-subtab](audit-skill-subtab/) | skill/agent 对账子 tab（取代已废弃的 sift-audit 独立 tab 方案） | Feature | 2026-07-29 | ✅ 已实现——落在 Audit 主 tab（`AuditBoardTab.tsx`）而非 Skills tab |
| Audit v4 审计流程 | [audit-v4-flow](audit-v4-flow/) | agent 中心三维度审计（功能完成/开发效率/开发质量），独立于 v1-v3 | Feature | 2026-07-30 | ✅ 已实现 |
| Session 轨迹分析器 | [session-trajectory-analyzer](session-trajectory-analyzer/) | 轨迹 MD → 分析 JSON，自建轻量 agent，不依赖 Claude Code | Feature | 2026-07-13 | ✅ 已实现（落在 `smart-agent/trajectory_analyzer.py`，为设计超集） |
| 导入批量写优化 | [import-batch-write](import-batch-write/) | 导入写入从逐条 create 改为批量 createMany + $transaction | Perf | 2026-06-18 | ✅ 已实现（`batchCreateMany`，500 行/批） |
| claude-jsonl 适配 proxy 格式 | [claude-jsonl-proxy-adaptation](claude-jsonl-proxy-adaptation/) | proxy 扩展字段按 OCP 文件隔离重构，核心管线不感知 | Refactor | 2026-08-14 | ✅ 已实现（`claude-jsonl-full-context.ts` 扩展层，红线见 AGENTS.md） |
| CANNBay v2 | [cannbay-v2](cannbay-v2/) | 数据集仓 + proxy jsonl 上传/partial clone/数据治理 | Feature | 2026-08-19 | ✅ 已实现（`src/lib/cannbay2/`） |
| 组合声明提取插件 + LLM 泛化 | [workflow-extract-plugin](workflow-extract-plugin/) | 主 agent 组合声明确定性提取插件化（cann-ops 默认）+ llm-root 选择式泛化路径（正文取 DB 原文，与确定性共享装配） | Feature | 2026-08-28 | ✅ 已实现（`src/lib/workflow-extract-config.ts` + `src/lib/llm-workflow-extract.ts`） |
| Session 轨迹评分 v2（六维评价体系） | [workflow-scoring](workflow-scoring/) | 评分卡从三组指标（deterministic/semantic/efficiency）重组为六维结果导向体系：D1 完成度（否决）、D2 行为可信、D3 质量、D4 效率、D5 冗余度、D6 自主性（加权）+ D7 用户自定义维度（可选）；单会话基线比值、subagent 重派检测、评审 CoT 契约与 judge-log 可观测 | Refactor | 2026-08-29 | ✅ 已实现（持续演进至 v2.20；v1 日落至 src/lib/scoring-sunset/） |

## 字段口径

- **创建时间**：取该需求需求/设计文档的起草日期（git 首次提交日期）。
- **是否实现**取值：
  - ⬜ **未实现** —— 仅有设计，代码未动
  - 🟡 **实现中** —— 部分落地（含方案变更后按新方案部分落地）
  - ✅ **已实现** —— 全部落地并通过验收（后附落地位置；与设计有偏差的在备注说明）

## 新增需求时的约定

1. 在本目录下新建一个**短横线命名（kebab-case 英文）**的子目录（如 `xxx-yyy`）。
2. 子目录内放 `requirements.md` / `design.md` 等（见开头说明）。
3. **回到本清单追加一行**，填齐上表各列。
4. 状态变化（⬜→🟡→✅）时回本清单更新；落地位置/偏差备注一并写。

## 归档

停更日志、一次性调研、被取代的设计快照不放本目录，统一移入 `docs/archive/`（见 [archive/README.md](../archive/README.md)）。
