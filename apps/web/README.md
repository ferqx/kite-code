# Web 只读调用者

`apps/web` 是新 HTTP 公共契约的浏览器观察 owner，交付[条件读取控制器](src/controller.ts)、[React 只读页面](src/page.tsx)与[同源 mount](src/mount.tsx)。正式根 `server` 经[已选 Terminal 入口](../../scripts/development/ensure-web.ts)先启动新 Daemon，再执行 `web`；源码入口使用校验过的 `dist/unified-terminal`，安装 CLI 的 [web host](../cli/host/daemon.ts)查询同一已准入 Daemon 的 Browser URL。[Daemon main](../service/src/daemon-main.ts)装配本包可信资产与 Cookie Gateway。此调用链已在当前源码切换，完整能力与最终旧路径退役仍按[统一进度](../../docs/plans/unified-agent-refactor-v1-progress.md)核实。产品预期见 [Web 手册](../../docs/handbook/clients/web/README.md)。

浏览器使用 [Client Browser 子入口](../../packages/client/src/browser.ts)，同源 HttpOnly/SameSite cookie 与固定页面身份。Native bearer/profile 路径不进入浏览器。Service 的[有限只读 Gateway](../service/src/development-web.ts)拥有 listener 和可读投影；转发具名目录、所选会话状态、分页 History、当前选择 Context、准确 Job output、原 Model input/output、Runtime logs 与恢复点 metadata，写入、审批、取消、SSE、配置/凭据与任意路径不转发。关闭页面或观察器只释放读取和浏览器访问，不取消 Session，也不关闭执行 Service。

`WebController` 仅轮询可见的所选活动会话，默认 2000ms，同一次读取为 single flight。切换 Session 和 document 可见性取消所属读取，迟到 success/error 不能覆盖新选择。失败保留同一选择的完整旧 snapshot 和内部 stale/error 事实；活动与空闲会话的失败读均在页面可见时持续退避重试，最高间隔30秒，不在消息区外显示旧快照／历史不可用等文案，也不把失败伪装为空历史。状态依据真实 `Run.isActive`，不从字符串标签猜运行权。

每次 History 用 Session 已分配上界和最多 200 项页面读取完整前缀，核对准确 Session、Decimal64 顺序、分页推进和最终 Store/selection/control revision/snapshot cursor。冲突时不发布 partial ready。当前便利 snapshot 返回整份消息数组，每次完整重读，且最终 global snapshot cursor 变化会要求再次读取；大历史、并发活动和内存性能资格尚未由本地小规模回归证明。没有持久离线缓存或第二业务状态机。

[控制器测试](test/controller.test.ts)使用 fake Browser 公共 port，验证 200+1 完整页、最后分配序号、scope/快照冲突、可见性/活动/单飞、迟到身份和 stale；[DOM 页面测试](test/page.test.tsx)通过 React/JSDOM 验证目录导航、全部历史、真实 cancelled/outcome_unknown、旧快照保留、页面可见性、后退/根导航、迟到响应与拒绝身份。它们不是原生浏览器资格。[真实 Service 测试](../service/test/isolated/development-web.test.ts)使用固定 Model、临时 SQLite、真实 partial、Cookie Gateway 与 HTTP，验证零业务写和页面关闭时原工作继续。当前为本机 macOS 证据，不代表安装或三平台发行。

页面只在 cookie 身份准入成功后读取目录。工作区展开时使用原 Browser `listAllSessionDirectory`，只有完整同 snapshot 的根会话与 activity 才交给私有[目录展示](src/directory.tsx)。按已封存 `updatedAt` 降序排列，null 置后、同时间保原分配顺序；各空间独立显示 5 条，再显示 10 条，收起重开回 5 条。旧身份便利入口保留兼容用途，正式 Web 已不再用它读取活动目录。会话路由使用 `/sessions/<id>`，popstate 与直接链接由当前 controller 读取；回到根目录会清除选择及轮询。document visibilitychange 实际连接 controller，可见且实际 isActive 才定时读。页面卸载只释放所属观察器/目录请求；pagehide 另显式清理 browser cookie session，仍不取消 Runtime。Cookie续建和单次请求重试由 Browser SDK 处理；页面层仅在失败后退避发起新的只读校准，不提交业务命令。原 Run 展示元数据读取也按所属 scope 退避重读，取消或隐藏后停止。

目录行只显示 name/title，详情复用公共 UI desktop 的原 Tooltip，首次悬停500ms／快速切换300ms、focus与Escape由原组件处理。空间数量来自完整已读根集合，Session状态只映射其原 activity：原Run状态、isActive、必需结果等待、queued和pending数量；事件时间显示原毫秒精度与时区，缺席保持Unknown，不借当前所选View或读取时钟。上下／Home／End移动可见目录行焦点，Enter沿原链接直接选择。Refresh directory读取工作区及各已展开根集合；失败保完整旧集合并后台退避重读，普通页面及详情不追加错误或上次读取文案。隐藏／bfcache暂停同步撤销所属读取，发布前再核原signal、mounted、paused和实际可见性，恢复准入后重读已展开集合；关闭导航只关闭详情，不取消业务。

[完整目录DOM文件](test/isolated/session-directory.test.tsx)通过实际WebPage公共port与原Radix核排序／分批／完整metadata、500/300ms时序、焦点／Escape、刷新／隐藏／暂停及迟到隔离。原page／navigation／runtime-logs断言保留，fixture只接新的正式reader与必要DOM装配；原[真实目录](../../tests/isolated/unified-agent/directory.test.ts)证明SQLite／Cookie HTTP／Browser完整分页和活动事实，原[恢复页面](../../tests/isolated/unified-agent/restored-web-model-output.test.ts)证明此consumer仍沿实际冷恢复GET读取。当前本机IAB另核编译资产、焦点详情、Escape和Enter准确进入，完整84项／14文件范围与限制归[目录进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11web-完整工作区与会话目录)。这些证据不代原生多浏览器、Win/Linux或阶段完整回归。

消息按准确 seq 平铺为可选中的安全 Markdown，HTML/脚本不执行；incomplete、取消、失败与 unknown 保持各自实际状态，不推断最终回复或思考。目录宽度与窄屏行为见下方布局小节；Runtime logs 的按需 metadata 观察见下方独立入口，恢复点只读 metadata 观察见下方独立入口，仍无恢复操作；API Docs 由所属 Service Gateway 提供，见下文；原 Model input 检查器见下方独立入口，其正文读取仍独立确认。正式启动路由已使用此 owner；手册承诺的完整客户端、安装平台与退出资格继续按实际能力验证。

## 目录布局

DOM 测试共用私有 [global descriptor 夹具](test/globals.fixture.ts)安装所需全局并恢复原属性描述符；每个测试继续自行配置 JSDOM、浏览器 API stub、React 生命周期和业务 port。夹具不进入生产构建，也不把 DOM 测试提升为真实浏览器资格。

私有 [navigation](src/navigation.tsx) 只管理浏览器本地布局，不接收 Client 或执行身份。宽屏目录默认 200 px，可用 pointer 拖动分隔线调整至 420 px；窗口仍为宽屏时保留像素宽度，由内容区适应剩余空间。拖至 100 px 以下折叠，顶栏按钮重开并恢复最后合法宽度。导航 DOM 保持挂载，目录展开项、选中会话及 History/Model/context/Job 所属读取不因折叠或 resize 重建。

分隔线是可聚焦的垂直 separator，发布 200–420 的 ARIA 值；左右键每次调整 10 px，Home/End 到边界，Enter/Escape 折叠并将焦点返回顶栏按钮。640 px 及以下初始关闭目录，按钮打开覆盖侧栏；选择真实会话或按 Escape 关闭，焦点在顶栏关闭按钮时也有效并回到打开按钮。已有目录 handler 消费的 Escape 不重复执行。选择仍使用原 controller，宽窄屏切换不改变 Session 或执行权限。

同源 `kite.web.navigationWidth.v1` 只保存 200–420 的三位整数，不保存正文、路径、身份或折叠状态；未知、越界、非整数和 storage 拒绝均有限回退至 200 px，不读取旧客户端 preference。未完成的 pointer 操作遇到取消、窗口失焦、document 隐藏或页面暂停时回到操作前宽度，不保存中间值。静态 scoped CSS 随受 manifest 校验的 app.js 交付，不加载额外 URL 或 legacy 业务组件。

[navigation DOM 测试](test/navigation.test.tsx) 使用真实 DOM pointer/keyboard 事件，核边界、其他 pointer 隔离、折叠恢复、有限偏好、storage 拒绝、窄屏选择/Escape，以及原选中 History 与读取计数不变。它和现有实际 Cookie Gateway/Service 邻接资格分别证明展示交互与公共只读边界；JSDOM 不代表实际浏览器触摸、像素布局或多浏览器资格。

## 有限可信资产

[build.ts](build.ts)是显式构建宿主，不进入 browser source。build 将 React/Client/UI 离线打包为固定 `/app.js`，同时产出 `/index.html` 和 `/app.css`、`dist/manifest.json`、source-independent `dist/assets.js` 与 `assets.d.ts`。`@kite-ai/web/assets` 的 `getTrustedAssets()` 返回新 ReadonlyMap，`assetManifest` 保存每个固定 path/MIME/UTF-8 size/SHA256；类型入口是源码声明，不要求 clean checkout 已有 dist。宿主先调用公共 `validateTrustedAssets(assets,assetManifest)`，再将这个固定 Map 注入 Gateway，不提供任意目录、URL 或文件代理。

[制品测试](test/isolated/assets.test.ts)实际执行完整 build，将 assets module 复制到没有源码的临时目录后动态 import，按 manifest 核对固定路径、hash、metadata，并拒绝额外路径、内容损坏及重复项。构建不连接 Provider，不携带 cookie、Native token 或配置路径。Service library 不必依赖 Web runtime；Root 的显式开发入口决定何时 build/load 和装配。

验证入口：`bun run --cwd apps/web typecheck`、`bun run --cwd apps/web build`、`bun test apps/web/test`。新源文件加入[依赖边界检查](../../scripts/check-unified-agent-boundary.ts)、统一测试与 workspace build/typecheck。正式入口装配本包；仓库中的 `apps/kite-web` 旧源码仍待完整迁移审查与最终退役，不能把保留目录当作现行正式启动路由。

2026-10-02 在 macOS 的实际 Codex In-app Browser 中用[本机预览夹具](../../tests/fixtures/unified-agent/web-preview.ts)复核了编译资产、真实 Service/SQLite、Cookie 准入、目录与直接会话链接、有效 GFM 表格与无脚本/自动图片、完整正文复制和 Cmd+A 的历史范围。A→B→A 恢复原 scrollTop，追加一条真实消息并显式刷新后仍保留该位置；原 Context 与 Job 三种输出均按需显示。首次现场发现运行时 AJV 编译被严格 CSP 拒绝，已改为构建时静态校验器并实际重验。该证据覆盖本机默认窄视口，不能代替其他浏览器、尺寸矩阵、Electron 或正式 launcher 资格。


会话正文现使用公共 UI `SafeMessageMarkdown`，保留完整消息并按 GFM 排版。原 HTML 显示为转义文本、图片仅显示替代文字、相对文件路径不启动本地编辑器。正文与消息阅读列同宽，不添加独立限宽或内边距；非消息区不可选中。

History 为独立滚动区域，首次进入定位最新，向上阅读时刷新保持原位置，可显式回到最新。会话内复制仅包含当前已展开的原消息正文；Cmd/Ctrl+A 限于当前 History，输入、textarea、select 与 contenteditable 不劫持。工具详情使用原消息 ID 独立展开，不从名称猜测分类或 Turn。页面内最多保留 32 个会话的滚动 metadata，每会话最多 256 个展开 ID，不保存旧正文；返回会话重读实际接口后恢复位置和展开。重载不承诺恢复。

已发送的 complete 用户消息逐条提供共享 [MessageCopyButton](../../packages/ui/src/desktop/MessageCopyButton.tsx)，直接复制原公共 `message.content` 字符串，保留 Unicode、CRLF、Markdown 与脚本字面量，不从渲染 DOM 重建文本。按钮按当前 Store/Session/message ID 挂载，悬停或键盘聚焦可见；成功勾保留两秒，失败可重试，正文变化／隐藏／暂停／换会话清除旧反馈与所属定时器。只调用本页面 `navigator.clipboard.writeText`，不增加 HTTP 写入、模型调用或任务操作；未知格式的原诊断保持，复制不解释或升级其内容。助手整轮复制沿准确 Run metadata 与当前已读完整正文核实，见下一段；不以相邻消息推造回合。

助手复制复用纯 [completeRunReplies](../../packages/ui/src/run-reply-copy.ts) 与正式 Native 的最终回复资格核验：只有当前 Session 未封存消息所属的准确 completed／inactive Run 才可合并，按原 Decimal64 seq 将全部助手正文以空行连接；中间助手的普通正文保留，Tool 参数、工具结果、reasoning、其他 Run 和子／封存消息不加入。最后助手仍须完整、支持格式且无后续 Tool；任一非零 `outputBody` 未经现有 reader 完整验证并显示，整轮按钮不可用，不拿预览补缺段，完整正文由会话 reader 自动读取，复制资格本身不触发业务执行。成功／失败交互继续共用 MessageCopyButton，隐藏、暂停、stale 或切换阅读身份撤销相应资格。

History 每条消息在生产 CSS 中拥有自己的定位容器，复制按钮归所属消息底部；不会把多个助手按钮定位到页面同一角落。阅读间距按准确 final 身份与相邻 role 选择：user／final 后32px，Tool 后紧邻 final 为16px，其他过程间隔8px，顶端不叠加旧通用 padding／分隔线。final 身份取 `completeRunReplies` 的已核 metadata entry，不依赖全文是否已加载；读／Close 只改变复制资格，不重新定义最后回复或移动阅读间距。原 hover、Tab focus-visible 和两秒反馈保持，当前字段仅为 DOM 展示，不增加 Runtime 或来源 authority。

2026-10-13 本机实际编译资产／Cookie／SQLite／固定模型预览中，修前两个助手按钮同时定位 x1256/y694，均不在自己的 article 内；修后两按钮各属于自己的 final article，长正文滚动和两次真实 Tab 聚焦保持 inside／focus-visible／opacity1。user／final 的生产布局 padding32已在浏览器核实，过程8和Tool→final16及全文开关身份在注入真实 `/app.css` 的便携 DOM 核实；不把 JSDOM 称为原生像素证据。观察仍为3次固定模型调用、4条消息、2个Run、4个Execution、cursor45，两次自有预览正常退出0。截图 `/private/tmp/kite-web-reply-layout-green-20261013.png` 仅证明当前定位与焦点，不代 OS 剪贴板原文字节；助手 OS 字节仍未直接观测，不记为通过。再次由用户人工粘贴不是原产品合同指定的独立验收方法，不再作为额外功能推进条件，见[门禁收束](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13回到原退出条件收束额外诊断依赖)。必要组合为全部11个Web文件及原真实恢复整例，共12文件62pass／739断言，详细范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13正式-web-复制定位与阅读间距)。

[run-facts](src/run-facts.ts)只为完整已读 History 中准确的未封存 Run 补 metadata。有限 View 已核项优先；超出最近200项时经具名 Browser `getRun(sessionId,runId)` GET 核当前 Store／准确 Run／Session，保合法恢复后的原 originStoreId。cache 只属于当前 Client／Store／Session／controller generation，completed／failed／cancelled 非活动事实可复用，active／interrupted／读取失败在新实际 snapshot 刷新时重核；View 新事实覆盖此前缓存。关闭、隐藏、页面暂停或不可读状态 abort 所属 GET；读取不提供执行、配置或凭据权。错误保原消息并说明整轮范围尚不可核，可沿原 Refresh history 重试。

[整轮页面用例](test/isolated/assistant-copy.test.tsx)覆盖201条完整历史、有限 View 外 Run、中间 Tool call 的普通正文、每段已加载全文与切换迟到隔离；[原真实恢复整例](../../tests/isolated/unified-agent/restored-web-model-output.test.ts)保原完整断言，并核实际 Cookie／Store A→B、原大正文加 inline 最终段的准确整轮复制、sealed 零按钮与切换撤销。便携 DOM clipboard 使用内存端口，不能替代本机 OS 剪贴板字节或其他平台资格。

[正式页面复制整例](test/isolated/message-copy.test.tsx)经实际 mount/ReactDOM 核两条原用户全文、重试、两秒反馈、切会话迟到隔离和已读 Model 正文保持；共享 Conversation 的原消费基线与最终 DOM 回归另保原用户／助手完整文本选择和同 ID 换正文隔离。相邻完整组合 13 文件／75 项／724 条 Bun 断言通过，含真实 Web assets 构建，根与八个 workspace 类型检查通过。本机 IAB 实际 Enter 核按钮焦点、24px 控件及 18px 成功图标、两秒复位，读取前后仍为 3 个固定模型调用、4 条消息、2 个 Run、4 个 Execution、cursor 45；工具提供的 clipboard reader 返回空文本，当时未能核实实际 OS 原文。用户随后在本机编辑器粘贴，并确认指定用户消息 `Show the full original Markdown response.` 为准确原文；共享复制控件自该预览至当前代码未变，因此该单条用户消息的实际粘贴事实可复用。此确认不覆盖助手整条回复、其他内容或 Native 剪贴板；这些资格仍按各自证据核定。`data:` 粘贴核对页被浏览器安全策略拒绝后未绕过；原公共 Cookie/正文读取证据按未改范围复用，完整浏览器／平台与阶段门禁保持。当前代码的完整默认回归及精确证据范围见[本轮收束](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13当前代码完整默认回归与用户原文粘贴确认)。

DOM 测试验证 Markdown 安全与完整文本、复制范围、键盘范围、刷新/切换位置及工具展开；JSDOM 的模拟 scroll 数值和 Range 证据不代表原生浏览器选区、实际布局或触控资格。正式浏览器体验仍由宿主独立验证。


## 按需只读诊断

“Read current selected context” 沿 [diagnostics reader](src/diagnostics.tsx) 固定当前已准入的 Store／Session、selection 与高水位，读完消息和结果两条独立游标后发布。明确备份恢复生成新 Store 时，已授权来源仍显示原 Store、Execution／revision 和完整结果；原出处与当前连接身份分别核对，不改标来源或取得执行权限。Gateway 从实际连接注入当前 Store，Core 核来源与真实 Execution 的出处／revision；其他 Session、错误当前连接及分页漂移仍拒绝。

[真实恢复消费者](../../tests/isolated/unified-agent/restored-context.test.ts)使用实际 Service／SQLite、备份恢复和 Cookie BrowserClient核首次及冷读、原完整结果和零业务重放；[诊断整文件](test/diagnostics.test.tsx)保分页、来源 Session 和原 DOM 取消／迟到守卫。HTTP 与 DOM 分别证明数据边界和展示行为，不冒称本轮实际浏览器或安装制品资格；准确失败及范围归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后完整-context-正式消费者)。

[Diagnostics](src/diagnostics.tsx) 只接收主 WebController 已选择的 view，不另行读取或猜测当前 Session。一个活动面板只保存同目标最后一次完整 snapshot；打开、显式刷新才读取，不后台轮询。缺 context/execution_output capability 时入口禁用，原 Store 与页面身份不匹配在本地拒绝。关闭、隐藏、切换 Session/selection 或卸载 abort 面板所属请求，既不关闭共享 Client，也不取消 Runtime。

Current selected context 显示当前选择、完整消息与原 result source 身份；它不是一次 Model 实际输入 Inspector。首次响应封存 highWaterSeq 和 selection，两条 cursor 独立穷尽，全部成功才发布；结束的消息流固定 afterSeq=upper，来源流保最后真实 ID。现公共接口没有禁用已结束 stream 的字段，后续页面可能仍读取其空投影；本地不重新追加该流，不承诺服务器停止扫描。selection/scope/重复或不前进游标冲突不会发布部分结果。

Job output 仅从当前 view 的实际 kind=job ID 进入，不能从 Tool 名称猜 Shell。完整覆盖现在复用公共 Client 的 [ExecutionOutputPages](../../packages/client/src/execution-output.ts)，与 Native 共用原页语义；Browser 准入、按需读取与原错误分类保持。首响应封存 output highWaterSeq，严格 Decimal64 顺序读取至该上界，保 stdout/stderr/progress、准确 seq/throughSeq、droppedBytes（NULL 表示 clipped interval 的字节数不可用）。按全局 interval 覆盖核缺口；per-stream coalesced gap 可跨越另一个 stream 的保留 chunk，也可与另一个 stream 的 gap 重叠，原记录全部保留。下一游标取本页所有 throughSeq 的最大值，不取排序末项；同 stream 冲突、重复普通 chunk、缺口或提前 EOF 拒绝，不把缺内容显示为完整输出。它不是完整 Runtime 事件日志，不补造退出码。刷新失败保同目标结果并标 stale；换目标立即清除旧正文。

[test/diagnostics.test.tsx](test/diagnostics.test.tsx) 使用 fake 公共 Browser port 和 React/JSDOM 验证双分页、原身份、Decimal64 超过 2^53 的区间、gap NULL、singleflight、scope/conflict 拒绝、同目标 stale、局部能力缺失、关闭/隐藏/切换 abort 与迟到结果隔离。真实 Gateway 接口由 Service 测试核对；这里不冒称真实浏览器布局、滚动或完整日志/Model Inspector 迁移完成。


bfcache 的 `pagehide.persisted` 保留现有 React document、选择和阅读 metadata，同步提交暂停状态：只 abort 本页目录、History 与诊断所属读取，不关闭共享 Client、Cookie session 或 Runtime。返回时 `pageshow.persisted` 先对 BrowserClient 原 page/instance/build/Store 身份重新 connect 核对，成功才解除暂停并刷新当前选择；失败保留旧正文并显示身份错误，页面保持 inert，不自动采纳新后端。反复 pagehide/pageshow 的迟到身份响应受本地代次核对。非 persisted pagehide 沿原清理行为 unmount 并尝试关闭 Browser session；它不停止 Service。DOM PageTransitionEvent 测试覆盖暂停、确认前零业务读取、原位置、错误身份不复活与真正离开清理；bfcache 实际浏览器返回资格由 Root 另测。

## 新开发 Web 宿主入口

[scripts/development/unified-web.ts](../../scripts/development/unified-web.ts) 将已构建的 `apps/service/dist/main.js`、公共 paired bootstrap 和本包可信资产组合成前台只读 Browser Gateway。开发入口命令为 `bun run scripts/development/unified-web.ts`；根 `web:dev` 由根集成 owner 指向该命令。启动前须显式构建 Service 和 Web，不在运行时构建、回退源码或发现旧 daemon。

缺省选择当前用户目录的 `~/.kite-code` dataRoot 和 `development` profile，数据库直接位于 `~/.kite-code/development/core.db`，与 CLI/TUI/Desktop 开发入口共用，不随 checkout 或工作目录改变。唯一可选参数为 `--data-root <absolute-path>`，显式值优先于默认根；不接收 token、任意 entrypoint、环境权限或 Provider 配置参数。旧 checkout 数据保留原位，目录结构和读取方式见[本地开发](../../docs/development/local-development.md)。启动选择先固定 profile/API/capabilities/instance；buildId 是所选 Service entry 文件字节的 SHA256，仅代表开发 entry 身份，不代表完整发行 candidate 身份。Native bearer 只走 paired 私有 bootstrap，stdout 仅一行 Browser endpoint，错误只输出有限错误码；不会打印 token 或 profile 路径。

浏览器关闭只释放其访问；前台宿主的 stdin EOF、SIGINT 或 SIGTERM 则关闭自己拥有的 Gateway 和 paired Service。stdin 是存活信号，不接受凭据或指令。Service 意外退出也关闭 Gateway，不保留指向旧身份的 listener。这个独立开发前台没有 detach 或正式安装生命周期；正式 `server`／`kite web` 由新 Terminal／Daemon owner维护，TUI／Native与发行各自的完整资格仍独立核实。

[隔离 launcher 测试](../../tests/isolated/unified-agent/web-launcher.test.ts) 在临时 profile 使用真实 paired Service、SQLite、固定 Model、Cookie Gateway 与外部宿主进程，证明错误资产启动前拒绝、零启动 Model、浏览器关闭时原工作继续、EOF/信号准确清理所属 PID/listener和 endpoint-only stdout。2026-10-02 macOS 本机 loopback 实测 4 tests / 46 assertions；不连接付费 Provider。该测试使用已有构建资产，不代替 Root 的统一构建、源码树外制品或安装平台资格。

## 原 Model 输入检查器

[Model calls / Original Model input](src/model-input.tsx) 是独立于 History 和 Current selected context 的只读诊断入口。它通过 Browser 公共 `listModelInputs` 穷尽固定 upperSeq 目录，支持第 201 次及之后的原调用；观察 snapshotCursor 可以变化，不替代目录上界。点击准确 executionId 后先确认敏感内容，确认前不请求正文。成功输入按原序展示 System、所有 Messages、Tool call/source IDs、完整工具描述与 Schema；不会从当前配置或 History 拼接请求。

正文使用公共 `getModelInput` 的完整 EOF/hash/准确身份验证结果，未完整成功不显示前缀；模型成功未确认时明确标 unconfirmed，不能据此声称 Provider 已收到请求。每次调用有封存 metadata 时显示实际 Adapter/Provider family/model、受支持 settings、准确 Extension/Tool namespace 和版本、来源 ID/digest、转换标识及最终授权 revision/controlReads；中立 policy 解释按原 JSON 展示，不从当前配置取值。opaque Adapter/Provider、未记录或未来静态版本、未派发授权分别明确 unavailable；已知派发事实不会因 policy 解释缺失而丢失。不显示凭据、endpoint、内部 Artifact 元数据或 Provider 响应，也不声称已经完整记录私有传输配置。关闭、隐藏、会话切换与 bfcache 暂停 abort 面板所属读取并清除正文，迟到响应不能覆盖新调用；只保留打开面板的本地目录身份，不持久缓存正文，不取消 Runtime。恢复可见后须再次明确读取，不后台轮询 Model 输入。

[test/model-input.test.tsx](test/model-input.test.tsx) 使用生成的公共 DTO、Browser port 与 React/JSDOM，验证 201 项目录、超过 17MiB 的完整正文尾部/System/Schema、确认门禁、single flight、scope/游标冲突、失败零前缀与关闭/隐藏/跨会话 late 隔离，以及封存 settings/装配/来源/授权在确认前不公开、确认后不被当前配置替代。这证明便携数据与 DOM 行为，不代替 Root 的真实 Service/Client 全文链路、原生浏览器布局或安装资格。Runtime logs 仅使用公共条目的准确 `modelExecutionId` 进入此检查器，仍需第二次确认才读取正文；TUI／Native和完整发行资格仍由各 owner核实。

## 原 Model 输出全文

History 的公开 `outputBody` 只表示原输出身份与完整性／长度。普通会话具备 `model_outputs` 能力时自动只读原 Session／Execution 的完整已记录正文；Browser Client 验证完整传输和正文后，共享 `ModelOutputMessage` 再核对当前消息身份。正文不附预览／全文标题或查看／收起按钮，完整读取通过后才提供全文复制。失败或取消的输出保留已记录的未完成正文及明确提示，不能借此批准 Tool calls；普通会话不展示原始工具调用详情或 reasoning 正文，读取仍核其原长度。

明确 profile restore 后当前 Store B只负责 Cookie/页面准入，原会话及 sealed Fork正文保持 Store A出处。[Core Model snapshot](../../packages/agent/src/storage/sqlite/model-output.ts)在一致读事务核真实 Execution／Run／Command／rootWork、原 Model Message与private output head，再核原 scope完整 Artifact；[Browser reader](../../packages/client/src/browser.ts)核当前 Store、准确 source Session／Execution与完整 EOF/hash。Web只在此 `model_outputs` reader具备时提供共享组件的 `canReadRestoredOrigin`，沿 sealed originMessage原 Session/Run读取，不从有限View目录推导原来源。组件仍核当前 Store、原 Session／Run／Execution、状态、完整性、实际 UTF-8 content/reasoning长度与 Tool数量；未具备该证明的共享宿主缺省拒绝foreign origin。没有新增 Core/API、重标原来源或旧工作的执行权。

关闭页面、隐藏、bfcache 暂停或会话切换释放所属读取与当前视图全文，迟到响应不得覆盖新选择，不关闭 Runtime；恢复可读后沿原身份读取。全文不进入阅读位置记忆或跨会话缓存，Copy conversation 只采用当前已核实显示的正文，不把有限预览当全文。缺能力或格式不支持时保留原文和必要说明，真实失败通过共享组件的显式 `autoReadRetry` 提供“重新读取”的只读重试，不自动重试或提交任务。[页面 DOM 测试](test/page.test.tsx) 覆盖自动读取、全文复制及跨会话清除；共享 [Model output 测试](../../packages/ui/test/model-output.test.tsx) 另覆盖超过 17 MiB 正文、迟到／隐藏／身份失败。这些 DOM 证据不替代实际 Browser、Native bridge 或完整发行入口资格。

[真实恢复页面整例](../../tests/isolated/unified-agent/restored-web-model-output.test.ts)通过公开 Fork、backup/restore A→B、两次全新 Service与实际 Cookie BrowserClient挂载正式 `mountWebPage`。原会话／sealed大正文、inline小回答、原完整 Tool call 的读取完整性、全文 Copy／切换与错误源读取分别核实；原 Message/sourceIds/originMessage、Run、Command、Execution与 metadata准确相等，读取全GET、Model保持2次、Tool效果保持1次、cold Model新增0。页面为JSDOM、clipboard为内存端口；实际Core/HTTP与DOM组合不代证新的原生浏览器或installed窗口。准确红绿、22完整文件／122项／1605Bun断言及复用范围归[恢复正文进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-web-完整-model-正文)。

目录读取使用 Browser `listAllWorkspaces/listAllSessionDirectory`，workspace过滤在服务端分页前执行，穷尽固定首分配上界的所有具名页后再发布结果；新增晚项目不混入原上界。Session摘要额外固定原snapshotCursor，变化由SDK丢弃全部前缀并有限重扫，持续变化明确失败。缺activity capability或摘要也明确失败，不降级生成状态。该完整观察不ACK、恢复、取消或授予执行权，Client／Core／HTTP及Store格式没有本轮改动。


## API Docs 导航

页面 header 的 `/api-docs` 是同源只读文档导航。新 Service Gateway 从本构建的生成规范提供路径/方法、可展开完整 JSON 与 `/openapi.json`，无在线调用、凭据或外部文档加载；paired开发Web与显式daemon共用这一提供者。浏览器访问文档仍受原Gateway Host/Origin与关闭准入约束，关闭页面不停止Service。真实编译daemon测试已核返回规范与该构建生成JSON一致且不含Native token；该有限接口不代替完整客户端与发行退出资格。

## 按需 Runtime logs

私有 [Runtime logs](src/runtime-logs.tsx) 使用 Browser 公共 `listSessionLogs` 与 `session_logs` capability，只读当前准确 Store/Session 的 metadata。打开、显式刷新或 Load more 才读取，不轮询。第一页从 afterCursor=0 冻结真实 upperCursor，后续沿原上界与本页最后 cursor；原 scope、Decimal64 顺序、重复/不推进游标、上界漂移和 replayFloor 冲突均拒绝，不发布部分新页。过期 cursor 显示实际 `cursor_expired`，不自动跳过保留边界或重放执行。

每页最多 200 条及 512KiB，面板缓存最多 1000 条及 2MiB UTF-8 metadata，达到上限明确显示未读完；显式刷新开始新首页观察，失败保留同目标完整旧内容并标 stale。顺序、真实时间、类别、状态、摘要及有限 details 按原字段展示；NULL time/status 显示未知，不补当前时间或执行终态，不暴露事件 payload。它不是完整数据库转储或无限日志备份。

关闭、隐藏、页面暂停、切换 Session 或读取消只 abort 所属读取，迟到响应不能覆盖新目标，也不取消 Runtime。准确 `modelExecutionId` 的条目可进入既有 Model inspector，Session/Execution 绑定原日志，确认前不读正文；普通摘要不能推导 Model ID。宽度、目录与原 History/Context/Job 面板保持各自状态。此面板没有业务 POST、Provider、ACK、审批或恢复动作。

[Runtime logs DOM 测试](test/runtime-logs.test.tsx) 使用公共 Browser port，验证冻结上界、NULL metadata、错 scope/重复 cursor/closed details、stale 保留、取消/隐藏/暂停/迟到隔离、准确 Model 目标与第二次确认以及缓存预算。fake port 与 JSDOM 只证明控制器/DOM 行为，实际 Cookie Service/SDK 证据由公共接口所属资格独立核对，不代表原生浏览器或完整安装资格；正式启动路由按本页入口调用链核实。

2026-10-03 本机 Codex In-app Browser 使用实际编译 Web、Cookie Gateway、Service/SQLite 与[所属预览夹具](../../tests/fixtures/unified-agent/web-preview.ts)复核日志和目录交互。新增真实事实使 cursor 从 36 到 46，已冻结日志仍保持 36，显式刷新后才显示新增项。实际 pointer/键盘调整、重载偏好、折叠恢复，以及 620×800 窄屏顶栏焦点的 Escape 均核对；首轮现场失败促成这一 Escape 修复，三文件 17/192 邻接通过。

后续实际 1280×800 页面有 45 条日志、两个成功 Job，展开原 Model 行后打开准确输入确认，再次确认才完整读取原 189 字节请求及 sealed 来源/授权 metadata。观察前后仍是原 3 次 Provider 调用、4 条消息、2 个 Run 和4个 Execution，cursor 保持45，页面关闭后所属进程退出。截图只在本次工具中展示，未生成独立保存图片。该资格限这次本机浏览器现场和默认源码 Service，源码外 installed、其他浏览器/平台及正式旧 launcher 仍需独立证据。

## File checkpoints 只读观察

[File checkpoints](src/file-checkpoints.tsx) 仅使用 Browser 公共 `file_checkpoints` capability 与三个具名 GET reader：`listFileCheckpoints`、`getFileCheckpoint`、`getFileRestoreStatus`。当前 Store/Session/Workspace、selection 与 control revision 固定为本次面板观察；切换、关闭、隐藏或暂停 abort 所属读取，迟到 success/error 不发布到新目标。浏览器不提交自报 Store/Workspace 权限，也没有任意 Extension Query、Action、恢复、批准、下载或 open-file 入口。

目录每页 200 项，显式 Next page 沿原 keyset cursor 读取，可有真实末空页；不裁剪首 N 项，不把跨页目录称为冻结 snapshot。当前观察 scope 与 checkpoint 的原 boundary 分别显示：fork 来源可保留原 Store/父 Session/Workspace/Run/selection/message/trigger，来源 ID 不变为当前授权。详情须与原目录同点、同 physical workspace 与完整 boundary 一致；preview 的 `restore/remove/unchanged/conflict/unavailable`、准确 reason、original/expected baseline 与 preimage metadata 按原字段展示。protected 可实际为 conflict，不另改状态；metadata 不提供正文或媒体读取权限。

restore-status 需要用户明确输入原 restore ID，只读该点的原 journal/carrier。旧 blocked 的 head/file revisions、v1 和 v2 原字段分别保留，v2 的 `rootWorkSeq`/nullable expected/confirmedPost 不补入 v1；journal phase 与实际 carrier status/result revision 分栏，`restored` 不冒称 carrier 成功。网络或身份失败保同目标旧 metadata 并标 stale；首读失败显示 unavailable，不称空目录。面板完整 metadata 缓存有明确 8MiB UTF-8 私有展示预算，超限保旧并明确 unavailable，不截断正文或目录；它不是服务端 task quota。

[专属 reader/DOM 测试](test/file-checkpoints.test.tsx) 使用生成公共 DTO、有限 fake Browser port 与 React/JSDOM，覆盖 200+1+末空页、跨 fork 来源/当前观察、完整原点绑定、scope/游标冲突、同目标 stale、超预算不裁剪、selection/revision/关闭/隐藏与迟到隔离、准确原 restore ID、legacy blocked 和 journal/carrier 独立事实。当前全 Web 邻接 8 files/51 tests/469 assertions、类型与实际 build 通过；这些证据只证明便携 reader/DOM 与编译，不代替独立实际 Cookie Gateway/SDK、原生浏览器现场、恢复执行或正式旧 launcher 迁移资格。

2026-10-04 独立[实际浏览器夹具](../../tests/fixtures/unified-agent/web-file-checkpoints-preview.ts)使用 fresh public terminal builder、packaged default Service child、owned Profile、固定 loopback Provider 和该 candidate 的完整校验 Web assets，在本机 Codex IAB 复核两 Run/两原点目录、详情及明确原 restore ID 的 v2 journal/carrier。实际独立 Ask 批准后原 250003 字节文件恢复，浏览器只读取 metadata；关闭与切 Session 的两个延迟真实 GET 被 abort，释放旧响应后另一 Session 仍是空目录。读取前后 Provider=8、cursor=124、messages=16、Runs=2、Executions=15、原 write effects=4、原文件 hash/存在性及完整 journal/carrier 全部相同。第六轮在当前 candidate `terminal-740167cc1d7bf19d175e99ae8ce39f30c553315bd5791889b9cfd7a33de8bcad` 核完整现场与 abort；第七轮再次 fresh build 得到同一 digest，复验目录/detail/status、before/after 等值及 stop 自动退出0。夹具保留前期失败日志，串行事实读取并完整关闭 owned HTTP/SQLite/child；没有拓宽原 deadline。这是当前同 Store/S/W 的本机现场证据，不冒称 fork/newStore 浏览器现场、完整恢复执行界面、源码外正式安装、其他浏览器/平台或完整 V1.3 切换。


## 完整后台执行与子会话观察

正式 [Background executions](src/background.tsx) 使用 Browser `listAllBackgroundExecutions`，固定当前 Workspace/root Session，沿原上界和 snapshotCursor 读完所有公共 Job metadata。首选会话时读取，之后由 Refresh background executions 明确重读，不复用有限 View 的最近 Execution 列表，也不随 History 轮询。失败保留同目标完整旧目录并标 stale；隐藏、暂停或切换取消所属读取，迟到结果不能覆盖新会话。目录保原 Store/Session/Execution/Run/result revision/delivery，实际 childSession/childRun 保原关系。子会话链接沿准确 childSession.id 进入原 History 路由，不创建会话或授予控制。

只把准确 childSession 关系显示为子 Agent；固定 `shell.command@1` 可显示 Shell，其他 Job/service 保原 definitionId，不按 label 推测分类。公共目录未记录 cleanup confirmation 或输出 highWater，因此显示 unavailable，不由 succeeded 推断已清理。目录 seq 明确是 keyset 游标，不当作输出游标；每个准确原 Session/Job 可显式读取完整已保存 output，沿公共 `ExecutionOutputPages` 核连续覆盖和真实缺口后显示原 highWater。关闭、隐藏、暂停和换会话清除所属正文并取消 GET；没有 stop、steer、cancel、approval 或恢复动作。

会话目录现在按原 activity 在行尾显示活动旋转图形或“待用户输入”，待输入优先；失败或隐藏期间的旧事实显示“上次读取”，不保留实时运行暗示。[后台 DOM 测试](test/isolated/background.test.tsx)核原身份、准确子链接、完整输出、stale 与暂停迟到；[目录 DOM 测试](test/isolated/session-directory.test.tsx)新增徽标优先及旧观察断言。[实际 Cookie 测试](../service/test/isolated/development-web.test.ts)沿真实 Service/SQLite 创建原 Job 和 child，核完整目录、child History、原输出、拒绝 authority 注入及零业务重放。DOM/fake-port 与本机 HTTP 证据不替代原生浏览器、OS 剪贴板或安装平台资格。
