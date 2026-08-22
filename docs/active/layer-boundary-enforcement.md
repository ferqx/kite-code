# 当前规则：分层边界强制

状态：active
最后更新：2026-08-21
范围：

- `apps/kite/src/` 所有 App 模块
- `packages/runtime-contract/src/` 跨层类型定义
- `packages/runtime-contract`、`packages/agent-kernel`、`packages/runtime-spi`、
  `packages/runtime-host`、`packages/runtime-storage-sqlite`、`packages/builtin-runtime`
- `apps/kite`

读取时机：

- 在 Runtime workspace package 或 `apps/kite/src/` 中新增或修改跨边界代码时。
- 在 `packages/runtime-contract/src/` 中添加 `import` 语句时。
- 在 Kernel/Builtin domain module 中进行文本格式化（截断、省略号、展示文案）时。
- 修改 Runtime workspace package、package exports、依赖或目标 App 组合根时。
- Code agent 生成代码涉及跨层引用时。

相关：

- `understanding/2026-05-11-three-layer-architecture-design.md` — 三层分离架构设计规范
- `project-conventions.md` — 类型定义层级规则（互补）

验证：

```bash
bun run check:core-boundary
bun run check:runtime-packages
```

## 核心原则

物理依赖方向固定为 `apps/kite → runtime-host/runtime-spi/runtime-contract/runtime-storage-sqlite/builtin-runtime`
以及各 package 的声明依赖：Runtime Contract 不得依赖 App/Host/Builtin，SPI 只依赖 Contract，Builtin 不依赖 Host、
Kernel 或 App，Host 只依赖 Kernel/Contract/SPI，App 是唯一 composition root。

Runtime modularization 的 authority 另按 package seam 固定：Builtin 只从一个冻结 SPI registry snapshot
投影 schema/parser/effects/traits/operation owner；Kernel 只做纯 governance/admission decision；Host 只拥有同一
snapshot 对应的通用 execution port/lifecycle；App 只组合一个 Model Gateway 与一个 Builtin operation port。
当前 State26 production caller/owner closure 已切换到 App RuntimeSessionCoordinator、Host generic coordinator、Kernel
与 Builtin；RMV1-16 最终 manifest/docs/journey/fault/soak Gate 和完成证据已经闭合。RAV1 只能沿现有依赖方向增加
identity/authenticity/format，不能恢复第二 owner。

授权提升不变量的唯一实现是 `packages/agent-kernel/src/authorization.ts`。它只接受 canonical
`mode/source/sandbox/autoReview/loopMode` facts，不得导入 App、Builtin、Host、时钟、随机数或 I/O。
App CLI/TUI 经 `@kite/runtime-host` 的窄 runtime-policy port 调用同一 Kernel 实现；不存在 Core policy re-export 或
第二 authorization implementation/fallback。

**Kernel、Host、SPI 与 Builtin domain module 只关心数据结构和业务逻辑，不关心任何 UI 端的展示格式。**

Runtime package 的返回值应可被 CLI、Web、桌面客户端等**任意前端**直接消费，无需依赖 TUI 的类型或工具函数。

## 禁止事项

### 🔴 禁止：Runtime package 导入 app/tui 的任何符号

```typescript
// ✗ 禁止 — Runtime package 不应依赖 TUI 类型
import type { OutputBlock, InterruptState } from "../../apps/kite/src/tui/types.js";

// ✗ 禁止 — core 层不应依赖 TUI 渲染工具
import { getToolDetail, getToolPreview } from "../../apps/kite/src/tui/components/render-utils.js";

// ✗ 禁止 — core 层不应依赖任何 app/ 子目录
import { ... } from "../../app/...";
```

**合规方式**：

- Runtime Contract 定义中立的数据类型，不含 `blockId`、`preview`、`detail`、`expanded`、`folded` 等展示字段。
- TUI 层通过适配器函数（如 `sessionDataToUI()`）将中立数据转为 TUI 专用类型。

### 🔴 禁止：runtime-contract 导入 Host/Builtin/App

`packages/runtime-contract/src/` 只保存跨层共享、JSON-safe 且不拥有 Runtime 调度语义的数据。它不得导入
`apps/kite/src/`、Runtime Host、Builtin 或通过 alias、相对路径、barrel、静态/动态 import 间接取得这些类型。
State26 Kernel facts、Runtime Event 与 provider interface 只由对应 package seam 导出，不把 Host/Builtin/App authority
倒灌进 Contract。

`check:core-boundary` 使用 TypeScript AST 解析 module specifier 与符号来源，覆盖 alias、相对路径、
多行 import/export、dynamic import/require，以及被重命名、括号或注释包围的 Registry dispatch 调用。
基于单行文本或精确调用字符串的检查不构成分层门禁。

PS-01/RMV1-12 还增加 filesystem seam 的静态所有权：只有规范 package 路径
`packages/builtin-runtime/src/filesystem/local-provider.ts` 与其 descriptor-relative helper 可为受治理 Workspace
capability 导入 Node filesystem/native API；该 Local Provider 不得导入 Policy、Runtime authority、Host 或 App。
production filesystem consumer 不得导入已删除的旧 file/search 路径，也不得导入
`tests/helpers/` 中的 Fake、legacy dispatcher 或差分测试实现。Builtin catalog entry、App adapter、Host coordinator 与 Pipeline
只能依赖 Runtime SPI operation/observation、Provider interface 或注入的 dispatcher，不能保留失败时直连旧
实现的 fallback。

RMV1-13 增加 Shell/Sandbox 的静态所有权：`SandboxExecutionProviderV1` 只定义在
`packages/runtime-spi/src/sandbox-execution-provider.ts`；Sandbox backend、grant、protected path、network 与
Local Provider 只定义在 `packages/builtin-runtime/src/sandbox/`；异步 process spawn、POSIX supervisor、
bounded output 与 process-tree cleanup 只定义在 `packages/runtime-host/src/`；native/host-shell availability
只在 `apps/kite/src/sandbox/` 组合。禁止重新出现 concrete Provider、`Bun.spawn`、双 handler、异常 fallback 或
Host→Builtin 依赖。

App 的 prepared Shell port 与 acknowledged host-shell availability fallback 也必须由同一 sandbox composition
owner 选择：只有 typed `backend_unavailable + pre_dispatch + cleanupConfirmed` 的已确认 Runtime invocation 才能
初始化一次 host fallback；Kernel、Host、Builtin 或第二 App module 不得复制该选择、把 native backend 判为可用，或在
command 可能已启动后重放。

Tool Pipeline 的 process-local dispatch stage authority 也有独立静态所有权。authority module 只能由
`dispatch.ts` issuer 与 `receipt.ts` verifier 导入；Recorded/Dispatched issuer 只能在 dispatch adapter 内调用。
Controller 可调用的唯一例外是 dispatch module 暴露的 confirmed-failure 专用投影，它不接受通用
`ToolExecutionResult`，不能签发 success 或注入 filesystem/Runtime 字段。任何新增通用 seal/factory、从其他
App 或其他非 owner 模块导入 authority，或手造 `stage: 'dispatched'` 进入 receipt 都属于边界绕过。

### 🔴 禁止：Runtime package 做展示层文本格式化

下列操作属于**展示层格式化**，不允许出现在 Kernel、Host、SPI 或 Builtin authority 中：

| 禁止的模式             | 示例                             | 说明                                               |
| ---------------------- | -------------------------------- | -------------------------------------------------- |
| 硬编码字符截断         | `text.slice(0, 40) + "..."`      | 截断长度、"..." 后缀是 UI 约定                     |
| 硬编码行数截断         | `lines.slice(0, 6).join("\n")`   | 预览行数是 UI 布局决策                             |
| 硬编码展示文案         | `"(file too large for preview)"` | 不同 UI 需要不同语言/风格的文案                    |
| 空字符串变 `undefined` | `str \|\| undefined`             | 仅在需要区分「无内容」vs「空内容」的展示场景有意义 |

**合规方式**：

- core 返回**完整数据**（全文本、全量行数），由 TUI 层做截断和格式化。
- 如需数据约束（如防止事件过大），使用技术常量（如 `slice(0, 1024)` 防止 1MB+ 内容进事件），并注释说明是数据约束而非展示格式化。

### 🟡 灰色地带：协议事件中的格式化

跨层 DTO（例如 `packages/runtime-contract/src/presentation.ts` 中的计划、审批和用户输入载荷）位于 core 的下游。如果字段
包含展示倾向的数据：

- **可接受**：事件携带原始数据片段（如文件前 1KB 内容），各端自行格式化。
- **不可接受**：事件携带已格式化的展示文本（如 6 行截断 + "..." + 英文文案）。

### 🟢 允许：core 做数据/技术约束

以下截断是合理的**数据约束**，不是展示格式化：

| 场景             | 示例                              | 理由                       |
| ---------------- | --------------------------------- | -------------------------- |
| 事件数据大小限制 | `error.slice(0, 200)`             | 防止巨型错误消息撑爆事件   |
| Token 限制       | `text.slice(0, MAX_TOKENS * 4)`   | LLM 上下文窗口硬约束       |
| 技能体大小限制   | `body.slice(0, 100 * 1024)`       | 防止巨型技能文件占用内存   |
| 工具输出摘要     | `summary = content.slice(0, 200)` | 协议事件的数据字段，非展示 |

## 架构检查清单

新增或修改 Runtime package/App boundary 代码时，确认以下问题：

1. Contract/SPI/Kernel/Host/Builtin 是否导入 App，或 Host/Builtin 是否形成反向依赖？→ 有则删除反向边。
2. 这个函数返回的数据结构里有没有 `preview`、`detail`、`expanded`、`folded` 字段？→ 移到 App 层。
3. 这行 `.slice(0, N)` 是为了展示美观还是数据约束？→ 美观则移到 App，数据约束加注释。
4. 这个字符串是用户可见的文案吗？→ 如果是，由 App 本地化；Protocol 只保留中立载荷。
5. 新增接口是否替代并删除了旧入口或错误依赖？→ 没有则不属于架构收敛。
6. Workspace filesystem I/O 是否只由 Local Provider 拥有，Fake/legacy oracle 是否严格 test-only？→ 否则拒绝。
7. Recorded/Dispatched stage 是否只由 ack 后的 Pipeline issuer 签发，receipt 是否拒绝 clone/手造 token？→ 否则拒绝。

## Runtime 模块化迁移清单

RMV1 迁移期间，分层检查还必须通过
`bun run scripts/check-runtime-modularization-manifests.ts`。清单位于
`tests/reliability-harness/runtime-modularization/manifests/`，分为两类：

- 人工清单记录 operation/responsibility 的唯一 production owner、Legacy 删除目标、源码迁移目标和精确的临时架构例外；
- 生成清单从 TypeScript State/Event/codec、实际 SQLite DDL、package graph 与 public exports 提取源码事实，禁止手工编辑。

`*.generated.json` 只允许生成器写入，因此不由 Biome formatter 重排；其他源码和人工清单仍受正常
format/lint Gate 约束。生成文件的格式与内容正确性由逐字节再生成检查负责。

生成器输出必须可重复，生成事实与人工意图必须同时闭合。新增 production entry、builtin operation、root
export、源码文件、测试消费者或 Legacy seam 时，必须在同一阶段更新相应清单；迁移后则把旧 owner/branch
改为已删除并让 verifier 证明不可达。`architecture-exceptions.json` 只允许精确、带 owner 和到期 RMV1 Task
的 compatibility edge，禁止目录级 allowlist。

RMV1 manifest 最初只冻结 package/owner/source facts；RAV1 后同一生成机制的当前输出机械显示 State26、Store5 与
`kite-runtime-modularization-v1-2026-08-19`，并从 production Store5 source 绑定未被旧 header shim 占用的
`.runtime-state26-store5.db` target path。清单不能把历史 State25/Store4 checkpoint 或 `.runtime-v5.db`
header shim 冒充当前 production truth。

### RMV1-03 workspace 与 Client authority 边界

仓库现有六个私有 Runtime package 与 `apps/kite` 都具备真实源码、显式 exports、consumer test、独立
build/typecheck/test。RMV1-03 已把 CLI/TUI、Git、Observability、Release 与 Workspace App 源码迁入
`apps/kite/src/`，production executable 通过 `apps/kite/src/bootstrap.ts` 取得 Runtime 依赖；根
`apps/kite/src/index.ts` 是唯一根 package module，只能从 App 内部精确重导出
`createKiteRuntimeBoundaryV1`、`runCli` 和 `runTui`；过渡 `src/index.ts` 必须不存在，公共入口不能构造或重新暴露
Kernel/Host 的可变 Runtime authority。

CLI/TUI Runtime presentation 不得拥有或导入 Kernel/Host/Builtin 的 State/Effect/Store authority；它可以使用
`@kite/runtime-contract` DTO 以及受控的 Builtin presentation/config exports。静态门禁拒绝 Client 导入 Kernel Runtime
authority、`bun:sqlite` 或任何第二 composition root。`apps/kite/src/bootstrap.ts` 通过
`KiteRuntimeExecutionModule` 注册唯一 `RuntimeHostExecutionBridge` 选择单一 handler；不存在 legacy production
目录、异常 fallback 或第二 production owner。

目标 package 依赖图固定为：Host 依赖 Contract/Kernel/SPI，SPI 只依赖 Contract，SQLite adapter 只导入
`@kite/runtime-host/storage`，Builtin 只依赖 SPI/Contract，App 依赖 Contract/Host/SPI/SQLite/Builtin，且
`apps/kite/src/bootstrap.ts` 是唯一目标 concrete composition root。`check:runtime-packages` 是 Required Gate，当前
scoped graph 检查已通过：非 bootstrap App 可以消费显式 export 的 SPI type、Builtin presentation/config/mechanism
与 Host observability contract，但不得导入创建 Host、Runtime module registry、Builtin module/frozen catalog 或 SQLite
storage 的 authority factory。跨包 deep import、未声明依赖、forbidden edge、package cycle、第二组合根、上述 authority
factory bypass、Contract/Kernel 的 Node/Bun ambient authority、Kernel 的 clock/random 使用、Client Kernel authority import
和 RMV1 阶段的 ProjectHandle/projectId/State 26/Store 5 泄漏仍须由该 Gate 拒绝或由精确、到期的过渡例外登记。

Observability 的 owner 链同样固定：`@kite/agent-kernel` 唯一执行 Runtime Event→secret-free fact 的纯投影；
`@kite/builtin-runtime` 只把 typed fact/model/receipt/resource DTO 投影为 metric draft；Host 现有 metric schema
是唯一的 metric-name/字段校验 authority；App bridge 只做 draft→Host sample→reporter 注入。Contract 只定义 neutral
DTO，不重建 Event 语义。旧 Core observability seam 已删除；App
SessionManager 与 CLI 当前只经 `@kite/runtime-host` 的窄 `projectRuntimeObservabilityFactV1` port 调用同一
Kernel projector。禁止 App 直连 agent-kernel，禁止恢复
旧 observability mapper 或在 Contract/Builtin/App 复制第二份 Event→fact authority。

默认根测试按 workspace 拓扑运行 deterministic suites，随后按拓扑逐 workspace
运行 consumer test，避免 Bun 递归发现造成重复执行。根 `build`、`typecheck` 和 `test` 都必须覆盖七个
workspace；checker 会机械验证这三条根脚本，不能只依赖开发者约定。

### RMV1-04 Storage ownership 边界

`@kite/runtime-host/storage` 只定义 Session、四类 transaction、effect lease、checkpoint 与 Artifact
namespace port；不得导入 SQLite、App、Kernel State 或 builtin 语义。`@kite/runtime-storage-sqlite` 是当前
Store5 production adapter，且只能导入 Host storage exports。`apps/kite/src/bootstrap.ts` 是唯一 concrete
creator，并把 adapter 与 module 一起注入 `createRuntimeHost`；CLI、TUI、Kernel、persistence helper 与
App compatibility layer 不得直接导入 `bun:sqlite`、按路径构造 Store 或持有 raw database handle。

旧 v4 storage driver implementation 与全仓 caller 已清零。
State26 storage view 只由 Host storage port 提供；root tests 通过 Host State26 codec 与 SQLite Store5 adapter 组合同一个 seam，
不再复制 concrete driver。session-specific format preflight 必须发生在写连接建立之前。四类 transaction port
都只允许映射到一次既有原子提交，禁止 fallback、dual write、retry-on-alternate-driver 或扩展 Store5。

### RMV1-05 Host、Session 与通知边界

`@kite/runtime-host` 是 production `RuntimeAccess` 的通用机制 owner：它拥有 SessionRegistry、每 Session FIFO
mailbox、command routing、Host 生命周期内的 scoped idempotency、revision conflict、committed Client
projection、gap snapshot 和有界 durable/ephemeral subscription。Host 只依赖 Contract、Kernel、SPI 与注入的
storage/bridge port，不得导入 `apps/kite`、SQLite 或具体 builtin。

`apps/kite/src/bootstrap.ts` 仍是唯一 composition root。它为一个 CLI/TUI 进程组合一个 Host、一个冻结模块
列表和一个惰性 Store5 owner；Kernel session 取得的是同一 storage 的引用计数 view，view 关闭只释放 lease，Host dispose 后在
最后一个活动 view 释放时关闭底层 adapter。格式不兼容仍在原会话加载边界 fail closed，不因 Host 组合而让
TUI 挂载失败。

`apps/kite/src/bootstrap/runtime/KiteRuntimeExecutionModule.ts` 只注册唯一 App execution bridge：每次调用只进入一个
handler，不拥有 mailbox、dedup、projection history 或 subscriber。具体 Context、Prompt、Skill、Model、
Capability、Filesystem、Sandbox、Verification 与 Subagent 语义属于 Builtin/App，不能进入 Host。完整
effect/cancellation/recovery ownership 仍属于 RMV1-06；RMV1-05 不新增 AbortController、lease、
late receipt 或 unknown recovery 实现。

### RMV1-06 Host lifecycle 与 recovery 边界

`@kite/runtime-host` 唯一拥有长期 operation root AbortController、same-session cleanup barrier、shutdown drain、
四类 Store5 transaction acknowledgement、单-Store effect lease supervision 与 restart recovery。cancel fact 在
signal 前提交；stale/renew-lost lease 不得 dispatch 或 terminal commit。该 lease 只证明当前单 Store owner，不能
推导 cross-Host Project fence。App bridge 只接收 Host signal/services，不得创建第二 production lifecycle。

### RMV1-07 Pure Kernel 与 AuthorizedEffect 边界

`@kite/agent-kernel` 是 production transition owner，只导出纯 `decide/reduce/selectPendingEffects`、结构化
State/Event/Effect contract、`KernelInput`、canonical `DecisionFacts` 与 RMV1 最小 `AuthorizedEffect`。package
import closure 禁止 Node/Bun/process/Date/random/timer/network、Store、Host、SPI、App 与具体 Provider/Executor。
所有 clock、ID、workspace、policy/provider、protected-path、network、execution-boundary 与 attempt facts 均在包外
投影为递归 JSON-safe plain values；函数、getter、Date、symbol、cycle、非有限数与 `-0` fail closed。

Host 唯一拥有 Contract Command 到 `KernelInput` 的翻译。当前 State26 domain reducer/scheduler 通过 package 内固定
reducer 组合接入纯 transition；该 binding 不得持久化、执行 effect 或形成第二 decision path。旧 Core Kernel control
surface 已删除，State26 restore/recovery 由 RuntimeSessionCoordinator 与 Host session seam 负责。

`apps/kite/src/bootstrap/runtime/KiteRuntimeExecutionModule.ts` 及其 registered handler 是当前唯一 App execution
bridge。它只消费 Host/Kernel 已形成的 State26 facts 与 single handler route，不得重新 classify、policy、approve、
reduce、持久化或 fallback。Builtin operation owner 与 App/Host effect seam 已唯一闭合；最终 Required Gate 仍需验证
manifest、docs、journey、fault 与 soak 证据。

### RMV1-08 Runtime SPI、Registry 与 App Execution Module 边界

`@kite/runtime-spi` 是私有编译边界，不是公开 Plugin ABI 或恶意同进程隔离。它冻结 `RuntimeModuleV1`
lifecycle、module/provider/operation manifest、Capability definition/binding/executor、ContextSource/
ContextCompiler port、bounded Receipt、normalizer 和受控 execution adapter。SPI 不导入 Host、Kernel、Store、
App、Node/Bun ambient authority 或具体 builtin。RMV1 DTO 不含 RAV1 的 ProjectIdentity、DataOrigin、Credential、
签名、State 26 或 Store 5 字段。

Registry 在每个 module 的同步 `register()` 返回后立即封闭 scoped writer；重复 module ID、provider ID、operation
owner、Capability ID、Executor、ContextSource、normalizer 或 adapter 都使 bootstrap fail closed，executor 与
Capability 的 provider/revision 必须精确匹配。module 按声明顺序启动、反向释放，生命周期调用有界；partial
startup 会释放全部 module 并拒绝继续，不存在 degraded fallback、热替换、last-wins、双 handler 或双写。
register/start 不得承载 readiness、filesystem、network、认证、spawn 或其他外部 effect；readiness 必须在后续
vertical slice 中作为正常 capability 生命周期迁移。

`@kite/runtime-host#createRuntimeHost` 是 Registry 的 production lifecycle owner：同一模块列表只注册一次，
Host start 先完成 module start 再 hydrate/recover；Host 只通过
`kite.runtime-host.execution-bridge.v1` 取得一个精确 adapter，不再接收独立 `createLegacyAccess` factory。
dispose 先关闭 bridge，再反向释放 module，最后关闭 Store5 storage。Host 仍只拥有通用机制，不解释具体
Context、Prompt、Skill、Model、Capability 或 Provider 语义。

`apps/kite/src/bootstrap/runtime/KiteRuntimeExecutionModule.ts` 是唯一 App composition adapter，直接注册唯一
`RuntimeHostExecutionBridge`。`createBuiltinRuntimeModules()` 当前返回六个 concrete module，冻结 snapshot 合计唯一
拥有全部 29 个 operation；Legacy operation 列表为空，`architecture-exceptions.json` 当前为空，App module 直接注册唯一
bridge。production caller/owner closure 与 RMV1-16 最终 Required Gate 已闭合。

29/20/9 不是手工文档数字：`packages/builtin-runtime/test/builtin-runtime.test.ts` 与
`tests/scripts/runtime-modularization-manifests.test.ts` 从同一 frozen SPI snapshot 机械断言 module、operation、
model-visible 与 internal counts；对应 scoped evidence 为
`bun test packages/builtin-runtime/test/builtin-runtime.test.ts tests/scripts/runtime-modularization-manifests.test.ts`。

“Legacy operation 列表为空”、production caller/owner closure、最终 manifest、docs、journey、fault 与 soak Gate
已经全部通过；RMV1-16 与其 manifest 已有完成证据。

### RMV1-09 Capability lifecycle 与 name-free Scheduler 边界

`@kite/runtime-spi` 的 `CapabilityBindingV1` 必须与当前 State26 turn binding 逐字段一致；Disclosure、Proposal、
Intent、AuthorizedEffect 与 Receipt 是分离 DTO，不能把 model proposal 当 grant。`RuntimeModuleRegistryV1.snapshot()`
返回 immutable definition/executor/context-source identity，`arbitrateCapabilityV1()` 只能返回 exact resolved identity
或 typed failure；它不得读 Session approval、调用 Provider 或签发 Grant。

`@kite/builtin-runtime#createCapabilityBindingV1` 是唯一 production binding 构造者，保留既有 canonical digest
字节；root catalog 的同名 helper 只是 RMV1-16 前的兼容入口。RMV1-10 已迁移的 `tool_search` executor 见下一节；
其余 concrete capability executor 仍由后续 vertical slice 按 owner manifest 迁移。

`@kite/agent-kernel` 拥有纯 `ExecutionTraitsV1` overlap/batch decision。Builtin catalog declaration 只声明静态 resource scope、
conflict/isolation/barrier/group/lease facts，兼容投影器再从当前 call 的已持久化 effect classification 与 causal
identity 补齐 traits；这些 traits 不加入 State26 或 RuntimeEvent。`packages/agent-kernel/src/scheduler.ts` 只能消费 traits
和既有 Policy 结果，禁止具体 Tool/Capability name literal。Runner 以 `process` resource scope 与 causal group
识别当前 shell overlap，不以 Tool name 判断。只读 sibling Subagent 可共享并发组；workspace-write sibling 即使
Policy 已放行也因 exclusive workspace/conflict facts 串行。未知、缺失声明或无法证明不冲突的调用保持 exclusive
fail closed。

### RMV1-10 Host execution port 与 `tool_search` vertical slice 边界

`@kite/runtime-spi` 只新增 provider-neutral 的 `CapabilityExecutionInvocationV1`/`CapabilityExecutionPortV1`；
冻结的非 authority catalog facts 属于 `ExecutionRequestV1.facts`，不在 execution context 增设旁路字段。Provider
context 精确只有 grant、request digest、signal、selected execution environment 与 attempt identity；受限进程内
机制只能挂在允许的 `ExecutionEnvironmentRefV1`，不能作为另一个 Runtime Provider 或持久 authority。
`@kite/runtime-host` 从启动时的
immutable Registry snapshot 建立唯一 execution port：arbitration、request/grant/attempt exact identity、
`invocationId + attemptId` 单次 claim 与 receipt identity validation 都在调用 executor 前后机械执行。失败 identity
保持 executor 零调用，已 claim attempt 不会重入，exact late receipt 可以回到既有 receipt/recovery 路径；Host
不读取搜索 query/facts、不授予能力，也不提供 alternate executor。

`@kite/builtin-runtime` 的 `kite-builtin-runtime@rmv1-10` module 唯一拥有 `builtin:tool_search` definition 与
executor。Controller 只能投影一次当前 MCP/Skill descriptor 和脱敏 Provider Directory 为冻结 JSON request facts；
Builtin executor 只观察这些 facts，执行 inventory redirect、相关性排序、安全 metadata 与 zero-match summary，
不接收 Workspace、MCP/Skill runtime 或 Model handle。RMV1-10 checkpoint 后遗留的 `tool_search` compatibility
surface、`execute/projectResult` 与 Legacy operation registration 均已删除；六个 Builtin module 的 frozen snapshot
是全部 29 个 operation 的唯一现时态事实。

生产链固定为 Registry/Proposal/Policy → Intent → Store5 invocation+attempt 原子 ack → Host port → 唯一 Builtin
executor → exact SPI Receipt → 既有 Tool Pipeline Capability Artifact/terminal receipt → Kernel/Client 投影。App
composition root 把同一 Host port 注入 CLI/TUI；App bridge 不直接复制 SPI authority。任一 port、ack、binding 或 receipt
identity 缺失都 fail closed，不得回到已删除的 central executor。当前 State26、Store5、epoch
`kite-runtime-modularization-v1-2026-08-19` 保持既有 approval/readiness/安全语义，并叠加 RAV1 keyless integrity/identity/single-Host admission；不存在 Runtime installation root。

### RMV1-11 Skills、Context ports、MCP 与 Web ownership 边界

`@kite/builtin-runtime` 的 `kite-builtin-runtime-rmv1-11` module 是以下 8 个 operation 的唯一 execution owner：
`builtin:web_fetch`、`builtin:list_mcp_resources`、`builtin:list_mcp_tools`、
`builtin:read_mcp_resource`、`mcp:dynamic_tool`、`builtin:read_skill_reference`、
`builtin:complete_skill` 与 `builtin:activate_skill`。App tool-pipeline adapter 只保留 schema、availability、effect、Policy 与
result contract；旧 concrete executor branch 已删除，不存在双 handler 或异常 fallback。

Skill workflow/catalog/activation/lifecycle 的实现位于 `packages/builtin-runtime/src/skills/`。调用点必须把完整
Agent State 投影为只含 active task、workspace 与 Skill frames 的冻结最小 view；Builtin 不取得 AgentState、Kernel
Event 或 Runtime Store。ContextSource 与 ContextCompiler 实现位于 Builtin `model-context`，Source 只同步投影已提交
facts，不能读 filesystem、连接 MCP、访问 network/process/ambient credential；Host 只收集、验证和委托 compiler，
不解释 Context/Prompt/Skill 选择、authority、排序、预算或截断语义。

MCP connect/discovery/read/auth/credential/transport/egress/write-governance 的实际实现位于
`packages/builtin-runtime/src/mcp/`，Web SSRF/robots/extraction/worker 位于 `packages/builtin-runtime/src/web/`。
当前 App compatibility/composition 通过 `apps/kite/src/bootstrap/runtime/tool-provider-services.ts`、
`tool-pipeline-composition.ts` 与注入 port 组织；App 只能注入配置仓库、network boundary
fetch、单次 MCP invocation identity 与现有 recovery mechanism，不再拥有 Manager/Supervisor/Web 领域实现。MCP
动态调用继续核对 inner capability/revision，network/egress/write admission 继续在 Tool Pipeline dispatch
前 fail closed；Skill、MCP 与 Web executor 之间没有直接 Runtime Provider 调用。

Builtin/App workspace import 必须覆盖 `#builtin-runtime/mcp` 与 `#builtin-runtime/web`，不能把子路径误当外部依赖。
RMV1-11 没有引入通用 DataOrigin/Egress/
Credential IR，也没有改变 project approval、OAuth/keyring、endpoint revision、transport recovery、State26、Store5
或 epoch `kite-runtime-modularization-v1-2026-08-19`。

### RMV1-12 Filesystem 与 Git ownership 边界

`@kite/runtime-spi` 物理拥有 Workspace filesystem 与 typed Git 的 JSON-safe request/grant/observation/receipt
contract；SPI 不导入具体 Provider、Host、Kernel、Store 或 App。`@kite/builtin-runtime` 的 filesystem 子路径物理
拥有 Local Provider、grant/evidence、descriptor-relative commit、diff/projection，Git 子路径拥有 broker 与 native
platform admission；这些具体实现不得导入 Host、Store、AgentState、KernelEvent 或 App。

`kite-builtin-runtime-rmv1-12` 是 `builtin:read_file`、`builtin:search_content`、`builtin:search_files`、
`builtin:write_file`、`builtin:edit_file` 与 `builtin:git_inspect` 的唯一 execution owner。相应 App tool-pipeline adapter
没有 `execute/projectResult`；旧 Provider/Git/protocol 路径已删除。Host port 在 Tool Pipeline 已完成 resolve/validate/classify/authorize/admit、Store5
invocation/attempt acknowledgement 后，才把 invocation-scoped filesystem dispatcher 或 Git broker mechanism 注入
selected environment。Builtin executor 缺少 mechanism、收到伪造 input 或错误 observation 时 fail closed，不得调用
旧 handler 或另一个 Provider。

本阶段保留当前 canonical path、trusted Workspace、external mutation approval、read-before-edit、preimage Artifact、
mutation-ready ack、single-use grant、descriptor-relative/no-follow commit、protected-path、bounded projection 与
unknown recovery。State26、Store5 与 epoch `kite-runtime-modularization-v1-2026-08-19` 未变化；ProjectIdentity、keyless persisted integrity、
cross-Host fence、DataOrigin/Egress/Credential IR 与 Store 5 仍属于 RAV1。

### RMV1-13 Shell 与 Sandbox ownership 边界

`kite-builtin-runtime-rmv1-13` 是 `builtin:shell_execute` 的唯一 definition/executor owner；Sandbox Provider
contract 位于 `@kite/runtime-spi`，Builtin 持有 backend/grant/Local Provider，Runtime Host 持有唯一 process
spawn、supervisor、bounded output 与 process-tree cleanup，App 只组合 availability 与平台 adapter。旧 Core/App
compatibility 路径已删除，不存在另一个 spawn owner 或异常 fallback。

### RMV1-14 Verification 与 Subagent ownership 边界

`@kite/runtime-spi` 物理拥有 Subagent Provider/continuation 与 Verification 的 JSON-safe contract；它不导入
Core、Host、Kernel、Store、App 或具体 Provider。`kite-builtin-runtime-rmv1-14` 是
`builtin:ask_user/read_plan/update_plan/write_plan/task`、`subagent:start/resume` 与
`verification:deterministic` 的唯一 Registry owner。`ask_user` 仍由 Kernel interrupt node 物化用户交互，不进入
execution dispatch；其 operation identity 与 exact schema 由同一 Builtin module 冻结。

Builtin 物理拥有 deterministic verification check executor、Subagent grant/Provider/composition、continuation
JSON/cursor、role/ceiling 与 lifecycle 语义以及 `BuiltinChildRuntimeDriverV1`。App 的 verification/subagent adapter 只把
State26 投影为最小 view、注入 Shell/MCP/Artifact/reviewer port，并把 Builtin check result 转成既有
`verification.*` event；repair、compensation、Verification Policy 与 Completion 仍由 Kernel/Runtime 原权威处理。
App composition root 只构造一个 `BuiltinChildRuntimeDriverV1` 与 governed composition。当前
`apps/kite/src/bootstrap/runtime/subagent/task-tool.ts` 与 `tool-adapter.ts` 只注入 invocation-scoped callback；缺少已解析 Model 时 fail closed，
不允许由 adapter 现场重建 Model。所有注册、single-use dispatch、expiry、capacity 与 abandon 均由 Builtin Driver 决定。
缺少 mechanism、Artifact binding 错配或 Provider admission 拒绝
继续 fail closed，不存在 try-new-catch-old、双 Provider、双 handler 或双写。

App 的 `read_plan/update_plan/write_plan/task` adapter 已是 capability-backed schema/Policy surface，不能携带
`execute/projectResult`；Plan store 与 child Model runner 通过 invocation-scoped mechanism 注入。RAV1 当前在不恢复第二 owner 的前提下增加 ProjectIdentity、keyless persisted integrity、invocation-local child frame、single-Host invariant、DataOrigin/Egress/Credential IR 与 State26/Store5。

### RMV1-15 Model、Context、Compaction 与 Reviewer ownership 边界

`@kite/runtime-spi/model` 物理拥有 provider-neutral、JSON-safe 的 Model Surface、attempt outcome、response 与
opaque Artifact ref contract。`@kite/builtin-runtime/model` 物理拥有 message conversion、token/cache accounting、
prompt assets、Context projection/selection/serialization、五类 Surface compilation、live response source、transport、
bounded retry/streaming、immutable Artifact、compaction 与 reviewer 实现。
Host 只持有 `ContextCompilerPortV1` 与 effect lifecycle，不解释 Model、Prompt、Context 或 Reviewer 语义。

`kite-builtin-runtime-rmv1-15` 是 `model:primary/compaction/auto_review/verification_review/subagent` 五个 operation
的唯一 Builtin registry owner/executor。五个 operation 已从 App execution module 的 operation 列表原子删除；App-owned
`apps/kite/src/bootstrap/model-runtime-composition.ts` 只装配 Model Artifact 的既有独立 integrity mechanism、Workspace/Subagent mechanism
与唯一 live Gateway。Model/Prompt concrete implementation 位于 `packages/builtin-runtime/src/model/`；
`apps/kite/src/bootstrap/runtime/RuntimeSessionCoordinator.ts`、`runtime-effect-coordinator.ts`、`runtime-tool-effect.ts`
与 `turn-coordinator.ts` 是唯一 production State26 effect/caller seam，并复用同一 Gateway、Builtin coordinator、catalog、
Host capability port、投影环境与 Store5 effect lease。compaction terminal batch 只以 exact lease identity 持久化一次；
不存在 Core controller/executor/subagent caller、第二 coordinator 或 fallback。RMV1-16 源码 closure 与最终
manifest/docs/journey/fault/soak Required Gate 已全部通过。

Surface identity、provider-data admission、Artifact key、attempt ack、stream prefix suppression、compaction acceptance
与 reviewer failure propagation 保持不变。State26、Store5、epoch `kite-runtime-modularization-v1-2026-08-19`、ProjectIdentity、keyless persisted integrity、single-Host invariant 与 DataOrigin/Egress/Credential 已全部进入唯一 production composition；Runtime installation authority key 已删除。

## 历史：本轮重构解决的问题

| 提交      | 问题                                                             | 修复                                                                      |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `9fe064b` | `getToolDetail`/`getToolPreview` 在 core 和 TUI 各有一份         | 统一到 `render-utils.ts`，sessions.ts 导入共享版                          |
| `32f1dc7` | `sessions.ts` 导入 `OutputBlock`/`InterruptState`，返回 TUI 类型 | 定义中立 `SessionData`/`ReplayInterrupt`，构建逻辑移到 `replay-blocks.ts` |
| `3f28bba` | `checkpoint.ts` 和 `sessions.ts` 硬编码 40/60 字符截断 + "..."   | 展示截断移到 `SessionSelector.tsx` / `CheckpointSelector.tsx`             |
| `73aa079` | `runner.ts` 硬编码 6 行预览截断 + 英文错误文案                   | 只传原始内容片段，格式化移到 `handleEvent.ts`                             |
## RAV1-01 Project identity boundary

`runtime-spi` 只定义 Project 与分层 identity contract；`runtime-host` 是 ProjectIdentityStore 和 Host-issued ProjectHandle 的唯一 production owner。Client 不得提交任意 projectId，Builtin 不得签发或扩大 ProjectHandle。Store 的 race、workspace move 与 stale/mismatch 校验必须 fail closed。

RAV1-02 的 envelope/frame schema 位于 `runtime-spi`，其真实性 verifier、nonce claim 与 revocation registry 位于 `runtime-host`。两者均不得进入 Kernel 的领域语义，也不得把同进程 typed seam 伪装成密码学隔离。

RAV1-03 的 DataOrigin/Egress/Credential contract 位于 `runtime-spi`，Builtin 负责具体 observation projection；CredentialHandle 只携带 opaque identity、purpose 与生命周期，不得跨层传递 secret。

RAV1-04 的 single-Host lease 由 Host 提供、App bootstrap 调用；Builtin 与 Kernel 不拥有 lease，也不能绕过 Host admission。

RAV1-05/06 的 target storage constructor 属于 SQLite adapter 的 production surface，只能由 App bootstrap 唯一调用。

Store5 profile 与旧 Store5 test-only support 保持物理隔离；公共 package entry 不导出 Store5 constructor/path/constants。

App bootstrap 是 target storage profile 的唯一 composition owner；TUI harness 只读取 bootstrap 选定的 target path，不自行打开旧 Store5 作为 fallback。

Bootstrap、Host session binding 与 App coordinator 全部使用 State26；SQLite remains the sole State26/Store5 persistence owner。

SQLite target commit is the final schema-version authority for explicit snapshot metadata.
