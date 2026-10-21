# Agent Note: Native 子 Agent 详情使用侧栏标签

Status: implemented

## Problem

用户要求子 Agent 详情通过侧栏 tab 打开。原页面将整个主阅读根投影切成子日志，暂停父历史和辅助读取，并隐藏输入与审批。沿用这套切换仅更换容器，会使主页面标题、草稿与当前读取仍依赖子详情，无法同时观察父工作和子结果。稳定协作者还可能有多个 carrier，仅以子 Session 识别标签会混淆任务。

## Decision

在现有 SessionTabs 增加只读子详情标签，以准确子 Session／Execution 去重，与网页和变更共享8项上限。重复打开选择已有标签；新目标超出容量时显示必要反馈。父会话保持原 readingKey、标题、正文、输入、审批和环境卡，其原有读取与操作门禁继续运行。

[NativeChildDetail](../../../../apps/desktop/src/native-child-detail.tsx)复用 Conversation、轮次／工具投影和已核实的 ModelOutput 快照。[环境 owner](../../../../apps/desktop/src/native-environment.tsx)继续拥有唯一活动子 reader 与有界已验证数据缓存。仅当前可见子标签激活该 reader；切换、关闭、收起、覆盖或换根释放读取和消息树，不停止业务任务。隐藏子标签只保存元数据、已验证数据和有界阅读状态，不保活监听或全文组件。父／子同时显示时，全选快捷键按事件目标、焦点与选区确定唯一所属阅读区。

标签归属固定稳定的 Store／父 Session；generation、history epoch 和 viewSelection 仍属于环境读取 scope，变化时释放旧读取并重新核准当前目标。两种身份不能混用，否则同一活动标签在 reset 后不会再次报告选择，可能永久停在加载。子正文保留与操作资格分开：ConversationActivityContext 接入当前父读取门禁、准确子事实及校准状态，权限丢失时保留展示但撤销复制／正文读取；仅轮次或工具元数据失败不遮住已核正文。

本决定部分替代[原主子阅读生命周期](../architecture/2026-10-15-native-session-reading-lifecycle.md)中进入子详情暂停父页与仅一个可见阅读区的选择。原准确 carrier、固定水位、完整校准、取消、迟到隔离和缓存／解析预算继续适用。[DOM KeepAlive 决定](../architecture/2026-10-19-native-conversation-dom-cache.md)的父会话缓存保留，子标签本轮使用数据和阅读状态缓存，不接入其 DOM 保活。

## Alternatives considered

1. 将旧子页面直接塞入标签而仍切换主投影：无法保留主会话标题、输入和并行读取，未采用。
2. 只按稳定子 Session 复用标签：同一协作者的新任务可能覆盖原 carrier 详情，未采用。
3. 每个已开子标签保持完整消息树和 reader：会在隐藏标签中保留大正文、解析 owner 和读取；当前一份环境观察及有界数据缓存已能支持按需重入，未采用。
4. 为子详情新建服务 API 或独立后台订阅：原环境 reader 已提供准确身份与完整正文，不需要扩大读取与协议边界。

## Consequences

父会话与当前子详情最多同时连接两棵可见消息树。子标签切换仍可能重建 DOM；已验证正文与阅读状态缓存有界，不承诺全部标签零重建。侧栏开合、网页隔离、准确停止、未知结果和真实执行不改变。当前行为与验证由[桌面手册](../../../../docs/handbook/clients/desktop/README.md)、[UI owner](../../../../packages/ui/README.md)和[Native owner](../../../../apps/desktop/README.md#native-当前会话环境信息与子详情)维护。

[标签生命周期回归](../../../../packages/ui/test/isolated/desktop-session-tabs.test.tsx)核准确去重、共享容量与活动挂载；[Native 导航回归](../../../../apps/desktop/test/isolated/native-session-navigation-dom.test.tsx)核父正文／草稿保持、并行更新、权限与代次恢复及迟到读取隔离；[全选回归](../../../../packages/ui/test/isolated/desktop-message-copy.test.tsx)核双阅读区快捷键归属。真实 Electron 流式窗口与平台限制仍以 Native owner 的实际执行记录为准。
