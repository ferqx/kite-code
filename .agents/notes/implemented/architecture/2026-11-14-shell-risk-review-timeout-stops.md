# Agent Note: 默认 Shell 风险审核取消本地输出上限并在超时时停止

Status: implemented

## Problem

Windows Kite 使用本机 OpenAI Responses 的 gpt-6-luna 时，审核可在返回风险 JSON 前用完 256 输出 token。一条预期严重风险的隔离 Git Bash 样本在 8 秒超时后沿当时规则执行，合成数据到达回环端点。该次没有模型分类。观察与测试环境见 [Windows Shell 证据](../../../../docs/active/windows-shell-sandbox.md)。

## Decision

默认 Shell 风险检查省略请求的输出 token 上限，保留独立低思考和原默认 8 秒总期限。调用依赖完整有效的审核决定或其他已核实的现有授权。审核超时结束本次调用，返回未派发的超时结果。只有有效 high 分类进入默认人工审批。任一组合策略要求超时停止时，组合结果也停止。原检查的截止和停止要求一起封存，SQLite 拒绝超过期限的完整审核、超时派发依据与人工兜底。

这部分取代 [Shell 风险事实](2026-11-04-shell-risk-review-facts.md)和[审核预算与执行证据](2026-11-04-auto-approval-budget-and-execution-evidence.md)的默认 Shell 输出上限及超时继续规则。原审核材料、精确父子依据、技术失败、持久证据与非默认合同仍各自适用。

## Alternatives considered

- 将 256 改成另一个固定输出上限。复杂样本仍可能在产生有效分类之前耗尽该预算，采用提供商上限和原时间预算。
- 超时后请求人工决定。无法从逾期推导出 high；用户确认超时直接停止调用。
- 只依赖 Runtime 定时器先于完成回包触发。定时器和持久成功回执可能竞争，SQLite 按封存期限检查同一个终态事务。

## Consequences

审核总预算内未完成分类的脚本会报告超时，业务会话可以继续其他工作。旧超时和模型结果可按原证据读取。需要重建活动 Run 时，审核合同或实际 preset 失配会明确拒绝旧绑定。当前实现及验证归 [权限](../../../../packages/agent/src/permissions/README.md)和 [SQLite](../../../../packages/agent/src/storage/README.md#只读授权观察)。
