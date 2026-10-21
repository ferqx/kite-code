# Agent Note: Native 主子会话阅读的缓存与读取生命周期

Status: implemented

## Problem

用户要求新客户端主／子 Agent 阅读能够持续显示消息，反复切换时及时释放读取，利用缓存降低延迟和资源消耗。原 Native 子详情只读一次完整快照，重新进入又下载全历史和全部 Model 正文；父历史仍在隐藏期间反复校准。主历史缓存只有条数上限，共享阅读状态无界；旧客户端的数据缓存可参考，但保留其全量重读和长 DOM 重建成本不能保证切换响应。

## Decision

- 主历史保留固定高水位完整校准。只有完整 EOF 成功才精确替换已发布快照；读取中保留原正文，失败合入合法前缀。相同序号不是内容相同的证明，缓存不能跳过校准或授予操作资格。
- 主历史缓存只持有非活动数据，采用 take 转移、12项／64MiB保守估算／16MiB单项预算。子详情独立采用相同预算，仅缓存已验证数据；每次打开先由当前父范围核准子成员，再展示缓存并完整校准。新generation清旧数据，history epoch清非活动缓存并撤销读取资格；主历史同身份的已发布活动正文按[后续 reset 阅读修正](../bug-fix/2026-10-16-native-history-reset-reading.md)仅保留只读展示，不把这段文字解释为清空当前阅读页的产品要求。其余缓存预算、全量核对和权限隔离理由继续适用。
- 活动子页复用现有全局 change 观察。环境目录与子读取分别单飞，变化合并为尾随读取，避免高频 partial 写入反复取消慢 GET。子读取仅在同一 context selection 下复用完整稳定前缀，未完成消息和 Model 正文重读；重进、显式刷新和 context 变化全量校准。原完整后台总览保持原固定快照语义。
- 增量依据是 Store 的 `persistModelPartial` 只更新尚未完成的原消息，最终执行结算将其完成；完整消息不再由该路径更新。私有游标不改变公共 API，也不成为新的读取权限。每次 Main 仍核当前父子、来源和固定上界，Renderer 仍核完整 wire EOF／SHA／UTF-8。
- 主子切换只保留一个活动消息树。隐藏父页暂停历史和辅助读取，返回重新校准；关闭、替换、失效与卸载只取消相应 GET／IPC lease，不提交任务取消。scope、nonce和Abort共同阻止迟到结果进入后来的页面。
- Main的父元数据刷新在途不撤销同selection已验证根的读取范围，避免controller暂时清空snapshot误伤child lease及Job固定H输出；Job新open仍核fresh Execution，原页不因最新输出增长扩大H。真实换根、reset或失败立即abort／撤销，迟到结果不能发布。自动元数据或显式权限刷新失败由Main主动释放environment目录、子正文和输出读取及观察，不依赖Renderer关闭；权限失效时不能用controller保留的快照重新准入。恢复须新建目录观察并全量校准当前子页，旧readId、正文缓冲和observation不复活。返回父页在layout阶段撤销旧complete资格并重开校准，正文／草稿可读而动作等待新EOF。
- 首次打开准确已核 carrier 不再等待同根后续全目录刷新。Renderer 只把上一完整同 scope 目录用于已 pin 的 Execution／child Session；Main 保留最近一个完整同根 child-only 候选，覆盖替换在途及 Main 已发布／正常关闭目录但 Renderer 尚未提交新 observation 的交接窗口，按请求 ID 选择准确观察；原 carrier、祖先、child 与完整固定水位正文仍重新核实。失败、未完成取消、reset、scope 改变及超出上一代观察撤销候选，停止及 Job 输出仍要求当前完整观察。首次无 pin 的 Session 导航继续等待唯一解析，不用缓存标题或正文授权。
- 多根change仍共用原全局SSE／ACK；全局目录修订与选中根修订分离，只由本根、已知后代或保守的新Session创建通知校准当前环境。目录索引仅路由失效，不取得读取或操作权。Controller替换选择时取消整条旧GET链，state刷新至多一个在途和一个最新后继；共享目录的child等待可独立取消，避免退役任务继续占用读取与闭包。
- 显式返回同步撤销child导航意图，再abort当前读取；自动恢复不从旧render的child推导用户仍要查看。真实窗口曾在目录提交与返回交错后重新打开子页，精确layout／passive回归在旧代码稳定复现并于修复后通过；临时权限丢失仍可保留当前未撤销意图。
- 子消息／正文按 ID 建索引，轮次运行状态一次遍历；共享阅读状态限32项／256KiB估算／512展开ID。宿主已验证的正文通过 `verifiedSnapshot` 直接交组件复核显示，避免已经下载正文却仍要求重复读取。
- 实际100轮主子往返确认约169KiB子正文每次重新解析 Markdown 会产生58–74ms长任务。因此 Desktop 固定GFM parser保留有界纯语法树（32项／8MiB总／2MiB单项，计原文本key），每次命中克隆给当前管线；不保存React、文件回调或processor，超预算正文照常完整解析。相同负载复验后切换期间长任务为零，准确测量与限制归Native owner。
- 多根16条真实流／120次切换另发现旧消息树仍累积。heap snapshot确定13棵Conversation经Document动画controller的RAF closure持有，原Radix ScrollAreaThumb卸载未结束持续RAF。消息区局部改为原生滚动viewport，保留原样式、ARIA、位置与跟随，仅拥有可清理的自有observer／单次RAF／keydown监听；不修改其他ScrollArea消费者。100轮滚动立即卸载回归证明自有资源逐次归零，真实窗口资格独立核对。
- 多根活动正文不断变化又暴露完整text缓存miss，CPU profile确定主要主线程成本来自固定micromark解析。因此Native对大Model正文在验证后、发布前用静态Worker准备完整纯语法树；主线程仍原安全后处理。调度单active／8pending／16MiB排队源文本，准确id／text与signal取消，不改业务权限。每批display owner在替换／关闭时释放树和单一监听，稳定snapshot按owner身份清理；inactive数据缓存不强持超预算AST，合法多正文顺序准备，缓存重进也走此边界。

## Alternatives considered

1. 每次 change 都取消并重读完整子日志：实现简单，但持续输出可能令读取永远追不上修订，并重复解析已完成正文，未采用。
2. 仅凭 nextSeq 不变跳过完整校准：partial 能在原序号更新，且完整校准还需发现内容替换和消失记录，未采用。
3. 为每个曾打开会话保活 React DOM 或独立订阅：可减少重建，但会同时保留大正文、effect和观察，违背有界资源与单活动阅读目标，未采用。
4. 将所有 child 读取改为同一种增量协议：会改变后台总览的完整固定快照保证，未采用；只有当前环境子页明确选择增量，旧消费者保持原语义。
5. 只缓存消息数据并接受每次重建时的解析成本：实测仍会每次阻塞主线程，不能满足此次切换目标；复用固定语法数据比保活隐藏DOM更符合资源边界。
6. 修改node_modules或全局拦截RAF来兜底第三方thumb：会扩大到所有调用者且不能由消息区拥有其生命周期，未采用。局部原生viewport已有同主题细滚动条，可保留现有消息阅读操作并直接去除已证持有路径。
7. 用Promise／延迟任务运行同一完整parser：只是推迟主线程阻塞，不能处理CPU profile证实的约60ms长任务，未采用。逐段猜测稳定Markdown也不能保完整GFM语义，后置定义可影响前文；固定完整parser由纯计算Worker承担，取异步准备延迟与双批短时内存的代价。

8. 即使 carrier 已核实仍让首次 child 读取等待后续全目录：会把准确目标的只读首屏绑到无关目录工作，实际 held-directory 回归复现无法开始读取；未采用。直接放开所有旧观察也未采用：旧停止和输出入口须维持原观察门禁，只保留上一份同根完整观察供 child 读取交接，且始终沿两次准确后端绑定重新准入；在成功 publication 时立即撤销会误拒 Renderer 尚未提交新观察的原点击。

## Consequences

缓存预算约束可保留的展示载荷，不是进程 heap／RSS 上限；活动超长历史仍可完整读取，Model 完整快照与 IPC wire 在传输期间仍会产生整块内存。只保留当前消息树意味着极长历史仍有挂载成本，不能仅凭单元测试承诺任意长度会话零阻塞或绝对无泄漏。

现行产品行为与验证入口由 [Native owner](../../../../apps/desktop/README.md#native-当前会话环境信息与子详情)和[桌面手册](../../../../docs/handbook/clients/desktop/README.md)维护。旧客户端[主子历史缓存决定](../feature/2026-09-29-desktop-child-session-history-cache.md)的数据与权限分离理由仍适用于其自身路径；本决定限定新 Native 的读取实现，不将旧客户端资格迁移为新客户端证据。
