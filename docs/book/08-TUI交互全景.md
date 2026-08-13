# 第八章 TUI 交互全景

## 8.1 任务输入

```text
用户提交输入
  → App 校验当前 overlay / interrupt / run 状态
  → SessionRuntime.runTask()
  → buildRunAgentParams()
  → runRuntimeAgent()
  → AgentEvent 流
  → reducer / blocks / status
```

多行输入、粘贴、软换行、宽字符和终端 resize 由 InputLine 与专用 hooks 处理；这些行为不进入 Core。

Windows 启用沙箱时，TUI 在主输入界面挂载前只读检查受管联网身份。首次安装会显示独立的 sandbox
setup/exit onboarding；只有用户确认 setup 才请求 UAC。进入主界面后的普通 Shell invocation 不负责安装。

Session logging 默认以 `metadata` 运行，TUI 不显示普通 mode 状态；只有 `content` 显示 artifact
许可与用户显式 opt-in 的披露。Logger 失败只显示一次脱敏诊断，不改变当前 Agent run。

## 8.2 运行中的结构化交互

| 交互              | Runtime 行为                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------- |
| 工具审批          | `approval` interrupt → approve/reject/cancel → RuntimeUserAction；批准单个调用后立即执行 |
| 用户问答          | `input` interrupt → 文本/结构化 answers → 恢复 Agent；Esc 只取消本次回答                 |
| 计划审核          | `plan_review` interrupt → approve/revise/cancel；cancel 中止当前 turn 并保留 draft       |
| Verification 决策 | replan、compensation 或带理由 waiver                                                     |
| Subagent 审批     | 保存 continuation；自动审查或用户决策通过后恢复                                          |
| 取消              | AbortSignal 传播并形成一致的终止/恢复状态                                                |

工具的 `tool.queued` 只在 reducer 中保存 name/args，不进入消息列表；收到 `tool.started`
后才物化 Tool Card。待审批调用只显示在 Footer 的“工具类型 · 工具授权”中：命令或工具直接作为独立引用块，
决策使用“主标签 + 影响说明”的等距列表；未获准调用不得提前出现在消息列表。多个 Shell
调用分别审批，任一调用获准后立即进入执行，不等待其他 sibling 审批完成。
Subagent 内部工具审批由 parent `task` Tool Call 持有 Runtime interaction，同时在 payload 和 continuation 中保留 child Tool Call 身份。Footer 以 parent id 匹配批准或拒绝终态并立即关闭，再由 child id 恢复准确工具；两种身份不得混用。
消息区的 Subagent block 将 suspended 阶段显示为“等待自动审查”“自动审查中”或“等待你的批准”；
前两种不弹出人工 Footer，只有最后一种表示用户必须作出决定。自动或人工批准后 block 回到 running。

工具终态的颜色、状态、恢复提示与耗时统一读取 Runtime 投影的 `ToolOutcomeV1`，不再从错误正文、
退出文本或交互类型猜测。人工审批拒绝、auto-review 拒绝、timeout、cancel 与普通执行失败保留各自
稳定语义；同一 terminal event 只生成一张 Tool Card 和一条模型 Tool Result。私有 recovery key、
fingerprint、lineage、工具参数和错误正文不会进入 TUI metadata 或下一次 Provider 请求。

工具授权、用户提问和方案审核可见时，Footer 暂时隐藏模型、思考级别、cache、context/token
和权限模式等全局状态，只保留当前交互与快捷键；交互结束后按最新状态恢复，统计数据不重置。

交互 Overlay 使用统一四区骨架和词汇：列表移动为“导航”，列表进入子页为“打开”，操作菜单为“选择”，产生决定或副作用为“确认”，多步表单推进为“继续”，子页退出为“返回”，根 Overlay 退出为“关闭”。标题、摘要、分组、问题/警告、字段标题、正文、选项、输入行、消息和快捷键之间的区域间距由共享 contract 统一约束；所有快捷键提示统一使用浅色非粗体文本，页面不得用空白 `Text` 修补。业务取消仍明确显示“取消”，不能用“关闭”掩盖审批拒绝、问答取消或 turn 中止语义。

Esc 不等价于静默成功：overlay 关闭、审批拒绝和任务取消根据当前交互类型显式处理。工具审批或 plan review 被拒绝/取消时，Runtime 取消尚未终结的 sibling 与正在执行的调用，写入 `turn.aborted(cause=user)`，本轮不再调用模型；`ask_user` 的 Esc 只形成该工具的取消结果，模型可以在同一 turn 继续。

## 8.3 斜杠命令

Slash command 由 `useSlashCommand`、suggestions 和 reducer 协作完成，可进入会话、模型、模式、MCP、Skill、帮助等产品功能。命令只是 App 入口；涉及 Runtime 状态的操作仍通过正式 action/event 边界执行。任何 `approval`、`input` 或 `plan_review` interrupt 可见时，slash 候选面板必须隐藏；已经打开的帮助、模型、权限、推理、主题、会话、MCP 或回退选择器也必须关闭。interrupt 是唯一的决策界面，避免它与其他界面同时占用键盘焦点。

内置命令的候选、参数提示和帮助清单共用 `SLASH_COMMAND_DEFS`，当前覆盖 `/effort`、`/model`、`/theme`、`/sessions`、`/new`、`/plan`、`/compact`、`/permissions`、`/mcp`、`/rewind`、`/export`、`/context`、`/clear`、`/help` 和 `/exit`；别名附着在同一条定义上。命令名执行不区分大小写。`/permissions`、`/effort` 和 `/theme` 不接受显式选择参数，直接确认命令后打开各自选择器；没有沙箱后端时，权限选择器显示 `full` 的能力说明但禁用它，不能切换到 Full。

模型选择器以 provider 与 model name 的组合区分 route；选择器将 provider 作为使用独立 accent 色的加粗标题行，并与 model name 文本列对齐；标题与首项紧邻，不同分组之间留一行间距，模型行不重复 provider 或显示 `default`。`/model` 不接受模型名参数，确认命令后始终打开该选择器，由用户明确选择 provider 与 model；选择结果绑定到当前会话，并以 `model: "provider:model name"` 简写写入用户配置作为新会话默认值。切换或恢复会话时还原各自 route；空会话切换模型不显示系统提示或工具目录产生的 context token 估算，新会话清空上一会话的 context snapshot。加载用户配置时仍兼容旧 `model.default` 对象格式。

`/mcp` 是静态候选命令；输入 `/m` 或 `/mc` 时，候选面板显示“管理 MCP Server”，并支持 Tab、右方向键和 Enter 补全。命令不接受 Server 参数或管理子命令，管理动作只在 Overlay 的可见 Select 中执行。MCP Prompt 使用独立的动态 `/mcp__<server>__<prompt>` 命令。

`/release` 是只读发布状态入口。普通开发 TUI 没有 artifact authority，因此固定显示
`artifact_disabled` 与 capability unavailable；该输出不启用 Release Profile，也不能作为
Sigstore、平台 qualification 或 production Gate 证据。

`/telemetry` 同样只读，显示 artifact authority、metrics flag、consent、endpoint policy、exporter
和 disk-spool 状态，不显示 endpoint secret。普通开发 TUI 固定为 `artifact_disabled`，该命令不能
开启 telemetry、授予 consent 或创建 exporter。

## 8.4 Session 与恢复点

会话选择、删除、重命名、恢复点 restore 和 fork 基于 Runtime Store，而不是旧图 checkpoint。会话选择器把搜索行作为独立区域，与紧凑的结果列表之间保留一个空白行；删除确认在选项下方动态说明会删除的本地会话范围及不会删除的工作区文件。切换会话不会把一个 thread 的授权、pending approval 或 transient binding 隐式复制到另一个 thread。TUI 的交互模型把切换/新建会话视为取消当前可见 turn：先持久化取消事实并等待旧生成器清理，再切换展示；其他客户端可以按 ADR-0050 保留后台运行语义。

`/compact` 触发上下文压缩并支持可选的自定义摘要指令（例如 `/compact focus on auth changes`）。手动与自动压缩都把 preparing/summarizing/validating 动画显示在消息区，并在压缩期间保持普通输入可编辑、可提交；提交后的同 session 写操作继续等待 Runtime 单飞 barrier。手动流程显示 `/compact` 且隐藏不属于该命令的 Agent run 状态；自动流程从持久化 request 事件显示只读语义消息 `/auto-compact`，同时保留当前对话的 Agent run 状态。`/auto-compact` 不属于可调用 slash command。active checkpoint 已覆盖最新安全消息时，无论是否带自定义指令都直接提示 `No new messages to compact.`，不再次调用摘要模型。自定义指令只改变包含新 safe history 的压缩侧重点。连最小 narrative 都无法节省 1024 tokens 时显示 `Not enough reducible context to compact` 且 Provider call count 为零。命令或语义命令通过不进入模型 transcript 的 RuntimeEvent 持久化；压缩成功、失败或历史不足的结果同样由 RuntimeEvent 保存，因此退出并重新进入 TUI 后仍可重放。同一 session 的手动压缩完整串行；stale projection 产生明确可重试终态，不会留下 pending。切换 session 会清除当前 inline progress，加载或重新进入持久化 session 也会丢弃上一展示会话的瞬时 compaction progress；晚到 terminal 缓冲到命令所属 session。删除 session 前必须取消并等待 standalone compaction，RuntimeStore CAS 同时拒绝删除后的晚到写入。会话切换期间，`onCompactRef`、`handleSlashCommandRef` 和 `mountedRef` 保持 handler 最新；异步结果只更新发起命令的 thread，不得写入后来切换到的会话。

`/rewind` 使用“选择边界 → 确认范围”两阶段面板。列表以恢复点之后的第一条用户消息描述
“发送这条消息之前”，显示消息摘要、绝对时间和已记录文件数，不暴露 event / snapshot ID。
Enter 只进入确认层；确认层默认选择“恢复代码和会话”，并提供“仅恢复会话”“仅恢复代码”。
当前范围下方动态说明会创建或保留的会话及工作区代码边界。会话恢复统一 fork 新 thread 并保留源会话；代码恢复按文件
原像修改共享工作区，当时不存在的文件删除。单个文件失败会逐个提示；手动或 Bash 修改
同一路径后，当前内容不再匹配 Kite 最后写入指纹，恢复会跳过该路径并提示冲突。缺少后像
指纹的旧记录同样不会盲目覆盖。Fork 会保留选中边界及其之前的恢复点，因此进入恢复出的
新会话后可以再次 `/rewind`，继续向更早的消息边界回退。恢复点必须对应完整结束的 turn；
确认提交和异步执行分别防重，任一恢复范围在修改会话或文件前都验证恢复点存在且快照可解析。
恢复出的新会话回到默认授权，不继承 full access、命令 grant、瞬时 capability binding 或
Provider session waiver。
正常完成的 `run.completed + turn.completed` 即使以 batch 原子提交，也必须生成同一个命名恢复点。

`/context` 是只读诊断命令，显示 system、当前工具 schema、checkpoint summary、live transcript、动态 Runtime 和 provider framing 的同源 token 投影。它与正常模型调用和 compaction acceptance 术语（压缩验收）共用 Runtime 的 projection environment resolver 术语（投影环境解析器）及当前 adapter metadata 术语（适配器元数据）解析出的模型能力，因此当前 MCP binding、tool search、workflow skill、active inline skill instructions 和真实模型窗口必须计入估算。`/compact reset` 不以本地 hard threshold 术语（硬比例阈值）做容量门禁；重置后下一次真实调用是否被接受由 Provider 术语（模型供应商）决定。

进入或切回历史会话时，TUI 从恢复的 RuntimeState、active checkpoint 和当前 projection environment 本地重建 Footer context snapshot，不调用 Provider。Footer 的绝对 token 数、`/context` 与 `/compact` 使用同一份当前请求投影；累计 cache hit/miss 与 usage 继续独立持久化，不因切换会话而重置。

TUI 的 token stats 连接与 RuntimeStore 共用同一数据库时必须采用 Core 提供的统一 journal mode；Windows 为 DELETE，其他平台为 WAL。长期 stats 连接保持打开期间，RuntimeStore 仍须能够打开、持久化和关闭，不能因两个连接各自设置 journal mode 而在启动时报 `database is locked`。

## 8.5 MCP 与 Skill 交互

MCP Overlay 订阅 Core control snapshot。Server List 按“数量/配置范围摘要 → 项目或用户分组 → Server 主次行 → 添加入口 → 分隔后的快捷键”展示 effective Server；名称与带语义色的连接状态位于同一主行，配置路径与 capability 数量位于次级行。Enter 打开只读 Detail，先展示状态、传输方式、能力和配置位置，再展示按 config/auth/health/diagnostic 动态生成的操作区。操作区在普通连接动作与禁用/移除组之间留一行，并在选项下方动态说明连接中断、配置保留、认证隐私或远程数据不受影响等边界，紧凑 action 列表通过 `OverlayChoiceList` 的辅助文本渲染边界说明。工具子页以工具数量和 Server 名称组成摘要，摘要与编号列表间留一行，选择前缀不改变编号列对齐。所有 MCP 业务流程统一使用 `↑/↓/Enter/Esc`，不使用 `A/L/R/D/Space` 等功能键。模型可调用能力仍来自 revisioned catalog/binding，而不是 UI 选中状态。

项目 Server 尚未批准时出现在 `/mcp` 的“需要审批”状态行。Detail 的“审核服务器”进入脱敏审批页，默认选择“稍后决定”，并提供“批准并连接”与“拒绝服务器”；决定继续绑定当前 config digest 并执行 TOCTOU 复核。批准属于 MCP control plane，不是任务 Runtime Tool Approval。

HTTP Server 真实进入 `login_required` 或 `reauth_required` 时，Detail 提供“认证”。认证页只有选择“打开浏览器”才启动 loopback callback 并调用系统 browser opener；authorizing 时 Esc/“取消认证”取消当前 flow。页面不显示 token、scope、authorization code 或 secret，成功认证只影响后续 discovery 与新 model turn，不重放旧 Tool Call。

开启 `mcpProviderActionV1` 后，Runtime 可在 Tool 失败后请求固定的 Login、Approve 或 Retry Provider Action。TUI 复用既有 input interrupt 收集决定并委托 MCP controller；成功恢复只开始新 turn，Later 或恢复失败都不会重放旧 Tool Call。新任务首次模型调用前还会对 unavailable required Provider 逐个显示 Retry、Session Waive 或 Cancel Run，waiver 只解除当前 session 的准入门禁。

Add Wizard 只收集 transport、name、URL/command 和 availability；选择式步骤的问题与首个选项之间保留一个空白行，选项组内部保持紧凑。Current project 写 `<project>/.kite-code/mcp.json`，All projects 写 `~/.kite-code/mcp.json`。Detail 可 retry/reconnect、enable/disable 和 remove；disable/remove 使用安全默认确认，remove 同时尝试清理对应本地 OAuth credential。高级配置、legacy migrate、Tool policy 和手动 reload 不进入 TUI。

Skill 命令触发正式 activation，不能把 SKILL.md 正文直接拼接到用户任务。

`tool_search` 在对话区渲染为 "Searched for tools"，搜索结果以 `Provider · Tool` 树展示。`list_mcp_tools` 渲染为 "Listed MCP tools"。

## 8.6 终端稳定性

交互式 TUI 运行在终端主屏缓冲区中，不启用 Ink alternate screen；输出保留在终端原生 scrollback 中，退出时不恢复旧主屏。Ink 交互模式由真实的 stdin/stdout TTY 能力决定，CI 环境中的真实 PTY 仍保持输入与持续渲染；非 TTY 输入或输出不强制进入交互模式。关键质量边界还包括 DEC synchronized output、无应用内 viewport culling、静态内容引用稳定、Footer resize、输入光标和 mixed-script wrapping。Spinner 帧由 elapsed time 的纯函数确定；测试使用受控时间验证帧序列，不依赖真实事件循环恰好在 120ms 内调度。对应规则位于 `docs/active/tui-*.md`。

`/exit`、双 Ctrl+C、SIGINT、SIGTERM 与 fatal ErrorBoundary 共用一个幂等退出协调器。退出会先停止当前
Runtime、等待 reporter flush 与 exporter shutdown（两个阶段各最多 250ms），再释放 SessionManager、
unmount Ink 并退出；任一清理阶段失败都不能跳过后续终端恢复。正常退出使用状态码 0，fatal path 使用
状态码 1。开发 composition 没有 telemetry authority 时 reporter 仍为 no-op，但沿用相同生命周期。

`/permissions`、`/effort` 与 `/theme` 直接确认时分别打开 interaction mode、推理深度和主题选择器，
确认某一项后才改变值；三者都不接受选择参数。所有 slash command 打开的 Overlay 显示时隐藏底部
状态栏和输入提示。推理深度确认后会立即刷新 Header 和 Footer，并作为下一次模型调用的 reasoning
effort。当前 sandbox backend 不支持 Full 时权限选择器禁用该项。
production execution status 只由 CLI `--execution-status` 查询，避免把普通开发 TUI 的模式选择误解为
release capability 或授权。
