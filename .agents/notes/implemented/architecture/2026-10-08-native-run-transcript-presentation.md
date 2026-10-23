# Agent Note: 原 PC 轮次阅读沿公共事实迁入

Status: implemented

## Problem

原 Conversation 已拥有过程折叠、最终回复、工具聚合和复制交互。新 Message 完整、工具成功与 Run 完成是不同事实；大输出正文还需要原 reader 核原身份、hash 与 EOF。直接把原 UI 的 Turn 标记套到每条消息，或以封存历史去查询来源 Run 后来的状态，会误标最终回复并越过历史边界。用户已确认复用原 PC 界面，目标是接入统一调用者。

## Decision

继续使用原 SessionPage／Conversation／ToolActivity。有限正文与工具分组 slot 保原外层布局、展开控制、会话阅读状态和复制按钮；公共 Run 只生成原展示标记，不恢复旧 Runtime 或增加第二条提交链。准确 Message 所属 Run、真实终态和起止时间决定过程／最终回复；Message complete 单独不够。

2026-10-23 用户明确子 Agent 工具消息应保留原历史操作，不因子任务完成或中断从“创建”变成“完成／停止”。原工具受理与子任务生命周期本来就是不同事实：消息装饰仅保准确身份、名称和详情目标，标题来自原工具 Message，不再传递或派生子任务 status／fresh。真实工具失败、取消及未知结果仍由该工具原回执显示，准确 carrier／child-start 校验与整行详情入口保持。当前生命周期继续用于已有环境卡、停止准入和子详情，不以消息行作为第二份状态面板，也不新增缓存或持久状态。

用户引导沿现有 `inputKind:input.steer` 与准确 Run 进入原处理过程，保原 user 角色、正文及顺序；同轮补充不会再次切开过程。首条输入与最终回复仍在外。Native 的本地 steer intent 已绑定 targetRunId，发送占位沿同一展示归属等待原持久消息接管；显示归组不表示接收检查点已应用，也不表示实际 Model 已读取，来源与执行证明仍按原输入合同核实。

2026-10-23 用户实测压缩行抖动，连续几何证据捕获同轮区域约 63px 短暂收缩。压缩采用同一次 Execution 的展示 key，并从当前 View 的真实压缩 Message 补齐独立历史读取的交接；原 Message ID 和正文／动作资格保持。Core 同时在 View 首个 await 前捕获热快照，避免旧 SQL 消息与已清除 hot 的组合。逐帧检查另证实普通 refresh 清空 snapshot 后，Main／Native 按 loading 撤热行会造成约20ms缺行，随后 running／unknown 文案反复切换；同选择正常校准因此复用原 lastView 的只读热观察，真正观察／权限失败继续撤销，所有动作仍等待新资格。完整历史终态优先，下一 attempt 独立，准确实现和验证归 [Native owner](../../../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。

当前 View 的已核 Run 可直接展示；旧完整历史只以当前已观察、未封存的 Message ID 分批32项，经当前 Client GET 核 Run／Session、Store 连接和阅读scope。当前 Store 已保存的旧 Store 终态保原 originStoreId，仅用于历史展示；foreign active 不提供活动或控制。Fork／Include 的 originMessage 有固定历史边界，不读取来源 Run 后来的状态。这两个来源必须分别处理，不能用同一 foreign guard 丢掉已恢复终态或取得后来的热事实。

同一 bridge／generation／Store／Session／Workspace／viewSelection 下，新 history epoch 仍清空读取缓存并重新核原 Run；仅已核的 inactive completed／failed／cancelled 保留展示，直到新 metadata 或 View 替换、明确缺失删除。保留层不种入新读取缓存，不减少 GET；当前已核 View 同步更新本 scope 的 read entry 与 revision，避免离开有限页后被旧 metadata 覆盖。active／interrupted 不跨 epoch 延续，换展示身份不保留。这样等待完整 metadata 或32项分批期间，原 Conversation 的准确轮次与用户展开节点不被暂时拆掉；大正文完整身份、复制撤销及动作 authority 仍归原入口。

没有 outputBody 的普通 inline 正文按 generation／viewSelection／Store／Session／Message 保持组件，不随 epoch 重挂同一 Markdown；有 outputBody 保原 epoch key 和全部 reader 撤销，切换分支也重挂。共享 ModelOutputMessage 只按原八项身份 memo JSON 序列化，callbacks、suspension、原身份变更、snapshot核验及复制撤销不变。普通展示保持不能延续旧完整正文资格或文件动作，原宿主回调仍以当前已提交能力控制。

Native 完整最终回复复制只持有原 reader 当前已验证并显示的准确正文；预览 copyText=null，关闭／换身份即撤销，不写新的持久缓存。2026-10-13 资格核验归共享纯 completeRunReplies，Native 显式 final 范围仍只取完整最终回复；Web 手册的整轮范围由 Web 显式 run 选择，不把同轮工具前说明加入 Native。原 DOM 最终段精确断言保持，用此真实失败纠正了共享接线的范围回归。相邻已知 Files 探索交原组件聚合，每项保自己的 receipt／文件回调，分组不授予范围。默认 ask_user v1 只按原成功 Execution／准确结果展示已保存人类答案，唯一原 Model call 才提供问题；信息取消与停止 Run 分开。原 pending 审批提交仍沿准确卡片；原 Approval 表单和有限审批历史已由[后续审批决定](2026-10-09-native-approval-observations.md)接入，本篇的来源、轮次、复制与问答理由继续适用。

原通用问题、计划和审批的记录阅读由[后续交互历史决定](2026-10-09-native-interaction-history.md)补入；本篇的唯一来源、封存边界、轮次、复制与默认问答结果理由继续适用。

本决定部分接续[工具消息观察决定](2026-10-08-native-tool-message-observations.md)：原唯一source、结果核验、32项scope、未来版本及Shell／Job分离理由继续适用；此前未接入轮次／聚合／默认Ask历史的范围由本片更新。完整当前行为与验证归[Native owner](../../../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。

## Alternatives considered

- 继续使用整条 renderMessage 覆盖：会绕开原消息外层、分组和复制交互；改用正文与完整工具分组 slot。
- 从消息 complete、最后一条助手消息或工具成功推 Run 完成：这些事实没有等价关系；以准确公共 Run 终态核最终回复。
- 让父聊天中的创建／继续工具行跟踪子任务生命周期：会改写历史工具调用的含义；原操作保持静态，当前子任务状态沿已有环境信息和详情读取。
- 对所有 foreign Run 一律丢弃：当前 Store 已保存的终态历史也被隐藏；接纳原终态但保出处，排除 foreign active。
- 对 Fork／Include 查询来源 Run 最新状态：越过封存边界；原封存消息保历史，不补后来终态。
- 复制大正文预览或另加持久正文缓存：前者会截断，后者增加第二份持久资格；复用原完整reader和当前显示生命周期。
- 从工具请求路径给整组提供一个文件回调：请求不证明效果，分组内文件身份不同；沿每项原receipt和Main目标校验。
- 把所有同 Run 的 user 消息收入过程：会一并隐藏首条任务输入；只沿明确 steer 类别归组，不按文本或位置推断。
- 等持久引导出现才改变归组：会让已知目标的发送占位先独立出现再跳入过程；本地准确 intent 与保存后的消息共用展示归属，failed／unknown 继续保原恢复入口。
- 延时清除压缩热状态或仅修改动画：前者仍不能保证独立 history GET 已接管，并可能延续旧 attempt；后者不能解决已经观察到的行移除与高度收缩。复用同一 View 的真实轻量状态事实和稳定渲染身份，不引入第二份持久历史。

- 用旧终态种入新 epoch 的读取缓存、跳过重新 GET，或只调换合并顺序：前两者会缩短核验，后者会使新 metadata 失去优先级；展示保留与读取 scope 分开，按新已核事实及明确缺失替换。保留 active／interrupted 也会把可恢复工作误当固定历史，因此只保三种非活动终态。

## Consequences

原交互可迁入正式 Native，同时原出处、阅读和控制分别保持边界。没有新 Core／HTTP API／SQL／私有维护或 UI 持久格式。Main／正式 caller、原 DOM 与首次／冷启动 macOS 源码外窗口覆盖本片断言；DOM全文使用UI snapshot fixture，不代证真实hash／EOF门禁。当前 Store 的原交互记录已沿后续决定接入；完整自动审批窗口、全部封存／恢复组合、完整PC及整片独立审查尚未关闭，本片不提升全阶段或其他平台资格。

新 epoch 的暂时拆组已由原 DOM 文件的真实红核实；最终5pass／80断言覆盖原47断言、准确节点／展开保持、分批等待、新 View／metadata／缺失优先及换身份迟到结果。原完整历史窗口随后1pass／6Bun断言及45Node流程断言、72.004秒退出，原75秒预算未变；首次／失败／重载／切换／两次物理SSE缺口／最后真实通知均读全5051条，零Model调用，Service普通退出和双EOF完成。前述真实红保留；完整默认、整体资源和阶段退出仍须各自原证据，不由DOM或单窗口通过替代，归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。
