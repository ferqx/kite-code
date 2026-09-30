# Agent Note: 独立子 Run 仅保留执行时限的累计资源上限

Status: implemented

## Problem

独立子 Run 原先从父 Run 分得模型请求、输入／输出 token、turn 和 Artifact 等累计额度。子 Agent 连续读取文件时，重复计入逐渐增长的上下文，可能在仍有执行时间和有用工作时被本地预算预留拒绝。固定份额也让任务复杂度依赖并发配置，与用户希望子 Agent 完成被委派工作不符。

## Decision

新受理的独立首轮子 Run 和 `followup_task` 新轮各自在激活时开始最长 30 分钟执行期限。该期限是子 Run 唯一的累计资源上限；不再为其模型请求、turn、输入／输出 token、工具调用或 Artifact 字节分配有限累计额度。父 Run 发起委派的工具仍须通过并发和授权检查；发起方是有限子 Run 时仍核验其期限，主 Run 期限由[主 Run 期限移除决定](2026-09-30-primary-run-deadline-removed.md)取消；父 Run 的累计额度后来由[主 Run 累计额度移除决定](2026-09-30-run-cumulative-limits-removed.md)取消。`resources.maxConcurrentSubagents` 继续可配置，默认 3，公开范围 1–28；新委派的 `code` 子 Agent 不再另占写者额度，旧委派按持久额度执行。角色、策略、授权、审批、执行权限和未知外部效果的恢复规则继续生效。新子 Run 的受理、激活和结果结算仍需持久身份及可恢复证据。已有 v1 有限预算的子 Run／followup 按持久 grant 回放，不静默扩权或改写历史。

本决定部分替代[累计资源治理决定](2026-07-30-cumulative-runtime-resource-governance.md)中把子 Agent 所有消耗计入父 Run 累计份额的范围。该决定的原子 reservation、并发许可、未知结果与准确终态原则继续适用；新主 Run 的累计数值范围又由上述 2026-09-30 决定替代。

## Alternatives considered

- 保留每个子 Run 的有限模型／token／Artifact 份额，只调高默认值：不采用；长对话的重复上下文计费仍可能触发同类提前耗尽，并使能完成的任务随配置数值变化。
- 连子 Run 执行时间也取消：不采用；失去对子任务持续占用执行资源的明确终止边界。
- 取消子 Agent 并发上限：不采用；用户明确要求保留可配置并发上限，受理时仍须核验该额度。

## Consequences

- 新独立首轮与新 followup 目标 Run 在自身期限内继续模型和工具调用，不因子 Run 的累计请求、turn、token 或 Artifact 计数耗尽而失败。Tool／MCP／Skill 的预留以 `durationOnlyChildRun` 子预算中的持久 `unboundedArtifactBytes: true`、`artifactBytes: 0` 表达单次工具不受累计 Artifact 上界约束；实际产物字节仍在结算时记录，供核对与诊断使用。私有 Task Artifact 的字节量不再计入父 Tool 累计产物用量，原 ref／digest／owner 完整性核验继续生效。`send_message`、`interrupt_agent` 和 `task_cancel` 不产生工作区 Artifact，也不预留其字节额度。
- Runtime 原先对单件模型／子任务私有产物、任务文字／名称、邮箱正文／待投递量、等待目标和时长、模型重试与本地输出默认值、默认有限 Shell 时长，以及进程内子任务登记／墓碑的固定阈值不再截断新子 Run；Provider 自身能力、明确指定的单次超时、格式、授权、完整性和物理资源仍独立生效。新跨 Session 邮箱验证超过 5000 字节正文及 9 条待投递消息一次进入模型输入。
- 新子 Run 的 Tool recovery journal 保留失败血缘与结构校验；工具准入、调度和计划完成不再用固定纠错次数或普通 `no_progress` 次数提前结束该 Run。`journal_invalid`、策略拒绝和缺少安全重复证明的外部操作仍阻止派发；历史有限预算 Run 的恢复额度不变。
- 新 v2 followup 缺少 terminal checkpoint 时，可从准确终态的持久 State 快照续跑；Store 将 source revision／digest、transcript 与 grant／新 Run 绑定。原 Run 有未知外部效果时，新 grant 签入 `priorOutcomeUnknown`，首模型收到明确观察提示，旧外部调用不自动重放。旧 v1 及证据不完整的路径仍失败关闭。
- 新 v2 followup 在并发位满时先持久排队；已受理意图不因来源 Run 原截止时间或短容量等待时限而过期，取得并发位才激活目标 Run 并开始 30 分钟期限。来源用户取消仍按准确受理事实结算；目标 completed／unknown 终态以准确审计释放来源并发槽。历史有限备付仍沿原有界等待和 `capacity_timeout` 规则。
- 父 Run 的执行期限、可配置子 Agent 并发上限及角色／授权／审批继续拒绝不合规的受理或调用；新委派的 `code` 子 Agent 不占独立写者额度。
- 旧有限预算记录与 v1 followup 按原持久上界恢复；超时、取消、结果不明及重复派发继续按既有证据收敛。

单个子 Run 在 30 分钟内可发出更多模型请求并产生更多数据，实际用量由模型服务、工作区存储及操作系统的独立边界承担。新旧持久预算格式共存，恢复逻辑依准确持久标记区分路径，不能凭当前配置推断旧记录获得新额度。Service/Store 集成验证覆盖独立续跑 14 次工具调用后的继续执行、父账本零子级计数结算与旧 v2/v1 兼容；现有 Run 续投和服务端 15 次模型调用的回归也已通过。无 checkpoint 的 completed 续跑与 prior unknown 显式观察／不重放的焦点 E2E 3/3 通过，旧 `current_turn` 的 routed／prepared 两处 SIGKILL 窗口仍各自准确续派原模型调用一次；Store15 升级、回滚与超过旧私有产物大小阈值的验证 22/22 通过。
