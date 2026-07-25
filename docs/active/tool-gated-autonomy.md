# 当前规则：Capability 执行与工具自治边界

状态：active

读取时机：修改工具路由、Capability binding、Tool Controller、副作用分类、审批、authorization、sandbox、MCP/Skill/Subagent 执行或最终完成条件时。

验证：`bun test tests/runtime/tool-controller.test.ts tests/runtime/scheduler.test.ts tests/tool-policy.test.ts tests/tool-definitions.test.ts tests/policies/approval-policy.test.ts tests/policies/mode-policy.test.ts tests/execution/gateway.test.ts tests/subagent-approval.test.ts tests/runtime/verification.test.ts`、`bun run typecheck`。

相关：`authorization.md`、`mcp-runtime-governance.md`、`verification-governance.md`、`cancel-resume-cleanup.md`、ADR-0007、ADR-0008、ADR-0025。

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

## 工具名单单一事实源（ADR-0026）

静态工具的 Schema、契约、副作用分类与执行器收敛到 ToolSpec Registry（`src/core/tools/registry/`），由 `toolSpecRegistryV1` 灰度切换（默认关闭，关闭时全部走现有 `definitions.ts` + `tool-runner` 路径）。迁移期不变量由 `tests/tools/tool-registry-conformance.test.ts` 棘轮守护：Policy 分类引用的工具名必须是已知名单（防 `list_files` 式幽灵名）；模型 ToolSet 不得携带 `execute`；写工具必须声明 mutation scope。模型参数的副作用自我声明与授权提议随 shell 迁移删除，审批决策只来自命令形态与授权状态。已迁移工具：`read_file`、`search_content`、`search_files`（契约暂引用对应 `*_CONTRACT.sections` 以保持 description 逐字节稳定）。

## 自治规则

1. 普通问答不使用全局 stop-check；没有未决 Effect 或 required verification 时可直接完成。
2. Read-only Builtin（`read_file`、`search_content`、`search_files`）在工作区内可按 mode 直通；路径指向工作区外部时需用户审批（`externalRead` effect），与 `write_file`/`edit_file` 的外部路径处理一致。外部性判断前，路径参数先经 MSYS2 归一化（`msys2ToWindowsPath`，非 Windows 透传）——否则 Windows 上 `/c/proj/...` 形式路径会被 `resolve()` 挂到当前盘符，工作区内路径被误判为外部。该归一化与 `resolvePath` 的 MSYS2 防御层（见 [[file-reading-shared-boundary]]）口径一致；`tool-runner` 的 `isExternalPathArg` 同样先归一化再判定 `allowExternal`。
3. `accept_edits`、`auto`、`full` 只决定交互策略，不取消 capability schema、revision、minimum approval 或 sandbox 检查。
4. Authorization grant 只在声明的 thread/workspace/command 范围有效；新 thread 不继承单次授权。
5. Destructive shell 与未知外部副作用保持保守边界，不能因 full access 或 same-command grant 自动放行。
6. 批量 tool calls 必须逐个进入相同策略；一个只读调用不能掩盖同批写入调用。

## 文件原像与可逆性（ADR-0025 §4）

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

## 工具结果结构化元数据

工具完成时的 `resultMeta`（`path`、`totalLines`、`command`、`matchCount`、`rawResultDigest`、`modelContentDigest`、兼容字段 `contentDigest`、`digestScope`、`intent`、`truncated`、`resourceRevision`）从 `harness/tool-runner.ts` 写入 `ToolCallRecord`，通过 `ToolCallResult` 进入 `RuntimeState.tools.calls`。Runner 必须在 MCP normalization、serialization 和任何模型可见截断前计算 raw digest，并显式传播截断状态；Controller 对模型可见内容计算 model digest，不能把 projected digest 标记成 raw。这些字段用于审计、恢复和摘要输入中的结构化事实；当前模型上下文不执行工具结果投影折叠。行为上不改变权限决策或审批路由。
