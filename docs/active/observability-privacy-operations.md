# 本地无正文 Observability 与运营边界

状态：active
读取时机：修改本地结构化指标、health/status、alert、kill switch、incident runbook 或退出 flush 时。
验证：`bun test tests/observability`、`bun run scripts/operations/rehearse-agent-incident.ts`、
`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0056、ADR-0063、ADR-0069、Phase 3。

当前运营范围只有本地 metadata-only 结构化状态、health/status、disable-only kill switch、incident
runbook 与本地 rehearsal。项目不建立 external cohort、长期服务等级/error-budget 资格、分阶段运营
观察或远程托管 observability 路线；这些内容不再是产品规则、发布 Gate 或未来 Task。

## 数据与启用边界

`observabilityMetricsV1=false`，普通 CLI/TUI 入口没有 artifact telemetry authority 或默认网络 transport。
project 配置只能关闭观测能力，不能开启远程发送、提供 endpoint secret 或扩大 release ceiling。仓库中
保留的 exporter/composition contract 在缺少 release authority 或 transport 时固定注入 no-op reporter；
它们只证明不可达路径 fail closed，不构成受支持的远程 telemetry 产品面。

结构化 metric 在创建和 reporter 边界都由严格 schema 重建，拒绝 unknown 字段和伪造 definition。
allowlist 只接受有限 metric/attribute 枚举与有限数值；单样本 canonical JSON 上限 1024 bytes。prompt、
模型或工具正文、路径、命令、自由错误、secret、credential 与任意 user/project identity 都不得进入
metric、日志、报告或 artifact。未知 route/capability 只能折叠为固定低基数 alias，不能携带原值。
运行时权限切换的 `interaction_mode.changed` 是 Runtime Store 审计事实，不产生 observability metric 或
属性；其 user source 与时间戳不得通过观测通道外发。

Reporter 使用有界内存 queue，不写磁盘 spool；满时丢弃最旧低优先级样本并只记录本地 drop 计数。
序列化、flush 或 shutdown 失败不得改变 Runtime outcome。CLI 退出执行有界 shutdown；TUI 的 `/exit`、
双 Ctrl+C、SIGINT、SIGTERM 与 fatal ErrorBoundary 共用幂等 exit coordinator，并在退出前执行两个各
不超过 250ms 的 flush/shutdown 阶段。当前开发 composition 没有 transport，因此链路实际为 no-op。

`ReclaimShadowReporter` 是独立的、可选注入的严格 DTO 接口，不得复用 compaction local-debug reporter 或
通用 observability exporter。默认 collector 只在进程内保留固定上限样本并支持 clear；记录字段仅含固定
policy/version/mode、估算 token/count/saving、拒绝原因计数和 duration。它不得接收正文、path/pattern/args、
call/message/frame ID、任何 digest、plan、selected entries 或 stub，不写 event、snapshot、session trace 或
磁盘。序列化或 reporter 异常不得改变模型调用结果。

CLI `--telemetry-status` 与 TUI `/telemetry` 只显示脱敏的本地启用状态，不显示 endpoint、secret、
Workspace path 或正文。普通开发入口固定显示 `artifact_disabled`。

## 本地运营闭环

health/status 只报告 schema version、启用布尔值、queue/drop、最近成功时间与固定枚举状态；缺失数据
显示 `unknown`，测试失败不得包装成绿色。kill switch 只能关闭新 admission、停止 reporter 或回滚完整
本地候选，不能扩大 capability、恢复未知副作用或绕过 embedded ceiling。

Alert Owner 为 `github:@ferqx`，backup 为 `none (single-maintainer)`。本地 incident rehearsal 运行固定的
metadata-only detection、containment、credential-rotation 与 rollback 场景；结果明确标记
`synthetic_contract_only`，不冒充真实事故、外部用户或线上运营证据。旧 retained-evidence verifier 可以
继续作为篡改、重排、重复和 source-splice 的负向测试资产，但不产生运营 milestone。
