# Cancel、Resume 与工具调用清理

状态：active

读取时机：修改 abort/cancel、Runtime 恢复、Effect lease、消息工具对清理、工具参数异常、Subagent continuation 或 TUI 取消行为时。

验证：`bun test tests/runtime/deadline.test.ts tests/runtime/kernel.test.ts tests/runtime/scheduler.test.ts tests/runtime/stability.test.ts tests/runtime/store.test.ts tests/shell-exec.test.ts tests/model-invoke.test.ts tests/mcp-tool-runner.test.ts tests/tool-parse-error.test.ts tests/context.test.ts tests/subagent-continuation-codec.test.ts tests/tui-interrupt-clear.test.ts`、`bun run typecheck`。

## Runtime 取消语义

取消通过 AbortSignal 传播到模型、工具和 Subagent。Kernel 必须使当前 Effect lease 收敛为完成、失败或取消事件，不能留下永久 busy 状态。TUI 清理运行中 block 只是展示投影，不是 Runtime 取消事实。

启用 `boundedExecutionV1` 后，每次 Model、MCP、Shell 和 Subagent invocation 都使用绝对
`deadlineAt`；首字节、idle、局部 timeout、retry backoff 与 Provider 调用只能消费同一份
剩余预算。外部 AbortSignal、总 Deadline 和阶段 timer 竞争时保留首个取消原因，后到的 timer
不得覆盖它，也不得影响相邻 invocation。

Shell 收到取消后必须停止 output reader 并清理受控进程树，不能只终止父 Bash。Windows 使用
`taskkill /t /f`，POSIX 使用独立进程组并执行 TERM → grace → KILL；用户取消映射为 exit
code `130`，deadline 映射为 `124`。terminal receipt 只能在主进程、reader 和受控进程树完成
收敛后产生。如果无法确认进程树收敛，结果必须携带 `cancellation_cleanup_failed`，Scheduler
进入 recovery-blocked，不得产生虚假成功 receipt 或开始新执行。

## Resume 语义

恢复从 Runtime snapshot + event log 重建 State，并重新检查不变量。以下状态不得被静默丢弃：pending approval、未完成 tool call、Capability binding revision、Skill frame、required verification 和 unknown external invocation。

重启不自动重放未知外部写入；必须 reconciliation 或用户决策。瞬时 binding、approval token 和 Effect lease 只能按各自恢复规则重新签发或收敛。

## Rewind 文件恢复（ADR-0042 §4）

`/rewind` 回退命名恢复点时必须先按文件原像表恢复工作区文件（检查点时刻存在的文件写回原像，不存在的文件删除），再截断事件日志与恢复点。约束：

1. 顺序不可颠倒：`restoreNamedSnapshot` 截断检查点之后的原像行，文件恢复必须先执行。
2. 单个文件恢复失败不阻断会话回退，但必须逐个显式提示失败路径。
3. Fork 生成新 thread 并复制 fork 点之前的原像行；共享工作区文件不被 fork 改动。

## 消息工具对清理

发送给模型的 transcript 必须保持 tool call/result 配对。取消或恢复后发现孤立 tool call 时，context sanitizer 生成明确的 cancelled/failed tool result，使模型知道该调用没有成功；不得删除调用伪装成从未发生。

## 非法工具参数

模型产生无法解析的工具参数时不得执行底层工具。系统应：

1. 保留 tool call identity 和原始解析错误；
2. 形成结构化失败 Tool Result；
3. 提供对应契约提示；
4. 让 Agent 在正常循环中修正参数；
5. 不把 parse failure 误报为 approval rejection 或 provider failure。

## Subagent continuation

子 Agent 因审批暂停时，continuation 必须可序列化并绑定原 tool call、消息、步骤与 journal。恢复前重新校验批准内容和能力边界；拒绝时向子 Agent注入结构化拒绝结果。
