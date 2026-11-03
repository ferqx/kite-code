# 浏览器固定 Renderer 展示收敛

状态：结构、缩放及左栏动画连续布局修正已落地，本机缩放及退出的限定验收完成；左栏单帧窄边缘差和整体浏览器过程的历史反例保留（2026-11-03）。范围为 Desktop 浏览器布局与呈现，不改变工具、权限、Loop 或协议版本。

## 当前与目标

迁移前链路是 Root 的 SessionTabs/Pane → Chrome 数据桥 → 独立 Chrome Renderer → Main Chrome Host → 裁窄 Root；Root 又经独占 CDP metrics 保持完整窗口逻辑布局。Root witness、Chrome ACK、准备帧、关闭画布和恢复 capsule 用来衔接这些不同宿主。真实网页和控制本来已由 Main/PageHost 持有。

目标链路是 Root 的同一套 SessionTabs/Pane/工具栏 → 单一 DOM 网页矩形与 panel layout → Main 校验当前 owner、revision、Root frame 和窗口几何 → 同一几何结果更新真实 WebContentsView 与输入屏障。Root 始终使用完整窗口原生尺寸。Main 的原生 resize 投影和 Renderer 的实际校准共用几何计算与属性写入；常规 resize 不隐藏网页。

首次显示与隐藏后的恢复在当前 Renderer 布局调用栈同步提交；祖先分栏宽度动画期间从 ResizeObserver 在 Root 绘制前同步放置。稳定正向校准仍保持一个异步请求在途，并在完成后只重新量测最新 DOM。同宽校准保留实际分配，不提前施加动画终态约束；真正预测窗口改宽才应用 min/max/collapse。046 连续画面已证实全部正向异步会在切页时留下一个内部暗空采样帧，因此不能用最终原页保留断言覆盖该空档。同步撤下继续推进 revision，使迟到正向不能复活旧页；不增加旧 UI 绘制 ACK 或截图替身。同步布局准入仍不等于 WindowServer 跨 surface 同帧提交。

053起同owner量测effect保留，失选tab的撤下在同次提交末尾合并，准确目标成功后取消待发旧null；Main目标先放置、来源后撤下，缺失页明确拒绝。真实owner／卸载／覆盖继续同步撤下。Cmd+W父窗隐藏退休live资格并保留准确child；隐藏Root的新token只维护当前intent，show前重新核对象／文档／Root／scope／Host／几何和当前shield，不恢复旧lease／观察。minimize不优化，迟到窗口通知核真实当前状态。没有增加公开开关、工具或协议版本。

删除独立 Chrome WebContentsView/preload/renderer、远端展示数据与动作 ACK、Root 物理裁剪和 CDP metrics 补偿、呈现 witness/关闭画布、普通切页与恢复截图缓存/交接。保留准确页面清单恢复、页面 incarnation、文档/导航、控制租约、输入屏障、模型截图 freshness 与注释冻结证明。

## 首开与层序

空标签由 Root 绘制，不为展示创建网页。输入 HTTPS 后，Main 创建准确 ID 的隐藏网页，Root 原工具栏保留地址和 loading。真实文档提交、DOM ready 后，将当前尺寸网页放在完整 Root 下方绘制；Root 的不透明网页区域持续覆盖它。Main 订阅该文档的完整原生帧，核对象、主 frame、文档代次、几何与请求序号后才把网页升到 Root 上方。文档等待与帧订阅均有期限，失败显示明确状态并保留人工刷新/停止入口，不无限等绘制；不把网络 loading=false 当成可绘制证明。订阅不复制或缓存截图，不产生模型观察与输入资格。已可绘制原文档的切页、收起/展开、会话返回、窗口重开不重做这套首文档门。

045 冻结运行验证隐藏新页 DOM ready 后仍没有可供 capturePage 读取的原生 surface。Electron 44.3.0 在增加 capturer 之前即拒绝无 surface 的复制，因此改变 stayHidden 或延时重试不能消除前提。既有显式 Root 工厂扩至所有平台，使 Main 可以通过公开 View API 将新页准确置于 Root 下方；BrowserWindow 隐式主视图不在 contentView 子列表，无法提供这一层序。平台菜单、标题栏、材质与托盘分支保留；Windows／Linux 实机资格不由工厂统一自动取得。

稳定层序为完整 Root ＜ 当前网页 ＜ 受控输入屏障 ＜ 应用确认Overlay。工具栏、标签和网页以外区域始终属于同一 Root。输入屏障仅约束真实网页控制，不阻挡应用 UI；应用确认的全content遮罩才阻止背景Root与Page输入。页面、展示绑定、Run/任务和控制租约各自退休。

DOM 弹层不能凭 CSS z-index 盖住原生网页。用户随后明确撤销通用浮层触发网页隐藏的策略：移除dialog/menu/popover/sheet相交扫描，aria-hidden／inert不再被视为视觉隐藏。切页、收栏、真正hidden／display／opacity隐藏、owner退休及明确进入冻结注释仍沿各自生命周期；不增加截图替身。普通自定义下拉的跨原生层覆盖暂不迁移。用户进一步要求全局对话框采用主窗口专用Overlay WebContentsView自绘，使Full与移除空间复用同一组件、CSS与主题；退出应用按用户最新要求保留系统原生弹窗。透明全content承载共享遮罩，层序高于真实网页与shield，保留原网页并阻止背景人工输入，已获授权的Page工具输入保留原控制门禁；窄preload只收固定kind并返回决定，不拥有Service或浏览器控制。取消、上下文变化、Root导航／崩溃和窗口生命周期退休确认，只有当前明确true回到原Controller，决定本身不授权限。操作失败原全局AlertDialog已移除，改为内容页内可关闭、6秒且hover／focus暂停的可读非模态消息；未知结果继续核对原操作。目录／文件选择和退出确认仍使用系统原生入口，Full与移除空间使用应用自绘确认。新对话本地选择与已有会话命令保持原边界，工具／协议／依赖版本不变。

## 参考与取舍

主要参考 [VS Code 固定提交](https://github.com/microsoft/vscode/tree/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/contrib/browserView)：Workbench 固定 UI、Renderer 量测后 Main 缩放取整、隐藏与销毁分离、重载先收 Main 清单且按准确 ID 复用、异步对象/序号校验、正常 resize 保留真实页。其首开只以 URL/error/layout 准入，没有 first-paint 证明；不据此推定 Kite 可提前撤 loading。每秒截图、隐藏页瞬时显隐重试、弹层下一 rAF 撤页以及窗口关闭销毁不照搬；Cmd+W 在 Kite 继续隐藏窗口。

保留旧架构会继续要求双宿主与尺寸补偿；只改颜色无法改变因果链。弹层截图复用现有注释接口会混淆冻结/控制语义并增加 draft 支持，本轮选择不使用截图。最初应用层范围不含引擎补丁；2026-11-02用户进一步明确授权在隔离副本中诊断和试验固定Electron44.3.0的macOS窗口／WCV合成补丁，随后用户明确要求合并，当前按[resize决定](../../.agents/notes/implemented/bug-fix/2026-11-02-macos-electron-resize.md)接入新开发应用和Native候选；普通依赖、工具／协议版本及发布状态保持不变。

## 实施与验收

主 Agent 拥有 Main、preload/bridge、集成与 Git；Renderer 独立区域可委派，避免重叠写入。先完成源码和定向失败回归，再冻结最新制品，沿用现有无凭据隔离 HOME/Profile，录制期间不改源码。

核新空标签导航、B 导航/切 A/关闭 B、右栏开合、会话切换、准确实例 Cmd+W 重开/刷新/resize、真实系统标题栏双击及快速拖边、原生菜单与 DOM 全局弹层恢复。连续系统画面与 Main 页面 ID/WebContents/frame/timeOrigin/表单/阅读位置一同作证；区分内部空档、窗口内灰带和窗口外背景。定向测试涵盖迟到准备/布局/关闭、scope/ID ABA、取消与控制边界；执行 Desktop 类型、格式、文档和适用边界检查。证据与限制归 Desktop owner；设计 Note 记录持久取舍。本计划完成后归位并删除。

## 当前验证与未完成

2026-11-02已按用户后续要求将082配套优化接入开发启动与Native新候选，083实色背景方案不采用。084由生产Main准入并选择feature，有限连续画面未确认旧灰边／分栏错位，退出137仍保原失败；已定位旧Host closed回调访问已销毁窗口，补修后086的真实动作、有限画面与Main／Service正常退出通过。两个旧UI集成夹具仍失败，不计全绿；准确范围统一归[Desktop owner](../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。未改依赖／工具／协议版本，不授发布或跨平台资格。本轮用户指定的两项缩放优化及代码合入已经完成；本计划所载整体浏览器过程仍保留范围外未验反例。

实现、原页与控制边界回归以及冻结制品的全部指定操作已执行，证据已归[Desktop owner](../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。050覆盖全场景，052多页反例已补完Display审查；053同提交目标替换、055最新完整场景均未再采到052切页暗空，准确原页、表单与scroll140保持。隐藏换B后立即Root重载选错A、迟到hide撤shield／show消耗新intent等源码竞态均先红后绿。当前Main112项、Root10项、Pane35项、Refresh及Main/Service/Runtime回归通过，不代替过程像素。

2026-11-03用户进一步限定本次只优化左侧导航隐藏时网页绘制不同步。已确认终态约束误判导致整段动画不发布，以及恢复连续发布后仍有异步单帧迟滞；按上面的同宽量测与动画期同步规则修正。准确实机范围和验证归 Desktop owner，旧右栏收展、设置返回、Cmd+W及跨平台资格不在本次收尾范围。

2026-11-02实机反馈曾将优先级明确为：拖动或双击缩放过程中连续出现、停稳后消失的右灰边，以及真实header双击时网页与容器绘制不同步。它不是停稳后仍在的固定留白。用户未遇到Cmd+W重开整窗材质空底，该项保留实验反例、降低当前排查优先级，不写成已解决或用户实机复现。其余问题先取得具体原因，再修复。

2026-11-02用户进一步要求先提交本轮代码，随后完成缩放灰边与header双击绘制不同步两项，再结束本任务。已提交`9b158c9ea`，适用pre-commit门禁通过；这是已实现结构、应用确认与临时消息的检查点，不代表浏览器完整过程验收通过。收展、设置返回和Cmd+W的历史反例继续保留在Desktop owner，不再作为这次收尾的前置工作。

| 顺序 | 剩余任务 | 当前诊断与完成条件 |
| --- | --- | --- |
| 已实现检查点 | 统一主窗口自绘确认与可读临时消息 | Full／移除空间的固定Overlay和原Controller防线已实现；退出应用已按用户要求恢复原生确认；073冻结Full三轮、背景阻断与有限连续画面通过。074冻结build后因退出竞态在run前退役；075最终Full三轮及空间只取消实机通过，原页／草稿／目录保持、退出0与制品无漂移，前6秒连续画面与尾部已审看，未见灰空或残留；退出原生弹窗与自然消息错误实机资格不能由组件或073替代。070／071按钮guard失败、072未run保留历史；普通下拉暂不迁移。准确测试及旧失败归Desktop owner。 |
| 1 | 消除系统还原／拖边时窗口内部动态灰带 | 077／079b的原反例保留；082保留旧Main同步并使用V2 GPU路径的新隔离候选，在本次动作及稳定尾Display335样本中未确认旧灰L／右灰带。083实色对照只改变缺口颜色，不能采用。配套优化已接入普通构建，最终086的42表334动作／尾样本未确认旧灰L／右灰带，Main／Service真实退出0；只授本机本轮限定范围，不外推逐像素或发行资格。 |
| 2 | 消除网页与Root容器在双击／拖边过程中的分栏错位 | 082实际放大／还原时Root／Page viewport各22／23次持续变化，未重现081约330ms停滞，本次连续Display及必要原图未确认明显分栏错位，原页／表单／阅读位置保持。最终086以生产Main选择配套策略，真实双击／拖边及有限连续画面未确认分栏错位，原页状态与正常退出通过；旧失败与084退出137保留，不宣称物理同帧或完整发行资格。 |
| 收尾范围外 | 055收起先暗空／展开聊天拼块与窄白页 | 061原尺寸未确认同型收起疑点，不覆盖055真实反例。需核Root实际布局／绘制与撤页、恢复顺序，避免把原页身份断言当成画面证明。 |
| 收尾范围外 | 061设置返回的旧卡片残片 | 该卡片属于Root，不能直接归因网页导航；核Root布局及surface／damage。055未采到050同型残片，不覆盖061新失败。 |
| 收尾范围外 | Cmd+W重开整窗材质空底 | 用户未遇到；055–061实验失败保留。056／057后台策略、058隐藏Root捕获、059–061激活候选均无修复资格。063附加诊断与064原生hook未取得观察成功，065尚未运行，不把准备或失败写成原因已证。 |

059 私有 showInactive 后保留 Main focus 的一次有限生命周期录制未采到首灰；060 补原 show 保留激活语义后又捕获首灰，不能把059写成机制已修复。061 普通完整链路复验再次确认重开首可见灰底、resize 窗内右灰条及设置返回旧卡片残片；退出0、输入／制品无漂移及系统焦点正确均不覆盖这些中间帧。061 collapse 的联系表疑点经主 Agent 原尺寸复核未确认：旧布局完整后页面／工具栏一起撤下并扩展聊天；不据此抹去055收展反例，也不授予整体无残片资格。activation helper 已精确回滚，回滚时2042份源码输入与060一致，既有 coalescing、隐藏意图与迟到状态修正继续保留。具体PTS、逐帧范围、回滚记录和未覆盖项归[Desktop owner](../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。

062隔离副本A/B已经运行并确认实际加载原／候选字节，两臂仍有内部灰带与跨栏错位；最终有效deadline仍未证明。067被动时序及068 Root-only对照定位了父尺寸通知与JS子几何更新的先后差异；069私有前移现有处理后，子geometry embed确实早于父新surface，父新surface仍早于准确Root／Page新surface激活，画面仍失败。后续用Graphics.Pipeline实际聚合frame trace ID闭合了父129／Root126／Page128的旧子帧参与关系，但不等于已取得WindowServer像素回执或最终等待策略。不能继续以“回调提前”作为充分修复。Root Panel中间约束状态也已记录，但rAF样本不证明已paint。055收起另查到先撤页、下一rAF才折叠的应用阶段；已将同scope准确原页保持到该rAF开始，再同批撤页和折叠，定向回归通过、过程像素待核。具体身份、PTS、trace时钟与限制归[Desktop owner](../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。

073的Window307帧／39表、Display261帧／33表只覆盖0–5秒动作及末约0.4秒，静态中段未目视；2065份source与制品无漂移、Main退出0、504模型调用未增，均只支持该Full冻结范围。当前结构与定向回归不代表整体过程体验完成：resize／真实header缩放、055收展、Cmd+W和设置返回残片仍受原失败阻塞；read ownership保留旧Agent入口一例失败，native-browser最小夹具first.visible失败尚未定位。074在run前因退出审查的旧确认／通知异常竞态退役，原材料保留；075最终冻结2065份source，四轮运行通过、Main38pass／3skip／440assert，Window364帧／46表、Display317帧／40表的前6秒与末约0.4秒画面通过；后补提前取消、Root-only事件拦截、透明原生view即时覆盖及前台焦点约束，Host8／84与Root11／92通过；退出恢复原生message box，Overlay已移除quit kind，Full／workspace文案、DOM与CSS保持，复用075对应正常画面而不称所有UI字节不变。076c定向实际Electron输入已先红后绿：Page CDP键鼠到达、Overlay真实mask接收且Root／Page零人工点击、取消及原文档／表单／scroll保持；load前native visible／全bounds／top已核，未授空DOM物理点击或新整体像素资格。最终普通／development实际构建1／29通过，准确范围归Desktop owner。准确范围及未覆盖项归[Desktop owner](../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。

Main bounds、原文档保持、完整Root可复制帧和脚本退出0均不能覆盖这些失败。当前配套修正已接入，086有限过程及正常退出结论不改写084的历史失败，也不覆盖范围外旧反例。用户已进一步授权合并固定Electron44.3.0修正；不重跑已否决的AsyncLiveResize或等价失败候选，不以Node exit事件、最终截图或同版本标签代替实际验收。普通依赖、工具／协议版本及发布状态保持。未完成前保留本计划，不宣告整体完成。

主窗口确认层的持久取舍及对旧固定Renderer决定的局部替代见[应用确认层Note](../../.agents/notes/implemented/architecture/2026-11-02-native-global-dialog-layer.md)；Note的implemented不授予075实机资格。
