# Agent Note: Desktop 主会话按消息加载历史

Status: implemented

## Problem

小会话的DOM缓存改善热切换，大历史冷挂载仍可能占据主线程约一秒。较早的[完整隐藏分批构建](../../archived/architecture/2026-10-26-desktop-initial-render-staging.md)降低峰值却增加总等待：600轮dev持续更新样本约24秒，单条600章节样本曾到13–14秒。用户随后明确优先显示底部消息、上滚补历史，同时要求阈值、每条回复完整显示，并接受Ctrl/Cmd+A仅全选已加载内容。默认折叠的工具过程不应提前构造内部明细。

## Decision

只在Native主会话SessionPage的keepAlive路径启用消息窗口，其他共享调用及侧栏子详情保持默认完整展示。按现有结构分组后的entry计数：首次不超过100条完整挂载，超过100条先挂末40条，接近上下200px边界或点击边界按钮，经RAF后的task各补20条。折叠turn的工具记录不是独立entry。持续更新跨100不突然裁掉已加载历史；回到最新允许重新选末40条。该规则控制初始挂载量，不是固定长度虚拟列表或耗时承诺。

窗口状态仅存稳定entry keys和顺序，不存React树或宿主闭包。补入时捕获首个可见entry及其相对viewport偏移，提交后按同一锚点补偿，避免尾消息同步追加污染scrollHeight差值。手动阅读和正文晚到保持锚点；冷重建在保存锚点附近挂载40条并支持双向补入。旧版只有像素坐标的manual记录完整挂载一次，保其坐标系。Activity暂停／卸载／回到最新取消所属frame与task，回调另核request身份，迟到工作不接管。

每条消息仍沿完整Markdown转换和渲染链路，未加载历史不参加DOM全选。默认折叠的turn过程和ToolActivity聚合通过工厂延迟内部投影；首次展开后继续使用原Radix Presence、关闭动画和卸载，动画期间使用当前事实，不冻结旧身份。原关闭内容本已不挂载reader，本次减少冷关闭时提前构造投影及空Content的成本，不放宽权限或恢复旧permit。

主消息区换为可聚焦、具名原生滚动section，保留原跟随、选择、缓存viewport身份及嵌套工具ScrollArea。SessionPage在已有初次／resize测量中探测实际滚动条占位，正文／输入区共用该值。CodeBlock间距从外层group:has改为同一块的局部兄弟选择器，避免消息追加使整棵turn反复失效样式；Shell／Markdown原覆盖规则保留。

## Alternatives considered

1. 保留完整隐藏分批构建：用户已不接受十几秒总等待，改为先呈现最新消息；归档保留其降低峰值及完整DOM选择的理由。
2. 拆单条Markdown根块：可分摊后代挂载，但用户选择每条完整显示；移除实验分片和相关缓存阻断机制，不引入另一套正文语义。
3. 对任意长度会话窗口化：增加小会话阅读和选择边界，采用超过100可见entry才启用的阈值。
4. 固定长度回收上方DOM：会改变已加载范围的选择、展开和阅读，本轮仅按需增加窗口，保留已加载消息，跳到最新才可重选尾部。
5. 只用CSS隐藏折叠过程：原Radix已不挂载关闭内容，但宿主仍提前构造明细；工厂边界直接消除该部分工作。
6. 用scrollHeight增长恢复prepend位置：会把同时追加的尾部消息算入补偿，采用entry几何锚点。

## Consequences

小会话冷开完整展示，大会话首屏DOM随末40条复杂度增长；窗口以现有分组计数，不限制整条正文复杂度。单条巨型Markdown仍可能形成同步大任务，这是用户选择的边界，不能宣称全程无阻塞。已加载历史累计仍可能超过缓存预算；原8个非当前页、节点／文字预算、完整后台计量和reader生命周期继续适用。

成本登记改用不可变token，旧注销不能移除同resource后来的登记和owner释放责任。没有暂存blocksCache、私有Activity掩码或Markdown任务队列。消息EOF、结构事实、正文读取／复制、子会话导航及写权限仍由原Native owner负责，不因页面按需挂载跳过历史同步或恢复执行。

当前行为和受控浏览器证据分别归[产品手册](../../../../docs/handbook/clients/desktop/README.md)、[UI owner](../../../../packages/ui/README.md#原桌面展示层)及[Desktop owner](../../../../apps/desktop/README.md#大会话首次构建)。隔离NativeDesktop与固定bridge证明渲染及生命周期，不代替真实Service／SQLite、Provider、完整安装包或跨平台资格。[DOM缓存](2026-10-19-native-conversation-dom-cache.md)与[增量Markdown](2026-10-24-desktop-incremental-markdown.md)其余理由继续适用。
