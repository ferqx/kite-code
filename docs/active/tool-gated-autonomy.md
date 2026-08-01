# 当前规则：Capability 执行与工具自治边界

状态：active

读取时机：修改工具路由、Capability binding、Tool Controller、副作用分类、审批、authorization、sandbox、MCP/Skill/Subagent 执行或最终完成条件时。

验证：`bun test tests/runtime/tool-controller.test.ts tests/runtime/resource-budget-admission.test.ts tests/runtime/concurrent-shell-cancel.test.ts tests/runtime/scheduler.test.ts tests/tool-policy.test.ts tests/tool-definitions.test.ts tests/policies/approval-policy.test.ts tests/policies/mode-policy.test.ts tests/execution/gateway.test.ts tests/subagent-approval.test.ts tests/runtime/verification.test.ts tests/sandbox/network-boundary.test.ts tests/sandbox/network-boundary-concurrency.test.ts`、`bun run typecheck`。

相关：`authorization.md`、`mcp-runtime-governance.md`、`verification-governance.md`、`cancel-resume-cleanup.md`、ADR-0007、ADR-0008、ADR-0042、ADR-0048、ADR-0049。

## 统一执行链路

```text
模型 tool call
  → 解析静态工具或 Runtime-issued binding
  → 校验 turn / token / capability revision / schema
  → 分类 effective effects
  → RuntimePolicy
  → auto review 或用户审批
  → sandbox / network boundary
  → provider adapter
  → ExecutionReceipt + RuntimeEvent
  → 必要时 Verification
```

工具声明只让模型表达意图。模型侧不得直接执行工具，TUI 不得绕过 Tool Controller 调用 provider。

`resourceBudgetV1` 启用时，策略/审批仍先于 child reservation；只有调用已经可执行时才原子写入
reservation，再单独写入 `dispatch_started`，最后进入 adapter。Subagent parent 只代表一次
lifecycle attempt，child 模型及工具/Shell/MCP 调用各自链接独立 reservation；artifact bytes
计入产出它的 tool/MCP reservation，不另建一个虚构 invocation。child tool/shell permit 使用
durable FIFO waiter、原子 promotion + reservation 与有界 wait deadline；超时通过主 Runtime 的
canonical failure terminal 收敛，不转换成普通 child tool error。
本地 Provider 最终 gate 明确拒绝且能证明未 dispatch 时可携带证明 release；已经执行部分
command/MCP check 的组合 Verification 必须转 `unknown`，不能整体退款。`resourceBudgetV1`
开启但 `boundedCancellationV1` 关闭时，模型不披露 writer、Shell 或 child capability，
Controller 也必须拒绝直接执行，不能退回无界副作用路径。

sealed `ExecutionBoundaryV1` 还会在 dispatch 时派生逐调用 network policy。当前 `web_fetch`
对 robots、正文和每个 redirect hop 分别做 DNS/endpoint admission，并在 socket 前持久化
`network.admission_decided`；Tool Result 只携带 policy revision、receipt digest 和 typed failure。
feature 关闭、决定无法持久化或 controller 不可用都 fail closed。因为当前没有可证明的跨进程
host allowlist，Shell/Skill descendant 固定 network-off，MCP inventory/resource/tool 与可能触发
Provider readiness 的 `tool_search` 在 Controller provider lookup 前拒绝；审批或 `full` mode 不能
把这些路径提升为 `allow_all`。

在非 sealed 开发路径中，remote HTTP MCP 的非空最终参数还必须通过独立 content-egress
permit；read-only effects、Tool Approval、`full_access`、Provider consent 或 host allowlist 都不
能替代。Controller 在 readiness 前拒绝确定性的缺失/过期/mismatch，Manager 在 SDK dispatch
前原子消费 nonce 并等待 durable `mcp.egress_decided` receipt。stdio 与空参数 HTTP 调用不消费
remote content permit；项目配置不能降低保守分类。

Shell 执行的 `onShellProgress` 必须在命令仍处于 running术语（运行中）状态时直接发布 `tool.progress`，Runtime event sink术语（运行时事件接收器）随即把增量交给 TUI；不得先缓存在 Controller 私有数组中等待终态结果。同一批并发 Shell 的增量允许按真实到达顺序交错，但每条事件必须保留各自 `toolCallId`。未提供 event sink术语（事件接收器）的直接调用兼容路径仍在返回数组中收集事件。

## 工具名单单一事实源（ADR-0043）

阶段 2 的 computer、coordination、interrupt 与 runtime action 静态工具也已完成 Registry 单路径切换。`task` 的 role-based effects、子 Agent 依赖和结果传播由 spec 驱动；`tool_search` 在 spec 内完成 feature gate、inventory redirect、provider readiness 重试、候选裁剪和 `capability.search_completed` 事件投影；`ask_user` 以 `kind: interrupt` 注册并仍由 controller 产生 `user_input.requested`。

事件型 ToolSpec 可通过 `ProjectedToolResult.runtimeEvents` 产出 Core Runtime 事件；controller 只追加这些结构化事件，不得重新计算 capability search、Skill activation 或 Plan 状态结果。该通道只引用 Core 事件类型，不引入 App/TUI 依赖。

ToolSpec Registry 阶段 3 进一步以统一 helper 原子追加这些事件并生成 terminal Tool
Result。Controller 不得构造 `plan.drafted`、`plan.review_requested`、
`plan.progress_updated`、`plan.completed`、`skill.activation_started` 或
`skill.frame_closed`；该所有权由 Registry conformance 测试守护。Skill activation 的
disclosure、approval 与 fork adapter 仍属于 Controller 的跨领域治理边界。

`read_skill_reference` 与 `complete_skill` 已迁入 Registry：spec 校验当前 task 的 active frame、Skill revision 和 compiled contract；reference 读取继续限制为声明文件、非 symlink、Skill 根目录内且不超过 128 KiB；completion 在 output schema 验证后投影 `skill.frame_closed` 与可选 verification 事件。

`activate_skill` 也已迁入 Registry：controller 保留 disclosure、approval 与 mode-policy 前置治理；spec 负责 activation validation、inline/fork 生命周期、fork 结构化输出校验、frame close 和 verification 投影。fork 子 Agent 仅作为受治理 provider adapter 注入。

`read_plan` 已作为 `runtime_action` 接入 Registry：spec 只接受当前 Task 的 active plan identity 与版本，可选 structural digest 必须匹配，并从不可变 Plan Artifact 返回完整文档；controller 不再重复解析或读取 Artifact。

`update_plan` 也已作为 `runtime_action` 接入 Registry：spec 限定 building/executing 状态，校验 plan identity 与稳定 step ID，拒绝在仍有 pending/in-progress 步骤时完成计划，并投影 `plan.progress_updated`、可选 `plan.completed` 与模型结果。

`write_plan` 已作为 `runtime_action` 接入 Registry：spec 保持 save→submit 两阶段 Artifact 协议、幂等保存、版本冲突、replan 元数据、review interrupt 和同批后续调用取消；模型表面不再携带 execute，controller 只追加 spec 投影事件，并仅在 save 立即完成时写入 `tool.finished`。

静态工具的 Schema、契约、副作用分类与执行器收敛到 ToolSpec Registry（`src/core/tools/registry/`）。六个计算原语 `read_file`、`search_content`、`search_files`、`write_file`、`edit_file`、`shell_execute` 已完成切换，迁移 flag 与旧执行器不再保留。一致性不变量由 `tests/tools/tool-registry-conformance.test.ts` 棘轮守护：Policy 分类引用的工具名必须是已知名单；模型 ToolSet 不得携带 `execute`；写工具必须声明 mutation scope。write_file 同批落地 ADR-0042 §2；edit_file 同批落地 ADR-0043 §3 与 ADR-0042 §1。shell_execute 的模型参数仅保留 `command`、可选 `description`、可选 `timeout_ms`；未提供 `timeout_ms` 时 Registry术语（工具注册表）必须向执行器传递 600000ms 默认硬超时，显式正整数可以覆盖；副作用、只读免审和审计 `action.intent` 全部由命令形态派生，审批 payload 不接受模型建议授权或 prefix rule。i10 以 `ls`、`pwd`、`git status`、`git diff --stat`、`rg` 语料守护真实 Approval Policy 的免审命中率。

生产静态模型工具面必须直接由 `builtinToolRegistry.toSchemaOnlyToolSet()` 投影；`definitions.ts` 只负责构造不可变的可用性快照并合并 Runtime-issued MCP bindings。默认开发入口继续暴露完整投影；production surface 必须逐项按 `network/process/write/shell/skillChild/localStdioMcp` 独立收窄，并同时检查 Capability Descriptor 的 declared/effective effects。Runner 在 dispatch 前重复同一检查，防止仅在模型 disclosure 层收窄；`process=true` 不能提升 `write=false` 或 `network=false`。原生 sandbox Shell 由显式 `process + shell` surface 接管其保守的 `unknown` descriptor；进程内 writer/network 工具仍按各自 effect 被拒绝。`verified_in_process_read_only` 进一步要求密封 qualification catalog 中的 capability ID、descriptor revision 与只读副作用契约完全匹配，并省略动态 MCP；这不是第二份 Registry。该快照包含 feature flags、task adapter、Tool Search、Skill catalog 与 active frame 可见性，并同时用于执行前的静态调用解析。工具表当前不做模块级缓存，避免长进程无界增长与运行中配置变化复用陈旧表面。Builtin Capability Descriptor 包含规范化输入 Schema，因此 Schema 变化必须改变 revision。静态工具进入审批与模型队列时，副作用分类优先且必须来自 `spec.effects()`；手写名称分类器仅用于动态或历史状态的保守回退。

`ToolSpec` 按 kind 构成可辨识联合：`computer`、`coordination` 与 `runtime_action` 具有 `execute/projectResult`；`interrupt` 只具有 `createInterrupt`，类型上不得出现执行器或结果投影。Interrupt 的模型输入与中断协议输出可以是不同类型，但转换只能发生在 `createInterrupt()`。`ask_user` 因此只能由 Tool Controller 创建 `user_input.requested`、不能误入 Registry dispatch；模型只提交 1-3 项的规范 `questions` 数组，每项提供 2-3 个 `{label, description}` 选项，单问题同样使用数组。`askUserSpec.createInterrupt()` 负责生成稳定 ID、将第一项标为推荐并启用客户端自由输入，Controller 不得手工组装中断内容。子 agent 审批恢复路径的 `task` 结果同样复用 `taskSpec.projectResult()`，不存在第二份手写 task 结果格式。

Registry dispatch 在执行后注入已解析参数（`invocationInput`，类型化且恒等于 Schema 解析结果）并调用 `projectResult()`，其输出是静态工具模型内容、`resultMeta`、展示提示和 Runtime events 的规范来源。Tool Controller 对 runtime action、Skill 与 Tool Search 直接以该投影生成 `tool.finished`；Tool Runner 对 read/search/edit/write/shell/web_fetch 与 MCP inventory/resource 同样直接消费投影，不得再次按工具名重算 diff、截断、mutation scope 或 raw digest。产出双路模型就绪文本的工具经投影的 `streams` 字段逐流处理：shell_execute、search_content、search_files 逐流截断且失败时 stdout/stderr 两路保留；MCP 清单/资源三件（list_mcp_resources、list_mcp_tools、read_mcp_resource）逐流透传，结构化载荷（含 stale_cursor 等结构化拒绝）保持在 execute 产出的原流。单流工具（read_file、edit_file、write_file、web_fetch、task、Skill/Plan/Tool Search）以 `modelContent` 为唯一模型通道，Runner 按 ok 分流到 stdout 或 stderr。执行适配器仍可负责读取指纹、文件原像、permit、network mode 和授权来源等治理事实，但不得覆盖 spec 已投影的结果语义。

## 自治规则

1. 普通问答不使用全局 stop-check；没有未决 Effect 或 required verification 时可直接完成。
2. Read-only Builtin（`read_file`、`search_content`、`search_files`）在工作区内可按 mode 直通；路径指向工作区外部时需用户审批（`externalRead` effect），与 `write_file`/`edit_file` 的外部路径处理一致。外部性判断前，路径参数先经 MSYS2 归一化（`msys2ToWindowsPath`，非 Windows 透传）——否则 Windows 上 `/c/proj/...` 形式路径会被 `resolve()` 挂到当前盘符，工作区内路径被误判为外部。该归一化与 `resolvePath` 的 MSYS2 防御层（见 [[file-reading-shared-boundary]]）口径一致；`tool-runner` 的 `isExternalPathArg` 同样先归一化再判定 `allowExternal`。
3. `accept_edits`、`auto`、`full` 只决定交互策略，不取消 capability schema、revision、minimum approval 或 sandbox 检查。
4. Authorization grant 只在声明的 thread/workspace/command 范围有效；新 thread 不继承单次授权。
5. Destructive shell 与未知外部副作用保持保守边界，不能因 full access 或 same-command grant 自动放行。
6. 批量 tool calls 必须逐个进入相同策略；一个只读调用不能掩盖同批写入调用。连续调用仅在
   每项都已持久化为 `read_only + sideEffect=false`、属于无交互语义的内置读取工具且
   Approval Policy 再确认无需审批时，才可组成最多 4 项的并行批次。`ask_user`、Plan/
   Skill/Task/Tool Search、动态 MCP、已审批恢复、写入、未知分类和需要审批的调用都是
   独占屏障；屏障后的读取不得越过它。同一模型消息、同一任务中的连续
   `shell_execute` 逐项完成策略预检与审批；任一调用一经批准就立即启动，Runner 可在它
   运行期间继续请求下一个 sibling 的审批，后一个获批后同样立即启动。单个调用的策略拒绝
   只终结自身；用户拒绝或取消任一工具审批时则中止整个当前 turn：审批目标 rejected，
   其余未终结 sibling cancelled，已启动执行收到 AbortSignal，Runner 不再继续审批、执行
   或调用模型。策略拒绝和系统失败不套用这一用户取消语义。Shell 重叠在非 Shell 调用、
   不同模型消息或不同任务边界处截断，不得
   跨越 `ask_user`、方案审核或其他工具；`tool.execution_ready` 只用于旧回放兼容。
7. `ask_user` 的拒答或取消不是工具审批拒绝。它只产生一个失败的成对 Tool Result 并清除
   用户输入交互，Runner 必须继续同一 turn，让模型在缺少该答案的情况下继续；不得发出
   `turn.aborted` 或中止其他执行。Schema 校验失败尚未创建用户输入交互，TUI 必须把它
   显示为工具错误，不能伪装成 `(no answer)` 或 `User: ...`。
8. 方案执行确认是授权屏障。用户取消 `request_plan_review` 时保留方案 draft，但取消方案
   工具和所有未终结 sibling，发出 `turn.aborted(cause=user)`，Runner 立即退出；不得把
   取消投影成成功的 `review_cancelled` Tool Result，也不得继续调用模型。
9. Planning 的 phase 边界不可审批升级。非只读 `shell_execute` 在该阶段不创建 approval，
   Controller 以 `phase_deferred` 终结本次 Tool Call，并向模型返回原始参数、
   `until_phase=building` 与“写入方案、批准后重新调用”的结构化指引。TUI 消费对应的离屏
   queued 元数据但不生成 Bash 卡、失败提示或 deferred command 行；这不是 Runtime 可自动
   恢复的执行队列。`write_file`、`edit_file` 与实现型 Subagent 等其他阶段越界使用
   `phase_denied` 硬拒绝，不创建 approval；模型结果必须明确当前阶段不可审批并要求把实现
   意图写入 Plan。文件编辑拒绝在 TUI 保留“Plan mode 只读、文件未修改、方案批准后执行”的
   可操作提示，但不物化未获准执行的 Tool Card，不能只显示通用 `Rejected ...`。破坏性
   Shell 仍使用硬安全策略拒绝。
10. 统一 AbortSignal 命中时，正在执行的 Shell 必须先完成有界 process-tree 清理并回传
    `processCleanup`；未确认 descendant 退出时另发 `cancel_incomplete`。若此时前台正等待
    sibling approval，Runner 必须先排空后台 terminal/diagnostic 再结束，不能提前关闭
    RuntimeStore 或 logger。

## 文件原像与可逆性（ADR-0042 §4）

`write_file` / `edit_file` 改动工作区文件前，工具执行链捕获目标文件原像存入 RuntimeStore。这是 `accept_edits` 等模式自动放行工作区写入的可逆性底牌：`/rewind` 回退到恢复点时先按原像恢复文件，再截断会话。约束：

1. 捕获是 best-effort：同一检查点窗口（上一次 turn 快照之后）内每个 path 只记录最早一份原像；捕获失败不得中断工具执行。
2. 子 agent（task）的工具写入经同一条记录链捕获。
3. 恢复顺序不可颠倒：`restoreNamedSnapshot` 会截断检查点之后的原像，文件恢复必须先于它执行。
4. Fork 只复制 fork 点之前的原像行，不改动共享工作区文件。

## 动态 Capability

MCP Tool 必须具有当前轮 binding；catalog 或 descriptor revision 漂移时 fail closed。Skill 必须是已编译 Workflow Contract 并形成 Runtime activation/frame；不存在返回 SKILL.md 正文的旧 `Skill` 工具。Subagent 与 Skill fork 的能力集合是 ceiling，不是授权。

通过 binding 解析出的 MCP 本地策略必须从 Tool Controller 传递到最终 Tool Runner，不能在防御性二次审批时丢失。只有 `minimumApproval=none` 且 filesystem、network、external state 三个 effect 维度都为 `none/read` 时，能力才属于已证明只读；任一维度为 write 或未知都保留审批边界。该规则同样适用于 Subagent 内的 MCP 调用。

Capability search 只负责发现。搜索候选不能作为调用句柄，也不能绕过后续 binding、policy 和 approval。

`list_mcp_resources` 与 `read_mcp_resource` 是无审批只读内置工具，但仍经过统一 Tool Controller、Provider/URI 有效性和输出大小治理。MCP Tool、Resource 列表或读取的任何错误只终止当前 Tool Call，并必须向模型产生结构化、成对的 Tool Result；Tool Controller 不得把 Transport 异常升级为会话级未捕获错误。HTTP/SSE 恢复由 Supervisor 串行处理，STDIO 断线等待用户显式 Retry，均不扩大原调用授权。

## 执行与完成

`ok` 或 provider success 只表示一次 Execution 收敛。外部写入先持久化 invocation intent；未知终态禁止盲重放。包含 write/destructive/unknown effect 的受治理能力按 Verification policy 创建 required 验收，未通过时不得 `run.completed`。

## 禁止事项

- 不得根据 `mcp__` 名称字符串直接推断权威能力身份。
- 不得相信远端 annotation 自行降低审批。
- 不得让 Skill manifest 自行授予权限。
- 不得把 approval 与 sandbox 合并为一个开关。
- 不得从 UI summary、模型 final 或 ToolMessage 文本推断任务完成。
- 新的已注册工具自动获得与其 Registry `effectClass` 对应的审批默认策略（`read_only`→放行、`plan_only`→放行、`workspace_write`→模式策略、`external_side_effect`→审批），不再需要逐工具手工维护审批矩阵。仅存在明确安全边界（URL 校验、外部路径、命令分类、MCP binding）的工具才需要专用分支。

## 工具结果结构化元数据

工具完成时的 `resultMeta`（`path`、`totalLines`、`command`、`matchCount`、`rawResultDigest`、`modelContentDigest`、兼容字段 `contentDigest`、`digestScope`、`intent`、`truncated`、`resourceRevision`）从 `harness/tool-runner.ts` 写入 `ToolCallRecord`，通过 `ToolCallResult` 进入 `RuntimeState.tools.calls`。Runner 必须在 MCP normalization、serialization 和任何模型可见截断前计算 raw digest，并显式传播截断状态；Controller 对模型可见内容计算 model digest，不能把 projected digest 标记成 raw。这些字段用于审计、恢复和摘要输入中的结构化事实；当前模型上下文不执行工具结果投影折叠。行为上不改变权限决策或审批路由。

## 子 Agent 阻塞审批请求构造

子 Agent 因工具审批阻塞时，Controller 通过 `buildBlockedToolRequest` 构造 `PendingToolRequest`：优先走 `toolRequestFromCall`（Registry → request adapter）获得类型化请求；仅在工具未注册时 fallback 到最小构造（builtin 或 MCP 取决于 `mcp__` 前缀）。不再手工 `as PendingToolRequest` 强转。失败分类的 `parseFailureCode`（`unknown_tool` | `tool_unavailable` | `invalid_arguments`）通过 `InvalidToolRequest` 透传到 `ClassifiedFailure`，保留 Registry 结构化失败码用于诊断。
