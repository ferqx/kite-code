# ADR-0016：MCP Provider Action 使用独立 Runtime 交互与新 Turn

状态：accepted
日期：2026-07-17
决策者：@chenchao
相关：ADR-0001、ADR-0005、ADR-0007、ADR-0012、ADR-0015

## 背景

ADR-0015 让 Runtime 能区分 Provider 等待批准、需要登录、暂时不可用和 capability 漂移，但 typed failure 本身不会执行恢复。若 Tool Controller 直接 retry、重新批准或继续使用旧 Tool Call，会复用旧 turn 的 binding、参数或授权事实；若把 login/retry 塞回 `/mcp`，则违反 ADR-0012 的只读边界。

## 决策

新增默认关闭的 `mcpProviderActionV1`。开启后，只有带固定恢复动作的 MCP typed failure 才能在 `tool.failed` 之后产生 `provider.action_required`：

- `provider_auth_required` → `login`；
- `provider_approval_required` → `approve`；
- retryable `provider_unavailable` → `retry`；
- `provider_capability_changed` 不创建外部恢复动作，由模型在新 catalog 事实下修复。

Provider Action 是独立的持久化 `InteractionState`、Runtime Event 和 interrupt Effect。交互只保存 interaction id、provider id、固定 action、原 Tool Call id 与 required/started 状态；不得保存旧 Tool 参数、binding、approval、token、URL、authorization code 或 raw error。原 Tool Call 必须已经是 `failed` 且不在 queue/active 中，恢复动作不得把它重新入队。

App shell 是 login、project approval 和 retry 的执行所有者。Runtime 只请求动作并接收 `completed`、`deferred` 或固定 failure code，不依赖 MCP control mutation API。App handler 后续必须以 interaction id 实现幂等恢复，并在重启后先检查当前 Provider 状态。`/mcp` 保持只读。

`provider.action_completed` 必须与一个新的 `turn.started` 同批提交。后续模型调用只能从新 turn 的当前 catalog 获取新 binding；旧 Tool Call、binding、approval 和 invocation 永不重放。deferred/failed 清除交互并形成明确 Runtime transcript 事实，但不宣称 Provider 已恢复。

Runtime schema 升级到 11。旧 snapshot 正常迁移；挂起的 Provider Action 可从 required/started 状态恢复调度。runner 在调用 App handler 前持久化 `provider.action_started`；handler 抛出的未分类异常只落成固定 `unknown` failure code，不持久化异常文本。

## 备选方案

- 原地 retry 旧 Tool Call：会复用旧 binding、参数和授权上下文。
- Provider 恢复成功后继续同一 turn：无法证明后续 binding 来自新 catalog revision。
- 把控制动作加入 `/mcp`：违反只读列表决策，并把 Agent 恢复与人工管理中心混在一起。
- 把 URL、错误文本或认证状态直接放进 Runtime action：扩大 secret 与日志泄漏面。
- Provider Action 不持久化：重启后无法区分尚未开始、执行中和已明确延后。

## 影响

flag 关闭时保留 ADR-0015 的 typed failure 行为，不创建新交互。flag 开启时，Agent loop 会在 terminal Tool 事实之后暂停到 App shell；成功恢复强制进入新 turn。Core lifecycle、migration、replay 和 golden 已可独立验证，foreground/background 的完整 App/TUI handler 仍由 Phase 5D 接入。

## 回滚

可以关闭 `mcpProviderActionV1` 回到纯 typed failure 路径。不得通过回滚恢复旧 Tool Call、在 Runtime 保存认证材料、让 Core 直接操作 App control plane，或扩张 `/mcp` 路由。
