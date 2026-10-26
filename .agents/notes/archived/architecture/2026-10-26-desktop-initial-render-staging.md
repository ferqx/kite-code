# Agent Note: Desktop 大历史的分批初始构建

Status: implemented
Archived: 2026-10-26

本篇保存本任务较早阶段的完整历史分批构建取舍，后续用户改为消息级按需加载，当前边界见[按消息加载](../../implemented/architecture/2026-10-26-desktop-progressive-history.md)。

## Problem

大量历史已在数十毫秒内读完并核完结构事实，React挂载及首次布局仍可连续占用主线程约一秒，用户输入和切走一起等待。用户明确允许保留加载画面，完整历史就绪后一次显示，优先避免界面卡死。只优化热缓存不能消除冷重建；只调低React渲染优先级也不能切开同一次DOM提交与强制布局。

## Decision

Native通过SessionPage对首次大树启用分批构建，共享默认调用和已呈现树保持原路径。沿完整messages生成的原entry投影分批连接DOM，正文保持不可见／inert及读取暂停，批间让出主线程；每批做真实布局测量以分摊首次scrollHeight成本，不把临时高度接管为阅读位置。完整且当前结构就绪后使用最新投影一次呈现，恢复原top／follow／expanded、全选和操作门禁。

暂存期间冻结已核结构的展示计划以防连续更新重启构建，完成时交接最新事实并释放旧投影／Native闭包。暂存不恢复任何业务权限；历史EOF、metadata和旧请求隔离仍由原owner负责。展示资源的blocksCache仅阻断缓存准入，阻断期不统计暂存DOM；离开时丢弃未完成树，完成后仍须新的完整成本测量才取得缓存资格。

## Alternatives considered

1. 只对历史complete回调使用transition：最后解除结构门禁的Run／Tool更新仍可同步挂树，且布局／commit成本不被分片；不作为首轮完整方案。
2. 只defer重Markdown子fiber：可以让部分React工作让步，但实测600轮渲染和commit／layout各占约半段，后半段仍会阻塞输入。
3. 只延后scrollHeight读取：首次可读画面仍需要真实布局与正确底部，不减少该工作本身，且可能暴露错误阅读位置。
4. 虚拟列表或只显示最近消息：会改变当前基于全部DOM的全选、像素阅读缓存及可见正文reader顺序。用户本轮选择完整历史就绪后一次显示，不引入这些交互变化。
5. 一次创建全部DOM后只用CSS隐藏：不能降低首次构建与布局峰值；选择连接小批DOM并主动分摊布局工作。

## Consequences

保留完整DOM与原消息归属，全选、阅读像素位置和已展开过程继续适用；以更多批次和更长总等待换取较短连续阻塞。默认阈值为至少200条消息、初始12个entry，后续按实际渲染加布局耗时调整到1–32个；不把这些值当作耗时承诺。小会话、已呈现树和未开启的共享调用保持原路径。

2026-10-26本机NativeDesktop／原CSS、隔离bridge、Message正文已就绪的Chrome155对照中，production600轮最长任务995→273ms、可信输入往返1026→276ms、切走输入排队974→18ms；完整首次可读帧1066→3169ms。dev600最长任务1120→392ms，完整可读1229→5519ms。逐帧没有露出部分历史，持续metadata／正文更新时仍完成且揭示匹配已提交输入，但高频dev更新样本耗时约24秒。当前命令、源码hash、全部数据和限制归[Native owner](../../../../apps/desktop/README.md#大会话首次构建)，不把单次对照或DOM出现当成分位数和实际绘制。

暂存节点不能提前被全选、复制、正文读取或缓存准入观察为已完成。阻断标记跨Activity暂停保持，真正owner清理时释放；同resource身份复用时旧注销不能删除新登记。完成后移除阻断仍须新完整后台计量。对应构建、成本与缓存测试入口归[UI owner](../../../../packages/ui/README.md#原桌面展示层)。

最终完整投影／揭示及单个特别复杂条目仍有同步成本，不能称为全程无阻塞。单条巨型Markdown内部pipeline与真实Main／SQLite／自动全文FIFO不由本轮纯历史渲染负载取得资格。未完成构建离开后回收，返回需要重建，不以未知加载页成本保活。

现有[DOM缓存](../../implemented/architecture/2026-10-19-native-conversation-dom-cache.md)的预算、读取隔离和单一可见容器继续适用；本篇补充未完成构建的准入阻断，不替代已完成树的成本核实。[增量Markdown](../../implemented/architecture/2026-10-24-desktop-incremental-markdown.md)的元素复用与流式语义不被替代。
