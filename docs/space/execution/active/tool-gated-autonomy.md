# 当前规则：工具边界自治

状态：active
最后更新：2026-04-30
最后验证：2026-04-30
范围：

- `src/harness/graph.ts`
- `src/harness/routes.ts`
- `src/harness/tool-policy.ts`
- `src/harness/tool-runner.ts`
- `src/harness/state.ts`
- `src/harness/tool-requests.ts`
- `src/tools/definitions.ts`
- `src/app/cli.ts`
- `tests/graph.test.ts`
- `tests/tool-policy.test.ts`
- `tests/tool-definitions.test.ts`
- `tests/cli.test.ts`

读取时机：

- 修改图路由。
- 修改审批行为。
- 修改 `read-only` / `write` 工作区访问权限。
- 修改工具安全策略、风险分级或审批展示 payload。
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

- 工具安全策略必须集中在 `src/harness/tool-policy.ts`。`routes.ts` 只根据策略决定进入 `tools` 还是 `approval`；`tool-runner.ts` 在执行前必须再次调用同一策略做兜底。
- `write` 访问下的写入、删除、执行类工具请求必须经过 approval。
- `read-only` 访问只允许执行只读工具和 `update_plan`；为保持缓存稳定，模型可见工具 schema 与 `write` 访问一致，但写入或执行尝试必须由 tools 层拒绝。
- `graph.state.phase` 是独立执行边界。`planning` 阶段只能执行只读检查、`update_plan` 和 `ask_user`，不得执行写入或代码执行类工具。
- 模型可见工具表面固定为 `read_file`、`edit_file`、`write_file`、`shell_execute`、`update_plan` 和 `ask_user`。
- `shell_execute` 是 command action envelope，不只是命令字符串。模型应提供 `command`，并可提供 `intent`、`objective`、`justification`、`expected_observation`、`failure_strategy`、`prefix_rule` 和 `grant_request`；文件定位、文本检索、目录查看和 git 只读检查使用 `intent: "inspect"`，测试、类型检查、构建、lint 和 smoke 验证使用 `intent: "verify"`。
- `shell_execute` 应按命令内容分级：只读命令可直通；普通执行、写入、网络和 VCS 变更需要审批；高危破坏性命令默认拒绝，不进入普通审批。
- `graph.state.authorization` 保存当前 thread 的 shell 授权状态。默认模式只支持本次审批 `approve_once` 和同命令授权 `same_command`；用户通过 resume payload 主动选择 `full_access` 后，当前 thread 内后续所有 `shell_execute` 直接执行，包括原本 destructive 分类的命令。
- `same_command` 的命中规则是同一 workspace/thread 下 `command.trim()` 完全一致，不受 `objective`、`justification` 或 `prefix_rule` 变化影响。它使用独立 command grant key，不能和 `approvalHash` 混用。
- `full_access` 只保存在当前 thread checkpoint 中，新 thread 不继承。它只影响 `shell_execute` 的审批和 policy 拒绝；文件工具仍按原工具路径和策略执行。
- `update_plan` 只更新 `graph.state.plan`，不能隐式切换 `graph.state.workspaceAccess`；是否规划应由模型自主决定，明确只读访问只能来自图状态或用户显式访问请求。
- `ask_user` 是规划澄清工具，不读写工作区，也不是工具审批；无论 `read-only` 还是 `write` 访问，都应路由到 `user_input` 节点并触发 `kind: "user_input"` interrupt，恢复值作为对应 tool call 的 ToolMessage 交回模型。
- `tool_approval` interrupt 必须携带 harness 生成的结构化审批信息，包括 `policy`、`approval` 和 `approval.approvalHash`，不能依赖模型自然语言自述风险。shell 审批 payload 还应暴露模型解释字段、建议 prefix rule、可选授权粒度和推荐授权。带 hash 的 resume payload 必须匹配当前请求；用户替换命令时，只能替换当前命令型请求，替换后仍需重新经过策略判定并按替换后的命令建立 grant key。
- 非危险最终答案、计划摘要和访问权限状态不触发 approval interrupt。

工具执行失败时，失败原因和正确用法应由工具结果自身返回，并作为 `ToolMessage` 进入模型上下文；失败结果应包含结构化的 `failure.reason` 和 `failure.guidance`。图不再通过 `reflect` 节点额外注入失败指导。

底层调用 shell 的工具必须保留 shell 返回的 `stdout`、`stderr` 和 `exitCode`。非零退出或 shell executor 异常都应转换为 `ok: false` 的工具结果，不能抛出到图执行层并阻断 `ToolMessage` 返回。

## 不要做

- 不要重新引入 `stop_check` 路由作为最终答案硬守卫。
- 不要为只读访问完成增加非危险 `mode_confirmation` 或 `access_confirmation` interrupt。
- 不要把 `ask_user` 复用成工具审批、访问权限切换或最终答案确认。
- 不要把受保护操作的安全检查从 tool gating 移到仅靠 prompt 指令。
- 不要在 `routes.ts`、`tool-runner.ts` 或工具定义中新增与 `tool-policy.ts` 漂移的独立安全判断；只读 shell 白名单这类底层分类函数可以被策略复用。
- 不要静默削弱 `read-only` 访问的只读约束。
- 没有具体工具边界需求时，不要重新引入 evidence/progress 账本或 watchdog 式进度推断。

## 测试期望

`tests/graph.test.ts` 应断言：

- `read-only` 访问下 final 直接路由到 `END`。
- `write` 访问下 final 直接路由到 `END`。
- `read-only` 访问下写入尝试进入 tools 并被拒绝。
- `read-only` 和 `write` 访问下 `ask_user` 都进入 `user_input`，不经过 approval 或 tools 拒绝。
- `write` 访问下受保护工具调用仍经过 approval。
- `shell_execute` 的只读命令、高危命令、普通执行命令分别覆盖直通、拒绝、审批三种路径。
- 工具列表必须精确等于 `read_file`、`edit_file`、`write_file`、`shell_execute`、`update_plan` 和 `ask_user`。
- `shell_execute` schema 覆盖 action envelope 字段。
- `same_command` 授权命中后同命令直接进入 `tools`，不同命令不命中；`full_access` 下普通、写入、VCS 和 destructive shell 命令都允许。
- `approve_once` 不写入 command grant；`same_command` 写入当前 thread/workspace/command 的 grant；`full_access` 写入当前 thread 授权模式。
- `planning` 阶段的执行类工具在执行层被拒绝，且不会调用 shell executor。
- `shell_execute` 执行结果保留 `intent`、`objective`、`expectedObservation`、`failureStrategy`、`prefixRule` 和 `grantUsed`。
- 审批 payload 由 runtime 根据工具请求和策略生成，包含风险、摘要、原因、预期影响和 hash。
- 带 hash 的审批恢复会校验当前请求；替换命令会更新当前请求并重新进入策略判定。
- CLI resume 解析 `--approve`、`--approve-same-command`、`--full-access`、`--approval-hash` 和 `--replace-command`。
- `write` 访问下 `update_plan` 不自动切换工作区访问权限。
- 重复只读工具调用不会被 tool-runner 进度状态阻断。
- `tools` 和 `user_input` 完成后直接回到单一 `agent`。

`tests/real-agent.real.ts` 应显式覆盖当前全部模型可见工具：

- `read_file`、`write_file` 和 `edit_file` 通过真实模型文件工具链路覆盖，并用工具结果中的 `tool` 元数据确认。
- `shell_execute` 通过 inspect 失败恢复、verify action envelope、`same_command` 和 `full_access` 场景覆盖。
- `update_plan` 通过真实模型主动更新计划状态覆盖。
- `ask_user` 通过用户输入 interrupt 和恢复后的 tool message 覆盖。
