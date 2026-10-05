# Web 只读调用者

`apps/web` 是新 HTTP 公共契约的浏览器观察 owner，交付[条件读取控制器](src/controller.ts)、[React 只读页面](src/page.tsx)与[同源 mount](src/mount.tsx)。Service 宿主可装配实际可信资产，正式旧 Web launcher 尚未切换。产品预期见 [Web 手册](../../docs/handbook/clients/web/README.md)，当前差距继续由[统一进度](../../docs/plans/unified-agent-refactor-v1-progress.md)登记，不能以本切片冒称完整产品。

浏览器使用 [Client Browser 子入口](../../packages/client/src/browser.ts)，同源 HttpOnly/SameSite cookie 与固定页面身份。Native bearer/profile 路径不进入浏览器。开发 Service 的[有限只读 Gateway](../service/src/development-web.ts)拥有 listener 和可读投影；只转发目录、所选会话状态、分页 History、当前选择 Context、准确 Job output 和原 Model input，写入、审批、取消、SSE、配置/凭据与任意路径不转发。关闭页面或观察器只释放读取和浏览器访问，不取消 Session，也不关闭执行 Service。

`WebController` 仅轮询可见的所选活动会话，默认 2000ms，同一次读取为 single flight。切换 Session 和 document 可见性取消所属读取，迟到 success/error 不能覆盖新选择。失败保留同一选择的完整旧 snapshot 并标 stale；首次失败显示 error，不能伪装为空历史。状态依据真实 `Run.isActive`，不从字符串标签猜运行权。

每次 History 用 Session 已分配上界和最多 200 项页面读取完整前缀，核对准确 Session、Decimal64 顺序、分页推进和最终 Store/selection/control revision/snapshot cursor。冲突时不发布 partial ready。当前便利 snapshot 返回整份消息数组，每次完整重读，且最终 global snapshot cursor 变化会要求再次读取；大历史、并发活动和内存性能资格尚未由本地小规模回归证明。没有持久离线缓存或第二业务状态机。

[控制器测试](test/controller.test.ts)使用 fake Browser 公共 port，验证 200+1 完整页、最后分配序号、scope/快照冲突、可见性/活动/单飞、迟到身份和 stale；[DOM 页面测试](test/page.test.tsx)通过 React/JSDOM 验证目录导航、全部历史、真实 cancelled/outcome_unknown、旧快照保留、页面可见性、后退/根导航、迟到响应与拒绝身份。它们不是原生浏览器资格。[真实 Service 测试](../service/test/isolated/development-web.test.ts)使用固定 Model、临时 SQLite、真实 partial、Cookie Gateway 与 HTTP，验证零业务写和页面关闭时原工作继续。当前为本机 macOS 证据，不代表安装或三平台发行。

页面只在 cookie 身份准入成功后读取目录。工作区展开时读取所属根会话，默认显示 5 条，再显示 10 条；不补造服务没有给出的排序字段或活动状态。会话路由使用 `/sessions/<id>`，popstate 与直接链接由当前 controller 读取；回到根目录会清除选择及轮询。document visibilitychange 实际连接 controller，可见且实际 isActive 才定时读。页面卸载只释放所属观察器/目录请求；pagehide 另显式清理 browser cookie session，仍不取消 Runtime。续建和每读一次重试由 Browser SDK 处理，不从 UI 定时器补发。

消息按准确 seq 平铺为可选中的安全 Markdown，HTML/脚本不执行；incomplete、取消、失败与 unknown 保持各自实际状态，不推断最终回复或思考。目录宽度与窄屏行为见下方布局小节；Runtime logs 的按需 metadata 观察见下方独立入口，恢复点只读 metadata 观察见下方独立入口，仍无恢复操作；API Docs 由所属 Service Gateway 提供，见下文；原 Model input 检查器见下方独立入口，其正文读取仍独立确认。这些手册承诺仍待正式调用者迁移闭合，不能通过本 README 改写为已完成或永久删除。

## 目录布局

私有 [navigation](src/navigation.tsx) 只管理浏览器本地布局，不接收 Client 或执行身份。宽屏目录默认 200 px，可用 pointer 拖动分隔线调整至 420 px；窗口仍为宽屏时保留像素宽度，由内容区适应剩余空间。拖至 100 px 以下折叠，顶栏按钮重开并恢复最后合法宽度。导航 DOM 保持挂载，目录展开项、选中会话及 History/Model/context/Job 所属读取不因折叠或 resize 重建。

分隔线是可聚焦的垂直 separator，发布 200–420 的 ARIA 值；左右键每次调整 10 px，Home/End 到边界，Enter/Escape 折叠并将焦点返回顶栏按钮。640 px 及以下初始关闭目录，按钮打开覆盖侧栏；选择真实会话或按 Escape 关闭，焦点在顶栏关闭按钮时也有效并回到打开按钮。已有目录 handler 消费的 Escape 不重复执行。选择仍使用原 controller，宽窄屏切换不改变 Session 或执行权限。

同源 `kite.web.navigationWidth.v1` 只保存 200–420 的三位整数，不保存正文、路径、身份或折叠状态；未知、越界、非整数和 storage 拒绝均有限回退至 200 px，不读取旧客户端 preference。未完成的 pointer 操作遇到取消、窗口失焦、document 隐藏或页面暂停时回到操作前宽度，不保存中间值。静态 scoped CSS 随受 manifest 校验的 app.js 交付，不加载额外 URL 或 legacy 业务组件。

[navigation DOM 测试](test/navigation.test.tsx) 使用真实 DOM pointer/keyboard 事件，核边界、其他 pointer 隔离、折叠恢复、有限偏好、storage 拒绝、窄屏选择/Escape，以及原选中 History 与读取计数不变。它和现有实际 Cookie Gateway/Service 邻接资格分别证明展示交互与公共只读边界；JSDOM 不代表实际浏览器触摸、像素布局或多浏览器资格。

## 有限可信资产

[build.ts](build.ts)是显式构建宿主，不进入 browser source。build 将 React/Client/UI 离线打包为固定 `/app.js`，同时产出 `/index.html` 和 `/app.css`、`dist/manifest.json`、source-independent `dist/assets.js` 与 `assets.d.ts`。`@kite-ai/web/assets` 的 `getTrustedAssets()` 返回新 ReadonlyMap，`assetManifest` 保存每个固定 path/MIME/UTF-8 size/SHA256；类型入口是源码声明，不要求 clean checkout 已有 dist。宿主先调用公共 `validateTrustedAssets(assets,assetManifest)`，再将这个固定 Map 注入 Gateway，不提供任意目录、URL 或文件代理。

[制品测试](test/isolated/assets.test.ts)实际执行完整 build，将 assets module 复制到没有源码的临时目录后动态 import，按 manifest 核对固定路径、hash、metadata，并拒绝额外路径、内容损坏及重复项。构建不连接 Provider，不携带 cookie、Native token 或配置路径。Service library 不必依赖 Web runtime；Root 的显式开发入口决定何时 build/load 和装配。

验证入口：`bun run --cwd apps/web typecheck`、`bun run --cwd apps/web build`、`bun test apps/web/test`。新源文件加入[依赖边界检查](../../scripts/check-unified-agent-boundary.ts)、统一测试与 workspace build/typecheck。正式旧 Web 仍由 `apps/kite-web` 提供，退役条件未闭合。

2026-10-02 在 macOS 的实际 Codex In-app Browser 中用[本机预览夹具](../../tests/fixtures/unified-agent/web-preview.ts)复核了编译资产、真实 Service/SQLite、Cookie 准入、目录与直接会话链接、有效 GFM 表格与无脚本/自动图片、完整正文复制和 Cmd+A 的历史范围。A→B→A 恢复原 scrollTop，追加一条真实消息并显式刷新后仍保留该位置；原 Context 与 Job 三种输出均按需显示。首次现场发现运行时 AJV 编译被严格 CSP 拒绝，已改为构建时静态校验器并实际重验。该证据覆盖本机默认窄视口，不能代替其他浏览器、尺寸矩阵、Electron 或正式 launcher 资格。


会话正文现使用公共 UI `SafeMessageMarkdown`，保留完整消息并按 GFM 排版。原 HTML 显示为转义文本、图片仅显示替代文字、相对文件路径不启动本地编辑器。正文与消息阅读列同宽，不添加独立限宽或内边距；非消息区不可选中。

History 为独立滚动区域，首次进入定位最新，向上阅读时刷新保持原位置，可显式回到最新。会话内复制仅包含当前已展开的原消息正文；Cmd/Ctrl+A 限于当前 History，输入、textarea、select 与 contenteditable 不劫持。工具详情使用原消息 ID 独立展开，不从名称猜测分类或 Turn。页面内最多保留 32 个会话的滚动 metadata，每会话最多 256 个展开 ID，不保存旧正文；返回会话重读实际接口后恢复位置和展开。重载不承诺恢复。

DOM 测试验证 Markdown 安全与完整文本、复制范围、键盘范围、刷新/切换位置及工具展开；JSDOM 的模拟 scroll 数值和 Range 证据不代表原生浏览器选区、实际布局或触控资格。正式浏览器体验仍由宿主独立验证。


## 按需只读诊断

[Diagnostics](src/diagnostics.tsx) 只接收主 WebController 已选择的 view，不另行读取或猜测当前 Session。一个活动面板只保存同目标最后一次完整 snapshot；打开、显式刷新才读取，不后台轮询。缺 context/execution_output capability 时入口禁用，原 Store 与页面身份不匹配在本地拒绝。关闭、隐藏、切换 Session/selection 或卸载 abort 面板所属请求，既不关闭共享 Client，也不取消 Runtime。

Current selected context 显示当前选择、完整消息与原 result source 身份；它不是一次 Model 实际输入 Inspector。首次响应封存 highWaterSeq 和 selection，两条 cursor 独立穷尽，全部成功才发布；结束的消息流固定 afterSeq=upper，来源流保最后真实 ID。现公共接口没有禁用已结束 stream 的字段，后续页面可能仍读取其空投影；本地不重新追加该流，不承诺服务器停止扫描。selection/scope/重复或不前进游标冲突不会发布部分结果。

Job output 仅从当前 view 的实际 kind=job ID 进入，不能从 Tool 名称猜 Shell。首响应封存 output highWaterSeq，严格 Decimal64 顺序读取至该上界，保 stdout/stderr/progress、准确 seq/throughSeq、droppedBytes（NULL 表示 clipped interval 的字节数不可用）。按全局 interval 覆盖核缺口；per-stream coalesced gap 可跨越另一个 stream 的保留 chunk，也可与另一个 stream 的 gap 重叠，原记录全部保留。下一游标取本页所有 throughSeq 的最大值，不取排序末项；同 stream 冲突、重复普通 chunk、缺口或提前 EOF 拒绝，不把缺内容显示为完整输出。它不是完整 Runtime 事件日志，不补造退出码。刷新失败保同目标结果并标 stale；换目标立即清除旧正文。

[test/diagnostics.test.tsx](test/diagnostics.test.tsx) 使用 fake 公共 Browser port 和 React/JSDOM 验证双分页、原身份、Decimal64 超过 2^53 的区间、gap NULL、singleflight、scope/conflict 拒绝、同目标 stale、局部能力缺失、关闭/隐藏/切换 abort 与迟到结果隔离。真实 Gateway 接口由 Service 测试核对；这里不冒称真实浏览器布局、滚动或完整日志/Model Inspector 迁移完成。


bfcache 的 `pagehide.persisted` 保留现有 React document、选择和阅读 metadata，同步提交暂停状态：只 abort 本页目录、History 与诊断所属读取，不关闭共享 Client、Cookie session 或 Runtime。返回时 `pageshow.persisted` 先对 BrowserClient 原 page/instance/build/Store 身份重新 connect 核对，成功才解除暂停并刷新当前选择；失败保留旧正文并显示身份错误，页面保持 inert，不自动采纳新后端。反复 pagehide/pageshow 的迟到身份响应受本地代次核对。非 persisted pagehide 沿原清理行为 unmount 并尝试关闭 Browser session；它不停止 Service。DOM PageTransitionEvent 测试覆盖暂停、确认前零业务读取、原位置、错误身份不复活与真正离开清理；bfcache 实际浏览器返回资格由 Root 另测。

## 新开发 Web 宿主入口

[scripts/development/unified-web.ts](../../scripts/development/unified-web.ts) 将已构建的 `apps/service/dist/main.js`、公共 paired bootstrap 和本包可信资产组合成前台只读 Browser Gateway。开发入口命令为 `bun run scripts/development/unified-web.ts`；根 `web:dev` 由根集成 owner 指向该命令。启动前须显式构建 Service 和 Web，不在运行时构建、回退源码或发现旧 daemon。

缺省选择独立的 `.kite-code/unified-development` dataRoot 和 `development` profile，不读取旧 profile。唯一可选参数为 `--data-root <absolute-path>`；不接收 token、任意 entrypoint、环境权限或 Provider 配置参数。启动选择先固定 profile/API/capabilities/instance；buildId 是所选 Service entry 文件字节的 SHA256，仅代表开发 entry 身份，不代表完整发行 candidate 身份。Native bearer 只走 paired 私有 bootstrap，stdout 仅一行 Browser endpoint，错误只输出有限错误码；不会打印 token 或 profile 路径。

浏览器关闭只释放其访问；前台宿主的 stdin EOF、SIGINT 或 SIGTERM 则关闭自己拥有的 Gateway 和 paired Service。stdin 是存活信号，不接受凭据或指令。Service 意外退出也关闭 Gateway，不保留指向旧身份的 listener。该入口没有 detach、旧 daemon 发现或正式安装生命周期；`server`、`kite web`、TUI、Electron 与旧发行入口继续由各自原 owner 维护，不能以此声明它们已迁移或退役。

[隔离 launcher 测试](../../tests/isolated/unified-agent/web-launcher.test.ts) 在临时 profile 使用真实 paired Service、SQLite、固定 Model、Cookie Gateway 与外部宿主进程，证明错误资产启动前拒绝、零启动 Model、浏览器关闭时原工作继续、EOF/信号准确清理所属 PID/listener和 endpoint-only stdout。2026-10-02 macOS 本机 loopback 实测 4 tests / 46 assertions；不连接付费 Provider。该测试使用已有构建资产，不代替 Root 的统一构建、源码树外制品或安装平台资格。

## 原 Model 输入检查器

[Model calls / Original Model input](src/model-input.tsx) 是独立于 History 和 Current selected context 的只读诊断入口。它通过 Browser 公共 `listModelInputs` 穷尽固定 upperSeq 目录，支持第 201 次及之后的原调用；观察 snapshotCursor 可以变化，不替代目录上界。点击准确 executionId 后先确认敏感内容，确认前不请求正文。成功输入按原序展示 System、所有 Messages、Tool call/source IDs、完整工具描述与 Schema；不会从当前配置或 History 拼接请求。

正文使用公共 `getModelInput` 的完整 EOF/hash/准确身份验证结果，未完整成功不显示前缀；模型成功未确认时明确标 unconfirmed，不能据此声称 Provider 已收到请求。每次调用有封存 metadata 时显示实际 Adapter/Provider family/model、受支持 settings、准确 Extension/Tool namespace 和版本、来源 ID/digest、转换标识及最终授权 revision/controlReads；中立 policy 解释按原 JSON 展示，不从当前配置取值。opaque Adapter/Provider、未记录或未来静态版本、未派发授权分别明确 unavailable；已知派发事实不会因 policy 解释缺失而丢失。不显示凭据、endpoint、内部 Artifact 元数据或 Provider 响应，也不声称已经完整记录私有传输配置。关闭、隐藏、会话切换与 bfcache 暂停 abort 面板所属读取并清除正文，迟到响应不能覆盖新调用；只保留打开面板的本地目录身份，不持久缓存正文，不取消 Runtime。恢复可见后须再次明确读取，不后台轮询 Model 输入。

[test/model-input.test.tsx](test/model-input.test.tsx) 使用生成的公共 DTO、Browser port 与 React/JSDOM，验证 201 项目录、超过 17MiB 的完整正文尾部/System/Schema、确认门禁、single flight、scope/游标冲突、失败零前缀与关闭/隐藏/跨会话 late 隔离，以及封存 settings/装配/来源/授权在确认前不公开、确认后不被当前配置替代。这证明便携数据与 DOM 行为，不代替 Root 的真实 Service/Client 全文链路、原生浏览器布局或安装资格。Runtime logs 仅使用公共条目的准确 `modelExecutionId` 进入此检查器，仍需第二次确认才读取正文；本入口不宣称正式旧 launcher、TUI 或 Electron 完成迁移。

## 原 Model 输出全文

History 的公开 `outputBody` 只表示原输出身份与完整性/长度，默认正文明确标为预览。具备 `model_outputs` 能力时可显式读取原 Session/Execution 的完整已记录正文；Browser Client 验证完整传输和正文后，共享 `ModelOutputMessage` 再核对当前消息身份。成功输出显示完整正文；失败或取消的输出只能显示完整已记录的不完整前缀，不能借前缀批准 Tool calls。完整调用放在可展开区域；会话阅读按手册不展示原 reasoning 正文，全文读取仍校验其原长度。

关闭、页面隐藏、bfcache 暂停或会话切换释放所属读取与当前视图全文，迟到响应不得覆盖新选择，不关闭 Runtime。全文不进入阅读位置记忆或跨会话缓存；Copy conversation 使用当前已显示的正文，关闭全文后回到明确预览，不将 4096 字符预览冒充全文。缺能力保留可读预览和禁用按钮。[页面 DOM 测试](test/page.test.tsx) 覆盖显式读取、全文复制、关闭与跨会话清除；共享 [Model output 测试](../../packages/ui/test/model-output.test.tsx) 另覆盖超过 17 MiB 正文、迟到/隐藏/身份失败。这些 DOM 证据不替代实际 Browser、Native bridge 或完整发行入口资格。

目录读取现使用 Browser `listAllWorkspaces/listAllSessions`，穷尽固定首分配上界的所有具名页后再发布结果。workspace 过滤在服务端分页前执行，不能在首页 100 项之后过滤而遗漏后续会话；新增晚项目不混入原上界。切换、隐藏或 dispose 使用所属 AbortSignal，失败保留准确错误而不发布不完整目录前缀。分配上界不冻结后续标题/删除变化；当前开发页按实际分配顺序展示，不冒称手册要求的更新时间排序/5+10分批展示已迁移。


## API Docs 导航

页面 header 的 `/api-docs` 是同源只读文档导航。新 Service Gateway 从本构建的生成规范提供路径/方法、可展开完整 JSON 与 `/openapi.json`，无在线调用、凭据或外部文档加载；paired开发Web与显式daemon共用这一提供者。浏览器访问文档仍受原Gateway Host/Origin与关闭准入约束，关闭页面不停止Service。真实编译daemon测试已核返回规范与该构建生成JSON一致且不含Native token；此切片不完成旧正式Web迁移。

## 按需 Runtime logs

私有 [Runtime logs](src/runtime-logs.tsx) 使用 Browser 公共 `listSessionLogs` 与 `session_logs` capability，只读当前准确 Store/Session 的 metadata。打开、显式刷新或 Load more 才读取，不轮询。第一页从 afterCursor=0 冻结真实 upperCursor，后续沿原上界与本页最后 cursor；原 scope、Decimal64 顺序、重复/不推进游标、上界漂移和 replayFloor 冲突均拒绝，不发布部分新页。过期 cursor 显示实际 `cursor_expired`，不自动跳过保留边界或重放执行。

每页最多 200 条及 512KiB，面板缓存最多 1000 条及 2MiB UTF-8 metadata，达到上限明确显示未读完；显式刷新开始新首页观察，失败保留同目标完整旧内容并标 stale。顺序、真实时间、类别、状态、摘要及有限 details 按原字段展示；NULL time/status 显示未知，不补当前时间或执行终态，不暴露事件 payload。它不是完整数据库转储或无限日志备份。

关闭、隐藏、页面暂停、切换 Session 或读取消只 abort 所属读取，迟到响应不能覆盖新目标，也不取消 Runtime。准确 `modelExecutionId` 的条目可进入既有 Model inspector，Session/Execution 绑定原日志，确认前不读正文；普通摘要不能推导 Model ID。宽度、目录与原 History/Context/Job 面板保持各自状态。此面板没有业务 POST、Provider、ACK、审批或恢复动作。

[Runtime logs DOM 测试](test/runtime-logs.test.tsx) 使用公共 Browser port，验证冻结上界、NULL metadata、错 scope/重复 cursor/closed details、stale 保留、取消/隐藏/暂停/迟到隔离、准确 Model 目标与第二次确认以及缓存预算。fake port 与 JSDOM 只证明控制器/DOM 行为，实际 Cookie Service/SDK 证据由公共接口所属资格独立核对，不代表原生浏览器或正式 launcher 已迁移。

2026-10-03 本机 Codex In-app Browser 使用实际编译 Web、Cookie Gateway、Service/SQLite 与[所属预览夹具](../../tests/fixtures/unified-agent/web-preview.ts)复核日志和目录交互。新增真实事实使 cursor 从 36 到 46，已冻结日志仍保持 36，显式刷新后才显示新增项。实际 pointer/键盘调整、重载偏好、折叠恢复，以及 620×800 窄屏顶栏焦点的 Escape 均核对；首轮现场失败促成这一 Escape 修复，三文件 17/192 邻接通过。

后续实际 1280×800 页面有 45 条日志、两个成功 Job，展开原 Model 行后打开准确输入确认，再次确认才完整读取原 189 字节请求及 sealed 来源/授权 metadata。观察前后仍是原 3 次 Provider 调用、4 条消息、2 个 Run 和4个 Execution，cursor 保持45，页面关闭后所属进程退出。截图只在本次工具中展示，未生成独立保存图片。该资格限这次本机浏览器现场和默认源码 Service，源码外 installed、其他浏览器/平台及正式旧 launcher 仍需独立证据。

## File checkpoints 只读观察

[File checkpoints](src/file-checkpoints.tsx) 仅使用 Browser 公共 `file_checkpoints` capability 与三个具名 GET reader：`listFileCheckpoints`、`getFileCheckpoint`、`getFileRestoreStatus`。当前 Store/Session/Workspace、selection 与 control revision 固定为本次面板观察；切换、关闭、隐藏或暂停 abort 所属读取，迟到 success/error 不发布到新目标。浏览器不提交自报 Store/Workspace 权限，也没有任意 Extension Query、Action、恢复、批准、下载或 open-file 入口。

目录每页 200 项，显式 Next page 沿原 keyset cursor 读取，可有真实末空页；不裁剪首 N 项，不把跨页目录称为冻结 snapshot。当前观察 scope 与 checkpoint 的原 boundary 分别显示：fork 来源可保留原 Store/父 Session/Workspace/Run/selection/message/trigger，来源 ID 不变为当前授权。详情须与原目录同点、同 physical workspace 与完整 boundary 一致；preview 的 `restore/remove/unchanged/conflict/unavailable`、准确 reason、original/expected baseline 与 preimage metadata 按原字段展示。protected 可实际为 conflict，不另改状态；metadata 不提供正文或媒体读取权限。

restore-status 需要用户明确输入原 restore ID，只读该点的原 journal/carrier。旧 blocked 的 head/file revisions、v1 和 v2 原字段分别保留，v2 的 `rootWorkSeq`/nullable expected/confirmedPost 不补入 v1；journal phase 与实际 carrier status/result revision 分栏，`restored` 不冒称 carrier 成功。网络或身份失败保同目标旧 metadata 并标 stale；首读失败显示 unavailable，不称空目录。面板完整 metadata 缓存有明确 8MiB UTF-8 私有展示预算，超限保旧并明确 unavailable，不截断正文或目录；它不是服务端 task quota。

[专属 reader/DOM 测试](test/file-checkpoints.test.tsx) 使用生成公共 DTO、有限 fake Browser port 与 React/JSDOM，覆盖 200+1+末空页、跨 fork 来源/当前观察、完整原点绑定、scope/游标冲突、同目标 stale、超预算不裁剪、selection/revision/关闭/隐藏与迟到隔离、准确原 restore ID、legacy blocked 和 journal/carrier 独立事实。当前全 Web 邻接 8 files/51 tests/469 assertions、类型与实际 build 通过；这些证据只证明便携 reader/DOM 与编译，不代替独立实际 Cookie Gateway/SDK、原生浏览器现场、恢复执行或正式旧 launcher 迁移资格。

2026-10-04 独立[实际浏览器夹具](../../tests/fixtures/unified-agent/web-file-checkpoints-preview.ts)使用 fresh public terminal builder、packaged default Service child、owned Profile、固定 loopback Provider 和该 candidate 的完整校验 Web assets，在本机 Codex IAB 复核两 Run/两原点目录、详情及明确原 restore ID 的 v2 journal/carrier。实际独立 Ask 批准后原 250003 字节文件恢复，浏览器只读取 metadata；关闭与切 Session 的两个延迟真实 GET 被 abort，释放旧响应后另一 Session 仍是空目录。读取前后 Provider=8、cursor=124、messages=16、Runs=2、Executions=15、原 write effects=4、原文件 hash/存在性及完整 journal/carrier 全部相同。第六轮在当前 candidate `terminal-740167cc1d7bf19d175e99ae8ce39f30c553315bd5791889b9cfd7a33de8bcad` 核完整现场与 abort；第七轮再次 fresh build 得到同一 digest，复验目录/detail/status、before/after 等值及 stop 自动退出0。夹具保留前期失败日志，串行事实读取并完整关闭 owned HTTP/SQLite/child；没有拓宽原 deadline。这是当前同 Store/S/W 的本机现场证据，不冒称 fork/newStore 浏览器现场、完整恢复执行界面、源码外正式安装、其他浏览器/平台或完整 V1.3 切换。
