# MCP 三层配置与热重载

状态：active
读取时机：修改 MCP 配置来源、schema、路径、Repository mutation、文件 watcher、Supervisor reconcile、Add Wizard 或 `/mcp` 配置命令时。
验证：`bun test tests/mcp-config-catalog.test.ts tests/mcp-config-repository.test.ts tests/mcp-config-reconcile.test.ts tests/mcp-project-approval.test.ts tests/mcp-supervisor.test.ts tests/mcp-panel.test.tsx tests/tui-slash-command.test.ts tests/slash-suggestions.test.ts`、`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-config-management.test.ts tests/tui-system/scenarios/mcp-management-readonly.test.ts tests/tui-system/scenarios/mcp-project-approval.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0011、`src/core/config/mcp-config-repository.ts`、`src/core/config/mcp-config.ts`、`src/core/mcp/supervisor.ts`、`src/app/tui/mcp/`。

## 来源与优先级

默认目录按以下顺序选择同名 effective Server：

```text
local ~/.kite-code/projects/<workspaceKey>/mcp.jsonc
> project_legacy <workspace>/.kite-code/kite-code.jsonc#mcpServers
> project <workspace>/.mcp.json#mcpServers
> user ~/.kite-code/kite-code.jsonc#mcpServers
```

`local`、`project`、`user` 可写；`project_legacy` 只兼容读取和显式迁移，不接受普通 TUI 写入。调用方显式 `configPath` 仍是单文件 `explicit` 来源，不与默认目录合并。`project` 与 `project_legacy` 都必须通过项目配置摘要审批；已有 `project_mcp_json`、`project_kite_code` 决定继续兼容读取。

移除只删除选中的 source entry。若下层存在同名配置，它会在下一次 catalog 计算中成为 effective，确认页必须显示 fallback source。被审批阻止的高优先级项目条目仍不回退到低优先级来源。

## Mutation 与文件安全

所有写操作通过 `McpConfigRepository.mutate()` 的 typed command：add、update、remove、set_enabled、migrate_legacy。名称长度为 1–64，只允许稳定的字母、数字、点、下划线和连字符组合，不能使用连续下划线或保留 MCP 命令名。

- mutation 重新读取文件并验证 source/entry expected revision；
- 外部变化返回 `config_conflict`，不得覆盖；
- JSONC edit 只修改 `mcpServers` 下的目标键，保留无关字段、注释和环境变量占位；
- 写入使用目标同目录临时文件、文件 flush、权限设置和原子 rename；已有文件保留原 mode，新建 user/local 文件为 `0600`，新建 project 文件为 `0644`；
- legacy 迁移从原位置删除目标条目并写入 `.mcp.json`，两边无关内容保持不变；
- project add/migrate 只产生 pending approval，保存动作不得同时批准。

Watcher 只把文件事件视为 reload 提示，debounce 后重新读取全部来源。事件内容不作为配置事实；watcher 不可用或事件丢失时，`/mcp reload` 仍执行同一完整加载与 reconcile。

## Schema 与 secret 边界

Phase 2 支持 stdio/HTTP transport 以及 `enabled`、`required`、`cwd`、timeout、args、env/header 配置。`enabled: false` 保留完整配置和环境引用，但不连接、不发布未来 capability。`required` 当前仅被持久化和展示，Phase 5 才提供任务准入语义。

Phase 2 不提供 Credential Store 或 OAuth。Wizard 的 HTTP auth 只允许 None/Environment reference；普通 JSONC 可以保存环境变量引用，但管理页预览不能显示 header value、env value、URL query/fragment/userinfo 或参数内容。Disable/remove 不删除未来 Phase 3 credential。

## Reconcile 与 Runtime 一致性

Supervisor 将 reload、retry 和 mutation 放入同一串行 reconcile 队列。新 catalog 到达后：

1. 先发布新的配置可见性；
2. 对 changed、removed、disabled Server 撤销 Manager capability/prompt 可见性；
3. 关闭旧 generation client；
4. 对通过配置与审批门禁的 added/changed/enabled Server 建立新 generation；
5. 未变化 Server 保持原连接。

provider version 绑定 source identity、Server 名称和规范化配置。即使 Tool schema 没变，配置或 effective source 变化也会改变 descriptor revision，使旧 turn binding fail closed。reconcile 不自动重放已登记、结果未知或正在完成的外部写。

## TUI 行为

`/mcp add` 打开非 OAuth HTTP/STDIO Wizard；`/mcp enable|disable|remove <server>` 只导航到确认页；`/mcp approve|reject <server>` 进入既有项目审批；`/mcp reload` 手动全量重读。列表中 `a` 添加，detail 中 `g` 启用、`d` 禁用、`x` 删除可写来源、`m` 迁移 legacy。

Add Wizard 按字段收集配置并在写入前显示脱敏预览。project scope 保存后显示 pending approval 提示，用户必须通过独立审批路由决定。破坏性操作必须在 dialog 中显式确认；Esc 取消当前 Wizard/确认页并返回上层。
