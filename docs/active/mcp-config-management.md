# MCP 双来源配置与热重载

状态：active
读取时机：修改 MCP 配置来源、schema、路径、Repository mutation、文件 watcher、Supervisor reconcile 或 TUI 配置边界时。
验证：`bun test tests/mcp-config-catalog.test.ts tests/mcp-config-repository.test.ts tests/mcp-config-reconcile.test.ts tests/mcp-project-approval.test.ts tests/mcp-supervisor.test.ts tests/mcp-credential-store.test.ts tests/mcp-oauth-integration.test.ts tests/mcp-panel.test.tsx tests/tui-slash-command.test.ts tests/slash-suggestions.test.ts`、`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-management-readonly.test.ts tests/tui-system/scenarios/mcp-project-approval.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0019、ADR-0013、ADR-0014、ADR-0018、`src/core/config/mcp-config-repository.ts`、`src/core/config/mcp-config.ts`、`src/core/mcp/supervisor.ts`、[`mcp-authentication.md`](mcp-authentication.md)、`src/app/tui/mcp/`。

## 来源与优先级

默认目录按以下顺序选择同名 effective Server：

```text
project <workspace>/.kite-code/mcp.json
> user ~/.kite-code/mcp.json
> read-only legacy sources
```

`project` 与 `user` 是仅有的可写来源。TUI Add 的 Current project 映射 `project`，All projects 映射 `user`。旧 hash workspace 文件、`.mcp.json`、项目和用户 `kite-code.jsonc#mcpServers` 只兼容读取与显式迁移，优先级低于规范来源。调用方显式 `configPath` 仍是单文件 `explicit` 来源，不与默认目录合并。所有项目控制来源都必须通过项目配置摘要审批。

移除只删除选中的 source entry。若下层存在同名配置，它会在下一次 catalog 计算中成为 effective；任何提供 remove 的非 TUI 前端都必须在确认前展示该 fallback source。被审批阻止的高优先级项目条目仍不回退到低优先级来源。

## Mutation 与文件安全

所有写操作通过 `McpConfigRepository.mutate()` 的 typed command：add、update、remove、set_enabled、migrate_legacy。名称长度为 1–64，只允许稳定的字母、数字、点、下划线和连字符组合，不能使用连续下划线或保留 MCP 命令名。

MCP 配置 schema 不识别数据分类、正文授权或 egress permit 字段，解析时不会把这类未知字段
带入 effective config。项目/user Server policy 可按
既有规则收紧 Tool 可见性、副作用与审批，但不能把 HTTP 非空参数的 Runtime 分类从
`confidential` 降为 `internal/public`，也不能用 host allowlist、read-only annotation 或 Provider
consent 替代单次 remote content permit。

- mutation 重新读取文件并验证 source/entry expected revision；
- 外部变化返回 `config_conflict`，不得覆盖；
- JSONC edit 只修改 `mcpServers` 下的目标键，保留无关字段、注释和环境变量占位；
- 写入使用目标同目录临时文件、文件 flush、权限设置和原子 rename；已有文件保留原 mode，新建 user 文件为 `0600`，新建 project 文件为 `0644`；
- legacy 迁移从原位置删除目标条目并写入 `<workspace>/.kite-code/mcp.json`，两边无关内容保持不变；
- project add/migrate 只产生 pending approval，保存动作不得同时批准。

Watcher 只把文件事件视为 reload 提示，debounce 后重新读取全部来源。事件内容不作为配置事实；TUI 不提供手动 reload，watcher 不可用或事件丢失时通过重启 TUI 触发完整加载与 reconcile。Core 的显式 `reload()` 能力继续保留给非 TUI 调用方。

## Schema 与 secret 边界

Schema、Repository 与手工 JSONC 支持 stdio/HTTP transport 以及 `enabled`、`required`、`cwd`、timeout、args、env/header 配置。`enabled: false` 保留完整配置和环境引用，但不连接、不发布未来 capability。默认关闭的 `mcpProviderActionV1` 开启后，`required` 进入 Runtime 首次模型调用前的持久准入门禁；不可用 Provider 必须 Retry、当前 session waiver 或 Cancel Run。该语义不改变配置、连接状态或 capability 可见性，`/mcp` 也不展示该字段。

Tool 可见性按以下顺序解析：

1. `enabledTools` 存在时作为 allowlist；
2. `disabledTools` 在 allowlist 后应用；
3. `tools.<name>.enabled` 作为精确 override。

逐 Tool policy 还可配置 `effects`、`minimumApproval`、`retry` 和 `idempotencyKeyArgument`。user 与调用方授权的 explicit 来源可以使用完整字段；project 及 project legacy 获批后只保留 allowlist、denylist、精确 disable、`minimumApproval: user` 和 `retry: never`。项目声明的精确 enable、annotation trust、effect 降级、较低 minimum approval 或 retry 放宽不会进入连接配置。引用 discovery 不存在的 Tool 只产生 control diagnostic，不使 Server 配置无效。

普通 JSONC 可以为 HTTP transport 保存环境变量名、credential profile 与 OAuth metadata，但不能保存 inline OAuth client secret；stdio 声明携带 `auth` 会被拒绝。`environment` 在 transport 构造时读取 env；`credential` 只保存 header、scheme 与 `credentialRef`；`oauth` 只保存 profile、scopes、client id、`clientSecretRef` 等非 secret metadata。TUI Add 不录入这些字段。Disable 和普通 Repository mutation 不删除 credential；TUI Remove 经 Supervisor 删除配置后尝试清理已投影的本地 OAuth credential，失败必须报告部分完成。未显式配置 auth mode 的 HTTP Server 可由真实认证状态触发 OAuth。完整持久化与生命周期见 [`mcp-authentication.md`](mcp-authentication.md)。

## Reconcile 与 Runtime 一致性

Supervisor 将 reload、retry 和 mutation 放入同一串行 reconcile 队列。新 catalog 到达后：

1. 先发布新的配置可见性；
2. 对 changed、removed、disabled Server 撤销 Manager capability/prompt 可见性；
3. 关闭旧 generation client；
4. 对通过配置与审批门禁的 added/changed/enabled Server 建立新 generation；
5. 未变化 Server 保持原连接。

provider version 绑定 source identity、Server 名称和规范化配置。即使 Tool schema 没变，配置或 effective source 变化也会改变 descriptor revision，使旧 turn binding fail closed。reconcile 不自动重放已登记、结果未知或正在完成的外部写。

## TUI 行为

`/mcp` 不接受参数或管理子命令；管理动作只由 Overlay 的可见 Select 产生。List 只导航，Detail 才可调用 controller。Add 收集 name、HTTP URL 或 STDIO command、transport 和 project/user availability；不收集 arguments、cwd、env/header、timeout、required、auth metadata 或 Tool policy。

Add、set_enabled 和 remove 都使用 Repository typed mutation 与 snapshot expected revision。冲突保留当前 UI 状态并显示 Core message，不覆盖外部变化。TUI 只写两个规范路径、不迁移 legacy、不编辑既有配置；项目 transport 前置决定在 Detail 的独立 Review route 完成，不与 config mutation 合并。
