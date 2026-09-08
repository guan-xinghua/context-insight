# 开发日志

> ⚠️ **已归档**：停在 v0.35（2026-06-15），后续进度跟踪由根目录 `CHANGELOG.md` 接管，本文不再维护。

## 迭代 1：CLI 地基模块

**日期**: 2026-06-14  
**版本**: v0.32  
**状态**: ✅ 完成

### 完成内容

#### 核心模块
- ✅ `src/cli/client.ts` — API Client 类（15 个端点方法，支持重试和认证）
- ✅ `src/cli/types.ts` — CLI 专用类型定义（Api 前缀，20+ 接口）
- ✅ `src/cli/errors.ts` — 错误类型体系（InsightError/ApiError/NetworkError/TerminalError/ConfigError）
- ✅ `src/cli/config.ts` — 配置管理（命令行 > 环境变量 > 配置文件 > 默认值）
- ✅ `src/cli/index.ts` — Commander 入口（9 个命令注册）
- ✅ `src/cli/utils/format.ts` — 格式化工具（formatTokens/Cost/Duration/Date/Percent/truncate）
- ✅ `src/cli/utils/table.ts` — 表格渲染（renderTable, padEndVisual, truncateVisual, 支持 CJK 宽度）
- ✅ `src/cli/utils/colors.ts` — 颜色主题（深色/浅色/自动）

#### 测试用例
- ✅ `tests/cli/unit/client.test.ts` — 24 个测试（构造函数、API 方法、重试机制）
- ✅ `tests/cli/unit/format.test.ts` — 21 个测试（各种格式化场景）
- ✅ `tests/cli/unit/table.test.ts` — 14 个测试（表格渲染、CJK 宽度）
- ✅ `tests/cli/unit/errors.test.ts` — 14 个测试（错误类型、继承关系）
- ✅ `tests/cli/unit/config.test.ts` — 13 个测试（配置优先级）

#### 依赖安装
- ✅ ink@7.0.6
- ✅ react@19.2.7
- ✅ commander
- ✅ chalk
- ✅ string-width
- ✅ cli-truncate
- ✅ tsx
- ✅ ink-testing-library（开发依赖）

#### 配置更新
- ✅ package.json 添加 `"type": "module"`
- ✅ package.json 添加 scripts: `cli`, `test:cli`
- ✅ package.json 添加 bin: `cannbot-insight`, `cbin`
- ✅ version.ts 更新为 0.32

### 验证结果

#### 测试验证
```bash
npm run test:cli
# 结果：86 个测试全部通过
```

#### CLI 入口验证
```bash
npx tsx src/cli/index.ts --help
# 结果：正常输出帮助信息，显示 9 个命令
```

#### 已实现命令
- ✅ `cannbot-insight --version` — 显示版本号
- ✅ `cannbot-insight --help` — 显示帮助
- ✅ `cannbot-insight tui` — 启动 TUI 模式
- ✅ `cannbot-insight sessions` — 列出 sessions
- ✅ `cannbot-insight session <taskId>` — 显示 session 详情
- ✅ `cannbot-insight stats` — 显示统计
- ✅ `cannbot-insight search <taskId>` — 搜索 turns
- ✅ `cannbot-insight import` — 导入 sessions

### 技术要点

1. **ESM 模式**: 所有代码使用 ES Module（`import`/`export`），因为 Ink 7.0.6 的 yoga-layout 使用 top-level await
2. **类型前缀**: CLI 专用类型使用 `Api` 前缀（如 `ApiSession`），与 shared 类型区分
3. **CJK 宽度**: 使用 string-width 库处理中文等宽字符的显示宽度
4. **错误处理**: 分层错误类型，支持重试机制（5xx 错误自动重试 3 次）
5. **配置优先级**: 命令行参数 > 环境变量 > 配置文件 > 默认值

### 下一步

**迭代 2**: 实现核心命令的完整功能
- sessions 命令的表格输出和过滤
- session 命令的详情展示
- stats 命令的统计信息
- 添加 --json 输出格式

---

## 迭代 2：核心命令实现

**日期**: 2026-06-14  
**版本**: v0.33  
**状态**: ✅ 完成

### 完成内容

#### 核心命令
- ✅ `src/cli/commands/sessions.ts` — sessions 命令（表格输出、--limit/--offset/--user 过滤、--json、总计信息）
- ✅ `src/cli/commands/session.ts` — session 命令（详情显示、token/cost/duration 格式化、agents/skills 子表、--json）
- ✅ `src/cli/commands/stats.ts` — stats 命令（全局/会话统计、平均 tokens/cost、--session/--json）
- ✅ `src/cli/commands/compare.ts` — compare 命令（并行获取两 session、对比表格、13 项指标、--json）
- ✅ `src/cli/commands/search.ts` — search 命令（搜索结果表格、--keyword/--limit/--json、结果计数）

#### 命令行入口更新
- ✅ `src/cli/index.ts` — 重构为使用 commands/ 模块，移除内联 stub

#### 测试用例
- ✅ `tests/cli/unit/commands/sessions.test.ts` — 6 个测试
- ✅ `tests/cli/unit/commands/session.test.ts` — 7 个测试
- ✅ `tests/cli/unit/commands/stats.test.ts` — 7 个测试
- ✅ `tests/cli/unit/commands/compare.test.ts` — 6 个测试
- ✅ `tests/cli/unit/commands/search.test.ts` — 7 个测试

### 验证结果

#### 测试验证
```bash
npm run test:cli
# 结果：119 个测试全部通过（原有 86 + 新增 33）
```

#### 命令验证
```bash
npx tsx src/cli/index.ts --help
# 结果：显示 sessions, session, stats, compare, search 等命令
```

### 技术要点

1. **命令模块化**: 每个命令独立文件，导出 `xxxCommand(): Command` 函数
2. **全局选项传递**: 命令 action 通过 `command.parent?.opts()` 获取 --server/--timeout
3. **格式化一致性**: 所有命令使用 formatTokens/Cost/Duration + renderTable 统一输出
4. **JSON 模式**: 所有命令支持 --json 输出原始 API 响应
5. **对比并行**: compare 命令使用 Promise.all 并行获取两个 session

### 下一步

**迭代 3**: TUI 交互模式实现

---

## 迭代 3：TUI 交互模式

**日期**: 2026-06-14  
**版本**: v0.34  
**状态**: ✅ 完成

### 完成内容

#### TUI 核心组件
- ✅ `src/cli/tui/components/Spinner.tsx` — 自写加载动画（字符轮换，10行）
- ✅ `src/cli/tui/components/TextInput.tsx` — 自写输入框（30行，支持退格/回车/placeholder）
- ✅ `src/cli/tui/components/StatusBar.tsx` — 顶部状态栏（版本号、当前屏幕、服务器URL）
- ✅ `src/cli/tui/components/KeyBar.tsx` — 底部快捷键提示栏（6个屏幕配置）
- ✅ `src/cli/tui/components/DataTable.tsx` — 通用数据表格（分页、选中高亮▸、CJK宽度对齐）
- ✅ `src/cli/tui/components/MetricCards.tsx` — 指标卡片行（label+value+color）
- ✅ `src/cli/tui/components/AsciiBar.tsx` — ASCII 柱状图（█░填充、warning/critical阈值颜色）
- ✅ `src/cli/tui/components/TreeView.tsx` — ASCII 树形图（Phase→Step/Checkpoint/Parallel渲染）
- ✅ `src/cli/tui/components/TabBar.tsx` — Tab 切换栏（7个Tab，icon+label，活跃高亮）
- ✅ `src/cli/tui/components/ConfirmDialog.tsx` — 确认对话框（y/n交互）

#### TUI Hooks
- ✅ `src/cli/hooks/useApi.ts` — API请求hook（缓存30s、loading/error/refresh、cacheKey）
- ✅ `src/cli/hooks/useKeyboard.ts` — 键盘事件处理hook（↑↓EnterEscTab q r / n p + custom）
- ✅ `src/cli/hooks/useNavigation.ts` — 屏幕导航栈hook（navigate/goBack/reset、params传递）
- ✅ `src/cli/hooks/useTable.ts` — 表格状态hook（selectedIndex、sortKey/sortDir、filterText、page分页）

#### TUI Screens
- ✅ `src/cli/tui/screens/SessionList.tsx` — Session列表屏（分页20、搜索模式、选中→详情）
- ✅ `src/cli/tui/screens/SessionDetail.tsx` — Session详情屏（7个Tab、并行数据获取、Tab切换）
- ✅ `src/cli/tui/screens/TurnDetail.tsx` — Turn详情屏（MetricCards、内容滚动、ToolCalls/Skills列表）
- ✅ `src/cli/tui/screens/CompareView.tsx` — 对比屏（10项指标对比表格、diff计算）
- ✅ `src/cli/tui/screens/ImportPanel.tsx` — 导入面板（可导入列表、确认对话框）
- ✅ `src/cli/tui/screens/HelpScreen.tsx` — 帮助屏（导航/全局快捷键说明）

#### TUI Tabs
- ✅ `src/cli/tui/tabs/OverviewTab.tsx` — 概览Tab（SessionInfo、MetricCards、TokenBreakdown、Agents/Skills列表）
- ✅ `src/cli/tui/tabs/TurnsTab.tsx` — TurnsTab（DataTable展示turns列表）
- ✅ `src/cli/tui/tabs/WorkflowTab.tsx` — WorkflowTab（TreeView展示workflow树+摘要）
- ✅ `src/cli/tui/tabs/SubagentsTab.tsx` — SubagentsTab（DataTable展示子agent列表）
- ✅ `src/cli/tui/tabs/SkillsTab.tsx` — SkillsTab（DataTable+ExecutionSkills列表）
- ✅ `src/cli/tui/tabs/BridgesTab.tsx` — BridgesTab（DataTable展示bridge列表）
- ✅ `src/cli/tui/tabs/ContextTab.tsx` — ContextTab（AsciiBar展示context使用率、MODEL_CONTEXT_WINDOWS映射）

#### App.tsx 根组件
- ✅ `src/cli/tui/App.tsx` — stdin切换（resume+setRawMode→render→恢复）、useMemo client、屏幕路由、全局q/Ctrl-C退出、?→Help

#### 命令入口更新
- ✅ `src/cli/index.ts` — tui命令改为调用runTui(loadConfig(globalOpts))

#### 测试用例
- ✅ `tests/helpers/render-tui.tsx` — Ink测试渲染器（renderTui、getPlainText、pressKey系列）
- ✅ `tests/cli/components/Spinner.test.tsx` — 3个测试
- ✅ `tests/cli/components/TextInput.test.tsx` — 4个测试
- ✅ `tests/cli/components/StatusBar.test.tsx` — 2个测试
- ✅ `tests/cli/components/KeyBar.test.tsx` — 4个测试
- ✅ `tests/cli/components/DataTable.test.tsx` — 8个测试（header、separator、CJK、选中标记、分页、自定义render、null值）
- ✅ `tests/cli/components/MetricCards.test.tsx` — 3个测试
- ✅ `tests/cli/components/AsciiBar.test.tsx` — 6个测试（填充、满/空、warning/critical颜色、unit）
- ✅ `tests/cli/components/TreeView.test.tsx` — 4个测试（空/step/failed/checkpoint）
- ✅ `tests/cli/components/TabBar.test.tsx` — 4个测试
- ✅ `tests/cli/components/ConfirmDialog.test.tsx` — 2个测试
- ✅ `tests/cli/hooks/useKeyboard.test.tsx` — 2个测试（mock useInput验证isActive）
- ✅ `tests/cli/hooks/useNavigation.test.tsx` — 4个测试（初始/导航/回退/重置）
- ✅ `tests/cli/hooks/useTable.test.tsx` — 3个测试（初始状态、分页计算）
- ✅ `tests/cli/hooks/useApi.test.tsx` — 2个测试（成功加载、错误处理）
- ✅ `tests/cli/tabs/OverviewTab.test.tsx` — 5个测试
- ✅ `tests/cli/tabs/WorkflowTab.test.tsx` — 2个测试
- ✅ `tests/cli/tabs/ContextTab.test.tsx` — 4个测试
- ✅ `tests/cli/screens/HelpScreen.test.tsx` — 2个测试

### 验证结果

#### 测试验证
```bash
npm run test:cli
# 结果：183 个测试全部通过（原有 119 + 新增 64）
```

#### 版本更新
- version.ts: 0.33 → 0.34

### 技术要点

1. **stdin切换**: App.tsx runTui() 中 process.stdin.resume()+setRawMode(true) → Ink render(exitOnCtrlC:false) → 退出恢复
2. **useMemo client**: config不变时client实例不重建
3. **自实现组件**: 所有组件自写（Spinner 10行、TextInput 30行），不依赖第三方Ink组件库
4. **CJK宽度**: DataTable列宽用string-width视觉对齐，padEndVisual/truncateVisual复用utils/table.ts
5. **分页替代虚拟滚动**: pageSize=20, n/p键翻页
6. **7个Tab**: Overview/Turns/Workflow/Subagents/Skills/Bridges/Context
7. **ink-testing-library**: 测试用render+lastFrame，Ink原生render()无lastFrame
8. **useApi缓存**: 30s TTL缓存，cacheKey用useMemo稳定化
9. **导航栈**: navigate(screen, params) → push栈 → goBack() → pop栈

### 下一步

**迭代 4**: 完善 CLI 命令（import/delete/config 完整实现）+ 性能优化

---

## 迭代 4：完善 CLI 命令

**日期**: 2026-06-15  
**版本**: v0.35  
**状态**: ✅ 完成

### 完成内容

#### 新增命令
- ✅ `src/cli/commands/turn.ts` — Turn 详情命令
  - 显示 Turn 的完整对话内容（user/assistant/tool）
  - 展示 Token 分解（输入/输出/缓存）
  - 显示工具调用历史
  - 支持 `--json` 输出

- ✅ `src/cli/commands/import.ts` — Session 导入命令
  - 支持 Opencode 数据库导入
  - 支持 Claude JSONL 文件导入
  - 交互式选择要导入的 session
  - 显示导入进度和结果

- ✅ `src/cli/commands/delete.ts` — Session 删除命令
  - 按 taskId 删除指定 session
  - `--all` 清空所有 session
  - 删除前确认提示（`--yes` 跳过确认）

- ✅ `src/cli/commands/config.ts` — 配置管理命令
  - `config get <key>` — 获取配置项
  - `config set <key> <value>` — 设置配置项
  - `config list` — 列出所有配置
  - `config reset` — 重置为默认配置

#### 测试用例
- ✅ `tests/cli/unit/commands/turn.test.ts` — 9 个测试
- ✅ `tests/cli/unit/commands/import.test.ts` — 8 个测试
- ✅ `tests/cli/unit/commands/delete.test.ts` — 7 个测试
- ✅ `tests/cli/unit/commands/config.test.ts` — 9 个测试

### 验证结果

#### 测试验证
```bash
npm run test:cli
# 结果：216 个测试全部通过（原有 183 + 新增 33）
```

#### 版本更新
- version.ts: 0.34 → 0.35

### 技术要点

1. **Turn 详情**: 从 API 获取 turn 数据，格式化显示对话内容、工具调用、token 统计
2. **导入流程**: 读取外部数据源 → 解析 session 列表 → 用户选择 → 调用 import API → 显示结果
3. **删除安全**: 删除前显示 session 信息，要求确认（除非 `--yes`）
4. **配置管理**: 读写 `~/.cannbot-insight/config.json`，支持多层优先级（命令行 > 环境变量 > 配置文件 > 默认值）

### CLI 命令完整列表

**查询命令**：
- `sessions` — 列出所有 session
- `session <taskId>` — 查看 session 详情
- `stats` — 查看统计信息
- `compare <taskId1> <taskId2>` — 对比两个 session
- `search <taskId> --keyword <text>` — 搜索 turn 内容
- `turn <taskId> <turnId>` — 查看 turn 详情

**管理命令**：
- `import` — 导入 session（Opencode/Claude）
- `delete <taskId>` — 删除 session
- `delete --all` — 清空所有 session

**配置命令**：
- `config get <key>` — 获取配置项
- `config set <key> <value>` — 设置配置项
- `config list` — 列出所有配置
- `config reset` — 重置为默认配置

**交互模式**：
- `tui` — 启动 TUI 交互模式

### 下一步

**端到端验证**: 启动后端服务，使用真实数据验证所有命令的完整流程
