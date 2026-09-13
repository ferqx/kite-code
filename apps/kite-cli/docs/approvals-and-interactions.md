# 审批与交互投影

产品预期见[审批指南](../../../docs/handbook/clients/tui/guides/approvals-and-questions.md)。实现：[ApprovalBlock](../src/tui/components/ApprovalBlock.tsx)、[PlanReviewBlock](../src/tui/components/PlanReviewBlock.tsx)、[global keys](../src/tui/hooks/useGlobalKeys.ts)、[事件投影](../src/tui/reducers/handleClientEvent.ts)。

Footer 只响应当前 active interaction，后台 pending 不抢焦点。request 绑定 interactionId、generation、owner 与 revision；过期动作不能回退作用于后来选择的 Session。

Enter/Esc 提交后，applied/idempotent receipt 之前保持交互及提交态。Enter 立即屏蔽重复输入，但延迟 200ms 才展示提交中反馈，避免正常的短回执闪现等待页；慢回执仍有明确反馈。连接、过期或状态变化错误不伪造授权、回答或取消；失败提示属于当前 Footer transient，不写入永久匿名消息。收到新 projection 后按稳定 identity 刷新 revision 再重试。

拒绝当前审批与整轮取消是不同输入语义；focused target 记 rejected，其他同轮 sibling 随真实 terminal 取消。Ctrl+C 始终整轮取消。取消先显示 Cancelling，等待 canonical terminal/idle；多次取消复用 Promise。start receipt 前取消进入 cancel-after-accept，取得身份后发送一次准确 cancel。

snapshot 用完整 queue 替换本地 Map，空 queue 可以清除旧交互；重复相同 active identity 不再追加问答。不能在清除 interrupt 后再 fire-and-forget 补 cancel。

计划批准由单次 plan.approved.executionMode 固定计划执行方式与展示，不在之前发额外 mode change 破坏审核 identity。问答已完成步骤不在恢复时重开，嵌套 Esc 由对应 owner 返回。

结构化问答在客户端提交 `question id -> option id | free text` 供 Service 对当前交互校验；Service 的持久回答事实保留该内部身份，投给模型和历史的工具结果使用问题、选项文案或自由输入原文。TUI 与 Desktop 遵循同一边界，不把 `q1-o1` 等位置编号作为 Agent 的语义答案。

验证：[问答 PTY](../../../tests/tui-system/scenarios/ask-user-esc.test.ts)、相关 approval/plan/interaction tests，及 Native facade conformance。布局与语言规则见[本地化](tui-localization.md)。

## 当前差异：Esc 提交态

Enter 通过 [ApprovalBlock.resolve](../src/tui/components/ApprovalBlock.tsx) 设置 submitting；Esc 则由 [App](../src/tui/App.tsx) 的全局回调直接 submitActionAsync(reject)，没有向 ApprovalBlock 传入同等提交态。因此拒绝回执返回前仍可能显示可选项，上文的 Enter/Esc 一致反馈尚未完全实现。

修复需共享受控提交状态或复用同一提交入口；补充 reject promise 挂起期间的反馈与重复输入测试。[布局测试](../test/tui-layout.test.tsx) 中 Enter 延迟回执和 Esc 拒绝/失败断言不能替代 Esc 在途状态断言。
