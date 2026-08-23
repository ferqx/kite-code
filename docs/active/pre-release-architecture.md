# 未发布阶段架构门禁

状态：active

读取时机：修改 workspace 边界、生产实体命名、App composition、Runtime Session、Tool execution/persistence、SQLite storage 或 package exports 时。

验证：`bun run check:pre-release-architecture`、`bun run check:runtime-packages`、`bun run check:core-boundary`、`bun run typecheck`。

## Clean cutover

Kite Code 尚未发布，生产文件、目录、类型、函数、类、变量和 export 使用领域职责命名，不使用 schema 数字、协议数字或历史实施任务作为实体身份。schema version、protocol version、format epoch 与数据库 format marker 只能作为 metadata 值存在。

最终发布前，调用方必须直接使用唯一入口；仓库不得保留旧名 alias、双 codec、旧数据库 constructor、旧 sidecar fallback、格式选择分支或长期兼容 façade。持久格式不匹配仍严格 fail closed，并继续验证 checksum、Project/Workspace identity、Event/Snapshot revision 与 effect lease。

## 当前组合与目录

- `apps/kite/src/bootstrap.ts` 是唯一 concrete composition root。
- Runtime Session 位于 `apps/kite/src/runtime/session/`，registry、lifecycle、rewind、planning、context compaction 与 projection 分属独立模块；TUI session adapter 位于 `apps/kite/src/adapters/tui/`，Runtime 不导入 TUI 类型。
- Tool execution 位于 `apps/kite/src/runtime/tool-execution/`，router 选择 Builtin、MCP、Skill 或 Subagent 唯一 executor；Tool persistence 位于 `apps/kite/src/runtime/tool-persistence/`，按 attempt、ack、receipt、filesystem、suspension、recovery 与 terminal projection 分段，且不创建 Store 或 reducer。
- Runtime Contract 的 command/query/notification/projection 与 Runtime SPI 的 capability/execution/model/module port 分文件组合。
- Kernel 根 state/event union 保持静态，planning/context/verification state 与 event map 位于 `packages/agent-kernel/src/domains/`；Host 按 `host/lifecycle/execution/kernel-adapter/format/process/storage/observability` 归档。
- Builtin operation module 位于各领域 `runtime-module.ts`；Skill、Subagent、Verification 只通过对应 package subpath 暴露，不再从根 barrel 暴露。
- SQLite 的只读格式预检位于 `packages/runtime-storage-sqlite/src/preflight.ts`；`adapter.ts` 是唯一数据库生命周期 owner，event/session/snapshot/artifact/authority/effect 子模块共享同一 database context，`transaction.ts` 是唯一 Runtime 原子提交 owner。
- App 只接收 Host 提供的嵌套 `sessions/transactions/effects/checkpoints` storage ports，不存在平面 storage bridge。
- 七 workspace 和依赖方向保持不变，App 负责组合 concrete adapter。

## 静态门禁

`check:pre-release-architecture` 必须拒绝：

- production path 或声明中的版本化、迁移编号、legacy/compat 实体；
- App Runtime 对 TUI 的反向导入；
- SQLite 格式选择或旧路径；
- 已删除的根 barrel、平面 storage port、旧 MCP source/auth spelling 与旧 TUI façade；
- active 文档中的版本化 State/Store 实体和旧 Runtime Store path；
- 多于一个 concrete composition root。

算法名称中的 IPv4、IPv6、SHA-256 数字不属于代码实体版本。accepted ADR、completed execution record 与 deprecated 历史材料不由该 Gate 改写。
