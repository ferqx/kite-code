# ADR-0017：Required MCP Provider 是可审计的会话准入门禁

状态：accepted
日期：2026-07-17
决策者：@chenchao
相关：ADR-0001、ADR-0005、ADR-0010、ADR-0012、ADR-0015、ADR-0016

## 背景

MCP 配置已经能声明 `required`，但此前它只作为 control snapshot 元数据存在。若 required Provider 在新 Agent run 前不可用，直接继续会让任务在隐式缺少依赖的情况下执行；直接终止 TUI 又会把连接故障升级为进程故障。Project config 也不能借 `required` 单方面禁止用户继续当前会话。

## 决策

当默认关闭的 `mcpProviderActionV1` 开启时，`runRuntimeAgent()` 在第一次模型调用前读取 effective provider directory。required 且状态为 `ready` 或 `degraded` 的 Provider 直接准入；其余状态按 provider id 稳定排序，形成持久化 `provider.admission_required` 队列和单一活动 interaction。optional Provider 不进入门禁。

门禁支持三种结构化决定：

- Retry：App shell 执行 control-plane retry，再返回 `ready` 或仍 unavailable 的脱敏结果；Runtime 记录 requested 和 satisfied/failed 事实；
- Session Waive：记录 provider、source、固定 reason `user_session_waiver` 和时间，然后继续当前 Runtime session；
- Cancel Run：记录 admission cancelled、task cancelled 和 turn aborted，并终止本次 runner。

Waiver 只解除任务准入，不改变 provider directory、capability snapshot、descriptor availability 或 binding。模型会收到“该 required Provider 已被用户对当前 session waive、能力仍不可用”的 Runtime transcript 事实。user/project/explicit 来源都允许 session waiver；managed/admin no-waiver policy 不在当前范围。

Runtime schema 升级到 12，新增 pending admissions 与 session waivers。schema 11 snapshot 迁移为空 admission state；挂起 gate 和 waiver 随 RuntimeStore snapshot/event replay 恢复。多个 required Provider 逐个处理，只有 pending 队列清空后 Scheduler 才能调用模型。

实际 Retry、Waive、Cancel 的 foreground/background TUI 组件和 Supervisor handler 属于 Phase 5D。未接入 handler 的 CLI/TUI 边界必须安全取消或 defer，不得绕过门禁，也不得扩张 `/mcp`。

## 备选方案

- required 不可用时自动继续：让配置语义失效且 Agent 不知道依赖缺失。
- required 不可用时阻止 TUI 启动：把任务门禁错误提升为应用可用性故障。
- 自动 retry 旧 Tool Call：required admission 发生在模型调用前，不应制造或重放调用。
- waiver 使 capability 可见：把准入决定错误地变成 discovery/authorization。
- project config 禁止 waiver：超出当前本地用户控制模型，managed policy 需要单独 ADR。

## 影响

新 run 在 required 依赖缺失时不会静默调用模型。Retry、waiver 和 cancel 都有持久事实；waiver 不会伪造 capability。TUI 仍可启动并查看只读 `/mcp` 状态。

## 回滚

可以关闭 `mcpProviderActionV1` 回到 required 仅作诊断元数据的兼容路径。不得在回滚中让 waiver 产生 binding、让 project config 获得不可撤销的 no-waiver 权限，或让 Core 直接持有 App control mutation API。
