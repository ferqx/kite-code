# Agent Note: Native observation refresh preserves complete output

Status: implemented

## Problem

真实 macOS PC 窗口的一次兼容 Model 产生超过17MiB正文时，原10秒等待内 Core Run仍为running，稍后的只读选读才看到completed。原诊断记录两个目录各605次GET、所选View139次GET。输出按不可变片段持续持久化，每个变化驱动Main立即再次读目录；所选View的后继调度还会额外读取目录。合并这些重复读取后，原完整窗口进一步暴露重命名刷新会卸载原消息组件，从而丢失已经验证并展开的全文。

完整默认随后暴露长历史重载的另一条重复工作：Reader 在每页到达时重新发布全部消息，Main 则在后续每页再次从已证明过大的 200 条开始缩页。已有完成正文还会在末页未结束时被前缀替换；只移除逐页发布后，离开会话的内部 entries 又可把未发布前缀带入缓存。这些行为须按现有手册的完整读取、后台保正文和失败阅读契约修正，不能减少历史或放宽原窗口预算。

## Decision

[NativeCaller](../../../../apps/desktop/electron/native-caller.ts)继续使用现有独立目录与所选View读取，每条路径保留一个在途读取和一个后继通知位。读取完成后100ms内的通知合并，最后通知仍触发新的事实读取；View的后继不再重新调度目录。旧读取失去当前owner后不设置后继计时器；目录epoch失效和网络释放清理所属计时器。显式选择、准确原命令操作和慢目录之间的既有独立性保持。

reset仍先重新读取原事实和完整历史；ready高水位等于重新读取的baseline时无需再读同一观察，不确认snapshot为已应用事件游标。[Native renderer](../../../../apps/desktop/src/native.tsx)在同一选择范围刷新时保留消息组件，只在没有可展示消息或正在切换范围时使用整页历史loading。全文组件按attach generation／viewSelection／history epoch／原消息ID封存生命周期，真实范围变化仍清正文；历史loading期间仍撤除写资格。

[NativeHistory](../../../../apps/desktop/src/native-history.ts)继续逐页核固定高水位、原 Session、序号与游标，合并全部合法记录；仅在本次扫描 EOF 或实际失败时发布阅读快照。后台扫描期间展示上次已发布正文，切换缓存和同会话新 scope 复用也只取 state.messages，避免未发布前缀经切走／切回提前展示。实际失败仍发布已合法读到的前缀。Main 只在同一 generation／selection／Session／Store／highWater／readId 内保留经过原身份和 4MiB IPC 校验的有效 limit，后页仍完整 GET 及全部校验；学习值单调缩小，旧或取消读取不能回写，范围变化、关闭和新读取重置。不新增正文缓存或协议字段。

共享 [MessageContent](../../../../packages/ui/src/desktop/MessageContent.tsx)在 layout effect 更新当前已提交的宿主文件回调，稳定派发函数读取该值，内层 Markdown 只在正文或回调能力有无变化时重渲染。宿主回调引用变化不重新解析同一正文；撤销和卸载清回调，能力撤销仍改变链接展示。该优化不改变原路径判断、外链、HTML和图片规则，也不取得文件操作权限。

共享 MessageContent 在完整 Markdown 转换树中把超长普通文本组织为相邻 Text 节点，继续原 GFM、消息列和所有字符，不增元素或换行；非ASCII沿 grapheme 边界，单一长 grapheme 保完整，code／pre不拆。完整宿主 EOF／SHA／UTF-8／scope 与复制原正文仍是前置，稳定回调和能力撤销门禁不变。该决定针对实际全文到达后原尾部可见性仍超时的正文布局工作，不是传输裁剪、虚拟化或固定内存 streaming。

## Alternatives considered

- 保持每次变化立即读取：原失败已经显示大量重复GET，且所选View后继还放大目录读取；持续输出会争用正常执行与观察所需的资源。
- 只合并当前在途读取中的通知：快读取结束后紧接到达的输出变化仍可立即重开，不能覆盖实际连续片段场景。
- 放宽原窗口期限、减少正文或根据Model succeeded推断Run completed：均未采用；它们不能证明原Core轮次完成和完整用户行为。
- 每次普通历史refresh都卸载全文组件：真实重命名断言已失败；改为同范围保组件，范围变化仍清理，不建立全局全文缓存。

- 继续逐页发布全部阅读消息：末页 held 的真实语义回归已证明提前替换完成正文，也会反复处理整个已读集合；采用固定高水位的完整发布，失败仍保合法前缀。
- 只移除逐页发布但缓存内部 entries：独立审查与切换回归证明未完成前缀仍可经缓存展示；缓存只持有已发布快照。
- 每页忘记已验证 limit 后重新尝试 200 条：原完整窗口与 Main 原 adaptive 回归显示重复 oversized 工作；只复用同次范围的有限页大小，不复用回应或跳过验证。

- 在 memo 比较器中忽略文件回调变化：会保留旧 scope 闭包，不能证明使用当前权限；采用提交阶段更新的回调 ref 与稳定派发，正文 memo 仍区分能力有无。

- 单改大正文段落 width:auto或局部长词CSS：原完整窗口仍实际超时，候选逐字节撤回。
- 以 content-visibility 跳过未显示布局：尾部可见后原 `main.innerText >17MiB` 断言失败，不能证明完整正文用户能力；候选撤回，保原断言。

## Consequences

自动观察在快读取完成后最多增加100ms合并等待，不作为所有设备的延迟保证。Core片段大小、完整持久化、终态判定、Service/Client API、默认宿主Shell及原UI结构未变。原窗口的10秒UI、45秒driver与60秒整例预算及全部18条Node断言保持；完整原窗口actual0／25.70秒，读取>17MiB原正文、rename CAS、重命名后全文保留、unknown delete原GET、Provider一次与普通退出所属Service停止全部通过。直接八文件27项／199断言通过，范围和失败记录归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-大输出刷新与全文保留)。本决定不关闭macOS RSS／八轮稳定性、完整迁移或其他平台资格。

完整历史的两项快照语义回归先红后绿，原完整 reader 文件 4 项／22 条断言；Main 原完整文件 14 项／146 条断言核完整正文、真实 EOF、后页复用与新读取重置。原断言和全部页面／driver／整例期限保持，独立审查核旧 read 与并发学习边界。该次输入的原完整历史窗口仍有真实重载超时；后续终态正文保留与fresh history epoch处理后，同一原历史窗口actual0／72004ms，完整5051条、rename后已读正文和退出保持。准确原红及后续限定证据归[普通制品收束进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)，不提升为默认回归、RSS或整体迁移退出。

原完整 Markdown 文件 2 项／23 条断言通过实际 DOM 点击核最新回调、撤销及恢复、原路径解码、外链和正文更新；原 matcher 均保留，DOM 环境在 finally 恢复。独立审查核 StrictMode 与提交／卸载边界，这些源码结论不冒充专门并发运行证据。该优化当次历史窗口仍实际红，不能把重复工作减少等同原10秒重载验收；后续实际结果按上述原历史范围记录。

长文本节点实现后，原完整Model／Fork文件分别actual0／27643ms与38014ms，4251 regular输入及Git前后全等；Fork原 `main.innerText >17MiB`、全文尾部／关联与rename／unknown原查询保持，两份各六个准确所属PID正常退出confirmedtrue。原Markdown两测试逐字保留，本轮同一完整文件3pass／44断言／336ms另核组合字符和ZWJ边界；临时IPC／DOM定位观察已退役，全部原业务断言和期限、100处Model业务await及准确进程owner保全。有限phase只供原阶段捕获；进程owner的未知身份、正常残留与共享截止规则归 [Desktop owner](../../../../apps/desktop/README.md)。随后本轮未过滤完整默认actual0／1658975ms，原661文件／522唯一主任务含6exclusive全部通过，4251 regular输入与Git前后全等；同图Model全文28633ms、Fork全文40178ms及原完整历史75513ms实际通过。原RSS／八outer／全资源和整体退出保持原门禁，准确结果归[普通启动进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。
