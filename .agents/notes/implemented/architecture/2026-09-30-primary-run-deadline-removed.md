# Agent Note: 主 Run 无总期限，子 Run 保留独立时限

Status: implemented

## Problem

用户明确要求只有子 Agent 有执行限制，主 Agent 不受执行额度或时限限制。移除主 Run 累计额度后，原 30 分钟 deadline 仍在 Service、Host 准入及资金身份中生效；TUI 另有独立的 30 分钟完成等待。最新会话约 77 秒后停在等待用户回答，后续无新增事件，却在原期限到达后被报告为 `budget_exhausted`。等待时长不能被解释为持续执行时间。

同轮的 `shell_stop` 已开始并完成资源结算，但同批兄弟工具拒绝推进 revision 后，旧 lease 的并发终态规则遗漏此工具，导致准确工具及能力终态未持久化。移除期限不能替代修复这个收敛缺陷。

## Decision

新主 Run 使用 `unboundedRunDuration: true`、`maxRunDurationMs: 0` 与 `deadlineAt: null`，仅允许在没有 child Session 来源的主账本中配置。累计用量沿原 `unboundedCumulativeUsage` 继续记录。有限子 Run 保留自身激活时开始的 30 分钟期限，角色、策略、审批、并发、取消、显式工具超时与 Provider 单次能力继续生效。

旧活动主 Run 以独立幂等的 `resource_budget.run_deadline_removed` 事件移除期限，不改写已有累计额度升级事件。升级保留 `previousDeadlineAt`，仅用于准确旧资金身份核对；已签发的子 grant 不重签，旧有限 followup 不获得无限期限。新 null 资金须经准确主 Run、reservation 和无期限标记查证；SQLite 既有非空 TEXT 列用命名 codec 的 `null` 文本编码这个空值，读取还原为真实 null，旧 ISO 行保持原样。

Service 不为主 Run 安装期限 timer，Host 不按原总期限拒绝后续模型、工具或新委派。主 Shell 未显式设置超时会将 null 贯通准备和执行端口，有限命令仍须自然结束或由取消收敛；TUI 已接纳 Run 的完成等待由正式 Run 终态或连接失败结束。期限取消的工具 failure 显式使用 `budget_exceeded`，真实用户取消保留原分类。

`shell_stop` 复用严格的并发控制终态接纳：同一活动 Turn、仍为 running 的准确 Tool／Capability、原 effect lease 与完整终态配对缺一不可。开始派发、错误身份、已取消调用或重复迟到结果仍拒绝。这只保存原已执行调用的结果，不授予重放权。

本决定部分替代[累计额度移除决定](2026-09-30-run-cumulative-limits-removed.md)保留主期限的范围；[独立子 Run 时限决定](2026-09-29-independent-child-run-duration-only.md)的子授权与有限期限继续适用。

## Alternatives considered

- 只禁用 Service timer：拒绝。Host 准入、资金期限、Shell 默认超时与 TUI 等待仍可能在下层截断同一主 Run。
- 用巨大 timeout 或遥远日期表示无限：拒绝。仍是有限数值，并可能被平台 timer 截断或错误地传播给子授权。
- 改写 `cumulative_limits_removed` 的既有含义或重签旧 child grant：拒绝。历史回放与资金身份必须保持，独立期限升级事件提供明确转换证据。
- 为 `shell_stop` 放开所有旧 lease：拒绝。仅完整、准确且仍活动的控制终态需要跨 revision 接纳，dispatch 与迟到事实保持原门禁。

## Consequences

主 Run 可以跨越原期限继续执行或等待用户输入；真实失败仍关闭 Turn，不把工具局部失败当作整轮结束。长期执行仍需要相应 Provider、磁盘和操作系统实际资源，取消与未知外部效果恢复不被空期限放宽。资金 deadline 的 nullable 格式须贯通所有接收边界，并与旧有限身份严格区分。

验证覆盖 Kernel／Host 新配置与旧活动升级、超过原期限的准入、旧有限资金到期拒绝、真实 SQLite null intent 受理及有限 child 激活、Service 正式入口与进程重启恢复、TUI 超旧等待时限，以及真实 Host `shell_stop` 旧 lease 的红→绿回归。macOS Native Shell 已验证空期限派发与清理；Windows 取得源码协议和受控 adapter 测试证据，当前机器不能重建 Windows binary pin 或验证原生 Job，因此不声称该扩展具有 Windows 平台资格。

当前行为与实现入口见[执行手册](../../../../docs/handbook/features/execution.md)、[Host 生命周期](../../../../packages/runtime-host/docs/execution-lifecycle.md)、[Service owner](../../../../apps/kite-service/docs/runtime-application.md)和[Windows 资格边界](../../../../docs/active/windows-shell-sandbox.md)。
