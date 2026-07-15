# MCP Control Plane 与管理中心

状态：active
读取时机：修改 `McpManager` 生命周期、`McpSupervisor`、MCP control snapshot、TUI `/mcp` 路由或 Runtime MCP provider 边界时。
验证：`bun test tests/mcp-manager.test.ts tests/mcp-supervisor.test.ts tests/mcp-config-reconcile.test.ts tests/mcp-panel.test.tsx tests/mcp-overlay-reducer.test.ts tests/tui-slash-command.test.ts`、`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-config-management.test.ts tests/tui-system/scenarios/mcp-management-readonly.test.ts tests/tui-system/scenarios/mcp-project-approval.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0010、ADR-0011、[`mcp-config-management.md`](mcp-config-management.md)、`src/core/mcp/supervisor.ts`、`src/core/mcp/control-types.ts`、`src/app/tui/mcp/`。

## 权威与依赖

`McpSupervisor` 是 MCP 连接 control plane 的唯一 App 入口。它通过 `McpConfigRepository` 加载 source-aware config catalog，立即发布 configured、disabled、pending、rejected、invalid 和 shadowed 条目，再在后台通过唯一的 `McpManager`/SDK client 路径连接可连接 Server。单个 Server 失败不阻塞 TUI mount 或其他 Server。

Runtime 只接收 `McpRuntimeProvider`，不依赖 Supervisor 或 TUI controller。TUI 只接收 `McpController` 和不可变 `McpControlSnapshot`，不得持有 `McpManager`，也不得调用 `getServerStates()`。Manager 的该方法只保留为 Core control-plane 迁移 API，并返回隔离副本。

## 生命周期与 generation

- `disconnect(name)` 先从 capability snapshot 和 prompt registry 移除 Server，再 best-effort 关闭 client；
- `reconnect(name, config, generation)` 先完成上述失效，再创建替代连接；
- connect、discovery 和 list-changed 回调只有在 client 与 generation 仍匹配时才能发布状态；
- 迟到的旧 generation 必须关闭自身，不能覆盖新状态或恢复旧 capability；
- `disconnectAll()` 先原子清空 Manager 可见状态，再并行关闭 transport；
- Supervisor 的 `start()`/`stop()` 幂等；reload、retry 和 mutation 进入同一串行 reconcile 队列并再次经过项目审批门禁；
- catalog diff 中 changed、removed、disabled 先撤销能力再关闭旧 client；unchanged 保留现有连接；
- provider config version 变化必须改变 capability descriptor revision，旧 turn binding fail closed。

Manager health、discovery、list-changed、call circuit 和 retry 变化均触发订阅。Supervisor 将其与 config catalog 投影为新的稳定 snapshot；snapshot revision 对规范化的可见字段计算，同一内容不会因 React render 产生伪 revision。

## Snapshot 与诊断

Control snapshot 包含全部有效和被遮蔽的 Server，并提供 source/revision、enabled/required、shadow/fallback、transport、config/auth/health、generation、capability revision、Tools/Resources/Prompts 只读投影、计数、retry 时间和 typed diagnostic。数组、key、审批 review 与嵌套 capability 数据均不可变。

Core diagnostic 只表达 code、retryable、脱敏 message 和有限 technical fields。Core 不提供展示标题或操作文案。URL 只保留 origin，authorization、token、secret 和 query credential 必须脱敏；TUI 决定标题、颜色、截断和建议动作。

## TUI 行为

`/mcp` 打开稳定排序的 Server list；`/mcp <server>` 直接进入 detail；`/mcp retry <server>` 重新经过 config/approval gate 后进入 detail。Overlay route 覆盖 list、detail、tools、resources、prompts、error、approval、add 和 mutation confirmation。

搜索、selection、route、二次确认只存在于 `src/app/tui/mcp/reducer.ts`。Esc 先退出搜索或子 route，再从 detail 回到 list，最后关闭 overlay。键盘 `r` 只对 `diagnostic.retryable` 的 Server 生效。项目审批继续要求同一决定键二次确认，且审批页只显示 Phase 0 允许的脱敏 review。

Phase 2 已开放 Add、enable/disable、remove、legacy migrate 和 reload。TUI 只调用 App controller；revision conflict、原子写入、source 权威与 reconcile 仍属于 Core。完整配置规则见 [`mcp-config-management.md`](mcp-config-management.md)。
