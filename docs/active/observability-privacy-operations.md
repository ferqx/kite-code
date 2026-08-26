# 本地无正文 Observability 与运营边界

状态：active
读取时机：修改本地结构化指标、health/status、alert、kill switch、incident runbook 或退出 flush 时。
验证：`bun test tests/observability`、`bun run scripts/operations/rehearse-agent-incident.ts`、
`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0056、ADR-0063、ADR-0069、Phase 3。

当前运营范围只有本地 metadata-only 结构化状态、health/status、disable-only kill switch、incident
runbook 与本地 rehearsal。项目不建立 external cohort、长期服务等级/error-budget 资格、分阶段运营
观察或远程托管 observability 路线；这些内容不再是产品规则、发布 Gate 或未来 Task。
当前版本不包含 synthetic evaluation cassette。reporter、metric、status 与 observability artifact 都不能读取
Production Model Artifact 或任何未来实验输入，也不能把 Runtime restore/replay authority 当作 telemetry consent。

## 数据与启用边界

`observabilityMetrics=false`，普通 CLI/TUI 入口没有 artifact telemetry authority 或默认网络 transport。
project 配置只能关闭观测能力，不能开启远程发送、提供 endpoint secret 或扩大 release ceiling。仓库中
保留的 exporter/composition contract 在缺少 release authority 或 transport 时固定注入 no-op reporter；
它们只证明不可达路径 fail closed，不构成受支持的远程 telemetry 产品面。

development/reference carrier 的一次性 bootstrap bearer、会话 cookie、token、Host/Origin 与
Workspace/Store authority identity 不属于诊断输入，也不得写入 Runtime Store。protocol/presentation event 正文
同样不属于诊断输入；carrier 仅可发出固定、无内容的连接/背压代码，不能把上述内容复制到文本日志（包括
stderr）、Session Logger、metric、health/status、report 或 observability artifact。canonical Runtime Event
本身是否持久化只由 Runtime Store contract 决定，不由 observability 规则删除。

ADR-0143 允许用户本地 TUI/CLI 的 closed presentation event 保留 reasoning、工具参数/结果与普通路径；该
产品展示面不是 observability。其正文可以进入 canonical Runtime Session history 并由 History Client 回放，
但不得复制到本节定义的 metric、health、diagnostic stderr、reporter 或运营 artifact。

结构化 metric 在创建和 reporter 边界都由严格 schema 重建，拒绝 unknown 字段和伪造 definition。
allowlist 只接受有限 metric/attribute 枚举与有限数值；单样本 canonical JSON 上限 1024 bytes。prompt、
模型或工具正文、路径、命令、自由错误、secret、credential 与任意 user/project identity 都不得进入
metric、日志、报告或 artifact。未知 route/capability 只能折叠为固定低基数 alias，不能携带原值。
运行时权限切换的 `interaction_mode.changed` 是 Runtime Store 审计事实，不产生 observability metric 或
属性；其 user source 与时间戳不得通过观测通道外发。
TUI 历史会话打开的 `NODE_DEBUG=kite-session` 是显式 opt-in 的本地诊断，不是 metric 或远程 transport。
它只允许输出固定 admission/replay stage 和闭集 failure code；即使本地启用，也不得输出 thread/session ID、
Workspace/Store path、Project digest、事件正文或原始异常。cleanup failure 使用同一约束，且只作为 primary
打开失败的 secondary diagnostic。
`completion.blocked` 同样只保留为 Runtime Store 的 completion lifecycle 审计事实；Kernel 的
`projectRuntimeEventToObservabilityFact` 不得为它创建 fact，Builtin projector 也不得为它创建 metric 或属性。事件只包含固定低基数的 blocker code、next action、计划阶段与 correction attempt，
不得包含 prompt、模型或工具正文、路径、命令、自由错误或身份信息。
Model Gateway 的 `model.invocation_prepared/attempt_started/completed/interrupted/evidence_unavailable` 也只
属于 Runtime Store evidence；Kernel fact projector 为它们生成零 fact。invocation id、Surface/Response
Artifact ref、integrity identifier、route/admission digest、reservation 与 parent link 不进入观测属性。
Provider readiness 的 intent、waiter、attempt、succeeded/failed 事件同样只属于 Runtime Store evidence，
Kernel fact projector 为它们生成零 fact；事件只允许有界 ID/digest、状态、时间戳与闭集 failure，绝不包含
endpoint、认证信息、tool args 或 provider 返回正文。
Tool Pipeline 的 `capability.invocation_recorded/execution_started/execution_result_recorded/
execution_succeeded/execution_failed/execution_unknown/reconciliation_resolved` 也生成零 fact。invocation 与
Tool identity、arguments/authorization/admission/effect/result/evidence digest、attempt ordinal、idempotency
key、Capability Artifact ref/locator、external reference、错误或 reconciliation 文本都不得进入属性。
既有 `model.responded` duration/usage 与 `model.retry` 低基数计数继续走 Kernel fact projector 和
Builtin projector 的 allowlist，不能从 private invocation event 补充高基数关联。

## Owner 与注入链

Runtime Event 到 secret-free observation fact 只有一个 owner：`@kite-ai/agent-kernel` 的纯函数
`projectRuntimeEventToObservabilityFact`。它只读取闭集事件字段，优先使用 envelope `occurredAt`，无 envelope
时使用调用方明确提供的 fallback 时间戳；不复制 State、Store、receipt identity、正文或自由错误。
`@kite-ai/builtin-runtime` 的 `createBuiltinObservabilityProjector` 只消费 typed fact、model、receipt、resource、release
与 task-stage DTO，并生成 metric draft；它不导入 Runtime Event 或 Host schema。Metric name、字段与数值约束仍只有
`@kite-ai/runtime-host` 的现有 metric schema 在 `createMetricSample` 边界校验。
`apps/kite` 的 Runtime bridge 只负责把 Builtin draft 交给 Host reporter，并吞掉 projector、schema 或 reporter 异常，不能改变
Runtime outcome。旧 `src/core/observability/runtime-fact.ts` 兼容 seam 已删除；App `RuntimeSessionCoordinator` 与 CLI
只经 `@kite-ai/runtime-host` 的窄 `projectRuntimeObservabilityFact` port 调用同一 Kernel projector。禁止恢复
旧 mapper/shim 或在 Contract、Builtin、App 复制 Event→fact 语义。

Reporter 使用有界内存 queue，不写磁盘 spool；满时丢弃最旧低优先级样本并只记录本地 drop 计数。
序列化、flush 或 shutdown 失败不得改变 Runtime outcome。CLI 退出执行有界 shutdown；TUI 的 `/exit`、
双 Ctrl+C、SIGINT、SIGTERM 与 fatal ErrorBoundary 共用幂等 exit coordinator，并在退出前执行两个各
不超过 250ms 的 flush/shutdown 阶段。当前开发 composition 没有 transport，因此链路实际为 no-op。

CLI `--telemetry-status` 只显示脱敏的本地启用状态，不显示 endpoint、secret、Workspace path 或正文。
普通开发入口固定显示 `artifact_disabled`；TUI 不提供 telemetry slash 命令。

## 本地运营闭环

health/status 只报告 schema version、启用布尔值、queue/drop、最近成功时间与固定枚举状态；缺失数据
显示 `unknown`，测试失败不得包装成绿色。kill switch 只能关闭新 admission、停止 reporter 或回滚完整
本地候选，不能扩大 capability、恢复未知副作用或绕过 embedded ceiling。

Alert Owner 为 `github:@ferqx`，backup 为 `none (single-maintainer)`。本地 incident rehearsal 运行固定的
metadata-only detection、containment、credential-rotation 与 rollback 场景；结果明确标记
`synthetic_contract_only`，不冒充真实事故、外部用户或线上运营证据。旧 retained-evidence verifier 可以
继续作为篡改、重排、重复和 source-splice 的负向测试资产，但不产生运营 milestone。
> 路径同步：runtime state/store 实现已采用无版本文件名，观测与持久格式 metadata 语义不变。
