# 历史归档

只读归档区，收录**不再维护**的历史文档。文件保留原貌，仅顶部加归档标注。

## 归档清单

| 文档 | 原路径 | 归档原因 |
|------|--------|----------|
| [dev-log.md](dev-log.md) | `docs/dev-log.md` | 开发日志，停在 v0.35（2026-06-15）；进度跟踪已由根目录 `CHANGELOG.md` 接管 |
| [report.md](report.md) | `docs/report.md` | 早期 Step 计划进展报告，停在 2026-06-13 |
| [tui-framework-comparison.md](tui-framework-comparison.md) | `docs/tui-framework-comparison.md` | TUI 框架一次性选型调研，结论已沉淀到 [design/cli-frontend](../design/cli-frontend/) |
| [cli-frontend-design-complete.md](cli-frontend-design-complete.md) | `docs/cli-frontend-design-complete.md` | 「设计+实现」合并快照，与 design/cli-frontend/ 高度重复且评审决策表过期；权威版本为 [design/cli-frontend/design.md](../design/cli-frontend/design.md) |

## 归档规则

- 停更的过程日志、一次性调研、被取代的设计快照进本目录
- 归档文档不再更新；如内容需要修订，回到活文档位置（`docs/` 根级或 `design/`）新写
- 移动一律用 `git mv` 保留历史，并在本清单登记
