# TUI 流式正文、Thought 与工具

产品说明见[对话](../../../docs/handbook/clients/tui/guides/conversation.md)和[工具](../../../docs/handbook/clients/tui/guides/tools-and-subagents.md)。入口：[handleClientEvent](../src/tui/reducers/handleClientEvent.ts)、[工具结果结算](../src/tui/reducers/tool-summary-result.ts)、[聚合](../src/tui/reducers/consolidateTools.ts)。

## 请求归属

text/reasoning 按 requestId 累计；tool presentationGroupId 与对应模型 messageId 精确绑定。缺少或错配 identity 时保持 detached neutral 组，不把当前 Thought 当 wildcard。相邻 model.requested 本身不是阶段边界；前一组工具终态后，新的已确认模型请求可接管同一探索阶段，保留旧映射处理迟到工具 terminal。

RequestAssembly 保存未分类正文与 reasoning；单请求最多 1 MiB、同时最多 64 项。超限或 gap 保持 presentation_incomplete，不能把截断文本 seal 成可信完整结果。发布后清理 assembly。

## 正文与活动窗口

普通 Markdown 以完整段落、list item、代码/表格结构为提交边界，不拆成逐行消息。结构内部只推进完整行。没有 active Thought 时，完整组件按当前 projector 的 seal 判断成为稳定前缀；活动结构和未闭合尾段继续动态维护。

已有 Thought 时，待分类正文留在 RequestAssembly；带工具模型终态丢弃这份可删除正文，匹配探索工具继续原 Thought；无工具终态补齐并发布最终正文。不能同时显示过程旁白和同一份最终回答。

reasoning delta 只累计，completed 才更新有界活动窗口；工具步骤与最新完整 reasoning 交替显示。阶段结束后不持久保留活动 reasoning 正文。standalone 工具、人机交互或 Turn terminal 结算阶段，不允许后到的旧工具 terminal 关闭新 Thought。

## 工具与提交

queued 仅缓存 closed classification、label 和有界参数；started 才物化对应展示。未 started 的拒绝在有 queued metadata 时显示拒绝卡；完全缺失目标时不伪造匿名执行。分类由 Service 提供，TUI 不解析 Shell 命令重新判断只读。

tool_summary 只有阶段封口且聚合结果终结才能 seal；active=true 时不能用子工具全终态提前封口。standalone 终态卡片和并发 Subagent 的组终态由 projector 发布，renderer 不扫描子字段推断。Shell 成功保留有界 stdout/stderr 及 exit 状态，只有用户主动折叠才隐藏。

Service 累计流合帧在 durable 边界前 flush；Native client 的 completed reasoning 到下一事件之间等待真实 presentation commit，最多 1 秒，不能靠固定 sleep 猜时序。重试保留已提交内容，未确认尾部不伪装成完成；迟到 reasoning 不重新打开 sealed owner。

验证：[渲染测试](../test/tui-mock-render.test.tsx)、[Timeline 收尾](../test/tui-timeline-closeout.test.ts)、[取消后继渲染](../../../tests/tui-system/scenarios/cancel-successor-render.test.ts)。
