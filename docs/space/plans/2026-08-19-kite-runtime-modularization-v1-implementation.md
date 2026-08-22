# Kite Runtime Modularization V1 实施方案

状态：active

日期：2026-08-19

最后更新：2026-08-22

优先级：P0

RFC：[`docs/design/2026-08-19-kite-runtime-modularization-v1-rfc.md`](../../design/2026-08-19-kite-runtime-modularization-v1-rfc.md)

分期决策：[`ADR-0124`](../../adr/0124-runtime-modularization-staged-delivery.md)

RFC 修订：[`ADR-0125`](../../adr/0125-accepted-rfc-staged-revision.md)

Implementation baseline HEAD：`af5a512305207dcaaeb40c334d0b914befbc3598`

本计划固定沿用：Runtime State schema `25`、Runtime Store schema `4`、epoch `kite-runtime-2026-08-18`

> 本计划只完成 Runtime 物理模块化、所有权迁移与中央 legacy 删除。Project/Composition identity、统一 Grant/Receipt authenticity、Project-scoped cross-Host fence、通用 DataOrigin/Egress/Credential IR、State 26、Store 5 与新 epoch 已移入连续计划 [`Runtime Authority & Format V1`](2026-08-20-kite-runtime-authority-format-v1-implementation.md)。RMV1-01 至 RMV1-15 均已完成；下一阶段为 RMV1-16 静态领域 Reducer、Legacy 删除与闭合，RAV1 继续 blocked。

> 2026-08-22 用户直接裁决：当前版本的 evaluation、record/replay baseline、真实 Provider smoke 及对应 CI job 全部移除，后续另行重做。因此本计划中的 evaluation 命令不再属于 RMV1 完成 Gate；产品 restore/replay、fault/soak 与安全负向测试仍按原定义执行。

## 1. 裁决与范围

2026-08-20 六方复核确认：目标架构、owner/delete matrix、安全不变量与垂直迁移方向成立，但原实施计划把模块化、权限体系、跨 Host 并发和持久格式重写压入同一个 P0，执行面和回滚面过大。

本计划据此收敛为纯 Modularization：

1. 建立 App、Contract、Host、Kernel、SPI、Storage 与 Builtin 的物理边界；
2. TUI/CLI 只依赖 Runtime Contract；
3. Runtime Host 成为 Session/Mailbox/transaction/effect lifecycle 的唯一 owner；
4. Agent Kernel 成为无外部 I/O 的纯 decision/reducer；
5. Builtin 通过私有 Runtime SPI 注册和执行；
6. Scheduler 只识别 ExecutionTraits/ResourceScope，不识别具体工具名；
7. 每个 operation 原子迁移，Legacy executor 持续缩小并最终删除；
8. 把中央 State/Event/Reducer 按编译期固定领域拆分，但不改变序列化形状；
9. 全程保持当前持久格式与当前安全行为。

### 1.1 本计划明确不做

- 不引入 ProjectIdentityStore 或 ProjectHandle sealing；
- 不建立统一 RuntimeCompositionIdentity digest；
- 不建立统一 HMAC/JSON canonical Grant/Receipt authenticity；
- 不建立 ProjectResourceFenceStore 或跨 Host/跨 DB fencing；
- 不重写 DataOrigin/Egress/Credential 模型；
- 不创建 State 26、Store 5 或新 epoch；
- 不在线迁移 Session，不建立 Runtime Server、Worker/WASI 或第三方进程内插件；
- 不把正式 56-probe qualification 作为模块化架构完成 Gate；它继续属于 release qualification。

这些不是取消，而是由 RAV1 在稳定边界上实施。

## 2. 目标物理结构

```text
apps/kite
packages/runtime-contract
packages/agent-kernel
packages/runtime-spi
packages/runtime-host
packages/runtime-storage-sqlite
packages/builtin-runtime
```

所有 package 都保持：

```json
{
  "private": true
}
```

命名采用 ADR-0124 的分期决定：

- `runtime-spi` 不把 ContextSource、module lifecycle、registry、effect handler 和 execution adapter 都误称为 Capability Provider；
- `builtin-runtime` 包含 Model、Context、Skills、Filesystem、MCP、Sandbox、Verification、Subagent 与领域 observability，不把它们全部误称为 Capability。

### 2.1 依赖图

箭头表示“依赖于”：

```text
runtime-host
  |-> runtime-contract
  |-> agent-kernel
  `-> runtime-spi

runtime-spi
  `-> runtime-contract

runtime-storage-sqlite
  `-> runtime-host/storage

builtin-runtime
  |-> runtime-spi
  `-> runtime-contract

apps/kite/bootstrap.ts
  |-> runtime-contract
  |-> runtime-host
  |-> runtime-storage-sqlite
  `-> builtin-runtime
```

`agent-kernel` 不依赖其他 `@kite/*` package。跨包只允许 package exports，禁止 deep import 和依赖环。

### 2.2 Runtime Host 的上限

Runtime Host 只拥有通用运行机制：

```text
Session ownership
Mailbox / command serialization
Runtime transaction coordination
Effect supervision
Cancellation / recovery
Notification projection
Module lifecycle / registry arbitration
```

Host 不拥有具体 Prompt、Skill、Model Context、MCP、Filesystem、Sandbox 或 Verification 领域语义。

Context/Prompt/Compaction 由 `builtin-runtime/model-context` 实现 `ContextCompilerPort`；Host 只调用 port、执行预算和生命周期协调。Capability modules 负责自己的 request/receipt normalization 与领域实现。Kernel 继续拥有 Policy、Intent、authorization decision、receipt acceptance、Evidence 与 Completion。

## 3. V1 信任模型与边界强度

### 3.1 信任模型

```text
Kernel / Host / builtin-runtime
  = trusted in-process code

MCP server / Shell / Sandbox child / Network peer
  = untrusted external effect

第三方进程内扩展
  = V1 不支持
```

Package export 是编译边界，不声称是恶意同进程代码的安全隔离。静态检查不能完整证明“没有 closure capture、动态 I/O 或 ambient global 访问”。V1 使用包边界、静态检查、运行时契约、负向测试和资格测试共同强制边界，不使用“单靠 TypeScript 机械证明安全”的措辞。

### 3.2 V1 内部 effect authorization

RMV1 冻结最小内部类型：

```ts
interface AuthorizedEffect {
  readonly grantId: string;
  readonly intentId: string;
  readonly sessionId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly authority: RequiredAuthority;
  readonly requestDigest: string;
  readonly compositionRevision: string;
  readonly expiresAt?: string;
  readonly revocationRevision?: string;
}
```

V1 要求：字段完整、类型严格、持久 intent/attempt 绑定、single-use CAS、identity equality、过期/撤销和 request digest 匹配。现有 Filesystem/Sandbox/Subagent sealed seam 不降级；RMV1 只是不把统一 RFC 8785/HMAC/domain seal 扩张到所有进程内 builtin。统一 authenticity 由 RAV1 根据真实 execution boundary 决定。

### 3.3 ContextSource 与 I/O

ContextSource 继续是纯 projector，只消费静态 registration 或当前实现已经提交的 observation/artifact。它不能直接读取 filesystem、连接 MCP、spawn、访问 network 或 ambient credential。

静态 Gate 检查 direct/transitive forbidden import、dynamic import 声明和 exports；运行时 contract test 用 fake adapter/external-call counter 检查 startup/collect 零调用。它们共同降低旁路风险，但不声称能隔离恶意同进程代码。

## 4. 全阶段不变量

1. State schema 始终为 `25`，Store schema 始终为 `4`，epoch 始终为 `kite-runtime-2026-08-18`；
2. 当前 Project identity、Session restore、MCP/Model/Filesystem/Sandbox/Credential/Egress 行为保持不变；
3. 每个 responsibility 分别记录 execution/state/persistence/receipt owner，同一维度只有一个 production owner；
4. 新旧 handler 不同时启用，不允许 `try-new-catch-old`、Fake-to-Local 或异常 fallback；
5. 每个 operation 原子切换，切换后立即删除旧 branch；Legacy executor 只缩小不增长；
6. Runtime Command 不是 Kernel fact；Client/Host/Builtin 不直接修改 Agent State；
7. Kernel 不依赖 Node/Bun/Store/Host/SPI/App，不读取 clock/random/process/fs/network；
8. Host 不决定 Policy，不扩大 authorization，不包含具体 Model/Prompt/Skill/Capability 领域语义；
9. Builtin 不获得 AgentState、KernelEvent 或 RuntimeStore，不直接调用另一个 builtin executor；follow-up 重新进入 Host/Kernel；
10. intent commit 失败和 attempt ack 失败时 external call count 为零；dispatch 后无 receipt 保持 `unknown`；
11. Cancel 先 durable settle，再发 AbortSignal；late receipt 不能修改 successor Work；
12. 四类 transaction 生命周期长期保留：decision、attempt-start、receipt/evidence、terminal/recovery；RMV1 映射到 v4 Store，不新增格式；
13. 行为变化必须在同一 Task 更新匹配的 `docs/active/`；最终文档 Task 不追认此前遗漏；
14. 每个自动 Gate 通过后 stop-and-report，不在同一未验证改动中跨越两个 Gate。

## 5. Manifest 策略

RMV1-01 只建立两类 manifest。

### 5.1 人工维护：设计意图

路径：`tests/reliability-harness/runtime-modularization/manifests/`

```text
operation-owner.json
legacy-delete.json
source-migration.json
architecture-exceptions.json
```

- `operation-owner.json`：operation/responsibility 的 execution/state/persistence/receipt owner、切换 Task 与唯一 production entry；
- `legacy-delete.json`：必须删除的 symbol/import/branch、目标 Task 和验证规则；
- `source-migration.json`：`src/app`、`src/core`、`src/protocol`、root entry/export/test consumer 到目标 package 的映射；
- `architecture-exceptions.json`：迁移期唯一允许的 compatibility import，包含 owner、理由和到期 Task。

### 5.2 自动生成：源码事实

禁止手工编辑：

```text
runtime-state-shape.generated.json
runtime-event-shape.generated.json
store-schema.generated.json
package-graph.generated.json
public-exports.generated.json
```

它们分别从 TypeScript AST/schema、Event union/codec、实际 SQLite v4 DDL、workspace graph 和 package exports 生成。generator 输出 canonical digest；completeness verifier 对比人工意图与生成事实，发现未登记 production entry、owner、export、event/state shape 或 legacy symbol 即失败。

RMV1 不生成 target State 26 mapping、Store 5 SQL、ProjectHandle/Composition/Grant cryptographic vectors或跨 Host fence fixture。

## 6. Operation owner 与删除矩阵

下表是人工 manifest 必须覆盖的初始集合；verifier 从 production entrypoint、registry、public exports 和 generated graph 发现遗漏时失败。

| Responsibility | 当前 owner | 目标 owner | Task | 删除 Gate |
| --- | --- | --- | --- | --- |
| Production bootstrap | TUI/CLI/run-agent 多处组合 | `apps/kite/src/bootstrap.ts` | RMV1-03/16 | concrete composition root 恰好一个 |
| CLI/TUI Runtime access | direct generator/Kernel/Store imports | `runtime-contract` | RMV1-03 | App presentation 只依赖 Contract |
| Runtime storage API | `RuntimeStore` concrete API | `runtime-host/storage` port + v4 SQLite adapter | RMV1-04 | Host/Kernel/App 无 raw DB handle |
| Session/Mailbox | TUI SessionRuntime/Agent loop | Runtime Host | RMV1-05/06 | TUI 无 generator/Abort/Kernel control |
| Transaction/effect lifecycle | Kernel/Runner/Executor/Store 混合 | Host + v4 adapter | RMV1-04/05/06 | 单一 persistence/effect owner |
| Kernel decision/reducer | AgentKernel + Store | pure agent-kernel | RMV1-07 | Kernel import closure无 I/O |
| Runtime module registry | Tool/MCP/Model special composition | runtime-spi + Host lifecycle | RMV1-08 | 注册入口固定、启动后冻结 |
| Capability binding/provider | Tool registry/controller | SPI definition/executor/binding | RMV1-09 | central resolve branch缩小 |
| Scheduler | tool-name branches | ExecutionTraits/ResourceScope | RMV1-09 | 工具名字面量为零 |
| `tool_search` | Tool Controller/Harness | builtin-runtime catalog observer | RMV1-10 | exactly one executor |
| Skills/Context/MCP read | special composition | builtin-runtime modules + ports | RMV1-11 | direct provider-to-provider为零 |
| Filesystem read/write | Tool Pipeline + provider seams | builtin-runtime filesystem | RMV1-12 | migrated legacy branches删除 |
| Shell/Sandbox | Tool runner + App sandbox | builtin-runtime shell/sandbox + Host supervisor | RMV1-13 | duplicate spawn/fallback删除 |
| Verification/Subagent | specialized executor/child runner | builtin-runtime modules | RMV1-14 | completion仍由Kernel唯一决定 |
| Model/Context/Compaction/Reviewer | Model Gateway + Host/TUI special wiring | builtin-runtime model/context | RMV1-15 | transport/Gateway/composition唯一 |
| State/Event/Reducer domains | central state/events/reducer | static kernel domain reducers | RMV1-16 | serialized v25 shape与replay不变 |
| Legacy executor/adapters | central controller/executor/compatibility imports | deleted | RMV1-16 | manifest 无 `legacy-owned` |

## 7. 阶段拓扑

为保留已经完成的设计关闭阶段编号，本计划继续把 RFC/ADR/分期决策记为 `RMV1-00`。六方复核中所称的“精简 RMV1-00 baseline”在本计划映射为 `RMV1-01`，范围不变。

```text
RMV1-00 design/RFC/ADR staged closure（已完成）
   |
RMV1-01 baseline + owner/delete manifest（已完成）
   |
RMV1-02 Bun workspace + package gates
   |
RMV1-03 Runtime Contract + apps/kite relocation
   |
RMV1-04 RuntimeStore Port + v4 adapter
   |
RMV1-05 RuntimeHost + SessionRegistry + Mailbox
   |
RMV1-06 Host lifecycle + cancellation + recovery
   |
RMV1-07 Pure Kernel extraction
   |
RMV1-08 Runtime SPI + Registry + Legacy executor
   |
RMV1-09 Capability definition/provider/binding
          + ExecutionTraits scheduler
   |
RMV1-10 tool_search pilot slice
   |
RMV1-11 Skills + MCP read
   |
RMV1-12 Filesystem read/write
   |
RMV1-13 Shell + Sandbox
   |
RMV1-14 Verification + Subagent
   |
RMV1-15 Model + Compaction + Reviewer
   |
RMV1-16 Domain reducer decomposition
          + Legacy deletion
          + package graph closure
```

RMV1-01、02、04、07、10、13、15、16 是自动 stop-and-report Gate。没有人工 reviewer 签署要求。

## 8. Task 执行矩阵

| Task | dependsOn | 主要产出 | Required Gate |
| --- | --- | --- | --- |
| RMV1-00 | 用户裁决 | RFC umbrella、ADR-0124、RMV1/RAV1 分期计划 | docs gates；已完成 |
| RMV1-01 | RMV1-00 Gate | 精简 baseline、manual/generated manifests、completeness verifier | baseline/journey/replay/fault + manifest verifier |
| RMV1-02 | RMV1-01 Gate | workspace、六包+App、root build graph、static gates | build/typecheck/test/dependency graph |
| RMV1-03 | RMV1-02 Gate | Runtime Contract、CLI/TUI relocation、LegacyRuntimeAccess | CLI/TUI/Contract journeys |
| RMV1-04 | RMV1-03 | Storage Port、LegacyV4StorageAdapter、四类 transaction mapping | v4 schema/digest/reopen/fault conformance |
| RMV1-05 | RMV1-04 Gate | Host、SessionRegistry、Mailbox、Query/Subscription | mailbox concurrency/revision/projection tests |
| RMV1-06 | RMV1-05 | lifecycle、cancel、effect supervisor、recovery | cancel/late/unknown/fault/CI soak |
| RMV1-07 | RMV1-06 | pure Kernel、DecisionFacts、Host transaction | parity/replay/import closure |
| RMV1-08 | RMV1-07 Gate | runtime-spi、Registry、Legacy executor | registry/lifecycle/zero-startup-I/O |
| RMV1-09 | RMV1-08 | definitions/bindings/executors、ExecutionTraits scheduler | single owner/scheduler parity |
| RMV1-10 | RMV1-09 | `tool_search` vertical slice | zero-call/single-executor/late receipt |
| RMV1-11 | RMV1-10 Gate | Skills、Context ports、MCP read | context golden/MCP lifecycle/replay |
| RMV1-12 | RMV1-11 | Filesystem read/write | current boundary/preimage/race parity |
| RMV1-13 | RMV1-12 | Shell/Sandbox | platform matrix/current fallback parity/fault |
| RMV1-14 | RMV1-13 Gate | Verification/Subagent | completion/continuation/ceiling/replay |
| RMV1-15 | RMV1-14 | Model/Context/Compaction/Reviewer | five-purpose gateway/replay/compaction |
| RMV1-16 | RMV1-15 Gate | static domain reducers、Legacy deletion、final graph | full suite/journey/replay/fault/CI soak/docs |

## 9. 详细 Task

### RMV1-00：设计与分期关闭（已完成）

本阶段不修改 production code。它保留 accepted RFC 作为完整目标架构，使用 ADR-0124 把交付拆为 RMV1 与 RAV1，并冻结本计划的包命名、Host 职责、进程内信任模型、manifest 分类和格式不变量。

完成证据：

- RFC 已按 ADR-0125 同步分期实施事实，当前 SHA-256 为 `a8fd3f35b5ca2331ff800c5a71f8a7907da5f6c5d11778b00e90c647c4d8be62`；
- ADR-0124 已接受；
- RMV1 与 RAV1 已成为两个连续权威实施文档；
- 文档索引和 docs gates 已同步。

### RMV1-01：精简 baseline 与 manifest（已完成）

只允许完成四项：

1. 当前 journey/replay/fault baseline；
2. `operation-owner.json` 与 `legacy-delete.json`；
3. production entrypoint / `source-migration.json` / `architecture-exceptions.json`；
4. v25 State、Event、v4 Store、package/export shape 自动生成器和 completeness verifier。

不得在本 Task 设计 State 26、Store 5、Project identity、composition digest、unified sealing、cross-Host fence、DataOrigin/Egress 或 Credential Broker。

定向验证：

```bash
bun run typecheck
bun run check:core-boundary
bun run test
bun run test:tui:system:core
bun run test:runtime:fault
bun run scripts/check-runtime-modularization-manifests.ts
```

Gate：所有 generated 文件必须可重复生成且 clean diff；人工 manifest 不复制 AST/DDL 字段。通过后 stop-and-report。

完成证据：[`2026-08-20-rmv1-01-baseline-manifests.md`](../execution/completed/2026-08-20-rmv1-01-baseline-manifests.md)。该检查点只完成 baseline 与 manifest，不创建 workspace package、不移动 production owner，也不解除 RAV1 的 blocked 状态。

### RMV1-02：Workspace、package 与边界 Gate

产出：

- Bun workspace、六个私有 package 和 `apps/kite`；
- 每包真实代码、consumer、exports、README、tsconfig、build/typecheck/test；
- root build/typecheck/test 覆盖 `packages/**` 和 `apps/**`；
- `check:runtime-packages` 检查 cycle、deep import、forbidden direct/transitive import、public exports、composition root 数量；
- 迁移期 exception 必须精确登记，禁止宽目录 allowlist。

本阶段只放最小真实 contract/port/registry 类型，不移动 production owner，不创建空 package。

```bash
bun install --frozen-lockfile
bun run typecheck
bun run check:core-boundary
bun run check:runtime-packages
bun run format:check
bun run test
```

Gate 后 stop-and-report。

完成证据：[`2026-08-20-rmv1-02-workspace-package-gates.md`](../execution/completed/2026-08-20-rmv1-02-workspace-package-gates.md)。该检查点只建立物理 package、根 build/test 图和静态依赖门禁；所有 production owner 与 release CLI/TUI 入口仍在 Legacy 路径，RMV1-03 尚未开始。

### RMV1-03：Runtime Contract 与 App 迁移

产出：

- `RuntimeAccess.command/query/subscribe`、Command/Receipt/Projection/Notification；
- Client 不接触 AgentState、KernelEvent、RuntimeStore、Executor 或具体 builtin；
- `src/app/tui`、`src/app/cli` 物理迁入 `apps/kite/src/tui`、`apps/kite/src/cli`；
- root scripts、tests、path aliases 和 `src/index.ts` consumer 按 source manifest 迁移；
- `apps/kite/src/bootstrap/legacy/LegacyRuntimeAccess` 是唯一 compatibility adapter，不是失败 fallback；
- 所有临时 legacy 实现都位于 `apps/kite/src/bootstrap/legacy/`，由 composition root 注入；`runtime-host`、`runtime-spi` 与 `builtin-runtime` 不得反向依赖 root `src/core`、`src/app` 或具体 legacy 实现；
- root shim 只能 re-export executable，不能构造 Runtime，且必须登记删除 Task。

RMV1 Contract 沿用当前 Workspace/Session identity，不新增 ProjectHandle 或新 format identity。

```bash
bun test tests/session-manager.test.ts
bun test tests/cli.test.ts tests/cli/trace.test.ts tests/cli-workspace-trust.test.ts
bun run test:tui:system:core
bun run check:runtime-packages
```

完成证据：[`2026-08-20-rmv1-03-runtime-contract-app-relocation.md`](../execution/completed/2026-08-20-rmv1-03-runtime-contract-app-relocation.md)。Contract 已建立 Command/Query/Subscription、Receipt/Projection 与 durable/ephemeral Notification；CLI/TUI 生产入口已迁入 `apps/kite`，root shim 只重导出 executable。所有临时实现集中在 `apps/kite/src/bootstrap/legacy/`，由单一 `LegacyRuntimeAccess` 选择明确 handler；State 25、Store 4 与原 epoch 未改变。

### RMV1-04：Storage Port 与 v4 adapter

目标：Host 依赖 port，SQLite 实现依赖 Host storage exports；物理数据仍是 v4。

产出：

- `SessionStore`、`RuntimeTransactionPort`、`EffectLeasePort`、`CheckpointPort`、`ArtifactPort`；
- `LegacyV4StorageAdapter` 包装当前 RuntimeStore 或把等价实现迁入 `runtime-storage-sqlite`；
- decision、attempt-start、receipt/evidence、terminal/recovery 四类 transaction port；
- v4 adapter 映射到当前 events/snapshot/lease/artifact 语义，不增加表、列、index、marker、schema version 或 epoch；
- `store-schema.generated.json` 在改动前后逻辑 shape 一致；旧 Session 可继续严格恢复；
- TUI/CLI/Kernel 无 raw SQLite handle。

`apps/kite` 通过 `createRuntimeHost({ storage, modules, ... })` 注入 v4 adapter 和后续 module；Host factory 不导入 concrete SQLite 或 legacy implementation。

若某个 target transaction 无法无损映射到 v4，保持 legacy owner并停止，不偷偷扩展 Store 4。

```bash
bun test tests/runtime/store.test.ts tests/runtime/file-checkpoints.test.ts
bun test tests/runtime/capability-artifacts.test.ts tests/subagent-artifacts.test.ts
bun run test:runtime:fault
bun run scripts/check-runtime-modularization-manifests.ts
```

Gate：v4 DDL、schema marker、state codec、epoch 和 restore golden 均不变；通过后 stop-and-report。

完成证据：[`2026-08-20-rmv1-04-storage-port-v4-adapter.md`](../execution/completed/2026-08-20-rmv1-04-storage-port-v4-adapter.md)。Host storage ports、唯一 v4 adapter、四类 transaction mapping、App `createRuntimeHost` 注入、session-aware fail-before-write preflight 与显式 token metadata port 已闭合；Store 4 的 8 表/3 index/marker、State 25、原 epoch、restore/fault 行为均未改变。

### RMV1-05：Runtime Host、SessionRegistry 与 Mailbox（已完成）

Host 建立：same-session FIFO、cross-session concurrency、command routing、revision conflict、Query committed projection、Subscription snapshot-on-gap、bounded ephemeral stream。

尚未迁移的工作由唯一 LegacyRuntimeAccess 端到端执行；Host 不另写一份 state/effect/receipt。Mailbox 不等待 Model/Shell/MCP。Cancel 可以入队，但完整 cancellation ownership 在 RMV1-06 切换。

```bash
bun test tests/session-manager.test.ts
bun test tests/runtime/session-state-machine.test.ts
bun test tests/cli.test.ts tests/cli/trace.test.ts
bun run test:tui:system:core
```

完成证据：[`2026-08-20-rmv1-05-runtime-host-session-registry-mailbox.md`](../execution/completed/2026-08-20-rmv1-05-runtime-host-session-registry-mailbox.md)。production `RuntimeAccess` 已切到 Host；same-session FIFO、cross-session concurrency、bridge 前 revision conflict、Host 生命周期内 scoped idempotency、committed Query、gap snapshot 与有界 durable/ephemeral subscription 均由包级 contract 和真实 TUI bootstrap 验证。`LegacyRuntimeAccess` 只保留单 handler execution bridge；完整 cancellation/effect/recovery owner 仍等待 RMV1-06。State 25、Store 4 与原 epoch 未改变。

### RMV1-06：Host lifecycle、Cancellation 与 Recovery（已完成）

迁移：run serialization、AbortController、effect supervision、attempt ack、lease claim/renew/release、cancel-before-signal、cleanup barrier、late receipt、notification projection和 restart recovery。

规则：intent/attempt ack 前外部调用为零；dispatch 后无 receipt 为 unknown；stale lease owner不能 dispatch/commit；同一 operation 的旧 supervisor 在切换时删除。RMV1 只保留当前单-Store lease/fence 语义，不增加跨 Host Project fence。

```bash
bun test tests/runtime/cancel-resume.test.ts tests/runtime/concurrent-shell-cancel.test.ts
bun run test:tui:system:core
bun run test:runtime:fault
bun run test:runtime:soak
```

`test:runtime:soak` 是 CI profile smoke；正式 qualification 仍按 release 规则单独运行。

完成证据：[`2026-08-20-rmv1-06-host-lifecycle-cancellation-recovery.md`](../execution/completed/2026-08-20-rmv1-06-host-lifecycle-cancellation-recovery.md)。production root AbortController、same-session cleanup barrier、durable-before-signal、四类 Store 4 transaction acknowledgement、单-Store effect lease fencing 与 restart recovery 已由 Host 唯一拥有；Required Gate 全部通过，CI soak 7/7 且清理残留为 0。State 25、Store 4 与 epoch `kite-runtime-2026-08-18` 未改变，cross-Host fence 与 RAV1 authority/format 范围未提前进入。

### RMV1-07：Pure Kernel extraction（已完成）

产出：

- `decide/reduce/selectPendingEffects` 纯 API；
- Host translation：Command/Receipt/Host fact -> KernelInput；
- DecisionFacts 提供当前等价的 clock、ID、workspace、policy/provider facts；
- Host 通过 v4 Storage Port 提交事件/快照；
- Kernel 无 Node/Bun/process/Date/random/Store/Host/SPI/App；
- State 25、Event union、codec、reducer输出与 replay完全等价。

本阶段的唯一过渡执行桥是 `apps/kite/src/bootstrap/legacy/LegacyAuthorizedExecutionAdapter`：它只接收 Host 已持久提交的 `AuthorizedEffect`，不得重新 classify、policy、approve 或扩大 authority。Kernel authority 切换时，旧 Tool Pipeline 的对应 validate/classify/policy/authorize 分支必须在同一 operation cutover 中删除或变为不可达；adapter 只调用保留当前行为的 dispatch 子路径。RMV1-08 再把该 adapter 包装为 Registry 中唯一的 `LegacyRuntimeModule`，禁止形成第二 policy owner。

```bash
bun test tests/runtime/kernel.test.ts tests/runtime/reducer.test.ts
bun test tests/runtime/runtime-scheduling-policy.test.ts tests/runtime/completion-guard.test.ts
bun run check:runtime-packages
bun run scripts/check-runtime-modularization-manifests.ts
```

Gate：同一输入 replay digest、State 25 snapshot和terminal outcome一致；通过后 stop-and-report。

完成证据：[`2026-08-20-rmv1-07-pure-kernel-extraction.md`](../execution/completed/2026-08-20-rmv1-07-pure-kernel-extraction.md)。production transition owner 已切到无 ambient authority 的 `@kite/agent-kernel`；Host command translation、canonical `DecisionFacts`、Store 4 commit-before-memory、单次 `AuthorizedEffect` 与唯一 legacy adapter 已闭合。旧 `RuntimeKernelControl`/`createAgentKernel` symbol 删除，State 25 domain reducer 只作为 RMV1-16 前的固定 compile-time binding；Required Kernel/scheduling/replay/package/manifest Gate 均通过，State 25、Store 4 与原 epoch 未改变。

### RMV1-08：Runtime SPI、Registry 与 Legacy executor（已完成）

`runtime-spi` 冻结私有内部契约：

- `RuntimeModule` lifecycle；
- Capability definition/binding/executor；
- ContextSource/ContextCompilerPort；
- execution adapter / external effect context；
- bounded receipt / domain normalizer；
- registry freeze/dispose。

Builtin 与 Host 都是可信进程内代码；SPI 不承诺第三方兼容或恶意隔离。`LegacyRuntimeModule` 的实现固定放在 `apps/kite/src/bootstrap/legacy/`，通过 Host factory 的 `modules` 参数注册，并承接所有未迁移 operation；它是 composition adapter，不属于 `runtime-spi` 或 `builtin-runtime`。只有该精确路径可在 `architecture-exceptions.json` 中临时导入现有 legacy execution code，manifest 证明其单一 owner并持续缩小，RMV1-16 删除实现和 exception。

```bash
bun test tests/execution/tool-pipeline-stages.test.ts
bun test tests/execution/workspace-filesystem-provider.test.ts
bun test tests/execution/sandbox-execution-provider.test.ts tests/subagent-provider.test.ts
bun run check:runtime-packages
```

完成证据：[`2026-08-20-rmv1-08-runtime-spi-registry-legacy-module.md`](../execution/completed/2026-08-20-rmv1-08-runtime-spi-registry-legacy-module.md)。私有 SPI contract、duplicate-safe frozen Registry、bounded module lifecycle、Host 单一 registry-selected adapter 与 App-local `LegacyRuntimeModule` 已闭合；29 个未迁移 operation 与 owner manifest 逐项等值，Builtin factory 在具体 vertical cutover 前保持空列表。Required execution/package Gate、46 个 workspace package test、31 个 package/manifest negative test、root+7 workspace typecheck、docs/format/manifest Gate 均通过；State 25、Store 4 与原 epoch 未改变。

### RMV1-09：Capability binding 与 ExecutionTraits Scheduler

建立 Catalog -> Disclosure -> Binding -> Proposal -> Intent -> AuthorizedEffect -> Receipt 的进程内受治理链路，保留当前 Policy/approval 行为。

Scheduler 只消费：resourceScopes、access、conflictKeys、isolation、causal group、interaction barrier、concurrency group和lease requirement。删除 `PARALLEL_READ_TOOL_NAMES`、`call.name === 'task'` 等 branch。

```bash
bun test tests/runtime/scheduler.test.ts tests/runtime/tool-concurrency-budget.test.ts
bun test tests/runtime/tool-barrier.test.ts tests/subagent-approval.test.ts
```

完成证据：[`2026-08-20-rmv1-09-capability-binding-execution-traits-scheduler.md`](../execution/completed/2026-08-20-rmv1-09-capability-binding-execution-traits-scheduler.md)。唯一 Builtin binding provider、SPI immutable snapshot/pure arbitration、State 25-compatible traits projection 与 Agent Kernel name-free scheduler 已闭合；Scheduler/Runner 的 concrete tool-name branch 已删除，29 个 concrete Legacy operation 未提前迁移。Required scheduler/barrier/replay Gate、73 个跨包/边界测试、root+7 workspace typecheck、package/manifest/docs/format Gate 均通过；State 25、Store 4 与原 epoch 未改变。

### RMV1-10：`tool_search` pilot slice

`tool_search` 只观察 frozen catalog，不读取 Workspace、MCP或Model。完整走通 Registry -> Proposal -> Intent -> v4 commit -> attempt ack -> builtin executor -> Receipt -> Mailbox -> Kernel。

验收：zero-call fault、single-use CAS、identity equality、late receipt、single executor、Legacy branch删除、Client projection parity。若需要特殊旁路，停止并修 SPI。

```bash
bun test tests/execution/tool-pipeline-stages.test.ts
bun run test:tui:system:core
bun run test:runtime:fault
```

完成证据：[`2026-08-20-rmv1-10-tool-search-pilot-slice.md`](../execution/completed/2026-08-20-rmv1-10-tool-search-pilot-slice.md)。`tool_search` 已完整走通 Registry -> Proposal -> Intent -> Store 4 invocation/attempt ack -> Host single-use arbitration -> 唯一 Builtin executor -> exact Receipt -> Capability Artifact/terminal commit -> Mailbox/Kernel/Client；Core concrete executor 与 Legacy operation 已删除。Required Tool Pipeline、journey、14 个 TUI PTY 场景和 Runtime fault Gate 均通过，专门负向测试覆盖 zero-call、identity equality、single-use CAS、late receipt 与 forged receipt；State 25、Store 4 与原 epoch 未改变。

Gate 后 stop-and-report。

### RMV1-11：Skills、Context ports 与 MCP read

迁移 Skill workflow、ContextSource、ContextCompilerPort 和 MCP connect/discovery/read 的 module ownership。具体 Context/Prompt语义在 builtin-runtime，不进入 Host。

保持当前 MCP project approval、auth、credential、transport、egress、endpoint revision与recovery行为；不在本 Task引入通用 DataOrigin/Egress/Credential IR。

```bash
bun test tests/mcp-manager.test.ts tests/mcp-transport-boundary.test.ts
bun test tests/mcp-project-approval.test.ts tests/mcp-auth-coordinator.test.ts
bun test tests/mcp/data-egress-policy.test.ts tests/mcp/write-admission.test.ts
bun test tests/runtime/context-compaction.test.ts tests/runtime/context-compaction-summary.test.ts
```

完成证据：[`2026-08-20-rmv1-11-skills-context-mcp-read.md`](../execution/completed/2026-08-20-rmv1-11-skills-context-mcp-read.md)。Skill workflow/lifecycle、ContextSource/ContextCompiler、MCP connect/discovery/read/auth/credential/transport/egress 与 Web extraction 已由 Builtin 物理拥有；8 个 operation 从 Legacy 原子删除并通过唯一 Registry executor 执行。Provider context 的 `providerFacts/providerServices` 旁路已删除，facts 进入 request，受限 mechanism 进入 selected environment，Skill 只接收冻结最小 state view。Required MCP/Context/replay Gate、扩展 Skill/MCP 治理矩阵、package/manifest/typecheck 均通过；State 25、Store 4 与原 epoch 未改变。

### RMV1-12：Filesystem read/write

迁移 read/search/write/edit，保留当前 canonical path、trusted Workspace、external approval、read-before-edit、preimage、descriptor-relative commit、no-follow、protected path、unknown recovery 和现有 sealed seam。

每个 operation 原子切换；不重写通用 origin/egress model。

```bash
bun test tests/execution/workspace-filesystem-pipeline.test.ts
bun test tests/execution/workspace-filesystem-provider.test.ts
bun test tests/execution/workspace-filesystem-local-race-parity.test.ts
bun test tests/runtime/file-checkpoints.test.ts tests/runtime/filesystem-evidence.test.ts
bun run test:runtime:fault
```

完成证据：[`2026-08-20-rmv1-12-filesystem-read-write.md`](../execution/completed/2026-08-20-rmv1-12-filesystem-read-write.md)。Filesystem/Git contract 已进入 Runtime SPI，Local Provider、grant/evidence、descriptor-relative commit、Git broker 与 6 个 concrete executor 已由 Builtin 物理拥有；对应 Legacy operation 和 Core concrete executor 已删除。Required Filesystem/fault/Git/schema/Controller/replay Gate、workspace package tests、package/manifest/Core boundary/typecheck/build/docs 均通过；当前为 15 个 Builtin operation、14 个 Legacy operation，State 25、Store 4 与原 epoch 未改变。

Gate 后 stop-and-report。

### RMV1-13：Shell 与 Sandbox（已完成）

迁移 Shell/Sandbox module 和唯一 process supervisor，保持当前 approval、network、execution boundary、native/host-shell availability、cleanup与platform support语义。RMV1 不执行 ADR-0123 中新的 environment/no-fallback 行为切换；该 authority变化属于 RAV1。

```bash
bun test tests/execution/sandbox-execution-provider.test.ts
bun test tests/sandbox/execution-boundary.test.ts tests/sandbox/network-boundary.test.ts
bun test tests/runtime/concurrent-shell-cancel.test.ts
bun run test:runtime:fault
```

Gate：旧/新 spawn owner不能并存，当前行为 parity全部通过；之后 stop-and-report。

完成证据：[`2026-08-20-rmv1-13-shell-sandbox.md`](../execution/completed/2026-08-20-rmv1-13-shell-sandbox.md)。`shell_execute` 已由 Builtin Runtime 唯一拥有，Sandbox Provider contract、Builtin backend/grant/Local Provider、Host process spawn/supervisor 与 App availability composition 已按 SPI/Builtin/Host/App 物理边界迁移；Legacy operation 与旧 concrete owner 已删除或收窄为 RMV1-16 前 compatibility/lifecycle adapter。Required Sandbox/boundary/cancellation/fault Gate、扩展 Shell/App/Windows/Session parity、workspace package、package/manifest/Core boundary/typecheck/build/docs 均通过；当前为 16 个 Builtin operation、13 个 Legacy operation，State 25、Store 4 与原 epoch 未改变，ADR-0123 environment/no-fallback 切换仍留给 RAV1。

### RMV1-14：Verification 与 Subagent（已完成）

迁移 deterministic verification executor、Subagent protocol/continuation/ceiling/Artifact和ChildRuntimeDriver ownership。Verification Policy/Completion保留Kernel唯一 authority。

本阶段 child/reviewer Model call 继续通过当前唯一 Model Gateway port，不建立第二 Gateway；RMV1-15 再迁其具体实现和consumer wiring。

```bash
bun test tests/verification/completion-semantics.test.ts tests/verification/required-lifecycle.test.ts
bun test tests/subagent-delegation-contract.test.ts tests/subagent-provider.test.ts
bun test tests/subagent-continuation-codec.test.ts tests/subagent-approval.test.ts
bun test tests/subagent-runner.test.ts
```

完成证据：[`2026-08-20-rmv1-14-verification-subagent.md`](../execution/completed/2026-08-20-rmv1-14-verification-subagent.md)。Plan/Task、Verification 与 Subagent 的 8 个 operation、private SPI、deterministic executor、grant/provider/continuation/ceiling/Child Driver ownership 已迁入 Runtime SPI/Builtin Runtime；Core 只保留 State 25/Event、Model runner 与 Tool Pipeline adapter，Kernel 继续唯一拥有 Completion/Verification Policy。该阶段当时执行的 replay evaluation 证据已记录在完成证据中，但对应体系已由 2026-08-22 用户裁决整体移除，不再是 RMV1-16 Gate。Required 四组产品测试、扩展 parity、workspace package、owner/delete/source manifest、package/Core boundary、typecheck/build/format/docs 均通过；当前为 24 个 Builtin operation、5 个 Legacy Model operation，State 25、Store 4 与原 epoch 未改变。

### RMV1-15：Model、Context、Compaction 与 Reviewer（已完成）

将 Model Gateway/transport/live response source、ContextCompiler实现、prompt assembly、五类 purpose、streaming、compaction、auto review和verification reviewer迁入 builtin-runtime。

Host只持有 ContextCompilerPort和effect lifecycle；Model/Prompt语义不进入 Host。保持当前 Model Surface、provider-data policy、Artifact key、attempt ack、产品 restore/replay fail-closed语义和compaction行为。

```bash
bun test tests/model-invocation-gateway.test.ts tests/model-invocation-recovery.test.ts
bun test tests/model-provider-data-policy.test.ts tests/model-artifact-key.test.ts
bun test tests/private-immutable-artifacts.test.ts
bun test tests/runtime/context-compaction-e2e.test.ts tests/runtime/context-compaction-manual.test.ts
bun test tests/runtime/context-compaction-auto.test.ts tests/runtime/context-compaction-summary.test.ts
bun run test:runtime:fault
```

Package/import closure变化必须刷新模块化 generated/manual manifests，并由产品态 State 25 restore/Event replay、Artifact readback 与 fault tests 证明等价；不得保留已删除 evaluator 的 catalog、cassette 或 source compatibility seam。Gate后stop-and-report。

完成证据：[`2026-08-20-rmv1-15-model-context.md`](../execution/completed/2026-08-20-rmv1-15-model-context.md)。Model Surface contract 已进入 Runtime SPI，Gateway、transport、response source、Context/Prompt/Compaction、五类 purpose、streaming、当时的 replay evaluation、Artifact 与 reviewer 实现已由 Builtin Runtime 物理拥有；App 是唯一具体 Model composition owner，Core 只保留 State 25 类型兼容 adapter，Host 只保留 ContextCompilerPort/effect lifecycle。五个 Model operation 已从 Legacy 原子删除，当前六个 Builtin module 合计拥有全部 29 个 operation，Legacy operation 为 0。该阶段完成证据保留其历史执行结果；2026-08-22 裁决已删除 evaluator、record/replay source 与相关 CI，RMV1-16 只以产品 restore/replay 和完整 Gate 收敛。State 25、Store 4 与原 epoch 未改变。

### RMV1-16：静态领域 Reducer、Legacy 删除与闭合

在不改变 State 25/Event codec/snapshot shape 的前提下，把 Kernel内部拆为编译期固定领域：

```text
agent-kernel/src/core/
  lifecycle
  authorization
  intent
  lease
  completion

agent-kernel/src/domains/
  work
  interaction
  capability
  context
  verification
  recovery
```

统一 `reduceAgentState()` 只组合固定 reducer列表；不建设动态 State Slice、Plugin Runtime或namespaced persisted module state。generated State/Event shape和replay digest必须不变。

最终删除：LegacyRuntimeAccess、LegacyRuntimeModule/executor、central Tool Controller/Executor branches、App direct Runtime imports、name-based scheduler、old composition roots、root compatibility shims和architecture exceptions。

Required Gate：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run format:check
bun run lint
bun run check:core-boundary
bun run check:runtime-packages
bun run check:docs-impact
bun run check:docs
bun run test
bun run test:tui:system
bun run test:runtime:fault
bun run test:runtime:soak
bun run scripts/check-runtime-modularization-manifests.ts
```

完成 Gate：

- package graph无 cycle/deep import/forbidden import；
- concrete composition root恰好一个；
- manual manifest无 `legacy-owned`，generated graph无旧 symbol可达；
- State 25、Store 4、epoch与旧 Session restore全部不变；
- 产品 journey、State 25 restore/Event replay、fault/CI soak和docs全部通过；
- 正式 56-probe qualification未运行时不得登记为通过，但不阻塞本架构计划完成。

## 10. 分阶段 active 文档 Gate

| Task | 同一变更至少复核/更新 |
| --- | --- |
| RMV1-02/03 | `layer-boundary-enforcement.md`、`six-concept-runtime-architecture.md`、`workspace-trust.md`、TUI/CLI规则 |
| RMV1-04/05/06 | `six-concept-runtime-architecture.md`、`cancel-resume-cleanup.md`、`private-artifact-storage.md`、`session-logging-policy.md` |
| RMV1-07/08/09/10 | `authorization.md`、`tool-gated-autonomy.md`、`failure-classification.md`、`capability-progressive-disclosure.md` |
| RMV1-11 | MCP active文档、`model-provider-boundary.md`、compaction规则 |
| RMV1-12 | `file-reading-shared-boundary.md`、`authorization.md` |
| RMV1-13 | `execution-boundary.md`、`execution-platform-support.md`、Shell/Windows sandbox文档 |
| RMV1-14 | `verification-governance.md`、`completion-guard.md`、Subagent相关规则 |
| RMV1-15 | `model-provider-boundary.md`、compaction规则；旧 evaluation 文档已整体删除 |
| RMV1-16 | `core-entry-criteria.md`、`layer-boundary-enforcement.md`、`six-concept-runtime-architecture.md`、所有仍描述legacy owner的active文档 |

## 11. 回滚原则

- 每个 operation/task使用代码版本回滚，不在同一binary保留运行时fallback；
- v4格式始终不变，因此回滚不需要DB迁移；
- 已切operation出现问题时整体revert该operation，并恢复Legacy executor为唯一owner；
- unknown外部effect不能因版本回退自动重放；
- manifest和active文档必须与owner回滚同步；
- 任一Gate失败时停止，不跨阶段补丁式推进。

## 12. 完成定义

只有全部成立才可把本计划标为 `completed`：

1. 六包与App物理边界成立，root build/test覆盖全部workspace；
2. Client只使用Runtime Contract；
3. Host只拥有通用机制，具体Context/Prompt/Skill/Model/Capability语义在builtin-runtime；
4. Kernel纯化并按静态领域拆分，State 25/Event及产品 restore/replay保持等价；
5. SPI是私有编译边界，Registry冻结，Builtin无Store/State/Event authority；
6. Scheduler不含具体工具名；
7. operation owner/delete manifest闭合，Legacy和central duplicate executor全部删除；
8. State schema 25、Store schema 4、当前epoch与旧Session restore保持不变；
9. 产品 journey、State 25 restore/Event replay、fault、CI soak、package和docs gates全部通过；
10. RAV1保持blocked，直到本计划完成并产生完成证据。
