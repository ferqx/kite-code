# MCP 项目配置审批门禁

状态：active
读取时机：修改 MCP 配置发现、项目来源、连接启动、`/mcp` 审批交互或 Approval Store 时。
验证：`bun test tests/mcp-config-catalog.test.ts tests/mcp-project-approval.test.ts tests/mcp-panel.test.tsx`、`bun test --parallel=1 --max-concurrency=1 tests/e2e/mcp-skills-auth-scopes.test.ts tests/tui-system/scenarios/mcp-project-approval.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0009、`src/core/config/mcp-config.ts`、`src/core/config/mcp-project-approvals.ts`、`src/app/tui/hooks/useMcpConnection.ts`。

## 当前安全性质

默认配置发现保留以下兼容优先级：

```text
project .kite-code > user kite-code > project .mcp.json
```

`project_kite_code` 与 `project_mcp_json` 的有效 Server 必须先获得本机用户对当前配置摘要的批准。`pending_approval`、`rejected`、`invalid`、`store_corrupt` 或 `store_unavailable` 的项目条目不会进入 `loadMcpConfig().servers`，因此 `McpManager` 不会为其创建 stdio 或 HTTP transport。高优先级项目条目被阻止时，不回退到同名用户条目。

用户来源保持原有自动连接行为。调用方显式传入的 `configPath` 只读取该文件，并被视为调用方已经授权的 `explicit` 来源；生产 TUI 使用默认来源发现，不能通过 `explicit` 绕过项目识别。

## 批准绑定

批准记录位于 `~/.kite-code/mcp-project-approvals.jsonc`，文件权限为 `0600`，使用临时文件、同步与 rename 原子替换。记录只保存 workspace/source/server 身份、SHA-256 摘要、决策和时间，不保存 command、args、URL、header、env 或 raw config。

摘要绑定以下输入：

- `realpath` 规范化后的 workspace identity；
- source kind 与 source path identity；
- Server 名称；
- 排序对象键但保留数组顺序的完整 raw config；
- 未识别字段和未展开的环境变量引用。

批准动作在写入前重新读取 source 并比较 expected digest。配置变化返回 `config_changed`，旧批准或拒绝记录不匹配新摘要，条目回到 `pending_approval`。Approval Store 损坏或不可读时项目来源 fail closed，且不得覆盖损坏文件。

## 与 Runtime Policy 的边界

项目批准只允许创建 transport，不是 workspace authorization、annotation trust 或 Tool Approval。批准后的项目连接配置强制使用 `trust: untrusted`，并忽略项目声明的逐工具 `effects`、`minimumApproval`、`retry` 和 idempotency override。因此项目 Tool 默认保持 unknown effects、`minimumApproval: user` 与 `retry: never`。

Approval Store 和 `/mcp` 决策属于 MCP control plane，不写入任务 Runtime Event 或 session log。MCP capability 只有在批准、连接和 discovery 成功后才进入现有 revisioned catalog；后续 Tool 调用仍必须通过 turn binding、schema、Policy、Execution 与 Verification。

## TUI 行为

`/mcp` 在 Server 尚未连接时也显示项目审批条目，只展示 Server 名称、transport、source path、状态、摘要短前缀、stdio command 与参数数量或只保留 origin 的 HTTP endpoint，以及脱敏诊断；不会展示 URL path/query/fragment/userinfo、env、header 或参数内容。选中条目后：

- 连续两次按 `a`：确认批准当前摘要，重新加载目录并重建 MCP 连接集合；
- 连续两次按 `r`：确认拒绝当前摘要，重新加载目录并断开不再可连接的 Server；
- 配置已变化或存储异常：显示 Core 返回的安全诊断，不创建 transport。

Phase 0 仍由现有 `useMcpConnection` 管理一次性 Manager 生命周期，面板仍读取 Manager 状态。可订阅的 `McpSupervisor`、热重载和完整管理路由属于已激活总计划的 Phase 1/2，不能通过在 TUI 中复制第二套 SDK client 提前实现。
