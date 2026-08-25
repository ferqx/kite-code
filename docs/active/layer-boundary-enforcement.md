# 当前规则：分层边界强制

状态：active

读取时机：修改七个 workspace、App composition、package exports、Runtime authority、持久化、Provider 或 TUI adapter 时。

验证：`bun run check:core-boundary`、`bun run check:runtime-packages`、`bun run check:pre-release-architecture`、`bun run typecheck`。

相关：[`pre-release-architecture.md`](pre-release-architecture.md)、[`six-concept-runtime-architecture.md`](six-concept-runtime-architecture.md)、ADR-0128、ADR-0138。

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

`check:runtime-packages` 直接从 TypeScript module graph、package manifests 与 export facts 验证依赖、环、deep import、唯一 composition root 与 public symbol drift；不提交或比对生成快照。不得通过 alias、barrel、dynamic import、相对路径或测试 helper 绕过。

## 领域归属

### Runtime Contract

`commands.ts`、`queries.ts`、`notifications.ts`、`projections.ts`、`capabilities.ts`、`presentation.ts` 与 `observability.ts` 只保存 client-facing、JSON-safe 数据。`index.ts` 只组合这些模块，不拥有持久状态、execution authority 或 TUI 展示状态。

### Agent Kernel

根 `state.ts` 与 `events.ts` 静态组合 domain state/event map；根 reducer 使用固定顺序调用 `packages/agent-kernel/src/core/` 与 `packages/agent-kernel/src/domains/` reducer。planning、context 与 verification 已拥有独立 state/event 模块。禁止动态 reducer 注册、caller 注入 domain 或第二 transition owner。

### Runtime SPI

`capability.ts`、`execution.ts`、`model.ts` 与 `modules.ts` 分别拥有 neutral capability、execution、context 与 module lifecycle port；filesystem、sandbox、MCP、Subagent、Verification 与 Tool Pipeline 使用独立模块。SPI 不包含 Builtin schema、Host lifecycle、Kernel state 或 App composition。

### Runtime Host

Host 源码按 `host/`、`lifecycle/`、`execution/`、`kernel-adapter/`、`format/`、`process/`、`storage/`、`observability/` 归档：

- `format/` 解析 persisted bytes，严格验证 current format，并为 App 明确指定的历史 profile 提供纯 read-side 投影；
- Host 根 export 只为 App compatibility composition 转发已知历史 profile 的 schema/epoch metadata marker；
  App 不得为读取这些 marker 直接导入 Kernel，marker 也不得进入 current writer、Policy 或 execution 选择；
- `kernel-adapter/` 翻译 Host facts 与 Kernel input；
- `lifecycle/` 管理 effect、cancellation、cleanup 与 recovery；
- `execution/` 管理通用 capability、Tool Pipeline 与 context compilation；
- `process/` 独占 spawn、bounded output、POSIX/MCP child supervision 与 process-tree cleanup。

Host 启动一个冻结 RuntimeModule registry snapshot；所有 arbitration、executor 与 catalog consumer 使用同一 snapshot。Registry-taking 的第二 execution factory 已删除。

### Builtin Runtime

Builtin operation module 位于各领域 `runtime-module.ts`。根 barrel 只暴露模块组合和跨领域 capability surface；Skill、Subagent 与 Verification 必须分别从 `@kite/builtin-runtime/skills`、`/subagent`、`/verification` 导入。Schema、parser、description、effects、availability、traits、provider 与 executor revision 都来自同一冻结 catalog projection。

### SQLite Storage

`adapter.ts` 单独拥有 database lifecycle。`schema.ts`、`event-store.ts`、`session-store.ts`、`snapshot-store.ts`、`artifact-store.ts`、`authority-ledger.ts` 与 `effect-leases.ts` 共享 adapter 创建的同一 database context。`transaction.ts` 是 Runtime event+snapshot 原子提交的唯一 owner。

App 只取得 Host 提供的嵌套 `sessions/transactions/effects/checkpoints` ports；平面 storage interface、alternate current-writer constructor、dual write 与 alternate-driver retry 均不存在。SQLite 的历史 source reader/import ledger 是独立只读边界，不进入这些 current execution ports；source 存在 WAL/SHM 时只能使用 SQLite 包内的 no-follow 隔离 snapshot，不能把真实 SHM handle 或 sidecar mutation capability 交给 Host/App。

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

Kite Code 未发布。生产执行路径、声明与 exports 使用领域职责名；schema/protocol/format 数字只允许作为 metadata 或显式历史 profile identity。旧 alias、双 writer、旧 reducer/driver fallback 与长期宽松 allowlist 必须删除。ADR-0138 允许的兼容面只存在于 Kernel migration、Host codec、SQLite readonly source 和 App composition：未知持久格式静默忽略；明确支持的历史 profile 在用户选中 exact session 后单向导入当前 generation。失败只隔离该 session，source 不覆盖、不改写，当前 writer/Policy/dispatch 永不选择旧格式。

`check:pre-release-architecture` 验证无版本 production path、兼容实体只出现在上述封闭 owner、无 Runtime→TUI 反向 import、唯一 composition root 与完整领域模块。`check:core-boundary` 继续验证 filesystem、sandbox、Host、Kernel、Builtin 与 App 的静态 owner。

`check:runtime-packages` 还会拒绝 root `package.json` 中通过 `bun run` 或 `bun test` 直接执行、但目标文件不存在的脚本；不存在 architecture exception allowlist，非 bootstrap composition authority import 一律失败。
