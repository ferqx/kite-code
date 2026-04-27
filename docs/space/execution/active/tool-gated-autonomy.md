# 当前规则：工具边界自治

状态：active
最后更新：2026-04-26
最后验证：2026-04-26
范围：

- `src/harness/graph.ts`
- `src/harness/routes.ts`
- `src/harness/tool-runner.ts`
- `tests/graph.test.ts`

读取时机：

- 修改图路由。
- 修改审批行为。
- 修改 plan 模式或 builder 模式的工具权限。
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

- builder 模式的写入、删除、执行类工具请求必须经过 approval。
- plan 模式只允许只读工具和 `update_plan`；写入或执行尝试由 tools 层拒绝。
- 非危险最终答案、计划摘要和模式完成不触发 approval interrupt。

reflect 逻辑可以在工具失败后注入指导，但不能变成最终答案 reviewer 或进度推断引擎。

## 不要做

- 不要重新引入 `stop_check` 路由作为最终答案硬守卫。
- 不要为 plan 完成增加非危险 `mode_confirmation` interrupt。
- 不要把受保护操作的安全检查从 tool gating 移到仅靠 prompt 指令。
- 不要静默削弱 plan 模式只读约束。
- 没有具体工具边界需求时，不要重新引入 evidence/progress 账本或 watchdog 式进度推断。

## 测试期望

`tests/graph.test.ts` 应断言：

- plan 模式 final 直接路由到 `END`。
- builder final 直接路由到 `END`。
- plan 模式写入尝试进入 tools 并被拒绝。
- 受保护 builder 工具调用仍经过 approval。
- 重复只读工具调用不会被 tool-runner 进度状态阻断。
- reflect 在没有 final 时回到当前 active agent。
