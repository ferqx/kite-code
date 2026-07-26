# ToolSpec Registry 阶段 0/1 完成记录

状态：completed
日期：2026-07-26
计划：[`2026-07-26-tool-spec-registry.md`](../../plans/2026-07-26-tool-spec-registry.md)
决策：ADR-0026、ADR-0027

## 已完成

- 删除八类已核实漂移中的阶段 0 遗留；
- 建立 ToolSpec、Registry、泛型解析、dispatch、descriptor 与一致性不变量；
- 迁移 `read_file`、`search_content`、`search_files`、`write_file`、`edit_file`、`shell_execute` 六个计算原语；
- 模型工具条目 schema-only，真实执行经过 Registry dispatch；
- edit_file 严格精确匹配并强制先读后改，write_file 移除 append；
- shell_execute 参数收敛为 `command`、`description`、`timeout_ms`，审批和 action 元数据由命令形态与授权状态派生；
- 审批 payload、协议事件与 session recorder 不再保留模型提供的 intent、grant、objective、expected observation、failure strategy 或 suggested prefix 元数据；
- shell effects 由 spec 唯一定义，Approval Policy 复用该投影；只读命令分类移出 definitions 依赖环；
- 删除从未接入运行时的 `toolSpecRegistryV1`，按 ADR-0027 以单路径完成收尾。

## 验证证据

- `bun run typecheck`
- `bun run check:core-boundary`
- `bun run check:docs`
- `bun run check:docs-impact`
- `git diff --check`
- `bun run test:e2e`：7 pass，0 fail
- `bun run test`：1766 pass，2 skip；Registry conformance、Approval Policy、Tool Controller 和本次新增 shell 链路覆盖全部通过
- Registry/Policy/Prompt/Golden/Subagent 定向复跑：85 pass，0 fail
- TUI reducer、session recorder、Tool Policy 与 Registry conformance 定向复跑：243 pass，0 fail
- TUI `read-only shell_execute search command` 场景：1 pass，0 fail；验证 shell 使用独立 tool card，不再依赖已删除的 `intent`

全仓脚本仍报告 5 个与 ToolSpec Registry 无关的失败：MCP TUI 路径显示、Windows chmod mode、shell delayed abort 5 秒超时，以及两项 Windows compaction debug ACL 前置条件。逐文件复跑呈现相同的平台或时序失败，本改动未修改其实现或断言。本计划相关测试均通过，但仓库全局测试尚非全绿。

## 后续边界

本记录只完成原计划声明的阶段 0/1 和六个计算原语。RFC 阶段 2/3 的 coordination、interrupt、runtime_action 工具迁移仍须另行立项，不属于本计划未完成项。
