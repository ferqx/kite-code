# Agent Note: 原 PC 轮次阅读沿公共事实迁入

Status: implemented

## Problem

原 Conversation 已拥有过程折叠、最终回复、工具聚合和复制交互。新 Message 完整、工具成功与 Run 完成是不同事实；大输出正文还需要原 reader 核原身份、hash 与 EOF。直接把原 UI 的 Turn 标记套到每条消息，或以封存历史去查询来源 Run 后来的状态，会误标最终回复并越过历史边界。用户已确认复用原 PC 界面，目标是接入统一调用者。

## Decision

继续使用原 SessionPage／Conversation／ToolActivity。有限正文与工具分组 slot 保原外层布局、展开控制、会话阅读状态和复制按钮；公共 Run 只生成原展示标记，不恢复旧 Runtime 或增加第二条提交链。准确 Message 所属 Run、真实终态和起止时间决定过程／最终回复；Message complete 单独不够。

当前 View 的已核 Run 可直接展示；旧完整历史只以当前已观察、未封存的 Message ID 分批32项，经当前 Client GET 核 Run／Session、Store 连接和阅读scope。当前 Store 已保存的旧 Store 终态保原 originStoreId，仅用于历史展示；foreign active 不提供活动或控制。Fork／Include 的 originMessage 有固定历史边界，不读取来源 Run 后来的状态。这两个来源必须分别处理，不能用同一 foreign guard 丢掉已恢复终态或取得后来的热事实。

完整回复复制只持有原 reader 当前已验证并显示的准确正文；预览 copyText=null，关闭／换身份即撤销，不写新的持久缓存。相邻已知 Files 探索交原组件聚合，每项保自己的 receipt／文件回调，分组不授予范围。默认 ask_user v1 只按原成功 Execution／准确结果展示已保存人类答案，唯一原 Model call 才提供问题；信息取消与停止 Run 分开。当前人工审批只标唯一真实 pending Interaction，提交仍沿原卡片。

本决定部分接续[工具消息观察决定](2026-10-08-native-tool-message-observations.md)：原唯一source、结果核验、32项scope、未来版本及Shell／Job分离理由继续适用；此前未接入轮次／聚合／默认Ask历史的范围由本片更新。完整当前行为与验证归[Native owner](../../../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。

## Alternatives considered

- 继续使用整条 renderMessage 覆盖：会绕开原消息外层、分组和复制交互；改用正文与完整工具分组 slot。
- 从消息 complete、最后一条助手消息或工具成功推 Run 完成：这些事实没有等价关系；以准确公共 Run 终态核最终回复。
- 对所有 foreign Run 一律丢弃：当前 Store 已保存的终态历史也被隐藏；接纳原终态但保出处，排除 foreign active。
- 对 Fork／Include 查询来源 Run 最新状态：越过封存边界；原封存消息保历史，不补后来终态。
- 复制大正文预览或另加持久正文缓存：前者会截断，后者增加第二份持久资格；复用原完整reader和当前显示生命周期。
- 从工具请求路径给整组提供一个文件回调：请求不证明效果，分组内文件身份不同；沿每项原receipt和Main目标校验。

## Consequences

原交互可迁入正式 Native，同时原出处、阅读和控制分别保持边界。没有新 Core／HTTP API／SQL／私有维护或 UI 持久格式。Main／正式 caller、原 DOM 与首次／冷启动 macOS 源码外窗口覆盖本片断言；DOM全文使用UI snapshot fixture，不代证真实hash／EOF门禁。自动审批历史、通用Interaction历史、全部封存／恢复组合、完整PC及整片独立审查尚未关闭，本片不提升全阶段或其他平台资格。
