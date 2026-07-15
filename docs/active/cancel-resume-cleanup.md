# Cancel、Resume 与工具调用清理

状态：active

读取时机：修改 abort/cancel、Runtime 恢复、Effect lease、消息工具对清理、工具参数异常、Subagent continuation 或 TUI 取消行为时。

验证：`bun test tests/runtime/kernel.test.ts tests/runtime/stability.test.ts tests/runtime/store.test.ts tests/tool-parse-error.test.ts tests/context.test.ts tests/subagent-continuation-codec.test.ts tests/tui-interrupt-clear.test.ts`、`bun run typecheck`。

## Runtime 取消语义

取消通过 AbortSignal 传播到模型、工具和 Subagent。Kernel 必须使当前 Effect lease 收敛为完成、失败或取消事件，不能留下永久 busy 状态。TUI 清理运行中 block 只是展示投影，不是 Runtime 取消事实。

## Resume 语义

恢复从 Runtime snapshot + event log 重建 State，并重新检查不变量。以下状态不得被静默丢弃：pending approval、未完成 tool call、Capability binding revision、Skill frame、required verification 和 unknown external invocation。

重启不自动重放未知外部写入；必须 reconciliation 或用户决策。瞬时 binding、approval token 和 Effect lease 只能按各自恢复规则重新签发或收敛。

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
