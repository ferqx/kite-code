# MCP TUI 管理中心 Phase 1 完成记录

状态：completed
实施日期：2026-07-15
计划：`../../plans/2026-07-15-mcp-tui-management-center-implementation.md`
架构决策：`../../../adr/0010-mcp-supervisor-control-plane.md`
当前规则：`../../../active/mcp-control-plane.md`

## 完成内容

- `McpManager` 增加订阅通知、单 Server disconnect/reconnect、generation 校验、失效优先关闭顺序和 typed/redacted diagnostic；旧 generation 的迟到连接、发现和通知结果不能覆盖当前状态。
- 新增 frontend-neutral `McpSupervisor`，组合 source-aware 配置、项目审批门禁和 Manager Runtime 状态，发布不可变、稳定 revision 的 control snapshot；Supervisor 只编排，SDK client 仍由 Manager 唯一持有。
- Runtime、Controller、Subagent、Tool 与 Verification 依赖收窄为 `McpRuntimeProvider`，TUI 不再注入或读取 `McpManager` 内部 Map。
- 旧 `McpPanel` 与 `useMcpConnection` 被 route 化管理中心和 `McpController` 替代；支持 Server 列表、搜索、详情、Tools、Resources、Prompts、错误、项目审批、显式 retry 和逐层 Esc 返回。
- `/mcp`、`/mcp <server>` 与 `/mcp retry <server>` 共享同一 control plane；Phase 1 保持只读，不开放普通配置添加、删除、enable/disable 或 scope mutation。
- 新增 ADR-0010、当前控制面规则，并同步 README、book、MCP 当前规则和 documentation map。

## 安全与一致性证据

- capability snapshot 与 prompt registry 在 transport 关闭前失效，旧 generation 的异步完成只关闭自身，不能恢复已撤销能力。
- control snapshot 不暴露 SDK client、env、header 或参数内容；diagnostic 消息经过长度限制和 secret/URL 脱敏。
- retry 只对 diagnostic 明确标为 retryable 的 Server 开放；Tool 调用自动重试仍只允许本地明确配置的安全读或幂等策略。
- project stdio 在 pending 时不启动，真实键盘双重确认后才连接；只读 PTY 场景验证 discovery 结果、详情子路由和逐层返回。

## 验证

- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs` 与 `git diff --check` 通过。
- Manager、Supervisor、MCP overlay、TUI reducer/layout/slash command 与文档空间目标测试：`355 pass, 0 fail`。
- MCP overlay/diagnostic 增量测试：`11 pass, 0 fail`。
- 真实 PTY：只读管理中心与项目审批 `2 pass, 0 fail`。
- 工作树 documentation impact 审计覆盖 63 个变更文件并通过；所有本次变更的 TypeScript/TSX/JSON 文件通过定向 Biome error-level check。
- 本次没有暂存、提交、推送或创建 PR；提交前仍须完整执行项目 `document-before-commit` Skill。

## 后续

总计划继续保持 active。Phase 2 在本控制面之上实现三层配置 repository、原子 mutation、冲突检测、watch/reconcile，以及 Add/enable/disable/remove/migrate 交互；OAuth、Credential Store、Tool Policy 和 Agent Provider Action 仍分别属于 Phase 3–5。
