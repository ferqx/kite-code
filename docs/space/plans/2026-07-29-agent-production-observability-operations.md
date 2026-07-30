# Agent 生产化 Phase 3：无正文可观测性与生产运营计划

状态：draft
创建：2026-07-29
优先级：P0
依赖：
[`Phase 0 治理、决策与 ADR`](2026-07-29-agent-production-governance-decisions.md)、
[`Phase 1A 数据与隐私`](2026-07-29-agent-production-local-data-privacy.md)、
[`Phase 1C Runtime 稳定性`](2026-07-29-agent-production-runtime-resilience.md)、
[`Phase 2B Agent Evaluation`](2026-07-29-agent-production-evaluation.md) 的 metrics contract
Evidence 绑定依赖：
[`Phase 2A Release Control`](2026-07-29-agent-production-release-control.md) 的 `2A-F`
替代：
[`2026-06-18-opentelemetry-observability.md`](2026-06-18-opentelemetry-observability.md)、
[`2026-06-18-kite-code-telemetry-collection.md`](2026-06-18-kite-code-telemetry-collection.md)
设计依据：RFC §13–§17

## 目标

建立默认无正文、低基数、可用于 SLO/告警/kill switch 的生产可观测性，并形成具名 Owner
可以执行的事故检测、遏制、恢复和复盘闭环。

## 为什么替代旧计划

旧 OpenTelemetry 草案允许导出 thread ID、Workspace、文件、命令、错误 summary/stderr 和
其他内容；旧双通道草案仍允许 project basename、命令名和截断错误正文。已批准 RFC 明确
禁止远程 telemetry 发送这些字段。

本计划不在旧 Span 对象上做“先全量记录再 scrub”，而是直接从结构化 Runtime/Receipt
metadata 通过 allowlist mapper 构造生产指标。

## 非目标

- 不导出 prompt、reasoning、summary、工具参数/输出、文件内容或路径；
- 不导出原始 thread/user/workspace identity；
- 不从用户可见错误字符串解析指标；
- 不默认写 telemetry spool；
- 不让 exporter 失败影响 Runtime；
- 不用 dashboard 替代 on-call、runbook 和 kill switch。

## 主要改动范围

- 新增 `src/core/observability/`
- App composition root
- Runtime/Receipt/ClassifiedFailure metadata adapters
- bounded queue/exporter
- TUI/CLI consent/status
- dashboards/alerts/runbooks
- `.github/workflows/` 和 Release Evidence
- active/book/ADR/map

## 实施步骤

### 任务执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 3.1 | `T:1A:1A.1`、`T:1C:1C.4`、`MS:2A-F`、`T:2B:2B.4` | `src/core/observability/metrics.ts`、metric schema、`tests/observability/metrics.test.ts` | `bun test tests/observability/metrics.test.ts` | `observabilityMetricsV1=false` 起步；关闭时使用 no-op reporter |
| 3.2 | `T:1A:1A.2`、3.1 | `src/core/observability/mapper.ts`、secret/cardinality fuzz fixtures | `bun test tests/observability/mapper.test.ts` | 与 3.1 同 flag；禁止回滚到通用 serializer/scrub |
| 3.3 | 3.2 | reporter/no-op/bounded queue/exporter、queue tests | `bun test tests/observability/reporter.test.ts` | exporter 可独立 no-op；撤回 consent 清空未发送 queue |
| 3.4 | `T:1A:1A.1`、3.3 | `src/app/observability/consent.ts`、CLI/TUI config/status、composition tests | `bun test tests/observability/consent.test.ts` | remote telemetry 默认 off；project config 永远不能开启 |
| 3.5 | `T:2B:2B.9`、3.1–3.4 | `ops/dashboards/agent-production.json`、`ops/slo/agent-production-v1.yaml`、baseline report | `bun test tests/observability/dashboard-schema.test.ts`；baseline report replay | 无数据为 unknown，不显示绿色；阈值变更生成新版本 |
| 3.6 | `T:2A:2A.7`、3.5 | `ops/alerts/agent-production.yaml`、`src/app/release/capability-kill-switch.ts`、alert tests | `bun test tests/observability/alerts.test.ts`；kill-switch rehearsal | 只能关闭/降 cohort；控制面故障不扩大能力 |
| 3.7 | `T:0:0.1`、3.6 | `docs/runbooks/agent-production-incident.md`、escalation matrix | table-top walkthrough；`bun run check:docs` | runbook revision 保留历史；联系人缺失阻断 canary |
| 3.8 | `T:2A:2A.6`、3.6、3.7 | `scripts/operations/rehearse-agent-incident.ts`、report/evidence adapter | `bun test tests/observability/rehearsal-evidence.test.ts`；完整演练 | 演练失败停止扩面；不删除原始 metadata evidence |
| 3.9 | 3.1–3.8 | active/book/README/map、旧计划状态、完成记录；唯一产生 `MS:3-OPS-READY` | `bun run check:docs-impact`、`bun run check:docs` | 不回滚为旧内容 telemetry 计划 |
| 3.10 | `MS:LIM-APPROVED`、3.5–3.9 | `scripts/operations/qualify-limited-slo.ts`、limited observation report、Gate record；唯一产生 `MS:LIMITED-SLO` | `bun test tests/observability/limited-slo-gate.test.ts`；Gate replay | 无数据/G0/G1 时保持 blocked |

### Task 3.1：定义无正文 metric schema

领域：

- Run/Turn；
- Model；
- Tool；
- MCP；
- Skill；
- Plan；
- Verification；
- Compaction；
- Runtime；
- Resource；
- Release/rollout。

首版 Resource/Runtime 指标至少包含低基数的：

- active/reserved tool invocations 与顶层 shell invocations；
- process-tree size high-water/limit termination（不带 PID/command）；
- read batch size、tool/shell concurrency wait/saturation；
- approval overlap 后的 cancelled/not-dispatched sibling；
- cancel incomplete、orphan shell/descendant 与 late terminal rejection。

每个 metric 定义：

- 名称；
- 类型；
- 允许 attributes；
- cardinality 上限；
- producer；
- SLO/alert consumer；
- privacy classification；
- schema version。

禁止 label：

- thread ID；
- workspace/path；
- command/tool args；
- MCP URI/description；
- endpoint/model 自由文本；
- error message/stack；
- user identity。

provider/model 只使用 Release Profile 中受控 route alias；自由填写值映射为 `custom/unknown`。

### Task 3.2：实现 allowlist mapper

输入只允许：

- durable Runtime Event；
- Execution Receipt/structured result metadata；
- `ClassifiedFailure`；
- model/compaction duration 和 usage；
- App lifecycle/resource；
- Release Profile/version/cohort 的低敏投影。

输出：

- mode-specific typed samples；
- 大小上限；
- 有限枚举；
- 无通用 object serializer。

测试：

- 所有 Runtime Event variant 都显式 handled 或 ignored；
- secret/path/command/source marker 不出现在 serialized payload；
- error message 不成为 label；
- 自由 route/name 不产生高基数；
- cardinality fuzz 达到上限后归并为 `other`。

### Task 3.3：Reporter 与 bounded queue

实现：

- Core reporter interface；
- no-op reporter；
- App composition root 注入；
- bounded memory queue；
- 满时丢弃最旧低优先级样本并计本地 `telemetry_dropped`；
- exporter 网络/序列化/shutdown 失败不传播；
- 默认无磁盘 spool；
- consent 撤回后停止新样本并清空未发送 queue；
- process exit bounded flush。

不能使用全局 singleton；Sub-agent 与父 run 使用同一受控 reporter/route。

### Task 3.4：Consent 与管理策略

- remote telemetry 默认 off；
- canary 用户显式加入，显示指标类别、接收方、保留和退出方式；
- project config 不能开启；
- admin 可以强制关闭；
- mandatory enterprise audit 与普通 telemetry 分开；
- mandatory audit 不可验证时按 Phase 1C failure matrix 拒绝受管 session；
- content logging consent 不隐含 telemetry consent；
- model Provider consent 不隐含 telemetry consent。

TUI/CLI 状态入口显示 enabled/consent/endpoint policy，不显示 endpoint secret。

### Task 3.5：Dashboard 与 SLO baseline

Dashboard 最少：

- run/turn success/cancel/fatal/duration；
- model success/failure/retry/latency/token；
- tool/MCP availability/failure/recovery/timeout；
- Skill activation/frame/recovery；
- Plan progress/completion；
- Verification passed/failed/inconclusive/waive；
- compaction eligibility/result/failure/before-after；
- replay/migration/checkpoint/hard block；
- budget exhausted、RSS、listener、FD/handle、event-loop lag；
- tool/shell concurrency wait/saturation、`resource_saturated`、batch admission rejection、
  process-tree limit、cancel incomplete/orphan child；
- log/artifact bytes；
- task checks/human accepted/integrated/reverted 的聚合结果。

SLO：

- 固定 G0 零容忍；
- 其他阈值只在 internal baseline 后批准；
- 记录最小样本量、观察窗口和 error budget；
- “无数据”不能显示绿色。

### Task 3.6：Alert 与 capability kill switch

告警路由到具名 Owner：

- G0 立即；
- G1/required CI；
- error budget burn；
- compaction critical；
- sandbox/network/worktree failure；
- Provider/MCP outage；
- resource leak/budget spike；
- telemetry drop/absence。

动作：

- 关闭单 capability；
- cohort 置 0；
- profile/artifact rollback；
- 停止新高风险 invocation；
- 保留 metadata evidence。

首个 limited 无分钟级 remote rollout 时，cohort 必须可联系，runbook 明确撤回制品和通知
动作。不能声称存在自动 kill switch。

### Task 3.7：事故响应 runbook

至少包含：

1. detection/classification；
2. Owner/backup 与升级路径；
3. containment；
4. evidence preservation；
5. credential/key rotation；
6. user notification；
7. recovery verification；
8. reopen rollout；
9. postmortem。

最高级事件：

- 未授权副作用；
- sandbox/Workspace trust 绕过；
- credential/正文外传；
- Runtime/checkpoint 状态损坏；
- critical compaction fact loss；
- tenant crossing（未来拓扑，当前应不可达）。

内容事故也不得自动开启全量日志。正文证据需要单独合法授权。

### Task 3.8：演练与 Evidence

至少演练：

- capability off；
- cohort 0；
- artifact rollback；
- provider credential rotation；
- telemetry exporter 故障；
- sandbox/worktree G0；
- compaction critical；
- mandatory admin policy unavailable。

记录：

- detection time；
- containment time；
- affected scope；
- action success；
- stale process/session；
- recovery checks；
- Owner approval；
- runbook gap。

演练报告 digest 进入 Release Evidence/G4。

### Task 3.9：文档与旧计划状态

更新：

- 两份旧 telemetry 计划状态为 `superseded`；
- 新增 active observability/privacy 记录；
- session logging active 边界；
- `docs/book/10-持久化与会话管理.md`；
- `docs/book/12-测试体系.md`；
- README consent/config；
- `docs/documentation-map.json`；
- telemetry/privacy/incident ADR。

无正文 mapper、告警、kill switch、runbook、事故演练和文档门禁全部收敛后，本任务唯一产生
`MS:3-OPS-READY`。该 milestone 表示运营基础设施就绪，不代表 limited cohort 已满足 SLO；
后者只能由 Task 3.10 产生。

### Task 3.10：Limited cohort SLO 资格

仅在 `MS:LIM-APPROVED` 后运行基础 limited cohort：

- cohort 不开启 manual/auto compaction、MCP write、Skills 或尚未 stable 的 Verification
  completion claim；
- 使用 Task 3.5 预注册的指标、样本量、窗口和 error budget，不在看到数据后改阈值；
- telemetry 未 consent 的 cohort 不发送远程样本；只使用已批准的聚合/本地回收流程；
- 无数据、样本不足、G0/G1 或 Owner/kill switch 不可用时为 blocked；
- 输出 artifact/profile/route/cohort identity 绑定的 Gate record，唯一产生
  `MS:LIMITED-SLO`。

建议落点：

- `scripts/operations/qualify-limited-slo.ts`
- `tests/observability/limited-slo-gate.test.ts`
- `ops/slo/agent-production-v1.yaml`

## 验收条件

- [ ] production payload 无正文、路径、命令和自由错误；
- [ ] mapper/serializer secret corpus 命中为 0；
- [ ] cardinality tests 通过；
- [ ] reporter/exporter 故障不传播；
- [ ] queue 有界且 drop 可见；
- [ ] telemetry 默认 off、consent 可撤回；
- [ ] dashboard 覆盖 RFC 最小指标；
- [ ] SLO 有样本量、窗口和 error budget；
- [ ] G0/运营告警路由到具名 Owner；
- [ ] kill switch/rollback/credential rotation 演练完成；
- [ ] G4 evidence 可绑定 artifact；
- [ ] 旧 telemetry 计划不再可执行。
- [ ] `MS:LIM-APPROVED` 后的 limited SLO Gate 有唯一报告和 producer；

## 回滚

- exporter 可以整体关闭；
- telemetry consent 撤回立即停止；
- queue/config 可降为 no-op；
- 不回滚为旧的内容 Span/双通道 scrub；
- mandatory audit profile 只能回退整个受管部署，不能静默变成普通可选 telemetry；
- dashboard 失败不改变 Runtime，但外部 canary 无 SLO 数据时停止扩面。

## 风险

| 风险 | 控制 |
| --- | --- |
| 从旧 Span 复用导致正文泄漏 | 新 typed metadata mapper，不接收全量对象 |
| 低基数字段变高基数 | schema allowlist + cardinality budget |
| exporter 阻塞退出 | bounded queue/flush timeout |
| 无数据 dashboard 显示健康 | explicit no-data 状态，Gate 阻断 |
| 告警无人响应 | Owner/backup/on-call 在 Phase 0 绑定 |
| 演练只验证按钮 | 真实 artifact、route、credential 和恢复检查 |

## 完成证据

- metric schema/allowlist；
- privacy/cardinality tests；
- exporter fault report；
- dashboard 与 alert 规则；
- SLO baseline decision；
- consent/status UX；
- incident/rollback rehearsal；
- G4 evidence bundle。
