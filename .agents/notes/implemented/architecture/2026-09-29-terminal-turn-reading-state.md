# Agent Note: 轮次阅读状态依据精确终态切换

Status: implemented

## Problem

轮次过程原先只在确认最终回复后默认收起。模型失败、取消或在回复途中中断时没有 `finalReply`，过程会保持展开；进入下一轮后，当前 Run 状态也不能继续说明旧轮的终态。未完成的助手正文可能是阶段说明或答复，不能仅凭它位于最后就判定为最终回复。

## Decision

Desktop 对每个 `turn.terminal` 投影一个不渲染的 `turn_terminal` 消息，保留精确 `turnId` 与 completed、failed、cancelled、aborted 原始终态，不依赖轮次起止时间是否可用。共享阅读层以该事实切到终态折叠键，首次默认收起；用户再次展开后的选择仍由阅读状态保存。当前 Run 的已确认终态用于实时更新，旧轮由投影标记保持一致。未确认完成的正文仍属于过程，只有原有 `finalReply` 事实才把答复放到折叠块外。

## Alternatives considered

- 继续只看 `finalReply`：失败、取消和中途停止没有该标记，无法自动收起。
- 从最后一条助手正文或工具状态推断终态：阶段说明与部分答复无法可靠区分，单个工具停止也不等于整轮结束。
- 只读当前 Run 状态：下一轮开始后会失去旧轮的精确状态。
- 把最后一段未完成正文当作结论：会改变复制资格和消息含义，并可能误把阶段说明标为最终答复。

## Consequences

投影中每轮多一条隐藏标记；历史重放与重复终态事件必须按 Turn 身份去重。该标记只影响阅读布局，不改变 Runtime 结算事实。流式增量若尚未持久化，重读历史时仍可能不存在，折叠层不补造文字。当前行为见[Desktop 会话 UI](../../../../apps/kite-desktop/docs/conversation-ui.md)和[共享阅读层](../../../../packages/kite-client-ui/README.md)；Desktop 投影、历史重放及共享阅读测试覆盖四种终态、部分回复中断与手动重新展开。
