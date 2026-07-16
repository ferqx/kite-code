# ADR-0012：TUI `/mcp` 收敛为只读连接状态列表

状态：accepted
日期：2026-07-16
决策者：@chenchao
替代：ADR-0011 中关于 TUI mutation、显式 legacy 迁移入口和 `/mcp reload` 的 UI 结论

## 背景

ADR-0011 建立了三层可写配置、原子 mutation、revision 冲突检测和 watcher reconcile，并据此把 `/mcp` 扩展为配置管理中心。Phase 2 实际使用表明，transport、command/arguments、scope 和高级可选字段进入 TUI 后增加了不必要的配置负担，也与 Claude Code、Codex 一类终端工具中“配置来自文件、状态在 TUI 查看”的职责划分不一致。

配置来源已经能由文件位置确定。继续让 TUI 选择 scope、构造配置或提供详情操作，会形成第二套配置体验，也会把连接状态查看与持久化副作用耦合。

项目 MCP 仍有独立的安全要求：workspace 控制的配置在创建 transport 前必须取得绑定配置摘要的本地决定。移除 `/mcp` 审批 route 不能使该决定失去可达入口。

## 决策

TUI 只接受无参数 `/mcp`。它打开一个只读列表，只显示当前 effective MCP Server；每行仅包含连接/门禁状态和 Server 名称。列表不显示 source/scope、transport、command、arguments、URL、capability 数量、Tools、Resources、Prompts 或诊断详情，也不提供选择、搜索、详情和操作 route。

`/mcp` 不接受 Server 参数或 add、retry、reload、enable、disable、remove、migrate、approve、reject 等子命令。TUI controller 不再暴露 MCP 配置 mutation、手动 reload 或 retry。MCP 配置由文件位置决定来源，并由 watcher 与 Supervisor reconcile 自动加载；watcher 不可用时，重启 TUI 是人工全量重载入口。

Core 的 `McpConfigRepository`、三层来源、typed mutation、原子写入、revision 冲突检测、legacy 迁移能力和 Supervisor reconcile 继续保留，可供非 TUI 调用方或未来独立 CLI 使用。本决策不迁移配置路径，也不改变 source precedence。

项目配置审批从 `/mcp` 移到 App shell 的独立信任提示。提示展示 ADR-0009 允许的脱敏投影，approve/reject 继续要求同键二次确认并绑定当前 config digest；Esc 只延后本次提示，不能记录决定或创建 transport。配置摘要变化后重新提示。

动态 MCP Prompt 命令 `/mcp__<server>__<prompt>` 和 Runtime capability/binding 行为不受影响。

## 备选方案

- 保留简化 Add Wizard：仍然让状态视图承担配置写入，并不能消除 scope 与高级字段的双重心智模型。
- 只隐藏字段但保留详情和动作：用户仍会把 `/mcp` 理解为管理中心，命令契约也继续膨胀。
- 删除项目审批入口：会使 project Server 永久 pending，或诱导绕过 ADR-0009 的 transport 前置门禁。
- 同时删除 Core mutation：会丢失已经建立的原子写入、冲突检测和非 TUI 复用能力，超出本次 UI 纠偏范围。

## 影响

- `/mcp` 的行为稳定且无配置副作用，scope 不再成为 TUI 概念；
- 连接排障信息不再从 `/mcp` 展示，详细诊断留给日志或未来独立 CLI；
- 项目配置可能在启动后立即触发独立信任提示，但未决定前仍保持 transport 零副作用；
- watcher 失效时不再有会话内 `/mcp reload`，需要重启 TUI；
- ADR-0011 仍是 Core 配置来源和 mutation 安全语义的历史权威，其 TUI 管理结论由本 ADR 替代。

## 回滚

可以恢复更丰富的只读诊断视图，但重新引入 TUI 配置写入、管理子命令或手动 reload 需要新的产品决策。任何回滚都必须保留 ADR-0009 的 transport 前置审批、脱敏 review、摘要绑定和 TOCTOU 复核。
