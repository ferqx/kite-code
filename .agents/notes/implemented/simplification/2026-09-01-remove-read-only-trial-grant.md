# Agent Note: 删除严格只读试跑 grant

Status: implemented

## Problem
先前的 Shell 方案在 unknown Shell 审批中增加 `read_only_once`，试图让用户先选择Workspace只读、network disabled的试跑。
实际产品评审确认该选项要求用户理解classifier、Sandbox和正常单次审批之间的差异，增加心智负担，却不改变核心结果：
无法证明只读的命令仍需要用户判断是否执行。

## Decision
1. 从TUI、CLI、Runtime Contract、Protocol、Kernel State/Event、Service prepared execution与Sandbox resolver完整删除
   `read_only_once`。未知或历史该值按closed schema fail closed，不提供兼容alias或迁移分支。
2. uncertain Shell继续按[Agent Note 0160](../bug-fix/2026-09-01-uncertain-shell-requires-exact-approval.md)请求exact真人审批，只提供正常`approve_once`、符合条件的`same_command`与拒绝。
3. 保留原方案中冻结并版本化的 Shell semantics registry、registry digest绑定capability revision、低基数未命中诊断和
   “不自动学习授权”结论。
4. 继续通过扩展registry descriptor与参数敏感inspector减少不必要审批；不得把底层分类差异转化为额外用户选项。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
- 用户审批界面恢复为稳定的单次允许、会话允许和拒绝，不暴露Sandbox实现选择。
- classifier覆盖率仍可演进，unknown命令仍保持exact approval与原sealed scope。
- 未发布grant不保留current兼容逻辑，Protocol digest恢复到删除前的closed值。

## 回滚
若未来需要不同执行scope的用户选择，必须新增Agent Note并提供可验证的独立用户需求；不得仅以Sandbox技术能力重新增加选项。

## Historical relationships

决策者：用户直接指令

相关：[Agent Note 0160](../bug-fix/2026-09-01-uncertain-shell-requires-exact-approval.md)、`docs/active/authorization.md`、`docs/active/tool-gated-autonomy.md`
