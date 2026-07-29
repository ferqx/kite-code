# Cancel、Resume 与工具调用清理

状态：active

读取时机：修改 abort/cancel、Runtime 恢复、Effect lease、消息工具对清理、工具参数异常、Subagent continuation 或 TUI 取消行为时。

验证：`bun test tests/runtime/kernel.test.ts tests/runtime/reducer.test.ts tests/runtime/stability.test.ts tests/runtime/store.test.ts tests/tool-parse-error.test.ts tests/context.test.ts tests/subagent-continuation-codec.test.ts tests/session-manager.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/tui-interrupt-clear.test.ts`、`bun run typecheck`。

## Runtime 取消语义

取消通过 AbortSignal 传播到模型、工具和 Subagent。用户停止当前轮次时，App shell 必须先通过 live Kernel control plane 原子持久化全部未终结工具的 `tool.cancelled` 与带 `cause=user` 的 `turn.aborted`，再触发 AbortSignal；这样活动 Effect lease 会因 revision 前移而失效，队列、active 列表和 transcript 工具调用/结果对共同收敛，不能留下永久 busy 状态。该操作只终止当前 turn，不把活动 task 改为 cancelled，下一条用户消息仍可沿当前任务上下文继续。重复取消不得追加重复 Tool Result。TUI 清理运行中 block 只是上述 Runtime 事实的展示投影，不是 Runtime 取消事实本身。

TUI 对用户取消的终态投影遵循：已实际开始的工具保留原名称、关键参数和已有输出并显示 `cancelled`；从未开始的 queued 探索工具不计入 `read N files` 等统计；不追加独立的整轮取消提示。实时取消和 event-log replay 必须得到相同投影。

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
