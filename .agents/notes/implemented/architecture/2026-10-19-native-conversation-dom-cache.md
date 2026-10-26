# Agent Note: Native 会话的有界 DOM KeepAlive

Status: implemented

同日后续：[视觉与资源生命周期修正](../bug-fix/2026-10-19-conversation-cache-visual-resources.md)部分替代本篇初版的原生 fieldset 禁用、切换即释放图片和撤回复制展示策略。原 LRU、条数／节点预算、单一连接树、读取取消与来源隔离继续适用；当前实现以该修正和 owner 为准。

## Problem

用户明确要求会话切换具有类似 Vue KeepAlive 的效果：返回最近查看的会话时直接显示原有内容。原有消息、语法树及阅读状态缓存仍需重建消息树；只取消恢复动画不能消除这一挂载成本。无限保留所有会话及其读取又会积累正文、定时器、观察器和旧操作范围。

## Decision

- Native 在原 SessionPage 启用 [ConversationCache](../../../../packages/ui/src/desktop/ConversationCache.tsx)。每项固定一个 portal 容器和 React 树；只有当前容器接入可见文档，其余容器脱离文档。React [Activity](https://react.dev/reference/react/Activity) 在隐藏时清理 effect，在重新激活时恢复组件状态及原 DOM。没有为非当前会话新增Service读取或执行订阅；缓存owner保留有界DOM成本观察。
- 最多保留 8 个非当前会话，按最近使用淘汰。DOM 与登记的图片编码载荷合计估算总量最多 16MiB、20,000 节点，单项最多 8MiB、10,000 节点；超限活动会话仍完整显示，离开后释放。估算按节点、UTF-16 文本和登记资源的编码字节计算，不声称限制浏览器总 heap、完整 snapshot 或已解码媒体。淘汰后仍使用原有界阅读状态与数据缓存恢复。
- DOM成本由独立owner在后台任务每片至多统计1024节点，真实结构／文字变化才失效，媒体登记／移除同步记账；准入前排空未投递Mutation记录并核同一revision。只有完整已统计的等成本叶文字替换可以复用成本；扫描期间任何结构变化都重启，避免TreeWalker的当前节点脱离后错误提前EOF。切换与layout不扫描DOM，未计量／已失效或超预算条目退出时释放DOM，消息与阅读状态继续由原宿主管理。
- 私有CacheHost先于所有portal sibling提交，在后代layout恢复之前接入原容器；不再通过attached状态制造第二次可见恢复。普通根会话跨目标导航让出一次RAF后task的绘制机会，再启动Main激活，防止即时新事实链在首帧前重复提交；同会话、首条投递和child不延后，等待后重核原读身份并保持窗口隐藏／deadline收束。
- 目录投影按窗口复用未变对象；Sidebar的空间／标题／会话行分层memo，选中变化只更新旧、新两行。SessionPage薄入口保留原标签页scope重置，页面内容位置和browser／child清理不变；失效的模型ready回调不再更新离开的选择。消息分组与纯复制view仅复用原展示投影，公开ActivityContext及resume语义保持，实际读取资格、文本、writer和宿主回调变化仍更新。
- 环境暂停从已提交raw版本派生busy，不再为暂停镜像状态触发第二次整页提交；恢复后在新read接管前继续拒绝旧事实操作。暂停标记同时封存旧read身份，旧成功／错误／排队刷新不能接管，新raw版本提交后释放标记引用；不依靠保留DOM、缓存状态或相同scope恢复权限。
- generation／Store 变化清空全部 DOM；history epoch 或已确认目录移除清理非当前项。同一活动会话在 reset 校准时仍可只读显示。新增会话不清空其他最近项。缓存身份包括准确阅读 Session，子会话仍须先经当前父范围确认，缓存不能绕过 Main 的选择准入。
- 当前可用目录中已确认存在的普通根会话，在点击时即按准确 Store／Session 恢复命中项的原 DOM，不等待 Main 完成选择确认；无命中时显示加载，不把旧正文放在目标标题下。子会话仍先完成父范围和选择准入。历史、轮次归属与工具信息在后台重新校准。缓存预览的控件由当前 gate 与事件捕获禁用，原生 fieldset disabled 的外观策略已由上述修正替代；只有当前宿主新事实恢复操作。普通同会话校准保留本地展开交互，真实读取仍有独立 gate；不把 DOM、展开状态或相同 seq 当作业务权限。
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
6. 等 Main 完整激活后再恢复缓存页：原节点虽保留，选择等待仍阻塞首次显示，短会话也会迟滞。2026-10-26改为目录内普通根会话的展示身份先接管，真实选择、读取和写入资格继续独立核实；首条占位也必须核当前目标，避免在后来目标下显示旧输入。
7. 切走时同步扫描或按未知旧成本保留DOM：前者占据绘制前主线程，后者破坏预算。选择活动展示后的版本化后台统计，只有已核实成本准入；允许未准备完成的条目回退原数据和阅读状态。
8. 用useInsertionEffect或先恢复后代再连接容器来消除第二次提交：前者依赖不适合该职责的阶段，后者会在脱离文档时恢复滚动。选择前置CacheHost sibling，以真实layout连接性与阅读位置回归核对。

9. 为减少恢复更新而修改公开ActivityContext的resume语义，或冻结读取／复制资格：现有消费者依赖原语义，拒绝。通过私有纯投影memo和精确text／writer回调依赖削减展示构造，原回调撤销、attempt隔离和effect清理继续执行。

## Consequences

[主会话按消息加载](2026-10-26-desktop-progressive-history.md)在超过100个可见entry时只初挂末40条，上滚补入；成本仍按实际保留树完整计量，预算和读取隔离不变。同resource重新登记采用不可变token，旧注销不能移除新登记或缓存owner释放责任。

命中预算内的会话复用原 DOM，后台新内容仍会正常更新。未完成成本准备、真实内容变化后尚未重新计量、淘汰、超预算、窗口重载、generation／Store 替换及布局树重建仍可能重新挂载，不承诺任意长度、无限会话或零内存增长。数据及正文只在当前窗口内保留，不持久化 DOM，不恢复执行、审批或模型派发。

当前产品行为和证据归[桌面手册](../../../../docs/handbook/clients/desktop/README.md)、[UI owner](../../../../packages/ui/README.md)与[Native owner](../../../../apps/desktop/README.md)。
