# CANNBot-Insight 文档地图

> 本文件是 `docs/` 的总索引。找文档先看这里。

## 目录结构

| 分类 | 位置 | 内容 |
|------|------|------|
| **用户指南** | `docs/*.md`（根级） | 安装使用、环境搭建、CLI 命令参考 |
| **架构与规范** | `docs/architecture.md`、`docs/cannbay-schema-spec.md` | 持续维护的活文档 |
| **需求与设计** | `docs/design/` | 一个需求一个子目录；状态在 [design/README.md](design/README.md) 清单跟踪 |
| **历史归档** | `docs/archive/` | 停更日志、一次性调研、被取代的快照，只读；见 [archive/README.md](archive/README.md) |

## 活文档（docs/ 根级）

| 文档 | 说明 |
|------|------|
| [architecture.md](architecture.md) | 系统架构：数据流 / 三前端共享 API / Prisma 模型 / 关键约束 |
| [cannbay-schema-spec.md](cannbay-schema-spec.md) | `x_cannbay` 捕获/导出格式标准（信封冻结 + 命名空间），新增/修改扩展字段前必读 |
| [install-usage-guide.md](install-usage-guide.md) | 使用手册：cpx 捕获代理 + insight 观测平台 + CANNBay 上传/导入 |
| [multi-user-server.md](multi-user-server.md) | 多人服务器部署（每用户单实例）：端口分配 / SSH 隧道 / 随会话清理 |
| [setup-windows.md](setup-windows.md) | Windows 原生环境搭建指南 |
| [setup-wsl.md](setup-wsl.md) | WSL 环境搭建指南 |
| [cli-commands.md](cli-commands.md) | CLI 命令参考（tui/sessions/session/turn/search/compare/stats/import/delete/config/upload/export） |

## 跟踪约定

- **实现进度**：统一记录在根目录 `CHANGELOG.md`（版本化），设计文档不记录进度
- **实现状态**：`是否实现` 只在 [design/README.md](design/README.md) 清单中跟踪
- **产品功能说明**：根目录 `README.md` / `README-zh.md`（两者同步维护）
- **AI 工具上下文**：根目录 `CLAUDE.md` / `AGENTS.md`（两者同步维护）

## 周边文档（docs/ 之外）

| 位置 | 说明 |
|------|------|
| `proxy/DESIGN.md` 等 | cpx 捕获代理设计（DESIGN / CANNBOT / CODEX / OPENCODE / COMPRESSION） |
| `smart-agent/README.md` | 轨迹分析服务（session-trajectory-analyzer 的落地） |

## 新增文档的约定

1. 新需求/设计 → `design/<feature>/` 子目录，命名 kebab-case 英文（详见 design/README.md）
2. 历史快照、停更日志、被取代的调研 → `archive/`，顶部加归档标注，不再维护
3. 用户指南、架构、规范类活文档 → `docs/` 根级
4. 文件名一律 kebab-case 英文，不使用中文文件名
