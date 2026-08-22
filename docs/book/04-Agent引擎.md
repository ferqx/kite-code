# 第四章 核心层：Agent 与 Runtime Kernel

Kite Code 使用事件化 Runtime。Agent Kernel 只负责事实、纯调度决策和 reducer；Runtime Host 负责通用 lifecycle、mailbox、lease 与持久化协调；Builtin Runtime 拥有模型、工具和领域语义；App 是唯一 composition root。

## 4.1 主循环

```text
RuntimeState
  → decideNextEffect()
  → invoke_model / execute_tools / compact_context / request_approval / run_verification / emit_final
  → App RuntimeSessionCoordinator
  → Runtime Host lifecycle / Builtin operation
  → RuntimeEvent
  → reduceRuntimeState()
  → 持久化并继续调度
```

| 实现 | 职责 |
| --- | --- |
| `packages/agent-kernel/src/` | State 25 事实、纯 scheduler/reducer 与治理决策 |
| `packages/runtime-host/src/` | mailbox、lease、transaction、prepared/receipt 与通用 lifecycle |
| `packages/builtin-runtime/src/` | Context、Prompt、Model、Tool、Skill、MCP、Subagent 与 Verification 语义 |
| `apps/kite/src/bootstrap/runtime/` | 组装唯一 Host、frozen registry snapshot、Model Gateway 和会话 coordinator |
| `packages/runtime-storage-sqlite/src/` | Store 4 SQLite adapter、快照、事件与恢复事务 |

## 4.2 模型边界

Builtin model runtime 负责模型调用语义与 transcript 投影。模型获得：

- 静态 system prompt；
- cacheable Runtime context；
- V2 中带来源的项目指令 synthetic user context；
- 单一动态 Runtime block 中的当前计划、模式、授权、sandbox 和恢复信息；
- 当前轮有限 Capability binding；
- 对应的 transcript messages。

模型输出被转换为 Runtime 事实。它不能直接写文件、批准操作、修改 State、签发 binding 或宣布 required verification 已通过。

App adapter 不直接触达 AI SDK。primary、context compaction、auto review、verification review 与 subagent
step 都由 `compileModelSurfaceV1()` 在 resource admission 前构造同一冻结的 provider-neutral Surface，随后
进入唯一 `ModelInvocationGatewayV1`。Gateway 先发布私有 Surface Artifact，再执行 Provider data
admission 与 resource reservation；`model.invocation_prepared` ack 后，每个 Provider attempt 还必须分别
ack `model.invocation_attempt_started`。底层 transport 只执行一次请求且 SDK retry 为零，Gateway 独占有界
retry/backoff。成功 response 先写入 Response Artifact，再把 `model.invocation_completed`、purpose terminal
和 resource reconciliation 原子提交；completion handle 在该 batch ack 前不向上层暴露 response。
Artifact、key、admission、persistence 或 Surface identity 任一失败都 fail closed，不存在旧 invoke 或
runtime fallback。

工具调用也由同一 Runtime 事实原则约束：App Tool coordinator 只把已 admission 的 invocation 交给唯一 Tool
dispatch boundary；Kernel ack invocation 与 attempt 后 adapter 才能开始。结果先进入 private Capability
Artifact，再以 capability receipt、Tool terminal 和必要的 resource/verification 事实原子提交。Runtime-owned
interaction 可以先记录 result Artifact 再暂停，但恢复 action 必须在 Tool terminal 同批闭合；dispatch 后
缺少 Artifact/receipt 时进入 unknown 并阻断后续调度，不会自动重放或绕回旧 adapter。

RMV1-10 至 RMV1-15 已把全部 29 个 operation 收口到唯一 Builtin registry。模型 surface 与执行都从同一
frozen snapshot 投影 schema/parser/effects/traits/revision；durable attempt ack 后 Host 对 exact identity 与
单次 attempt claim 做通用仲裁，唯一 Builtin executor 返回 SPI Receipt，再复用上述 Capability
Artifact/terminal commit。Host 不解释具体能力语义，App 不维护第二份 operation registry。

Workspace 文件工具还经过 PS-01 的 Provider 子流水线。读/search 在 intent ack 后取得 observe grant；
write/edit 先做零写入 prepare，随后发布私有 preimage Artifact，持久化
`capability.filesystem_mutation_ready`，最后才签发 single-use commit grant。Local Provider 是生产路径唯一
Node filesystem owner，旧 file/search 仅为 test oracle。commit 前 stale identity/preimage、取消、过期或
symlink swap 都保持零写入；rename 后证据丢失为 commit-unknown，不能重放。

成功 `read_file` terminal 把 actor/target/content 的 digest-only observation 写入 Runtime，`edit_file` 只
接受同 actor、同 lexical target 的最新 committed observation。未读或外部修改分别返回
`read_required`/`stale_read`；Parent、child、sibling 不共享 freshness。旧 rewind checkpoint 是次级投影，
不授权 commit。filesystem intent、ready 与 observation 不保存原始路径、正文或 grant；既有 Tool Call
arguments/result metadata 仍可包含模型已见路径，但不是 target identity 或 commit authority。Session Logger
与 remote observability 不导出 filesystem path、正文、preimage 或 grant。

`promptContractV2` 当前默认开启，并保持 `promptContractV2=false` 的 legacy 回滚路径。V2 把稳定规则、环境、项目指令、动态状态和工具声明分层；环境 digest 包含 Prompt 版本、项目指令 revision 与真实 sandbox backend，避免跨版本或规则变化误用缓存。项目加载器只读取 Workspace 内适用的 `CLAUDE.md`/`AGENTS.md`，按父到子、同层 CLAUDE 后 AGENTS 排序，并以 16 KiB/文件、64 KiB/快照、16,384 tokens/快照和链接越界拒绝约束读取。首次写入新子目录若发现当前模型未见的规则会先拒绝，下一轮刷新后再允许重新发起。

## 4.3 Plan 生命周期

计划是 Runtime 管理的版本化 Artifact，而非模型消息中的临时文本。计划创建、更新、审核、批准、执行和恢复均有明确事件；结构摘要用于防止审核后计划被静默替换。

Plan mode 与普通执行共享同一个 Kernel，只通过策略和可用工具边界限制行为，不建立第二套 Agent 引擎。

## 4.4 完成与恢复

Scheduler 只有在没有待执行工具、审批、Provider Action、恢复动作或 required verification 门禁时才可 `emit_final`。RMV1-09 后具体 ToolSpec 先投影 ExecutionTraits，`@kite/agent-kernel` 只按 resource scope、access、conflict、isolation、causal/barrier/concurrency/lease facts 选择批次，不含 Tool name 分支；缺失或未知 traits 串行。版本化 CompletionGuard 在 scheduler、runner 与 reducer 三层复用同一 Kernel 判定：V1 用于无 Plan task，PlanDocument V2 使用 V2，并额外校验完整 Plan identity、required verification 和 effect receipt evidence。final 文本只是 candidate；非终结 Tool、suspended subagent、unknown invocation、active Skill 或缺失 evidence 都不能形成 `run.completed`。

每个当前工具终态在持久化和发布前由 Kernel 写入唯一 canonical `ToolOutcomeV1`，transcript 仍只有一个 ToolMessage。Runtime 而非工具正文决定 dispatch/effect certainty、恢复 ceiling 与 timing；缺少或损坏 envelope 的事件直接 fail closed，不进入 historical decoder。父/子执行共享可重放 recovery journal：参数修正一次，受信 safe-read 自动 retry 一次且必须先落 retry record；policy/approval deny、timeout、cancel、unknown effect 和没有 receipt 的幂等声明都不重放。恢复数据损坏或重复无进展会在资源上限前 fail closed，CompletionGuard V2 也拒绝 unresolved/quality-blocked journal。已解析调用使用当前 ToolSpec/MCP binding schema defaults 与 revision 生成
identity，解析失败只保存 raw 参数的私有 HMAC。状态、模型 guidance、Session/metrics 与 TUI 都从同一
outcome 派生，审批等待与 total active timing 由 Runtime 持久时间边界计算。

MCP Provider Action 是持久化交互。旧 Tool Call 必须先失败并退出调度，Runtime 才向 App shell 请求固定的 login、approve 或 retry。恢复成功会开始新 turn，旧 binding、approval、参数和 invocation 都不重放；延后或失败也会形成明确事实并清除交互。
工具失败与紧随其后的 Provider Action 使用同一有序 event batch 提交，确保 Kernel 不会在
Tool Call 仍为 running 时拒绝或提前展示恢复交互。

新 run 还会在第一次模型调用前执行 required Provider 准入。ready/degraded 可继续，其余 Provider 逐个等待 retry、当前 session waiver 或 cancel。Waiver 是持久事实但不会恢复能力可见性；只有显式 cancel 会取消任务并中止 turn，交互 UI/transport 自身的异常必须记录为 error-caused terminal，不能伪装为用户取消。

启用 `resourceBudgetV1` 的新 run 在所有 Runtime invocation 前执行累计预算 admission。
工具、MCP、Skill/Sub-agent 与非模型 Verification 继续由 Runner 持久化 reservation/FIFO waiter 和
`dispatch_started`；模型、compaction、auto review、verification reviewer 与 child model reservation 由
Gateway 在冻结 Surface 与 Provider admission 后拥有。第一次 model attempt 把 `dispatch_started`、attempt
intent 与 primary 的 `model.requested` 同 batch ack，后续 attempt 也各自先 ack；terminal fact 与实际 usage 原子
reconcile。Shell 同时取得 tool/shell 两类 permit，不会部分占位。累计耗尽、并发等待超时和
未知外部结果分别保留不同终态，不会投影为普通完成。

Subagent child tool/shell 也使用同一 durable FIFO admission，而不是 parent task 内的私有计数器。
child waiter promotion 与 reservation 原子提交，wait deadline/Abort 有界收敛；child saturation
穿透 Task 执行链并由同一 terminal adapter 生成 `run.error + turn.aborted`。迟到 child usage 只能
经 resource-only reconciliation 写入，不能携带工具终态或恢复调度。

当前 Runtime state（schema v25）的终态使用 `RunTerminalOutcomeV1`。展示层读取 reason code、external
effects、safe retry、recovery entry 与 pending verification，不解析错误字符串；只有
`status=completed` 可进入完成展示。

同一 schema/format epoch 的 `modelInvocations` 投影保存每个调用的 Surface ref、admission/resource facts、
attempt count、response ref 与 certainty。completed restore/fork 必须交叉验证 Surface/Response evidence；
缺失、损坏或 installation key unavailable 时保留已 ack transcript，但标记 evidence unavailable。prepared
且无 attempt intent 的调用收敛为 undispatched，已有 attempt intent 且缺 completion receipt 的调用及其
reservation 收敛为 unknown，绝不自动重发。旧 snapshot 只在 `modelInvocations` 字段完全缺失时归一为空表，
不补造历史 Surface。2026-08-22 已删除本版 evaluation、record/replay response source、cassette、suite
actor/context 与相关 CI 入口；产品态 Session restore、Event replay 和 Artifact readback 继续由普通产品测试覆盖，
恢复绝不从 evaluator 或 cassette 补造历史调用。后续 evaluation 必须另立计划并重新定义身份、授权和数据边界。

统一失败矩阵由 `resolveFailureModeV1()` 解析。它为 sandbox/network/worktree、model/MCP、
persistence、预算与并发、process-tree、compaction/Verification、可选诊断和 rollout 返回同一
组 disposition、invocation 数、durable/external-effects 状态、reason、恢复入口与 fallback。
预算准入和 run deadline 直接消费该结果；产品级 journey、fault、soak、CLI 与 TUI 测试通过同一
`RunTerminalOutcomeV1` 投影复测。其他 producer 需要显式接线或等价入口 contract
test 后才能声明 coverage。展示层和各入口不能用本地错误字符串发明更宽松 fallback；缺少
external-effect 证据时结果为 `unknown`，未 reconciliation 时不能继续。process-tree 超限且清理有明确
正向证据时仍以 `budget_exhausted` 状态结束，稳定 reason 保留
`process_limit_exceeded`，清理未确认则为 `cancel_incomplete`/unknown。

每个网络 hop 的 allow/deny admission receipt 会持久化到
对应 Tool Call。获准 socket 只有在 receipt event 提交成功后才能打开；恢复时不会为历史调用
补造网络决定。

远程 HTTP MCP 的独立内容外发决定以
`mcp.egress_decided` 追加到对应 Tool Call。许可只绑定一次 invocation 的 Server/endpoint/Tool/
最终参数 digest，nonce digest 由 Runtime Store 与 receipt 同事务唯一 claim，进程重启后仍不能
重放；持久化唯一冲突会转换并保存为 `permit_replayed`，流式持久化异常会 reject 调用方而不会
让执行循环挂起。恢复不会为历史调用补造外发决定。

## 4.5 上下文与缓存

静态 prompt、稳定工具契约和 cacheable Runtime context 尽量保持前缀稳定；项目指令使用独立早期消息，动态状态、Skill disclosure、搜索结果和 turn binding 放在轮次投影中。V2 的动态 phase/interaction/authorization/sandbox/planning state 只出现一次。上下文压缩保留任务事实、计划和工具结果语义，不取代 Runtime Store。

当前 Runtime 把 M2 checkpoint lifecycle 纳入事件循环。`context.compaction_requested` 形成 pending 状态，scheduler 在工具、交互、verification 和 final 等更高优先级工作结束后调度 `compact_context`，controller 以 completed/failed 事件收敛。压缩复用普通 Effect lease；来源 revision 变化仍由 Kernel lease 拒绝并重新调度，完成时 projection environment 变化则产生 `stale_context` 可重试 failed 终态，清除 pending 且不激活 checkpoint。同一 session 的 standalone manual compaction 由 App 串行化整个 command/request/effect/terminal 生命周期，不能由多个 Kernel 并发推进同一事件流。RuntimeStore 还通过跨连接 effect lease 阻止同一 compaction id 的重复 Provider dispatch，并用 snapshot expected-revision CAS 拒绝 stale Kernel 或删除后的晚到写入；进程内 Promise barrier 只负责交互排序，不能替代持久化所有权。恢复通过当前 epoch snapshot 加严格 event tail 重建 pending 或 active checkpoint，已收敛的 completed 不会重复激活。安全边界和输入上限都以完整 settled turn/tool pair 为单位，不能拆分调用与结果。Checkpoint 只是一种可 reset 的模型上下文投影，原始 transcript 仍保持不变。

压缩原因只有 `manual | auto`。Token ratio 术语（文本计量比例）、窗口估算、Provider 术语（模型供应商）错误和压缩失败不会产生 hard block 术语（硬阻断）；`ContextHardBlock` 只表示 Runtime correctness failure 术语（运行时正确性故障），普通压缩或 reset 术语（重置）不能清除它。Runtime 不解释通用 Provider HTTP 400；模型请求失败不自动触发压缩或硬阻断，用户可在会话恢复交互后自行执行 `/compact`。

会话压缩使用当前对话模型执行一次无工具、零 SDK retry 的专用 summary request，并且只接受一份 Markdown narrative。输入只包含最小固定 prompt、已有 narrative、全部 safe settled history 和作为不可信数据的 custom instructions；不携带普通 Agent system prompt、工具 schema 或 live tail。手动压缩总结全部安全历史；自动压缩只保护当前 turn。Provider dispatch 前先用最小有效 narrative 计算 candidate projection 的理论最大收益，低于 1024 tokens 时零调用失败；已有 checkpoint 后无新增 safe history 时同样零调用返回 `No new messages to compact.`，custom instructions 不能单独触发 narrative 重写。显式 summary input 上限超出时整体失败，不会静默总结局部前缀。输出必须非空、未因长度截断、没有 tool call、低于 narrative 上限，并使统一 candidate projection 至少减少 1024 个估算 token。Checkpoint 只持久化规范化 summary 字符串与 Context 边界元数据；投影时通过唯一 XML-safe serializer 生成一个历史区首位的 `<compacted_history>` assistant frame。
