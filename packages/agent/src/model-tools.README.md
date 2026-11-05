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

`shell_stop` 的 `shell_id` 使用原返回句柄，`command_id` 则由调用方为本次取消创建唯一意图 ID；不能复制 launch／Job 返回的旧 Command ID。只有准确重试同一次取消才复用该 ID。说明与字段描述都表达这一区别，工具版本、输入形状和原去重／权限行为保持。

可信 `RunConfiguration.modelHiddenToolIds` 只收窄该 Run 的模型目录：Runtime 冻结工具副本并设置模型隐藏，内部原定义、版本和每次派发权限保持。Service 在新 Native 统一浏览器配置中用它隐藏原子依赖，同时公开 `browser_execute`；子任务继承与恢复依据原冻结配置，不从今天的默认目录改写旧 Run。调用者的普通 Tool 参数不能声明这个宿主配置。回归见[浏览器配置](../../../apps/service/test/isolated/browser-execution-configuration.test.ts)。

## 字段转换规则

`snakeCase:true` 只转换 JSON Schema 明确声明的 `properties`，并同步该节点的 `required`；组合分支按本次实际实参选择，仅保留激活且存在的字段规则。`parameterNames` 使用内部字段点路径指定公开 key，例如 `offset → start_line`、`limit → max_lines`，数组元素配置路径用 `*`，实际调用记录具体元素索引，避免改变 opaque 兄弟元素。记录的路径是输入字段位置，不是对象内容的搜索替换。

`omitParameters` 按内部顶层字段名收窄公开入口，`requiredParameters` 将已声明且未移除的顶层字段设为公开必填，不能添加不存在的字段。它们只约束本次模型 schema，合法输入最终仍转回原定义校验；当前六个协作工具使用各自的闭合 schema。

没有声明属性的任意 JSON 保持原样，包括 Task 的 `input`、prompt 的 `arguments`、远端 MCP schema 和 schema/default 等数据。模型投影不递归猜测业务 key，也不修改 JSON Schema 关键字。需要字段改名的 schema 若包含无法支持的 `$ref`，明确拒绝，不能只改表面或偷偷放宽校验。

`anyOf` 多个匹配分支产生不同字段映射时，该调用明确失败；`if/not` 谓词内的 `properties` 自身需要改名时，装配明确拒绝。只含 `required` 的条件和名称不变的 `kind` 判别仍支持。每份实际变换的 schema 独立校验，纯名称投影不重复编译远端 MCP schema，不合并不同工具的 `$id` 空间。

[model-schema.ts](model-schema.ts)仅按完整 JSON 内容复用模型参数投影与分支匹配的 Ajv 编译结果；每个 schema 仍有独立 registry 和私有副本，同 `$id` 的不同正文及本地 `$ref` 不混用。缓存按 LRU 最多128项，键串 UTF-8 合计1MiB、单键64KiB；超出接纳预算、非纯 JSON／访问器等情况保原完整编译路径，不拒绝工具。实际调用只消费本次同步校验结果，不缓存参数、字段映射、权限或文件事实。新 Run 的 schema 改动产生新键，旧 caller 修改 schema 不能污染复用结果。[缓存回归](../test/isolated/execution/model-schema.test.ts)核内容复用、引用隔离、修改、数量／键字节淘汰与非缓存路径；[参数投影](../test/isolated/execution/model-tools.test.ts)和[分支回归](../test/isolated/execution/model-tools-branches.test.ts)继续拥有目录、碰撞和 opaque JSON 语义。

显式公开名称须为最多 64 字符的 lowercase snake_case 标识。一次准确目录中的名称碰撞、同一对象的字段碰撞和不存在的显式字段路径均拒绝；`hidden:true` 只从模型声明目录移除，内部注册和可信调用资格仍由原合同核实，不通过隐藏授予额外权限。

同一对象跨 `allOf` 的字段声明按来源及替代分支选择核对，碰撞检测不依赖分支遍历顺序，也不枚举组合；互斥分支可分别使用可逆映射。只有名称变化的 MCP/自定义工具直接深拷贝原 schema，不遍历或重编译远端字段，合法空字段和 opaque JSON 保持。

## 当前公开名称

| 负责模块／内部工具 | 模型工具名称 | 主要字段选择 |
| --- | --- | --- |
| `files.read` | `read_file` | `offset/limit → start_line/max_lines`；工作区相对路径或准确外部绝对路径 |
| `files.write/edit` | `write_file`、`edit_file` | `base` 保留；`find/replace/occurrences → old_text/new_text/expected_matches` |
| `shell.execute/launch/read/wait/stop` | `shell_execute`、`shell_launch`、`shell_read`、`shell_wait`、`shell_stop` | 前台执行时限 `execution_timeout_ms`；等待时限 `wait_timeout_ms`；其他声明字段转 snake_case |
| 普通问题、网页 | `ask_user`、`web_fetch` | 问题保留闭合 `{questions}`；网页使用 `max_chars/timeout_ms` |
| `task.spawn/message/follow_up/interrupt` | `spawn_agent`、`send_agent_message`、`follow_up_agent`、`interrupt_agent` | 创建使用 `prompt/task_name/preset`；后续协作使用稳定 `agent_id`，消息可明确 `target:parent`；不接受内部操作键、Provider 或 Run 身份 |
| `task.events/list` | `wait_agent_events`、`list_agents` | 事件使用 `after_seq/wait_ms`；列表使用 `agent_ids/after_seq/upper_seq/limit` |
| `planning.read/write/review/update` | `read_plan`、`write_plan`、`request_plan_review`、`update_plan_progress` | 只改模型名称和声明字段，原计划批准与版本 CAS 保持 |
| `browser.execute` | `browser_execute` | `code` 与简短动作 `description`；页面句柄、引用和操作 key 由 [Browser owner](tools/browser/README.md)核实，原子依赖在新 Native 默认目录中隐藏 |
| `skills.load/resource` | `load_skill`、`read_skill_resource` | `id → skill_id`，可选 `version`；资源读取另含 `path`，不接受 `description` |
| MCP 来源／连接／刷新／搜索 | `list_mcp_sources`、`connect_mcp_server`、`refresh_mcp_catalogue`、`search_mcp_tools` | 内置声明字段转 snake_case；来源目录与当前选中工具搜索分开 |
| MCP 资源／提示 | `list_mcp_resources`、`read_mcp_resource`、`list_mcp_prompts`、`get_mcp_prompt` | 绑定字段转 snake_case，远端 `arguments` 保持 |
| 动态 MCP Tool | `mcp_<server>_<remote>_<hash8>` | 来源和远端名称清理、转小写并限制片段长度，摘要绑定完整原身份；原远端 schema 与 RPC 名称/参数完全保留 |

只有浏览器执行入口声明动作 `description`，沿既有 `model.requiredParameters` 对新模型调用必填，内部 schema 可选；长度为1–10个Unicode字符且不能全为空白，说明本次动作目的，不宣称成功。原输入与公开历史保留该字段，旧记录不补造，页面业务代码不消费它。两个 Skill 读取入口不再声明或要求执行描述；旧历史与封存请求保持原文。该字段不向 MCP／自定义工具注入或改写其业务参数，不升级 Tool／Protocol 版本。

文件、Shell、Task 和 MCP 的完整参数、输出与生命周期分别归各 leaf README；本表不是另一份执行 schema。目录查看、文件查找与正文搜索由 Shell 完成，搜索使用内置 rg；原三个文件检索模型工具和五个验证工具已删除，历史记录不会重新开放它们。MCP 搜索范围不因改名扩大。

Files 的目录与检索 API 仍服务客户端文件候选等内部读取，不注册为模型工具。read_file 的结果呈现、完整正文和分页归 [Files owner](tools/files/README.md)。spawn_agent 的默认及开放 preset 说明取实际注册角色，不从名称猜能力；当前目录和封存表面分别表达现在与当时事实。Shell 本地引用缺失由 [Shell leaf](tools/shell.README.md)返回有限失败，不改变派发状态或未知效果。

## 工具选择与职责

普通宿主的实际默认目录来自 [Service defaults](../../../apps/service/src/configuration-defaults.ts)：不含可选 Browser 的基础目录在具备合格 Shell 时为16项，不具备时为11项，包括 Files 三项、问题、网页及协作六项；其中 read_file 支持准确工作区外只读路径。宿主允许 Browser 时另选择对应浏览器能力；新 Native 默认对模型提供 `browser_execute` 与两个 Skill 读取入口，原子依赖保持内部隐藏。最小嵌入配置仍只默认提供问题工具。名称表同时列可选能力，不是每次 Run 的固定清单；Planning、Skill 和 MCP 仍按配置、能力及权限选择。旧 Task 工具和专用 required-result 机制已删除，不保留内部兼容入口。

工具按独立操作及可观察结果划分，不把模型填写的结论包装成事实来源。研究状态工具及其 records/context、权限例外和导出入口已撤回。计划工具管理步骤、批准和版本；专用验证工具已移除，检查通过普通 Shell 执行并如实报告。

`wait_agent_events` 只给事件摘要与游标。`list_agents` 可以重新取得最近一次终态的完整子报告，包括由原 Artifact 核身份后展开的正文；旧自动 Source 被压缩后，新的目录调用仍能重新带入该正文。它不选择任意历史轮次；当前 queued/running/waiting 状态可能仍携带上一轮结果，不能将其当作本轮完成。完整报告可读、结果接纳、最终主张有依据分别由原 Task 合同和实际证据核实。

## 验证边界

验证应捕获实际 Adapter 收到的公开名称/schema，发出公开调用后核对真实内部定义和准确参数，再核下一轮历史与 Inspector。当时定义变化、同名碰撞、非法字段、opaque JSON、大正文及拒权零效果分别验证，不能只比较两份同源 schema。

验收入口包括[真实 Runtime 与上下文基线](../test/isolated/execution/model-tools.test.ts)、[组合分支](../test/isolated/execution/model-tools-branches.test.ts)、[真实 Service 读改与审批](../../../apps/service/test/isolated/configuration.test.ts)、[模型快照](../test/isolated/model-snapshot/metadata.test.ts)、[Inspector](../test/isolated/model-input/inspector.test.ts)、[MCP 实际调用](../test/isolated/mcp/mcp.test.ts)、[MCP 搜索](../test/isolated/mcp/interactive-discovery.test.ts)与 [资源模型提示](../test/isolated/mcp/resource-model-source.test.ts)。其中 CamelCase MCP 用例通过真实 stdio 核公开名小写、原 schema 的 `projectId` 和 RPC 的原远端名称/参数保持；其他受影响固定模型 fixture 使用当前公开合同，旧内部名调用不是兼容资格。

[真实模型工具测试](../../../tests/e2e/live/model/README.md)另以显式门禁调用现有默认模型，使用合成工作区验证文件读改写、公开历史和单子任务的准确等待/结果。它不进入默认测试发现；运行次数、超时、凭据和报告边界归该入口。固定模型与本机 HTTP 的通过不能替代真实 Provider 结果，真实单模型通过也不外推其他模型。


Skill Workflow 的六个工具和专用外部文件三个工具已移除定义及宿主装配；旧名称没有 alias。`read_file` 的外部读取由 [external-file-reads](tools/external-file-reads.ts) 在同一定义下核准确授权与原生身份，不提供外部写入或项目指令发现。
