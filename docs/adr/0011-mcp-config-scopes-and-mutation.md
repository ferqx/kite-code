# ADR-0011: MCP 配置使用三层可写作用域与显式 legacy 迁移

**Status**: superseded by ADR-0019
**Date**: 2026-07-15
**Decision makers**: @chenchao

## Context

Phase 0 为两个项目来源增加了 transport 前置审批，Phase 1 建立了单一 Supervisor control plane，但普通 MCP 配置仍需手工编辑。旧来源优先级 `project .kite-code > user > project .mcp.json` 也不适合作为长期配置模型：项目私有覆盖没有独立位置，`.mcp.json` 的共享语义弱于历史 `.kite-code` 路径，且 UI 写入历史复合配置会扩大修改面。

配置写入还必须与编辑器或其他进程并存。仅按文件事件增量修改、覆盖整份 JSONC 或在连接完成后才撤销旧能力，都会导致丢失用户修改、破坏注释或让旧 Runtime binding 暂时继续可用。

## Decision

MCP 配置采用以下有效优先级：

```text
local ~/.kite-code/projects/<workspaceKey>/mcp.jsonc
> project_legacy <workspace>/.kite-code/kite-code.jsonc#mcpServers
> project <workspace>/.mcp.json#mcpServers
> user ~/.kite-code/kite-code.jsonc#mcpServers
```

`local`、`project` 和 `user` 是可写作用域。`project_legacy` 继续兼容读取和项目审批，但普通 mutation 只读；迁移到 `.mcp.json` 必须展示源/目标差异并由用户显式确认。旧 `project_kite_code`、`project_mcp_json` 审批记录继续作为兼容别名读取，避免来源命名升级使已有决定失效。

所有写入由 Core `McpConfigRepository` 执行 typed command。mutation 必须携带 source 或 entry revision，重新读取目标文件并比较 revision，使用 JSONC edit 保留无关字段和注释，再通过同目录临时文件、flush、mode 与 rename 原子替换。冲突返回 `config_conflict`，不覆盖外部修改。Watcher 事件只触发 debounce 后的全量 reload；`/mcp reload` 始终保留为手动恢复入口。

Supervisor 串行执行 reload、retry 和 mutation reconcile。effective source、transport、command、URL、cwd、环境引用或 policy 配置变化都会生成新的 provider version；changed、removed 和 disabled Server 先从未来 capability/binding 可见性中撤销，再关闭旧 client 和连接新 generation。未变化 Server 保留连接，不自动重放外部写。

## Alternatives

- 继续让用户手工编辑：不能满足管理中心目标，也无法提供一致的冲突与迁移语义。
- 直接写 legacy `.kite-code`：扩大复合配置修改面，并把历史兼容路径固化为新产品入口。
- 使用最后写入者获胜：可能静默覆盖编辑器或同步工具的外部修改。
- 每次 reload 重建全部连接：会无谓中断未变化 Server，并扩大能力 revision 变化。

## Consequences

- 非 OAuth stdio/HTTP Server 可在 TUI 中完成添加、启停、删除、迁移和 reload；
- project 保存后仍独立进入 config-digest 审批，不允许添加动作隐式自批；
- remove 指定来源后，同名低优先级配置可以重新生效，确认页必须预告该 fallback；
- `required` 在 Phase 2 只持久化和展示，任务准入语义仍留给 Phase 5；
- OAuth、Credential Store 和 secret material 不进入本决策，Phase 2 只接受普通值或环境变量引用。

## Rollback

可以关闭 TUI mutation 入口或停止 watcher，但不得恢复覆盖式写入、隐式迁移、项目自批或先连接后失效。回滚后仍须保留三层来源读取、revision 冲突检测、旧审批记录兼容和手动 reload。
