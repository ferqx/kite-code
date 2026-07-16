# `/mcp` 只读连接状态列表完成记录

状态：completed
实施日期：2026-07-16
计划：[`../../plans/2026-07-16-mcp-tui-readonly-list.md`](../../plans/2026-07-16-mcp-tui-readonly-list.md)
架构决策：[`../../../adr/0012-mcp-tui-readonly-list.md`](../../../adr/0012-mcp-tui-readonly-list.md)
当前规则：[`../../../active/mcp-control-plane.md`](../../../active/mcp-control-plane.md)

## 完成内容

- `/mcp` 收敛为无参数命令，只显示 effective MCP Server 的 `[status] name`；shadowed 来源、transport、scope、capability 详情和诊断不进入列表。
- 删除 TUI selection、搜索、详情、Tools/Resources/Prompts、Add Wizard、确认页、配置 mutation、retry 和 reload 路由；带参数的 `/mcp ...` 按 unknown command 处理。
- TUI controller 只保留 control snapshot 订阅与项目摘要决定；Core Repository、三层来源、原子 mutation、revision conflict、watch/reconcile 和 legacy 迁移能力保持不变。
- 项目 MCP 摘要审批迁移到 App shell 独立信任提示，继续双键确认；Esc 只延后当前提示，批准前不创建 transport。
- slash suggestion、HelpPanel、README、book、active 规则与 ADR 同步到只读契约。

## 验证

- MCP Repository、catalog、approval、reconcile、Supervisor、组件、slash parser/suggestion 共 65 项定向测试通过。
- 三个真实 PTY 文件共 24 项测试通过，覆盖只读 `/mcp`、独立项目审批、批准前零 stdio 进程和通用 slash command 回归。
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs` 与 `git diff --check` 通过。

## 历史关系

Phase 2 配置管理和随后 name + URL Wizard 的完成记录保留为当时实现事实。本记录与 ADR-0012 替代其 TUI 产品结论，不改写 Core 配置安全能力，也不迁移现有 project/local/user 配置路径。
