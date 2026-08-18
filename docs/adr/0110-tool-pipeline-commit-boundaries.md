# ADR-0110：Tool Pipeline 提交边界

状态：accepted

日期：2026-08-16

决策者：github:@ferqx

相关：ADR-0001、ADR-0007、ADR-0008、ADR-0043、ADR-0096、ADR-0105、ADR-0106、ADR-0107、`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

当前 Tool Controller 已执行 binding/schema 校验、Policy、approval、Provider readiness、dispatch、
artifact receipt、verification 与 recovery，但这些职责仍交织在一个控制面中。已有 MCP intent 和 recovery
journal 证明了关键副作用边界，却没有覆盖所有 builtin、filesystem、sandbox、Subagent 及 Provider
readiness/prepare 操作的统一 stage contract。

继续依赖调用者记住正确顺序，会让只读 observation、readiness 或 mutation prepare 成为无 durable intent
的绕过点，也会让外部副作用之后的 receipt failure 被误判为可重试失败。

## 决策

1. Tool execution 收敛为唯一 `ToolPipelineV1`，按 resolve、validate、classify、authorize、admit、
   dispatch、receipt、verify 的类型状态推进。前置纯 stage 不执行 Provider I/O。
2. 任何 Provider readiness、read-only observation、allocating prepare 或 side-effecting commit 前都必须已有
   对应 durable intent 且 Kernel acknowledgement 成功。ack 失败时该 Provider 操作调用数必须为零。
3. Policy 与 approval 只由 Pipeline 拥有。Provider adapter 只接收 Runtime 签发的 sealed grant，返回受限
   observation/receipt；不得写 Runtime Event、修改 RuntimeState、作 Policy 决定或发起 approval。
4. 外部副作用完成后，artifact receipt、canonical `ToolOutcomeV1`、terminal event 与 resource reconciliation
   必须按 effect 语义原子提交。receipt 无法提交时状态为 unknown，不能伪造 success、verification input 或
   自动 retry 权限。
5. Provider readiness 使用 keyed lifecycle 与 durable waiter ledger，允许相同 provider/revision 的并发等待者
   合并，但 search/discovery 不得直接触发 readiness。恢复时必须区分 none、attempted 与 unknown certainty。
6. Verification 只能消费已提交的 canonical receipt；它不能直接消费 adapter 私有返回值，也不能为缺失
   receipt 补造成功证据。
7. Builtin、MCP、Subagent 与后续 Local Provider adapter 必须逐一通过 differential parity 后迁入 Pipeline。
   production composition 不保留旧 Tool Controller dispatch fallback。
8. Tool Pipeline 迁移本身不切换 Runtime format epoch。只有 `CUT-01` 在全部 model/tool/provider 依赖完成并
   删除旧 dispatch composition 后执行唯一 epoch 切换。
9. ADR-0105 的同改动替换要求在 TP-01 至 TP-04 中按一个未接入 production 的迁移 series 验收：纯 stage
   可以先新增，但 TP-04 前不得形成第二条 production dispatch。Engine 的一般 feature flag 要求由
   differential/no-bypass evidence 与 CUT-01 替代，不能增加失败时回旧 Controller 的 runtime flag。

## 备选方案

- 仅把 Tool Controller 拆成多个函数：拒绝。没有类型状态和 durable commit boundary 时仍依赖调用顺序。
- 只为 mutation 建 intent：拒绝。readiness、safe read 和 prepare 也可能外发数据、消耗资源或分配句柄。
- receipt 失败后按原调用重试：拒绝。副作用是否发生未知时会重复执行。
- 迁移期保留 production adapter fallback：拒绝。它会在新 Pipeline 失败时恢复无证据路径。

## 后果

- Pipeline 需要明确的早终态、waiter、receipt 和 recovery 类型，并使 Tool Controller 逐步缩为 orchestration。
- Capability artifact 必须迁移到与 Model artifact 共用的安全 immutable storage primitive，但保持独立
  namespace、schema、访问策略和 retention。
- 测试必须覆盖 no-intent-no-dispatch、terminal atomicity、artifact failure、unknown recovery、
  idempotency 和 legacy journey parity。

## 回滚

CUT-01 前只能撤销未合并迁移并继续修复 parity，不能在 production 增加运行时 fallback。CUT-01 后任何
intent、receipt、artifact 或 verification boundary 失败均保持 fail closed。
