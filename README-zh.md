# CANNBot-Insight

LLM 编码 Agent 的 Session 级可观测工具：导入 agent 会话日志，逐轮分析 token、上下文、子代理与技能使用。

**[English Documentation](README.md)**

## 功能介绍

导入 SQLite（opencode.db）或 JSONL（Claude 原生 / cpx proxy 捕获，明文与 `.jsonl.gz` 均可，`cpx-` 前缀自动处理），进入 session 详情页的多个分析 Tab：

- **Token 与费用** — 每轮 token 五项拆解，按模型上下文窗口显示占比，估算费用
- **上下文增长** — 逐 subagent 的上下文增长曲线与动画回放，`/compact` 压缩点标注
- **上下文治理** — 查看每轮 LLM 输入构成：可见消息 + 稳定 System 开销
- **Subagent 追踪** — 识别子代理会话与 dispatch→response 链路，时间线内联展示
- **Turn 快速跳转** — Turns 时间线输入 `#459` 回车直达该轮
- **Wire 轮次**（proxy 捕获）— 逐轮重组完整 wire 输入/输出，与 DB 重建对照；`-a` 启动显示
- **Skill 事件 / 覆盖度 / 全文** — 每轮 skill 事件、可用 skills 全集对照使用情况、SKILL.md 全文重建
- **Agent 定义恢复** — 子代理 `.md` 定义一键取全文：会话内 system 注入优先，磁盘扫描兜底
- **概念追踪** — 跨轮关键词搜索、传播链路与 DAG 图，结果可按来源/thinking/工具过滤
- **文件读取分析 / 内容复卷 / 重编汇册** — 重复读取检测、单文件逐行重建、整目录重建打包下载
- **Session 对比** — 两会话的 token / 费用 / 耗时 / 工具 / 子代理对比
- **轨迹评分** — 六维评分卡（完成度否决维 / 行为可信 / 质量 / 效率 / 冗余 / 自主性 + 自定义维度），支持基线对比与评分配置 profile
- **Audit** — Workflow 审计（流程框图 + 节点问题 + 优化优先级）与 Skill 审计（真实执行 vs SKILL.md / agent 定义 / workflow 声明对账）
- **密钥脱敏**（proxy 捕获）— API key 永不落盘：落盘咽喉统一打码（`前4…后4`）

主页 Sessions 列表支持关键词 / sessionID 搜索；导入对话框提供常用路径一键直达。

## 安装与使用

### 方式零：npm 一键安装（推荐）

```bash
npm install -g cannbot-insight
cannbot-insight            # 首次：自动 build + migrate（约 30s-2min），随后启动 + 开浏览器
```

- 需 Node.js >= 20；国内网络可加 `--registry=https://registry.npmmirror.com`
- 离线环境可用 tgz：`npm install -g ./cannbot-insight-<版本>.tgz`
- 可写状态集中在 `~/.cannbot-insight/`；默认端口 21025（占用自动顺延）
- CLI 子命令直接透传：`cannbot-insight upload --file … --list` / `sessions` / `--help`
- Python 3 可选（存在则启动 smart-agent 分析后端，缺失静默降级）

| 标志 | 作用 |
|------|------|
| `-a`, `--advanced` | 显示高级 tab（wireRounds/replay） |
| `-k`, `--kill` | 杀掉占用 21025 端口的进程并复用 |
| `-f`, `--fresh` | 清空构建缓存重建 |

### 方式一：源码运行 Web UI

```bash
./start.sh              # 生产模式（默认）：构建缓存复用 + 请求零编译
./start.sh -u           # 更新依赖后启动
./start.sh -f           # 强制重新构建
./start.sh -d           # dev 模式（改源码热重载时用）
```

- 需 Node.js >= 20；`./start.sh` 同时安装 cpx 捕获命令（详见 `../cpx/README.md`）
- 浏览器打开 `http://localhost:21025`

日志文件位置：
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/`（目录自动扫描）

Web UI 还支持：导出 session 为独立 SQLite 或 Markdown；上传 CANNBay 数据集仓（范式目录 + 算子生成结果标注 + 可选 baseline，上传前强制密钥治理）；从 CANNBay 列表按需导入。数据湖远端、认证与分支可在设置页配置（凭据仅存浏览器 localStorage）。LLM 接入面板内置常见提供商 Base URL 速查。

### 方式二：CLI 上传 + Web 分析

适用于 SSH 远程等无浏览器环境（首次需 `npm install` + `npx prisma migrate deploy`，之后上传命令自动拉起后端）：

```bash
# opencode：列出 / 指定上传 / 交互选择
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --list
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --session-id <id> --description "描述" --yes --json

# Claude Code：目录扫描 / 单文件
npx tsx src/cli/index.ts upload --file ~/.claude/projects/ --list
npx tsx src/cli/index.ts upload --file ~/.claude/projects/<hash>/<uuid>.jsonl --session-id <uuid> --yes --json
```

| 参数 | 说明 |
|------|------|
| `--file <path>` | 源路径（.db / .jsonl / 目录，类型自动推断） |
| `--session-id <id>` | 指定 session（跳过交互） |
| `--description <text>` | 提交描述 |
| `--yes` / `--json` | 跳过确认 / JSON 输出（脚本友好） |
| `--list` | 仅列出可选 session |

上传后在 Web UI 点击 **CANNBay** 按钮选范式目录导入，无需手动 clone。
