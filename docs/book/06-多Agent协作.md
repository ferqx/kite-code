# 第六章 Subagent 协作

Subagent 是能够在隔离上下文中完成部分任务的 Capability。主 Agent 保持最终编排权，子 Agent 不形成 peer-to-peer 网络。

## 6.1 内置角色

| 角色 | 用途 | 默认能力边界 |
| --- | --- | --- |
| `explore` | 搜索和理解代码 | 只读工具 |
| `plan` | 调研并形成方案 | 只读工具 |
| `code` | 实现明确任务 | 完整工具集，但仍受 Runtime policy |
| `review` | 独立检查结果 | 只读工具 |

角色配置位于 `src/core/subagent/roles.ts`。允许的工具集合是能力上限，不是授权授予。

## 6.2 运行结构

```text
主 Agent 调用 task capability
  → Runtime/Policy 校验
  → Task Tool 创建 SubAgentRunner
  → 独立模型上下文和 AbortController
  → 工具调用仍走执行与策略边界
  → 生命周期事件投影给主 Runtime/TUI
  → 返回结构化结果或 continuation
```

Subagent 默认不读取主 Agent 的完整消息历史，只接收任务、角色 prompt、必要上下文和 Runtime 签发的有限能力。

模型可以为有界、自包含、独立且值得额外模型调用的工作自主选择委派；用户明确要求不委派时必须遵守。Runtime 不解析 `userGoal` 作为委派或 role 授权协议，也不按语言、单词数或语义短语判断 delegated task；硬校验只保留 schema 的 `8..8000` 字符边界，自包含性由模型可见契约约束。App 附加的 project/shell context、文件内容或工具结果不能提升 child 的 authorization、phase、预算或能力 ceiling。Planning 只允许 explore 和 architecture/design 规划的 plan role，
code 保持禁止。plan child 返回后先 `write_plan:save`，再 `write_plan:submit`，不使用
`update_plan` 跳过 Plan Artifact/review。

SubAgentRunner 只通过父 Runtime 传入的 `McpRuntimeProvider` 访问 MCP，不依赖 Supervisor 或 Manager control API。执行动态 MCP 工具前先由 Runtime binding 找回 descriptor，并把其中的 effective effects 与 minimum approval 一并交给共享 Tool Runner。这样只读 MCP 不会在二次策略检查中被误判为未知能力，写入或不确定能力也不能借子 Agent 路径降低审批等级。

`task` capability 的 schema、契约、role-based effects 与结果投影由 ToolSpec Registry 的 `task` spec 统一定义。实际 `SubAgentRunner` 作为受治理的执行适配器由父 Runtime 注入，避免 Registry 依赖子 Agent 装配细节；旧的 `createTaskTool()` 模型工具执行器已删除。子 Agent 的 shell 只读分类与主 Runtime 共用命令形态分类器，不接受模型提供的 `intent` 等治理字段。

子 Agent 的 Workspace、权限模式与读取 freshness 都来自 Runtime 而非模型参数。Runner 将 canonical Workspace 同时用于模型 `Workspace`/`CWD` 与工具根目录；child 显式继承父 Runtime 当前的 interaction mode，审批恢复时重新读取 live mode。每个 child 使用稳定且独立的 Runtime-issued id 跟踪 read-before-edit 状态，Parent 和 sibling 不能出借已读事实。

## 6.3 审批暂停与恢复

子 Agent 遇到需要用户审批的操作时不能自行批准。Runner 产生 blocked tool 与可序列化 continuation，主 Runtime 请求用户决策；批准后恢复同一个调用身份和执行上下文，拒绝则把结构化拒绝结果反馈给子 Agent。

continuation codec 保存消息、步骤、journal 和阻塞请求，并在恢复时严格校验。它不是让子 Agent绕过审批的离线执行通道。

这里的 current journal 是与父 Runtime 同构的 `ToolRecoveryJournalV1`：包含私有 HMAC identity、
failure instance、`recoveryOf`、一次模型修正/自动重放 ceiling 和 tool-owned progress。continuation
恢复不会重置次数；child 返回时父 Runtime 通过单一 merge event 合并 journal，而不是解析 child
summary 或旧 stderr/path journal。私有 key、fingerprint 与 lineage 不投影到 SessionLog/telemetry。
MCP binding validation failure 与旧 exhausted-fingerprint bypass 也生成同构 typed terminal、scope-bound
quality guard 和 lineage；continuation JSON restore 不重置 ceiling，parent merge 会把 child scope 重新
绑定到 owning task call。动态 MCP identity 使用当前 binding descriptor 的 schema defaults、revision 与
schema digest，不退回 builtin `unknown_tool` 身份。
task Subagent 创建时继承 parent 的 canonical-private recovery identity key；merge 只接受同一 HMAC
domain，foreign-key child journal 直接 quality-blocked 且不复制 fingerprint。这样 child deny 合并后，
parent 对同一 canonical invocation 的重提仍会在 dispatch 前零调用阻断。

## 6.4 Skill fork

声明 `context: fork` 的 Skill 可在隔离 Subagent 中执行。它只能获得 Skill capability ceiling 派生出的 Runtime binding；MCP capability 在执行前再次核对 revision、schema digest 和参数。

## 6.5 调度与边界

Task Tool 按 Runtime/线程限制活动数量。取消通过 AbortController 传播。子 Agent 不递归无限派生，也不能修改主 RuntimeState；其结果必须通过主 Runtime Event 合并。

Subagent 调用统一串行执行。模型不得把多个 child 描述成“并行派发”；当多个独立视角都有收益时，一次调用一个，并在前一个结果返回后继续后一个，若减少请求数量则说明原因。Scheduler 只调度已持久化的 task call，Controller 为 child 保留独立 ID/stream ownership；terminal 或 suspended 状态收敛后才处理后继调用。

## 6.6 累计预算、取消与恢复

父 Agent 与全部 Subagent 共用同一个 run-scoped `ResourceBudgetV1` ledger，子 Agent 不获得独立
余额。Task parent reservation 只覆盖本次 lifecycle/concurrency attempt；子模型及 Builtin、
Shell、MCP invocation 分别建立带 `parentReservationId` 的 child reservation，并在 dispatch 前
持久化。artifact bytes 计入产出它的 tool/MCP reservation，不重复计算一次 invocation。暂停后
恢复会创建新的 parent attempt，不会复用旧 attempt 的许可或把旧 child usage 退回余额。

`maxConcurrentSubagents`、`maxConcurrentWriters`、tool permit 与 shell permit 都由共享 Runtime
原子执行。Shell child 必须同时取得 tool 和 shell invocation 两类 permit，不能先占一种再等待
另一种；等待按资源 FIFO 排队，期限取 concurrency wait deadline 与 run deadline 的较早者。
这些顶层 invocation permit 不替代平台对完整 Shell descendant process tree 的限制。

取消或 run deadline 会传播到子 Agent 及其 descendants，并先收敛 durable 状态：未 dispatch
reservation 才能 release，已经 `dispatch_started` 而无 terminal receipt 的调用转为
`unknown`，不能自动重放或退款。process-tree 清理无法确认时，父 Runtime 以
`cancel_incomplete` 和 reconciliation hard block 结束；迟到 child actual usage 只能经
resource-only bounded reconciliation 提交，child tool/model terminal 本身会被拒绝，不能复活
已取消 turn、释放未知额度或启动后继调用。

子 Agent 的失败、资源饱和与终态使用主 Runtime 的同一 failure-mode policy 和
`RunTerminalOutcomeV1` 投影。模型 final、子进程零退出码或 parent task 的表面成功都不能绕过
required Verification，也不能把 `unknown`、`budget_exhausted` 或 `resource_saturated` 显示为
完成。

UI 与 Runtime 的 child 生命周期共用 `running | suspended | terminal`语义：等待用户
审批是 suspended，批准恢复后重回 running，只有规范 terminal event 才显示 done/error/
cancelled。成功 child 统一投影 `completed`；恢复历史由 canonical Recovery Journal 保留，不再复制为另一套 UI/协议完成态。同一 child 不得同时显示 failed 与 done。
role 选择由模型按用户任务语义完成：只读工作使用 explore/plan/review，用户任务要求实施时才使用 code。child 的模型 schema、Registry parse、执行与 resume 使用同一 config、phase、live interaction mode、authorization、gitBroker 与 availability context；typed Git 只能经只读 broker，不能隐式退回 raw Shell，写操作仍由 code role 的既有 Runtime policy 治理。
