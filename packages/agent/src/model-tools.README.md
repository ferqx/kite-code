# 模型工具名称与参数投影

[model-tools.ts](model-tools.ts) 负责 Agent 内部工具名称、参数与模型公开工具表面的转换。[ToolDefinition.model](extensions/index.ts) 只保存纯数据：`name`、`snakeCase`、`parameterNames`、`hidden`、`omitParameters`、`requiredParameters` 和结果呈现的 `resultVersion`，不接收执行函数、权限对象或第二套工具实现。各 leaf 拥有名称、说明与字段选择；实际定义 ID、version、input schema、execute/resume、effects、来源和权限继续由原 owner 负责。

## 结果呈现

工具可在定义顶层提供同步纯函数 `formatModelResult`，并声明 `model.resultVersion`。Runtime 在重建下一次模型历史时核原执行、调用、Session／Run／Store 与当前捕获定义的准确 ID/version，只向 formatter 传冻结的原 `ToolResult` 副本和已核完整读取的 Artifact 正文。未知定义、旧版本、不支持的形状或 formatter 异常保留原呈现；真实 Artifact 身份、读取和完整性失败继续拒绝，不能被展示 fallback 吞掉。

目前 [Files](tools/files/README.md) 对工作区读取和搜索去除重复 envelope，保留正文、基线、行窗、分页和未检查范围。[child Source 呈现](model-result-presentation.ts)依据原持久 child 配置和执行身份，前置未核验状态、范围与实际原文预览，再给出完整子报告；未覆盖的工作不能被推断为未发生。失败、取消、未知或无法识别的来源沿原格式交付。

呈现在 [Runtime.modelMessages](runtime.ts) 中完成，早于输入封存、预算估算、续写／重试及压缩；只读 Inspector 读取当时封存的真实输入，不用今天的 formatter 改写旧快照。原 Message、ToolResult、Source、Artifact、邮件携带判断及结果接纳保持原内容和身份。没有生产配置开关或按搜索次数注入的提醒。回归见[真实 Runtime 呈现](../test/isolated/execution/model-result-presentation.test.ts)及[子取证](../test/isolated/business/task/child-tool-evidence.test.ts)。

只读上下文预测须核原 Run 捕获的呈现版本。无法取得准确动态定义，或重建工具正文与已封存输入不一致时，沿原 `context_estimate_unavailable` 返回，不能把原始长 JSON 误报为模型正在使用的短正文；也不为估算重新解析配置或调用模型。[预测回归](../test/isolated/context/result-presentation-estimate.test.ts)覆盖这条边界。

## 请求、派发与历史

1. Loop、内部 `ModelRequest.tools` 和持久工具输入保留规范 ID 与参数。Runtime 冻结注册定义及其模型配置，不按公开名称推断工具身份或权限。
2. [UnifiedExecution.model](execution/index.ts) 为本次准确选中的工具建立公开目录，再把公开名称、公开 schema 和已重建的模型历史交给任意 `ModelAdapter.stream`。转换不只在某个 Provider adapter 内执行，固定模型与自定义 adapter 同样接收该表面。
3. 完整返回的模型调用按本次目录查回原定义，并将公开参数转回内部参数后交给原持久和执行链路。未提供的工具、非法公开参数与转换冲突返回工具失败，不能进入真实效果；不完整流式参数也不能派发。
4. `ToolCall.model` 只记录原公开名称、实际发生改名的字段路径和必要错误码；内部 `ToolCall.name/arguments` 仍保存规范形态。下一轮由 `modelToolCall`／`modelToolMessages` 重建原公开调用，不咨询今天的定义，也不为每条历史复制整份 schema。
5. [Model metadata](model-snapshot.ts) 的 `context.toolSurface` 保存当时完整公开工具声明。内部 assembly 仍绑定原 ID/version；[Inspector 只读入口](runtime.ts) 从原请求和封存表面恢复当时模型所见，不拿当前目录补齐旧输入。完整正文、scope、EOF/hash 及原读取资格仍由 [Model body owner](model-body/README.md)核实。

本次切换不提供旧会话工具消息的名称或参数兼容，不增加旧名称 alias。原操作 `key`、文件 `base` 和准确执行引用仍是必需合同；公开名称友好不代表执行去重、文件基线或授权可以省略。

上下文估算和压缩同样使用公开名称、schema 与历史；原实测 token 基线和新增消息必须采用同一种表示，私有 `ToolCall.model` 不计入实际模型输入。持久取舍见[模型工具表面决定](../../../.agents/notes/implemented/architecture/2026-10-18-model-tool-presentation.md)。

## 字段转换规则

`snakeCase:true` 只转换 JSON Schema 明确声明的 `properties`，并同步该节点的 `required`；组合分支按本次实际实参选择，仅保留激活且存在的字段规则。`parameterNames` 使用内部字段点路径指定公开 key，例如 `offset → start_line`、`limit → max_lines`，数组元素配置路径用 `*`，实际调用记录具体元素索引，避免改变 opaque 兄弟元素。记录的路径是输入字段位置，不是对象内容的搜索替换。

`omitParameters` 按内部顶层字段名收窄公开入口，`requiredParameters` 将已声明且未移除的顶层字段设为公开必填，不能添加不存在的字段。它们只约束本次模型 schema，内部控制合同仍保留；合法输入最终仍转回原定义校验。旧内部等待定义保留这些投影元数据，但均已对模型隐藏；当前六个 Task 工具使用自己的闭合 schema。

没有声明属性的任意 JSON 保持原样，包括 Task 的 `input`、Workflow 的业务 `input/output`、prompt 的 `arguments`、远端 MCP schema 和 schema/default 等数据。模型投影不递归猜测业务 key，也不修改 JSON Schema 关键字。需要字段改名的 schema 若包含无法支持的 `$ref`，明确拒绝，不能只改表面或偷偷放宽校验。

`anyOf` 多个匹配分支产生不同字段映射时，该调用明确失败；`if/not` 谓词内的 `properties` 自身需要改名时，装配明确拒绝。只含 `required` 的条件和名称不变的 `kind` 判别仍支持。每份实际变换的 schema 独立校验，纯名称投影不重复编译远端 MCP schema，不合并不同工具的 `$id` 空间。

显式公开名称须为最多 64 字符的 lowercase snake_case 标识。一次准确目录中的名称碰撞、同一对象的字段碰撞和不存在的显式字段路径均拒绝；`hidden:true` 只从模型声明目录移除，内部注册和可信调用资格仍由原合同核实，不通过隐藏授予额外权限。

同一对象跨 `allOf` 的字段声明按来源及替代分支选择核对，碰撞检测不依赖分支遍历顺序，也不枚举组合；互斥分支可分别使用可逆映射。只有名称变化的 MCP/自定义工具直接深拷贝原 schema，不遍历或重编译远端字段，合法空字段和 opaque JSON 保持。

## 当前公开名称

| 负责模块／内部工具 | 模型工具名称 | 主要字段选择 |
| --- | --- | --- |
| `files.read/list/glob/search` | `read_file`、`list_directory`、`glob_files`、`search_content` | 读取 `offset/limit → start_line/max_lines`；搜索 `after → cursor`；路径继续按固定 Workspace 根解释 |
| `files.write/edit` | `write_file`、`edit_file` | `base` 保留；`find/replace/occurrences → old_text/new_text/expected_matches` |
| `files.read_path/write_path/edit_path` | `read_user_file`、`write_user_file`、`edit_user_file` | 沿文件字段规则，独立绝对路径和原目标权限 |
| `shell.execute/launch/read/wait/stop` | `shell_execute`、`shell_launch`、`shell_read`、`shell_wait`、`shell_stop` | 前台执行时限 `execution_timeout_ms`；等待时限 `wait_timeout_ms`；其他声明字段转 snake_case |
| 普通问题、网页 | `ask_user`、`web_fetch` | 问题保留闭合 `{questions}`；网页使用 `max_chars/timeout_ms` |
| `task.spawn/message/follow_up/interrupt` | `spawn_agent`、`send_agent_message`、`follow_up_agent`、`interrupt_agent` | 创建使用 `prompt/task_name/preset`；后续协作使用稳定 `agent_id`，消息可明确 `target:parent`；不接受内部操作键、Provider 或 Run 身份 |
| `task.events/list` | `wait_agent_events`、`list_agents` | 事件使用 `after_seq/wait_ms`；列表使用 `agent_ids/after_seq/upper_seq/limit`；旧 Task 工具仅保内部注册，对模型隐藏 |
| `planning.read/write/review/update` | `read_plan`、`write_plan`、`request_plan_review`、`update_plan_progress` | 只改模型名称和声明字段，原计划批准与版本 CAS 保持 |
| `validation.define/check/rebind/request_waiver/auto_check` | `define_validation_checks`、`run_validation_checks`、`rebind_validation_checks`、`request_validation_waiver`、`check_file_changes` | 原实际执行、期待值、验证和 waiver 资格保持 |
| `skills.load/resource` | `load_skill`、`read_skill_resource` | `id → skill_id` |
| Workflow 六工具 | `activate_skill`、`read_skill_reference`、`complete_skill`、`verify_skill`、`repair_skill`、`decide_skill_verification` | 现有名称保持，业务 JSON 不改名 |
| MCP 来源／连接／刷新／搜索 | `list_mcp_sources`、`connect_mcp_server`、`refresh_mcp_catalogue`、`search_mcp_tools` | 内置声明字段转 snake_case；来源目录与当前选中工具搜索分开 |
| MCP 资源／提示 | `list_mcp_resources`、`read_mcp_resource`、`list_mcp_prompts`、`get_mcp_prompt` | 绑定字段转 snake_case，远端 `arguments` 保持 |
| 动态 MCP Tool | `mcp_<server>_<remote>_<hash8>` | 来源和远端名称清理、转小写并限制片段长度，摘要绑定完整原身份；原远端 schema 与 RPC 名称/参数完全保留 |

文件、Shell、Task 和 MCP 的完整参数、输出与生命周期分别归各 leaf README；本表不是另一份执行 schema。`search_content` 仍是字面文本搜索，公开名称不把它变成正则工具；MCP 搜索范围也不因改名扩大。

`files.search@4` 默认 `mode:files` 按命中文件定位，显式 `mode:content` 取正文片段；`next_cursor` 原样交回公开 `cursor`，不得换查询、模式或过滤条件。`context_lines/max_line_chars/respect_ignore` 继续由同一声明生成。`read@4` 的结果呈现版本为1，`search@4` 为2；原读取 baseline、完整正文、过滤、分页及当前页未读范围归 [Files owner](tools/files/README.md)。模型正文不增加没有后续操作用途的执行 UUID，原执行身份和 Artifact 范围仍在原记录中核实。`spawn_agent` 的默认及开放 preset 说明取自实际注册角色，不从名称猜测能力；当前源目录和封存工具表面分别表达现在与当时事实。Shell 本地引用缺失由 [Shell leaf](tools/shell.README.md)返回有限确定失败；这些反馈字段不能改变原派发状态、重放权限或未知效果。

## 工具选择与职责

普通宿主的实际默认目录来自 [Service defaults](../../../apps/service/src/configuration-defaults.ts)：具备合格 Shell 时为20项；不具备时为15项，包括工作区 Files 六项、外部文件读取、问题、网页及 Task 六项。最小嵌入配置仍只默认提供问题工具。上述名称表同时列出可选能力，不是每次 Run 的固定工具清单；计划／验证、Skill、Workflow 和 MCP 仍由原显式配置、能力及权限选择。旧 Task 内部定义有可信调用消费者，隐藏于模型不等于可删除内部执行合同。

工具按独立操作及其可观察结果划分，不把模型填写的结论再包装成事实来源。本轮实验的研究状态工具及其 records/context、权限例外和导出入口已全部撤回，没有保留可选入口或另建替代工具。计划工具管理已存在的步骤、批准和版本，验证工具运行真实检查；它们不因此成为语义真值来源。

`wait_agent_events` 只给事件摘要与游标。`list_agents` 可以重新取得最近一次终态的完整子报告，包括由原 Artifact 核身份后展开的正文；旧自动 Source 被压缩后，新的目录调用仍能重新带入该正文。它不选择任意历史轮次；当前 queued/running/waiting 状态可能仍携带上一轮结果，不能将其当作本轮完成。完整报告可读、结果接纳、最终主张有依据分别由原 Task 合同和实际证据核实。

## 验证边界

验证应捕获实际 Adapter 收到的公开名称/schema，发出公开调用后核对真实内部定义和准确参数，再核下一轮历史与 Inspector。当时定义变化、同名碰撞、非法字段、opaque JSON、大正文及拒权零效果分别验证，不能只比较两份同源 schema。

验收入口包括[真实 Runtime 与上下文基线](../test/isolated/execution/model-tools.test.ts)、[组合分支](../test/isolated/execution/model-tools-branches.test.ts)、[真实 Service 读改与审批](../../../apps/service/test/isolated/configuration.test.ts)、[模型快照](../test/isolated/model-snapshot/metadata.test.ts)、[Inspector](../test/isolated/model-input/inspector.test.ts)、[MCP 实际调用](../test/isolated/mcp/mcp.test.ts)、[MCP 搜索](../test/isolated/mcp/interactive-discovery.test.ts)与 [资源模型提示](../test/isolated/mcp/resource-model-source.test.ts)。其中 CamelCase MCP 用例通过真实 stdio 核公开名小写、原 schema 的 `projectId` 和 RPC 的原远端名称/参数保持；其他受影响固定模型 fixture 使用当前公开合同，旧内部名调用不是兼容资格。

[真实模型工具测试](../../../tests/e2e/live/model/README.md)另以显式门禁调用现有默认模型，使用合成工作区验证文件读改写、公开历史和单子任务的准确等待/结果。它不进入默认测试发现；运行次数、超时、凭据和报告边界归该入口。固定模型与本机 HTTP 的通过不能替代真实 Provider 结果，真实单模型通过也不外推其他模型。
