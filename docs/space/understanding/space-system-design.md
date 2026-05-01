# Space 系统设计

日期：2026-04-26
状态：understanding
相关：

- `../index.md`
- `../references/openai-harness-engineering.md`

## 目的

`docs/space/` 是一个轻量的仓库本地记录系统，用于保存应该跨 agent 会话存续的决策。它填补源码、测试和聊天历史之间的空白。

它解决的核心问题是：后续 agent 往往只能看到当前代码形态，却看不到这些形态背后的设计理由。space 记录保留理由、当前约束和验证历史，同时避免把 `AGENTS.md` 变成大型手册。

该设计遵循 harness-engineering 原则：仓库应成为 agent 可读的记录系统，而 `AGENTS.md` 应保持为指向更深资料的简短地图。

`docs/space/` 不是 LangGraph checkpoint 状态的替代品。每次运行的 `graph.state.plan` 仍是运行时状态。space 记录只保存持久设计规则、已完成实现证据和参考材料。

## 设计原则

- 地图优先：`AGENTS.md` 指向 `docs/space/index.md`，不承载整个知识库。
- 渐进式披露：未来 agent 先读索引，再只读与当前任务范围匹配的记录。
- 执行记录一等化：active 和 completed 决策存放在版本化文件中，而不只存在聊天历史里。
- 运行时边界：不要为每个 `graph.state.plan` 生成计划文件；只记录持久设计决策和已完成实现历史。
- 新鲜度可判断：记录应包含状态、范围和验证说明，让后续 agent 能判断是否仍然适用。
- 垃圾回收：过期 active 规则必须带理由退役或改写，不能静默累积。

## 目录模型

### `index.md`

所有持久 space 记录的目录。

用于：

- 按范围定位 active 规则。
- 发现背景和参考记录。
- 判断记录是 active、completed、generated 还是 reference-only。
- 在不读取所有文件的情况下保持目录可导航。

任何新增、移动、退役或实质修改的 space 记录，都应在同一改动中更新索引。

### `understanding/`

保存理由、心智模型和背景解释。

用于：

- 解释某个设计为何存在。
- 记录容易遗忘的取舍。
- 分析源码行为。
- 记录跨 provider 或架构层面的推理。

这些记录解释决策，但不是直接执行清单。

### `execution/active/`

保存当前有效、未来工作应保留的规则。

用于：

- 阻止随意重构破坏约束。
- 记录测试应继续断言的行为。
- 解释看起来偶然但实际有意的设计选择。
- 规定修改相关子系统前必须阅读的规则。

active 记录应短小、具体，并限定到明确文件或子系统。

active 记录不应每个任务都读。只有当前任务触及其声明范围时才必须读取。

### `execution/completed/`

保存已完成变更记录。

用于：

- 记录改了什么。
- 解释为什么改。
- 列出涉及文件。
- 记录运行过的验证命令。
- 说明剩余风险。

completed 记录是历史证据，本身不是 active 规则。

### `references/`

保存外部参考摘要。

用于：

- 上游来源对比。
- 第三方行为说明。
- 影响本地规则的文档摘要。

reference 记录不具备约束力，除非被提升为 `execution/active/` 规则。

### `generated/`

保存明确低权威性的生成或派生材料。

用于：

- 草稿。
- 综合对比。
- 临时生成说明。
- 可能有用但不能静默成为政策的材料。

## 权威与冲突规则

权威顺序：

1. 用户、system 和 developer 直接指令。
2. 源码和测试。
3. `index.md` 中链接的 `execution/active/` 记录。
4. `understanding/` 和 `references/`。
5. `generated/`。

如果 active 记录与源码或测试冲突，不要盲目遵循任何一边。应检查实现、测试和 completed 记录，然后用明确理由更新过期的一方。

如果用户明确要求修改 active 规则，应在实现中同步更新该规则，并记录设计为何改变。

## 后续 Agent 的读取路径

不要每次任务都读取所有 space 记录。

首次需要持久项目上下文时，读取 `docs/space/index.md`。

当任务触及某条 active 记录的范围时，读取该 `execution/active/` 记录，例如：

- 模型上下文构建。
- 计划状态处理。
- 图路由、自治或 tool gating。
- 工具 gating 和审批行为。
- 缓存敏感 prompt 布局。
- active 记录范围中命名的任何子系统。

只有当 active 规则需要背景，或实现意图不清楚时，才继续读取 `understanding/` 或 `references/`。

## 记录元数据

可能影响未来实现的记录应包含：

- `状态`：`active`、`completed`、`understanding`、`reference` 或 `generated`。
- `范围`：记录覆盖的文件、子系统或行为。
- `读取时机`：哪些任务条件要求读取该记录。
- `相关`：active 规则、completed 记录、参考资料或测试。
- `验证`：相关命令、测试或检查证据。

格式可以保持简单 Markdown key-value。关键不变量是：后续 agent 能机械扫描记录，并判断它是否当前有效、是否相关。

## 写入路径

当某个决策如果被遗忘会产生未来成本时，新增或更新 space 记录。

适合记录的内容：

- 影响架构的 provider-specific 行为。
- prompt 或上下文布局决策。
- 安全、审批或 plan-mode 不变量。
- 不容易从代码直接看出的规则。
- 对比外部项目后形成的选择。

避免为常规实现细节、临时调试笔记或已由附近测试名清楚表达的事实新增 space 记录。

## 晋升为顶层文档

`ARCHITECTURE.md`、`SECURITY.md`、`RELIABILITY.md`、`DESIGN.md`、`FRONTEND.md`、`PLANS.md`、`PRODUCT_SENSE.md` 和 `QUALITY_SCORE.md` 这类顶层 Markdown 文件，只应在它们成为有用入口时创建，不要作为空占位符创建。

agent 应在出现至少一个信号时，主动提议或创建顶层文档：

- 同一主题已经有多条 active 或 completed `docs/space` 记录，未来 agent 需要先读稳定地图再读细节。
- 主题跨多个源码目录或测试套件，单条 active 规则过窄。
- 主题定义了会指导许多未来改动的持久运行原则、质量标准或架构边界。
- 主题除了可执行测试或 active 规则外，还需要人类可读概览。
- 已有顶层文档可以避免在 `AGENTS.md`、`README.md` 或多条 space 记录中重复解释同一内容。

按当前仓库形态创建最小有用文档。对本项目而言，`ARCHITECTURE.md` 是第一个可能需要的候选，因为图拓扑、模式切换、provider 边界、checkpoint 和 tool gating 彼此交织。仓库真正出现相关领域前，不要创建 `FRONTEND.md`、`PRODUCT_SENSE.md` 或类似产品领域文档。

创建顶层文档时：

1. 保持 `AGENTS.md` 作为地图，只添加指向新文档的短链接。
2. 从 `docs/space/index.md` 或相关 space 记录链接该文档。
3. 把详细历史决策保留在 `docs/space`；顶层文档应总结和路由，而不是复制每条记录。
4. 如果文档编码了可机械检查的结构不变量，应新增或更新轻量测试。
5. 如果需求不确定，先新增 `understanding/` 记录，等信号重复后再创建顶层文档。

新增 active 规则时：

1. 在 `execution/active/` 下新增简洁记录。
2. 包含状态、范围、读取条件、必需行为和“不要做”指导。
3. 可行时新增或更新测试来强制该行为。
4. 如果规则来自实现变更，新增 completed 记录。
5. 更新 `index.md`。

退役规则时：

1. 带理由移动或改写 active 记录。
2. 新增 completed 记录描述退役。
3. 同步更新测试和源码。
4. 更新 `index.md`。

## 垃圾回收

space 记录不应膨胀成第二个 README。

相关维护时检查：

- 范围不再匹配实现的 active 规则。
- completed 记录仍是历史，但不再暗示当前规则。
- generated 或 reference 材料是否应晋升为 active 规则，或保持明确非绑定。
- 缺少状态、范围或索引链接的记录。

当前期望是手动维护。如果目录继续增长，应增加轻量检查来验证索引链接和必需元数据。

## 命名

使用描述性的 kebab-case 文件名。

推荐模式：

- `understanding/YYYY-MM-DD-topic.md`
- `execution/active/topic-rule.md`
- `execution/completed/YYYY-MM-DD-topic.md`
- `references/source-topic.md`

历史记录优先使用日期前缀。active 记录不需要在文件名中使用日期，因为它们代表当前规则。

## 当前重要规则

第一条 active 规则是 `execution/active/plan-state-reminder.md`。

它记录了 `graph.state.plan` 必须作为真实会话之后的尾部合成运行时状态提醒投影，而不是放入静态 system prompt 或可缓存运行时上下文。
