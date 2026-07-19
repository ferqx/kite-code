# MCP Agent Provider Recovery Phase 5 完成记录

状态：completed
实施日期：2026-07-17
计划：[`../../plans/2026-07-17-mcp-agent-provider-recovery-phase5.md`](../../plans/2026-07-17-mcp-agent-provider-recovery-phase5.md)
架构决策：[`../../../adr/0015-mcp-provider-availability-boundary.md`](../../../adr/0015-mcp-provider-availability-boundary.md)、[`../../../adr/0016-mcp-provider-action-runtime-lifecycle.md`](../../../adr/0016-mcp-provider-action-runtime-lifecycle.md)、[`../../../adr/0017-required-mcp-provider-admission.md`](../../../adr/0017-required-mcp-provider-admission.md)
当前规则：[`../../../active/mcp-runtime-governance.md`](../../../active/mcp-runtime-governance.md)、[`../../../active/mcp-control-plane.md`](../../../active/mcp-control-plane.md)

## 完成内容

- Supervisor 通过中立 `McpRuntimeProvider` 暴露脱敏 provider directory；Runtime 使用 typed provider failure 区分登录、项目批准、暂时不可用和 capability 漂移。
- `capability_search` 可返回 bounded unavailable-provider 元数据，但不返回 schema、capability ID、binding 或调用句柄。
- 默认关闭的 `mcpProviderActionV1` 增加持久 Provider Action lifecycle。原 MCP Tool Call 先终结；成功恢复只在新 turn 继续，defer/failure 不重放旧调用。
- Runtime schema 12 持久 required-provider admission 队列与 session waiver。首次模型请求前，非 ready/degraded 的 required Provider 必须 Retry、Session Waive 或 Cancel Run。
- TUI 把 Provider Action 与 admission required 事件投影到既有输入中断面，并由 `TuiMcpController` 复用 Supervisor login、project approval 与 retry。CLI 缺少恢复 controller 时安全 defer/cancel。
- `/mcp` 保持 ADR-0012 定义的只读 effective Server 列表，没有恢复配置管理 route。

## 验证证据

- Runtime、MCP、配置、golden 与 SessionManager 定向套件：`175 pass, 0 fail`。测试 HTTP Server 统一使用固定随机端口与 bounded 冲突重试，不再依赖当前 Bun 环境不稳定的 `port: 0` 分配。
- TUI reducer 单独回归：`155 pass, 0 fail`，覆盖 Provider Action 与 required admission 的输入投影。
- MCP authentication PTY：`4 pass, 0 fail`。其中 required gate 在 waiver 前保持模型请求数为零；failed MCP Tool Call 的 Later 路径确认旧 Tool 只调用一次。
- 默认完整套件：`1500 pass, 1 skip, 0 fail`；默认按平台条件跳过的 native MCP keyring smoke 已显式启用并单独验证为 `1 pass, 0 fail`。
- 独立 E2E 与 TUI PTY 套件：`123 pass, 0 fail`，覆盖 28 个测试文件。
- `bun run typecheck` 通过。
- 文档影响、文档结构、Core 边界、Biome 与 diff whitespace 门禁在本记录归档时通过。

## 安全与产品边界

Provider Action 事件不携带 URL、token、authorization code、旧 Tool raw args、binding 或 approval。Session Waive 只解除本次 Runtime admission，不改变 Provider health、capability snapshot 或模型可见工具。任何恢复都必须重新进入模型边界并使用当前 catalog revision。
