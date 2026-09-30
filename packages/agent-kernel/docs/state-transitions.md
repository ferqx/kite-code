# State、Event 与确定性转换

Kernel 负责从当前 State 和已确认 facts 决定下一状态，不执行 I/O。真实入口是 [kernel.ts](../src/kernel.ts) 的 decide，以及 [reducer.ts](../src/reducer.ts) 的 reduceAgentState；[state](../src/state.ts) 和 [events](../src/events.ts) 保存完整类型。

## 输入与结果

| 对象 | 生产者 | Kernel 的处理 |
| --- | --- | --- |
| KernelInput | Host 的命令/回执/fact 翻译 | 检查 Session、expectedRevision 与事件批次 |
| DecisionFacts | Host 构造的 JSON-safe facts | 使用注入的时间、identity、策略及 scheduler facts，不读取外界 |
| KernelEvent | 已封闭的业务事件 | 校验、规范化、按静态 reducer 转换 |
| KernelDecision | decide | applied、rejected、conflict 或 idempotent_replay |
| pendingEffects | scheduler | 供 Host 后续执行，不是在 reduce 时执行 |

`applied` 返回 events、envelopes、nextState 和 pendingEffects；`conflict` 指明当前 revision；拒绝和幂等重放都不能被调用者当成新的副作用执行许可。

已确认派发的 effect 返回时若 State revision 已被无关事实推进，Kernel 默认拒绝旧 lease。例外必须按 effect 类型显式证明：`shell_stop`、`task_read`、`task_wait`、`task_cancel` 仅在同一活动 Turn、原 `run_tools` lease 内的精确 Tool 仍为 running、Capability attempt 已确认且结果批次只包含该调用的 Capability／Tool 终态时，允许跨 sibling 或 background settlement revision 接纳。dispatch 前的 attempt、错误 Tool identity、已取消或已终态调用及其他事件仍拒绝；该规则只保存已经执行的结果，不授权重放工具。

## 转换过程

先验证当前写格式、输入 identity/revision 和 facts，再规范化事件并使用固定组合 reducer。Core 负责 intent、authorization、lease、lifecycle、completion；domain 负责 work、capability、context、interaction、recovery、verification。不同领域对同一事件的处理顺序由源码静态确定，不接受调用者注册第二 reducer。

Host 分配时间和 ID，Kernel 只校验与使用。重放同一已提交事件必须得到同一状态；不能在 reducer 中读取 clock、random、文件、Provider 或编译动态配置。

`turn.aborted` 会由授权归约同时取消尚未结算的审批 Tool。若该 Tool 已开始执行，Host 在提交同一批次前为仍活动的 Capability 补入带 Host 时间的 `capability.execution_unknown`；外部执行结果未获确认时保持 unknown，避免 Tool 已终态而 Capability 仍在运行，也不把异常结束误记为用户主动取消。

新主 Run 的持久预算使用 `unboundedCumulativeUsage` 与 `unboundedRunDuration`，`deadlineAt: null` 明确表示无总期限；`maxRunDurationMs: 0` 仅为该模式的格式占位。旧活动主 Run 分别由 `resource_budget.cumulative_limits_removed` 与 `resource_budget.run_deadline_removed` 事件幂等升级，后者保留 `previousDeadlineAt` 供已有资金身份核对；Kernel 保留累计实际用量、并发校验和在途执行身份，并放宽当前 Run 尚未结算的直接模型／工具预留上界。无期限配置及升级不能用于 child Session；独立子 Run 继续验证有限 deadline。已结束历史 Run 与旧子 grant 不因当前配置改写。资源等待记录仍接受历史 `['artifact_capacity']`，并继续读取旧 `['writer']`、`['tool']`、`['tool', 'shell_invocation']` 记录。Kernel 只验证持久事实、顺序和状态转移；等待重算、超时后的局部 Tool 失败以及 Run 级失败选择由 Service 和 Host 决定。

无累计额度的活动账本用 `externalizedClosedReservations` 标记，只在 State 保留尚未结算的 reservation。Kernel 结算时移出记录；Host 与 Store 在同一 State revision 事务写入完整终态 receipt。旧账本升级时迁出既有终态记录，旧有限账本仍沿原状态格式恢复。已归档身份的幂等重放与父 reservation 血缘由 Host 的 Store receipt 查证，Kernel 不读取数据库。

在 `unboundedCumulativeUsage`／`durationOnlyChildRun` 活动 Run 中，required verification 的 `repair.maxAttempts` 保留事件格式但不作为修复次数门禁；失败或无法确认时继续 `repair_pending`→模型修复→验证，只有通过或用户的结构化 waiver 才能完成。旧主 Run 升级后，因次数耗尽而产生、没有规范诊断的 `budget_exhausted` 可恢复修复；无效规范、缺少校验事实和身份不符仍阻塞。回归见 [Service verification](../../../apps/kite-service/test/runtime/verification.test.ts)。

自动压缩的失败保留原 checkpoint 和 transcript，scheduler 可继续模型请求；失败的可选 `sourceDigest` 进入持久状态，Builtin 用它抑制同一来源的立即重复压缩。新增上下文后可再次尝试，旧记录无 digest 时按当前 Turn 防止重复。低收益、频次和冷却计数不再禁用自动压缩；有效 checkpoint 须有实际正向减少、准确来源与覆盖边界，不要求节省固定 1024 token。PlanDocument 的结构、摘要、身份与完成证据继续验证，正文／步骤／标题长度不再作门禁。Auto 审查的重复与拒绝计数只保留观察语义，授权仍按每次调用的真实策略和能力决定。

## 与持久化的交接

Kernel 返回的 nextState 尚不等于持久提交。Host/Storage 将事件、快照和相应运行事实在指定事务边界落盘，再执行 pending effect。页面不能跳过这一步直接从模型结果修改 Kernel 状态。

正常执行、历史读取和当前 writer 的格式边界不同；旧 State 解码不允许恢复旧执行路径，见[恢复与完成](completion-recovery.md)。

验证：[Kernel](../test/agent-kernel.test.ts)、[core reducers](../test/core-reducers.test.ts)、[codec](../test/codec.test.ts)。产品结果含义见[执行](../../../docs/handbook/features/execution.md)。
