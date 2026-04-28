# 当前规则：工具边界自治

状态：active
最后更新：2026-04-28
最后验证：2026-04-28
范围：

- `src/harness/graph.ts`
- `src/harness/routes.ts`
- `src/harness/tool-runner.ts`
- `src/harness/state.ts`
- `tests/graph.test.ts`

读取时机：

- 修改图路由。
- 修改审批行为。
- 修改 `read-only` / `write` 工作区访问权限。
- 重新引入任何最终答案守卫或非危险确认门。

相关：

- `../completed/2026-04-26-remove-stop-check.md`
- `../completed/2026-04-26-remove-internal-ledgers.md`
- `../../references/opencode-codex-plan-handling.md`

验证：

- `bun test tests/graph.test.ts`
- `bun run typecheck`

## 规则

harness 不应使用 stop-check 节点硬阻断模型最终答案。模型结束主要由 prompt 约束和普通图路由控制。

人工确认只保留给受保护工具执行：

- `write` 访问下的写入、删除、执行类工具请求必须经过 approval。
- `read-only` 访问只允许执行只读工具和 `update_plan`；为保持缓存稳定，模型可见工具 schema 与 `write` 访问一致，但写入或执行尝试必须由 tools 层拒绝。
- `update_plan` 只更新 `graph.state.plan`，不能隐式切换 `graph.state.workspaceAccess`；是否规划应由模型自主决定，明确只读访问只能来自图状态或用户显式访问请求。
- `ask_user` 是规划澄清工具，不读写工作区，也不是工具审批；无论 `read-only` 还是 `write` 访问，都应路由到 `user_input` 节点并触发 `kind: "user_input"` interrupt，恢复值作为对应 tool call 的 ToolMessage 交回模型。
- 非危险最终答案、计划摘要和访问权限状态不触发 approval interrupt。

工具执行失败时，失败原因和正确用法应由工具结果自身返回，并作为 `ToolMessage` 进入模型上下文；失败结果应包含结构化的 `failure.reason` 和 `failure.guidance`。图不再通过 `reflect` 节点额外注入失败指导。

底层调用 shell 的工具必须保留 shell 返回的 `stdout`、`stderr` 和 `exitCode`。非零退出或 shell executor 异常都应转换为 `ok: false` 的工具结果，不能抛出到图执行层并阻断 `ToolMessage` 返回。

## 不要做

- 不要重新引入 `stop_check` 路由作为最终答案硬守卫。
- 不要为只读访问完成增加非危险 `mode_confirmation` 或 `access_confirmation` interrupt。
- 不要把 `ask_user` 复用成工具审批、访问权限切换或最终答案确认。
- 不要把受保护操作的安全检查从 tool gating 移到仅靠 prompt 指令。
- 不要静默削弱 `read-only` 访问的只读约束。
- 没有具体工具边界需求时，不要重新引入 evidence/progress 账本或 watchdog 式进度推断。

## 测试期望

`tests/graph.test.ts` 应断言：

- `read-only` 访问下 final 直接路由到 `END`。
- `write` 访问下 final 直接路由到 `END`。
- `read-only` 访问下写入尝试进入 tools 并被拒绝。
- `read-only` 和 `write` 访问下 `ask_user` 都进入 `user_input`，不经过 approval 或 tools 拒绝。
- `write` 访问下受保护工具调用仍经过 approval。
- `write` 访问下 `update_plan` 不自动切换工作区访问权限。
- 重复只读工具调用不会被 tool-runner 进度状态阻断。
- `tools` 和 `user_input` 完成后直接回到单一 `agent`。
