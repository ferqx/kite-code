# 模型工具名称与参数投影

模型提供业务输入，宿主以原回执引用保管准确基线、版本和执行身份。引用不授予权限，不选择最新对象或重放原操作；持久取舍见[准确引用决定](../../../.agents/notes/implemented/architecture/2026-11-08-model-tool-exact-references.md)。

[model-tools.ts](model-tools.ts) 负责 Agent 内部工具名称、参数与模型公开工具表面的转换。[ToolDefinition.model](extensions/index.ts) 只保存纯数据：`name`、`snakeCase`、`parameterNames`、`hidden`、`omitParameters`、`requiredParameters`、可选公开 `inputSchema` 和结果呈现的 `resultVersion`，不接收执行函数、权限对象或第二套工具实现。可选公开 inputSchema 只控制模型表面，Core 仍校验原定义的完整内部输入；它不转换旧字段或新增执行前处理平台。各 leaf 拥有名称、说明与字段选择；实际定义 ID、version、input schema、execute/resume、effects、来源和权限继续由原 owner 负责。

## 结果呈现

工具可在定义顶层提供同步纯函数 `formatModelResult`，并声明 `model.resultVersion`。Runtime 在重建下一次模型历史时核原执行、调用、Session／Run／Store 与当前捕获定义的准确 ID/version，只向 formatter 传冻结的原 `ToolResult` 副本和已核完整读取的 Artifact 正文。未知定义、旧版本、不支持的形状或 formatter 异常保留原呈现；真实 Artifact 身份、读取和完整性失败继续拒绝，不能被展示 fallback 吞掉。

原 owner、Shell 引用和证据正文的 Store／Artifact 读取在纯 formatter 的异常回退范围外完成。压缩后通过执行证据找回旧结果时，同样完整校验嵌套原正文，并沿本次模型准备的取消信号中止读取；缺失或损坏沿既有模型准备失败路径上报，不以成功目录 JSON 替代不可读正文。纯展示不支持某种形状时仍保留完整原结果，包括未知 evidence 限定和外部工具业务字段；有 Artifact 时同时保留已验证的完整正文，不只取 `content`。

目前 [Files](tools/files/README.md) 对工作区读取去除重复 envelope，保留正文、准确基线引用、行窗、分页和未检查范围；普通确定缺失保准确路径及 `exists:false`，不造正文或基线。[child Source 呈现](model-result-presentation.ts)依据原持久 child 配置和执行身份，前置未核验状态、范围与实际原文预览，再给出完整子报告。准确失败的 child 也保此前工具观察、Shell 输出预览及遗漏限制，失败原因使用公开英文说明，不把失败称为此前零效果。未知证据结构保原完整 Source；未覆盖的工作不能被推断为未发生。成功专用 leaf formatter 不处理失败结果；child 呈现并非 leaf formatter。

[失败说明](tool-failure-presentation.ts)在原 Tool／call／Session／Run／Store 已核实后，为失败、取消及效果未知标注准确状态；工具拥有的解释使用简洁英文，[固定公开原因表](tool-failure-causes.ts)替代裸码，不用内部执行术语代替原因。未知的非空公开 `ToolResult.content` 作为低信任返回正文保留，不按单词、JSON 或错误码形状删除；没有正文时明确说明未返回错误描述。原业务正文和完整 Artifact 继续保留，不靠正文是散文还是 JSON 猜测是否已经表达失败，也不翻译或删除 stdout／stderr、MCP 业务数据及其他非英文原文。是否未派发只取 Core 的实际派发观察，不信任 leaf 自称未执行；确有未派发证明时明确本次未执行、本次 Tool 作用为零，不能误述为本次效果未知，也不否定此前操作的作用。人工拒绝另核原 human answer，不从裸码猜用户决定；Auto 拒绝核原成功审核的拒绝原因。完成决策被新用户输入替代时，下一模型明确获知旧决策已过期，须按当前任务重新判断；不据此自动重放原请求。[真实交错回归](../test/isolated/context/store.test.ts)核原取消回执、同一调用与来源及零派发。取消不证明回滚或后台已停，unknown 明确可能已有作用、须核原操作且不得重投。不把任意 details、私有 Error 或 cause 自动加入模型。后台结果 Source 保原来源，已识别的 Shell 与 child 以公开结果呈现，未知结构继续保原完整 JSON；不主动创建新 Model。原存储回执、机器状态、工具／协议版本和准确封存的旧 ModelInput 不改写。[实际 Runtime 回归](../test/isolated/execution/tool-failure-presentation.test.ts)核下一模型、原回执不变、call/source、未派发与已尝试的区分、私有数据和完整错误 Artifact；[失败子结果回归](../test/isolated/business/task/partial-child-failure.test.ts)核此前真实写入、读取及 Shell 诊断仍交给父模型且无重放。

准确内置 `read_execution_evidence` 的模型结果按当前任务、原 Store／Session／Run、执行 ID、状态及完整原结果重新核对，再复用原结果呈现；同名外部 owner 不借用这条能力。识别成功的目录及公开结果呈现不重复内部执行 envelope，不改变原 evidence Tool 的持久结果或原操作；不匹配的投影形状保原结果，实际正文完整性错误继续失败。原 Shell 输出内合法业务 `job` 等字段保持字节，不能按关键词清理。[实际证据读取回归](../test/isolated/execution/evidence-public-feedback.test.ts)覆盖准确原 Job／Tool、失败17、Unicode 两流、错误任务范围及同名外部 owner，以及压缩后完整、缺失、损坏和读取中取消的正文、未知子证据和外部业务字段保真，原操作只执行一次。

呈现在 [Runtime.modelMessages](runtime.ts) 中完成，早于输入封存、预算估算、续写／重试及压缩；只读 Inspector 读取当时封存的真实输入，不用今天的 formatter 改写旧快照。原 Message、ToolResult、Source、Artifact、邮件携带判断及结果接纳保持原内容和身份。没有生产配置开关或按搜索次数注入的提醒。回归见[真实 Runtime 呈现](../test/isolated/execution/model-result-presentation.test.ts)及[子取证](../test/isolated/business/task/child-tool-evidence.test.ts)。

只读上下文预测须核原 Run 捕获的呈现版本。无法取得准确动态定义，或重建工具正文与已封存输入不一致时，沿原 `context_estimate_unavailable` 返回，不能把原始长 JSON 误报为模型正在使用的短正文；也不为估算重新解析配置或调用模型。[预测回归](../test/isolated/context/result-presentation-estimate.test.ts)覆盖这条边界。

## 请求、派发与历史

1. Loop、内部 `ModelRequest.tools` 和持久工具输入保留规范 ID 与参数。Runtime 冻结注册定义及其模型配置，不按公开名称推断工具身份或权限。
2. [UnifiedExecution.model](execution/index.ts) 为本次准确选中的工具建立公开目录，再把公开名称、公开 schema 和已重建的模型历史交给任意 `ModelAdapter.stream`。转换不只在某个 Provider adapter 内执行，固定模型与自定义 adapter 同样接收该表面。
3. 完整返回的模型调用按本次目录查回原定义，并将公开参数转回内部参数后交给原持久和执行链路。未提供的工具、非法公开参数与转换冲突返回工具失败，不能进入真实效果；不完整流式参数也不能派发。
4. `ToolCall.model` 只记录原公开名称、实际发生改名的字段路径和必要错误码；内部 `ToolCall.name/arguments` 仍保存规范形态。下一轮由 `modelToolCall`／`modelToolMessages` 重建原公开调用，不咨询今天的定义，也不为每条历史复制整份 schema。
5. [Model metadata](model-snapshot.ts) 的 `context.toolSurface` 保存当时完整公开工具声明。内部 assembly 仍绑定原 ID/version；[Inspector 只读入口](runtime.ts) 从原请求和封存表面恢复当时模型所见，不拿当前目录补齐旧输入。完整正文、scope、EOF/hash 及原读取资格仍由 [Model body owner](model-body/README.md)核实。

参数校验失败时，Core 保持 `invalid_tool_arguments` 和零派发，在原失败回执的 `details.schemaError` 保存本次选中公开 Schema 的校验位置及说明，例如缺少 `version`。仅拒绝路径复用纯 Schema 编译缓存，不给成功调用增加一次校验、I/O、模型或等待；不回显实参值、任意对象 key、私有异常或完整 Ajv params。下一模型在 Core 已证实未派发时收到该具体反馈，已派发 leaf 自报的同名详情不加入呈现。原调用和封存输入保持，诊断失败沿原通用拒绝，不代填字段、扩大可调用范围或自动重投。验证见[参数投影](../test/isolated/execution/model-tools.test.ts)、[实际失败回路](../test/isolated/execution/tool-failure-presentation.test.ts)与[缺版本计划](../test/isolated/business/planning.test.ts)。

新目录不增加旧名称 alias；已保存模型调用按原 descriptor 还原名称和参数，不用今天的目录重写历史。内部操作身份、文件 `base` 和准确执行引用仍是必需合同；Shell 的新模型输入不含 key，改由原 Tool execution ID 派生，历史显式 key 和封存投影保持可解释；公开名称友好不代表执行去重、文件基线或授权可以省略。

上下文估算和压缩同样使用公开名称、schema 与历史；原实测 token 基线和新增消息必须采用同一种表示，私有 `ToolCall.model` 不计入实际模型输入。持久取舍见[模型工具表面决定](../../../.agents/notes/implemented/architecture/2026-10-18-model-tool-presentation.md)。

Shell 自动生成的 `shell_id` 是原已持久调用 ID 的无损短表示，当前 UUID 对应26字符；读取继续准确查原记录，不新增注册表、旧摘要读取或近似匹配。`shell_stop` 只让模型提供原 `shell_id`。宿主从本次Tool身份生成稳定取消Command ID，结果另给 `cancellation_execution_id`，不把接纳当成已停止。

可信 `RunConfiguration.modelHiddenToolIds` 只收窄该 Run 的模型目录：Runtime 冻结工具副本并设置模型隐藏，内部原定义、版本和每次派发权限保持。Service 在新 Native 统一浏览器配置中用它隐藏原子依赖，同时公开 `browser_execute`；子任务继承与恢复依据原冻结配置，不从今天的默认目录改写旧 Run。调用者的普通 Tool 参数不能声明这个宿主配置。回归见[浏览器配置](../../../apps/service/test/isolated/browser-execution-configuration.test.ts)。

当前 Task 冷恢复逐字核验原 Model 的完整工具目录、能力快照、指纹和 Source，不转换升级前的旧工具声明。说明、schema 或版本变化不能凭同名工具通过恢复；原输入和已完成历史继续按保存的 descriptor 读取，不改写为当前目录。[当前版本冷恢复回归](../test/isolated/recovery/child-message-resume.test.ts)核原审批和唯一效果，以及目录与快照漂移拒绝。

## 字段转换规则

`snakeCase:true` 只转换 JSON Schema 明确声明的 `properties`，并同步该节点的 `required`；组合分支按本次实际实参选择，仅保留激活且存在的字段规则。`parameterNames` 使用内部字段点路径指定公开 key，例如 `offset → start_line`、`limit → max_lines`，数组元素配置路径用 `*`，实际调用记录具体元素索引，避免改变 opaque 兄弟元素。记录的路径是输入字段位置，不是对象内容的搜索替换。

`omitParameters` 按内部顶层字段名收窄公开入口，`requiredParameters` 将已声明且未移除的顶层字段设为公开必填，不能添加不存在的字段。它们只约束本次模型 schema，合法输入最终仍转回原定义校验；当前六个协作工具使用各自的闭合 schema。

没有声明属性的任意 JSON 保持原样，包括 Task 的 `input`、prompt 的 `arguments`、远端 MCP schema 和 schema/default 等数据。模型投影不递归猜测业务 key，也不修改 JSON Schema 关键字。需要字段改名的 schema 若包含无法支持的 `$ref`，明确拒绝，不能只改表面或偷偷放宽校验。

`anyOf` 多个匹配分支产生不同字段映射时，该调用明确失败；`if/not` 谓词内的 `properties` 自身需要改名时，装配明确拒绝。只含 `required` 的条件和名称不变的 `kind` 判别仍支持。每份实际变换的 schema 独立校验，纯名称投影不重复编译远端 MCP schema，不合并不同工具的 `$id` 空间。

[model-schema.ts](model-schema.ts)仅按完整 JSON 内容复用模型参数投影与分支匹配的 Ajv 编译结果；每个 schema 仍有独立 registry 和私有副本，同 `$id` 的不同正文及本地 `$ref` 不混用。缓存按 LRU 最多128项，键串 UTF-8 合计1MiB、单键64KiB；超出接纳预算、非纯 JSON／访问器等情况保原完整编译路径，不拒绝工具。实际调用只消费本次同步校验结果，不缓存参数、字段映射、权限或文件事实。新 Run 的 schema 改动产生新键，旧 caller 修改 schema 不能污染复用结果。[缓存回归](../test/isolated/execution/model-schema.test.ts)核内容复用、引用隔离、修改、数量／键字节淘汰与非缓存路径；[参数投影](../test/isolated/execution/model-tools.test.ts)和[分支回归](../test/isolated/execution/model-tools-branches.test.ts)继续拥有目录、碰撞和 opaque JSON 语义。

[共享缓存原语](schema-cache.ts)只复用纯 JSON 内容键和上述 LRU 预算；Model 仍按内容读取新键，并以 `allErrors:false` 使用独立 registry。Tool／Extension 输入校验另由 `InputSchemaCompiler` 保持 `allErrors:true`：先以弱对象身份复用原 validator，只有所有对象与数组均冻结、无 `$id`／任意引用／`$schema`／锚点的匿名 JSON Schema 才按准确 `JSON.stringify`（保属性顺序）复用独立编译器。未冻结任一节点、布尔 Schema、注册／引用或不可缓存内容继续使用原共享 Ajv，保留 const／enum 对原对象的引用、跨定义引用和原编译错误；不按 Tool ID／version 合并。LRU 淘汰断开独立编译器的强引用，仍存活的 Schema 对象经 WeakMap 保留原 validator；不缓存实参或权限事实。[输入校验回归](../test/isolated/execution/schema-cache.test.ts)覆盖这两类身份、引用与错误边界、数量／键字节淘汰，以及实际 Runtime 封存后的 Shell Tool／Job Schema 资格。

显式公开名称须为最多 64 字符的 lowercase snake_case 标识。一次准确目录中的名称碰撞、同一对象的字段碰撞和不存在的显式字段路径均拒绝；`hidden:true` 只从模型声明目录移除，内部注册和可信调用资格仍由原合同核实，不通过隐藏授予额外权限。

同一对象跨 `allOf` 的字段声明按来源及替代分支选择核对，碰撞检测不依赖分支遍历顺序，也不枚举组合；互斥分支可分别使用可逆映射。只有名称变化的 MCP/自定义工具直接深拷贝原 schema，不遍历或重编译远端字段，合法空字段和 opaque JSON 保持。

## 当前公开名称

| 负责模块／内部工具 | 模型工具名称 | 主要字段选择 |
| --- | --- | --- |
| `files.read` | `read_file` | `offset/limit → start_line/max_lines`；工作区相对路径或准确外部绝对路径 |
| `files.write/edit` | `write_file`、`edit_file` | 完整基线使用准确 `base_ref`；正文与 `*_ref` 互斥；`expected_matches` 默认1 |
| `shell.execute/read/wait/stop` | `shell_execute`、`shell_read`、`shell_wait`、`shell_stop` | execute 默认前台，`background:true` 后台；顶层 filesystem/network；前台期限 `execution_timeout_ms`；key/cancellation/permissions/旧 timeoutMs 仅内部保留，旧 shell.launch 从新目录隐藏；workdir进入原审批与实际Job；read使用cursor，wait使用wait_ms，stop意图由宿主生成 |
| 普通问题、网页 | `ask_user`、`web_fetch` | 问题保留闭合 `{questions}`；网页使用 `max_chars/timeout_ms` |
| `task.spawn/message/follow_up/interrupt` | `spawn_agent`、`send_agent_message`、`follow_up_agent`、`interrupt_agent` | 创建使用 `prompt/task_name/preset`；后续协作使用稳定 `agent_id`，消息可明确 `target:parent`；不接受内部操作键、Provider 或 Run 身份 |
| `task.events/list` | `wait_agent_events`、`list_agents` | 事件使用 `work_refs/cursor/wait_ms`；列表使用 `agent_ids/cursor/limit`；当前及最近结果分别给出work_ref |
| `planning.read/write/review/update` | `read_plan`、`write_plan`、`request_plan_review`、`update_plan_progress` | 进度 Tool 由 owner 绑定本次 Run，不接受模型 `run_id`；模型用 `plan_ref/progress_ref/expected_plan_ref/file_base_ref`，宿主核原版本、摘要与进度CAS |
| `browser.execute` | `browser_execute` | `code` 与可选动作 `description`；页面句柄、引用和操作 key 由 [Browser owner](tools/browser/README.md)核实，原子依赖在新 Native 默认目录中隐藏 |
| `skills.load/resource` | `load_skill`、`read_skill_resource` | `id → skill_id`，可选 `version`；资源读取另含 `path`，不接受 `description` |
| MCP 来源／连接／刷新／搜索 | `list_mcp_sources`、`connect_mcp_server`、`refresh_mcp_catalogue`、`search_mcp_tools` | 来源目录用cursor；connect只填server_id；refresh用connection_ref；搜索只给一个准确可调用名与原schema |
| MCP 资源／提示 | `list_mcp_resources`、`read_mcp_resource`、`list_mcp_prompts`、`get_mcp_prompt` | list用connection_ref；read/get用resource_ref/prompt_ref；arguments省略为{}且远端业务key保持 |
| Worktree | `git_worktree` | create/remove使用snake_case、顶层filesystem和宿主意图；observe只读原operation_ref，不重放未知效果 |
| 动态 MCP Tool | `mcp_<server>_<remote>_<hash8>` | 来源和远端名称清理、转小写并限制片段长度，摘要绑定完整原身份；原远端 schema 与 RPC 名称/参数完全保留 |

Browser执行的 `description` 可选，省略使用宿主展示摘要；长说明仅在界面省略显示，完整原文随原调用保存，不进入浏览器代码，不再因10字符限制拒绝执行。两个Skill读取入口不要求执行描述。远端MCP／自定义工具的业务参数不改名或注入展示字段。

文件、Shell、Task 和 MCP 的完整参数、输出与生命周期分别归各 leaf README；本表不是另一份执行 schema。目录查看、文件查找与正文搜索由 Shell 完成，搜索使用内置 rg；原三个文件检索模型工具和五个验证工具已删除，历史记录不会重新开放它们。MCP 搜索范围不因改名扩大。

Files 的目录与检索 API 仍服务客户端文件候选等内部读取，不注册为模型工具。read_file 的结果呈现、完整正文和分页归 [Files owner](tools/files/README.md)。spawn_agent 的默认及开放 preset 说明取实际注册角色，不从名称猜能力；当前目录和封存表面分别表达现在与当时事实。Shell 本地引用缺失由 [Shell leaf](tools/shell.README.md)返回有限失败，不改变派发状态或未知效果。

## 工具选择与职责

普通宿主的实际默认目录来自 [Service defaults](../../../apps/service/src/configuration-defaults.ts)：不含可选 Browser 的基础模型目录在具备合格 Shell 时为17项，不具备时为13项，包括 Files 读写三项、图片读取、问题、网页、当前任务证据读取及协作六项；其中 read_file 支持准确工作区外路径，有效 Full 下的 write_file/edit_file 也支持普通外部修改。宿主允许 Browser 时另选择对应浏览器能力；新 Native 默认对模型提供 `browser_execute` 与两个 Skill 读取入口，原子依赖保持内部隐藏。最小嵌入配置仍只默认提供问题工具。名称表同时列可选能力，不是每次 Run 的固定清单；Planning、Skill 和 MCP 仍按配置、能力及权限选择。旧 Task 工具和专用 required-result 机制已删除，不保留内部兼容入口。

工具按独立操作及可观察结果划分，不把模型填写的结论包装成事实来源。研究状态工具及其 records/context、权限例外和导出入口已撤回。计划工具管理步骤、批准和版本；专用验证工具已移除，检查通过普通 Shell 执行并如实报告。

`wait_agent_events` 仅向主 Agent 提供事件摘要与游标，子 Agent 的模型目录不含此工具；发送消息不需要另等确认。`list_agents` 可以重新取得最近一次终态的完整子报告，包括由原 Artifact 核身份后展开的正文；旧自动 Source 被压缩后，新的目录调用仍能重新带入该正文。它不选择任意历史轮次；当前 queued/running/waiting 状态可能仍携带上一轮结果，不能将其当作本轮完成。完整报告可读、结果接纳、最终主张有依据分别由原 Task 合同和实际证据核实。

## 验证边界

验证应捕获实际 Adapter 收到的公开名称/schema，发出公开调用后核对真实内部定义和准确参数，再核下一轮历史与 Inspector。当时定义变化、同名碰撞、非法字段、opaque JSON、大正文及拒权零效果分别验证，不能只比较两份同源 schema。

验收入口包括[真实 Runtime 与上下文基线](../test/isolated/execution/model-tools.test.ts)、[组合分支](../test/isolated/execution/model-tools-branches.test.ts)、[真实 Service 读改与审批](../../../apps/service/test/isolated/configuration.test.ts)、[模型快照](../test/isolated/model-snapshot/metadata.test.ts)、[Inspector](../test/isolated/model-input/inspector.test.ts)、[MCP 实际调用](../test/isolated/mcp/mcp.test.ts)、[MCP 搜索](../test/isolated/mcp/interactive-discovery.test.ts)与 [资源模型提示](../test/isolated/mcp/resource-model-source.test.ts)。其中 CamelCase MCP 用例通过真实 stdio 核公开名小写、原 schema 的 `projectId` 和 RPC 的原远端名称/参数保持；其他受影响固定模型 fixture 使用当前公开合同，旧内部名调用不是兼容资格。

[真实模型工具测试](../../../tests/e2e/live/model/README.md)另以显式门禁调用现有默认模型，使用合成工作区验证文件读改写、公开历史和单子任务的准确等待/结果。它不进入默认测试发现；运行次数、超时、凭据和报告边界归该入口。固定模型与本机 HTTP 的通过不能替代真实 Provider 结果，真实单模型通过也不外推其他模型。


Skill Workflow 的六个工具和专用外部文件三个工具已移除定义及宿主装配；旧名称没有 alias。`read_file` 的外部读取由 [external-file-reads](tools/external-file-reads.ts) 在同一定义下核准确授权与原生身份，不做外部项目指令发现；普通外部修改仅由 [Full 适配器](tools/full-access-files.ts)在最终有效 Full 下复用 write_file/edit_file，其他模式沿原 Shell 独立申请链路，不新增 Files 权限参数或审批入口。

纯模型元数据可声明 `model.inputSchema`（内部字段名）。表面投影对该Schema做闭合校验，Core仍按准确Tool的inputSchema校验实际输入。当前仅Browser需要同时保留统一入口的内部显式步骤与公开引用入口；公开Schema不开放内部key/generation/seq。没有新执行前处理器、权限缓存或旧模型字段读取。准确引用与原回执范围的取舍见[准确引用决定](../../../.agents/notes/implemented/architecture/2026-11-08-model-tool-exact-references.md)。
