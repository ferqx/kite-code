# MCP 项目配置审批门禁

状态：active
读取时机：修改 MCP 配置发现、项目来源、连接启动、项目信任提示或 Approval Store 时。
验证：`bun test apps/kite-service/test/isolated/mcp-config-catalog.test.ts apps/kite-service/test/isolated/mcp-project-approval.test.ts apps/kite-service/test/mcp-supervisor.test.ts apps/kite-cli/test/mcp-panel.test.tsx apps/kite-cli/test/slash-suggestions.test.ts`、`bun test --parallel=1 --max-concurrency=1 tests/e2e/local/mcp-skills-auth-scopes.test.ts tests/tui-system/scenarios/mcp-project-approval.test.ts tests/tui-system/scenarios/mcp-management-readonly.test.ts tests/tui-system/scenarios/slash-commands.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0009、ADR-0010、ADR-0014、ADR-0018、`apps/kite-service/src/config/mcp-config.ts`、`apps/kite-service/src/config/mcp-project-approvals.ts`、`packages/builtin-runtime/src/mcp/supervisor.ts`、`apps/kite-cli/src/tui/mcp/`。

## 当前安全性质

默认配置发现使用以下优先级：

```text
project .kite-code/mcp.json > user ~/.kite-code/mcp.json
```

`project` 的有效 Server 必须先获得本机用户对当前配置摘要的批准。`pending_approval`、`rejected`、`invalid`、`store_corrupt` 或 `store_unavailable` 的项目条目不会进入 `connectableServers`，因此 `McpManager` 不会为其创建 stdio 或 HTTP transport。项目条目被阻止时，不回退到同名 user 条目。

local 与 user 来源保持自动连接行为。调用方显式传入的 `configPath` 只读取该文件，并被视为调用方已经授权的 `explicit` 来源；生产 TUI 使用默认来源发现，不能通过 `explicit` 绕过项目识别。

## 批准绑定

批准记录位于 `~/.kite-code/mcp-project-approvals.jsonc`，文件权限为 `0600`，使用临时文件、同步与 rename 原子替换。记录只保存 workspace/source/server 身份、SHA-256 摘要、决策和时间，不保存 command、args、URL、header、env 或 raw config。

摘要绑定以下输入：

- `realpath` 规范化后的 workspace identity；
- source kind 与 source path identity；
- Server 名称；
- 排序对象键但保留数组顺序的完整 raw config；
- 未识别字段和未展开的环境变量引用。

批准动作按canonical path顺序同时取得source配置与Approval Store的owner-specific lock，再重新读取source并比较expected digest、重读Approval
Store后执行atomic replacement。配置变化返回`config_changed`，锁/Store不可用返回`store_unavailable`；旧批准或拒绝记录不匹配新摘要，条目回到
`pending_approval`。Approval Store损坏时fail closed且不得覆盖。外部编辑器虽不参与Kite lock，后续connect仍重新按当前config digest匹配批准记录。

## 与 Runtime Policy 的边界

项目批准只允许创建 transport，不是 workspace authorization、annotation trust 或 Tool Approval。批准后的项目连接配置强制使用 `trust: untrusted`。项目可通过 `enabledTools` allowlist、`disabledTools` denylist、`tools.<name>.enabled: false`、`minimumApproval: user` 和 `retry: never` 收紧策略；精确 enable、逐工具 effect 降级、较低 minimum approval、可重试策略与 idempotency override 被忽略。因此未被进一步收紧的项目 Tool 仍保持 unknown effects、`minimumApproval: user` 与 `retry: never`。

Approval Store 和项目配置信任决定属于 MCP control plane，不写入任务 Runtime Event 或 session log。MCP capability 只有在批准、连接和 discovery 成功后才进入现有 revisioned catalog；后续 Tool 调用仍必须通过 turn binding、schema、Policy、Execution 与 Verification。

## TUI 行为

`/mcp` 注册在 TUI 的静态斜杠命令表中。输入 `/m`、`/mc` 或完整命令时，候选面板显示 `/mcp` 及“管理 MCP Server”说明；Tab、右方向键和 Enter 遵循通用补全行为。命令只接受无参数形式。

Supervisor 发布 effective `pending_approval` 或 `rejected` 项目条目后，它以“需要审批”或“已拒绝”出现在 Server List。用户进入 Detail 并选择“审核服务器”或“审核决定”后，审核页只展示 Server 名称、transport、stdio command 或 HTTP origin 和固定信任警告；不会展示 URL path/query/fragment/userinfo、env、header 或参数内容。Select 默认“稍后决定”，并提供“批准并连接”与“拒绝服务器”：

- 稍后决定/Esc：保持当前决定，不创建 transport；
- Approve：绑定当前 digest 记录批准，reload 后进入 connecting；
- Reject：绑定当前 digest 记录拒绝，Detail 原地投影 Rejected；
- 配置已变化或 Store 异常：显示 App Repository/Builtin Supervisor 投影的安全诊断，不创建 transport。

TUI 不使用 `a/r` 功能键。任何外部写入或 App Repository mutation 产生的新项目摘要都必须重新进入 pending approval。完整 control-plane 与配置边界见 [`mcp-control-plane.md`](mcp-control-plane.md) 和 [`mcp-config-management.md`](mcp-config-management.md)。
