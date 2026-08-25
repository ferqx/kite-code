# 未发布阶段架构门禁

状态：active

读取时机：修改 workspace 边界、生产实体命名、App composition、Runtime Session、Tool execution/persistence、SQLite storage 或 package exports 时。

验证：`bun run check:pre-release-architecture`、`bun run check:runtime-packages`、`bun run check:core-boundary`、`bun run typecheck`。

## Clean cutover

Kite Code 尚未发布，生产文件、目录、类型、函数、类、变量和 export 使用领域职责命名，不使用 schema 数字、协议数字或历史实施任务作为实体身份。schema version、protocol version、format epoch 与数据库 format marker 只能作为 metadata 值存在。

最终发布前，调用方必须直接使用唯一执行入口；仓库不得保留旧名 alias、双 writer、旧数据库 constructor、旧 sidecar fallback 或 execution fallback。这里的 clean cutover 约束当前生产入口和当前写格式，不授权破坏已有会话。按 ADR-0138，历史读取只允许位于 Kernel migration、Host codec、SQLite readonly source 和 App composition 的封闭边界：未知 schema/epoch 静默忽略，明确支持的 profile 只在选中单个会话后单向导入当前 generation。当前 writer、reducer、Policy 与 execution 不选择历史格式，兼容投影必须清除旧 approval/grant/effect authority，并继续验证 checksum、Project/Workspace identity、Event/Snapshot revision。

## 当前组合与目录

- `apps/kite/src/bootstrap.ts` 是唯一 concrete composition root。
- Runtime Session 位于 `apps/kite/src/runtime/session/`，registry、lifecycle、rewind、planning、context compaction 与 projection 分属独立模块；TUI session adapter 位于 `apps/kite/src/adapters/tui/`，Runtime 不导入 TUI 类型。
- Tool execution 位于 `apps/kite/src/runtime/tool-execution/`，router 选择 Builtin、MCP、Skill 或 Subagent 唯一 executor；Tool persistence 位于 `apps/kite/src/runtime/tool-persistence/`，按 attempt、ack、receipt、filesystem、suspension、recovery 与 terminal projection 分段，且不创建 Store 或 reducer。
- Runtime Contract 的 command/query/notification/projection 与 Runtime SPI 的 capability/execution/model/module port 分文件组合。
- Kernel 根 state/event union 保持静态，planning/context/verification state 与 event map 位于 `packages/agent-kernel/src/domains/`；Host 按 `host/lifecycle/execution/kernel-adapter/format/process/storage/observability` 归档。
- Builtin operation module 位于各领域 `runtime-module.ts`；Skill、Subagent、Verification 只通过对应 package subpath 暴露，不再从根 barrel 暴露。
- SQLite 的只读格式预检位于 `packages/runtime-storage-sqlite/src/preflight.ts`；历史会话 source reader/import ledger 位于 `compatibility.ts`，只读 source 与当前 target 严格分离。`adapter.ts` 是唯一当前数据库生命周期 owner，`log-query.ts` 的独立 no-follow/read-only reader 只实现 `RuntimeLogQueryPort`，event/session/snapshot/artifact/authority/effect 子模块共享写 database context，`transaction.ts` 是当前 Runtime event transaction owner。
- App 只接收 Host 提供的嵌套 `sessions/transactions/effects/checkpoints` storage ports，不存在平面 storage bridge。
- 七 workspace 和依赖方向保持不变，App 负责组合 concrete adapter。

## 静态门禁

`check:pre-release-architecture` 必须拒绝：

- 封闭历史会话读取边界之外的版本化、迁移编号或 legacy/compat 实体；
- App Runtime 对 TUI 的反向导入；
- current writer 的 SQLite 格式选择、dual write 或 execution fallback；
- 已删除的根 barrel、平面 storage port、旧 MCP source/auth spelling 与旧 TUI façade；
- active 文档中的版本化 State/Store 实体和旧 Runtime Store path；
- 多于一个 concrete composition root。

这些门禁直接检查当前源码、package manifest 与行为测试；不得提交 generated architecture snapshot、迁移 owner matrix 或 exception allowlist 作为第二事实源。

算法名称中的 IPv4、IPv6、SHA-256 数字不属于代码实体版本。accepted ADR、completed execution record 与 deprecated 历史材料不由该 Gate 改写。
