# Run 观测（workflow-bundle 导入与展示）— 需求

> 输入格式契约：`workflow-bundle-format.md`（草案 v1，schema `cannbot.workflow-bundle`，
> 由 Opsbot 侧定义；Opsbot 导出器暂不在本期范围）。
> 背景：Opsbot graph 运行（run）在执行侧有完整历史（多代回滚/逐次尝试/执行与验收
> 会话），Insight 有完整的会话级 turn 观测——两层之间没有通道。本需求补齐 Insight
> 侧：导入 workflow-bundle 包，做 run 级观测 + turn 维度下钻。

## 1. 问题陈述

一次 graph 运行由数十个成员会话/进程组成（真实样例 op-develop：183 会话 + 5 进程，
3 个动态子图）。当前 Insight 里这些会话是互不关联的孤岛：

- 看不到"哪个节点失败 → 如何回滚 → 重跑的会话是哪几个"的运行结构；
- 单会话详情页不知道自己属于哪个 run / 节点 / 代 / 尝试 / 角色；
- bash 节点与 script 验收（无会话）的输出完全没有观测面。

## 2. 目标

| # | 目标 | 验收口径 |
|---|------|---------|
| G1 | 导入 workflow-bundle：manifest 校验落盘 + 会话全量立即导入 | 导入幂等可重入；`exportDataComplete=false`、缺正文成员、未引用会话目录均为容忍态 |
| G2 | Runs 一级入口 + Run 列表 | 与 Sessions 并列的导航入口，列出 run 名/状态/规模/导入时间 |
| G3 | Run 详情：多代 DAG 视图 + 节点运行历史 | 对齐交互原型（代带分栏、回滚红虚线、子图视图、carried/空占位语义、逐次尝试历史） |
| G4 | Turn 维度下钻闭环 | 成员会话 → 现有 session 详情页（全量 tab 复用）；session 页显示 run 归属徽标并可返回 |
| G5 | 三前端架构不破 | 全部能力经 `/api/observe/*`·`/api/ingest/*` 提供；Web 先行，CLI/TUI 分期 |

## 3. 非目标（本期不做）

- Opsbot 侧 bundle 导出器（上游仓职责）
- run / manifest 的 lake（CANNBay）分享与多人分发
- Prisma schema 变更（run 结构不落库，见设计的零 schema 原则）
- TUI/CLI 的 run 观测界面（仅预留 API，分期实现）

## 4. 关键决策（已拍板）

| 决策点 | 结论 |
|--------|------|
| Runs 入口形态 | 首页一级导航入口（与 Sessions 并列的域概念） |
| 会话导入时机 | 导入 bundle 时立即全量导入（不做懒导入） |
| lake 分享 | 暂不涉及 |

## 5. 输入材料

| 材料 | 角色 |
|------|------|
| `graph-demo-rollback-manifest.json` | 结构样例：76 成员/82 关系/3 代/2 回滚/1 子图（无会话正文）——reader/view-model 的结构测试基准 |
| `d01dfbaa-bundle/`（op-develop） | 真实样例：183 会话（insight 导出件格式）+ manifest（仅 gen=0）——导入链路与 turn 下钻的验收数据（本地手工验收，不入 CI） |
| `graph-demo-export-preview.html` | 交互原型：多代 DAG + 运行历史侧栏——展示层交互参照 |
