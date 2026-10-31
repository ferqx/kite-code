# Agent Note: Native 浏览器由原生视图拥有可视边界

Status: proposed

## Problem

普通窗口缩放使浏览器呈现不断进入主动 hide、旧 PNG 衔接、两次 Root witness 后再显示。连续 proposal 会延长旧 viewport／黑空阶段。保留页面身份与最终恢复并不证明中间画面正确。直接提前移动 Native 则可能覆盖仍按旧布局显示的聊天。

用户于2026-10-31重新提出缩小闪烁，并明确同意继续此前暂缓的呈现结构调整。浏览器工具、原页面／incarnation、租约、任务与进程生命周期边界仍适用；不增加 Agent Loop 或工具版本。

## Proposal

Main 以统一布局批次拥有聊天 Root、右侧 Chrome 条带、网页和输入屏障的真实边界。普通 browser-live 不使用旧网页图像替身，也不通过隐藏真实页来等待 Root 帧。

原 Root 保唯一 tab model、权限／observer、草稿、注释与业务 handlers。右侧独立 Renderer 只收有限展示快照并返回白名单 UI 事件，不取得 NativeBridge、Service caller、执行代码或通用 CDP。普通 browser-live 使用该宿主；非浏览器 reader、起始页、注释、全局覆盖状态恢复原 Root 完整展示，保留原网页。

Root 必须使用自身的原生物理边界；普通父 View 与正半径 clipPath 在本机没有裁剪 WebContentsView 子项，不能据图层树或数学 bounds 假定物理裁剪。保留完整逻辑窗口宽度的候选使用 Main 独占的固定 UI viewport 设置，需先实测其实际尺寸、字体、坐标与命中。它不作为代理能力，不进入 browser_execute、页面 registry 或 Service 工具端口。若不成立，需重新评估逻辑布局，而非放宽目标／输入门禁。

## 统一尺寸提交（本节已实施，整体视觉资格未完成）

用户在只读审查后确认实施：保留窗口事件与Renderer真实量测两种输入，由原Browser controller持有唯一的最终几何计算和差分应用入口。窗口事件立即使旧坐标失效，再合并投影更新；同步量测仍核原scope／revision并按原回执要求进入相同入口。相同输出跳过原生属性写入，实际不同的校准可以再次应用，不能强求一次拖动只执行一次。

Chrome host撤除独立resize调度，layout不再顺带请求Root viewport。Root CDP仍由原host拥有，启动／释放／文档或连接代次变化与普通缩放统一按desired／inflight／applied比较，成功才记录已应用；A已应用、B在途、最新又为A时必须最终恢复A。同值命令省略不能省首次prepared／绑定确认。业务状态、地址输入echo、witness／ACK、准确目标和权限核对不按矩形相同跳过。

本次保留同步IPC、首次与兼容路径的两步witness，以及Root启动／非托管窗口职责；隐藏／关闭／切scope使旧任务失效。复用现有布局状态和队列，不新增通用布局框架或协议版本。统一Main写入只说明命令组织，不能当作系统画面同帧提交保证。验收分别核同值去重、有效校准、A→B→A、晚到任务不复活、启动与真实缩窗；不以减少调用宣称灰带已消除。

本节已按上述边界接入并完成135项1697断言、类型／格式与边界核对。冻结组件实机保受控页及公开HTTPS原文档，007私有计数为77次metrics、相邻同参0、同值bounds写0，模型账本仍504；真实开发启动正常。007恢复扩窗的process PTS3.425000和display PTS3.466667仍见窗口内窄深灰带，因此本节去重完成不改变整篇proposed状态或整体无闪烁未通过事实。原始失败、过程与资格完整归Desktop owner。

## 本轮范围与收尾

2026-10-31用户在两项原生候选验证后明确选择“先保留当前实现，明确保留缩放缺口”。当前已接入的原生分栏及统一尺寸提交／去重保持，不继续引擎补丁、结构试验或重复实机；失败候选不接入普通客户端。此决定仅结束本轮实施与调查，未将缩窗空带／闪烁判为通过，也未降低原产品预期。整体Note继续proposed，保留已实施部分、未取得资格和原反例；文档收尾复用未变源码的既有验证，不新增模型或客户端。

## Alternatives considered

- 保持旧 PNG 衔接：已有真实过程证实旧宽正文、暗空与最终恢复；无法满足连续缩小。
- 仅删除 hide 或放宽 same-geometry retain：大缩窗可只剩窄条真实页；提前按新 anchor 移动则能覆盖旧聊天。
- 裁剪旧新槽交集：大变化可能为空，不能保证原页持续可见。
- 超尺寸 Root 放在父 View 中：本机 plain 与 radius1 均出现 Root 洋红区覆盖真实网页；可信点击亦命中越界 Root。私有材料保留于 `.cache/browser-native-clip-probe-20261031`，不算产品资格。
- 将全部混合 reader／编辑器都迁入新 Renderer：现有 ReactNode、草稿、注释和业务所有权不能安全直接序列化，超出所需范围。
- 仅把边界计算移入原生LayoutManager：固定Electron44.3.0虽未在当前类型／API文档声明`setLayout`，源码导出及实际二进制均支持；隔离三个WebContentsView原型已由该回调独占几何应用。真实缩小仍露出窗口内13图像像素宽的品红底色，窗口和桌面原帧共同确认，故不将它接入普通产品当作消除闪烁的修复。原页保留及回调先于JS resize不构成所有surface同帧提交证据；完整过程归Desktop owner。
- 只恢复Chromium原生外窗等待入口：固定版本AsyncLiveResize默认关闭，Electron未转发相应父类；私有delegate转发与feature组合已实测74次进入等待分支。窗口和真实桌面源仍有内部品红带，故不采用默认关闭的feature或私有运行时注入作为产品修复。等待父Widget compositor帧也不等于所有网页surface新内容与外窗同刻提交；当前源码还不能将默认配置问题定因为缺失super或永久live-resize状态。后续引擎补丁可能影响构建、签名和升级维护，需要明确扩大实施范围，不能由本轮失败原型默认为正式依赖。

## Acceptance criteria

- 在既有分栏仍展开的 browser-live 槽内，连续小缩窗、大缩窗及来回缩放保持真实页面 live；聊天、Chrome 与网页各自受实际边界限制，无旧截图替换、黑空或覆盖聊天。沿用既有空间不足时的分栏折叠语义，不能以“始终可见”夹具断言改写该行为；折叠不销毁原页面。
- 保留 pageId、incarnation、WebContents、navigation、documentId、timeOrigin、表单与阅读位置；不导航、重开、存储恢复或重放业务动作。
- Root 与独立 Chrome 的 tab、导航、菜单、控制按钮、地址输入／IME、焦点、Escape、splitter 和全局覆盖互斥正确；只有一套业务 handlers／observer。
- 新宿主无 Service／Agent 执行入口；旧 scope、迟到事件、重复序号与未知派发不重放；原截图坐标与元素引用照常按变化失效。
- 冻结实际生产制品后记录真实 OS 缩放过程，区分原型、受控 HTTPS／公开 HTTPS 与完整客户端资格，保留所有失败及未覆盖项。

## Risks

独立原生视图不构成跨 Renderer 的原子事务；正确性依赖各自真实物理边界。逻辑 viewport 与物理 bounds 的关系必须实测，不能仅信 innerWidth。Root modal、混合 tab、注释与焦点还原属于必须验证的状态切换。受限 preload、构建资产、关闭清理、缩放／DPR和 Main／Renderer 生命周期需按实际边界接入。

## 启动边界

本轮曾让隐藏Root的`capturePage`成功后才允许窗口启动。真实`desktop:dev`实证其会抛`Current display surface not available for capture`并退化成`native_startup_failed`，该前提已撤除。BaseWindow／WebContentsView的实际loadURL或loadFile成功才允许Main显示，加载失败、窗口关闭和后继加载替代仍拒绝；加载完成不伪装为`ready-to-show`绘制证明。真实隔离开发启动已输出Service ready、显示并保持Root界面后正常退出；该有限回归不证明缩窗过程修好。

## Native resize phase evidence

首次生产组合实机发现初次宿主错误依赖绘制后的scope，已改用页面本身的Store／Session归属；页面归属不等待首次绘制。scope、导航及Root新绑定仍各自核实。后继冻结组合实际保留原页、表单与固定阅读段落；scrollY随网页重排改变，但同段落viewport top保持，不能只要求数值scrollY恒定。

`attempt-002`窗口源及`attempt-004-native-display`受纯色隔离背景保护的真实桌面源，都观察到窗口内部右灰带。后者为真实系统边缘拖拽；网页／Chrome右界先于外窗边界约一帧，排除了仅窗口录制源伪影的解释。两轮失败和未执行的步骤保留在 `.cache/browser-recheck-20261030/ordinary-dev/observations/native-layout-20261031`，不授无闪烁资格。

[固定Electron delegate](https://github.com/electron/electron/blob/v44.3.0/shell/browser/ui/cocoa/electron_ns_window_delegate.mm#L203-L206)在原生windowDidResize内、super之后直接通知JavaScript resize。当前候选将Root／Chrome／page与UI viewport的实际更新合并到原生回调后的同一Main批次，事件内先废弃旧坐标依据和Chrome动作；它只改变布局执行phase，不使用延时常量、截图衔接或越界overscan。该phase已由冻结`app-005-post-native`及`attempt-005-native-display`否定其消除闪烁的结论：原页、表单、阅读段落与header拖窗通过，但真实桌面帧73（PTS1.825秒）和95（PTS2.233333秒）仍见窗口内部右灰带。后置JS批次不是CA／WindowServer原子提交保证；不能将调度延后作为已完成修复。当前候选保留未交付状态，停止等价实机重跑，不能据定向测试、正常退出或最终截图将本Note标记implemented。
