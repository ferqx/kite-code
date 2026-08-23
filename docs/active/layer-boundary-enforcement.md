# 当前规则：分层边界强制

状态：active

读取时机：修改七个 workspace、App composition、package exports、Runtime authority、持久化、Provider 或 TUI adapter 时。

验证：`bun run check:core-boundary`、`bun run check:runtime-packages`、`bun run check:pre-release-architecture`、`bun run typecheck`。

相关：[`pre-release-architecture.md`](pre-release-architecture.md)、[`six-concept-runtime-architecture.md`](six-concept-runtime-architecture.md)、ADR-0128。

## 固定依赖方向

七个 workspace 保持不变：

```text
runtime-contract
      ↑
runtime-spi        agent-kernel
      ↑                 ↑
builtin-runtime   runtime-host ← runtime-storage-sqlite
          \          /
             apps/kite
```

- Runtime Contract 不导入 SPI、Kernel、Host、Builtin、SQLite 或 App。
- Runtime SPI 只依赖 Contract；它只定义 neutral port 和 execution contract。
- Agent Kernel 不依赖其他 workspace，不读 clock、random、Node/Bun 或 I/O。
- Runtime Host 只依赖 Contract、SPI 与 Kernel；不得解释具体 Builtin 工具语义。
- Builtin Runtime 只依赖 Contract 与 SPI；不得导入 Host、Kernel 或 App。
- SQLite Storage 只导入 `@kite/runtime-host/storage`，不解释 Kernel/Builtin 语义。
- `apps/kite/src/bootstrap.ts` 是唯一 concrete composition root。

`check:runtime-packages` 通过 TypeScript module graph、package manifests 与 export facts 验证依赖、环、deep import、唯一 composition root 与 public symbol drift。不得通过 alias、barrel、dynamic import、相对路径或测试 helper 绕过。

## 领域归属

### Runtime Contract

`commands.ts`、`queries.ts`、`notifications.ts`、`projections.ts`、`capabilities.ts`、`presentation.ts` 与 `observability.ts` 只保存 client-facing、JSON-safe 数据。`index.ts` 只组合这些模块，不拥有持久状态、execution authority 或 TUI 展示状态。

### Agent Kernel

根 `state.ts` 与 `events.ts` 静态组合 domain state/event map；根 reducer 使用固定顺序调用 `src/core/` 与 `src/domains/` reducer。planning、context 与 verification 已拥有独立 state/event 模块。禁止动态 reducer 注册、caller 注入 domain 或第二 transition owner。

### Runtime SPI

`capability.ts`、`execution.ts`、`model.ts` 与 `modules.ts` 分别拥有 neutral capability、execution、context 与 module lifecycle port；filesystem、sandbox、MCP、Subagent、Verification 与 Tool Pipeline 使用独立模块。SPI 不包含 Builtin schema、Host lifecycle、Kernel state 或 App composition。

### Runtime Host

Host 源码按 `host/`、`lifecycle/`、`execution/`、`kernel-adapter/`、`format/`、`process/`、`storage/`、`observability/` 归档：

- `format/` 解析 persisted bytes 并验证 current format；
- `kernel-adapter/` 翻译 Host facts 与 Kernel input；
- `lifecycle/` 管理 effect、cancellation、cleanup 与 recovery；
- `execution/` 管理通用 capability、Tool Pipeline 与 context compilation；
- `process/` 独占 spawn、bounded output、POSIX/MCP child supervision 与 process-tree cleanup。

Host 启动一个冻结 RuntimeModule registry snapshot；所有 arbitration、executor 与 catalog consumer 使用同一 snapshot。Registry-taking 的第二 execution factory 已删除。

### Builtin Runtime

Builtin operation module 位于各领域 `runtime-module.ts`。根 barrel 只暴露模块组合和跨领域 capability surface；Skill、Subagent 与 Verification 必须分别从 `@kite/builtin-runtime/skills`、`/subagent`、`/verification` 导入。Schema、parser、description、effects、availability、traits、provider 与 executor revision 都来自同一冻结 catalog projection。

### SQLite Storage

`adapter.ts` 单独拥有 database lifecycle。`schema.ts`、`event-store.ts`、`session-store.ts`、`snapshot-store.ts`、`artifact-store.ts`、`authority-ledger.ts` 与 `effect-leases.ts` 共享 adapter 创建的同一 database context。`transaction.ts` 是 Runtime event+snapshot 原子提交的唯一 owner。

App 只取得 Host 提供的嵌套 `sessions/transactions/effects/checkpoints` ports；平面 storage interface、alternate constructor、格式选择、dual write 与 alternate-driver retry 均不存在。

### App 与 TUI

Runtime Session、Tool execution 与 Tool persistence 分别位于 `apps/kite/src/runtime/session/`、`tool-execution/`、`tool-persistence/`。App Runtime 不导入 TUI。TUI 只通过 `apps/kite/src/adapters/tui/session-adapter.ts` 与 Runtime bridge 取得 typed client surface；不得取得 Kernel state、Host execution control、SQLite handle 或 Builtin executor。

## Authority 不变量

- Workspace filesystem I/O 只由 Builtin Local Provider 拥有。
- Policy 与 authorization decision 只由 Kernel 拥有；App/Host 只投影或组合事实。
- Host 是 operation lifecycle、effect lease、cancellation、cleanup 与 restart recovery owner。
- Tool persistence 子模块只构造和验证同一持久批次，不创建 Store、不执行 reducer、不复制 transaction owner。
- Sandbox backend 与 path/network policy 属于 Builtin；process supervision 属于 Host；平台 availability 由 App composition 选择。
- MCP Manager/Supervisor 属于 Builtin MCP control plane；Runtime 只取得受限 provider port。
- Model Gateway、Context compiler、Subagent Provider 与 Verification 各有唯一 concrete owner，不得增加 fallback dispatcher。

## Clean cutover

Kite Code 未发布。生产路径、声明与 exports 使用领域职责名；schema/protocol/format 数字只允许作为 metadata 值。旧 alias、双入口、旧 source、格式迁移、长期 allowlist 与 compatibility façade 必须直接删除。持久格式不匹配仍 fail closed，不迁移、不覆盖、不尝试其他 driver。

`check:pre-release-architecture` 验证无版本生产路径/声明、无已删除 compatibility 名称、无 Runtime→TUI 反向 import、唯一 composition root、完整领域模块与 active 文档零版本实体。`check:core-boundary` 继续验证 filesystem、sandbox、Host、Kernel、Builtin 与 App 的静态 owner。
