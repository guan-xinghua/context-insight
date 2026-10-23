# AGENTS.md — context-insight

> 与 `CLAUDE.md` 同步维护：主体内容对齐，本文件额外保留 CLI 前端细节与 proxy 侧红线。
> 改动任一文件时同步另一份。

## Project

Context-Insight: Session-level observability tool for LLM coding agents (opencode).
Next.js 16 App Router + Prisma 6 + SQLite. Chinese/English mixed UI.
UI version tracked in `src/lib/version.ts` — `package.json` version stays in sync (same value, for npm publish); the display source of truth is `src/lib/version.ts`.

## Commands

| Command | Purpose |
|---------|---------|
| `./start.sh` | **Production mode (default)**: auto port (21025+), kills existing server, `next build` (cached via `.next/BUILD_ID`; auto-rebuilds when sources changed) + `next start` — zero per-request compile |
| `./start.sh -u` | Same but also `npm install` first |
| `./start.sh -d` | Dev mode (`next dev`): hot reload while editing insight source; first request per route compiles on demand |
| `./start.sh -c tui` | Backend + CLI TUI mode (backend stops when CLI exits) |
| `../cpx/install.sh` | Standalone cpx installer (also invoked by `./start.sh`); capture works without insight, `cpx list` browses captures; import is insight's own job (UI / auto-import at capture exit) |
| `npm run test` | `vitest run` — all tests |
| `npm run test:watch` | `vitest` — watch mode |
| `npm run test:cli` | `vitest run tests/cli/` — CLI tests only |
| `npx vitest run tests/cli/unit/commands/import.test.ts` | Run a single test file |
| `npm run lint` | eslint (flat config, `eslint.config.mjs`) |
| `npm run build` | `next build` |

## Architecture

### Data Flow

```
opencode opencode.db (external)
  → better-sqlite3 read
  → opencode-db adapter (src/lib/ingest/adapters/)
  → normalize → turn-split → bridge-builder → execution-split
  → data-service (orchestrator)
  → Prisma write (8 models, SQLite)
```

Adapter registry in `src/lib/ingest/adapters/registry.ts`（agent-source-framework，设计见 `docs/design/agent-source-framework/design.md`）— `SourceDescriptor` 单点声明身份（sourceType ↔ framework 映射）、解析、可选能力（子代理发现/版本提取/文件嗅探/内容探测/sessionId 推导）；目前注册 `context-insight` / `opencode-db` / `codex-jsonl` / `claude-jsonl` 四源，并按文件形态声明源族（`SOURCE_FAMILIES`：jsonl / sqlite，伞形 sourceType 是 API 一等值，`resolveSource` 单点探测解析）。新框架接入 = 适配器模块 + registry 一行（jsonl 系自动入族）+ import-ui quickDir 一条（可选），data-service/API 路由/normalize 零改动。

### Frontend Modes (shared backend)

All three modes are pure API clients of the same 22 `/api/observe/*` endpoints:

| Mode | Entry | Rendering |
|------|-------|-----------|
| **Web UI** | `src/app/page.tsx` (server component, direct Prisma) | Next.js + shadcn/ui v4 + Tailwind v4 + @base-ui/react |
| **TUI** | `src/cli/tui/App.tsx` | Ink 7 + React 19 (ESM strict) |
| **CLI** | `src/cli/index.ts` (Commander) | chalk + string-width + cli-truncate |

Session detail page (`session/[taskId]/`) is `"use client"` with 10 tabs
（`wireRounds`/`replay` 默认隐藏，URL `?a` 或 `NEXT_PUBLIC_SHOW_ADVANCED_TABS` 展开）fetching from `/api/observe/*`.

### Key Code Paths

- **Ingest write**: `src/lib/ingest/data-service.ts` → `importSession()` — batched `createMany` (500 rows/batch) inside `$transaction` via `batchCreateMany()` (see `docs/design/import-batch-write/design.md`)
- **Ingest read**: `src/lib/ingest/adapters/opencode-db.ts` — N+1 query pattern (per-session/per-message sub-queries to `part` table)
- **Context windows**: `src/lib/context-window-config.ts` — configurable via `context-windows.json`, hardcoded defaults as fallback. Web `ContextTracker.tsx` has its own model mapping — keep in sync.
- **AI analysis**: `src/lib/ai/analyzer.ts` — only OpenAI-compatible `/chat/completions`, config in localStorage only
- **CLI client**: `src/cli/client.ts` — InsightClient with 17 methods across `/api/observe/*`, `/api/ingest/*`, `/api/ai/*`
- **CLI types**: `src/cli/types.ts` — `Api`-prefixed interfaces to distinguish from `src/lib/shared/types.ts`
- **Lake v2（数据湖引擎）**: `src/lib/lake`（mirror 治理/导出/编排）— 设计见 `docs/design/lake-v2/design.md`

### CLI Frontend

```
src/cli/
├── index.ts              # Commander entry point
├── client.ts             # API client (17 methods)
├── types.ts              # Api-prefixed response types
├── errors.ts             # Error hierarchy
├── config.ts             # Config management
├── commands/             # sessions, session, turn, search, compare, stats,
│                         # import, delete, config, analyze, upload, export, export-md
├── hooks/                # useApi, useKeyboard, useNavigation, useTable
├── utils/                # format, colors, table (with padEndVisual/truncateVisual)
└── tui/
    ├── App.tsx           # Root component (stdin switching, useMemo client)
    ├── screens/          # SessionList, SessionDetail, TurnDetail, CompareView, ImportPanel, HelpScreen
    ├── tabs/             # Overview, Turns, Workflow, Trace, Skills, Bridges, Context
    └── components/       # StatusBar, KeyBar, DataTable, MetricCards, AsciiBar, TreeView, TabBar, Spinner, TextInput
```

CLI 约束（PoC 验证过的决策）：
- **Ink v7 原生 `render()` 无 lastFrame/frames/output** — 测试只能用 ink-testing-library
- **无第三方 Ink 组件** — ink-table/ink-select/ink-spinner 与 v7 不兼容，全部自实现
- **分页优先于虚拟滚动** — pageSize=20, n/p 键
- **CJK 宽度** — 一切文本测量用 `string-width`
- **CLI 类型 `Api` 前缀** — 与 shared types 区分
- **版本号** — 从 `@/lib/version` 导入，禁止硬编码

### Proxy 扩展：开闭原则（OCP）与文件隔离

proxy（cpx 捕获）是 insight 的扩展来源，不是核心管线的一部分。所有 proxy
特有的数据和行为必须**文件隔离**——放在独立的扩展层模块里，在 API/显示层
按需读取，**不注入核心管线**。

**参照模式**：`src/lib/ingest/adapters/claude-jsonl-full-context.ts`
- 它读 proxy 扩展字段（`system`/`tools`/`memory`/`skills`），在 turns API 层
  调用，核心管线（`readSession` → `normalize` → `turn-split` → `data-service`）
  完全不感知。
- proxy 以后加新扩展字段（`metadata`/`cache`/`retry`/`dedup` 标记…）在同一
  扩展层文件内加，核心不动。

**格式契约**：捕获/导出 jsonl 的扩展字段格式一律参考 `docs/lake-schema-spec.md`
（信封冻结 + `x_lake` 命名空间 + `(schema,version)` 声明式分发；加可选字段
不升版本，改语义/类型必升版本并配 IT 锁）。新增或修改任何扩展字段前先读它；
规范落地前的现状（legacy 顶层字段 `source`/`duration_ms`/`system`/`tools`）与
双轨优先级见该文档 §6。

**红线（不得违反）**：

| 模块 | 能否为 proxy 改动？ |
|----------|-------------------|
| `src/lib/shared/types.ts` (`RawInteraction` 等) | ❌ 不加 proxy 专用字段 |
| `src/lib/ingest/normalize.ts` | ❌ 不透传 proxy 数据 |
| `src/lib/ingest/turn-split.ts` | ❌ 不读 proxy 扩展字段 |
| `src/lib/ingest/data-service.ts` | ⚠️ 只允许 proxy 专用的 guard（如 reshape 检测），不透传数据 |
| `src/lib/ingest/adapters/claude-jsonl.ts` | ✅ 入口分流（`classifyProxyCapture` 统一分类），行级只读标准语义字段（`source`/`stopReason`/`duration_ms`/`x_lake` core），不内联 proxy 逻辑；注入分类单点调 `injections/` 分发（cpx 把异框架捕获归一成 claude 布局，本适配器是通用格式入口，不持有异框架指纹） |
| `src/lib/ingest/adapters/injections/` | ✅ 框架注入分类层（纯函数，无 fs）：指纹规则框架自持（`claude-code.ts`/`codex.ts`/`opencode.ts` 家族），`index.ts` 按行级 `source` 标记 → `agentFrameworkOf` 分发；新框架 = 新指纹模块 + 分发表一行（设计见 agent-source-framework §2.5b） |
| `src/lib/ingest/adapters/system-structure/` | ✅ 系统提示结构层（读侧对偶 injections/，纯函数无 fs）：memory/skills 结构段与结构化解析框架自持（`claude-code.ts`/`codex.ts`/`opencode.ts` 家族），`index.ts` 按行级 `source` 标记分发；消费侧 `readFullContext`/`readAvailableSkills` 零框架分支，禁止格式试探序嗅探（设计见 agent-source-framework §2.5c） |
| `src/lib/ingest/proxy-classify.ts` | ✅ proxy 统一分类器（meta > 行级 `source` 标记 > wire 指纹），只产出 Session.framework/version 元数据 |
| `src/lib/ingest/adapters/claude-jsonl-full-context.ts` | ✅ proxy 扩展层（system/tools/memory/skills + requestParams + 可用 skills 全集） |
| `src/app/api/observe/session/wire-rounds/route.ts` | ✅ wire 轮次 API 直接解析捕获 jsonl（roundIndex 以 `x_lake.data.roundIndex` 为权威） |
| `src/app/api/observe/session/turns/[turnId]/route.ts` | ✅ API 层调扩展层读 proxy 数据（像 `readFullContext`） |

**proxy 侧红线**（proxy 仓内部，与上表互补）：

| 模块 | 能否改动？ |
|------|-------------------|
| proxy 捕获层（server/emitters/writer） | ❌ 不感知 insight —— 只写 verbatim |
| proxy `normalize/` | ❌ 只做布局归一 —— 内容解释（框架行为）一律去 insight adapter |
| norm 文件格式 | ⚠️ 必须保持 insight 原生 claude-jsonl 可消费（含扩展字段透传） |

产物布局（gzip at rest：live 明文追加、退出压缩、resume 解压回明文；insight
**直读 verbatim 导入与长期 serving**——`.jsonl.gz` 透明解压、`cpx-` 前缀自动剥、
子代理按 `<parentDir>/<sid>/subagents/` 发现。norm/ 镜像层已退役：与 verbatim
逐行相同的冗余副本，退出路径不再自动生成，存量不迁移不删除，`cpx normalize`
降级为兼容命令）：

```
~/.context-insight/proxy/
├── cpx-<sid>.jsonl(.gz)          verbatim 捕获（single source of truth）—— insight 导入这个
├── cpx-<sid>.meta.json           cc-session-meta（明文契约，含 governed 标记）
├── <sid>/subagents/              verbatim 子代理捕获 + meta.json
└── norm/                         （退役，仅 cpx normalize 手动生成）
```

**判定标准**（两侧通用）：如果改动让 native（非 proxy）的 `RawInteraction` /
`NormalizedInteraction` / `TurnRow` 的字段值发生变化（哪怕是 `?? null`），
就违反了 OCP。native 路径必须**逐字节不变**——靠架构隔离保证，不靠约定+测试。
一个问题是"框架怎么行为的解释" → insight adapter；是"导入视图怎么摆" → proxy normalize。

## Constraints & Gotchas

- **lake 镜像的 git 命令必须走 `runGit`**（mirror.ts）：其 per-command 配置中和 lfs filter（`filter.lfs.process= / smudge=cat / clean=cat / required=false`）+ `push --no-verify`。数据仓 `.gitattributes` 历史上带 `*.gz filter=lfs`，装 git-lfs 的客户机会在 checkout（孤儿指针 smudge 403）与 add（clean 指针化）两条路上炸；绕过 runGit 直拼 git 命令会重新暴露（IT：`tests/lake-lfs-immunity.test.ts`）
- **framework 值域（方案一：同 sid 双会话）**：proxy 捕获行 = agent 框架 + `-proxy` 后缀（`claude-code-proxy` / `opencode-proxy` / `codex-proxy` / `cannbot-proxy`），与同 sid 原生会话共存两行。**判断一律走谓词，禁止对 framework 裸等值**：格式判断用 `isClaudeFormatSession`（放行 `-proxy` 变体）、agent 归属用 `agentFrameworkOf`（剥后缀）、proxy 与否用 `isProxyVersion(version)`；按 taskId 解析会话的 API 必须接受 `framework` 消歧参数（同 sid 可能两行）
- **lake 仓布局（同 sid 双记录）**：不变量是「sid × 记录类 全仓唯一」——wire 捕获占裸 `<sid>/`，原生 claude 会话占 `<sid>.native/`（目录内文件用真实 sid 命名）。目录名推导/还原一律走 `sessionFolderOf` / `parseSessionFolder`（mirror.ts），不要手拼 `.native` 后缀；按 sid 定位仓内会话的代码必须带记录类维度（`locateSessionLocations` / `materializeSession` / `uploadFolder` 的 recording 参数，缺省 capture 兼容存量）
- **双名发布（cannbot 品牌变体）**：`node scripts/pack-cannbot.mjs` 产出 `cannbot-insight` 同内容变体 tgz（staging 精确字面量替换 + 每规则 minHits 哨兵，源码仓零改动）。新增/改动品牌字面量（显示名 `Context-Insight`、CLI 别名 `ctxi`、bin 文件名、数据目录 `~/.context-insight`）时必须同步 `scripts/pack-cannbot.mjs` 规则表与 `tests/cannbot-pack.test.ts` 泄漏哨兵；格式契约（`BRAND_SOURCE_TYPE` / `x_lake` / `LAKE_*`·`CONTEXT_*` env 名 / `context-smart-agent` 服务标识 / lake 机器提交身份）**不得品牌化**——两品牌数据互通靠它们
- **ESM strict** (`"type": "module"` in package.json) — no `require()`, use `import`
- **Ink v7 has no lastFrame/frames/output** on native `render()` — use `ink-testing-library` for tests only
- **No third-party Ink components** — ink-table/ink-select/ink-spinner incompatible with Ink v7; self-implement all components
- **CJK width**: Chinese chars = 2 columns; use `string-width` for all text measurement in CLI
- **Zero Prisma schema changes** for feature work — computed data built at API/render time, not persisted
- **Turn model has no `cost` field** — set `cost: 0` in API mapping, strip from `TurnRow` before Prisma write
- **`createdAt_ts` is nullable DateTime** — fallback to `createdAt` with `.toISOString()`
- **Hydration error**: inner expand buttons must be `<span role="button">` not `<button>` to avoid nesting
- **`response_format: { type: "json_object" }`** required for AI analysis — no fallback
- **AI input optimization**: Only root assistant/user/system turns, 30K chars budget, summaries 80 chars max
- **Git hosted on gitcode.com** — never use `gh` CLI
- **Path alias**: Always `@/lib/...` / `@/components/...`, never relative `../../`

## Testing

- **Test DB isolation**: 测试一律写独立 `prisma/test.db`（`tests/setup.ts` 默认 + pretest 每次重建）——禁止任何测试直连真实 `prisma/dev.db`（常驻 server 的生产库）；回归锁 `tests/ut/test-db-isolation.test.ts`
- **Integration over unit**: 写测试用例时，不要简单的函数级别用例，需要从页面或 API 层面进行验证
- **Data-driven**: 通过 JSON 或 DB 原始数据驱动测试，数据准备在 `tests/data/` 目录下
- **Pipeline coverage**: 测试应覆盖完整数据流（如 JSONL → adapter → turn-split → SkillEvent → aggregates）
- **功能修复必须写 IT 测试**: 每个 bug 修复或功能改进必须配套集成测试，验证修复后的完整数据流表现

## Commit Workflow

每次提交代码前必须完成以下步骤（顺序执行）：

1. **同步远端**: `git pull` — 远端可能有更新
2. **解决冲突**: 如有冲突，手动解决后继续
3. **运行测试**: `npm run test` — 全部通过才能继续
4. **更新文档**: README.md / README-zh.md（如有功能变更）
5. **版本号（PR 粒度）**: 提交本身不升版本；每次合 PR 前统一升一次（+0.0.1），**只升本 PR 实际改动的包**——PR 触达 `packages/insight` 才升 insight（`src/lib/version.ts` 与 `package.json` version 同步改，单轨同值），触达 `packages/cpx` 才升 cpx（`src/version.ts` 与 `package.json` 同步改），未触达的包不动；CHANGELOG 的 Unreleased 段落定版号
6. **提交推送**: `git commit -m "[type] v0.xx: 描述"` → `[feat]` `[fix]` `[test]` `[docs]` `[chore]`

## Code Conventions

- **License header**: Every newly added source file (`*.ts`/`*.tsx`/`*.js`/`*.mjs`/`*.py`/`*.sh`) must start with the CANN copyright header. Use `//` for TS/JS, `#` for Python/shell. Verbatim text (adapt comment prefix):
  ```
  Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
  This program is free software: you can redistribute it and/or modify it under the terms of
  CANN Open Software License Agreement Version 2.0 (the "License").
  Please refer to the License for details. You may not use this file except in compliance with the License.
  THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
  INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
  See LICENSE in the root of the software repository for the full text of the License.
  ```
  See `start.sh` or any `src/app/api/**/route.ts` for the canonical copy. This is the one exception to "no comments".
- **Comments**: Don't write them unless asked
- **Doc files**: Don't create `.md` / README unless explicitly requested
- **README sync**: When features change, update both `README.md` and `README-zh.md` feature lists and tab descriptions
- **Version bumps**: PR-granularity — bump once per merged PR (+0.0.1), **only the packages this PR actually touched** — insight only when `packages/insight` changed (`src/lib/version.ts` + `package.json` together, single-track), cpx only when `packages/cpx` changed (`src/version.ts` + `package.json`); untouched packages stay; individual commits don't bump
- **CHANGELOG 简洁**: 条目一两句说清「什么变了、用户可感知什么」——不写实现细节（函数名/内部机制/IT 清单，那些放 PR 描述或 docs/design）；只有功能性变化才写，小加固/杂项不单开条目
- **Badge variants**: default, secondary, destructive, outline, blue, green, orange, purple, gray, red, yellow, slate
- **UI primitives**: All from `@base-ui/react` (not radix-ui) via shadcn v4 + Tailwind v4
- **Charts**: Pure SVG, no chart libraries — match TraceView DAG style
- **Dialogs**: Use `src/components/ui/dialog.tsx` (built on @base-ui/react), never browser `confirm()`
- **Search history**: sessionStorage only, never persisted
