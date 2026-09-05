# ADR-0170：工具审批拒绝终止当前工具批次

状态：accepted

日期：2026-09-04

决策者：用户直接指令

取代：ADR-0137 关于 Approval Esc 只拒绝 focused target 并继续 sibling 的局部结论

重申：ADR-0049 关于拒绝任一工具审批即终止当前 turn 的结论

## 背景

模型可以在同一响应中声明一个需要人工审批的 Shell 和若干免审探索工具。旧实现把拒绝解释为只终结 focused Shell，随后继续
调度同批 sibling。实际会话因此在用户拒绝 Shell 后仍启动了一个`search_files`，最后才中止 turn；TUI 同时把拒绝压缩成脱离
原命令的`Command not run: approval rejected.`文本，用户无法从历史确认究竟拒绝了什么。

## 决策

1. 用户拒绝任一工具审批即终止当前 turn 的整个工具批次，不再推进同批 approval focus。
2. 同一 durable command transaction 原子提交：focused target 的`approval.rejected`与`tool.rejected`、其他所有未终结 sibling
   的`tool.cancelled`、必要的 capability/resource reconciliation，以及`turn.aborted(cause=user)`。
3. Runtime 在该 transaction 提交后才传播 AbortSignal。尚未开始的 sibling不得收到`tool.started`；已经开始的 sibling必须沿统一
   取消与cleanup路径收敛，拒绝后不得再次调用模型。
4. TUI 不为`approval.rejected`追加脱离工具的普通文本。随后配对的`tool.rejected`使用`tool.queued`时已投影的安全名称和参数，
   渲染一张保留原命令或目标的rejected工具卡，并明确表示执行从未开始。
5. `ask_user`拒答、Plan review取消、策略拒绝和系统自动审查拒绝继续保持各自既有语义；本决策只改变人工工具审批的明确拒绝。

## 后果

- 用户拒绝授权后，同批读取或其他工具不会越过该决定继续启动。
- durable日志完整区分被拒绝的目标与被取消的 sibling，并在同一revision边界结束turn。
- live与history都能从工具卡看到被拒绝的原始安全展示上下文，不再出现一条匿名“command not run”消息。

## 备选方案

- 只拒绝 focused target 并继续 sibling：拒绝；它把用户的授权否决错误解释为调度许可。
- 仅在TUI隐藏拒绝后启动的 sibling：拒绝；执行事实已经发生，展示层不能掩盖Runtime错误。
- 把 focused target 也记为cancelled：拒绝；目标的准确事实是用户拒绝授权，sibling才是因批次终止而取消。

## 回滚

若未来产品重新需要逐项审批并继续 sibling，必须新增决策并提供能明确区分“拒绝单项”和“停止本轮”的独立用户动作；不得复用当前
唯一的“拒绝”交互隐式恢复 focused-only 语义。
