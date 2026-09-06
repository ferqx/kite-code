# TUI 消息投影与终态

产品预期见[对话展示](../../../docs/handbook/clients/tui/guides/conversation.md)。入口：[事件 reducer](../src/tui/reducers/handleClientEvent.ts)、[Timeline](../src/tui/presentation/timeline.ts)、[状态 reducer](../src/tui/reducers/index.ts)。

只消费 accepted client presentation envelope，保留 Session、generation、durability、revision、Run/Task/Turn 与 stream identity。未知或不可安全投影的事实明确 unavailable，不传入 raw Store event 或 any。

Message Projector 是聚合及 Live→Sealed 的业务 owner。OutputBlock 为单向兼容渲染 DTO，每个变体必须有 projector-owned presentationState；Timeline 产生 identity、visualDigest 和 render model。renderer 不再按 Tool/Thought/Subagent 字段推导第三套 terminal。

同一 epoch 下 sealed item 不重新打开；迟到包不能修改已封口模型内容或追加第二份正文。canonical messageId 实现 live/replay 幂等，不按正文去重。两个相同文本但不同 identity 的消息必须保留两条。

Subagent step 使用稳定 stepId/toolCallId，approval 使用 interactionId、generation 与完整 owner；不按工具名、上一个 pending step 或当前块猜测归属。History 缺少已支持的旧 identity 只由 persistence-order migration reader 处理，不在 renderer 创建兼容写路径。

event-free snapshot 按同 revision 的完整 interaction queue 替换本地集合，不能与旧集合求并集。低于已接受 command revision 的 snapshot 不能结束新 Run；本地 Promise 收尾不生成伪 idle、取消或完成事件。

视图状态、Server Run、Client command 与物理 RenderEpoch 分开。正文 seal 不意味着 Run 完成；正式终态才清除活动 Run。详细流式分类见[流式展示](streaming-presentation.md)。

验证：[Timeline 收尾](../test/tui-timeline-closeout.test.ts)、[渲染](../test/tui-mock-render.test.tsx)、相关 Service projection 与 Protocol conformance tests。
