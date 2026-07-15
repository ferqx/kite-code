# MCP TUI 管理中心 Phase 2 完成记录

状态：completed
实施日期：2026-07-15
计划：`../../plans/2026-07-15-mcp-tui-management-center-implementation.md`
架构决策：`../../../adr/0011-mcp-config-scopes-and-mutation.md`
当前规则：`../../../active/mcp-config-management.md`

## 完成内容

- 新增 source-aware `McpConfigRepository`，建立 local、project、user 三层可写来源和只读 `project_legacy` 兼容来源；有效优先级为 local > legacy project > project > user，remove 后可显式看到低层 fallback。
- typed add/update/remove/set_enabled/migrate command 使用 expected revision、重新读取、JSONC edit、同目录临时文件、flush、mode 和原子 rename；外部修改返回 `config_conflict`，不覆盖注释或无关配置。
- source watcher 只触发 debounce 后全量 reload；手动 `/mcp reload` 与 watcher 共享加载/reconcile 路径。
- schema 与 control snapshot 增加 enabled、required、cwd、source/entry revision、shadow/fallback；disabled 保留环境引用但不创建 transport。
- Supervisor 串行处理 reload/retry/mutation，并按 provider config version 增量 reconcile；changed/removed/disabled 先撤销未来能力再关闭旧 client，unchanged Server 不重连，旧 turn binding 因 descriptor revision 变化 fail closed。
- TUI 增加非 OAuth HTTP/STDIO Add Wizard、启用/禁用/删除/legacy migration 确认页，以及 add/enable/disable/remove/approve/reject/reload slash command。project add/migrate 保存后仍独立进入 pending approval。
- Phase 0 的 `project_mcp_json`、`project_kite_code` 本地审批记录继续兼容，不要求升级后重复授权。

## 安全与一致性证据

- mutation conflict 测试在目标文件外部改变后拒绝写入；JSONC 注释和环境变量 placeholder 在 update/disable 后保持原样。
- project add 不自批，legacy migration 不复制审批决定；项目 transport 仍在批准前 fail closed。
- HTTP Wizard 预览只显示 origin，不显示 query/fragment/userinfo 或环境/header value；破坏性 slash command 只进入确认页。
- provider 配置变化先失效旧 capability generation，再连接新 generation；未变化 Server 的连接和 generation 保持不变。
- remove 只影响目标 source，低优先级配置由完整 catalog 重算后恢复，不删除 credential material。

## 验证

- 默认 `bun test` 全部通过；定向 Repository、reconcile、catalog、审批、Supervisor、MCP panel/reducer、slash 与 suggestions 为 `75 pass, 0 fail`。
- 真实 PTY 为 `3 pass, 0 fail`，覆盖窄终端 Wizard、local stdio 添加与连接、disable、slash enable、remove，以及 Phase 1 只读管理和项目审批回归。
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs` 与 `git diff --check` 通过。
- 本轮新增/修改的 MCP TypeScript/TSX 文件通过定向 Biome check。提交前仍须执行项目 `document-before-commit` Skill。

## 后续

总计划继续保持 active。Phase 3 在当前 JSONC reference 边界之上选择跨平台 Credential Store backend，并实现 HTTP OAuth login/logout/refresh/revoke；不得把 secret material 写入普通配置作为 fallback。Phase 4–5 的 Tool Policy 与 Agent Provider Action/required 准入仍未实施。
