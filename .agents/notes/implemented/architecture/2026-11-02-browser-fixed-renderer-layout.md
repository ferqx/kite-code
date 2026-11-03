# Agent Note: 浏览器固定 Renderer 界面与 Main 原网页布局

Status: implemented

## Problem

浏览器空标签、加载、稳定网页与关闭返回主界面曾分属 Root 和独立 Chrome Renderer。Main 为防原生网页遮住聊天，把 Root 的物理区域裁到左栏，又用独占 CDP metrics 让其按完整窗口逻辑尺寸排版。因此一次布局涉及不同宿主、逻辑与物理尺寸、Root witness、Chrome ACK 和准备／返回交接。原页保持及最终 bounds 正确，均不能证明工具栏、中间 loading 或系统缩放过程没有灰空、闪回和遮挡。

用户于2026-11-02确认以 VS Code 的实际实现为主要参照，收敛浏览器布局与呈现，不扩展 Agent Loop、工具、权限或协议版本。原页面身份、控制租约和观察／输入安全不能因删除展示补偿而放宽。完整实施步骤与验收归[固定 Renderer 方案](../../../../docs/plans/2026-11-02-browser-renderer-layout.md)，实际交付与证据归[Desktop owner](../../../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。

## Decision

此状态只对应已落地的结构与身份边界决定。本轮完整视觉体验验收仍受阻：冻结制品有瞬时空底、残片及内部灰带，不能把实现或数据回归通过写成全过程通过。具体当前证据及未完成工作归 Desktop owner，实施计划继续保留。

Root 持续拥有同一套标签栏、地址栏、空标签、loading 和错误界面；Main 持有真实网页 WebContentsView 的创建、准确身份、位置、显隐及销毁。Root 保持完整窗口原生尺寸，不再物理裁左、逻辑排全窗。Renderer 统一量测网页与 panel layout；Main 的窗口 resize 投影和 Renderer 校准沿同一几何计算及原生属性写入入口，核当前 owner、revision、Root frame 和窗口几何。正常 resize 不隐藏网页。

同一窗口宽度的校准依据实际量测的 panel 分配，不重新施加动画终态的 min/max；只有预测不同窗口宽度时才应用目标约束。左栏收起时目标已为零，而 DOM 仍有合法中间宽度，混用两者会使 Renderer 延后发布、Main 拒绝准入。校准仍从各层 panel 与 inset 重建网页矩形并核一致性，不直接信任传入 bounds；原生缩放约束和身份门禁保持。

首次显示与隐藏后的恢复在当前 Renderer 布局调用栈同步提交；祖先分栏的既有宽度动画期间，也从 ResizeObserver 在 Root 绘制前同步放置当前矩形，避免异步消息使网页迟一帧。稳定正向校准继续单个异步在途、完成后重读最新 DOM。动画同步放置退休旧异步校准的回调资格，并沿同一 revision 防止旧请求覆盖；同值不重发，动画或拖拽结束恢复异步。046 的连续画面证实全部正向异步会在切 A 时产生一帧内部暗空，不能被原文档和最终截图断言覆盖。撤下仍同步推进 revision，迟到正向不能恢复旧展示；不恢复 UI 绘制 ACK、witness 或截图交接。同步准入不构成跨 surface 同帧提交保证，像素过程必须另核。

Windows拖拽的可见边缘进一步交给Main：两个普通View只画侧栏内的分隔线和active拖拽把手，与准确原Page沿同一几何入口提交；Root仍保完整工具栏、真实DOM分隔线、键盘与可访问性。有界主题RGBA与布局数据不授页面或控制权限，旧layout和非Windows不要求原生装饰。静止hover／focus保留DOM把手，原生把手仅在Root已捕获的active拖拽期间显示，避免其参与命中阻断下一次操作；结束及所属展示退休即撤下。此处只替代Windows边缘的绘制归属，原文档、页面隔离、Root完整bounds及其余结构决定继续适用。具体过程证据归Desktop owner，不据此宣称整个Root与Page所有像素跨surface原子提交。

网络加载失败由Root呈现浏览器式错误页，按用户最终参考图展示主机、可读建议、单行原生错误名与显式重新加载。当前Electron的默认错误文档为空，直接放行不能提供参考图的交互，因此不采用空错误文档作为正常显示路径。错误页不进入原生网页文档，也不增加或替换WebContents；原失败历史、网页身份与正常首帧门保持。Main只传有限分类与格式核验的错误名，不传日志；导航／Agent文档失败仍为失败，重试沿当前页面和原控制门禁，证书检查不放宽。此处只明确网络失败的Root展示归属，固定Renderer、真实原页及其余安全边界继续适用。具体实现与证据归[Desktop错误页owner](../../../../apps/desktop/README.md#浏览器加载失败页2026-11-03)。

同一 owner 的量测 effect 不因 visible／pageToken 更新而先 cleanup 撤页。失选页的 null 在同次 React 提交末尾合并，准确目标同步成功后退休待发旧 null；Main 先放置目标再撤来源，缺失页的正向请求明确拒绝。真正 owner 替换、卸载、覆盖仍立即撤下。这样消除的是应用主动制造的两个独立原生可见性事务，不声称 Root 与网页已跨 surface 原子提交；053及055的有限连续画面未再捕获052切页空档。

父窗隐藏由 Main 退休 live 展示及旧截图 basis，准确可绘制 child 自身保留原生可见性。隐藏 Renderer 仍用新 token 维护当前意图，正向不能授 live 呈现，真实切页／收栏／覆盖／卸载的 null 能退休它。show／showInactive 前仅消费隐藏期间新确认且对象、文档、Root、scope、Host 导航和几何仍准确的意图，先放当前控制 shield，再显示父窗；同步维护采用记录，Root 立即重载也恢复实际最后目标。minimize及未消费前置的system show仍撤下，迟到窗口通知先核真实当前状态。这份意图不保存旧观察 freshness、lease 或 Run，也不靠 URL／last selected ID 猜原页。055证明正确前置绑定仍有整窗材质空底，保 child 并不等于像素已显示。

本轮已移除独立 Chrome WebContentsView、preload、renderer、展示数据桥和远程 UI 动作 ACK，以及 Root CDP metrics、仅服务展示交接的 witness／nonce、关闭画布、普通切页与恢复截图或准备缓存。不保留两套等价展示或新增公开切换开关；这不退役真实网页 CDP、文档可绘制门、模型截图 freshness、真正 Agent observer 路径的注释冻结证明、控制租约和输入屏障。

实际 consumer 核对确认 `captureBrowserPresentation`／`capturePresentation` 与 `presentationKey` 一次性提交没有生产调用者，属于旧显示截图交接 API，随本轮删除，不作为伪注释接口保留。真正注释由 AgentBrowserPanel 的 observer `capture` 经 PageHost 与准确原页 port 独立读取有限画面；模型截图也有自己的 captureId、导航、viewport／滚动及控制基准。两者的安全检查继续保留，不由显示 ready 或首文档内部帧授予资格。

空标签只由 Root 绘制。首次输入 HTTPS 后，Root 保持原工具栏和 loading；Main 创建准确 ID 的隐藏页，等待真实主文档提交及 DOM ready，再把当前尺寸网页放到完整 Root 下方绘制。Root 的不透明网页区域持续盖住尚未就绪的真实页。Main 以 beginFrameSubscription(false) 与 invalidate 接收当前文档完整原生帧，核页面对象、incarnation、主 frame、文档代次、几何和准备序号后，才升到 Root 上方。文档等待与帧订阅均有期限，失败保留可读状态和明确停止／刷新入口。订阅不复制或缓存截图，不成为替身、模型观察或输入许可。已可绘制原文档在切页、侧栏开合、会话返回及窗口重开时复用；不为这些展示变化重复导航或刷新。

045 冻结运行实际发现：隐藏新页即使 DOM ready，也没有 capturePage 可复制的原生 surface。Electron 44.3.0 在增加 capturer 之前即拒绝复制，不能通过改 stayHidden 或延时重试取得可靠资格。既有 BaseWindow＋显式 Root WebContentsView 工厂扩到所有平台，使首文档可经公开 View API 在 Root 下方绘制。BrowserWindow 隐式主视图是 contentView 前面的 sibling，无法插到它下面，已归属窗口的 WebContents 也不能 adopt 到新 View。仍保留平台菜单、标题栏、材质及托盘分支；当前 UI 不消费 BrowserWindow 独有的 WCO Renderer 环境通知，Windows／Linux 实机资格并未因此取得。Root 和 Page 仍由各自应用 owner 明确关闭。

上述前提见固定 Electron 44.3.0 的 [capturePage surface 检查](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents.cc#L3768)、[BrowserWindow 主视图层序](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_browser_window.cc#L81)与[已有 owner 的 adopt 拒绝](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents_view.cc#L210)。平台菜单按 [BaseWindow 与实际 focused WebContents](https://github.com/electron/electron/blob/v44.3.0/lib/browser/api/menu.ts#L82)路由；不能从 BrowserWindow.getAllWindows／getFocusedWindow 的类过滤结果推断组合窗口不存在。

稳定浏览器层序为完整 Root ＜ 当前网页 ＜ 受控输入屏障，工具栏与网页外区域始终由 Root 负责。DOM 的 CSS z-index 无法跨原生网页层。此处最初采用通用 DOM 弹层相交／aria-hidden／inert 扫描后撤下网页，用户随后明确撤销该策略，相关扫描和视觉误判已删除；真实 hidden／display／opacity、页面与 owner 退休、设置整页替换和明确冻结注释继续按原生命周期处理。全局确认现由[专用浮层决定](2026-11-02-native-global-dialog-layer.md)部分替代：独立应用 WebContentsView 位于网页和输入屏障之上，自绘共享 Dialog 与透明遮罩，网页不因确认框撤下。普通下拉覆盖不在此迁移范围；原生菜单仍由系统呈现。不引入网页截图、Root 裁剪或浏览器绘制握手。

页面、展示绑定、任务／Run 与控制租约各自结束。切标签、会话、收起、后台及 Cmd+W 隐藏只撤展示，不销毁或刷新准确原网页；真正关闭标签才销毁页面。Renderer 重载先收 Main 已有页面清单，以准确 ID、incarnation 和目标对象恢复，不能凭 URL 或当前选中项猜测。旧 scope、页面、布局与迟到回调不能恢复旧展示、误删继任者或操作其他页。Main 重启无法保留其原 WebContents 文档；取消、输入互斥、未知结果不重放及普通工具失败交回原 Loop 保持。

## 与既有决定的关系

本方案部分替代[原生可视边界 Note](../../proposed/architecture/2026-10-31-native-browser-native-layout.md)中的独立 Chrome 展示、Root 物理裁剪与全窗 CDP 逻辑尺寸、对应 Root／Chrome 呈现握手，以及它们衍生的普通切页、首导航和返回补偿。旧 Note 的准确身份与取消、页面／展示／控制生命周期分离、真实页面帧与输入证明、统一 Main 几何 owner、失败候选及历史像素证据继续适用；其中灰带和跨平台／发行资格不能由结构迁移自动改判。

[最初浏览器隔离决定](../../implemented/architecture/2026-10-20-sidebar-browser-isolation.md)仍解释 Main 原生页与应用权限隔离、响应式标签保活、reader 读取取消及主题不改站点等取舍；其最初“切会话／Root 重载即销毁”的页面生命周期已被后续准确原页保留所替代，本方案继续维持原页与展示解绑，不恢复该旧策略。

## Alternatives considered

- 保留独立 Chrome，只继续补颜色、Root metrics、witness 和恢复交接：仍要让两套 UI 与不同物理／逻辑边界互相追赶，无法消除本次针对的因果链。
- 直接复制 VS Code 全部显隐、截图和关闭策略：其首开只按 URL／error／layout 显示，没有独立 first-paint 证明；Kite 的 Cmd+W 又是隐藏，不能复制所属窗口关闭即销毁。每秒截图和截图重试也不作为 Kite 的显示保证。
- 弹层复用截图：须另外准确绑定原页、几何、期限、取消及用途；借用真正 observer 的冻结注释会扩大其展示语义和草稿路径。旧显示截图 API 没有生产 consumer，不能以“保留注释”的理由续存。最初曾选择暂隐真实页并露应用底色；该通用策略后被用户撤销，现采用专用应用浮层，不引入此缓存。
- Windows只请求新Root LocalSurfaceId或过滤旧surface激活：隔离同版本引擎对照仍捕获错位，Root能在父帧参考更新前通过旧surface绘制新布局；这些诊断未接入普通客户端，最终采用原生边缘归属，不扩展引擎发布链。
- 始终显示原生把手：实际鼠标第一轮后第二次拖拽被其命中阻断。最终只在Root捕获后的active拖拽期间绘制，把空闲交互留给原DOM。细条也不调用通用View圆角裁剪，实测会把小于32px的装饰裁空。
- 直接展示Electron默认网络错误文档：原版44.3.0实测只有空白chrome-error文档。用户最终选择带说明与重试的参考样式，因此由Root呈现错误页；不向失败网页注入应用HTML，也不把它改导航到data页，以保留原身份、历史和权限隔离。
- 只把 DOM 弹层 z-index 调高：无法盖住更上层的 WebContentsView，不能解决原生层序。
- 进入 Electron／Chromium 引擎补丁：最初应用层授权不含此范围，不能代替先消除双重尺寸与 UI owner 交接。用户随后于2026-11-02明确授权在隔离副本中诊断和试验固定 Electron44.3.0 的 macOS 合成补丁；当时普通客户端依赖、工具／协议版本及发布状态保持不变，实验尚未接入产品；随后用户明确要求合并，当前固定44.3.0 arm64的配套修正已按[resize决定](../bug-fix/2026-11-02-macos-electron-resize.md)接入新开发应用和Native候选。此处仅该阶段边界被部分替代，固定Renderer结构与页面／控制约束继续适用，版本和发布资格不变。
- 关闭后台节流以解决重开空底：056只改私有Page策略，057再改准确Root，均未消除实际空底，未接产品。Root关闭还会令Page Visibility保持visible，不能丢掉真实窗口观察门；固定VS Code只对特定Agents／Sessions窗口关闭，普通Root并非一律关闭。
- 单次读取隐藏Root暖起合成：058在默认策略下准确取得完整原Root帧，图片仅存证据、不进UI；其后Window首可见仍空底。这不是经过验证的恢复机制，不进入普通显示路径。

主要源码参考固定于 microsoft/vscode `1306698e328e5e531f5e632301d30020aa994eff`：[BrowserEditor](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/contrib/browserView/electron-browser/browserEditor.ts)与其 navigation／welcome／WebContentsView feature 保固定 Renderer UI、单一 DOM 几何；[WebContentsViewHost](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/contrib/browserView/electron-browser/webContentsViewHost.ts)和[OverlayManager](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/contrib/browserView/electron-browser/overlayManager.ts)解释 overlap、隐藏与截图补偿；[Workbench service](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/contrib/browserView/electron-browser/browserViewWorkbenchService.ts)及[Main view](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/platform/browserView/electron-main/browserView.ts)解释清单恢复、准确 ID、几何和网页寿命。其截图发起后下一 rAF 复查隐藏，不等待本次图片；这是视觉补偿，不能视为跨视图同帧提交或本机性能验收。

## Consequences

先完成源码、定向失败回归、类型、格式和适用边界，再冻结最新制品。沿用现有隔离 Profile 与无凭据 HTTPS 页，验收期间不改源码，不清理旧失败与验收材料，不增加用户客户端、模型任务或认证数据复制。

连续观察空标签导航、B 新建／导航／切 A／关闭 B 回 A、侧栏开合、切会话返回、Cmd+W 准确实例重开／刷新／resize、真实系统标题栏双击／快速边框拖动，以及菜单和全局弹层覆盖恢复。画面与准确 Main page ID、WebContents、frame、timeOrigin、表单及阅读位置共同作证；核工具栏是否重建、旧地址／颜色闪回、网页空底、聊天遮盖和内容丢失。定向测试核取消、旧 scope／ID ABA、迟到准备／布局／关闭及输入与观察边界。

已可绘制且在 Root 上方的原页保持原生兄弟位置，切换和恢复不再无用途地排序到紧邻 Root；只有新文档从 Root 下方准备完成才升层。所有其他页先撤展示，受控输入屏障继续独立位于当前页之上。最后层序回归先复现三次多余排序，修后为零；它不建立物理跨 surface 原子提交保证。

原页保留、Root完整bounds、隐藏意图确认和可复制完整帧分别提供不同证据。055及后续私有候选仍有收展错接、Cmd+W空底或resize内部灰带，精确帧与当前范围只在Desktop owner维护。固定引擎的[View几何API](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_view.cc#L300-L422)没有指定WCV的屏幕提交回执；普通[WebContents.invalidate](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents.cc#L3897-L3906)在macOS只到[父窗setNeedsDisplay](https://github.com/electron/electron/blob/v44.3.0/shell/browser/native_window_mac.mm#L926-L928)，不据此添加热点重试。这些接口边界不是具体反例的底层根因证明，更不能把未通过改写为不可修或整体完成。

059 将准确 activate 的 show 私有路由到 showInactive 后保留 Main focus，一次有限生命周期画面未采到首灰，不构成修复。060 再补原 show 以保留激活语义，立即捕获同型首灰；061 将候选用于普通完整链路复验，又确认重开首灰、resize 窗内灰条及设置返回旧卡片残片。061 的 activation helper 因此已精确回滚，回滚记录确认当时2042份源码输入与060逐字一致；既有 coalescing、隐藏意图及迟到状态防线保持，失败制品和证据保留。不能把059有限绿或系统焦点正确写成候选有效。

062 隔离副本 A/B 已实际运行、确认加载原／候选字节，两臂仍有灰带及跨栏错位；最终有效 deadline 未取得证明。067–069进一步确认父几何通知、Root／Page geometry embed与新surface激活处于不同阶段，提前回调、原生布局或仅换BrowserWindow均无完整修复资格。Root Panel中间DOM也不等于该状态实际paint。具体因果证据与限制由[Desktop owner](../../../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)维护，不把入口policy、最终bounds、较早回调或有限画面当作跨surface同帧保证。用户先确认运动中灰边与双击绘制不同步是实际反馈，Cmd+W空底保留实验失败并后置；随后将全局对话框与临时消息调整为当前优先，具体决定见专用浮层 Note；这些诊断未改变本Note的结构决定，候选未接入普通客户端。

## Risks

隐藏页的 DOM ready 不等于已经有可读 surface，不能提前撤 loading 或无限等待。首文档完整原生帧订阅必须有期限与当前对象检查，不能把 native visible 或 URL 作为可绘制／输入证明。

Renderer 与 Main 的消息顺序不能保证 WindowServer 跨 surface 同帧显示；专用应用浮层的打开、取消、确认、焦点及恢复也须观察真实全过程。内部布局空档、窗口内右缘灰带与窗口外背景须分别定位。旧灰带和未取得的平台／发行资格继续由 owner 保留；本轮引入的回归必须修复，不能划为既有缺口或因代码减少、单张最终画面正确而宣告完成。
