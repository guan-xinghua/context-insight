# 主 agent 组合声明提取：插件化 + LLM 泛化路径

> 对应实现：`src/lib/workflow-extract-plugin.ts`（客户端安全核心）+ `src/lib/workflow-extract-config.ts`
>（server-only fs 加载器）+ `src/lib/sift-audit.ts`（确定性提取引擎）+ `src/lib/llm-workflow-extract.ts`
>（LLM 泛化路径）。v2.02 落地。

## 背景

root 对账的组合声明（规程层 + 计划层）的**确定性提取**内置了一批识别启发式——计划文件名白名单
（STATE.md 等）、plan-like 标题（## Tasks/任务…）、skill 打包目录（resources/templates）、
turn0 ≥500、正文 ≥100、todowrite ≥3——它们是对**算子生成任务**（CANN ops workflow）调出来的。
两个诉求：

1. **插件化**：换一个领域（非算子生成），这些约定全部失效；要求不改代码即可切换领域参数。
2. **泛化**：LLM 提取（llm-root）作为领域无关的兜底路径，且产出要与确定性提取**同构一致**
   ——"可以提取拼接，不可以篡改"。

## 设计

### 双路分工

| 路径 | 识别者 | 领域知识来源 | 速度 | 泛化性 |
|---|---|---|---|---|
| 确定性（`recoverCombinedWorkflowDeclaration`） | 代码启发式 | **插件配置**（cann-ops 默认） | 快（纯 DB 查询） | 限插件领域 |
| LLM（`llmExtractWorkflowDeclaration`） | 模型理解 | 无（概念定义进 prompt） | 慢（claude CLI） | 任意领域 |

### 插件（确定性路）

`workflow-extract-plugins.json`（部署根，gitignore；schema 见 `.example`，镜像
context-windows.json 惯例）：

```jsonc
{
  "active": "cann-ops",
  "plugins": {
    "cann-ops": {
      "regulation": { "resourceDirs": ["resources"], "turn0MinChars": 500, "bodyMinChars": 100 },
      "plan": { "fileNames": ["STATE.md", "TODO.md", ...], "planLikeHeadings": ["Tasks", "任务", ...],
                 "minChecklistItems": 3, "minNumberedItems": 5, "minTodos": 3, "bodyMinChars": 100,
                 "excludedDirs": ["resources", "templates"] }
    }
  }
}
```

- 无配置文件 → 代码默认 `DEFAULT_PLUGIN`（= cann-ops 现值，native 行为逐字节不变）。
- 提取管线本身（两层模型、四桶优先级、首次实质读取、60% 实质比）是领域无关引擎，**不进配置**——
  插件只调"认什么"，不改"怎么提取"。
- 加载器 `ensureWorkflowExtractPluginLoaded()`：进程内幂等一次；API 路由入口
  （audit-skillsift / main-agent-workflow / skill-content）调用激活；单测直调 recover* 不激活
  → 回退默认（与旧行为一致）。

### 模块隔离（客户端可达性）

`sift-audit.ts` 被 session page 的客户端组件 import，它顶层 import 的模块全部进 client bundle。
故插件配置拆两半（镜像 agent-md-scan.ts 的隔离模式）：

| 模块 | 可达性 | 内容 |
|---|---|---|
| `workflow-extract-plugin.ts` | 客户端安全（零 node 内建 import） | 类型 / DEFAULT_PLUGIN / `resolvePluginFromRaw` 纯合并 / holder（`getWorkflowExtractPlugin()` = 测试注入 > 文件加载 > 默认） |
| `workflow-extract-config.ts` | server-only（fs/path） | 读 `workflow-extract-plugins.json` → 灌 holder；`ensureWorkflowExtractPluginLoaded()` |

违反即 Turbopack "does not support external modules (node:fs)"（v2.02 修复过一次）。
`tests/workflow-extract-config.test.ts` 的**客户端可达性静态锁**在源码级禁止回归。


### LLM 泛化路径（选择式契约）

关键决策：**LLM 不抄写正文，只做选择**。

```
确定性收集候选（零领域启发）            LLM 选择（claude CLI）           共享装配（代码）
┌────────────────────────────┐    ┌──────────────────────┐    ┌────────────────────────┐
│ 规程候选（dispatch 前窗口）：  │    │ prompt：两层定义 +    │    │ parseCandidateSelection │
│  turn0 注入 / skill 正文 /   │ →  │ 候选预览 + 选择规则    │ →  │ 只认候选 ID，正文取 DB   │
│ 计划候选（全 session）：      │    │ 输出 {"regulation":   │    │ 原文 → assembleCombined │
│  todowrite / .md/.txt 快照  │    │  "R1", "plan": "P1"}  │    │ Declaration（与确定性共 │
└────────────────────────────┘    └──────────────────────┘    │ 享，字节级同构）          │
                                                              └────────────────────────┘
```

- **不可篡改 by construction**：LLM 输出里即使夹带伪造正文也不被解析——正文一律来自候选
  （DB 原文），机械归一化（Read 剥行号 / todowrite 格式化 / 计划层 [x]→[ ]）在代码里做。
- **结果一致**：装配走确定性提取的同一 `assembleCombinedDeclaration`；候选 source 口径与确定性
  对齐（basename / "skillName (SKILL.md)" / "turn0 (注入编排规程)" / "todowrite"）——识别正确
  的常见场景，两条路产出**字节级一致**（IT 锁定）。
- **泛化**：收集零领域启发（文件名白名单 / 内容特征全交给模型判断）；prompt 只给概念定义
  （规程=怎么干 / 计划=干什么）+ 选择规则（镜像确定性优先级 + 两层互斥 + 完整优先）。
- 候选排序用中性信号：todowrite 在前、同文件多次读取（活跃计划）加权、部分读取标注降权；
  上限 40 计划候选 / 8 规程候选防爆 prompt。

## 验证

- `tests/workflow-extract-config.test.ts`：默认值不变；换插件后 named 桶 / 标题集 / 排除目录
  分岔；null + reset 回默认。
- `tests/llm-workflow-extract.test.ts`：候选收集（双列 / 剥行号 / 格式化 / 排除 / 合并 /
  partial 标注）；prompt 契约（只选不抄）；选择解析（跨层作废 / 代码块容忍 / 非 JSON 空）；
  端到端（**LLM 路 vs 确定性路字节一致**、单层直出、runner 注入、伪造正文不生效）。

## 边界

- 插件是**全局单选**（部署级 active），不按 session/framework 路由——同仓多领域混跑需后续
  按 framework/目录探测路由（本期未做）。
- LLM 路的选择仍可能错（如把需求文档当选计划）——prompt 规则缓解，审计结果以人判为准。
- 计划候选仅收集 .md/.txt（其他扩展名的计划文件不入候选，LLM 路同样受限）。
