# Agent Note: Native 会话的有界 DOM KeepAlive

Status: implemented

同日后续：[视觉与资源生命周期修正](../bug-fix/2026-10-19-conversation-cache-visual-resources.md)部分替代本篇初版的原生 fieldset 禁用、切换即释放图片和撤回复制展示策略。原 LRU、条数／节点预算、单一连接树、读取取消与来源隔离继续适用；当前实现以该修正和 owner 为准。

## Problem

用户明确要求会话切换具有类似 Vue KeepAlive 的效果：返回最近查看的会话时直接显示原有内容。原有消息、语法树及阅读状态缓存仍需重建消息树；只取消恢复动画不能消除这一挂载成本。无限保留所有会话及其读取又会积累正文、定时器、观察器和旧操作范围。

## Decision

- Native 在原 SessionPage 启用 [ConversationCache](../../../../packages/ui/src/desktop/ConversationCache.tsx)。每项固定一个 portal 容器和 React 树；只有当前容器接入可见文档，其余容器脱离文档。React [Activity](https://react.dev/reference/react/Activity) 在隐藏时清理 effect，在重新激活时恢复组件状态及原 DOM。没有为非当前会话新增后台订阅。
- 最多保留 3 个非当前会话，按最近使用淘汰。DOM 与登记的图片编码载荷合计估算总量最多 16MiB、20,000 节点，单项最多 8MiB、10,000 节点；超限活动会话仍完整显示，离开后释放。估算按节点、UTF-16 文本和登记资源的编码字节计算，不声称限制浏览器总 heap、完整 snapshot 或已解码媒体。淘汰后仍使用原有界阅读状态与数据缓存恢复。
- generation／Store 变化清空全部 DOM；history epoch 或已确认目录移除清理非当前项。同一活动会话在 reset 校准时仍可只读显示。新增会话不清空其他最近项。缓存身份包括准确阅读 Session，子会话仍须先经当前父范围确认，缓存不能绕过 Main 的选择准入。
- 返回已确认选择时，命中项先显示原 DOM，历史、轮次归属与工具信息在后台重新校准。缓存预览的控件由当前 gate 与事件捕获禁用，原生 fieldset disabled 的外观策略已由上述修正替代；只有当前宿主新事实恢复操作。普通同会话校准保留本地展开交互，真实读取仍有独立 gate；不把 DOM、展开状态或相同 seq 当作业务权限。
- [Native model adapter](../../../../apps/desktop/src/native-model-output-message.tsx)从 Desktop 的单一 context 向公共 reader 传显式 `readActive`。Root UI 与 Desktop 可独立构建，不依赖两个 bundle 恰巧共享内部 Context。停用时 abort 原全文读取、撤销当前复制正文通知；同一已核实身份可保留已读显示，激活后使用新回调，迟到结果不能进入新视图。显式关闭、suspended、正文身份变化和实际卸载保持原清理。
- Chrome 宽表格实测显示原节点脱离布局后横向位置仍会归零。因此停用容器记录实际嵌套 scroll，激活的 layout 阶段恢复并裁掉已移除节点；Conversation viewport 仍由原跟随／手动策略处理，不用缓存旧位置覆盖新底部。
- 图片停用仍取消未完成读取；初版切走即释放 blob URL 的策略由上述修正替代，已核验资源纳入同一 entry 的预算与回收，已经撤销的 URL 仍不得复用，校准前不能用旧 scope 读取。正文、轮次、展开与滚动组件本身保留。复制计时器、滚动 observer、键盘监听等 effect 随 Activity 停用；恢复不重播原展开动画。

这一决定只部分替代[原主子阅读生命周期](2026-10-15-native-session-reading-lifecycle.md)中的单树限制；原完整校准、读取取消、迟到隔离、纯数据预算、Worker 解析和无界保活的拒绝理由仍适用。

## Alternatives considered

1. 所有访问过的会话持续挂载：可避免重建，但正文和 effect 无界累积，仍拒绝。
2. 只用 CSS 隐藏：DOM 留下，监听、计时和读取继续运行，不能满足资源生命周期要求。
3. 克隆静态 HTML 作缓存预览：可以暂时显示正文，但丢失 React 状态和当前回调，恢复交互仍需重建，不能交付用户要求的 KeepAlive。
4. 对所有后代逐一增加手动暂停开关：容易遗漏 Radix 和未来组件的 effect。使用 Activity 统一停用，再由宿主显式 gate 当前读取与操作。
5. 让公共 reader 直接依赖 Desktop 的私有 Context：源码图可共享，独立打包后可能出现两个 Context。用 Native adapter 交付布尔 gate，保留公共 UI 的便携性。

## Consequences

命中预算内的会话复用原 DOM，后台新内容仍会正常更新。淘汰、超预算、窗口重载、generation／Store 替换及布局树重建仍可能重新挂载，不承诺任意长度、无限会话或零内存增长。数据及正文只在当前窗口内保留，不持久化 DOM，不恢复执行、审批或模型派发。

当前产品行为和证据归[桌面手册](../../../../docs/handbook/clients/desktop/README.md)、[UI owner](../../../../packages/ui/README.md)与[Native owner](../../../../apps/desktop/README.md)。
