# Desktop 与 Native 制品

普通 Workspace／明确外部路径写入的完整快照同样复用消息内交付卡。外部文件只提供原交付的阅读，不借用 Workspace 的编辑器打开权限。2026-10-23 最新 Main／交付 DOM 两文件12项118断言通过；工作文件删除、改动不改变原快照，中文跨页仍完整。受控浏览器中 Plan 修订为版本2后，选择 Auto 并批准，原待审卡退出、原轮次继续结束；此结果不外推 TUI／安装版资格。

会话文件已接入 Main 字节准备、稳定导入、原消息绑定及后续 [Files 读取](../../packages/agent/src/tools/files/README.md)；输出和 Plan 的准确会话文件可由现有文件入口打开。下述受控页面、IPC 合同与真实 Node 冷查分别证明其覆盖的路径，不替代完整 Electron 安装制品或其他平台资格。

会话输出在对应工具消息提供“查看本次交付的文件”。[历史 reader](electron/file-changes.ts)核原 succeeded Execution、原结果 revision、scope、Artifact 成员及完整 hash／size，按完整 UTF-8 边界返回每段至多64KiB；界面提供续读和回到开头，当前文件被改动或删除也不改旧版本。“打开当前文件”仍单独走原编辑器路径及准确登记重核。历史读取目前沿 Client 完整 Artifact reader 后分页 IPC，不宣称流式磁盘分页或大文件内存限额。

PDF 工具页图复用 [图片 reader](electron/input-image-reads.ts)及 [NativeUserImages](src/native-user-images.tsx)：Main 只接观察到的完成 Tool 消息和索引，核原执行、最多4个 PNG 引用及16MiB总量，renderer 不能指定任意引用或路径。后继轮次、Fork 与冷历史按原来源读取，预览缓存只负责显示，不承担历史保存。只含一次读取的工具组也显示其页图。

2026-10-23，`ba34a2e6` 加本轮修复、同一 Windows 开发环境：实际页面观察复制中源文件变化的失败提示、准备中状态、显式取消保留草稿与后续重新添加。补正准备完毕但界面未接纳的生命周期：signal 保持到 `addFiles` 接管，失效输入或丢弃的晚结果释放准确 Main 项，已接纳附件不随准备结束删除。[准备 owner DOM 回归](test/isolated/native-input-files-dom.test.tsx)1项30断言和 [Composer 回归](../../packages/ui/test/isolated/prompt-editor.test.tsx)8项78断言通过。最新页面再次混选文本／PDF／图片，实际观察发送占位→一条持久用户消息→三次读取→页图与报告交付→终态；源文件删除后重载，原图片、页图和历史正文仍可读，没有重复消息或卡住。该观察使用上述隔离浏览器桥，仍不代证完整 Electron 安装窗口。

2026-10-23，`5c28cd1fd` 加当前会话文件工作树、Windows x64／Bun1.4.3：[会话文件浏览器夹具](test/session-files-browser-runner.fixture.ts)通过真实页面、Main 请求、HTTP、SQLite、Artifact 与受控模型逐步观察三种附件准备、删除临时源文件、发送占位接管、文本与 PDF 读取、页图、输出写入、进程关闭后重开及后继编辑。旧报告与修改后报告同时展开核对，各保原版本；过程未见重复消息。原 Plan 文件经普通 Files 修订后，审核显示相同修订正文和版本2。Main／DOM 历史交付与工具展示三文件23项284断言通过。夹具的传输桥、模型和私有 UI 数据端口是测试替身；不证明完整 Electron IPC、外部编辑器启动、真实模型识别或安装版资格。普通侧栏在此窄视口出现零宽现象，未计作通过；消息内交付阅读独立可用。

Desktop renderer的普通图标沿共享`--ui-icon-size:14px`，原16px的设置返回、设置分类及提供商页面SVG局部覆盖同步消费该变量；按钮点击区域、文字字号和原生窗口／托盘资源保持原规则。

产品展示名称统一为 **Kite**：共享侧栏、启动页、页面与窗口标题、关于菜单和原生提示使用相同大小写。原 `kite-native` 运行标识、workspace 包名、IPC 与本机偏好键保持，已有用户数据路径保持。

## Windows 托盘与窗口图标

[Main](electron/main.ts)在 Windows 启动时设置固定应用身份 `dev.kite-code.native`，使用 [Kite 原生图标](app-icon.ico)创建窗口和唯一托盘。双击托盘或选择“打开 Kite”恢复最小化的原窗口并显示、聚焦；普通关窗仍只隐藏。托盘“退出”调用原 `app.quit()`，复用活动工作确认及自有 Service 清理；取消确认保留托盘，确认退出后先移除托盘和窗口，再完成后台清理，退出期间不重新显示窗口。

ICO 沿用 [SVG](app-icon.svg)，包含 16、20、24、32、40、48、64、256px 图像。[构建入口](scripts/build-native.ts)在开发热更新与固定 renderer 两条路径共用的阶段复制图标，正式 Native 的现有完整文件清单自动包含该资源。托盘生命周期与安全退出回归沿用 [Main 夹具](test/isolated/native-main-scheduling-lifecycle.test.ts)；它验证主进程接线，不代替真实 Windows 通知区域操作。

2026-10-24，Windows x64（10.0.26300）／Electron44.3.0／Bun1.4.3：Main 回归30项352断言、Desktop typecheck、定向Biome与文档检查通过。普通 Main／生产 renderer 构建在独立 Profile、真实配套 Service 下正常启动并退出；随后仅在隔离测试制品加入私有观察端口，逐步观察关窗隐藏且托盘保留、投递 Tray 双击事件恢复并聚焦同一窗口、最小化后恢复，以及点击托盘原生菜单“退出”。最终 Main 退出0，准确所属 Service PID 已消失；观察记录在本机 `.cache/native-tray-live-20261024`。双击事件与菜单展开由该测试端口触发，原生菜单退出由实际 Windows UI 点击；没有取得通知区域物理双击／右键或完整安装包资格，不将该端口加入普通开发或正式客户端。

## Markdown 与附件输入

用户消息的图片和普通文件通过 `SessionPage.renderMessageAttachments` 从正文气泡中分离，由 [NativeUserImages](src/native-user-images.tsx) 接入[共享 Attachment 列表](../../packages/ui/src/desktop/MessageAttachments.tsx)，沿原文件后图片的顺序显示，超宽时横向滚动；正文、时间和复制归原消息。首次发送及已有会话发送冻结附件名称作为占位，接管前不再将图片数量写进正文，也不借用已被草稿释放的 blob URL；历史确认后由原图片 reader／缩略图缓存显示预览。原输入身份、图片暂存、文件引用、读取与失败重试不变。空正文且没有需显示的真实格式／读取状态时不创建正文内容。产品尺寸和操作归[桌面手册](../../docs/handbook/clients/desktop/README.md#提示词与附件)。

2026-10-23，Windows x64／Bun1.4.3、Chrome155.0.8059.85、`7af0dee6b` 加本次附件工作树：[图片浏览器夹具](test/image-previews-browser-runner.fixture.ts)的 `--attachments --observe` 在生产组件与样式中逐步观察深浅主题×1280／390px的发送占位→保存预览、滚动两端→键盘回翻、刷新→缓存切回、失败→仅附件→重开；正文位置、消息顺序、时间／复制数量和横向溢出均核对。发现并修正仅附件消息被空正文过滤、失败边框跨附件和窄屏焦点裁切；最终 `--attachments` 四组通过，并补核重开图片就绪与焦点轮廓。过程截图／报告位于本机 `.cache/image-previews-browser-SfuHgK`，最终复验位于 `.cache/image-previews-browser-Xpmahn`。[首条消息DOM回归](test/isolated/native-new-conversation-dom.test.tsx)70项通过，包含文字＋文件／仅文件的延迟选择与历史接管；图片读取、输入附件、消息复制及阅读滚动定向回归通过。此为隔离生产组件及受控桥接验收，未取得本轮完整安装版Electron、真实模型或其他平台资格；既有嵌套 `@keyframes` 编译提示保留。

消息内容通过[共享 Markdown renderer](../../packages/ui/README.md#markdown-消息内容)显示 Mermaid、语法高亮／diff、提示块、公式及消息内标题／脚注跳转。主消息、子详情与后台正文沿原 `NativeModelOutputMessage` 复用；本文不扩展 Web 或 TUI 的独立展示能力。公式语法已加入 Worker 的同一固定 parser，图表／KaTeX排版留在 renderer；纯Worker入口不引入DOM或可视化库，原CSP、Main IPC、完整正文核验与复制资格保持。

2026-10-25，macOS arm64／Bun1.4.2、Chrome155.0.8059.86、`ccd1201d5`加本次样式工作树：`bun apps/desktop/test/markdown-content-browser-runner.fixture.ts`通过1280／390px及深浅主题，核代码底色／无外框、行内代码小圆角／无底线、引用、五类提示图标和标题、链接悬停／键盘聚焦、输入编辑、准确源码复制与原图表恢复。五类提示标题对实际合成底色均至少4.5:1；表格原字号、内边距、网格与透明表头保持。实际浏览器逐步观察深浅切换、图表生成、流式开始→追加→完成及390px换行；同一500px视口下表格的样式和几何与改动前完全一致，代码和行内代码的原节点在追加／完成后保留。报告和过程截图位于本机`.cache/markdown-content-browser-I8m5Eq`。原`bun apps/desktop/test/streaming-render-browser-runner.fixture.ts`四组场景通过，核选区、手动阅读、缓存返回和完成状态，材料位于`.cache/streaming-render-Rs1qbD`；仅后续链接优先级与提示标题配色由前述内容夹具重新构建核实，未改变流式管线。六个Markdown／代码复制／正文复制／输入编辑／流式／滚动回归逐文件独立运行通过27项／1073断言，UI与Desktop typecheck、定向Biome及文档结构／影响检查通过。此为隔离生产组件与受控Native桥接验证，未重验完整安装版Electron或真实Service／模型；既有嵌套`@keyframes`编译提示保留。

2026-10-22，Windows x64／Bun1.4.3、`beabc9628` 加本次Markdown工作树：[内容浏览器夹具](test/markdown-content-browser-runner.fixture.ts)用生产Vite资产、原生产CSP和Chrome155.0.8059.85通过1280／390px，覆盖深浅主题、五类图表、未闭合围栏、错误后恢复、源码复制、脚注往返、读取暂停和会话缓存切回，未发起外部资源请求。实际逐步观察生成占位→图表、源码展开→切会话→恢复、错误→修正及主题变化，并修正默认阴影与小图放大；字体从本地资产加载。[纯Worker构建回归](test/native-markdown-build.test.ts)核新增公式树仍可在无document／window／Node的VM运行；组件与输入编辑证据归[UI owner](../../packages/ui/README.md#markdown-消息内容)。此为隔离生产组件验收，未取得本轮完整安装版Electron或其他平台资格；保留既有嵌套`@keyframes`编译提示。

2026-10-23 补充 Windows x64／Electron44.3.0 实际窗口验证：同一工作树通过 `buildNativeDesktop` 构建普通 Main／preload／生产 renderer，`testDiagnostics:false`，连接真实配套 Service、独立 Profile 与本机兼容 SSE Provider；没有使用开发 HMR 页面或用户配置。由普通输入框发送一次请求，人工逐段观察10段输出：未闭合行内公式保留原文，补全后排版；块公式增量补全正常；Mermaid 未闭合围栏显示源码，闭合后经过绘制提示成为流程图／时序图；追加正文与表格没有重复图表，表头下边线与其他表格边线一致。手动上滚稳定后追加内容保持阅读位置，返回最新恢复跟随；错误图表回退源码，后续合法图表与公式正常显示。完成时运行指示消失、复制按钮出现、正文保持一份；源码展开后切换会话再返回保留展开与阅读位置，深浅主题均可读。正常退出并冷重开后，原图表、公式与完成状态读回，Provider 总请求仍为1；两次 Main 均退出0，准确所属 Service PID 已消失。临时复现入口为本机 `.cache/native-markdown-live.ts`，分段输入与进程记录保留于 `.cache/native-markdown-live-20261022/events.json`；本次不新增生产代码改动。范围仅为当前 Windows 隔离构建的上述实际操作，不代表正式安装包、远端模型、其他平台或所有流式分段组合；此前浏览器与组件回归证据继续按原范围适用。

2026-10-23 主题色修正：用户指出流程图／时序图缺少主题色，确认原 adapter 将全部线条映射为正文色。现改为深浅主题各自的蓝色节点边框／箭头和青色生命线／辅助边框，继续透明底。`bun apps/desktop/test/markdown-content-browser-runner.fixture.ts` 在 Chrome155／1280与390px下通过；新增解码图像像素断言核对蓝色确实绘出、时序生命线有青色、背景主要透明及深浅切换，页面错误和外部请求为0。生命周期隔离回归1项／22断言、UI与Desktop typecheck、定向Biome通过。再用当前生产renderer、`testDiagnostics:false`、原独立Profile和真实Service构建Electron44.3.0窗口，冷读原消息并实际检查亮／暗流程图、时序图与主题切换：颜色更新，文字可读，阅读位置保持；切换后先保留旧图再异步替换，不承诺颜色与页面背景同帧变化。此增量只复验主题色，前述流式时序／冷读等证据按未变化范围复用，不据此扩大安装或平台资格。

产品操作见[桌面手册](../../docs/handbook/clients/desktop/README.md#提示词与附件)。[共享 Composer](../../packages/ui/src/desktop/Composer.tsx)按 MIME／图片扩展名分流。图片保留现有字节流程；普通 File 由 renderer 分块读取，每块至多 64 KiB，经闭合 IPC 交给 [Main 准备 owner](electron/input-files.ts)，不让 renderer 自报路径触发 Main 任意文件读取。每窗口最多 128 个准备项，单项及总量至多 256 MiB；显式取消、移除与换代终止所属准备并释放 Main 项，上传在途保留预算直到真实完成。

新会话先创建准确 Session，再将冻结准备项通过 Service 流式发布为 Artifact；稳定导入 ID 绑定 Store／Session／draft ID。ACK 丢失先 GET 原导入，同 ID 不重复创建逻辑附件。调用 journal 保存已准备引用，原 command 接纳事务完成绑定；未知提交保留原意图而不盲目重新发送。历史附件和占位仍使用原文件名，普通附件从此不依赖源路径。未发送草稿仍仅保窗口生命周期。旧路径附件不静默转换。

2026-10-23，`ba34a2e6d` 加本次会话文件工作树、Windows x64／Bun1.4.3：[普通附件 IPC 回归](test/isolated/native-session-files-ipc.test.ts)实际构建生产 preload，在 VM 中接入真实 Main handler、NativeCaller、Service HTTP、SQLite 与 Artifact，31断言通过。准确 sender、未完成／已释放／换代准备项和传入字节复制均核对；在实际 Windows Artifact 临时文件写入边界注入一次 ENOSPC 后，确认临时文件关闭并删除、输入导入与绑定均未形成、无 command／caller journal／模型调用、原文本草稿保持。解除故障后直接复用原准备 ID 和原字节重试，随后分别丢弃成功上传与 command 的 ACK，确认 GET 查回原导入，只有一次成功上传和一次 command POST。重建 caller 后首次 GET 再丢回执，第二次只查回原 command，原消息绑定、完整 Artifact 字节与模型调用数保持。此为实际链路写失败注入，不是物理磁盘满额资格；Electron 传输和此例私有 UI 数据端口为替身，也不代证完整 Electron 进程冷恢复。

[普通文件 DOM 回归](test/isolated/native-input-files-dom.test.tsx)接真实 Main 准备 owner，核活动 FileReader 上显式 AbortSignal 取消及 scope 换代均不 append／finish、不生成 ready 草稿，并释放准确准备项；重新选择随后成功。本例本轮1项30断言通过；[Main 字节回归](test/input-files.test.ts)的原预算与字节合同证据继续适用。取消后的用户全过程观察仍以上述浏览器证据为准。

[真实 Node 冷查](test/isolated/native-caller-journal-host.test.ts)使用 Node24.15.0、真实私有 SQLite journal 与 Profile 准入：原 `run.start` 携普通附件，在真实 HTTP 接纳后断开回执并强制退出 caller，冷进程首次 GET 再丢回执，后续只 GET 查回原 ID／摘要／scope，零重发；原附件绑定与字节仍可读。另两例核合法恢复活动 Run 后的 `input.steer` 原 ID 查回及已完成原公共 Run 的冷查，三例共102断言通过。冷重开本身不启动新模型或恢复业务效果。既有 `execution.cancel` 子进程夹具依赖 Unix Shell，在本机仍为 `shell_unavailable`；该独立平台限制不由附件或 command 查回测试取得资格。

[文件入口](electron/file-changes.ts)保留原消息／执行回执核验；默认读取版本增加 5，旧 3／4 保持可读。打开 Profile 中的输出或方案时，先通过当前 Session 的 Files／Planning 查询匹配准确绝对目标，再核实际目录身份、规范路径与单链接；其他受保护路径仍拒绝。历史预览与“打开当前文件”的含义分开，外部编辑不会改变原保存的预览。

开发热更新后的旧 preload 可能缺少 `fileReferences`，旧 Main 也可能拒绝图片暂存方法。[窗口适配器](src/native-input-images.ts)把原 `invalid_native_request/native_host_operation_unavailable` 识别为附件接口尚未加载；缺少文件路径解析 port 时以有限 `file_picker_restart_required` 错误交给共享 Composer，图片暂存直接保留明确的完全退出／重新启动提示。普通选择失败仍可重试，不展示原错误细节、不清草稿或重发。取消选择返回空列表。[窗口回归](test/isolated/native-input-images-dom.test.tsx)与[编辑器回归](../../packages/ui/test/isolated/prompt-editor.test.tsx)分别核旧协议、普通失败、取消和原草稿保持；主进程仍按原开发边界显式重新启动。

直接图片经[封闭 IPC](electron/native-ipc.ts)分块进入 [NativeInputImages](electron/input-images.ts)：每条输入最多 10 张，每张 16 MiB，窗口保留总量最多 128 张／64 MiB，核连续 offset、完整大小与 SHA-256。UI 在读取前拦截超量；[草稿 owner](src/native-input-images.ts)再次核已有与新增，IPC／Main 发布独立核每次输入的数量。Renderer 在任何读取前预留全部已选图片的窗口预算，跨添加批次串行准备；[原生异步编码](src/input-image-encoding.ts)以可取消 FileReader 完成摘要读取及 32KiB Base64 分块，避免逐字节字符串数组和整图 Data URL，摘要 buffer 不跨后续编码保留。移除或退出取消所属 reader，排队任务不再读取。Main 在原输入 journal 准备前，按准确 Store/Session 发布图片 Artifact，只把稳定引用放入正式命令；Provider 请求由 AI 转为内联 Base64，不使用外部托管或 Provider file ID。原 Command 与未知回执继续按原查询处理，不在窗口重开时重放上传或发送。未发送附件为窗口内草稿，不属于私有文本草稿的冷保存；成功受理才清理此次冻结的附件 ID。

历史图片由 [Main reader](electron/input-image-reads.ts)从已观察的准确用户 Message 取得引用，不接受 renderer 自报 Artifact；每次核 generation/viewSelection/historyEpoch，完整 Client Artifact 校验后分块交付。[Renderer](src/native-user-images.tsx)再次核大小／EOF／SHA，在可见区域前后 160px 内自动准备 blob 缩略图；原图读取等待 close 回执，预览准备完成后才接纳下一项，同窗口 bridge 按序执行。图片加载、错误与重试共用固定预览区域；同一观察范围内的普通历史同步只暂停新的读取，不卸载原卡片或已验证预览。远离区域或隐藏窗口取消所属排队／读取并释放 URL，回到可见区域时重新按当前观察校验。切换会话仍取消未完成读取，但图片 key 只含 generation、原消息及图片引用身份，不使用 viewSelection／historyEpoch；已核验 URL 由有界缓存 owner 持有，返回时复用原 img，淘汰或真正移除时释放，缩略图编码与RGBA像素估算一起计入原 UI 预算。CSP 仍只允许本地 blob 图片，不开放远程图片源。

[窗口缩略图缓存](src/native-image-previews.ts)由附件 owner 按 bridge／generation／当前Store创建，输入区和历史正文共用。原图先完成当前读取与SHA核实，再按完整hash／媒体类型／字节数／转换版本复用派生结果；普通重绘、viewSelection和historyEpoch变化不失效派生内容，缓存不替代Main准入或原始校验。相同原图的在途请求合并，单个调用者取消不影响其他调用者，最后一个取消则终止活动Worker或移除排队项。完成后只缓存派生Blob与尺寸；LRU最多128项，按缩略图编码字节＋宽×高×4估算合计32MiB。待转换原始输入包含活动项在内最多8项／32MiB。已显示URL的保留仍受原正文资源owner或草稿生命周期管理，不随派生LRU淘汰而撤销。清范围／卸载取消所有任务并清缓存；失败不缓存，旧Worker答复不能恢复已取消的结果。

[原生Worker](src/native-image-preview-worker.ts)只使用 `createImageBitmap`、OffscreenCanvas与 `convertToBlob`，单次处理一张，保持比例且不放大小图，长边最多512px，输出WebP质量0.8（平台不支持该编码时可返回PNG）；原生解码处理EXIF方向与透明度，GIF为静态首帧。原图Bitmap在绘制后关闭，临时Canvas在结束后释放；Worker空闲5秒终止，命中缓存无需重新启动。首次生成仍需解码一张原图，像素预算是派生数据估算，不能作为任意原图解码峰值或浏览器总heap保证。图片暂存、Artifact和模型输入仍使用原字节；输入预览失败显示“预览不可用”，不把它当成上传失败或阻止原图发送，历史卡片可显式重试。原生能力不可用时不回退到完整原图预览。取舍见[缩略图缓存](../../.agents/notes/implemented/architecture/2026-10-20-native-image-preview-cache.md)。

本轮[缓存回归](test/native-image-previews.test.ts)核合并、LRU、像素／条数／队列预算、取消、失败重试与scope清理；原[草稿](test/isolated/native-input-images-dom.test.tsx)和[历史图片](test/isolated/native-user-images-dom.test.tsx)继续核原发送字节、预览失败不影响暂存、门禁及URL回收。[真实浏览器入口](test/image-previews-browser-runner.fixture.ts)执行 `bun run apps/desktop/test/image-previews-browser-runner.fixture.ts`，仅使用隔离测试制品、生产组件和真实原生Worker，生成10张不同的4000×3000 JPEG，核512×384预览、转换时输入、历史刷新／会话切换／重选原文件不增加转换，以及完整原发送字节；另核PNG／WebP透明度、GIF及EXIF旋转。CPU减速仅是本机对照，不取得实际低性能电脑、完整Electron／IPC或跨平台资格。

2026-10-20 Windows x64／Bun 1.4.3／Chrome155.0.8059.82的隔离生产构建中，正常／4倍CPU减速下，10图从选择到原始暂存完成分别约710／1213ms，重选约133／801ms（包含原图hash、编码和模拟上传，并非缓存查询耗时）；转换并发峰值1。两种条件下连续30次A→B→A、30次历史刷新及重选后，转换总数仍为10，各自两轮共20次原图暂存的字节全部相符。转换期间输入成功，无达到50ms的主线程长任务，冷准备最大RAF间隔分别50／43.7ms；这组证据不表示全程60fps。报告与截图输出于 `.cache/image-previews-browser-*/`。

2026-10-18 Windows x64／Bun 1.4.3，本任务工作树的[图片暂存](test/input-images.test.ts)、[窗口草稿](test/isolated/native-input-images-dom.test.tsx)、[IPC](test/input-images-ipc.test.ts)、[历史读取](test/input-image-reads.test.ts)及受影响的原草稿／首次发送／导航 DOM 测试已运行；隔离 Chrome 实测 Markdown 快捷输入、撤销、路径引用、图片粘贴、Enter 与 scope 隔离。实际 HTTP／Provider 映射证据归 [Service](../service/README.md#图片输入协议)与 [AI](../../packages/ai/README.md#图片消息)。未调用真实付费图片模型，不据此宣布安装或跨平台资格。

2026-10-19 Windows x64／Bun 1.4.3／Electron 44.3.0，在独立 Profile 与合成 Workspace 的普通 Native 开发窗口中，用系统文件选择器经 `+` 选文件并点击发送；真实用户配置的 `deepseek-v4-flash`／chat-completions、自动审核模式完成两场景。工作区内含中文／空格／方括号的 ini 文件实际 `files.read` 成功，最终回复准确合成标记；工作区外 ini 的同一工具返回 `file_path_invalid`，同 Run 的下一次真实 Model 正常解释拒绝。两个 Run 的持久记录均为 `completed`，各两次成功 Model、一次 Files；完整封存 Model 输入核实工具结果进入下一轮、外部文件及说明正文未进入模型，均无 `context_source_unavailable`。[越界装配回归](../service/test/isolated/assembly-file-denial.test.ts)另1项／13断言通过。当前范围为手工原生窗口路径引用资格，不代表直接图片、PDF 正文解析、其他模型、完整安装或跨平台资格；不增加普通客户端诊断入口，用户 Profile 与配置保持。

普通宿主的外部只读工具曾遗漏于默认清单，上述强制工作区工具的拒绝测试不代表已选外部附件可用。默认补齐 `read_user_file` 后，同日同一平台／模型／自动审核模式重新在独立普通 Native 窗口经系统选择器选工作区外 ini，以普通“这是什么文件，读取实际内容”提问：模型实际使用 `files.read_path` 成功读取准确路径，回复实际字段值；原 Run `completed`、两次成功 Model、一次成功只读 Tool，完整下一 Model 输入包含准确文件内容，不包含同目录未选中的 `AGENTS.md`，无 `context_source_unavailable`。主输入和 `+` 仍只发送路径，不修改权限模式／配置、不复制文件或开放外部写入。当前默认装配归 [Service](../service/README.md#默认装配与业务规则归属)，取舍归[Note](../../.agents/notes/implemented/bug-fix/2026-10-19-default-external-file-read.md)。此证据限普通用户文本文件，不补齐二进制内容解析或其他模型／平台资格。

2026-10-19 同一平台／模型／协议的独立普通 Native 窗口补齐混合附件：经两个系统选择器选工作区外 INI 和直接 PNG，原正文保持，消息独立保存一个 `files` 和一个 `images`；两次 Model 成功、一次 `files.read_path` 成功、Run `completed`。最终准确回复 INI 两个合成字段、图片文字与两个红色方块，封存 Model 输入中的图片 Base64 与原文件字节完全相同，未包含同目录未选的 `AGENTS.md`，无 `context_source_unavailable`。本段补齐前述直接图片未知，仅覆盖真实 DeepSeek Chat Completions；其他提供商及 Responses 仍为受控 HTTP 映射测试，未扩为真实端点或安装资格。

同日 [Composer／草稿回归](test/isolated/native-input-images-dom.test.tsx)核编码中切换 scope、继续编辑、移除准确图片后停止后继分块及 finish、所属 URL／暂存释放、另一会话附件与正文保持；[编辑器回归](../../packages/ui/test/isolated/prompt-editor.test.tsx)核取消／迟到选择不进入其他会话。手工浏览器入口为 `bun run apps/desktop/test/input-attachments-browser-runner.fixture.ts`，只构建[独立测试入口](test/input-attachments-browser.fixture.tsx)，不改普通客户端、用户 Profile 或权限。实际 Electron 44.3.0 窗口验证 12 个文件在 720px／380px 容器中保持单行、横向滚至末尾、准确移除及会话隔离。四张各 16 MiB 的小 PNG 补齐文件分别在 1ms／8ms 模拟分块回执延迟下完成编码，Data URL 读取上限 32768 字节、各四次摘要读取／2048 个分块；两次观测均无超过 50ms 的主线程长任务，最大帧间隔约 37.7／49.9ms。时间包含夹具回执延迟，不代表实际 IPC 吞吐、超大像素图片解码或其他机器性能保证；dev／prod 无该观测入口。

2026-10-19，Windows x64／Electron 44.3.0，统一入口在[独立浏览器夹具](test/input-attachments-browser-runner.fixture.ts)中使用真实沙箱 preload 和系统多选，一次选择工作区外 INI 与 PNG：真实磁盘 File 路径解析成功、普通文件卡片与完成编码的图片缩略图并排显示、正文保持空白，只有图片触发一次摘要读取。夹具的图像 IPC 为模拟回执，此项不冒充新的真实模型发送或完整安装资格；原 Provider 映射未改。10／11 张边界、混选超限零附件 port、粘贴／拖入累计、分批预留、移除释放名额、Main 窗口计数，以及 HTTP 超限零模型请求分别由上述 owner 测试核对。

2026-10-19，本次 Windows x64／Bun 1.4.3／Electron 44.3.0 工作树针对流式抖动补齐验证：[Native 页面回归](test/isolated/native-history-presentation-dom.test.tsx)核活动 Run 的连续历史扫描期间，图片自动加载且卡片、img 与 URL 不被重复重建；[预览生命周期](test/isolated/native-user-images-dom.test.tsx)核六张可见图片只有一个活跃读取、视区／隐藏释放、切换后的排队取消与坏元数据零预览及显式重试。独立沙箱 Electron 窗口中，共享 Conversation 与真实 Native 图片组件使用合成 PNG 和受控 IPC 回执，24 次流式更新零向后跳，距底部最大偏差约 0.67 CSS px；12 次手动阅读更新中锚点和卡片高度偏移均为 0，切换后释放原 URL，返回后自动重新显示。此项验证实际浏览器布局与滚动，不代表新的真实模型或安装资格。

## 真实输入消息的唯一展示

首次发送与已有会话的引导／后续输入在构造原意图时共用 [promptTextForSend](src/prompt-text.ts)，只去掉末尾连续 CR／LF；发送占位与实际消息使用相同正文，编辑草稿保留原字节以供失败恢复及版本比较。Main 的自动草稿证明、[caller journal](electron/caller-journal.ts)准入和[私有草稿消费](electron/private-data.ts)允许原文或仅去尾换行的正文对应；仍核准确 Store／Session／草稿 revision 及原文 SHA，不因转换清除后来编辑。旧请求原文继续可读，不改写历史。纯函数、[Native DOM](test/isolated/native-new-conversation-dom.test.tsx)、[Main](test/native-caller.test.ts)和[真实 Node 冷读](test/isolated/native-prompt-draft-store.test.ts)分别验证转换、发送／恢复、原证明与受理后的持久清理。2026-10-25，Windows x64／Bun1.4.3：上述四文件125项、Desktop类型及定向Biome通过。隔离生产页面实际观察三个尾部换行的首发与续发、占位接管、草稿清空和回复完成；Native 请求及受控 Responses wire 均保留两个内部换行与两个尾部空格，末尾 CR／LF 为零，证据归本机既有 `.cache/session-files-browser-96f83a8f-934d-4d39-829c-3f094948e584/newline-*-send.json`。浏览器夹具的假草稿 ID 先前不符合正式 SHA 形状，首轮失败后按现有 Main 单测对齐该替身，未放宽生产校验；真实持久清理由 Node 用例单独证明，仍不代证完整 Electron 安装包。

新消息直接进入当前主 Agent；首次发送保留一条用户消息及实际 Agent 回复，没有额外的“关联工作”判定答复。运行中引导进入原轮次安全检查点，排队等待仍沿原队列；UI 不靠过滤新回复掩盖重复。相同正文的两次提交保持两个独立输入，冷重开只读取原历史。普通输入的本地投递占位在原持久用户消息到达后交接。新 `run.start` 消息在原事务保存 `originCommandId`，历史先于 Run View 到达时也能核对原提交并立即接管，不短暂多出用户消息；此路径同样适用于 Responses；带 `originMessage` 的继承记录不能消费当前 Store 的投递占位。旧历史中仅有 `sourceIds` 的原 `run.start` 消息也须核同 Store／Session／Run 与准确原 Command，不按正文比较或合并独立提交。Run 状态先于历史到达时，本地输入仍按原 Command 绑定该轮次，位于该轮状态、工具和回复之前；连续引导输入按原输入身份保存因果前驱，前条从本地转为持久消息时也不反转后条。

旧处理／业务双记录继续通过 [呈现投影](src/native-presentation.ts)消费准确 `Message.humanInput` 证明，只有本次读取含同 Session／原输入／公开提交身份的替代 Message 才合并副本。业务对象在原输入位置呈现，保原 ID/seq/Run/正文/附件；不改 SQL 顺序、不删除原历史、不按正文去重，Fork 只映射本分支已封存的替代行。证明来源归 [输入 owner](../../packages/agent/src/storage/sqlite/inputs/README.md)。

[普通页面回归](test/isolated/native-new-conversation-dom.test.tsx)保旧历史、缺替代行和独立同文的展示兼容。[真实普通 Electron 回归](test/isolated/native-human-input-electron.test.ts)使用实际 Main/Service/SQLite 与受控业务 Provider、关闭产品调试入口，核首次为用户→实际回复、正常退出冷重开零新提交，以及同文重交仍为独立用户→回复；SQL 不生成 raw/decision/processing，新请求无分类调用。

2026-10-25，新对话准备闪烁修复：Windows x64／Bun1.4.3，原[新对话DOM回归](test/isolated/native-new-conversation-dom.test.tsx)82项／1666断言、Desktop类型检查与定向Biome通过，新增暂停读取期间的目标展示、同项目控件节点保持、失败禁发及重试恢复断言。实际NativeDesktop／共享CSS在隔离浏览器中逐步观察重复点击→读取暂停→完成、其他空间→全局默认空间→迟到读取返回；目标高亮与项目名直接更新，重复点击期间分支节点保留，选择器不变淡，草稿保持，原请求不覆盖后选空间，页面无错误。该夹具使用模拟NativeBridge，覆盖此前仅共享SessionPage夹具遗漏的宿主异步准备过程，不替代完整安装版Electron或真实IPC验收。

2026-10-25，Windows x64／Bun1.4.3：连续输入修复在独立 Profile 的 NativeCaller→HTTP→SQLite 与本机受控 Responses SSE 页面观察到旧版第二次发送的额外用户占位；补齐原提交身份后，连续同文发送分别由一条持久用户消息接管，流式回复、完成及重载读回保持原顺序，重载未增加模型请求。Store 与 Native DOM 回归分别核相同正文的新 Command、幂等重查、冷读和 Run View 迟到；证据保留在本机 `.cache/session-files-browser-96f83a8f-934d-4d39-829c-3f094948e584`。浏览器桥与受控模型不代证完整 Electron IPC、真实远端模型或安装包。

## 普通客户端与测试诊断

Native 启动、目录与子 Agent、安排任务、分支、模型／提供商／MCP／Skills 设置、扩展能力、文件差异、上下文、交互记录和完整日志／输出读取均不插入临时加载文案，刷新同样不追加“正在核对”提示。已有正文、静态控件标签、图片文件名和预览占位保持，忙碌由原转圈、控件禁用及 `aria-busy` 表达；共享模型输入／输出遵循 [UI owner](../../packages/ui/README.md#原桌面展示层)。会话观察失败、历史不完整和原申请回执丢失由后台自动重读或查询原 ID，普通页面不再在消息区外追加异常文案、临时重试／核对按钮或通用错误弹窗。已读正文和草稿保留；真实执行失败和未知结果保留在原输入、轮次或工具消息中。设置、启动与空间管理等独立业务错误仍在所属界面处理，敏感内容确认、完整读取和写入准入不变。测试等待使用实际区域的忙碌状态，不能以加载文案消失推断完整读取成功。

[会话后台核查](src/native-session-recovery.ts)按原 scope／请求身份持续退避，间隔最高15秒、当前恢复范围最多2项并发；隐藏、切范围或退出撤销待调度项，未结束的原 key 保留去重身份，同 key 重新显示时等待原读取；已撤销范围的在途读取不占用新范围预算。同一子日志的自动恢复沿原读取任务保留已核实正文，即使后续目录读取也失败仍不清空；旧正文仅供展示，不恢复操作资格。首次消息、后续输入、答案、权限和队列未知结果仅查询原申请，不重发原写入；队列编辑的原文不能覆盖后来草稿。会话选择以原激活序号区分首次明确激活与自动读取重试，Main 只保存当前一项；自动重读不重复生命周期 POST，也不重新分配 Main 的会话选择身份。真实输入投递失败附在原用户输入项中，准确持久消息接管后移除本地副本。首次提交查回后，目录观察独立恢复，不阻塞原会话接管；选中读取重试成功后按原页、Session 与 Store 结束准备态。首次引导 POST 的明确4xx `input_target_stopped` 拒绝保存为本地 rejected，不能继续作为 unknown 查询不存在的 Command；网络、5xx和结果核对失败继续保未知，不据此自动重发。[调度器](test/native-session-recovery.test.ts)、[Main／Controller](test/native-caller.test.ts)、[会话页面](test/isolated/native-read-ownership-dom.test.tsx)、[首次接管](test/isolated/native-new-conversation-dom.test.tsx)、[子日志恢复](test/isolated/native-environment-child-recovery-dom.test.tsx)及[历史展示](test/isolated/native-history-presentation-dom.test.tsx)分别验证并发、原 ID、迟到隔离、慢请求不自取消、后台恢复与普通界面无额外异常提示。

2026-10-20，`5dba8a6b` 上的本次工作树，Windows x64／Bun1.4.3：逐文件独立运行 UI、Native 和共享 Web 输入阅读的25个完整文件，228项／3013断言通过；覆盖[慢配置读取与迟到隔离](test/native-mcp-settings.test.tsx)、[Skills 刷新保留详情](test/native-skills-settings.test.tsx)、[会话门禁](test/isolated/native-session-shell-dom.test.tsx)、[完整输出](test/native-job-output-panel.test.tsx)及启动、子日志、附件与文件差异。UI／Desktop typecheck、34个本轮 TypeScript 文件的 Biome、文档结构及影响核对通过。原 Electron driver 的等待同步改为区域忙碌状态，本轮未重新运行真实制品或安装窗口，不增加平台或发行资格。

[统一展示 context](src/native-diagnostics.tsx)只允许显式测试诊断。`NativeDesktop({testDiagnostics:true})` 供直接 DOM fixture；可信 `buildNativeDesktop` 第三参数中的 `testDiagnostics:true`、`buildNativeCandidate` 输入的同名选项供单独测试制品写入 renderer 构建常量，纳入实际制品字节指纹。普通正式制品和 `desktop:dev` 将常量固定为 false，Provider 同时核对该常量与组件参数，传入 true 不能绕过构建关闭值。dev／prod 不得出现测试专用调试功能，不依据 NODE_ENV、development 身份或 fixture 内容推断资格，也不改变 Main／IPC／Service 权限和恢复资格。顶部“会话工具／设置”、左栏连接标签与重读目录、两处 Composer 的“先审核计划”、当前会话的“保留草稿”及缺默认模型辅助提示均只在此显式测试模式展示；普通界面的设置仍从“个人工作区”用户菜单进入，Windows 另有[顶栏菜单](#windows-顶栏菜单)。[Main](electron/main.ts)移除 Linux 窗口菜单栏，Windows 隐藏独立系统菜单行并保留原生快捷键。

普通界面隐藏机器身份、泛化 Model result dump、已确认的创建／答案／交互账本，以及正常完成的历史校准、后台状态汇总计数、子日志的固定序号／原子轮次 ID 和缓存诊断。后台计数非零、出现未知任务或观察不可用都不能绕过测试诊断开关；实际任务状态继续由原轮次和环境信息展示。所保留的面板在未开启测试诊断时使用“执行记录”标签，未知、当前错误、未完成申请和取消未确认保持原查询合同；“查看提交记录”仍可读原申请全文并清理已核实记录，不清除 unknown。原全文继续核 EOF、完整字节、SHA 和准确命令，关闭／切 scope 只结束所属读取。非 Model [结果组件](src/native-result.tsx)逐字段保留全部业务正文；下文涉及“会话工具”的 Job／子日志、Model input、Context、恢复与管理面板由自动测试显式进入，配置另保普通用户菜单入口。

旧 Electron 身份断言在测试构建显式开启诊断；普通模式验证见[diagnostics DOM](test/isolated/native-diagnostics-dom.test.tsx)、[启动 DOM](test/isolated/native-startup-dom.test.tsx)、[新对话 DOM](test/isolated/native-new-conversation-dom.test.tsx)及[会话导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)。启动与当前会话覆盖默认隐藏、显式开启辅助入口及零新增请求，缺模型仍禁发送；导航回归另核非零／未知计数、观察失败、子日志身份在普通模式隐藏，构建关闭时组件 opt-in 无法开启，显式测试诊断仍保留原计数与身份。需要侧栏或目录重读的原问答／计划／草稿／恢复 DOM 明确开启诊断，其他用例保普通模式。DOM 文件沿测试体系各自隔离运行，避免多个 JSDOM 共享 React DOM 的全局捕获。此展示调整不建立完整 Windows／Linux 实测或新的发布资格。

[构建隔离回归](test/isolated/native-diagnostics-build.test.tsx)另经真实dev Vite服务加载原Provider，以及真实Vite／React构建原Provider和共享context的私有生产IIFE，验证编译关闭后即使组件传true、运行时伪造全局常量、dev／prod／test环境名、诊断环境变量或URL参数，仍保持普通模式；显式测试构建的true正向对照继续生效。实际2项／14断言通过，临时服务和目录均释放。生产部分验证原组件的实际编译行为，完整普通生产窗口另由下述混合压力回归覆盖，不将小入口当作完整发布打包资格。

2026-10-14 Windows x64／Bun 1.4.2，基于 `006b79d3` 的本次界面 diff：分别执行上述启动、新对话、诊断文件，以及目录读取归属、草稿、问答、计划、模型选择、共享页面和 Sidebar 目录，共十个完整文件49项／665断言通过。Desktop／UI typecheck 和定向 Biome 通过；Biome 保一个未改动的 fragment 提示。[恢复压缩原输入](test/isolated/native-restored-compression-input.test.tsx)及 `HEAD` 原文件的临时副本都在页面挂载前的压缩准备断言失败（`compression` 未生成），不计为本轮通过；临时副本已清理。本轮未运行完整默认测试或新的正式制品窗口。

本地开发先安装当前 workspace 依赖，使用根 `npm run build` 后 `npm run desktop:dev`。该[显式开发宿主](../../scripts/development/unified-desktop.ts)复用已构建的 workspace 运行资产、实际 Bun SHA、已有 Native development assets 与构建器，从当前 Service 源码构建独立开发版本，使用当前用户 `~/.kite-code` 数据根中的 `development` profile，数据库直接位于 `~/.kite-code/development/core.db`，与 CLI/TUI/Web 开发入口共用；checkout 和启动工作目录不决定数据位置。目录结构与旧数据读取方式见[本地开发](../../docs/development/local-development.md)。Windows x64 的[开发环境准备](../../scripts/development/windows-desktop-environment.ts)复用已初始化环境或通过已安装 vswhere／VsDevCmd 自动初始化，只导入本次进程的构建白名单；普通 PowerShell 无须手动配置 MSVC。每次构建到独立 `.cache/unified-desktop-*`，Windows 目录由原生权限接口创建并通过私有 ACL 校验，实际 Electron 退出后清理自己的应用目录；开发数据保留，活动应用目录不覆盖。纯帮助与严格参数拒绝先于资产读取／工具探测／构建／Profile 写入，缺 built Service 明确要求 `npm run build`；SIGINT／SIGTERM通过本次父连接请求所属进程收尾，菜单退出沿Native原收尾流程。操作步骤及 Windows C++ 工具安装要求归[本地开发](../../docs/development/local-development.md)。[开发入口测试](../../tests/isolated/unified-agent/development-desktop.test.ts)核对自动初始化、已有环境复用、缺工具／SDK／无效环境拒绝、帮助、缺资产、严格参数、独立私有应用目录及已有缓存保留。

当前桌面构建与启动使用仓库根 `bun run release:build --product native` 和 `bun run desktop`，定向验证为 `bun run test:desktop:native`，安装／归档／版本选择见 `bun run release:native --help`。旧 `apps/kite-desktop` 的普通开发、服务准备和打包命令已给出明确退役诊断／退出码2；不再从当前checkout构建或启动旧writer。原Vite开发热更新只属历史实现，当前Native候选启动的具体行为仍按本页及[发布owner](docs/native-release.md)核对。此项调用者退役不表示全部旧源码或阶段已退出。

Windows 开发启动还会先运行 [Electron 权限预检](../../scripts/development/windows-electron-permissions.ts)及其固定 [PowerShell 实现](../../scripts/development/windows-electron-permissions.ps1)，按已安装包／实际 EXE／版本限定物理 `dist`。在固定原对象并完整扫描后，仅向缺权限的现有对象追加受限应用包 RX；无递归继承授权、ACL 重置或提权。链接、硬链接及适用的拒绝 ACE 在写入前失败；已有 ACL、所有者、继承和运行字节保留，已满足时不写入。每次启动重新解析当前安装，覆盖重装／版本切换；项目、私有应用目录、Profile 和正式 Native 权限策略不变。范围与取舍归 [Note](../../.agents/notes/implemented/bug-fix/2026-10-19-development-electron-sandbox-acl.md)，操作与错误码归[本地开发](../../docs/development/local-development.md)。[权限回归](../../tests/isolated/unified-agent/development-electron-permissions.test.ts)覆盖真实 ACL 增量、原权限／数据保全、重装、幂等、目录联接／硬链接和拒绝规则。2026-10-19 Windows x64／Bun 1.4.3／Electron 44.3.0 的独立官方 ZIP 新解压夹具复现 GPU `0x80000003`，自动修复后 renderer 加载且实际 preload 报告 sandboxed／contextIsolated 为 true，再次检查零写入；此证据只覆盖本机开发启动。

2026-10-22，macOS arm64／Electron 44.3.0／Bun 1.4.2／Node 22.21.1，[普通 Native 故障整窗口](test/isolated/native-session-anomalies-electron.test.ts)使用真实 Main／preload／生产 renderer 与配套 Service，构建常量 `testDiagnostics:false`，以隔离的兼容 SSE Provider 和真实 `files.write@2` 验证：销毁 Main→Service 的实际 socket 后后台完成并自动重连；原 POST 已收到 202 响应数据后截断回执，后台仅 GET 原 Command 确认；活动 Model 期间对准确配套 Service 与 Main 执行 SIGKILL，冷重开将旧轮次收束为 interrupted，并可明确发送新轮次。六次输入各保留一个原 Command／Run，五个完成轮次各一次工具、两次 Model；被强杀的原轮次始终只有一次 Model、无工具效果。继续输入与再次冷读后原身份、请求 digest、执行集合和五份实际文件均未重放，普通退出核 Main exit 0 与所属 Service 已消失。全过程记录 129 次 DOM 观察、40 帧实际窗口画面和 11 个阶段快照，并逐段核对输入先于对应状态／工具／回复、投递与持久历史接管无重复、无通用异常文案闪现；失败现场继续保留，最终截图或脚本通过不能覆盖中间异常。该范围为本机隔离构建及 Main 作用域的实际 HTTP 故障，未做操作系统全局断网、付费 Provider、完整安装版或其他平台验收。

同日按用户要求改用已配置真实 `deepseek-v4-flash`／chat-completions／medium，沿[真实模型整窗口入口](../../tests/e2e/live/model/README.md#普通桌面会话异常)重验上述三类故障。真实第 02 轮发现原 Run 未重放，但新模型缺少旧 Run 已中断事实，在新 Run 又发起旧文件写入；该失败保留在 `dist/acceptance/session-anomalies-live-20261022-02.json`，不能计为通过。后端补齐[历史输入生命周期投影](../../packages/agent/README.md#人类输入工作选择与可靠结果)后，提示词、模型和断言不变的第 03 轮通过：11 次真实 200 请求，六条原输入／Command／Run，五个完成任务各一次实际写入，旧中断任务只有原一次 Model、零工具且旧文件不存在。回执丢失确认实际 202／357 字节后截断，原 POST 一次、仅原 ID GET 查回；断线与强杀的响应 gate 均先收到真实响应正文而未向 Service 转发。11 个阶段逐次暂停观察，另核 313 帧窗口、168 份顺序采样和 18,604 次 DOM 扫描，输入先于对应状态／工具／实际回复，未发现重复气泡、顺序倒置或会话外异常文案。最终正常退出／第三次冷开保持原业务身份、11 次调用及五份文件不变，三次启动的六个所属原 PID 均确认消失；外层及 driver 均退出 0。准确代码 hash、阶段截图／轨迹、冷事实及清理证据在 `dist/acceptance/session-anomalies-live-20261022-03.json.workspace/evidence`。第 01 轮夹具识别／取消判定失败同样保留。范围仍为本机隔离源码构建、明确文件任务和 Main 作用域 HTTP 故障，未做系统全局断网、安装版、其他模型或平台验收。

## 开发热更新与服务重载

根 `desktop:dev` 在已准备 workspace 资产后，由[开发宿主](../../scripts/development/unified-desktop.ts)通过 builder 的 `development` 选项构建 Main／preload 和首个独立 Service 版本，由[本地 Vite renderer](scripts/development-renderer.ts)提供页面。[重载协调器](../../scripts/development/desktop-reload.ts)在初次构建和每次重建后，以新 Bun 进程实际加载 Service 及外部 workspace 导入；不执行 `import.meta.main` 分支、不自动安装依赖，最长等待10秒，失败保留最多16K字符诊断并回收探测进程。缺失导出不能只因入口 bundle 生成而放行。加载检查不代替完整类型检查或业务验证。

协调器监听 Service、Agent、AI、Client 的 `src`，合并连续保存、串行构建并保留旧版本字节；同时核源码内容摘要，避免外部 workspace 变化而入口 SHA 未变时跳过重载，内容相同不重启。检查中源码变化拒绝发布该版本，后续保存仍沿原队列处理；编译／加载检查失败保持旧服务。React 组件及 CSS 沿 Vite Fast Refresh，共享 UI 保存不重启 Service。

Main／preload及其IPC投影变更必须退出并重新启动`desktop:dev`，沿新启动构建加载；只刷新页面或新建会话不会替换旧主进程。重新启动沿原development profile读取已保存会话，不需重新提问或重跑工具；进程内未发送内容须按原草稿边界保留。完整操作边界归[本地开发](../../docs/development/local-development.md)。

开发 Main 在页面加载后沿原 `openCaller` 完成 Service 握手、Client 连接和私有数据准入，才在准确父连接报告 `desktop.ready`；初次失败携有限错误码报告 `desktop.failed`。连接建立本身不报告就绪；父宿主最长等待45秒，失败以非零结束并等待所属 Electron 退出后清理目录，不把加载失败窗口当成成功。正常候选的启动错误／重试展示及控制边界保持。

Vite 使用 middleware 模式，HTTP 与 HMR WebSocket 共用宿主拥有的 loopback 端口；其默认 SIGTERM／stdin EOF 退出处理不再接管整个开发进程。宿主信号处理器保留到 Vite、父通道与所属 Electron 收尾完成并清理私有应用目录，防止 Vite 直接退出而跳过清理。

2026-10-24，macOS／Bun1.4.2：[真实开发 Main 回归](../../tests/isolated/unified-agent/development-desktop.test.ts)在隔离 Profile、独立 Electron 数据目录及最小 renderer 中逐步核缺失导出先于 Electron 启动失败、有效模块但后台失败返回非零、实际 Service／Native caller 就绪、外部依赖加载失败保留原 Service PID、修正保存后唯一一次更新及新旧 PID 退出；开发函数真实返回143后应用目录为空。未调用模型，不代表完整聊天界面、其他平台或安装版验收。

开发 Service 对 `@kite-ai/agent/jobs/shell` 的导入固定为当前 checkout 已构建的 `packages/agent/dist/jobs/shell.js`，以独立文件 URL 保留资产定位器的原模块位置；其余工作区导入继续使用当前源码。不能把源码 `.ts` 的资产不可用误判为宿主缺少 Shell，也不能内联定位器后按 Service 缓存目录寻找 guardian。资产准备、平台限制和实际权限仍归[默认 Shell 装配](../service/README.md#默认-shell-装配)，子 Agent 按父 Agent 实际工具范围继承。[开发 Shell 回归](../../tests/isolated/unified-agent/development-desktop-shell.test.ts)通过普通开发构建与 paired Service，在隔离 HOME／Profile／Workspace 和受控模型下，核 macOS 主 Agent、默认通用及 code 子 Agent 的真实工具声明、Shell 执行和完整短输出；不注入工具或审批策略。[构建回归](../../tests/isolated/unified-agent/development-desktop-reload.test.ts)另核连续重建及中文／空格路径保留原资产 URL。本机执行证据不赋予 Windows／Linux Shell 或正式发行资格。

开发配置由 builder 固定且仅 `kind: development` 接受。[闭合配置／父通道](electron/development.ts)限定 renderer 为 `127.0.0.1` 的实际 HTTP 地址；script 用 Vite nonce，connect 只允许同源资源及该端口 WebSocket。Main 的沙箱、隔离、导航与准确窗口／主 frame 校验保持，Vite 文件服务只开放应用／workspace／依赖源码并拒绝仓库内 Profile、缓存、密钥及内部目录。正式候选不接受这份开发配置，继续 file renderer 和原 `connect-src 'none'`。

Windows GUI stdin 的实际过早 EOF 已否定其控制通道方案。当前父宿主为每次启动创建独立 loopback TCP 连接，编译到私有 Main 的 32 字节随机 token 认证连接；token 不进入 argv、日志、renderer 或 Vite 内容。闭合重载请求只含版本 ID／SHA，不接受任意路径或命令；Main 派生自己应用目录内的版本，先验证新字节，再沿原 caller／私有数据／paired 关闭并确认实际退出0，按新 build 身份准入并整页重新 attach。新旧 Service 不重叠，历史和持久申请保留，不重发工作；未知关闭或回执阻止后续自动切换。父连接 EOF、错误或关闭，以及 Main 的 SIGINT／SIGTERM，均等待同一幂等资源收尾完成再退出；配套 Service 自己也沿信号进入原 drain。父控制在连接／认证前收到停止会锁存，准确认证后立即 EOF，不丢退出请求；停止后拒绝新重载，迟到回执不恢复资格。菜单等待检查或用户决定期间被上述退出接管后，迟到“保留服务”或拒绝不能重新启动调度／观察。普通应用退出关闭 Vite 和监听器。取舍归[开发重载 Note](../../.agents/notes/implemented/architecture/2026-10-14-desktop-development-reload.md)。

[开发协调测试](../../tests/isolated/unified-agent/development-desktop-reload.test.ts)验证真实构建版本、编译失败保旧字节、串行更新、认证、原请求回执及 Vite 私有文件拒绝；[开发配置测试](test/development.test.ts)验证明确开发类型、URL／nonce／闭合通道，[窗口 IPC](test/native-window-ipc.test.ts)保原断言并核 HTTP 主 frame／origin／路径边界。2026-10-14 Windows x64／Bun 1.4.2／Electron 44.3.0 的实际窗口已核共享组件 Fast Refresh、草稿保留、UI 更新零 Service 重启、自动 Service 换 PID、旧 PID 退出、同 Main／Store、编译失败继续旧服务及下一次修正保存恢复。其结果仅覆盖开发热更新，不代 formal Native、其他平台或模型执行资格。操作及 Main／preload、Worker 资产需重新启动的边界归[本地开发](../../docs/development/local-development.md)。

## 复用原桌面展示层

模型和提供商设置的普通保存过程不再插入独立状态段落，提供商保存／删除成功直接更新原列表并关闭所属编辑面板；取消、控件忙碌及失败／结果未知的原申请查询保持。附件准备仅保留原忙碌图标、无障碍名称和取消入口。环境信息有业务名称时保留原名，否则普通页面回退为“Shell”／“子 Agent”；内部执行 ID 及“执行状态待核实”仅供测试诊断显示，实际操作仍绑定原 ID，执行权未核实仍撤销停止资格。安排任务的运行记录沿共享 UI 显示中文状态。设置、环境、附件和任务的回归归各自原有 DOM 测试，不改变 Main／Service 操作协议。

Native 使用现有捆绑的 Geist Variable 与 Geist Mono Variable 字体资源；`--font-geist` 指向共享 `--font-ui`，让会话、工具、输入、设置及浮层消费同一界面字体栈，中文优先系统 UI 字体。界面标题和设置名称使用 500 字重，普通文字为 400；Markdown 强调与等宽代码沿原语义样式。字体加载不改变阅读区排版变量。客户端默认字号由共享 `--ui-text-size: 14px` 管理；[Native样式](src/native-tailwind.css)与[设置样式](src/native-provider-settings.css)中的窗口菜单、设置普通段落、按钮、模型／连接主名称、表单标签和输入、完整详情正文，以及浏览器地址和失败正文统一消费该基准。模型名称多行输入保留等宽字体，字号与普通输入一致；页面标题、徽标、标识符与辅助说明保留各自层级。设置导航不再重复定义窄窗字号，窗口缩放只改变布局。样式入口先登记 `theme, base` 层，再引入 utilities，保持原生控件的字体继承低于组件明确字号；既有 utilities 与 components 的相对优先级保持。提供商删除确认的正文显式继承该区域字号，避免旧段落小字规则覆盖。

2026-10-21，macOS arm64／Bun1.4.2，`a7f629960` 工作树加本次全客户端字号核对：17个相关UI／Native测试文件以 `bun test --parallel=1 --max-concurrency=1` 执行，167项／2701断言通过；UI与Desktop类型检查、四个变更源码文件的Biome、文档结构与影响检查通过。Chrome155.0.8059.86沿实际Native与共享组件、生产编译CSS及隔离只读bridge，在深浅主题、360／767／1000／1280px下完成292组计算字号检查，覆盖设置列表和表单、删除确认、工作台、任务表单、问卷、右栏、地址输入及容器外Portal；另核12px辅助容器内组件明确的14px字号仍生效，并检查宽窄截图。Markdown的8组深浅／宽窄编译样式检查保持14px正文及原相对层级。无脚本错误；保留既有嵌套 `@keyframes` 编译提示，未运行本轮完整安装版窗口。

[Native样式](src/native-tailwind.css)的窗口留白、会话标题和设置右栏与[共享面板](../../packages/ui/src/desktop/SessionPage.tsx)统一消费UI的侧栏动画参数，默认180ms／ease-out。设置布局始终保留可插值的第三列，在0与420px之间开合；空编辑宿主不再直接 `display:none`，透明度与可见性随退出完成。窄窗改用相同曲线的右侧位移动画。提供商、MCP与Skills的原portal内容仍在关闭时立即卸载，原读取取消、秘密清理和焦点语义不等待动画。

2026-10-19 Windows x64／Bun1.4.3、`f734245a` 加本轮动画改动：[Native页面](test/isolated/native-new-conversation-dom.test.tsx)、[提供商](test/native-provider-settings-dom.test.tsx)、[MCP](test/native-mcp-settings.test.tsx)与[Skills](test/native-skills-settings.test.tsx)四个完整文件111项／1713断言及Desktop类型检查通过；连同共享三文件共142项／2007断言。设置宽窄栏的逐帧布局证据见[UI owner](../../packages/ui/README.md#原桌面展示层)，该夹具使用实际RightSidebar与Native CSS，不代证完整安装窗口、真实服务或其他平台资格。

正式 [NativeDesktop](src/native.tsx) 已使用原 kite-desktop 的共享 [SessionPage](../../packages/ui/src/desktop/SessionPage.tsx)、Sidebar、Conversation、Composer 与 RightSidebar。[renderer 入口](src/native-main.tsx)载入原主题、字体、Tailwind/typeset 和共享 CSS；[构建器](scripts/build-native.ts)复用原 Vite/React/Tailwind 管线，仅替换 renderer 构建，Main/preload、Service 闭包、递归制品清单与使用锁保持。macOS 沿原 hiddenInset 与 trafficLightPosition 布局；正式 workspace 仍为原八个。

[输入方式监听](src/native-input-modality.ts)由 renderer 入口在挂载前安装，在 document 捕获鼠标／触摸和键盘事件，通过根元素 `data-input-modality` 统一控制原生控件、共享组件与 Portal 的焦点外观。[Native CSS](src/native-tailwind.css)在 pointer 状态关闭 outline，并约束 Tailwind `focus-visible` ring／边色及调宽把手光环；共享 Composer 的聚焦边色／阴影沿同一状态。实际 focus、输入、菜单／弹窗归焦和键盘导航保持，未增加 blur 或阻止默认事件。键盘仍可恢复焦点提示，Web 未安装此 Native 监听。

2026-10-18 Windows x64／Bun 1.4.3，基于 `f734245a` 的本次焦点样式变更：隔离 Vite 编译的实际共享组件在 Electron 44.3.0 中通过21项点击／键盘检查；包含原工作区既有样式调整的 Chrome 155 无头夹具通过23项，另核亮暗主题添加／编辑按钮的透明悬停和按下背景、相同图标颜色。控件实际保持 focus，菜单／Dialog／Sheet 关闭归焦无残留外框，Tab、键盘菜单退出及按钮／滑块光环恢复，草稿保留，零页面异常。上述[共享页面](../../packages/ui/test/desktop-page.test.tsx)与[Native 新对话](test/isolated/native-new-conversation-dom.test.tsx)两个完整文件31项／567断言、Desktop／UI typecheck、定向 Biome 和文档检查通过。隔离编译保留原嵌套 `@keyframes` 提示；未运行全量默认测试、正式安装窗口或其他平台。

[适配器](src/native-presentation.ts)只将生成 Client 的真实 Workspace/Session/Message 转为原 UI view model。目录状态与时间消费同快照只读 activity，缺能力或未记录的事实保持待读取／未知；完成消息不推断 final reply、Turn、Tool grouping 或执行成功。正文 slot 继续使用现有 ModelOutputMessage 与完整原身份 reader；未知格式、预览与不完整内容继续保留。原 Composer 的发送、草稿、model choice 和 planMode 回调沿现有 Native controller，不建立第二条提交链。

显式自动测试模式中的“会话工具”将已有后台目录、Runtime logs、Context、恢复、权限、管理、原命令与草稿面板接到原可调整宽度的右侧栏。侧栏开关不卸载对话区，管理操作保留本视图已读的完整正文；关闭读取仍只 abort 所属 GET。全屏设置复用原 Dialog、双栏布局和主题偏好，模型/提供商/MCP/Skills 数据仍沿新 Main 的准确观察与原 mutation。只有真实端口提供操作 callback；工作台仍按手册隐藏。原安排任务草稿页、新对话准备与首次发送、全局目录状态和时间排序、环境信息卡与只读子详情已迁入，空间移除已接原侧栏与 Main 原生确认；空间和单会话离线历史清理已接同一公开维护，安装版五项常用维护的 macOS 已验范围见[Native owner](docs/native-release.md#macos-安装版离线维护)，这些原主入口已有正式适配，完整行为与阶段退出仍须按[PC 主线](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)的动态结果及剩余资格核对。

[原页面契约测试](../../packages/ui/test/desktop-page.test.tsx)迁回原 12 项展示断言；现有 Native 目录、草稿、问答与计划 DOM 只调整控件/浏览器 API，保留业务断言。源码外 [Native 候选](test/isolated/native-bundle.test.ts)与[driver](test/native-bundle-electron.fixture.ts)已核编译 CSS/字体、可操作 Composer、新 preload bridge、实际审批/任务、冷读和两层使用锁收尾。准确输入、原失败与结果归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08复用原-pc-桌面展示层)，不代表完整客户端、installed 全量、独立审查或 Windows/Linux 阶段退出。

## 原启动页与初始化重试

Windows Mica 与 macOS Vibrancy 窗口的[启动样式](src/native-startup.css)仅在 Main 已确认 `data-window-material=mica/vibrancy` 时将 `.kite-client.desktop-startup` 设为透明，准备中和初始化失败沿用同一容器，直接透出原生材质。文字、图标与共享按钮保留原主题及交互；未确认材质的窗口保留原实色启动背景，服务准备与重试逻辑保持。

2026-10-14 Windows x64／Bun 1.4.2，启动页 DOM 完整文件3项／58断言通过；实际 Chrome headless 按 renderer 的 CSS 顺序载入当前 Tailwind 编译结果、启动样式与共享 CSS，核亮／暗、Native Mica／无材质／非 Native、准备中／失败共12种组合：Mica 启动容器及其承载层透明，其他组合保原实色，文字与重试按钮保主题颜色。定向 Biome、文档结构与影响检查通过；此 CSS 验证不代证 Windows 桌面的最终材质合成，Main 的材质选择未改。

[NativeStartup](src/native-startup.tsx)迁入原 kite-desktop 的启动页布局、[图标](app-icon.svg)和[启动样式](src/native-startup.css)，按钮仍用原共享 Button。[正式入口](src/native.tsx)先完成现有 Main 的 attach 与首屏完整 Workspace／Session 目录观察，再显示原 SessionPage；尚未核实的目录不能进入，空目录与未配置模型可以进入处理。没有人为最短停留时间，不另建服务或执行路径。

[窗口容器](src/native-window-frame.tsx)在准备中、启动失败和重试时使用 `showHeader=false`，不渲染自绘顶栏与 Windows 菜单，也不监听 F10／Alt 菜单导航；内容区使用整个窗口高度。缺 bridge 的失败页使用同一显示规则。完整首屏目录观察通过后恢复32px顶栏与菜单；进入主界面后的连接失败沿原逻辑保留页面和顶栏。Main 继续负责原生窗口按钮，服务准入、诊断、重试和退出沿原端口。

2026-10-14 Windows x64／Bun 1.4.2，`5f41fc3d` 加菜单及启动 header 调整：[启动 DOM](test/isolated/native-startup-dom.test.tsx)与[窗口动作 DOM](test/isolated/native-window-actions-dom.test.tsx)两个完整文件4项／90断言通过，覆盖准备中及首屏目录等待、启动失败、重试、进入应用后恢复菜单、隐藏时菜单快捷键零宿主调用，以及迟到观察、后续连接错误和原草稿。Desktop typecheck、定向 Biome、文档结构与影响核对通过；Biome 保留原未改动 fragment 提示。本次未重新运行真实窗口或完整默认测试，下面既有窗口证据不代证本次启动 header 显隐。

初始化失败保留启动页、公开错误分类和明确“重新尝试”。初始目录观察确认 unavailable 时显示 `native_directory_unavailable`，不会一直显示准备中；原 generation 后来取得完整可用目录仍自动进入。同步状态阻止重复点击；每次重试撤销旧观察、所属历史读取和旧 generation，迟到响应不能覆盖新的目录。Main 的 detach 只释放读取与选择，不停止 Service、Run 或重发业务。进入主界面后连接或目录读取失败保留原页面与草稿，不重新遮挡。缺 preload bridge 时沿同一启动页说明资源错误，不提供不能执行的重试。原“保存诊断”现已接回，范围见下节；完整安装恢复仍按原方案验收。

[Main](electron/main.ts)从已完成真实身份准入的 paired Service 向 [NativeCaller](electron/native-caller.ts)交接同一个 Client 的一次初次许可，首次 attach 不再重复 `/v1/server`。许可消费前同步清空，Main 核原 paired Service 与退出状态；detach、网络释放和关闭都撤销未消费许可。standalone Client 的缓存 `serverInfo` 不能替代准入，后续重连仍沿 Client 完整身份核验。内部交接不增加 renderer／IPC 权利，不改变必需能力或超时；[真实 HTTP caller 测试](test/native-caller.test.ts)核一次交接、再次准入、错 Store／profile 和撤销，准确结果归[普通启动进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动目录恢复与准入交接)。

[启动 DOM](test/isolated/native-startup-dom.test.tsx)沿实际 NativeDesktop 核首次等待、未核目录、空项目／无模型、两类失败、重复重试、旧响应隔离和进入后草稿保持；同轮原新对话／草稿／安排任务测试保业务断言。原[源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)核编译启动样式及首次／冷启动完成后进入原页面，保原任务、审批、冷读与退出；实际窗口不代证初始化失败矩阵。代码输入、执行结果及剩余迁移归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原启动页与初始化重试)，完整 PC、安装恢复及阶段退出仍按原方案核对。

旧读取的失败与成功使用同一展示归属：refresh 的 state 和 select/draft.read 捕获 generation、viewIntent 与 Main 退出生命周期 epoch，迟到拒绝已不属于当前视图时不再进入当前页面的“操作未完成”；当前读取仍抛原错误。全局目录绑定 generation 与生命周期，同代切换会话后真实目录失败仍提示。没有按错误码统一吞取消，也没有修改 mutation 的未知结果、原 commandId 查询、权限 CAS、启动失败和退出门禁。

[真实页面归属回归](test/isolated/native-read-ownership-dom.test.tsx)在原源码下实际三红，修后8pass/61assert：旧选择、草稿和事件状态的拒绝不污染新会话；当前错误、全局目录错误、未知首次提交的同ID查询及启动真失败继续成立。[正式默认 Shell 整窗口](test/isolated/native-shell-lifecycle-bundle.test.ts)保全部原断言、预算与故障路径，在 firstWindow 连接后被动记录公开启动错误与操作弹窗；正常启动、真实 parent 完成、准确停止及最终冷读要求记录为空。该观察不代证此前首屏的瞬时提示，SIGKILL 后真实断线继续保留。准确 owner 全量、原失败与本地交付证据见[客户端修复进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11客户端迟到读取误报)。

## 原启动诊断保存

原 [saveStartupDiagnosticReport](electron/startup-report.ts) 从 kite-desktop 逐字迁入，原两项[保存测试](test/startup-report.test.ts)只调整 owner import。Service 的真实 Store 打开失败产生闭合 `data_unavailable/opening_store`，配对启动准入失败在关闭所属 child 后把有效诊断交给 [Main](electron/main.ts)。没有有效 Service 诊断的通用连接、资源或目录错误不显示保存按钮；重试清除前次诊断，进入主界面不保留该启动操作。诊断协议与报告生成归 [Service owner](../service/README.md)，不导入旧 runtime，也不恢复旧数据迁移。

[preload](electron/preload.ts) 固定提供 `startupStatus/saveStartupDiagnostic`；[IPC](electron/native-ipc.ts) 只接受无 payload 的两个固定端口，核当前窗口、准确主 frame 和 renderer URL，不打开业务 caller。renderer 只得到可保存与保存结果，不接收报告、路径或任意文件写权限。Main 复用原系统保存对话框、JSON filter 和默认文件名，只有用户选定新路径后才以 `wx/0600` 写入。取消不写，已有文件不覆盖；保存失败沿原启动页说明选择新的文件名重试，不把 OS 异常正文或路径送回页面。对话框等待后重新核 frame、当前窗口和捕获报告，重试或退出撤销旧保存资格。

报告保原 `kite.startup-diagnostic.v1` JSON 形状、缩进及固定处理提示，只记录当前真实错误分类与准备阶段；没有有效的存储格式号诊断，`actualSchema/expectedSchema` 均为 null，不推断损坏类型或旧格式迁移。原 [NativeStartup](src/native-startup.tsx) 的保存按钮／错误提示与明确重试沿当前 [NativeDesktop](src/native.tsx) 接入。保存和读取诊断不发送任务、不修改原 Store。

[闭合诊断](../service/test/startup-diagnostic.test.ts)、[实际配对失败与重试](../service/test/isolated/paired.test.ts)、[Main 保存资格](test/native-startup-ipc.test.ts)和[启动 DOM](test/isolated/native-startup-dom.test.tsx)分别核 producer、交接、无 payload／迟到 frame 与报告变化、原页面及固定失败提示。原[源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)保已有任务／冷读／退出断言，再以同一不可变候选运行[诊断 driver](test/native-startup-diagnostic-electron.fixture.ts)：真实坏 Store、原保存入口、取消／已有文件／新 JSON、原坏文件保持、外部修复后同窗口明确重试和零 Model。只有 OS 对话框的选路径 callback 被控制，不代证 OS 人工点击或所有存储故障分类；原 120秒整例预算保持，新增 driver 有界20秒，页面10秒。实际结果、输入和仍未验的完整恢复／平台范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原启动诊断保存与明确重试)。

## 原主题与窗口背景联动

[useNativeTheme](src/native-theme.ts)沿原 kite-desktop Hook 与原 Sidebar 的“暗／亮／跟随系统”，继续使用 `kite.desktop.theme` 本机偏好、DOM theme／color-scheme 和系统媒体监听。现有[preload](electron/preload.ts)固定提供 `NativeThemeBridge`；业务 `NativeBridge` 仍只持原请求与观察，有限展示夹具可不提供窗口端口。主题沿独立固定 IPC 到[Main](electron/main.ts)，只接受原三个值、当前窗口的准确主 frame 与 renderer URL；额外字段、陌生值、其他 frame 和已销毁窗口在改变外观前拒绝。

Main 迁入原 nativeTheme.themeSource、创建时背景和 updated 监听，无系统材质时窗口底色与共享主体使用相同的浅色 `#fafafa`／深色 `#191919`，关闭后移除所属监听。主体与输入框、卡片的明度层次由 [UI 共享样式](../../packages/ui/README.md#原桌面展示层)统一管理；Mica／Vibrancy 的窗口与左侧导航继续透明，不以主体实色覆盖。固定主题随原偏好立即同步，跟随系统时由实际外观引擎更新；恢复本机偏好沿同一 Hook。窗口外观端口不打开业务 caller，连接或初始化失败不妨碍同步已有偏好，也不改变 Store、任务、草稿或 Service 生命周期。公共 HTTP 和私有数据格式保持。

原四项[主题 Hook 测试](test/isolated/native-theme-dom.test.tsx)只迁 owner／Hook／bridge 名称，保原恢复、系统变化、固定主题、存储拒绝和 DOM 断言；[Main 端口](test/native-theme-ipc.test.ts)核闭合值、准确 frame、连接失败及零 caller 启动。原[源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)从原用户菜单切换三档，核真实 Main／页面底色、Electron 外观引擎更新和冷启动偏好，保全部原业务与收尾。Playwright 默认浅色模拟须取消后才观察真实 Native 引擎；测试仅驱动该引擎，不修改用户系统外观。高速人工拉伸与完整产品视觉资格不由底色状态断言代证。准确输入、原失败与实际通过见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原主题与窗口背景联动)。

2026-10-20 Windows x64／Bun1.4.3，`5dba8a6b` 加本次配色改动：上述两个主题整文件8项／60断言、Desktop typecheck、定向Biome与文档检查通过。Chrome155以隔离的原 Native 会话夹具和实际 Vite／Tailwind 编译样式，核深浅主题×实色／Mica／Vibrancy样式分支×1280／500px共12种组合，主体、标题与输入框色值正确、主体前景对比度保持，宽窗菜单与设置的有效底色正确、透明分支的导航和根承载层保持透明，无页面异常或横向溢出。原 macOS 整窗口夹具的色值断言已同步；本轮浏览器检查不代替实际系统材质合成或完整安装版窗口资格。

## 原消息复制与标题栏缩放

Native [renderer 入口](src/native-main.tsx)明确开启 `NativeDesktop` 的 `nativeWindow` 布局，由[窗口容器](src/native-window-frame.tsx)承载启动与业务页面，启动页显隐按[启动显示规则](#原启动页与初始化重试)。普通 DOM 嵌入默认不套窗口布局。Windows／Linux 的沉浸式窗口顶栏单独占32px，内容区从 y=32px 开始；Mica 会话面板另按下文圆角留白内缩。macOS 将原生窗口按钮与48px业务 header 整合，内容区从 y=0 开始，不再额外保留32px空行。[Main](electron/main.ts)在 Windows／Linux 设置 `titleBarStyle: hidden` 和32px的透明 `titleBarOverlay`，不另显示系统应用图标与标题；macOS 保 `hiddenInset`，traffic-light位置为 `{x:13,y:17}`，与业务 header 垂直居中。`nativeTheme` 更新同步按钮符号颜色，窗口背景继续沿原主题端口。选择 [Electron 原生叠层](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)是为了保留宿主的窗口操作，不新建最小化／关闭 IPC 或另一套按钮状态。

[Main](electron/main.ts)创建主窗口时设置 `minWidth: 800`（Electron逻辑像素），初始尺寸保持1100×780；系统调宽受此下限约束。当前没有保存／恢复窗口尺寸的独立路径。共享页面仍适应缩放后的CSS宽度，左侧栏仅由按钮收展；header和底部个人工作区的内边距不再受900px媒体查询改写。

[Native CSS](src/native-tailwind.css)通过明确的 `data-native-window`和平台属性限定窗口展示；共享 Web 页面不因此变为可拖拽。Windows／Linux 只由独立顶栏声明 drag，内容区使用剩余高度，全屏设置相对内容区定位，所有宽度的侧栏都留在该内容区内，仅由按钮收展。macOS 的顶栏元素改为左上角80×48px的绝对定位区域，不占流式高度；侧栏顶部隐藏重复品牌文字，侧栏收起时通过已有 `sidebar-visible` 状态将安全间距转移到主 header。设置侧栏顶部统一保留48px窗口操作空间，导航另留与主侧栏一致的8px顶部间距，保持键盘焦点轮廓完整；“返回应用”置于同一分类导航首项，在其下方按正常列表排列，不再单独增加横向避让。返回按钮使用共享ghost按钮，带14px返回箭头，32px高、10px图文间距，与主侧栏“新对话”规范一致；其余四个分类沿共享SettingsNavigationIcon提供齿轮、链接、插头及书本，统一14px、10px间距和左右10px内边距，宽窄窗口均与返回行的图标及文字列对齐，分类保留原36px行高；关闭设置仍恢复原会话、草稿与焦点生命周期。macOS 的侧栏、会话、右栏与设置 header 空白声明 drag，内部按钮、链接和表单控件声明 no-drag。顶栏区域在 modal 遮罩之上保留窗口操作。此变更不增加 Service 能力，不改变关闭隐藏与原退出收尾。

2026-10-15 macOS／Electron 44.3.0／Bun 1.4.2 的隔离实际 Main／preload／renderer 与配套 Service 验证了整合布局：1100×780窗口的业务区从 y=0 开始，侧栏 header 高52px，原生按钮位置为 `{x:13,y:19}`；侧栏收起、设置往返、文件变更及760／550／400px窗口的窄侧栏与设置控件均避开按钮区域，草稿往返保留，页面无异常。Windows／Linux 的平台 CSS 切换核实独立32px行保留，不代替这两平台的原生窗口验证。现有窗口交互、启动与共享页面三个完整测试文件共16项／171断言、Desktop typecheck、定向 Biome 和文档检查通过；drag／no-drag 核对为计算样式证据，未进行物理鼠标拖拽验收。

[正式 Native 页面](src/native.tsx)接回原 kite-desktop 的 `copyText`／`handleHeaderMouseDown` 行为，仍由原 SessionPage／Conversation 决定可复制正文及 header 交互。[preload](electron/preload.ts)固定提供 `NativeWindowBridge` 的文本复制、窗口缩放及只读材质查询，沿三个固定 IPC 到 [Main](electron/native-ipc.ts)；当前窗口、准确主 frame、renderer URL 与闭合 payload 验证先于宿主动作。文本按原宿主上限接受至 1 MiB UTF-8 字节，超限明确失败，不截断或替换正文；缩放不接受 payload，按实际 isMaximized 切换 maximize／unmaximize；材质查询同样无 payload，只返回 `mica/vibrancy/none`。窗口端口不打开 Service caller，不提交任务或写私有存储。

Native 正文中的 Code Block 单独复制沿用上述原宿主 port 和 1MiB 上限，仍须取得原 Conversation 的准确 `copyText` 资格；预览、流式和未知最终身份不出现代码复制入口。共享 context 覆盖 `NativeModelOutputMessage` 的自定义正文子树，完整 reader 关闭即撤销；缓存校准只暂停操作，保留原代码 PRE、横向阅读位置和已完成反馈。子详情同样以当前 reader 的 `onContent` 和准确阅读身份提供可复制全文，而不是把已取得的 snapshot 长期当作复制资格；关闭全文同步撤销整消息与代码复制，重新读取后才恢复，换 Store／Session／Execution、generation 或快照不能沿用旧资格。临时暂停时保留正文、阅读位置和已有复制反馈，仍由当前读取资格禁用操作；reader 的明确关闭通知单独撤销复制，包括暂停期间关闭，不把普通暂停误当成用户关闭。[子详情复制回归](test/isolated/native-child-copy-dom.test.tsx)核完整正文关闭后的截断代码预览、重新读取及身份失效。[正文缓存 DOM 回归](test/isolated/native-model-output-cache-dom.test.tsx)核完整 reader 的代码复制、停用与关闭，[浏览器缓存夹具](test/conversation-cache-browser-runner.fixture.ts)核实际生产样式及 A→B→A 的节点、滚动与宿主复制。

原 header 只接左键单击／双击，控件与链接不触发窗口操作；单击不缩放，双击切换。失败沿原 AlertDialog，草稿保留。原完整正文门禁保持：预览、不完整回复和未知最终身份不启用 Agent 复制，完整 reader 当前已显示并核实的原文才可复制，关闭撤销资格；成功／失败提示仍归原 Conversation。

2026-10-14 独立顶栏初次验证（Mica 圆角内缩前）：Windows x64／Electron 44.3.0／Bun 1.4.2 的隔离实际窗口使用当时 Main／preload、普通模式 renderer 构建与真实配套 Service，顶栏与原生叠层均为 y=0、高32px，导航及侧栏 y=32px、高52px，导航恢复24px右侧间距。782px内容 viewport 下业务区与设置页均为750px、高度准确到窗口底部；500×720窄窗口的侧栏浮层从 y=32px 开始、高688px。实际主题菜单亮／暗、设置返回、侧栏展开／关闭、最大化／还原、零页面异常与 Main 正常退出0通过。原窗口 IPC／DOM 两个完整文件5项／53断言、Desktop typecheck与定向Biome通过；构建保原 CSS keyframes 优化与大chunk提示。此范围没有物理鼠标拖拽、Linux／macOS新窗口或正式安装制品资格，原平台门禁保持；当前 Mica 面板几何按下文验证。

[Main 端口测试](test/native-window-ipc.test.ts)核原 Unicode／换行、UTF-8 边界、准确 frame、宿主失败、连接失败及零 caller；[实际 Native DOM](test/isolated/native-window-actions-dom.test.tsx)核原 header 过滤、双栏回调和失败时草稿，原[轮次 DOM](test/isolated/native-transcript-dom.test.tsx)保全文复制门禁。原[源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)首次／冷启动以实际 Main 剪贴板读取核准确完整正文，浏览器 fallback 明确失败；测试的[剪贴板保护进程](test/native-clipboard-guard.fixture.jxa)仅在内存保留原各格式字节，stdin 关闭时恢复，不导出用户内容。header 的 DOM 事件验证真实 BrowserWindow 缩放，不代证物理鼠标双击或窗口拖拽；完整 PC 资格仍另核。准确输入、执行结果与未验范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原消息复制与标题栏缩放)。

## Windows 顶栏菜单

[窗口容器](src/native-window-frame.tsx)在进入主界面后，于 Windows 顶栏左侧绘制“文件、编辑、视图、帮助”，沿共享主题颜色和圆角，菜单按钮使用 `no-drag`，其余顶栏保持原拖动区域。菜单支持 F10、左右键与下键，以及 Alt+F／E／V／H；点击时保留原编辑器焦点与选区。macOS／Linux 主界面保留原顶栏。窗口布局由 `NativeDesktop` 明确启用，启动准备及失败页按[启动显示规则](#原启动页与初始化重试)隐藏 header，进入应用后全屏设置页继续保留菜单。

[菜单 owner](electron/native-window-menu.ts)定义中文原生项，[Main](electron/main.ts)安装隐藏的窗口菜单以保留原生快捷键，再从相同模板通过 [Electron Menu.popup](https://www.electronjs.org/docs/latest/api/menu#menupopupoptions)打开对应下拉，不增加另一行菜单。编辑、缩放、全屏、隐藏与退出使用 Electron roles，退出仍经过原 `before-quit` 与 `settleDesktopQuit`。文件前三项沿固定事件返回原 renderer controller 的 `prepareConversation`、`addWorkspace` 与设置状态；Ctrl+N／O／, 在 Main 的 `before-input-event` 中按同一固定动作分发，拒绝组词、重复和额外修饰键，并阻止重复进入原生 accelerator。F10／Alt 导航留给 renderer。准备中、原 mutation 进行中或退出中不进入页面操作，迟到事件同样核当前状态。进入新对话保原草稿，不创建会话或发任务，添加空间保持原准确选择及登记路径。

Windows Native 的全屏设置保留已有 `covered` 内容区的隐藏与 `inert`，设置 Dialog 使用非 modal 模式以保留顶栏的鼠标、键盘和可访问入口；顶栏交互不触发外部点击关闭，原返回与 Escape 仍可用。其他嵌入及平台保持原 modal 模式。

[封闭菜单 bridge](src/native-menu-bridge.ts)只暴露四个 menu ID、整数位置与当前可操作状态，以及三个固定页面动作。[preload](electron/preload.ts)过滤未知事件并在卸载时移除监听；Main 核当前窗口、准确主 frame、renderer URL、Windows 平台、闭合 payload 和窗口边界，按实际页面缩放换算下拉位置，窗口菜单端口不打开 Service caller。宿主错误返回通用失败，顶栏允许再次打开。设置和目录仍由已有业务端口核权限。

[菜单端口测试](test/native-window-menu.test.ts)覆盖页面缩放、禁用项、文件快捷键的修饰／组词／重复边界、外来窗口／frame／文档、开发 HTTP 边界、闭合参数和宿主错误；[窗口 DOM](test/isolated/native-window-actions-dom.test.tsx)核四个菜单、现有页面动作、设置页菜单可访问、设置返回、添加空间原请求、草稿保留及零任务提交。

2026-10-14 Windows x64／Bun 1.4.2／Electron 44.3.0，`5f41fc3d` 加本次菜单 diff：使用当前 Main／preload、普通 renderer 构建与独立 Profile／真实配套 Service，实际窗口核四个入口、原生下拉、保留原输入焦点与全选、文件菜单进入设置／新对话、设置页继续打开菜单、草稿保留、Electron 输入端口的 Ctrl+, 与 F11 全屏／返回、F10／左右／下键与 Alt+H、实际放大／恢复、用户菜单暗／亮主题、32px初始内容起点及500px窄窗口。零页面异常、Main 正常退出0；文件快捷键验证使用 Electron 输入端口，原生项选择使用实际 MenuItem，不代证物理键盘／系统菜单鼠标点选。菜单端口、原窗口 IPC、窗口动作 DOM 与启动 DOM 四个完整文件13项／181断言通过；Desktop typecheck、定向 Biome、文档结构／影响核对和统一边界检查通过，Biome 保留原未改动 fragment 提示，构建保原 CSS keyframes 与大 chunk 提示。未运行完整默认测试、正式安装制品或其他平台新窗口；这项菜单改动不提升这些资格。

## Windows 原生 Mica

主体面板外沿使用 [Native CSS](src/native-tailwind.css) 的 `--native-content-shadow`：深浅主题均为向下1px、模糊6px的单层黑色阴影，亮色不透明度6%、深色28%。会话阅读区与工具右栏共用 `.client-content-frame`，阴影在框外绘制，1px半透明描边由不占位的 `::after` 覆盖整框；`--native-content-border` 亮色为黑色5%、深色为白色10%。右栏仅保留左侧1px内部分隔边，没有独立外边距、圆角、阴影或上／右／下描边；右栏内容在共同外框内展开和裁切。调宽把手保留命中与键盘行为，不增加占位边框。设置内容及其独立右侧编辑栏继续消费原主题阴影，接缝处裁去主区外沿描边／阴影以避免叠线。macOS 保持直角、零外边距及无外沿描边。

Windows 导航的 [Native CSS](src/native-tailwind.css) 将宽侧栏和窄窗口侧栏的外层左右 padding 归零，列表内边距设为6px、header设为10px；底部用户区沿共享负 margin 抵消列表内边距，使顶部分隔线铺满侧栏。此布局也适用于 Windows 实色回退，不改变调宽与收展逻辑。

[Main](electron/main.ts)根据实际运行宿主的 Windows build选择材质：Win32且build至少22621时，在窗口构造中设置 `backgroundMaterial: mica`，窗口背景保持 `#00000000`；主题变化只更新原生深浅外观与窗口按钮符号，不改回实色。范围由 [Electron](https://www.electronjs.org/docs/latest/api/base-window#winsetbackgroundmaterialmaterial-windows)及 [DWM](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type)的最低支持版本定义；较早 Windows 与 Linux 保持原实色，macOS 按下文使用 Vibrancy。具体材质绘制与系统降级归 [Windows Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)。

`getWindowAppearance()`沿前述窗口守卫只读 Main 选择，不从构建机、NODE_ENV或浏览器 User Agent猜支持情况。renderer在挂载前读取闭合 `mica/vibrancy/none`，读取失败或旧bridge缺此端口时按 `none`；这项外观读取不依赖 Service成功连接。明确 `mica/vibrancy` 的 Native窗口共用透明 root／body／Frame／shell作为材质承载层，窗口顶栏、`.client-sidebar-panel` 及内部 `.sidebar-header`／`.sidebar` 均透明，侧栏不另铺主题色，与顶栏直接显示同一原生材质；窄侧栏容器使用相同透明规则。主面板、会话header及main保留原实色page背景，输入框与卡片保留原实色card。设置dialog、分类侧栏与返回区透明，右侧设置内容显式填充background，面板圆角和留白按下文平台规则处理；未确认材质时保留原实色设置背景。共享Web不消费Native材质标记，Windows／Linux 独立32px顶栏及原运行权限保持。

设置是同级视图切换：[Native页面](src/native.tsx)将settingsOpen交给SessionPage.covered，主panel树保持挂载和原几何，以opacity0退出绘制，inert／aria-hidden退出交互，避免玻璃侧栏叠出下层正文、边缘或导航文字。保持挂载用于保留未发送草稿、阅读位置和panel状态，不执行会话重选、任务取消或新业务申请。窄侧栏原模态在covered期间关闭，返回后按原开关恢复；原返回自动聚焦在切换期间被抑制，设置自身仍有Radix焦点范围与Escape关闭。设置内容位于panel同级的overlays，明确showOverlay=false，不渲染会压暗材质或透出旧页面的遮罩；设置reader随原内容打开／关闭，Core／Service的authority与运行状态保持。

Windows Mica 的会话 `.client-content-frame` 默认保留四周6px外边距；仅在 `.shell.sidebar-visible` 且外层 `#navigation-resize` 的实时 `aria-valuenow` 存在且非0时，将工作区内共同外框的左侧外边距设为0、宽度扣除一份 `--native-panel-inset`，与导航之间只保留1px调宽分隔条，右侧始终为6px。右栏位于框内第二层 Group，开合不改变外框的右边缘、留白、四周描边和阴影。拖动导航到0时，CSS立即恢复共同外框左右6px，并将导航分隔条宽度归零、关闭其过渡；同一次按住拖拽仍可反向展开。样式消费原分隔条已有的实时ARIA，不等待鼠标释放后的 `onLayoutChanged`，不新增JS外观状态或改动宽度保存逻辑。收起导航和窄窗口回到默认四周6px；窄窗口浮层不匹配这条宽窗口规则。共同外框沿 `var(--radius)` 裁切内部背景，`workspace` 的内容视口允许外阴影绘制，阅读区与工具面板各自保持原裁切。设置内容仍沿原900px断点与编辑栏组合外侧留白，接缝为直角；macOS 的内容留白为0，直接铺满区域并移除外沿描边。调宽分隔不常驻竖线，原事件、ARIA、悬浮把手和键盘焦点环保持；仅已确认的 Native Mica／Vibrancy 消费玻璃留白，共享Web与实色回退不增加材质边距。

Windows `.sidebar-header` 的左／右内边距分别为16／10px，使 Kite 标题与主要导航、空间图标的左边缘对齐。桌面共用收展按钮的展开位置消费同一 `--sidebar-header-end-padding`，收起位置消费标题起始内边距；Mica／Vibrancy 加上内容的顶部留白，Mica 收起位置另计6px左留白，macOS 收起位置避让原窗口按钮区。按钮位于共享面板边界的零宽轨道，不受导航200px最小内容宽度的裁切，窗口拖动排除仍由 `no-drag` 保持。macOS 收起后按钮覆盖会话 header 内的 `.session-sidebar-toggle` 占位，该占位同样声明 `no-drag`，使原生拖拽区域明确扣除按钮所在位置；只给外部按钮声明 `no-drag` 仍可能被 header 的拖拽区域截获。

玻璃导航的 `.sidebar-header` 以同一 `--native-panel-inset` 设置顶部外边距，Windows Mica 为6px，macOS 为0px。Windows 标题行取消共享48px最小高度，由品牌内容和顶部10px内边距撑开，主导航顶部外边距沿共享8px；品牌、侧栏按钮、会话标题与操作按钮共用垂直中心。收展按钮两种状态均沿原 `--sidebar-toggle-top` 定位，Mica 下计入6px留白。macOS／Linux 沿共享48px标题高度居中。2026-10-23 的隔离浏览器加载当前生产 CSS 与标题结构，深浅主题、Mica／实色、1200／600px八组测得四处中心相同，侧栏收起与恢复时按钮中心不变；标题行随28／40px内容行高增为42／54px，主导航间距保持8px。该证据只覆盖浏览器布局，不代替完整 Electron 窗口交互或原生材质合成验收；2026-10-19 旧52px标题行的历史几何结果不作为当前自适应标题行的验收依据。

2026-10-25，macOS／Electron44.3.0：隔离 `hiddenInset` 窗口以系统鼠标事件复现收起后按钮不接收 pointerdown／click，而DOM点击仍能展开；占位排除拖拽后，系统点击可反复收展，邻近标题空白仍能原生拖窗。当前48px header与32px按钮保持。浏览器窗口回归同时核深浅主题下占位完整覆盖按钮、header仍为drag、占位为no-drag；CDP点击仅验证DOM交互，系统鼠标证据单独核实，未重验正式安装包。

Native 的面板左外边距／宽度及会话标题栏的左内边距仅在共享 Group 的 `data-animate-width=true` 时跟随180ms过渡，使 Mica 的6px留白和macOS窗口按钮安全间距与[共享标题占位](../../packages/ui/src/desktop/SessionPage.tsx)一起移动；手动调宽沿原事件关闭动画，减少动画偏好统一直接切换。2026-10-19 Windows x64／Electron44.3.0 的隔离实际组件与编译样式逐帧对照：原Windows Mica侧栏收起的标题反向跳动为50px，实色为44px，macOS样式标记为108px；修复后1086px可用宽度的反向偏移小于0.1px、垂直位移为0。786px紧凑布局另核深浅主题、有／无右侧按钮、实色及macOS样式，减少动画偏好另核五组，反向及垂直位移均为0。页面／侧栏／安排任务／Native新对话／后台五个整文件60项、1041断言和UI／Desktop类型检查通过；平台标记只验证样式，不代证其他平台原生窗口或安装资格。

Mica 分隔条在实时 `aria-valuenow=0` 时立即归零、关闭过渡的规则，只用于 Group 未进行程序动画的直接调宽。按钮收展仍沿共享分隔条过渡，避免快速反向切换时提前撤掉1px占位；原指针／键盘调宽事件先结束程序动画，因此按住拖到0仍立即恢复6px左留白，同次按住反向展开继续可用。

同日基于 `f734245a` 加当前未提交源码，`bun .cache/sidebar-rapid-20261019/run.ts wide-verified` 构建运行，再以 `compact-verified --width=800 --skip-build`、`reduced-verified --reduce --skip-build` 复用同一构建。隔离 Electron44.3.0 实窗加载实际 SessionPage、Conversation、Composer、NativeWindowFrame 与编译样式，独立用户目录、沙箱保持开启。1086／786px可用宽度及减少动画模式共36组，每组24次快速切换，共864次切换请求，另含同帧重复点击和最终状态校准；5795份位置采样包含逐帧跟踪与点击前后核对。修前 Mica 的面板与标题过渡相差约1px；修后标题、正文和输入框的非预期反向／垂直位移、点击瞬间突跳及滚动漂移均为0，节点、草稿、保存宽度与最终按钮／ARIA／inert 状态保持。键盘 Home 收起及 Chromium 输入事件保持按下拖到0后反向展开，18组均通过。420px上限经面板库按可用宽度换算，最终恢复宽度与初始值最多差0.532px，保存值仍为420；该边界核连续性、方向和最终状态，不假定归一化动画进度完全一致。上述五个完整测试文件本轮重跑60项／1041断言通过，定向CSS检查通过；这是本机组件布局与输入证据，未复验真实Service、完整安装包或其他平台原生材质。

2026-10-14 设置组件层验证（统一圆角前）：Windows 11 x64 build26300／Electron 44.3.0／Bun 1.4.2，实际当时Main／preload、普通renderer与配套Service隔离窗口核Mica标记。原Main窗口资格已由 `DwmGetWindowAttribute`确认 `DWMSBT_MAINWINDOW=2`；该次未改宿主材质选择。亮／暗设置中，主panel树opacity0但仍保持750px布局高度；向该树注入仅供验证的洋红底色后，返回区、分类栏及其与原主内容重叠区域的实际PNG alpha均为0，右侧设置内容为原主题RGB／alpha255，圆角和顶栏仍透明，无旧页面或黑色遮罩。主textarea和panel对象、未发送草稿及非零scrollTop（120px）在返回与Escape后保持；覆盖期间旧输入不能取得焦点。500×720窗口设置侧栏180px，原侧栏模态暂停，连续Tab均在设置内，返回后恢复侧栏并保草稿。零页面异常、Main退出0通过。[新会话DOM](test/isolated/native-new-conversation-dom.test.tsx)另核原输入实例、未发送草稿、返回／Escape、零重复attach／select／messages／draft.read和零发送；它与启动、草稿、读取归属、模型／提供商／MCP／Skills设置和窗口动作共九个完整文件44项／526断言通过。Desktop／UI typecheck及定向Biome通过。未运行完整默认、旧Windows或新macOS／Linux窗口，透明PNG不代证桌面壁纸最终合成或正式安装视觉资格。

同环境此前圆角与分界验证（统一圆角前）：亮／暗主题下四周留白均为6px，面板y=38、高738px（viewport782）；实际PNG的圆角切口、留白和未聚焦的调宽分隔均为alpha0，面板内部为255。实际Playwright键盘与鼠标调宽、聚焦把手的可见环、收展动画结束后的6px左留白均通过；500×720窄窗口面板为x=6、y=38、宽488、高676，无整页溢出。后续设置覆盖调整复用该次主面板与调宽证据；当前圆角值和本轮窗口验证见下文。此检查核renderer交互与绘制层，不提升未取得的安装或其他平台资格。

共享 [RightSidebar](../../packages/ui/src/desktop/RightSidebar.tsx) 的外观由 [Native CSS](src/native-tailwind.css) 管理。会话工具、文件变更、宿主详情和安排任务编辑在同一 `.client-content-frame` 内与阅读区等高，右栏是共同内容面中的一个区域；开合只重新分配内部宽度，接缝保留单一左边框。提供商／MCP／Skills 设置编辑栏继续沿原900px断点并排或覆盖，使用原独立宿主和外侧留白，覆盖时仍与设置内容等高。两类布局复用主题变量，关闭、滚动、焦点与读取生命周期保持。

2026-10-18 Windows x64、Bun 1.4.3，在 `f734245a` 加本次布局改动上，定向 `bun test --parallel=1 --max-concurrency=1` 的 Native 设置／新会话与共享页面／安排任务七个文件共136项、1823断言通过。隔离模拟桥夹具编译实际 Native 与共享 SessionPage，Chrome 155.0.8059.82 无界面检查72组几何状态：明暗主题、Windows／macOS／实色回退的 CSS 标记、设置400–1600px窗口及900px断点两侧、三类会话右栏和左侧导航收展均核等高与接缝；键盘调宽、分隔条上下边界及关闭后留白恢复通过，页面零异常。CSS Biome、文档结构／影响检查通过；未运行实际 Service、macOS／Linux 原生窗口或正式安装制品，不以 CSS 标记检查替代这些资格。

会话共同外框的1px淡边缘由 [Native CSS](src/native-tailwind.css) 的 `.client-content-frame::after` 绘制，位于实色标题栏与正文之上，不接收指针，也不增加占位尺寸。右栏展开及退出期间，外框四边持续绘制，内部接缝由右栏左边框承担。右栏内容不穿过框外固定6px右侧留白；导航开合只过渡共同外框的左外边距与宽度。内部阅读区和右栏沿原180ms缓出同步调宽，内容视口关闭库默认 `overflow:auto`，正文和代码块继续在原容器内滚动。macOS 移除共同外框描边并铺满原区域。布局与动画由[共享 UI](../../packages/ui/README.md#原桌面展示层)负责，取舍见[共同外框记录](../../.agents/notes/implemented/bug-fix/2026-10-20-session-content-frame.md)。

2026-10-18 Windows x64／Bun 1.4.3／Chrome 155.0.8059.82，在 `f734245a` 加本次修复上，隔离夹具加载实际 SessionPage 及当前 Vite 编译样式：100%／150%缩放下三类右栏共60组开合逐帧检查，左栏的物理像素边界保持稳定，最大 CSS 量化差为1/64px；修复前同类场景曾短暂偏移约113px。真实鼠标将右栏调宽80px，左栏位移为0；键盘调宽、动画中切入调宽、快速反向开合、左栏收展恢复和减少动画设置通过。亮暗主题在标题及正文左边缘均读到描边像素，macOS CSS 标记仍为无描边。定向 `bun test --parallel=1 --max-concurrency=1` 的共享页面、安排任务和 Native 新会话三个文件46项／713断言、UI typecheck及定向Biome通过；未复验真实 Service、原生壁纸合成或其他平台实窗。

2026-10-20 Windows 11 x64 build26300／Bun1.4.3／Electron44.3.0（Chromium152.0.7977.78），`5dba8a6b` 加本次共同外框 diff：隔离测试制品从现有[浏览器 UI 夹具](test/native-browser-ui.fixture.tsx)和[原生宿主夹具](test/native-browser-electron.fixture.ts)编译实际 SessionPage、NativeWindowFrame、NativeBrowserPane、preload 与浏览器 controller，并开启可见原生窗口及独立用户目录。亮暗主题、1280／900px、新标签页／变更／实际 WebContentsView／长正文共32段开合逐帧检查通过；阅读区与右栏首次移动采样相同，宽度总和最大误差小于0.001px，外框右侧6px留白固定，零临时主区滚动条、零内容溢出，收起时原生网页立即隐藏。8个开合状态的PNG核四边持续可见、外侧留白不含实色栏内容；4组亮暗／减少动画配置核快速反向、Escape与焦点、拖拽／键盘收起及导航同开。另核900→800→700→650→500→700→900px恢复和显式关闭保持；16组平台／材质／主题／减少动画样式配置通过，其中macOS／Linux仅为CSS标记检查。`bun test --parallel=1 --max-concurrency=1` 的共享页面、标签页、导航、安排任务及Native文件变更、浏览器、新对话七个整文件共67项通过，移除固定面板数量断言后页面整文件13项另行复验；UI／Desktop typecheck、定向Biome、文档结构／本次作用域影响核对及统一边界检查通过。该证据不覆盖正式安装制品、真实Service或其他系统原生合成；既有嵌套 `@keyframes` 编译提示保留。

## macOS 原生玻璃

[Main](electron/main.ts)在 macOS 窗口构造中设置 `vibrancy: sidebar` 和 `visualEffectState: active`，窗口及主题更新的底色均保留 `#00000000`。使用 [Electron 原生 Vibrancy](https://www.electronjs.org/docs/latest/api/structures/base-window-options)使材质由 macOS 合成，失焦时保留活动材质，深浅外观沿原 `nativeTheme` 端口同步；不设置 `transparent: true`，保留普通原生窗口的缩放与阴影。Main 只读报告 `vibrancy`，[preload](electron/preload.ts)接受闭合新值，未新增让 renderer 自选窗口效果的端口。

macOS 复用上述玻璃透明层、设置遮盖、导航对齐和调宽样式，并将 `--native-panel-inset` 设为0。会话共同外框 `.client-content-frame`、内部 `.client-main-panel` 与设置 `.settings-content` 均使用0px外边距和直角，内容铺满可用区域；共同外框不绘制外沿描边，内部卡片和输入框仍沿原样式。侧栏 header、会话 header 与 `{x:13,y:19}` 的原生窗口按钮保持同一顶部行。启动中与失败页同样透明；会话正文和设置右侧继续实色。系统材质的最终合成由 macOS 管理。

同日内容铺满调整后，隔离实际窗口重核13种状态：亮暗主题的主面板与设置内容均为0px圆角、0px外边距、无阴影描边，高度铺满780px可用区；550／400px设置内容同样到达窗口右边界。玻璃透明层、侧栏收展、键盘调宽、草稿往返保持，Mica 平台 CSS 仍为10px圆角和6px外边距；页面无异常，CSS Biome及文档检查通过。本次仅改 CSS，沿用未变 TypeScript 的前轮检查结果。

2026-10-15 macOS 26.7.1／Electron 44.3.0／Bun 1.4.2，内容铺满调整前的隔离实际 Main／preload／普通 renderer 与配套 Service 的13种状态核对通过：原桥返回 `vibrancy`，亮暗主题经原用户菜单切换后透明承载层保持透明，NativeImage 中导航空白 alpha为0、正文为255；向原主面板注入洋红底色后，设置左栏与原主面板重叠区域仍为alpha0，右侧内容为255。侧栏收展、键盘调宽、550／400px窄侧栏和设置往返保留草稿，顶部 header仍从y=0开始，原生按钮位置和窗口可调宽保持，页面无异常。另核 Mica 与 `none` 的 CSS 适用边界；窗口 IPC、窗口动作 DOM、启动 DOM 三个完整文件9项／155断言、Desktop typecheck、定向 Biome 和文档检查通过。此证据覆盖宿主接线和 renderer 透明层，未核系统壁纸最终合成或切换系统辅助功能设置。

## 交互状态与透明材质

Native 的[普通设置样式](src/native-tailwind.css)与[提供商／MCP／Skills 列表](src/native-provider-settings.css)消费 [UI owner 的中性交互变量](../../packages/ui/README.md#原桌面展示层)，顶栏菜单与设置内容沿用默认的悬停／选中／按下分级；设置返回与 `.settings-sidebar` 将按下变量局部映射到悬停值，与共享侧栏保持一致。已选设置分类将按下变量映射到选中值，避免点击时加深；Tailwind 的 `--color-accent` 映射到 `--control-hover`，使移出页面树的菜单也遵循同一规则。原 `--accent` 继续服务静态内容，不随交互高亮调整。实色主操作保留原角色配色，禁用状态和键盘焦点沿原控件语义。

2026-10-19 Windows x64／Bun 1.4.3／Chrome 155.0.8059.82，在 `f734245a` 加当前未提交源码上，用隔离夹具加载实际 SessionPage、Sidebar 与 Native 编译样式，Windows／macOS CSS 标记下亮暗、Mica／Vibrancy／实色、窄侧栏、选中导航与设置分类选择器共14组对照：悬停／按下底色不一致的采样由64处降为0。键盘按下空间标题只绘制一层背景，焦点提示、透明承载层、草稿和主区普通按钮的原按下反馈保持；页面无异常，定向 CSS Biome 与文档检查通过。设置页仅核选择器夹具，未复验真实 Service、Electron 实窗或系统材质最终合成。

[Native 页面](src/native.tsx)向共享 SessionPage 传递选中ID时，有明确导航目标则同时核 `selected.current` 与已读取的 `selection.session.id`。切换中保留的旧会话事实只用于原正文及写入门禁，不重新涂成当前选中项；新事实确认后才显示目标行高亮。没有显式切换目标的初始已选会话、同会话刷新及原晚到响应守卫保持。回归归[新对话与导航 DOM 测试](test/isolated/native-new-conversation-dom.test.tsx)。

2026-10-19 Windows x64／Bun 1.4.3，在 `f734245a` 加当前未提交源码上：选中高亮回归先复现延迟选择响应时旧行仍带 `aria-current="page"`，修后核初始已选会话、会话／全局及项目准备入口、缺选择的 Main 发布、目标确认与晚到响应。新对话、会话导航及共享页面三个整文件44项／981断言，Desktop typecheck、定向 Biome 和文档检查通过。Chrome 155.0.8059.82 隔离实际 Native renderer 沿既有模拟桥，亮暗下三种入口及键盘共8组逐帧核对，修前8组误选旧行，修后为0；两种准备入口的4组旧行背景 alpha 全程为0，同目标刷新保留高亮。未改共享 hover 配色、会话选择请求或写入门禁；未复验真实 Service 或 Electron 实窗。

Mica／Vibrancy 的背景明度与壁纸合成继续由系统材质管理，承载层保持透明，不为每个按钮重复添加模糊或读取壁纸。半透明交互层只控制组件的叠色；完全透明且明暗不受约束的底图无法仅靠一种 hover 色保证对比度。此边界也符合[系统材质的可读性说明](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic#legibility-considerations)。

2026-10-19，基于 `f734245a` 和当时未提交源码的中性交互调整：Windows／Chrome 155.0.8059.82 隔离夹具加载实际 SessionPage、共享控件与当前 Native 编译样式，Windows／macOS CSS 标记下亮暗主题各4种模拟材质底色，以及540px侧栏共18种状态通过。普通按钮、空间／会话／导航／用户行、移出页面树的菜单核同一 hover，选中悬停与按下强度分开；禁用背景、键盘焦点、透明承载层、正文及草稿保持。另8种模拟底色的截图像素符合黑5%／白7%叠色，样本导航文字对比度最低约6.08:1；实际 NativeWindowFrame 与设置选择器夹具的亮暗2种状态核顶栏开合、设置返回／分类、提供商与目录按钮、选中悬停、禁用和实色保存按钮。三份 CSS 的 Biome、文档结构与影响检查通过。本轮未运行真实 Service、Electron 壁纸最终合成或其他平台实窗，模拟材质结果不构成任意壁纸可读性保证。

## 统一桌面圆角

Native 统一消费[共享 UI 的圆角变量](../../packages/ui/README.md#原桌面展示层)：普通按钮和菜单项为8px，字段与弹出层为16px，提示词输入框内部按钮为胶囊形。[设置／Mica 样式](src/native-tailwind.css)与[提供商表单](src/native-provider-settings.css)分别按用途引用 `--button-radius`、`--input-radius` 和 `--radius`；[正文排版](src/native-typeset.css)继续消费表面圆角。macOS 主内容与设置内容另按上文采用直角；Tailwind 尺寸别名、圆形及拼接直角的范围归 UI owner。现有 Mica 透明层、6px留白、设置覆盖与业务交互保持。

2026-10-23，Windows x64／Bun1.4.3／Chrome155.0.8059.85，基于 `de498789b` 的当前圆角与输入区 diff：实际共享组件与生产编译 CSS 在深浅两套组件画廊及1280／390px四组会话中核对按钮、字段、主／子菜单、Tooltip、Dialog 和 Sheet。提示词选择器为13px文字、14px图标、28px高度与上下4px／左右6px内边距，附件／发送图标保持16px；宽屏左右两组中心一致，窄屏换行后各组仍居中，无横向溢出。观察圆环提示的悬停与键盘聚焦、复制反馈、模型选择、权限和附件菜单的展开与关闭，以及弹窗归焦，草稿与消息保持；14px状态圆环为独立SVG，鼠标、Enter与Space均未提交任务，无页面异常。四个相关原文件22项／198断言、UI／Desktop类型检查及定向Biome通过。夹具使用模拟回调，不读取用户数据；未重验完整安装版Electron，保留既有嵌套 `@keyframes` 编译提示。

2026-10-14 同环境、基于 `006b79d3` 的当前圆角 diff：隔离普通 Native 构建和真实 Service，由实际空间选择入口登记测试目录（仅控制系统选择框回调）。亮／暗实际 computed style 核空间列表、主面板、Composer、建议按钮、项目选择、用户菜单及菜单项、设置内容、卡片、选择框与导航按钮均为10px；临时将根变量改为14px后全部随之改变，随后恢复10px。顶栏、设置分类栏与返回区保透明；500px窄窗口仍为同一圆角，返回与Escape保原输入实例和未发送草稿，圆形发送按钮与全屏直角保持。截图核布局，零页面异常、Main退出0通过。Desktop／UI typecheck、三份 CSS 的 Biome 和 diff 检查通过（保留原三项 `!important` 提示）；构建保原 keyframes 优化与大chunk提示。仅核本轮桌面外观，未运行完整默认测试或其他平台／安装制品验证，不将先前完整状态矩阵作为本轮重跑结果。

2026-10-19，基于 `f734245a` 和当时未提交源码的16px调整：Windows／Chrome 155.0.8059.82 隔离夹具用实际 `SessionPage`、共享控件及 Native 编译样式核对1600／1000／540px亮暗共6种状态。面板、空间与会话行、输入框、环境卡、正文代码／引用／表格、菜单及弹窗随根变量由10px变为16px；发送按钮保留圆形，右栏拼接边和 macOS 主内容保留直角。前后布局尺寸与草稿相同，页面无异常；定向 CSS 和文档检查通过。本轮未重跑 Electron 实窗或平台发行资格。

## 玻璃导航间距

[Native 玻璃样式](src/native-tailwind.css)在 macOS 宽窗口的 `#navigation .client-sidebar-panel` 左侧加入 `--native-panel-inset + --resize-handle-width` 留白，补偿1px调宽占位；macOS 的内容留白为0。Windows 宽、窄侧栏均取消这份外层补偿，采用上述6px列表内边距，用户区负 margin 将分隔线展开到容器左右边界；Mica 主面板的展开与实时收起边距按[上述样式规则](#windows-原生-mica)处理。共享分隔宽度的定义归 [UI owner](../../packages/ui/README.md#原桌面展示层)，原200～420px调宽范围保持。共享 Web、macOS 的列表内边距及未确认材质时的主面板布局保持。

2026-10-16 Windows x64 的隔离 Chrome headless 页面加载实际 SessionPage 与 Native／共享 CSS：200px侧栏展开时，分隔线止于x=200，正文从x=201开始，只保留1px分隔条。前轮验证只核鼠标释放后的收起布局；补测发现按住拖到0时，旧 `.sidebar-visible` 仍为true、主面板左边距仍为0。改用实时ARIA后，亮暗主题下实际 `buttons=1` 的收起／反向展开／再次收起均通过：收起时主面板左右6px、分隔条0px，展开时主面板贴齐1px分隔条；拖动中偏好写入0次，松开到展开宽度后才保存1次。按钮／键盘收起、窄窗口浮层开关／Escape、截图和零页面异常通过。此前宽窄切换验证与本轮区分，不把旧鼠标释放后结果当作持续按住证据。此验证只覆盖renderer布局和交互，未启动真实Main／Service或验证原生Mica合成。

2026-10-14 Windows 11 x64 build26300／Electron 44.3.0／Bun 1.4.2，基于 `006b79d3` 的本轮 CSS diff：隔离普通 Native 构建与真实 Service，修前实际常用入口／空间行左右为12px／19px，分隔1px加内容留白6px确为差值；修后两侧均为19px，header两侧23px、用户区15px、底部分隔线7px。亮／暗、200px起始宽度、键盘左右调宽、鼠标拖到420px及收展后均保持等距；500px窄窗口两侧仍12px，取消Mica标记的普通布局不加补偿。设置返回与窄侧栏Escape保未发送草稿；截图核布局、零页面异常、Main退出0通过。两份 CSS Biome与diff检查通过，保原三项 `!important` 提示和构建提示；未改TypeScript，前轮Desktop／UI typecheck范围可复用。未运行完整默认、其他平台或正式安装验证。

## 原窗口关闭与退出收尾

配套 launcher 的普通 close 等待 Service 自然退出，没有默认5秒强杀。Main 的菜单退出、信号和开发父连接 EOF／error／close 共用一次停止；确认或空闲直接退出时，先销毁客户端窗口，再由原 Main 在后台等待在途重载、启动及同一个资源 close Promise。清理完成退出0，清理失败沿准确所属 child 强退1，不再要求用户处理收尾提示，也没有默认20秒强杀。菜单的迟到检查、决定或错误不能撤销已接管的停止；首次确认选择保留服务仍沿原路径恢复。普通关闭窗口仅隐藏。当前单次确认与界面先关闭的取舍见[退出决定](../../.agents/notes/implemented/bug-fix/2026-10-22-single-confirmation-exit.md)。

[原 Main 有限宿主回归](test/isolated/native-main-scheduling-lifecycle.test.ts)核关闭屏障、信号／父通道、重载与迟到菜单决定；[真实 paired 多 Agent 进程](../service/test/isolated/paired-shutdown.test.ts)核超过旧5秒后的实际存活、自然退出和冷终态。前者控制 Electron 端口，不冒称物理窗口或 OS 信号；后者限本机进程和平台，其余原窗口资格按本节既有证据分别核对。

[Main](electron/main.ts)保留普通关闭窗口时隐藏、activate 时显示并聚焦的现有行为，阅读、草稿和所属 Service 不因此停止。明确退出先从完整 Session 目录／View 只读核活动或未知执行；原两秒检查上限沿 [inspectNativeQuitWork](electron/quit-settlement.ts)接当前 NativeCaller，只 abort 本次检查 GET。活动、失败或超时只显示一次确认，默认保留服务；开发重载或首次启动未完成直接按未知工作进入该确认，不先无限等待。取消退出后可继续原页面；检查不提交业务或重发任务。没有可用窗口时使用无父窗口确认；窗口或确认异常仍关闭界面并收尾，不另弹错误框。

确认未答时，已开始的启动和开发重载在原 owner 的交接点等待该决定；此时不提前丢弃新 Service，也不继续发布 caller。取消后沿同一次启动／重载恢复，确认或外部停止后释放决定并进入原清理，避免保留服务后仍卡在 draining。退出中迟到的窗口加载失败不再弹启动错误框，也不重复清理。

停止 Promise 在窗口销毁前接管 owner；Main 清空全局窗口引用并用 `destroy()` 绕过普通 close 隐藏与 beforeunload，随后才开始后台清理 await。macOS 同时调用 app.hide／dock.hide；window-all-closed 不提前退出正在清理的 Main，activate、ready-to-show 和迟到 whenReady 均不能重开界面。窗口销毁触发原 browser pane 和主题监听清理；原 Caller／Service／lease 仍按实际关闭顺序保留，不另建 daemon 或替代 owner。

Main 开始退出和取消退出时通过原固定 event channel 通知 renderer；[preload](electron/preload.ts)只转发闭合的 `quitting/active` 生命周期。退出通知撤销旧 state、目录、选择与私有草稿读取的展示归属，暂停自动刷新；原 caller 的读取与资源仍按既有退出顺序收束。取消退出沿同一 generation 恢复读取，保留原草稿，不重新 attach、写草稿或重发任务。正在选择时的暂空输入不覆盖原草稿。真实当前错误、已提交写入的未知结果和异常收尾继续提示，不能仅凭 `native_draining` 错误码消除它们。

[读取归属 DOM](test/isolated/native-read-ownership-dom.test.tsx)保原八例，另核上述四类读取的退出失效／取消恢复、退出期间零自动刷新、当前 `native_draining` 仍提示和未知原提交仅查询同 commandId。[交互分页原窗口](test/isolated/interaction-pages-electron.test.ts)保原40项效果及全部预算，在正常退出时被动观察操作／启动误弹窗，分别核实际 Electron 与准确所属 Service 的零退出；清理失败不能由 `app.close().catch()` 算作正常。准确红绿及当前有限 macOS 验证见[退出误报修复进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-12native-退出期间操作未完成误报)。

[settleDesktopQuit](electron/quit-settlement.ts)等待唯一清理 Promise，实际完成返回 clean，抛错或拒绝返回 force；没有期限、提示回调或等待循环。Main 沿现有唯一清理顺序关闭原 caller、私有数据／使用权和配对 Service，另核实际 Service 退出为零后才释放制品使用权；launcher close 返回不代证正常退出。确认或空闲直接退出后只启动一次收尾；窗口先消失，后台成功后 app.exit(0)，失败只对 Main 当前直接创建的配对 child 句柄发 SIGKILL，随后 app.exit(1)。重复退出不另开确认或清理；不从 PID／目录发现任意进程，也不把未知效果改写为成功。父通道错误等既有非零退出码保持，业务／私有格式与公共协议保持。

[收尾测试](test/quit-settlement.test.ts)核正常、同步异常、异步失败、后台未完成时保持等待及迟到完成／失败，单次关闭且没有强杀定时器；[实际 caller 测试](test/native-caller.test.ts)核检查的同一 signal 传到完整目录与 View、超时撤销所属读取及零写。[默认源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)保全部原业务、冷读和双锁收尾，另在同一候选以[退出 driver](test/native-quit-electron.fixture.ts)核关闭／激活、SIGSTOP 实际 Service 时两秒未知确认与取消后保留草稿，以及确认后立即销毁窗口、重复退出／激活无新提示或界面复活、超过原二十秒仍在后台保原进程与锁、恢复 Service 后自然退出0。实际 Service SIGKILL 仍核窗口销毁、非零退出与双锁释放；生产候选／Service 字节保持。原生确认的响应来自有限 dialog port，不宣称 OS 对话框人工点击或真实 Service 全故障资格。原历史警告流程的证据保留在[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原窗口关闭与退出收尾)，不作为当前重复提示的产品要求。

新对话的 Git 查询／首次明确分支切换和默认编辑器入口现共用 Caller 所属的 [NativeProcessOwner](electron/native-processes.ts)。明确退出后，Caller 在首次 await 前封闭 helper 新准入，对仍属自己的原 ChildProcess 句柄请求停止，并等待实际 close；Main 继续在 Caller 完成之后释放私有数据／Profile 和制品使用权。Git 每次串行启动都重新经过该 owner，只读分支读取也纳入 Conversation 收尾。超时或启动错误保存首次失败，不能在仅发出 kill 后返回或被迟到的零退出覆盖；信号失败或 close 未到时界面已关闭，Main 在后台保留原资源等待结算。取消退出确认和普通窗口隐藏不关闭该 owner。范围仅为这些直接 helper，`/usr/bin/open` 后交给系统的编辑器应用仍属于 external，不构成全 Runtime 后代树证明。原十五秒 Git deadline、stdout／stderr 各1 MiB、严格 UTF-8 和编辑器十秒期限保持；期限确定超时结果，实际 close 才结束调用。默认 IPC 沿 `NativeCaller.openEditor` 登记所属 launcher；可信测试 opener 不进入生产 Main 装配。取舍见[Main helper 收束决定](../../.agents/notes/implemented/bug-fix/2026-10-10-native-main-helper-shutdown.md)。

[所属进程整例](test/isolated/native-processes.test.ts)和[实际 Node driver](test/native-processes-node.fixture.ts)核原 handle／双 EOF、首错与 Caller 收束；原首次发送真实 Git、文件目标／frame和上述完整窗口各核原范围。替代编辑器 executable 的夹具不操作个人应用，也不证明 OS 编辑器窗口已打开；准确执行归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10native-普通用户操作的所属-helper-收尾)。

## 会话标签页与内置浏览器

会话 header 的“标签页”图标打开[共享 SessionTabs](../../packages/ui/src/desktop/SessionTabs.tsx)，默认新标签页，首页仅有“变更”工具。关闭最后一个网页、变更或子详情标签会沿原收起逻辑关闭右侧栏并返回顶栏按钮，再次打开显示新的空白页。旧直接“文件变更”按钮移除；原调宽、折叠、主题与无下边框 header 保留。标签模型在响应式 Group 之外，侧栏收起与窗口缩放不销毁网页；关闭网页、换阅读 scope、页面卸载或 root renderer 导航／崩溃时释放对应 WebContents。工具与子详情 reader 仅在当前可见标签挂载，覆盖／切换／收起会释放读取。环境卡打开子 Agent 时选择原 Session／Execution 的详情标签，重复打开复用原项；全部标签共享8项上限。主会话始终保持显示与自身读取，子详情的准确目标、正文与操作门禁见[环境与子详情 owner](#native-当前会话环境信息与子详情)。

[renderer adapter](src/native-browser-pane.tsx)通过[封闭浏览器 port](src/native-browser-bridge.ts)发送导航与可见 viewport，preload 只交付有限操作与有界显示 metadata。[Main controller](electron/native-browser.ts)复用当前主窗口、准确 mainFrame 和 renderer URL 的 sender 校验，校验地址后才分配最多8个 WebContentsView。顶层导航只支持 HTTP／HTTPS；网页的 WebSocket 子资源可使用无凭据的 ws／wss，不开放对应的顶层或子框架导航。纯文本交 Bing 搜索，localhost 默认 HTTP，普通域名默认 HTTPS。地址栏聚焦编辑期间保留输入，失焦后同步最后确认的页面地址，包含重定向结果。历史操作使用 Electron navigationHistory；网页弹窗的 HTTP 链接在当前标签打开，下载与外部协议拒绝并保留必要错误。

网页使用独立非持久 session，无应用 preload，sandbox／contextIsolation／webSecurity 开启，Node、webview、DevTools 和权限申请关闭。网页不共享应用 Cookie 或 Service port；没有模型浏览接口、导入、扩展、下载或持久标签／历史。renderer 依据活动标签、窗口可见性、覆盖层和实际几何隐藏／定位 native view，网页 viewport 先与所属 ResizablePanel 的实际边界取交集，并观察该面板尺寸使原生网页随宽度动画逐帧裁切；完全折叠或收起结束后不保留可绘制内容。Main 再按 root zoom 和内容边界夹紧；重载、退出清理网页，Cookie 只留内存。取舍见[浏览器隔离决定](../../.agents/notes/implemented/architecture/2026-10-20-sidebar-browser-isolation.md)，产品操作归[桌面手册](../../docs/handbook/clients/desktop/README.md)。Main／preload 更新需要完全退出并重启。

[地址与 port 测试](test/native-browser-bridge.test.ts)、[共享 UI 生命周期](../../packages/ui/test/isolated/desktop-session-tabs.test.tsx)、[地址同步与面板裁切 DOM](test/isolated/native-browser-pane-dom.test.tsx)、[网络策略回归](test/isolated/native-browser-network.test.ts)、[原文件 reader DOM](test/isolated/native-file-changes-dom.test.tsx)分别核有限输入、标签资源、实际面板裁切与原文件读取合同。[隔离 Electron](test/isolated/native-browser.test.ts)使用真实 Main controller／preload／SessionPage 及 loopback 页面，测试专用入口只在 test fixture，普通构建诊断常量仍为 false。实际执行结果与平台限制在本节验证记录维护。

2026-10-20 Windows x64／Bun 1.4.3／Electron 44.3.0／Node 24.15.0，在 `5dba8a6b` 工作树既有输入加本轮 diff 上执行：`bun test --parallel=1 --max-concurrency=1 packages/ui/test/desktop-page.test.tsx packages/ui/test/isolated/desktop-sidebar.test.tsx packages/ui/test/isolated/desktop-session-tabs.test.tsx apps/desktop/test/native-browser-bridge.test.ts apps/desktop/test/native-file-changes.test.ts apps/desktop/test/isolated/native-file-changes-dom.test.tsx` 的对应分组共33项／419断言通过；上述隔离 Electron 命令另通过1项及实际窗口断言，核真实前进／后退／刷新、独立 Cookie、无应用／Node接口、外来 frame 拒绝、同标签弹窗、下载拒绝、宽窄保留和关闭／换会话销毁。亮暗新标签页截图核标签条、地址栏、工具留白和无 header 下边框；UI／Desktop typecheck、定向 Biome、文档和边界检查通过。窗口隐藏运行，不代证原生网页与系统材质合成、外部站点兼容、macOS／Linux 或安装制品；未调用模型。Tailwind 对既有嵌套 keyframes 的优化 warning 保留，普通客户端未增加测试入口。

## 原文件变更面板与编辑器

[NativeFileChanges](src/native-file-changes.tsx)将原 [FileChanges / FileDiff](../../packages/ui/src/desktop/FileChanges.tsx)接到 SessionPage 标签页首页的“变更”工具，复用行号、高亮、展开与焦点行为。它只在变更标签选中且侧栏可见时扫描当前已读完整历史的工具消息，每批32项；展开一项才读取原结果正文。目录扫描与单项 GET 各有自己的 read ID；折叠、切换标签、关闭侧栏、切换会话、detach 或 history epoch 更换只释放相应读取，不取消执行。测试诊断的会话工具仍使用独立 RightSidebar；与标签栏互切先卸载旧 reader，不保活隐藏工具内容。

[Main reader](electron/file-changes.ts)从 NativeCaller 已登记的原 Message 取得唯一 `sourceIds`，经生成 Client GET 核真实原 Run 和 Execution 的 Store、Session、Run、定义、结果 revision 和准确 content。当前 Store 负责连接准入，备份恢复后的原出处仍保留；封存 Fork 严格沿 `originMessage` 的原 Run，不借当前消息补来源，也不要求整 Run 成功才可读其中已成功的 Files。观察 ID 封存原 Run/Command、Execution 定义和完整结果的固定 SHA-256 摘要，详情与打开前重新核对，同 revision 的结果或来源变化也不能换绑旧 ID。仅 succeeded 的 `files.write/edit` 进入列表；同名 tool call 不建立关联，Shell/MCP 和 failed/unknown/cancelled 不猜逐文件贡献。`details.fileChange@1` 由 [Files owner](../../packages/agent/src/tools/files/README.md#逐操作文件变更预览)提供。旧 receipt 或未知格式保留已确认操作与可用路径，明确无差异，不从当前文件或恢复检查点重建。原来源和当前 Workspace 不同或不能确认时不提供打开按钮。

“常规”复用原编辑器选择，默认 VS Code，Zed/TextEdit 可选，只在当前 renderer 进程保留。文件操作中的路径按钮传 Main 观察 ID 和封闭 editor 枚举，不传任意路径、工作区根或应用名。Main 再读原 receipt、当前登记 Workspace 和物理根 dev/inode，沿迁入的 [editor leaf](electron/editor.ts)只接受该项目内存在的普通文件；保护 Profile 与候选目录。调用固定 macOS `/usr/bin/open` 的独立 argv，打开当前磁盘内容；编辑器未安装或目标漂移明确失败。Main 在所有读取后、分发前重新检查原 renderer frame。正文阅读不以编辑器可用为前提，路径按钮也不证明历史 diff 等于当前磁盘。原消息路径与常规默认摘要的当前接入见下一节；本面板仍不代表整个 PC 迁移完成。

取舍见[文件结果迁移决定](../../.agents/notes/implemented/architecture/2026-10-08-native-file-change-receipts.md)。[真实 Files 回归](../../packages/agent/test/isolated/files/change-preview.test.ts)、[Main 端口](test/native-file-changes.test.ts)、[原面板 DOM](test/isolated/native-file-changes-dom.test.tsx)与原[源码外窗口](test/isolated/native-bundle.test.ts)分别负责 IO/receipt、准确作用域、原入口与冷读。实际执行输入、失败与通过边界归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原文件变更与编辑器入口迁入)；OS 编辑器窗口、安装版全路径和 Windows/Linux 资格不由有限 callback 或按钮断言代证。

[恢复后真实消费者](test/isolated/native-restored-file-changes.test.ts)使用默认 Files、公开 Fork/backup/restore 和两个冷 Service/Node Main，核源会话与封存 Fork 的保存 write/edit 差异、read/write/edit 路径及普通消息路径，当前磁盘独立改变后历史仍精确。全部原 Message/Run/Command/Execution、原出处与 metadata 保持，冷读取全 GET、Provider 不增加；可信 opener 只核已重新验证的当前文件目标。原 UI/Caller/IPC 完整文件核既有派发守卫，该新例没有重新证明恢复后的整窗口点击或 OS 编辑器；准确红绿输入和剩余门禁归[恢复文件进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-文件历史与当前文件入口)。

## 原消息文件路径与常规摘要

原 [MessageContent](../../packages/ui/src/desktop/MessageContent.tsx)沿 `ModelOutputMessage.renderText` 展示同一条预览或已验证全文；普通正文自动读取并沿用原来源、哈希及读取暂停门禁。HTTP(S)仍需显式打开，图片不请求，HTML、锚点和 scheme 不产生文件操作；相对路径沿原 decodeURIComponent。子详情和未知格式不提供文件回调。消息文件点击传已读 Message ID、viewSelection/history epoch、最多8192 UTF-8 bytes 的路径及封闭 editor 枚举；[Main](electron/file-changes.ts)核当前登记项目、原 Message 来源、物理根和普通目标／保护目录，派发前核当前 frame。一般 Markdown 路径表达当前项目文件，不证明文件贡献；有原 Run 时核其准确身份和出处，无 Run 的原用户消息仍沿已观察 Message、当前准入的源 View 同 Workspace 和物理目标核对。恢复后的旧出处不因 Store 不同被拒绝，也不继承另一项目的文件范围；跨项目或来源不可核对时拒绝，缺失文件沿原 AlertDialog 告知。

[元数据 reader](src/native-file-targets.ts)复用原32项扫描与所属 GET 释放，消息结果有 path 仅用于筛选请求，不授予行为；Main核准确原 Execution后只给成功的 Files read/write/edit 提供原 [ToolRow](../../packages/ui/src/desktop/ToolActivity.tsx)文件路径。完整历史不依赖 View 的近200项执行列表，未知格式／未核结果沿原正文保留。面板与工具行重复扫描同一封存结果时保持相同观察 ID，不相互撤销；文件面板仍只计写入／编辑，不把读取算作变更。失去当前scope即清元数据，刷新失败可显式重读，关正文只结束其 reader。

[常规卡](src/native-general-settings.tsx)直接迁入原设置行，无论当前主会话、新对话准备页或项目，均读取用户级模型配置并核 Store/scope。显示配置 defaultModelId 的 Provider 与模型，不把临时下一轮选择或活动 Run 的冻结模型当作默认。常规卡通过封闭的 `settings.general.models.read/close` 使用独立只读 Main 观察，不能取得模型写入资格；切换/关闭只释放自身 GET，不覆盖或关闭提供商与模型的后台队列观察。迟到旧观察不显示；没有默认、读取失败与配置诊断分别表达。编辑继续进入提供商/模型分类。

2026-10-25，后台模型队列与常规页的租约冲突已通过生产 queue＋Main manager 精确复现：模型保存后的健康 flush 中，旧 General GET／close 覆盖或清空队列 observation，下一次开关在 POST 前被拒，恢复按钮普通 GET 后才重获资格。独立只读 manager 修复后，Main 配置／提供商30项／302断言、General与模型DOM45项／649断言、完整NativeDesktop82项／1705断言通过；并发 GET 用例确认 General close 不取消模型续读，封闭IPC拒绝注入scope、Store、写入或continuation authority。此路径不依赖未决journal或Service保存失败；不据此推定每一种重新读取提示都来自该冲突。同轮匿名生产UI／真实Main浏览器夹具在1100／550px深浅四组合通过，共12391次过程采样／2127帧，无页面错误；每组合常规read/close各1次，返回后台队列不增加普通模型GET，原5次串行POST继续完成。健康阶段2442次采样中恢复控件、alert及只读状态均为零，原未知、失败、foreign read-set和草稿读取断言保持。该证据不代表当前已运行的旧Main已热更新，也不代证安装版或真实用户配置操作。

[原入口 DOM](test/isolated/native-original-entries-dom.test.tsx)、[Main 文件端口](test/native-file-changes.test.ts)和原[源码外窗口](test/isolated/native-bundle.test.ts)核默认与临时选择分离、旧scope、预览／全文／关闭、准确路径／frame和首次／冷读；窗口只核可用路径按钮及真实缺失目标拒绝，不实际启动 OS 编辑器。输入、实际通过与旧错误见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原消息文件路径与常规摘要)，完整PC／installed全路径／其他平台和阶段退出仍按原条件核对。

## 原工具过程与结果阅读

工具阅读区启用共享 ScrollArea 的纵向边界交接：内层仍能滚动时保留原生滚动，到顶／到底或没有溢出时交给最近可滚动祖先。2026-10-25，Windows x64／Chrome155.0.8059.85 的[长聚合浏览器夹具](test/native-live-tool-aggregation-browser-runner.fixture.ts)在亮色1280px与暗色780px通过原内部滚动、长异常全文、键盘、开合及新增上下边界断言；实际逐步观察内层→外层→反向回顶，输入区保持固定。过程帧与报告在本机 `.cache/native-live-tool-aggregation-3KpaNM`；无页面错误。该页面消费生产组件和隔离 NativeBridge，不代证完整 Electron 或其他平台。输入／Native DOM 与共享 UI 的五文件定向组合130项通过；追加来源隔离与卸载监听清理后，Native输入83项及滚动文件3项分别复验通过。Agent、UI、Desktop类型、定向Biome、文档、统一边界和测试归属检查通过；Biome保留输入测试原有两项字符串拼接提示。

[工具消息适配器](src/native-tool-messages.tsx)为准确 `task.spawn`／`task.follow_up`／`task.message`／`task.events`／`task.list`／`task.interrupt` v1 提供可读标签，未知版本保原 ID／version。创建／追问工具终态只表示这次调用结束，不将其当作 child 业务完成。现有准确授权投影继续优先人工 pending，批准与执行效果分开；[工具 DOM 回归](test/isolated/native-tool-messages-dom.test.tsx)验证新标签及未来版本保守展示。

[六工具真实窗口门禁](test/isolated/native-collaboration-bundle.test.ts)使用 source-free macOS Electron、真实 Service/Runtime/SQLite 和隔离 mock Provider：普通父轮结束后两个 child 独立待批，只批准 A 不执行 B；稳定 A Session 续接到新 Run，旧 A 答复和旧卡停止均拒绝且不改投 A2，批准 A2 后只产生它的效果；准确停止 B 后迟到批准无效果，冷重开零 Provider 重放。实际 1 项通过，15 次 Provider 请求，原进程退出及候选独占 lease 均核实。审批只在准确根 Session/Run 的活动交互时隐藏主输入；child 待批仍保留原卡和父输入。[DOM 回归](test/isolated/native-interaction-composer-dom.test.tsx)保留原根审批入口。本机隔离窗口证据不表示付费 Provider 或 Windows/Linux 资格。

2026-10-20新增[普通Native真实模型runner](../../tests/e2e/live/model/collaboration-native-window.live.ts)与[私有driver](test/live-collaboration-native-window.fixture.ts)，构建常量 `testDiagnostics:false`，通过普通读取范围确认、权限菜单选择accept_edits、原输入框及两张准确child审批卡完成一批一拒。原freeze2三个独立样本共23HTTP均200，窗口、SQLite与文件效果相符；普通冷重开零新增Provider/Run/Execution/Command/Source/control，两窗口均正常退出并确认清理。流级usage保持null，canonical Model usage独立记录，不混算为每次HTTP已知。这组历史样本没有运行稳定child第二轮，不能借旧mock窗口补齐付费范围。

后续freeze6在同一真实默认策略下新增同child两轮的普通窗口子集，非Markdown输入4354项，摘要 `86836fc2853e98165887dfb0b5c6a19264e280bfd161e40c2b1eec3abd987b17`。三个新样本各12HTTP、共36HTTP均200，U01、U02可达子集与冷U03子集全部通过。原A/B两张Files卡完成一批一拒后，普通UI切换会话再返回，准确继续原工作；先展开父 `task.follow_up` 完整审批请求核对A与新C目标并只批准一次，再对同A第二轮的新C Files卡单独批准。每例恰有四张Interaction、两个child Session、三个carrier；A保持同一Session并使用两个不同Run，旧卡目标、答案及原carrier元数据保持，旧审批控件已移除。父委派批准不代替新C文件批准，实际A/C字节匹配、B零派发且文件不存在。每份主窗口及冷窗口均正常退出并确认清理，冷读零新增Provider、业务或Source。物理HTTP usage仍未知；36份canonical Model usage另行核对，合计input 133951/output 10448。该U02子集没有提交迟到旧答案或旧停止请求，也未覆盖断线重连、Job report关联、冷Service恢复或其他平台；旧控件移除不能代证服务拒绝迟到请求。准确版本、manifest、保留失败、独立核验与69/80逐项范围归[真实用例记录](../../tests/e2e/live/model/collaboration-v1.1-cases.md)。

子详情 reader 仅返回已封存 carrier／Store／rootWork 内的准确 Run 与有限 execution.authorization DTO；renderer再核出处，唯一活动 Run 的人工 pending 优先显示“等待你的批准”，不能从 waiting 状态推断授权。打开准确 A 子详情读取该状态、再返回父输入也由上述真实窗口核实。未取得准确控制 DTO 的旧缓存保原生命周期，不伪造审批状态；同一稳定 Session 的旧卡仍绑定原 carrier。

[NativeToolMessage](src/native-tool-messages.tsx)直接消费原 [ToolActivity / ToolRow](../../packages/ui/src/desktop/ToolActivity.tsx)，保轻量工具行、状态、箭头和结果展开。历史 Message 的 complete 只表示消息完整；[Main metadata reader](electron/tool-messages.ts)按已读 Message 的唯一 source Execution GET，核原 Store／Session／Run、tool kind、终态、result outcome 和完全相同的 content。每批最多32项，完整已读历史不限于 View 近200项；元数据核对前和无法核实的条目保留在原工具聚合中，默认收起，缺少执行状态时不推断成功或结果未知，“状态待核对”仅在显式测试诊断中显示；只有用户逐项展开才挂载原正文及其读取控件，不先将原结果 JSON 显示为消息正文再替换。读取失败仍保留原文和明确重试入口。[回执渲染回归](test/isolated/native-tool-receipt-render-dom.test.tsx)直接使用 NativeDesktop，核展示信息未到、失败、未知／未来版本及不支持格式的收起阅读和切会话清理。metadata close、切会话、detach 或 history epoch 变更只释放所属 GET，不停止、重做或恢复工具执行。同一阅读身份的普通事件刷新暂清 controller snapshot 时沿 Main 已验证 lastView 保留只读观察；明确选择、reset 或 Store 变化仍撤销旧范围。

Native 将 Tool 的 `planned` 映射为 UI `queued`，显示“等待执行”；`dispatching` 与 `running` 映射为 UI `running`，显示“执行中”并使用运行标记。普通 Tool 的实际调用等待结果期间仍为 `dispatching`，不能将它视为排队；读取、修改与独立工具行均保留执行状态文字，聚合标题只显示动作，运行与等待状态保留在各工具行。执行权观察继续约束忙碌与读取资格，普通界面不追加“执行状态待核实”；准确审批提示、停止请求和终态语义保持；确认未派发的审批拒绝／取消沿共享工具行只保留审批标签，不重复未执行或停止文字，Shell详情也不重复等待审批。自动审批未通过沿共享ToolApproval显示14px警告色盾牌图标，悬停或键盘聚焦只提示审批状态，完整拒绝原因仅在展开详情显示；其他工具行附属状态使用13px辅助色，独立的真实异常保留异常色与逐项展开详情，适配不改后端 ledger、执行准入或并发。[原工具 DOM 回归](test/isolated/native-tool-messages-dom.test.tsx)沿实际适配与组件核待派发、已派发、终态和混合探索聚合。

Main 仅在原 Message／Execution 身份和结果完全匹配、原状态 failed、`authorization.dispatched=false`、Core `adapterAttempted/dispatchCommitted=false` 且准确刷新 code 与 content 一致时投影只读 `decisionRefresh`。Native 适配为中性的 `not_executed`，显示上下文／工具信息已更新、此次未执行；聚合标题不追加状态计数，逐项状态仍区分此次未执行与真实失败。持久 ledger 不被改写，冷历史复用相同核验；缺证明、实际派发失败及伪造 details 均保原事实。[Main](test/native-tool-messages.test.ts)及[DOM](test/isolated/native-tool-messages-dom.test.tsx)验证四项重新评估与一项真实失败混合时保留各项准确状态。

Files等工具目标仅展示同一原来源／Run、结果之前且已读历史中唯一 Model call 的请求字段；重复 callId 不建立执行关联，有歧义不补目标。Shell原命令另沿下述确切Tool输入投影。请求文本不证明实际文件变更，也不授予打开文件资格。成功 Files 路径按钮仍沿独立原 receipt／观察 ID；Files read 的当前版本4与保留版本3均核原 baseline，write/edit 仍限版本2。文件读取失败行内保留简短状态，点击该工具展开完整异常原因；不附行内错误预览，也不提供文件打开动作。

唯一原调用属于已知 `files.list@1` 且省略 path 或传空字符串时，目标按该版本的已知默认值显示 `.`，表示工作区根目录；显式路径保原文。缺原调用、重复身份或未知版本不补默认路径，目录文本不获得文件打开动作。[Main 回归](test/native-tool-messages.test.ts)核默认／显式路径及缺来源／歧义／未来版本，[原组件 DOM](test/isolated/native-tool-messages-dom.test.tsx)核目录行实际保留根路径。

执行中的工具行只来自当前 Store、所选会话活动 Run 的真实 tool Execution，与同 Run 的原结果消息接管；旧 Store 恢复记录不遮掉新工作。停止申请尚非终态时明确等待结果，视图不可核实时保留原记录并后台重读，普通界面不追加“上次确认状态”。Shell execute/launch/read/wait/stop 显示各自实际操作；已知`shell.execute@1`也沿原工具输出卡呈现，启动受理不表示后台Job已完成，Job的准确停止与完整日志仍归原环境／Runtime logs入口。未知定义或版本保原 ID／version 和可展开原文，不借旧 UI 同名分类解释未来结果。

Shell卡片按用户参考图采用终端图标、实际状态与单行省略命令的工具行，展开后复用共享CodeBlockHeader／Content／Footer：带`$`的命令在Header完整多行显示，保留原始换行、长行自动折行、不省略Unicode原文，沿原CodeBlockCopyButton复制全文；Header无下分隔线，聚合／输出的滚动边缘沿真实viewport使用shadcn的scroll-fade-y；仅输出区滚动，右下角结果固定在Footer。外层工具标题预览限制512个UTF-16单位；独立输出viewport最高256px，当前400px聚合内按剩余空间限为252px，列表间距仍为0，结果保留在底部。原24px自动跟随阈值、手动保位和原输出保留，移除“回到最新输出”按钮；手动滚回底部即恢复跟随。Header自然增高，超长命令可在聚合外层viewport完整滚读，输出仍有独立viewport。`shell.read`按返回items顺序保stdout／stderr交错，不按流名重新排序；仅已验证的真实Job成功显示勾号；正常成功只显示成功，不追加退出码，非成功结果继续显示实际退出码，截断及部分输出提示保留。launch已受理、wait超时且仍在运行、stop请求尚待结束分别显示，未知、超时、失败与部分输出不冒充完成。审批原因在卡片内去重展示，不在工具行追加正文；已有部分输出的失败／未知仍保完整异常记录，未核实的最小Shell事实不冒充受理或停止成功。Shell局部inline-size containment阻止长命令将Radix的table内容wrapper撑宽，窄窗口的卡片和箭头仍在原阅读列内。

Main沿既有`toolMessages.list`的`commandOffsets`读取命令分片；新增可选`executionIds`，只允许与非空`messageIds`二选一，单次1–32项。运行中读取仅核当前scope已观察、同Store／Session活动Run中的Tool，再GET确切Execution及其原toolInput；known Shell@1从该原输入显示命令，不等待Model或Tool执行完成。已保存receipt同样核唯一原Execution与准确callId；有可见原调用时仍要求唯一、canonical定义及command／key与Tool输入一致，冲突不回退。Model尚未完整、未加载或公共预览省略调用，不再成为准确Tool输入可读的前置；普通Tool的parentExecutionId可为空，不能将其当Model来源。命令分片按UTF-16 offset在码点边界续读，每片JSON转义后UTF-8最多8KiB，命令本身最多262144码点，单批另设512KiB命令预算；原ask／images等元数据预算保持。fact的inputSource绑定原Store／Session／Run／toolCallId，renderer核read范围、准确Execution与定义、连续offset及字节预算，拼齐前仅给明确摘要，失败保已核兄弟项与原记录入口，不增IPC方法、正文reader或执行能力。

仅原receipt、准确Execution的结果content与structured details完全一致，且引用的Job符合原Store／Session／id、builtin.shell与shell.command@1时，Main／renderer才投影真实状态、输出、退出码与完整性；未来版本或畸形结果保原文。实时最小DTO不携大命令，metadata读取只影响对应项。原Execution与当前未封存的唯一同来源receipt共享Store／Session／Run／Execution构成的presentationKey；Conversation、逐项React key与阅读缓存共同使用它，避免live→receipt→metadata接管时卸载卡片或关闭详情。跨来源与封存记录不借此别名，原消息ID继续负责metadata、正文reader及文件／子Agent操作。metadata未到的已展开Shell保同一卡片和读取提示，不先闪原JSON再切卡片；无法核实时在同卡内保原记录。

`useNativeToolMessages`把实时输入与已保存receipt放在同一读取生命周期中，liveToolMessages只补准确命令／摘要，不用metadata旧status或approval覆盖当前View。queued、审批中、等待人工及执行中均可显示原命令；receipt接替前只沿同原Store／Session／Run／Execution／callId保留已核输入，不借状态、结果或控制权。匹配调用声明变化仍触发所属项重核，后来出现冲突先撤旧资格；Main与renderer都先统计同来源的所有匹配调用，再核唯一调用的完整性与格式，未完成或unsupported调用不能被过滤掉而隐藏重复冲突。重核回复不得恢复仍有冲突的命令；不按正文、思考或无关Model刷新重复读。实时命令分片期间若工具列表变化中断读取，未收齐项从首片重新读取，已收齐兄弟项继续复用缓存。补核失败仍保原记录和显式重试，不无限重读或借旧事实恢复资格。旧会话直接按原receipt读取，冷重开不需要重新提问、执行命令或保有live View。

子Agent只读详情不借主会话`executionIds`读取子范围，而在原`background.child.open`已核exact-child快照中附可选`presentation.liveTools`，复用原64KiB快照分页。Main对live及已保存Shell命令收齐8KiB片段，额外命令累计编码预算512KiB，超额仅保明确摘要、不提供全文复制。receiver核原child Execution、inputSource、定义／状态／revision与完整命令预算；拒绝foreign、future、partial及结果权限字段注入，快照刷新全量替换，已到receipt不重复挂live输入。共享liveToolMessages只补输入，原View审批／状态、目录／控制DTO、读取lease与逐项展开身份保持。

同一 Run 中连续的所有工具调用共用聚合，不以只读分类、Shell、定义版本或 metadata 是否到齐决定分组。`desktopTranscript` 为原 Run 的 Tool 消息提供分组身份，`groupNativeToolMessages` 再以 Run 和可读消息边界稳定该身份；第一项即使用聚合壳。Execution 已结束而历史回执尚未到达时保留该工具项，回执逐项或乱序接替、原 Execution 移出 View 近200项以及 metadata 补齐均不更换聚合容器与阅读开关。名称、状态、文件打开与子 Agent 导航仍分别核原身份，分组不补执行或权限事实。[native-presentation](src/native-presentation.ts)仅将`firstOutput=tool_calls`、当前预览为空、没有body或`contentBytes=0`且格式受支持的无附件模型声明投影为`presentation:hidden`；Conversation不让它形成可见行或分组边界。主View中的工具可以先于历史Model complete更新到达，该交接不再把原聚合临时拆开。非零body的空预览不设置此hidden标记，仍按原body reader合同处理；unsupported、附件、压缩和后来实际正文保持各自原展示。新阶段独立默认收起，展开后保每项原阅读入口；元数据未到的项逐项主动展开才挂载原记录，准确子 Agent carrier 仍直接打开原详情。未知版本的原始结果不进入收起标题。未核实只约束对应项；同组已核实的文件打开、交付文件和 PDF 页继续消费自己的原读取资格，不因兄弟工具缺 metadata 而撤下。摘要按已识别工具的动作去重组合，例如“编辑文件读取文件运行命令”，直接拼接动作，不加“了”或顿号，不显示总项数或成功完成计数；未知工具只概括为“使用工具”。标题后不追加数量、状态或异常文本；展开后的聚合整体最高400px，32px标题以外的列表最高368px并在内部滚动，列表项之间的纵向间距为0。聚合、工具异常／原始详情、Shell与文件差异沿共享ScrollArea真实viewport滚动并显示scroll-fade边缘提示，原region／键盘阅读与Shell跟随事件保留，PRE不再独立滚动；交付文件历史文本也沿共享viewport展示，原480px上限、分页字节offset与reader关闭保持。非工具区域沿原组件。执行失败或审批未通过的完整原因，只在点击对应工具展开后显示，列表和长详情支持键盘滚动。摘要不切换成最后工具的名称／路径；重新评估不计完成，失败、取消和结果未知分别保留。[运行期聚合 DOM](test/isolated/native-live-tool-aggregation-dom.test.tsx)覆盖这些交接、手动阅读和身份隔离场景。

2026-10-25，用户认为Shell阅读区偏矮，聚合总高上限从240px提高至400px；共享变量得到368px列表与252px组内Shell输出，列表间距0、多行Header、原生scroll-fade及手动阅读保持。成功Footer不再追加退出码，失败仍显示实际退出码，超时／未知与截断等事实保留。共享工具／页面两整文件37项／1088断言及UI／Desktop类型、定向Biome、文档检查通过。生产组件／编译CSS的Chrome155在浅1280／深780px全过程检查高度、首尾渐隐、手动暂停／滚到底部恢复、开合、完整输出及Diff尾部与11状态矩阵；实测400／368／252px，成功为“成功”，失败为“失败 · 退出码7”。`.cache/native-live-tool-aggregation-1y5wDz/report.json`记录3707样本／1036帧，页面错误0，已人工复看两类终态截图；此前240px及成功退出码0记录仅描述调整前版本。本次为隔离生产组件验证，未重跑完整安装版或模型执行。

2026-10-25，后续按用户要求补齐执行中命令、精简已批准状态，并调整完整多行Header。Main／Native工具与transcript三文件58项／1829断言、子详情两文件35项／298断言通过；最终共享工具／页面／阅读缓存三文件在新UI下复跑39项／1094断言通过。UI／Desktop类型、定向Biome、文档、边界、测试归属与diff whitespace检查通过，未变的身份／权限链验证按原范围复用。Chrome155实际组件／编译CSS与Main reader在浅1280／深780px核实时排队、自动及人工审批、执行、receipt接替、旧会话冷重开，17.9KiB多行命令始终保完整；匹配Model后到不额外GET，真实冲突与失败显式重试保持。已批准仅用14px盾牌勾，hover／真实Tab与Shift+Tab／Escape说明开关不改变展开或几何。最终Header无下边框、原始换行完整可见，输出单独滚动；不再有回到最新输出按钮，手动上滚停跟随、滚到底部恢复。聚合240px、列表208px及输出92px保持，超长Header、输出与结果末端均可滚读。原生scroll-fade-y在实际viewport测得首部仅尾fade、中部双端、末端仅首fade；五行Header高118px，输出滚动不移动Header。最终证据`.cache/native-live-tool-aggregation-QT1a2n/report.json`、`.cache/native-live-tool-aggregation-4Jnuzx/report.json`与`.cache/native-live-tool-aggregation-jeGw4G/report.json`共7240样本／2537帧、6窗口组合，浏览器错误／工具外逸／横溢／嵌套按钮均为0；后两份功能未受最终1px分隔线删除影响的范围复用，不把旧单行Header／回最新按钮记录当当前行为。已人工复看原生740×408深色卡片、审批提示与关闭、长命令尾、冷开结果。对用户旧窗口核实10:14旧Main缺命令传输字段，用户重启新Main后确认同一原会话恢复，不需要重新提问；此实际确认不外推完整安装版或全部模型时序。

2026-10-25，用户实际发现Shell命令缺失且正文停在JSON。对截图对应的已保存Tool／Model／receipt做只读复播，确认命令及输出存在，原调用完整时生产Service投影与Main核验可恢复命令和Job成功；Model仍incomplete时只返回最小Shell事实。旧缓存没有随原Model补齐重核。新增[Native工具DOM回归](test/isolated/native-tool-messages-dom.test.tsx)经Shell factory、canonical Model surface及真实NativeToolMessages，覆盖同receipt补核、原卡／展开、无关刷新、调用冲突撤资格、失败后显式重试、兄弟缓存与缺来源／未来版本。浏览器旧hook的`.cache/native-live-tool-aggregation-QrSaSx/`先复现同样失败：Model完成后仍只读一次metadata，Header仅Shell、正文JSON、结果未提供。修复后Chrome155浅1280／深780px的`.cache/native-live-tool-aggregation-37xhLG/report.json`记录1214样本／549帧，均恰两次真实Main metadata读取；第二次补齐命令、正常输出、成功与退出码0。手动Home后Tool及ScrollArea viewport保持原节点、展开不变、scrollTop为0，补核不闪回读取提示，聚合及输入区位置稳定，回到最新可读完整尾部；页面错误、工具外逸和横溢均为0，已人工复看深浅阶段截图。此前固定Header／240px上限及其他状态证据在未变范围复用；本次补足了旧九场景始终先备齐Model call的时序缺口。此为只读实际记录复播及隔离生产组件／metadata producer验证，未外推完整安装版或真实模型执行资格。

本次迟到调用修复的Main metadata、Native工具DOM及Native transcript DOM三个整文件56项／1713断言通过，其中真实producer新case先红后绿，最终43断言覆盖补核及失败边界。Desktop typecheck、定向Biome、文档结构／影响、边界、测试归属与diff whitespace检查通过；共享UI及Main／Job来源门禁没有变化，既有对应范围证据复用。

2026-10-25，按用户Shell参考及后续固定命令Header要求完成本轮卡片调整。macOS arm64／Bun1.4.2当前工作树：`bun test`沿共享工具聚合／页面／阅读缓存三个文件39项／909断言，Native工具／回执／运行期聚合三个隔离文件分别执行34项／775断言通过；Main原命令来源、分片与Job证明沿本轮先前67项Native相关测试中未变范围复用，UI／Desktop类型、定向Biome、文档、边界与测试归属检查通过。实际Chrome155沿生产组件及编译CSS在浅1280／真深780px核独立与聚合卡：Header32px，输出Home／回到最新前后Header完整box不动，原命令DOM全文准确且仅在Header，完整命令的复制控件可用；独立卡片宽740／529px，卡片、命令和箭头均不被裁切。输出自动跟随、手动保位、完整尾部、11种操作结果、240px聚合／208px列表／92px输出与13pxFooter通过。`.cache/native-live-tool-aggregation-bJVGAx/report.json`记录2776样本／639帧；Native审批精准复验`.cache/native-live-tool-aggregation-b18ZTr/report.json`记录570样本／249帧，拒绝原因仅一次，metadata等待无原JSON闪现，live→receipt→facts保持同节点、展开及卡片。其余8种Native操作／大命令分页复用`.cache/native-live-tool-aggregation-9PSDiV/report.json`的对应稳定合同；原`.cache/native-live-tool-aggregation-BZnXCH/`保留修复前卸载与丢展开证据。最终两份报告页面错误0；人工复看宽窄独立成功、深色聚合尾部、等待超时及Native等待→拒绝截图。此前独立窄卡内部裁切未被document overflow捕获，已增加viewport与row／card／arrow实际边界断言；不将旧4XeWpS图作为最终固定Header资格。此为隔离纯UI及真实metadata producer／受控bridge验证，未外推完整安装版或真实Service模型执行；测试岛未接宿主clipboard，不声明本轮实际系统剪贴板验收。

2026-10-25，用户将聚合整体上限从200px改为240px。沿共享高度变量同步得到208px列表、176px长异常／diff区域与100px聚合内Shell区域，列表间距保持0。生产组件／CSS浏览器在浅1280／深780px实测整体240px、列表208px、row-gap为0px；滚轮／thumb／键盘、首尾fade、长异常尾部及Shell／diff完整输出通过，审批矩阵复用前次证据。`.cache/native-live-tool-aggregation-r1AvKa/report.json`与`.cache/native-live-tool-aggregation-kZbiwW/report.json`共4423样本／1848帧、页面错误0；定向Biome、文档检查及diff whitespace通过。以下200px记录仅描述此前版本。

2026-10-25，用户再次将聚合列表项纵向间距从2px改为0。沿现有浏览器夹具定向复验几何、滚动与长详情，浅1280／深780px实测row-gap为0px、整体200px、viewport168px，滚轮／thumb／键盘和首尾fade、异常长尾可读及开合选择保持；审批矩阵沿前次证据复用。`.cache/native-live-tool-aggregation-oD3aSd/report.json`记录3063样本／1299帧、页面错误0。定向Biome、文档检查与diff whitespace通过；以下2px记录仅描述此前版本。

2026-10-25，用户明确仅工具聚合与工具详情统一接入ScrollArea和scroll-fade。工具聚合、异常／原记录、Shell、差异、交付历史及旧子工具过程均把region、焦点与滚动事件落在真实viewport，PRE只保原正文；共享fade默认关闭，不改变主会话等旧消费者。UI工具／页面／diff、轮次与原滚动生命周期五整文件46项／1777断言，Native工具／回执／运行期聚合三整文件31项／722断言，以及历史交付两项／40断言通过，共79项／2539断言；UI／Desktop类型、定向Biome、文档、边界与测试归属检查通过。历史交付核Unicode字节offset分页、回开头、关闭reader和准确文件打开，修正了原测试按裸文件名匹配旧按钮文案的选择器。

Chrome生产组件／编译CSS在浅1280／深780px核工具聚合200px、viewport168px、列表2px；滚轮、Radix thumb拖动、PageDown／End作用于实际viewport，首／中／尾的fade实测分别为仅尾部／两端／仅首部。`.cache/native-live-tool-aggregation-t1sOI4/report.json`记录8232样本／3440帧，覆盖长异常、完整尾部、13px状态矩阵与逐项开关。CSS长度百分比按实际viewport计算值解析，不用parseFloat误读min/calc。隔离生产SessionPage／ToolActivity／FileDiff测试岛的`.cache/native-live-tool-aggregation-kcmT4s/report.json`另有1286样本／516帧，核Shell跟随、手动保位／回最新、diff纵横滚动与末端；曾捕获聚合内256px Shell区域被168px外层裁尾，最终聚合内Shell区域按剩余空间限为60px，独立输出仍256px。真正深色测试岛截图核背景25/25/25、侧栏36/36/36，旧NEYR8D仅作为亮色几何记录，不计深色资格。原混合工具／390px过程的JfC6cU为3889样本／1599帧，空Model交接的1G0sRc为646样本／271帧，分组、选择、正文reader、阅读位置与输入位置均保持。四份最终记录页面错误0；人工复看长异常、Shell和diff尾部。此验证为受控bridge或纯UI测试岛，未外推完整安装版、真实Service模型执行或其他平台资格。

2026-10-25，用户将聚合整体高度改为200px、组内列表项间距改为2px。共享CSS通过`--tool-aggregate-max-height`约束总高，保32px标题与168px内部列表；长异常详情同时缩至136px可滚动区域，避免原320px详情超出新的阅读窗口。生产NativeDesktop／编译CSS的浏览器夹具在浅1280／深780px实测整体200px、列表168px、row-gap为2px，36项内容内部滚动；长失败与审批原因均能键盘End读到尾部，逐项开关、聚合重开选择和11种审批状态继续通过。`.cache/native-live-tool-aggregation-zWCH0k/report.json`记录5732样本／2777连续帧，页面错误0；人工核列表及长原因尾部截图。定向Biome、文档结构与影响检查通过；以下450px记录仅描述调整前的原版本。

2026-10-25，按用户要求精简工具审批状态：确认未派发的自动／人工拒绝及审批中停止不再附加未执行或重复停止，等待人工不在Shell详情重复；工具行附属状态统一13px辅助色，实际失败、超时与结果未知继续独立保留。共享工具／页面两整文件34项／787断言、Native工具整文件12项／180断言通过，UI／Desktop类型、定向Biome及文档检查通过。生产NativeDesktop／编译CSS的Chrome隔离bridge在浅1280／深780px核11种审批与执行组合，各自观察普通、悬停与展开过程；浅色辅助／异常色分别为rgb(102,102,102)／rgb(161,62,62)，深色分别为rgb(181,181,181)／rgb(224,161,152)，附属状态均13px，悬停和展开不改变其字号与颜色。`.cache/native-live-tool-aggregation-TxQ5jQ/report.json`记录5754样本／2786连续帧、页面错误0；标题无附加状态、无嵌套按钮和横向溢出，450px总高／418px列表、键盘滚动、异常长尾阅读与逐项开关保留。人工复看拒绝、等待和已批准后真实失败及两类独立未知截图。Native shell.launch不命中旧shell_execute输出组件，因此Shell footer去重由共享UI矩阵覆盖，不将该浏览器分支未命中当作资格；此验证未覆盖安装版或远程真实模型。

2026-10-25，按用户要求收敛聚合高度与异常阅读：标题仅保留动作、图标和箭头，不附状态或数量；失败读取、写入、Shell、未知工具与审批未通过的原因改为逐项点击展开。共享聚合／页面两整文件33项／489断言，Native运行期聚合／工具／回执三整文件31项／722断言，原轮次整文件22项／373断言均通过；UI／Desktop typecheck、定向Biome、文档、统一边界与测试归属检查通过。Chrome155的生产NativeDesktop／编译CSS隔离bridge在深浅1280／780px下核36项长列表，整体450px、列表418px；PageDown／End可读后续工具，长失败与审批原因的末尾均在对应详情聚焦后可见，聚合关闭与单项关闭均不泄漏原因，重新打开保留原阅读选择。`.cache/native-live-tool-aggregation-Jw0Sff/report.json`记录1426个样本、672张连续帧；1280／780／390px混合工具的`.cache/native-live-tool-aggregation-37zEM6/report.json`另有3917个样本、1607张帧，聚合标题无附加节点，工具不外逸、节点／阅读／输入位置稳定，页面错误0。窄窗逐帧曾捕获箭头旋转时越界1.76px，补足旋转边距后原断言通过。空Model交接沿本轮`.cache/native-live-tool-aggregation-KNyBaK/report.json`的630样本／263帧复验，无分组或正文读取回退。人工核长列表、两类完整异常尾部及窄窗过程截图；此证据不外推为完整安装版、远程真实模型或其他平台资格。以下旧证据仅说明各自原版本与范围。

2026-10-25，macOS arm64／Bun1.4.2，`bfdb6a273` 加本次连续工具聚合工作树：对运行期聚合、原轮次、工具适配与回执渲染四个完整 DOM 文件执行定向 `bun test ./apps/desktop/test/isolated/<原文件>`，51项通过；其中 Core compression 用例的本机 port0 绑定曾报 `EADDRINUSE`，单独复跑通过。导航新增混合组 carrier 与原完成子详情两项通过；导航全文件另两项 owner warning 文案断言在 `git archive HEAD` 基线上同样失败（预期“执行状态待核实”，实际“运行中”），未改断言。新回执回归核永久未核实兄弟项不会撤下准确文件按钮与已展开交付、失败读取没有文件动作，元数据接管保同一 DOM。UI／Desktop typecheck、定向Biome、文档、统一边界、workspace及测试归属检查通过。

动作摘要更新后，UI相关两文件27项及Native聚合／工具／回执、问答和子详情定向33项通过，UI／Desktop类型与文档检查通过。同日执行 [连续工具浏览器 runner](test/native-live-tool-aggregation-browser-runner.fixture.ts)，以真实 NativeDesktop 与生产编译 CSS 在 Chrome155.0.8059.86 的浅色1280px、深色780／390px检查首项、七类混合工具、旧Execution移出View、回执／metadata接管、开合、失败／取消／unknown、完成及缓存返回；1721个RAF采样、1580张连续过程帧，页面错误0，活动聚合节点、收起位置／高度、滚动和输入位置均保持；动作摘要可自然变宽，标题省略显示且展开箭头完整保留，没有组外工具。人工复看首项、缺View回执、混合失败与窄屏缓存返回。证据 `.cache/native-live-tool-aggregation-OKOnwy/report.json`；390px保标题及开合，完整状态可通过标题提示与可访问名称读取。此夹具的 fileTargets 为空，文件操作／交付资格由上述独立 DOM 回归覆盖；PDF的原读取与权限合同未改，本轮没有新做混合PDF窗口资格。未运行安装版Electron、真实模型或其他平台。

2026-10-25，按收起状态重新排查：旧夹具没有流式Model消息，并未覆盖View中的工具先到、历史仍是空incomplete Model的交接。新版[浏览器runner](test/native-live-tool-aggregation-browser-runner.fixture.ts)增加`KITE_AGGREGATION_SCENARIO=model-handoff`，覆盖无body和明确body0两类工具声明，以及非零body的空preview。`KITE_AGGREGATION_BASELINE=pre-empty-model-fix`只在隔离构建移除新增hidden投影，未回滚共享源码；修复前 `.cache/native-live-tool-aggregation-PVXixQ/report.json` 中36个Mutation／RAF／task样本出现两组→一组，工具B曾暂时在原聚合下方独立显示。修复后 `.cache/native-live-tool-aggregation-b8DcWW/report.json` 的645个样本、270张连续帧保持一组与原summary／标题／箭头节点，选区、阅读位置和输入位置保持；实际非零body经原SHA／字节／IPC reader显示正文，等待既有渐显结束后的截图确认完整可读；等待只属于测试观察，不增加生产延迟。新增同步Mutation和直接RAF采样后，1280／780／390px原混合工具三场景另3877个样本、1593张连续帧通过，页面错误0，证据 `.cache/native-live-tool-aggregation-MZ1AX7/report.json`。人工对照查看两组闪现、修复后收起交接和正文reader截图。

本次共享聚合、思考轮次、回复状态和阅读滚动四文件49项，Native运行期聚合与原轮次两个完整文件33项均通过；Native整文件含真实Core→HTTP回归，沙箱内port0绑定报EADDRINUSE后在允许loopback的沙箱外完整复跑通过。UI／Desktop类型、定向Biome、文档和边界检查通过。浏览器仍为生产组件／编译CSS与受控bridge，不外推为完整安装版或全部真实模型时序；本次未改工具源Model DTO或工具排序合同。

2026-10-24，搜索定义 v4 复用同一探索展示，v2/v3 历史继续可读。[运行期聚合 DOM](test/isolated/native-live-tool-aggregation-dom.test.tsx)逐阶段核 v3/v4 搜索＋读取从派发、settling、延迟回执和 metadata 接管保持同一节点与展开状态。同日 macOS arm64／Chrome155.0.8059.86 的隔离生产组件浏览器夹具已改用真实 v4 搜索定义，六组阶段覆盖两种 metadata 顺序、初次／切换、深浅主题、4／40轮及缓存返回；733张过程帧和171个正文可见 RAF 采样均通过原节点、顺序、几何、滚动及输入位置检查，页面错误0。人工核延迟占位、亮色搜索聚合及暗色缓存返回；证据在 `.cache/native-history-presentation-f4b6uR/report.json` 和帧目录。该证据为隔离组件与受控 bridge，不代表完整安装版、真实模型或其他平台；原 CSS 嵌套 keyframes 提示保留。以下旧证据仍仅覆盖其原版本及场景。

2026-10-23，搜索定义 v3 继续使用已知探索展示；历史 v2 保留同样展示，未知版本仍保守显示原定义，不并入探索。准确已知搜索映射为共享 `search_content`，使搜索／读取聚合显示各自次数。新增运行期回归核搜索＋读取从活动、settling 无回执、逐项回执和延迟 metadata 接管始终保同一聚合 DOM 与手动展开；主会话与子详情沿同一投影，后者保留父草稿和只读范围。相关 live aggregation／transcript／navigation 整文件共56项1333断言通过，Desktop typecheck与定向Biome通过。

同次 macOS arm64／Chrome155.0.8059.86 的[隔离历史浏览器夹具](test/native-history-presentation-browser-runner.fixture.ts)改用真实 v3 搜索＋读取，六组覆盖两种metadata到达顺序、初次／切换、深浅主题、4／40轮及缓存返回。逐阶段截图与RAF帧核首次正文展示后消息因果顺序、DOM、几何、滚动／输入区位置保持，搜索聚合未闪回generic；六组均通过、页面错误0，证据在本机 `.cache/native-history-presentation-o4dtrD/report.json` 与帧目录。人工检查延迟读取占位和亮／暗最终聚合，未发现重复或跳位。本次仅为隔离生产组件和受控桥接验证，不代表完整安装版、真实模型、其他平台或所有实时推送分段资格；原嵌套 `@keyframes` CSS编译提示保留。

[Main 与有限 IPC](test/native-tool-messages.test.ts)、[正式 caller 路由](test/native-caller.test.ts)、[原工具 DOM](test/isolated/native-tool-messages-dom.test.tsx)和原[源码外窗口](test/isolated/native-bundle.test.ts)分别核关联、作用域、原交互和真实执行／Files读取失败及冷读；准确输入和结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原工具过程与结果阅读)。轮次阅读、聚合与已知 Ask 回执的后续接入见下一节；自动审批历史、完整 PC、安装版全路径及其他平台资格仍未闭合。取舍见[工具消息观察决定](../../.agents/notes/implemented/architecture/2026-10-08-native-tool-message-observations.md)。

原Native整窗口夹具只对准确尚未处理的pending卡要求“等待人工审批”，同一write行必须在原loop剩余期限内完成该文案后再核原断言；已提交的同一卡仍可见时不要求工具倒退到pending。此前完整默认暴露该重复／提前观察的可达错误，原红未保存失败时完整text/status，不能称唯一现场因果。生产renderer／Main／审批行为保持，原96条完整assert及顺序、whole文件bytes和10／45／120秒预算均保留；原三driver整文件1pass／13Bun断言／82.859秒，正常退出、双锁、冷正文和启动诊断均通过，具体证据与新完整默认收束归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11macos-mcp-失败建立与完整连接恢复)。

## 原轮次阅读、聚合与问答回执

[native-transcript](src/native-transcript.ts)把已核实的公共 Run 接入原 [Conversation](../../packages/ui/src/desktop/Conversation.tsx)，保原过程折叠、最终回复、失败行、工具聚合与会话阅读状态。SessionPage 的 `renderMessageContent` 只替换正文、`renderToolActivity` 接完整分组与原展开控制；外层布局和复制按钮仍归原组件。正文继续使用原 ModelOutputMessage，子详情沿原只读 reader，不以子日志重建轮次。

压缩行的热进度与持久记录按 Store／Session／Run／Model Execution 使用同一 `presentationKey`，只控制原 MessageGroup 的 React 身份，真实 Message ID 与正文读取、复制身份不变。[Main](electron/native-caller.ts)从同一 View 的真实压缩 Message 提取空正文的最小状态事实，经原 selection 生命周期交给 transcript，补齐独立 history GET 的交接空隙，并按原 seq 插回。有限 View 不删除完整历史，已保存的 completed／failed／cancelled 不被旧 View 的中间态回退；同一 Run 的下一次压缩使用新 Execution 身份。普通同选择刷新暂时清空 controller snapshot 时，Main 沿原 lastView 保留热压缩的只读显示，Native 不再按读取 loading 二次撤掉进度；真实观察／权限失败仍撤销热指示，动作资格始终等待新读取。没有新增显示缓存、摘要正文读取或操作权限。[交接 DOM 回归](test/isolated/native-transcript-dom.test.tsx)核三阶段热行、View 终态先到、新正文先到及历史接管时行与 Turn 节点保持、顺序、去重、旧状态不回退和跨身份隔离；[Main 回归](test/native-caller.test.ts)核摘要及正文描述符不进入这些展示事实，并阻挡普通刷新核保留进度、真实刷新失败核撤销；[导航 DOM 回归](test/isolated/native-session-navigation-dom.test.tsx)在同选择多次刷新时核原行和运行文案不变、真实权限失败后移除。Core 的快照连续性由[压缩 owner](../../packages/agent/src/storage/sqlite/context/compression.README.md#会话消息中的压缩身份)负责。

2026-10-23，普通 macOS arm64／Bun 1.4.2 Native 候选、`8a8458800` 加本次工作树，压缩显示专项回归 17 整文件 189 项／3035 断言、八 workspace typecheck、边界、同源 API、测试归属、Biome 和文档检查通过。真实 `deepseek-v4-flash`／chat-completions／medium／4096 的父压缩专项 `dist/acceptance/parent-compaction-stability-live-window-20261023-c492861a.json` 通过：15 次 HTTP 200、278 帧；144 个压缩行采样始终同一 DOM 节点和 32px 高度，仅由“正在压缩上下文”转为真实“上下文压缩完成”，无空档、重复行或旧状态回退。原父 Turn 保留两引导，最终中文按后条采用 Blue 并含两码，冷重开零新增请求或业务记录。该 profile 明确不触发子压缩，不能代替完整父子压缩验收；它验证此前真实样本 `d95a430e` 中 20ms 缺行及约 63px 高度跳变的显示修复。

同日完整父子场景 `dist/acceptance/parent-child-compaction-live-window-20261023-f601c98d.json` 通过，非 Markdown 输入 4591 个，工作树 SHA-256 为 `88a36b91c5897a416abae6f07524be1068e338be168323e94498f81160a112cd`。16 次真实 HTTP 均为 200、37 张阶段截图及 359 帧覆盖父结束后的条件续跑、本轮原邮箱接入、子真实自动压缩与一次完整读取、两条原 UI 引导、父真实自动压缩、最终折叠／展开及冷开。父压缩的逐帧／DOM 监视四项检查无错误，原节点从 running 到真实 completed 保持 32px，无重复、缺行或旧文案回退；最终仅一段“用时37秒”。子最终保留独立初始指示码并完成待发邮件，未将内部维护说明变成新任务，也未因原回执退出窗口重复读取。父后继请求独立保留两条完整原引导，最终中文保全部码并采用 Blue；冷开零新增 Provider／Run／Execution／Command／Source／control，两个普通窗口正常退出、所属进程无残留。上述候选均关闭诊断，真实响应只经透明时序门延迟，未改写内容；资格限本机 macOS 和这次真实模型响应，不外推任意模型或完整发布。

当前原消息的 `inputKind:input.steer` 与准确 Run 一起投影给 Conversation，使本轮用户引导保留原 MessageItem、完整正文和发送顺序，进入原处理过程，随“处理过程／用时”共同折叠。首条输入、后继轮首条输入和缺少原类别的历史消息保留独立展示，封存 `originMessage` 不猜当前 Run。原 [Native 提交](src/native.tsx)沿准确本地 steer intent／targetRunId 保留发送占位的过程归属，原 `savedNativeInput` 接管保存后的消息，避免外部气泡与过程内消息之间跳动或重复；failed／unknown 的恢复入口继续可见。这里只调整展示归组，原 Command、接收检查点、模型输入、正文／附件和授权保持原合同。

压缩后的引导保留由共享 [Context owner](../../packages/agent/src/storage/sqlite/context/compression.README.md)负责，Native 不另存指令。2026-10-23，同一 macOS arm64／Bun 1.4.2、`8a8458800` 加本次工作树，普通 Native／真实 `deepseek-v4-flash`／chat-completions／medium 验证通过：两条 UI 引导后完整读取 182 行材料，生产 24000-token 阈值在同一父 Run 自动压缩；覆盖上界 19 包含引导序号 16、17。压缩后实际 ModelInput 独立保留两原 Command 的完整正文各一次，最终中文回复保留两核验码并按后条要求采用 Blue。15 次真实 HTTP 均为 200，35 张阶段截图与309帧保存在 `dist/acceptance/steer-compaction-live-window-20261023-c21e94a7.json.workspace`，报告为同名去掉 `.workspace` 的 JSON。实际检查受理／原消息接管、压缩进行中、后继请求、完成和冷开；149 个含引导的过程帧始终同一段、无过程外引导或重复。冷开零新增 Provider／Run／Execution／Command／Source／control，两次窗口正常退出且所属进程无残留。此前一次窗口驱动未提交 active 原任务，只执行6次 idle 请求，未取得压缩资格；修正普通 Enter 单次提交及实际受理检查后才取得上述通过结果。此证据限该本机候选和真实模型。

2026-10-23，macOS arm64／Bun 1.4.2，`8a8458800` 加本次工作树：[普通真实窗口 runner](../../tests/e2e/live/model/collaboration-unified-native-window.live.ts)使用 `testDiagnostics:false`、现有 `deepseek-v4-flash`／chat-completions／medium／4096，通过13次实际HTTP 200。两条多段引导从普通输入框发送，先受理再由原检查点应用；原 Command／Message／Run／selection、完整正文和准确来源逐项核对，下一份真实 ModelInput 及 Provider 请求各包含两条原文一次，原父 Run 的最终回复含两条核验码。28张阶段截图、174帧、canonical正文与回执保存在 `dist/acceptance/steer-process-live-window-20261023-3a9e5d9f.json.workspace`，报告为同名去掉 `.workspace` 的JSON。发送、接管、后续模型、完成与冷开相关41帧始终只有原父一段过程，无过程外引导或重复；实际检查了草稿清空、发送占位接管、终态默认折叠、展开原序全文及再次收起。`16-complete-steer-collapsed.png` 显示单个“用时10秒”和过程外最终回复，`17-cold-steer-1-expanded.png` 保留重开后的完整引导。冷开零新增Provider／Run／Execution／Command／Source／control，两个窗口正常退出，准确所属进程无残留。UI／Native及原首条输入接管七整文件117项／3007断言、八workspace typecheck、同源API、边界、测试归属、Biome与文档检查通过。该结果限本机普通候选与上述真实模型；时序门只延迟真实响应，不生成或改写模型内容。

轮次底部回复状态行消费同一已核实 Run 的 `turnActivity` 和 terminal marker，不按单条 Message 的 complete／模型正文是否已出现判断。思考阶段在同一底部节点显示“正在思考…”，出现正文或活动工具后显示“正在回复…”，底部行不附运行时长；普通活动过程入口固定为“处理过程”，无可展开内容时不显示空入口。主会话与子详情均沿此交接，工具或模型完成但 Run 仍活动时保留，观察暂不可用继续保留上次准确活动状态及原警示；准确 Run 完成、失败、取消或 interrupted 后移除。[思考 DOM 回归](test/isolated/native-reasoning-dom.test.tsx)核正文出现前及单段模型结束，[工具聚合 DOM](test/isolated/native-live-tool-aggregation-dom.test.tsx)核全部回执 complete 但 Run 仍活动的情况；[会话导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)核有可靠 Run 起点时底部仍只显示状态文字、普通校准节点保持及未知状态提示。

Native 的侧栏打开入口对当前父会话及同一在途选择去重，重复鼠标点击和 Enter 不重新发起 `select`、撤销历史读取或重建消息。子详情通过右侧栏标签打开，点击当前父会话不会关闭详情或重新选择父会话；准备页及安排任务页仍恢复原会话；选择其他目标和显式恢复读取保持原流程。[首次呈现回归](test/isolated/native-history-presentation-dom.test.tsx)核重复点击的请求数量、消息节点、滚动和展开保持，以及在途目标复用。

初始没有已选会话时，`selectionHandoff` 同样参与聊天加载判断，覆盖目标 `select` 确认和模型准备，再由 `NativeHistory` 的加载阶段接续；不能因 `selection` 尚未到达而提前发布 Conversation 空状态。[新对话 DOM 回归](test/isolated/native-new-conversation-dom.test.tsx)分别核已有正文与真实空历史，延迟选择、模型及历史读取并穿插状态刷新；完整历史到达后才呈现正文或实际空状态，原首次发送的待定消息交接仍保持。

首次挂载未缓存历史时，Native 将历史扫描及影响分组的 Run／Tool 首次读取标为 `initialPresentationPending`，原 Conversation 在首次可读提交前保留加载状态，随后一次显示完整轮次／工具布局。已核分组展示缓存可以直接使用；文件目标、图片、大正文和用量不加入结构等待。查询成功但缺少事实正常发布原文，历史／权限／结构读取失败保留原文和原恢复，不靠猜测终态或工具类型获得布局。首次输入与待定输入沿原即时展示，不等待历史接管后的结构读取。首次提交后的同一 Conversation 不再因该标记隐藏内容，流式更新、history epoch 校准及缓存返回保留原节点、阅读位置和展开；新事实或失败恢复仍按实际状态更新。发送、停止、审批和新读取继续等待当前完整scope资格，展示缓存不恢复操作权。[首次呈现回归](test/isolated/native-history-presentation-dom.test.tsx)核两种结构到达顺序、缺失／失败、缓存返回及epoch校准；[活动回执回归](test/isolated/native-tool-receipt-render-dom.test.tsx)继续验证运行中延迟工具信息的折叠原文保护。

[轮次分组展示缓存](src/native-transcript-display.ts)沿原NativeDisplayCache预算，仅在同一bridge对象、generation／Store边界及准确Session／Workspace／historyEpoch内保留已验证grouping。metadata加载期间，完整消息与已核全文回复的全部字段仍相等时才复用；正文、来源或附件变化不命中，真实历史／Run／Tool／文件读取错误或非加载期权限不可用撤销对应项。非加载且完整时才更新缓存，`turnActivity`始终取当前fresh transcript；缓存不保存读取lease或操作资格，当前viewSelection的读取门禁保持。

首条输入经 `savedNativeInput` 核实保存后，仅在当前窗口记住所属 Store／commandId 已由历史接管；后续冷读暂时没有该 Message 时，不重新插入旧占位或永久豁免首次分组等待。原 `firstSubmission` 的未知结果查证、失败重试及草稿／附件处理仍保留。[首条输入回归](test/isolated/native-new-conversation-dom.test.tsx)核创建并保存、离开、history epoch 清除非当前缓存，再返回时分别延迟历史／Run／Tool的完整链。

提交前 review 发现并补齐上述首创会话冷返回边界：新增用例在历史仍被阻挡时复现旧占位提前出现，修复后1项／24断言通过；同一首条输入整文件69项／1317断言通过，原延迟接管、未知查证、失败重试及草稿隔离保持。

当前 View 的真实 Run 可直接用于展示；完整历史超出近200项时，[Main](electron/tool-messages.ts)只接受当前已经观察、未带 `originMessage` 的 Message ID，每批32项，经当前生成 Client GET 核准确 Run ID／Session 和前后 Store 连接。结果仅含原出处、状态与时间，按原 generation／viewSelection／history epoch 绑定；关闭和切换只释放所属 GET。当前 Store 已保存的旧 Store 终态 Run 可作为历史事实展示，保原 `originStoreId`；foreign active 不进入活动轮次或控制。Fork／Include 的封存 Message 不查询来源 Run 后来的状态，也不据此标最终回复。

同一 bridge／generation／Store／Session／Workspace／viewSelection 内，history epoch 刷新会重新核历史 Run；此前已核的 inactive completed／failed／cancelled 仅保留轮次展示，使等待新 metadata 和分批返回时不会暂时拆掉原 Conversation 节点或用户展开的过程。此展示层不填入新 epoch 的读取缓存，也不减少原 GET；已核的新 View 和新 metadata 替换旧事实，明确缺失删除旧展示。当前 View 同时更新该 scope 的 metadata，避免 Run 离开有限页后被较早结果覆盖。active／interrupted 不跨 epoch 保留，换任何展示身份即撤销；大正文复制和所有动作仍沿当前原身份与 authority 核验。原 DOM 文件5pass／80断言核节点、展开保持和新事实／缺失覆盖；原完整历史窗口的75秒资格与完整默认回归仍以[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)为准。

没有 `outputBody` 的普通历史正文按 generation／viewSelection／Store／Session／Message 的 inline 身份保持组件，不因 epoch 重新挂载相同 Markdown；当前文件回调有无仍随核验状态变化。带 `outputBody` 的组件保原 epoch key，完整读取、关闭、换 scope 的撤销仍沿原边界；inline／body 分支切换同样重新挂载。共享正文身份仅按原八项字段 memo，任一字段变更仍清理原已读结果，不以展示组件保持借用旧全文或动作许可。

只有已确认 completed 且非活动 Run 的最后一条完整、支持格式、无工具调用且后面无工具结果的助手消息才成为最终回复。原起止时间与终态供原组件显示耗时／失败／停止；无法核对时保原消息，活动视图失效显示“上次确认状态”，不补造成功或计时。最终回复资格与正式 Web 共用纯 [completeRunReplies](../../packages/ui/src/run-reply-copy.ts)；Native 显式选择 `copyScope=final`，保[桌面手册](../../docs/handbook/clients/desktop/README.md)只复制完整最终回复、不含同轮工具前说明的合同，Web 整轮范围不扩到 Native。大正文预览的 `copyText=null`；仅最终段原 reader 已验证并显示的准确正文启用“复制本轮Agent回复”，关闭正文、换消息身份或换scope即撤销。本地 Map 只持有当前已显示内容，不写持久日志或格式。

同一准确 Run 中相邻、已核实的 Files read2/3/4、glob2、search2/3、list1 交原组件视觉聚合，正文／独立工具仍构成边界。每项文件按钮保自己的 Message 和原 receipt 观察 ID，经 Main 原文件端口核当前项目、普通目标与 frame；分组不共享文件权限。当前人工审批文字只来自同一当前 Store／活动 Run／Execution 的唯一真实 pending Interaction，实际回答仍沿原 InteractionCard 和公共提交链。

默认 `ask_user` v1 的历史回执沿原成功 Execution／准确结果读取；唯一原 Model call 提供 q1–q3 的实际问题，回答保原人类选项标签与自由文本。`{cancelled:true}` 显示“已取消回答”，工具仍按实际 succeeded，Run 可继续；这不是停止任务。缺原请求不补问题，未来版本只保原文。原审批的当前接入见下一节；原记录另由[交互历史](#原交互记录只读历史)读取，所有封存／恢复组合及完整 PC 核对尚未关闭。

恢复为新 Store 后，原源会话和封存 Fork 的已回答记录继续交原 ToolRow 展示。Main 核已观察 Message 的唯一原 Execution、原 Session／Run、明确封存的 Store 及终态／准确结果；原问题只从同一原 Store／Session／Run 中唯一较早的 Model call 取得，不把当前准入 Store 当作原出处。封存记录不读来源 Run 的后来状态，也不提供原授权或回答入口；当前活动工具与回答资格仍由原独立入口控制。恢复后的封存 Model 用量同样只核原成功 Execution，不借来源 Run 的后来状态补历史。

[安装版问答回归](test/isolated/native-restored-questionnaire-bundle.test.ts)使用默认 installed Main／Service／preload 与原 Questionnaire，保存一次选项和完整 Unicode／换行自由文本，再明确 Fork、退出并通过包内 CLI 备份恢复为新 Store。三个真实 macOS 窗口核源会话／分支的原问题、答案、Message／Execution／Run／Store、首次与冷读及切换清理；原回答 POST 仅一次、Provider 两次，读取 POST 与封存来源 Run GET 均为零，三次 Service 普通退出及双层 EX 可取。当前结果为 1pass／24Bun断言及全部 Node 流程／79.14秒；[Core 冷出处](../../packages/agent/test/isolated/context/restored-origin.test.ts)、[投影](../service/test/message-response.test.ts)与上述 Main／原 DOM 提供各自范围的证据，准确输入和失败归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后已保存问答回执)。本片不扩展取消回答、审批、通用交互历史的全部恢复组合或完整 PC 资格，公共 schema、原 UI 与持久格式保持。

取舍见[轮次展示决定](../../.agents/notes/implemented/architecture/2026-10-08-native-run-transcript-presentation.md)。[Main／有限 IPC](test/native-tool-messages.test.ts)、[正式 caller](test/native-caller.test.ts)和[原 Conversation DOM](test/isolated/native-transcript-dom.test.tsx)核身份、所属读取、原展开／复制及问答；原[源码外 macOS 窗口](test/isolated/native-bundle.test.ts)核首次和冷读的折叠、展开与准确最终复制，保原预算和退出断言。实际执行输入与结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原轮次阅读聚合与问答回执)，有限展示证据不代替完整恢复、其他平台或整片独立审查。

## 会话消息渲染验证

2026-10-25同一`852f665b0`工作树、Windows x64／Bun1.4.3／Chrome155：用户指出无工具回复仍可能在文本渲染时换行，隔离页面复现逐字span在英文558px和中英混排244px比连续正文多出一行。改用[绘制层渐显](../../packages/ui/src/desktop/streaming-text-reveal.ts)，文字保持连续Text节点、原字距与字体。实际浏览器同时检查字符绘制颜色由透明逐步增加、全文高度不变、结束后Highlight及动态样式为零；不能只核原生时钟已创建。新增字素与已读选区继续分开，后续追加使用appendData保留旧选区。

`bun test --parallel=1 --max-concurrency=1`定向执行流式Markdown、Markdown结构、语法缓存、消息复制、阅读滚动、轮次生命周期和过程聚合七文件，56项／1654断言通过；UI／Desktop typecheck、Biome及文档检查通过。[原流式浏览器回归](test/streaming-render-browser-runner.fixture.ts)在1280／800px、深浅主题及减少动态效果四组均通过，每组加入三种纯文本在180–740px的281档宽度比对，共3372组流式／自然正文换行一致；仍核旧块不变、原400px手动阅读、缓存回切、重连、末次追加和自动全文交接。实际绘制帧及隔离比对在`.cache/text-wrap-20261025`，完整回归在`.cache/streaming-render-QE3iPR`。当前证据覆盖生产Native renderer与隔离bridge，不替代安装版Electron或真实外部模型资格；与先前仅验证固定正文信息行的范围分别保留。

同日首轮真实客户端观察：`852f665b0`加上述工作树，Windows x64／Electron44.3.0，通过`bun run desktop:dev`启动普通Main／preload／当前HMR renderer与真实Service，诊断构建值关闭；在新建验收对话中经普通模型菜单选择`gpt-6.1-sol`／high，实际发送中文单段、中英文加表情双段、英文长段和英文短段四次普通聊天。英文短段从“正在回复”到耗时终态的18个连续样本，正文区域与最终帧逐像素相同，但这只证明末尾稳定；用户指出最开始整块上下跳动后，回看第698至699帧确认“回复未完成”临时插入后消失，原用户气泡锚点由310到360px反向回落50px，原整轮“未见抖动”的结论撤回。只读查询准确验收Session确认四个Run均completed、四个业务Model均succeeded且模型与high快照一致，Tool Execution为0；自动标题另有独立Model，不计为业务回复或工具。原742张带时刻的窗口帧、脱敏执行摘要及末尾像素比对继续保留于本机`.cache/live-gpt-render-20261025`；长混排回复记录未覆盖完成瞬间，也不据此证明终态。该记录不代表正式安装包、其他窗口尺寸／主题／模型或全部流式分段组合。

随后修正共享[ModelOutputMessage](../../packages/ui/src/model-output.tsx)对`autoRead`的提示判定：`body.complete=false`只表示当前前缀未封存，读取中间状态或已核实的planned／dispatching／running不插入“回复未完成”；已核实终态且输出确实不完整才显示，失败／取消／结果未知保持原提示。[Model output回归](../../packages/ui/test/model-output.test.tsx)先复现读取中间状态错误插入提示，再全文件16项／173断言通过，另Native正文缓存、后台历史与Web页面三文件22项／368断言通过。原[流式runner](test/streaming-render-browser-runner.fixture.ts)新增前缀→封存各36帧、思考稳定后首段固定正文40帧的几何与临时提示断言；1280／800px、深浅主题及减少动态效果四组通过，封存时正文top与height不变，首段后没有额外展开位移，因此未修改折叠实现。当前真实开发窗口再次经普通输入发送40词英文消息，仍用`gpt-6.1-sol`／high且无工具调用，连续110帧覆盖发送、首批正文、首次换行及完成；锚点随新增内容向上跟随，没有原50px反向回落或提示闪现。实际窗口被用户最大化并打开右侧浏览器，故不将其与旧尺寸当作同尺寸性能对照。新帧及前后锚点分析在`.cache/live-gpt-start-20261025`，隔离回归在`.cache/streaming-render-zNRGj1`；本次范围限上述Windows普通回复过程，其他平台、安装包和任意流式分段组合仍未据此取得资格。

2026-10-25，`852f665b0`加本次信息行修正，Windows x64／Bun1.4.3：[共享Conversation](../../packages/ui/src/desktop/Conversation.tsx)将独立流式提示放进原信息栏，[共享样式](../../packages/ui/src/desktop/style.css)统一回复／思考提示与工具栏为28px高、距正文2px；展开过程以Agent正文结束时采用相同的8px后续间距。[轮次生命周期](../../packages/ui/test/isolated/desktop-turn-response.test.tsx)、[过程聚合](../../packages/ui/test/desktop-reasoning-turns.test.tsx)和[日期](../../packages/ui/test/desktop-message-time.test.ts)三文件36项／653断言通过，UI typecheck与定向Biome通过。使用真实Conversation与生产编译CSS的隔离页面逐步观察轮次与独立消息从回复中到完成：两组各40帧的信息行高均为28px、距正文均为2px，正文、信息行及下一条消息坐标保持，过程内不增加时间／复制。原16px后续位移已复现并修正；测量保留在`.cache/response-row-20261025`。这是共享组件的固定正文布局验证，未重验安装版Electron、真实模型或正文与过程内容本身发生变化的布局。

2026-10-25接入远端`2e913e139`的自动全文及读取队列后，Native普通消息继续默认自动核验正文。`NativeMarkdownBody`仅在原Store/Session/Message/Run/Execution身份内保留已显示的核验文字和prepared树；下一版读取时不闪回预览，旧文件入口关闭、原onContent仍撤销复制资格，新的准确核验结果到达后才发布当前正文。首个自动全文填充静态，之后追加按字素渐显；显式手动读取保持静态，身份切换和Activity隐藏清理保留。合并后16个完整定向文件195项／3248断言及五个受影响workspace typecheck通过，日志在`.cache/native-streaming-rebase-tests.log`。同一Electron runner的四组窗口另覆盖自动全文首填、100ms在途保留、复制资格撤销、六个新字素依次渐显和减少动态效果；合并后夹具补齐真实首轮模型协议封存，不能以缺配置造成的发送阻塞冒充正常场景。窗口轨迹与截图在本机`.cache/streaming-render-C3CEQm/`，生产renderer流程与孤立Native自动正文的证据分别记录，不代替用户数据或安装包验收。

2026-10-24本轮最终定向验证：13个完整测试文件170项／2964断言通过，日志分别在`.cache/native-history-final-tests.log`及`.cache/native-streaming-final-tests.log`；Agent／Service／Client／Desktop／UI typecheck、33个相关源码与测试文件Biome、生成API一致性、统一边界、测试归属、文档结构和影响核对通过。范围为Windows开发交付及下列隔离窗口/协议场景，不代替安装包或其他平台资格。

[NativeModelOutputMessage](src/native-model-output-message.tsx)为未暂停的assistant预览传递`streaming`：incomplete为true，完成预览为false；显式完整读取不传此标记。正文来源、完整读取证明、复制与当前操作准入保持原链路；用户消息、已完成历史与独立Web／TUI不启用该效果。共享展示层的元素memo与追加文字渐显归[UI owner](../../packages/ui/README.md#markdown-消息内容)。[流式浏览器runner](test/streaming-render-browser-runner.fixture.ts)沿现有隔离[NativeDesktop夹具](test/render-performance-browser.fixture.tsx)加载生产编译CSS，记录每帧文字、状态、滚动及透明度，核稳定块零正文DOM变更、连续追加、完成、缓存返回及减少动态效果；夹具入口和控制只存在于测试制品，正式诊断构建值关闭。执行`bun run apps/desktop/test/streaming-render-browser-runner.fixture.ts`，产物位于本机`.cache/streaming-render-*/`。

同一runner为读取注入45ms跨任务延迟；`--electron`在独立临时数据目录启动沙箱Electron窗口，运行生产renderer和隔离bridge，不读取用户Store。普通流式阶段只允许首轮完整基线，其后每次读取仅返回更新消息，不能闪现历史`aria-busy`；切换返回及模拟重连则必须观察完整校准中间状态。记录每次通知到对应文字第一次进入DOM的时间，逐字渐显不阻塞正文提交。当前[NativeHistory](src/native-history.ts)的持久变更协议见下文；Main收到正文事件直接唤起增量读取，跳过View刷新合并窗口，模型端保存合并及其他元数据刷新的节流未调整。

2026-10-24，Windows x64／Bun1.4.3／`fb3989b47`加当前工作树：最终逐字渐显的四组Electron44.3.0／Chromium152.0.7977.78窗口共2982帧，普通三组各219个独立字素动画，减少动态效果0个；每批跨行内节点有序错开，观察到部分字已淡入而后字仍透明。每组正常流式阶段1次基线后13次增量、每次只返回1条更新消息，无history loading；切换B、返回A和模拟重连各增加一次完整基线。稳定块正文DOM变更0、400px阅读位置保持，完成后跟随，无裁剪或脚本错误。56次追加注入45ms读取后的DOM展示均值58.6–61.3ms，各组P95为63.3–66.7ms；不是实际用户Service延迟，也不等待420ms内的动画结束。过程截图、逐帧文字／透明度／状态、读取与通知日志在`.cache/streaming-render-xs39Ln/`，已逐阶段检查流式、手动阅读、缓存、重连与完成。

[真实链路回归](test/isolated/native-history-incremental-http.test.ts)连接实际Main→SDK→Service→SQLite，以固定流保存同seq正文，主动切断真实SSE后在断开期间继续保存，等待新的ready/epoch和完整基线，重连和冷建Client/reader均保原ID与单条正文；原Run只执行1次、命令POST只有1次。读取可能经尚在途的HTTP先抵达，不能将“正文出现”等同于观察流已重连。当前定向整文件回归覆盖Main／history／cache、Store／原输入接管、Client／HTTP，以及逐字UI／复制／滚动／Native transcript；进程日志保留在本机`.cache/native-history-final-tests.log`。新协议需完整重启桌面Main及配套Service，renderer HMR不能加载后端能力。本轮没有重启用户运行中的客户端，也未验收安装包、真实Provider或其他平台。原macOS长历史窗口夹具已按增量API注入读取失败，并以真实SSE重连触发held完整基线，原断言和期限保留；本机Windows不能执行该macOS整窗口资格。下面较早的按片段渐显与完整重读记录保留其当时范围，当前行为以上述逐字和增量实现为准。

同日用户反馈实际开发客户端没有渐显后，加入上述跨任务读取，原条件复现动画0次；失败报告保留在`.cache/streaming-render-zjNzSA/`。原即时bridge的2162帧只证明其合批时序，不能覆盖实际IPC准入。修复为只核当前读取资格，以已显示正文维持连续性；Activity隐藏／重连、完整读取与纠正的原限制保持。新增读取校准回归与缓存、复制、滚动四个完整文件14项／1218断言通过，UI／Desktop类型检查、定向Biome和文档核对通过。Windows x64／Electron44.3.0／Chromium152.0.7977.78的最终四组800／1280px、深浅主题及减少动态效果共2571帧，逐阶段检查渐显、连续追加、手动阅读、缓存返回与完成；各组实际观察76–90帧读取中间状态，三组普通模式各15次新增动画，减少动态效果0次，稳定块正文DOM变更0，手动400px位置保持，无裁剪或页面错误。52次追加在注入45ms读取后的显示均值为63.2–65.4ms，各组P95为67.8–74.4ms，计时截至文字进入DOM，不等动画完成；这是隔离夹具结果，不是用户实际会话或真实Service耗时。准确轨迹、源码构建与过程截图在`.cache/streaming-render-7WddnH/`；未操作用户会话，未做真实Provider或完整安装制品验收。

2026-10-24，Windows x64／Bun1.4.3，`fb3989b47`加本轮工作树：定向12个完整测试文件最终有效66项／2464断言通过，包含新增的实际React跳过渲染与Native不完整全文读取静态交接；最终正文来源区分后重跑流式UI及Native消息完整文件，其余按未变的非流式路径、parser、Worker、复制与滚动断言复用本轮结果。Native文件的一轮沙箱loopback请求返回`network_outcome_unknown`，允许本机网络后完整20项／337断言通过，未改业务断言。UI／Desktop类型检查、定向Biome、统一边界、测试归属及文档检查通过。

Chrome155.0.8059.85的最终四组800／1280px、深浅主题及减少动态效果记录2162帧：三组普通动画各15次，仅新增文字处出现0.25到1之间的透明度；减少动态效果为0次。稳定块正文DOM变更为0，上翻后的连续追加与缓存返回保持400px位置，回到底部后完成仍跟随，正文范围无裁剪、页面无横向溢出或脚本错误。逐阶段截图核正文、输入草稿、处理状态及完成交接，产物在`.cache/streaming-render-J6e67q/`。首轮runner用原Markdown源码等待展示文字而超时，失败帧保留在`.cache/streaming-render-KQ4ro6/`；修正展示文本等待后通过。390px试探出现原有布局裁剪，核[Main](electron/main.ts)的800px下限与原内容面板最小宽度后，最终按实际桌面尺寸验收，未改窗口布局。Windows窗口观察工具因无法核实浏览器URL停止，不将该次观察计为整窗口验收；本轮证据为隔离生产renderer及真实浏览器，未重验安装版Electron、真实Provider、系统断网或其他平台。保留既有嵌套`@keyframes`编译提示。

[消息适配](src/native-presentation.ts)将公开 `Message.createdAt` 交给 UI 的 `createdAtMs`，Agent 邮件和结果的专用展示分支也保留已提供的时间，缺失时不补造；旧输入的真实业务副本接管原行时，保留原输入的记录时间、独立同文与原业务身份。普通刷新、完整正文读取和重开不生成客户端替代时间；尚未保存或历史缺失时保持未知。共享 Conversation 仅在原消息边界显示信息栏，Turn 过程内的 Agent 正文和普通邮件不渲染复制／时间及其留白，用户引导、过程外最终回复与独立结果的原边界保持；该显示选择不删除宿主时间事实。[时间投影回归](test/native-message-time.test.ts)核字段与接管，具体格式与布局由 [UI owner](../../packages/ui/README.md)和[桌面手册](../../docs/handbook/clients/desktop/README.md)负责。

2026-10-23，Windows x64／Bun1.4.3：时间投影2项通过（含原输入时间未知时不借用较晚业务时间），原[会话消息 DOM](test/isolated/native-transcript-dom.test.tsx)整文件9项／143断言通过；隔离 Chrome 的输入接管、流式、重开、日期与阅读位置证据见 [UI owner](../../packages/ui/README.md)。本次新增 Service／Client 的时间字段，开发运行需完整重启客户端以加载 Main 与配套 Service 的新协议资产；不以 renderer HMR 代替主进程更新，完整安装包未在本轮重验。

[首次历史浏览器夹具](test/native-history-presentation-browser.fixture.tsx)通过实际 NativeDesktop、生产样式和隔离 bridge 分别延迟选择、历史、Run 与 Tool，并按原请求身份和32项批次返回。由[逐帧 runner](test/native-history-presentation-browser-runner.fixture.ts)核首次进入、未缓存切换及缓存返回，记录目标首个可见消息之后的节点身份、宽高、滚动、留白与加载／欢迎状态；旧性能夹具提前提供完整 View Runs，其数据不覆盖这一异步重组时序。环境卡首次宽度在共享 SessionPage 的 layout effect 确定，不启动初始占位过渡；后续窗口跨阈值和用户开合保留原动画。

2026-10-23，macOS arm64／Bun1.4.2，基于 `45b8275c1` 的当前工作树（含本次修复及并行子 Agent 展示改动）：合回当前目录后，相关11个DOM／组件测试文件154项、3982断言通过，UI／Desktop类型检查、定向Biome及文档检查通过。Chrome155六组首次／未缓存切换核Run先到、Tool先到、View已齐、40轮多页历史与32项事实批次，含亮暗主题、1280／1320／1440px和减少动画；目标首次显示后连续28–30帧的消息／轮次节点、阅读区几何、滚动和Composer位置不变，缓存返回保原节点。Electron44.3.0／Chromium152独立窗口沿相同生产renderer制品复核首次与未缓存切换，各80个连续可见帧同样稳定，零页面错误；过程截图确认等待后直接进入完整分组。环境卡独立9组首屏／晚到内容与8组开合／调宽验证中，1320／1440／1600px首帧已为最终占位，原403px正文高度变化和146.5px最大横移消除，后续交互动画保留。证据分别位于本机 `.cache/native-history-presentation-fyZ0mY/` 与 `.cache/session-render-fixed-electron-C3IvWz/`；使用隔离数据，不覆盖真实Service／SQLite延迟、安装包或其他平台资格。异常读取fallback后的新事实仍按原恢复规则更新，不把正常冷开布局稳定外推为恢复时不更新分组。

[Code Block／Trace 聚焦夹具](test/ai-elements-browser.fixture.tsx)使用实际 Conversation、ToolActivity、MessageContent 和生产 CSS，执行 `bun run apps/desktop/test/ai-elements-browser-runner.fixture.ts` 核亮／暗主题、1280／390px viewport、代码横向滚动、文件按钮、工具聚合与 Shell 追加／取消。同组思考／回复切换保留底部状态节点，收起过程仍可见；准确 Turn 结束后移除。输出 `.cache/ai-elements-browser-*/report.json` 及各组常规／思考状态截图，所有数据固定且诊断构建值关闭。

2026-10-21，`c89911153` 加本次工作树，macOS arm64／Bun 1.4.2／Chrome 155.0.8059.86：上述四组均无页面横向溢出或脚本异常，Shell 输出保持256px上限，上翻后追加保持原位置，回到最新准确到达底部；手动开合、取消后的实际日志及独立文件回调保持。[缓存夹具](test/conversation-cache-browser-runner.fixture.ts)在亮／暗两组的各24个观测帧核代码 PRE 与复制节点身份、80px横向位置、暂停操作及宿主原文复制。[桌面代码块回归](../../packages/ui/test/isolated/desktop-code-block.test.tsx)、共享桌面／Markdown／缓存与 Native 正文缓存共13文件59项通过，Native 工具显示／回执／聚合另3文件17项通过；UI／Desktop typecheck、UI Desktop 生产构建和定向 Biome 通过。原 Native 渲染夹具六组继续通过流式更新、回复状态边界、减少动画和缓存返回检查；本次未运行安装版 Electron 窗口或其他平台。

[隔离夹具](test/render-performance-browser.fixture.tsx)使用实际 `NativeDesktop`、SessionPage、Conversation、Markdown 和生产 CSS，只有 NativeBridge 的会话／历史读取为固定数据；测试诊断构建常量仍为正式关闭值。执行 `bun run apps/desktop/test/render-performance-browser-runner.fixture.ts` 会独立构建生产组件，在临时 Chrome profile 测量窗口首屏、首次选中、逐条更新、连续32次／32ms间隔更新、终态转换和 A→B→A。覆盖10／60／180轮含列表、表格、代码和Unicode的历史，以及亮／暗、1440×1000／960×1000、减少动态效果；输出 `.cache/render-performance-*/report.json` 与截图，不读取用户会话或调用 Provider。

2026-10-20，`5dba8a6b` 上的本次工作树，Windows x64／Ryzen 9 5950X／32GiB／Bun 1.4.3／Chrome 155.0.8059.82：修前首段正文已经显示后，默认展开的活动过程仍重播300ms动画；共享 [Conversation](../../packages/ui/src/desktop/Conversation.tsx)在首次读取也使用原恢复标记后，首个正文观测周期即为完整高度，手动开合仍按原动画。截图另发现“正在回复…”的绝对定位使末行被折叠容器裁剪，浏览器边界断言先复现失败；改为正常文档流后完整可见。最终六场景中，本机HTTP夹具导航至应用壳观测约243–272ms；下表另从触发会话选择计时，展示亮色1440×1000的一次本机样本。

| 历史轮数（每轮2条消息） | 首次显示且高度稳定 | 未缓存会话切换 | 选择确认后的返回显示 | 单次流式更新 |
| --- | --- | --- | --- | --- |
| 10 | 116ms | 46ms | 21ms，复用DOM | 6–8ms |
| 60 | 215ms | 171ms | 74ms，复用DOM | 9–15ms |
| 180 | 474ms | 385ms | 327ms，超节点预算后重建 | 18–24ms |

浏览器在RAF后的task采样，避免把ResizeObserver绘制前的跟随写入误记成可见跳动；另记录实际展开动画与50ms以上long task，不把等待固定观测帧的总时长当渲染时间。六场景首次正文高度均保持一值、无自动展开动画，回复状态完全位于viewport及各级裁剪容器内，底部跟随误差≤1px；手动阅读的1500px位置在更新和往返后保持，切换等待期间无空白帧。每场景连续更新均无50ms以上long task，最大采样间隔约12–20ms。预算内返回核原消息节点身份，180轮按原10,000总DOM节点单项预算回收，不以元素数代替包含文本的节点数。

剩余瓶颈是完整大历史的首次Markdown／DOM挂载和淘汰后的重建，本轮没有降低这部分CPU成本；命中60轮缓存仍约69–74ms。此夹具的分页与选择响应由内存bridge提供，不覆盖真实Main／IPC、Service／SQLite、安装启动、Provider延迟、真实图片／大模型正文reader或Electron compositor。[缓存浏览器回归](test/conversation-cache-browser-runner.fixture.ts)在本轮亮／暗主题的200次切换中另核图片、复制与悬停恢复；[完整工具栏回归](test/session-shell-browser-runner.fixture.ts)通过200次切换与192个等待帧，核标签、位置、透明度、草稿及只读门禁。实际制品、跨平台及完整业务资格仍按各自owner验证。

## 原审批面板与授权观察

[NativeApproval](src/native-approval.tsx)复用原 [Approval](../../packages/ui/src/desktop/Approval.tsx)按钮与范围菜单，只提供原请求实际允许的 `approve_once`／`same_command`。主按钮“批准一次”，分体菜单“本次会话批准”同时注明仅本次及本会话相同命令。已知 `shell.execute`、`shell.launch` 和 `shell.command` 的版本1显示准确原命令，其他定义显示原身份、目标和原因；工具标签与等宽目标分层，单行超出省略，沿原 Tooltip 悬停／聚焦查看核实后的完整原审批请求（包含 Shell 每次调用的 filesystem／network 权限、其他输入与策略原因），不再额外展示详情；单行命令不代替授权范围披露。`InteractionCard.renderApproval` 的紧凑模式自动沿原附件 reader 的身份、hash、UTF-8 和 EOF 资格核实完整正文，失败可重试；未读完、换卡、提交中或未知时禁用。回答仍走当前 Native／Main／公共 Client 原链，不建立第二个提交入口。

[NativeApprovalGroup](src/native-approval-group.tsx)将当前普通工具审批归入输入组件上方的一张独立浮卡，高度不超过默认 Composer；右上角“‹ 1/3 ›”一次只挂载一项原 `InteractionCard` 与准确 `approval ID` article，翻页不回答其他项，当前项消失后按原位置选择后继。主 Agent 不显示名称；子 Agent 名称按实际 Store／Session／Run 核实，未匹配时显示“子 Agent”，不将内部 UUID 当名称。[ApprovalHeader](../../packages/ui/src/desktop/ApprovalHeader.tsx)按准确 Store／Session 的随机身份确定固定池中的图标及语义色槽，翻页、重开或新 Run 不重新随机。附件读取、独立 grant、在途／未知禁用、原答案身份与迟到隔离均沿原链；MCP 来源／凭据授权、问题及计划不进入普通审批组。

[浮卡 DOM](test/isolated/native-approval-group-dom.test.tsx)连同[原审批](test/isolated/native-approval-dom.test.tsx)和[输入交互](test/isolated/native-interaction-composer-dom.test.tsx)核单卡翻页、主名称缺席、准确子名称与稳定图标、独立决定、紧凑附件门禁、单项 unknown、旧 Store／Run 名称隔离及其他交互类型保持；[环境信息停止回归](test/isolated/native-environment-stop-dom.test.tsx)继续核只读名称投影未放宽原停止资格。

子 Agent 的会话批准另由同一浮卡 DOM 核实际菜单选择，答案保留原 child Interaction／Session／Run／Execution，父及兄弟卡仍各自待批；两份审批 DOM 整文件本次均通过。[双 child 窗口](test/isolated/native-collaboration-bundle.test.ts)使用新构建、源码外候选和受控模型：A／B 请求完全相同 Shell 命令，A 的 Tool 与 Job 各自选择“本次会话批准”后，同子会话第二个 operation key 无新审批执行，效果恰好两次，B 保持原卡零效果。原同 Session follow-up、旧答案／旧停止拒绝、准确停止及冷重开零重放断言保留；冷只读 Store 另核只有 A 的两条 Tool／Job grant，父和 B 均无 grant。原权限交集与版本绑定由[Agent owner](../../packages/agent/src/permissions/README.md)维护。

2026-10-22 在 `761405f5e` 加本次差量、macOS／Bun1.4.2／Electron44.3.0 上，以 `bun test --parallel=1 --max-concurrency=1 /Users/chenchao/Code/ai/kite-code/apps/desktop/test/isolated/native-collaboration-bundle.test.ts` 执行上述窗口整文件：1项／43条 Bun 断言及 driver 过程断言通过，33.37秒，18次受控 Provider 请求；同时保留内部权限检查及标题生成不计入真实 child 目录的原断言。过程截图已逐张观察；正常退出和原候选清理均无强制终止或残留，冷重开无模型重放。实际 report、日志、截图与冷授权目录保存在 `dist/acceptance/child-session-approval-f34f97ba-6028-4ced-9842-9557b3b5094d`，测试成功后清理临时候选，只保留有限证据。该结果覆盖本机受控 Electron／Shell 链路，不取得付费 Provider、其他平台或签名安装资格。

公共 Execution 的可选 `authorization` 是 [Store 只读观察](../../packages/agent/src/storage/README.md#只读授权观察)，只表达原 reviewer、人工答案、accepted decision 与派发事实。Native 将它映射到原 ToolActivity 的审批标签，分别显示“已提交批准，待核对”“已人工批准”、自动批准／拒绝／等待或结果未知；停止后保留可核对的已有记录。批准不覆盖工具的真实失败、取消或未知状态，也不授予执行权限。每项当前待批状态仍以实际 Interaction 为准；Auto 转人工时保留原审查原因。

普通 root／child 工具审批都与父 Composer、权限选择器并存，待批时可切 Auto／Full 使原未派发工具重新判断。`nativeRootInteractionBlocksComposer` 只为准确当前根的 question、plan_review 与 MCP 特殊审批隐藏输入，仍核原 Store、父 Session、准确 Execution 与活动 Run；runless 原交互核准确原执行，不以 rootSessionId 或 waiting 文案推断。共享 SessionPage 的 `interactionHidesPrompt` 缺省保持，Native 对普通工具审批明确保留 Composer。实际输入、单轮准入及模式复核继续由原 Runtime 决定。

## 原运行中消息队列

[renderer hook](src/native-input-queue.ts)与 [Main owner](electron/native-input-queue.ts)通过封闭 [队列桥](src/input-queue-bridge.ts)读取当前根 Session 的真实 pending 输入，不将已提交命令伪装成本地数组。`pending_input_queue` capability 与当前 generation／viewSelection／history epoch／Store／Session／Workspace 核实后，Main 穷尽固定 revision 页并保留正文，给 renderer 仅提供当前 observation、可见条目及有限操作。每次完整观察最多4096成员、3MiB文本，超限拒绝而不截断；`result.include` 不作为提示词展示，仍参与后端固定槽与 revision。

同一准确 scope 的普通 View／历史校准保留已观察队列的 DOM 和全文悬浮层，只暂停编辑、删除和调序；重新核实时不靠卸载组件重置展示。真实观察失败仍显示错误并禁写；切换 Store、会话或读取代次不复用旧队列。

[Composer 队列](../../packages/ui/src/desktop/QueuedMessages.tsx)位于输入框同一外框顶部，单行 Markdown 与全文 Tooltip、常显拖柄／编辑／删除、拖拽与 Alt+↑／↓均受宿主控制。编辑先对已观察原 ID 精确 `input.withdraw`，只有核原 Command 的 applied／`input_withdrawn`、target、subject、request digest 和当前 scope 后才返回 Main 保留的原文，填入普通草稿并聚焦；用户自行重新发送，没有特殊编辑态、取消或自动放回。删除同样只撤回 pending 输入；已消费竞争刷新，不取消活动 Run。图片／文件或 extensionInputs／selectedSkills 不能无损转为普通 draft 时禁编辑，附件 only 行用展示占位，保删除和完整集合调序。

[queue journal](electron/native-input-queue-journal.ts)沿 [private-data](electron/private-data.ts)懒迁移 DB11 `input_queue_intents`，保存 Main 分配的原操作 ID、闭合 request、scope、subject、digest 与编辑原文。首次 POST 前持久提交；未知／冷记录只 GET 原 ID，不重发。read 恢复未决元数据和已 applied 未交付编辑，但不自动回填；显式 lookup 核实后返回原文，renderer 成功填入普通输入框后以 `input.queue.ack` 标记交付，之后不再提示或返回旧文。草稿沿原普通编辑／显式保存合同，不将交付 ack 当作草稿已落盘。128行／16MiB局部容量不裁未决或未交付编辑，已交付终态记录有界剪裁。切会话、Store、代次或关闭撤销原读取，晚到结果只记账，不向替换视图回填。

[Main／IPC 回归](test/native-input-queue.test.ts)、[实际 Node journal](test/isolated/native-input-queue-journal.test.ts)与[renderer DOM](test/isolated/native-input-queue-dom.test.tsx)分别覆盖封闭输入、分页 revision、完整原文、未知只查原 ID、ack、附件、防迟到及受控交互；后端消费与持久顺序的实现和测试归 [Store owner](../../packages/agent/src/storage/README.md#待消费输入的撤回与排序)。真实窗口通过[原运行中权限夹具](test/isolated/native-live-permissions-bundle.test.ts)核验，不据 DOM／Node 结果推导窗口或其他平台资格。

取舍和未采用方案见[紧凑审批与队列决定](../../.agents/notes/implemented/feature/2026-10-22-native-approval-input-queue.md)。

直接历史只沿当前已观察 Message 的准确原 Execution 读取；Fork／Include 的封存 `originMessage` 不取得来源 Execution 后来的审批。原外部 Store／恢复边界继续适用。观察是现有响应的可选字段，不改持久格式，不公开私有审查正文或上下文；审批事实也不让未知工具版本进入旧结果分类。具体取舍见[审批观察决定](../../.agents/notes/implemented/architecture/2026-10-09-native-approval-observations.md)。

[Core 授权测试](../../packages/agent/test/isolated/execution/authorization-check.test.ts)、[真实 HTTP／Client](../../tests/isolated/unified-agent/client-interactions.test.ts)、[Main](test/native-tool-messages.test.ts)和[原组件 DOM](test/isolated/native-approval-dom.test.tsx)分别核原授权门禁、公开字段、封存隔离及完整请求与标签；[源码外默认窗口](test/isolated/native-bundle.test.ts)核首次和冷读的原人工审批及已保存标签，[计划窗口](test/isolated/native-plan-review-bundle.test.ts)核独立审批与大请求。实际结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原审批面板与授权观察)。原记录阅读见[交互历史](#原交互记录只读历史)，当前 Store 的 Auto 窗口与原输入区控制见下一节；全部封存／恢复组合及整片独立审查仍待核对，本节不代表完整 PC 退出。

## 原会话输入区权限与停止

普通 [Native 页面](src/native.tsx)不再将 `permission.mode` 的 `saved/submitting` 状态插入 `beforeConversation`；原 [Composer](../../packages/ui/src/desktop/Composer.tsx)通过触发器的切换中标签、`aria-busy` 和禁用状态表达正常提交，避免状态段插入／移除时挤动消息区。`unknown/failed` 的原结果与准确查询入口、项目读取信任申请的原进度、显式测试诊断账本均保留，底层 Command、权限写入及重复提交门禁未改。

`writeInput` 仅为首条发送、已有会话输入和首条重试设置 `sending`，仍委托原 `write` 保持串行及历史准入，并在完成／失败时撤销发送提示。通用 `pending` 继续禁用相关操作，但权限切换、停止、查询和空间操作不会借此替换发送／停止图标。空间行内操作的临时禁用不改变原悬停／聚焦显隐，选择器修复归[共享 UI](../../packages/ui/README.md)。

2026-10-18 Windows x64／Bun 1.4.3，基于 `f734245a` 加当前工作区改动：新增 Native DOM 延迟权限回归先在原实现复现发送按钮 `aria-busy=true`，修复后保原图标、草稿及空间操作节点，禁用点击零额外写入；实际输入、首条发送及重试仍显示发送忙碌。新对话整文件20项／549断言、会话导航10项／302断言、共享页面13项／95断言及 Desktop typecheck 通过。Chrome 155 隔离共享组件夹具在亮暗主题、1240／800／500px 和触屏下验证：原空间隐藏按钮禁用时透明度从0变0.45，修复后仍为0，悬停／聚焦为1，触屏始终为1，所有受测页面几何和滚动不变；500px 未挂载侧栏，不计作侧栏视觉证据。未运行完整安装窗口、其他平台及全量默认测试；原嵌套 `@keyframes` 优化提示保留。

2026-10-18 Windows x64／Bun 1.4.3，基于 `f734245a` 加本轮工作区改动：[Native 新对话整文件](test/isolated/native-new-conversation-dom.test.tsx)19项／518断言通过，新增普通模式五阶段、原 unknown 查询／零重放、失败提示、Store／会话隔离及信任进度保留，并核菜单 mousedown 不再落入输入区空白聚焦。Desktop／UI typecheck 通过。Chrome 155 隔离共享 SessionPage／Composer 布局夹具复现原临时状态段使消息区下移47px；按 Native DOM 已核实的正常状态显隐修正后，1240／800／500px 三宽度的面板、阅读区、输入框几何及手动滚动位置均不变，多行草稿保持、零页面异常。该有限布局证据不代正式安装窗口、全量默认测试或其他平台；原嵌套 `@keyframes` 编译提示保留。

普通 Native 不再挂载独立的项目读取范围确认弹窗。首次与已有会话的明确发送分别由 [NativeConversation](electron/conversation.ts)和 [NativeCaller](electron/native-caller.ts)调用 [prepareWorkspaceAccess](src/controller.ts)，按当前 Session 绑定的项目准备 Workspace Trust，包含宿主声明的额外只读范围。准备保留原 observation、trust revision、目录身份和范围摘要 CAS，以及原权限 journal；未知只查询原申请且零业务提交，切会话／Store／项目或替换观察后不沿旧观察继续。打开会话只读历史及核实执行状态，不自动授予范围；审批模式与工具硬限制独立。诊断 PermissionPanel 的显式信任／撤销入口继续保留。

同一 observation 的并发准备共享原授权和完成后的读取。已有会话发送期间，Main 只将准确原 trust command 的持久通知刷新推迟到准备结束，不让自身成功授权的通知使原输入失效；外来权限通知及导航仍立即使旧观察失效。即使通知已显示 trusted，原授权回执 unknown 时仍须查询原申请，核实不会自动发送。

[新对话 DOM](test/isolated/native-new-conversation-dom.test.tsx)核普通页面不再出现范围确认，权限结果未知仍沿原 ID 查询，切会话保原草稿；[Main 权限回归](test/native-permissions.test.ts)核已有会话准备授权时的未知回执、选择切换和过期观察均不提交工作，另核回执前原通知、并发重复发送、外来权限／读取范围变化，以及已显示 trusted 的 unknown 原申请不能跳过核实。原诊断模式与权限菜单断言保持；[真实窗口](test/isolated/native-human-input-electron.test.ts)核首次输入、正常退出后冷重开和同文独立重交，重开不增加恢复申请、问答或模型调用。当前运行结果见[测试 owner](../../tests/README.md#子-agent-协作-v11-验证)。

[NativeDesktop](src/native.tsx)为已有根会话接入原 [Composer](../../packages/ui/src/desktop/Composer.tsx)的请求批准／自动审核／完全访问菜单和停止按钮。模式沿现有 permission observation 提交，只改当前会话，不改工作区默认；请求批准直接提交 `accept_edits`，不再映射为旧 `ask`。Full 仍须原风险确认，确认绑定当前 generation、Store、Session、阅读选择与 history epoch；取消或切会话后的旧确认没有写入资格。模式选择不启动任务，也不清理原草稿；未读完历史、事实不可用或原权限申请未核实时等待。普通 Composer 的模式选择不以项目已信任为前提，也不自动设置信任或启动 Model；项目授权在明确发送前独立准备。诊断会话工具中的模式表单仍按其显式信任入口控制。原计划窗口按真实信任→Auto 顺序运行，由真实审核返回 `ask_user` 后保独立工具审批；完整审核、Files 与冷读断言保持；准确回归范围见[PC 迁移主线](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)。

普通历史／View 后台刷新只暂停操作，审核标签按 generation、Store、Session 和 Workspace 保留上次已确认模式，不以新的 viewSelection／history epoch 丢弃同会话标签。模式展示使用原有界 `NativeDisplayCache`，最多12项；generation／Store 替换清理，真实权限或后台观察失败撤销当前项。缓存不保存 permission observation、trust 或写资格，未命中时显示明确读取占位。目标选择尚未得到 Main 确认时保留当前草稿并只读，确认后才一次切换到目标缓存草稿，再独立核对持久草稿；原本空草稿的禁用发送、实际发送／停止中与真实失败仍按原事实展示。Native 将普通读取等待交给 Composer 的 `sessionLoading`，已知标签、图标、透明度及悬停保持，权限、模型和执行动作仍沿当前事实准入。[页面 DOM 回归](test/isolated/native-session-navigation-dom.test.tsx)模拟 Main 在普通 View 刷新时暂撤 permissions，核标签、计时和输入节点保留，操作仍禁用，真实失败提示仍出现。

停止沿现有 [NativeCaller](electron/native-caller.ts)保存并提交 `command.cancel`，目标是已核实当前 Store／Session 活动 Run 的 `originCommandId`。它不新增停止端口，也不把申请当成终态；原保存／提交中／未知申请禁止重复，准确结果仍由原 Run 和持久申请核实。只读子详情没有这组控制，切换阅读不停止原工作。

[原页面 DOM](test/isolated/native-new-conversation-dom.test.tsx)核模式、Full 取消／跨会话确认撤销、草稿和零任务提交；[原 Main 权限](test/native-permissions.test.ts)保独立原申请及未知结果。[实际源码外 Auto 窗口](test/isolated/native-auto-approval-bundle.test.ts)经完整候选的默认 Core／Service／Main 和原 Renderer，核批准、拒绝、请求人工、无效审查结果和审批中准确停止。转人工保原原因，只有实际批准产生准确文件效果；拒绝终止原任务，停止后迟到批准没有效果。普通退出后五种原记录完整冷读，Provider 与回答次数保持。该窗口只证明本机 macOS 当前 Store；全部封存／恢复、完整 PC 和独立迁移审查仍开放。实际执行及原失败见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原会话权限停止与自动审批闭环)。共享 Composer、Core／公共 API、SQL 和私有持久格式均未改。

## 输入区上下文占用

[NativeDesktop](src/native.tsx)通过 [useNativeContextUsage](src/native-context-usage.ts)向共享 [Composer](../../packages/ui/src/desktop/Composer.tsx)传只读上下文估算。圆环的比例固定为 totalInputTokens / contextWindowTokens，分母是最近已保存原请求所属冻结模型的完整窗口，不能使用累计缓存率、累计输入或API中扣除输出预留后的 utilization。浮层标明约数，显示上下文已用与总容量；窗口容量未知时显示未知，尚无可用原请求或读取失败时隐藏圆环。输入框旁仍独立显示原累计缓存文字。圆环由共享 Composer 直接渲染为无点击操作的状态图标，保留悬停与键盘聚焦的详情提示。

[Main reader](electron/tool-messages.ts)的 toolMessages.contextUsage沿原有限IPC只接受一个已观察的完整助手Message ID，复用原read lease、关闭与退出释放；核准确当前Store、Session、Run、成功Model Execution、消息正文与来源后，调用现有 getContextEstimate，只回传模型、上下文选择及输入／窗口数字。响应前再核当前View、选择、工作区和原消息；不向Renderer回传上下文正文，不写入、不初始化Provider、不启动模型。这个用户可见的数值展示不开放测试Context面板。API的完整历史预测、实测基线和来源限制归 [Core owner](../../packages/agent/src/context-estimate.README.md)，未发送草稿、重新捕获的项目来源与随后模型／工具配置变化不在该预测内。

Renderer按generation、Store和history epoch清空有界显示缓存，按会话、工作区、context selection保存最多12项，并逐次核对原消息和已选模型；普通读取期间可保留同目标已核实比例，已知模型改变或上下文切换后不沿用原比例。完整消息高水位、原助手消息及阅读身份变化驱动重新估算，普通无关重绘和缓存率变化不触发新读取；迟到响应与失败不发布旧范围，切换、重载和退出取消所属读取。[数值IPC与来源回归](test/native-tool-messages.test.ts)和[占用DOM回归](test/isolated/native-context-usage-dom.test.tsx)分别核只读范围、分母独立、异常计数、迟到取消及显示隔离。

2026-10-20，Windows x64／Bun1.4.3，`5dba8a6b`工作树加本次接线：`bun test --parallel=1 --max-concurrency=1`运行上述数值IPC、占用DOM、原累计缓存DOM与共享页面四个整文件，34项／317断言通过；UI／Desktop类型、15个相关源码／测试的Biome、文档、边界与测试归属检查通过。Chrome155沿实际Composer与Native编译样式核深浅主题各1240／360px四组，覆盖悬停、键盘、Escape、真实零、未知容量及显示独立；另以实际NativeDesktop和明确隔离Main替身核会话切换，缓存70%／30%时圆环分别为68%／20%。未运行本轮安装版IPC窗口或其他平台；前轮已确认的环境停止控件壳层测试既有失败仍不作为本次通过证据。Main数值端口新增后，开发热更新页面不足以加载它，须完全退出并重新启动客户端。

## 原输入区累计缓存命中率

[NativeDesktop](src/native.tsx)通过 [cache metrics adapter](src/native-cache-metrics.ts)给原 [Composer](../../packages/ui/src/desktop/Composer.tsx)传累计缓存用量，以独立文字显示原累计百分比，原生悬停提示保留完整命中／总输入 token；它与上方上下文占用的分子和分母独立，展示实现见 [UI owner](../../packages/ui/README.md)。无样本隐藏行为保持。完整历史读到固定高水位后，按所选会话全部已观察的完整助手消息读取，不限于 View 近200项；真实 cached input为0且input大于0才显示0%，缺缓存字段或总量为0不补造样本。分叉／包含的封存消息保原来源，同一个原 Store／Model Execution只计一次。后台历史／View 校准和新一轮用量读取期间，保留同一阅读范围内、正文与来源仍匹配的已核实样本；新样本整批核实后才更新累计值。原消息改变或移除即剔除对应样本；切换会话只恢复目标会话自己的样本，在新 viewSelection 下仍重新读取。generation、Store 或 history epoch 变化清空旧指标快照。失败保留仍匹配的原样本，可显式重新读取，不启动或重放任务。

[Main reader](electron/tool-messages.ts)沿已有有限IPC增加 `toolMessages.usage`，复用close与所属read lease，每批至多32个已观察 Message ID，从当前生成 Client GET核原 Model Execution／Session／Run、成功结果和准确content，以及前后连接与原消息未变。它只返回已核实的缓存命中／未命中token；整数、非负及cached不大于input分别校验，不将缺失视为0。封存来源读取不可变Model用量，不借来源Run后来状态取得热事实；当前Store保存的旧Store结果另核终态出处，foreign active拒绝。读取失败不发布部分新样本；原历史正文、权限与准确停止继续独立，未新增Core／HTTP／SQL／私有持久格式。

[Main与有限IPC测试](test/native-tool-messages.test.ts)、[原Composer DOM](test/isolated/native-cache-metrics-dom.test.tsx)和原[源码外默认窗口](test/isolated/native-bundle.test.ts)分别负责来源资格、累计／去重／迟到／无样本和默认SDK用量的首次及冷读。实际输入与结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原输入区累计缓存命中率)；累计口径与来源核验保持，完整PC、全部恢复组合、资源退出和全阶段独立审查仍按原计划核对。

## 会话工具栏显示快照

[NativeDisplayCache](src/native-display-cache.ts)仅保留进程内展示数据，每个模型／指标／审核标签缓存至多 12 项、总计 16MiB，单项超过 4MiB 不保留；按访问顺序淘汰，没有隐藏的会话组件或持久存储。模型目录按当前 generation、Store 和配置 revision 隔离，分别保存每个 Session／Workspace 及新对话准备页的已读事实；返回时不先清空标签，后台 GET 完成前模型与发送仍不可用。缓存率按当前 generation、Store、Session、Workspace 和 history epoch 隔离，复用时逐条核当前已读消息的准确内容与来源，去重、真实零和缺样行为保持；读 lease 仍绑定新的 viewSelection，迟到读取不能替换其他会话。

[NativeDesktop](src/native.tsx)在选择交接时先暂停旧历史读取并门禁操作，目标选择确认后一次交接其缓存正文与元数据，避免旧选择配新正文造成工具栏短暂清空。未命中模型展示缓存时，先经原 `input.models.read` 准备该目标的完整目录与持久模型路由，再发布目标页；原模型名和档位直接更新到最终值，不经过“选择模型”占位。`NativeModelSnapshots` 将原有界展示缓存交由导航与 [NativeModelPicker](src/native-model-picker.tsx)共同使用，预算和身份隔离保持；命中目标缓存时不等待额外准备，原 Picker 继续后台核对。冷准备的结果沿 generation／Store／Session／阅读选择／配置 revision 交给原 Picker，消费后不重复 GET；同一路由也按新阅读身份重新发布 ready，不能沿用旧会话发送资格。Main 在本次选择期间暂未发布 selection 时，仅保留旧选择的只读展示，撤销 permissions 并标记 viewLoading／permissionUnavailable；它不能恢复发送、审批或停止资格。目标草稿直接从原独立草稿缓存恢复，不先置空再填回。模型控件在后台核对时保留原 DOM 与文字颜色，弹层随禁用关闭；真实失败保留原错误。准备期间只延后目标 selection 的可见交接，原目录和全局失败仍发布；后台 state 通知和 layout 驱动的历史读取遵循同一准备门禁，不提前启动目标历史。新目标、退出或 generation 变化使旧准备失去发布资格；等待期间观察被撤回时只保留已确认目标的只读身份，最新失效标记胜过旧回执，Store 替换放弃旧准备；模型读取错误由目标 Picker 明确展示，目标历史继续加载，缺失的原路由不静默落到全局默认。这里仅调整 Renderer 的读取／发布顺序，不增加 Main／IPC、Core 或持久协议。

进入安排任务页时丢弃本次导航的模型预读交接，返回会话时重新核对模型目录；原历史校准与未发送草稿保持。[安排任务 DOM](test/isolated/native-scheduled-tasks-dom.test.tsx)核往返读取、原草稿和零额外创建／发送。

[模型 DOM](test/isolated/native-model-picker-dom.test.tsx)、[缓存率 DOM](test/isolated/native-cache-metrics-dom.test.tsx)和[完整会话页 DOM](test/isolated/native-new-conversation-dom.test.tsx)分别核模型与比例不串会话、原节点保留、延迟响应、epoch 失效、容量限制、无选择交接时禁止写入及首条自动进入。

2026-10-19 Windows x64／Bun 1.4.3／Chrome 155，基于 `f734245a` 加本轮工作区改动：原实现用新增冷会话断言复现模型尚未就绪就发布目标页；修复后 `bun test --parallel=1 --max-concurrency=1 ./apps/desktop/test/isolated/native-session-shell-dom.test.tsx ./apps/desktop/test/isolated/native-model-picker-dom.test.tsx` 的18项／238断言通过，覆盖同模型新范围 ready、无重复 GET、后台状态通知、迟到准备、真实错误与准备中的观察撤回。合并后的19个相关整文件共139项／3208断言通过，Desktop typecheck、定向 Biome、文档和边界检查通过。增强的 `bun apps/desktop/test/session-shell-browser-runner.fixture.ts` 在浅／深主题完成冷页长模型名首帧、192帧等待采样和200次暖切换，模型按钮保持原 DOM，模型名／档位与同帧标题一致，无占位带来的中间宽度，业务写入为0。该夹具使用实际 NativeDesktop／CSS 与模拟 Main，浏览器沙箱开启；完整 Electron 安装窗口与真实 IPC 未复验，原嵌套 `@keyframes` 及既有 ToolActivity key 测试提示保留。
## 原交互记录只读历史

原“会话工具”侧栏的“交互记录”由 [NativeInteractionHistory](src/native-interaction-history.tsx)复用 `InteractionCard` 阅读问题、计划审核和普通／MCP 审批，保存答案、取消、当前 revision 与 accepted decision 分开表达。通用 question 保原 schema／JSON 答案，不借默认 `ask_user` 的 q1–q3 解释任意定义。计划的实际修改反馈按原字符串显示；原 PlanBody 提供格式化阅读，完整原附件可另行展开。没有回答回调，待回答记录也只读；当前真正待输入卡和原提交链继续独立。

[Main reader](electron/interaction-history-reads.ts)只从已准入的当前 Store／Session／Workspace 与阅读 generation、viewSelection、historyEpoch 推导范围，经原公共 `listInteractions` 的明确 `origin:'all'` 每页20项读取全部状态，没有累计项数截断。首 snapshotCursor 在每页保持，核原来源／展示关系、ancestry、规范游标、严格 ID 顺序和准确 nextAfterId，真正 EOF 才发布完整记录。分页期间任意 Store 通知水位变化会拒绝拼接，含其他会话或模型输出变化；本会话上次完整记录可保留并明确未更新，用户显式重读。它没有冻结新历史 API，也不承诺连续变化时一次完成。

附件仅从本次已观察卡的准确 key 推导，先经明确 `origin:'all'` 的公共 GET 核原 card／revision，再由原 SDK reader 分别核当前准入和原附件 Store、scope、hash／UTF-8／EOF；[64KiB Native reader](src/native-interaction-attachment.ts)继续核原字节。历史使用独立附件实例和方法，不能进入当前审批的 loaded proof；关闭、刷新、切范围或 detach 释放所属 GET 与正文资格，迟到结果不能替换新范围。此阅读链只有 GET，沿既有公开维护明确恢复；DB／私有格式不变。公共只读 query 增加可选 origin，默认当前查询与回答资格保持。新 Store 的历史卡保原出处，标为“恢复历史，只读”；未完成卡沿实际维护结果显示取消，原请求、答案与 accepted revision 保持。Fork／Include 只读自己的实际记录，不补来源后来的 Interaction。

[Main／分页与附件反例](test/native-interaction-history.test.ts)、[原卡 DOM](test/isolated/native-interaction-history-dom.test.tsx)与[真实 HTTP／Core](../../tests/isolated/unified-agent/client-interactions.test.ts)分别核完整读取、只读／迟到与通用问题／child 来源；原[默认源码外窗口](test/isolated/native-bundle.test.ts)核首次／冷读记录，原[计划窗口](test/isolated/native-plan-review-bundle.test.ts)核历史大附件、准确反馈和零重复提交。准确执行输入、失败与范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原交互记录只读历史)，取舍见[历史阅读决定](../../.agents/notes/implemented/architecture/2026-10-09-native-interaction-history.md)。当前 Store 自动审批的实际窗口范围见[输入区控制](#原会话输入区权限与停止)；完整 PC、全部封存／恢复组合和整片独立审查仍未关闭。

新 Store 完整交互历史的[真实 HTTP／Core／SDK／Main 回归](../../tests/isolated/unified-agent/client-interactions.test.ts)保问题 schema／答案、计划完整内容与修改反馈、child 原审批与 accepted revision、取消和完整大附件，核首次及冷只读、默认当前查询隔离、旧卡回答拒绝、Fork 不补后来记录与零新水位／Model。[现有安装版问答窗口](test/isolated/native-restored-questionnaire-bundle.test.ts)继续沿原 Questionnaire／ToolRow，并从会话工具读取同一份原 Interaction 请求／选项 ID／自由文本对象；实际选项标签仍由原工具回执展示。三个真实 macOS 窗口核源、Fork 空历史、包内 CLI 恢复后的首次与冷读、关闭及三 Service 普通退出／双 EX。原 120／45／10 秒期限和原断言保留，actual0／1pass／24Bun及全部 driver／77.95秒，Provider2、原答案 POST1、恢复阅读 POST0和封存来源 Run GET0。直接七文件33pass／758断言与各 owner／root types通过；准确新增断言失败及未验范围归[恢复历史进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后完整交互历史)。本片没有新的计划／审批 installed 窗口，完整 PC 与阶段退出资格保持。

## Native 项目会话目录

正式目录直接复用 [Sidebar](../../packages/ui/src/desktop/Sidebar.tsx)，替代临时 NativeDirectory。适配器按公共 workspaceId 分组，项目默认展开，可独立收起；空项目显示“暂无聊天”。上下键只移动当前项目列表焦点，确认沿原 Session ID 读取；收起不调用 bridge、不改选或取消工作。首次发送等待不阻止阅读已有会话，原 NativeDesktop 仍保护迟到创建、后来选择和草稿。选择标记核同 Store，目录 Store 更换重置展示。侧栏先显示五项、“展开更多”每次增加十项只是展示完整已读目录，不改变公共分页或高水位。

Workspace/Session 完整目录分别读取；其间新登记的项目可能还未进入项目上界。相应 Session 保留在“项目待读取的会话”，可读原历史，但不提供该未观察项目的新建入口。Session 目录使用公共 `listAllSessionDirectory` 穷尽同一观察，未选中会话也有实际 active／latest Run、排队及同主体当前 Store 的待输入数量。更新时间取原 Core 最后对话消息更新的封存时间，读取、改名和审批模式切换不修改它；未记录或未知格式保持缺席，原 Sidebar 按真实时间排序、悬浮显示本地时间。必需后台结果等待沿原通用活动指示，与人类待输入 Badge 分开。

活动 Run 的公开 `executionOwner` 仍是只读锁观察；[DesktopController](src/controller.ts) 的选中与 [NativeCaller](electron/native-caller.ts) 重连先调用 SDK `reconcileSessionState`，再读取公开历史。后端结算后，主／子轮次、工具及环境卡使用持久终态，不继续显示排队、回复动画或 Stop。原 [目录适配器](src/native-presentation.ts) 的“执行状态待核实”和 `executionUnconfirmed` 只承担失败／证据不足的回退展示；owner 观察只适用于同一个确实 active 的 Run，旧目录不能覆盖当前终态或后来新 Run。目录刷新失败时，同一活动 Run 的缓存观察按待核实展示，不恢复运行标记或停止按钮；后续完整目录确认持有执行权后才恢复。普通事件刷新保持只读；迟到旧选择不能发布，失败保留历史并报告错误。协议归[Core owner](../../packages/agent/src/storage/sqlite/run-resume.README.md#会话恢复时的状态核实)，[真实 Native 交接](test/isolated/native-session-reconciliation.test.ts)经实际 Service／Runtime／SQLite／Client／Controller 核 SIGKILL、冷读与零重放；[导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)核回退和缓存终态。

[Main](electron/native-caller.ts)在 SSE ready／change 后合并刷新全局目录，不逐个读取未选中 view、不取得其他会话执行权；目录读取与当前正文读取分别持有生命周期，慢目录不阻挡阅读。Store／attach generation 与独立读取 epoch 核对迟到结果；断线、reset 或读取失败保上次标题和时间，状态标为“上次确认状态”，连接文字显示“目录状态待核实”，不以旧数量显示当前待输入。detach 只 abort 所属 GET 并清本视图目录，不取消工作。显式刷新仍沿原目录入口，完整成功后才恢复当前状态。项目批量移除的当前范围见下节；单会话执行组的离线清理已接现有维护，安装版常用维护已具本机有限证据，DB8 原代码回退的本机边界已由[安装版窗口](docs/native-release.md#真实代码升级与冷回退)核对，其余维护恢复和剩余旧页面行为仍未闭合。

[目录 DOM](test/native-directory.test.tsx)与[草稿 DOM](test/isolated/native-drafts-dom.test.tsx)已直接核已有 Sidebar/实际 NativeDesktop：同名会话准确项目/原 ID、空项目、独立折叠零写、项目列表焦点零选择、创建期间阅读、晚项目保留与迟到创建保后来选择/草稿。新目录 DOM 另核真实时间排序、5/+10 展示、全局待输入／required 等待和旧事实保留；Main 有限 port 核第201项之后的非选中变化、失败保目录、慢读取不挡选择及 detach 迟到拒绝。源码外默认 macOS [窗口](test/isolated/native-bundle.test.ts)实际核审批期间切到另一会话、原目录 Badge／准确 Run／时间／排序、原卡返回、Provider 不增加与冷时间保留。具体输入和结果归[本片进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-全局会话状态与时间排序)，不以有限 DOM 宣称完整 installed/跨平台资格。

Main 对目录与所选会话分别保留一个在途读取和一个后继通知位，读取结束后合并100ms内的连续变化；所选会话的后继读取不再额外刷新目录。显式选择与原命令操作不等待该合并窗口，慢目录仍不阻塞所选会话。reset 后先读原事实与历史，ready 高水位等于该 baseline 时不重复读取，也不将 snapshot 当作已应用事件游标。同一阅读范围的历史刷新保留原消息组件和已展开全文，真实 attach／选择／history epoch 变化才释放原全文状态；加载中写资格仍按原门禁撤除。取舍见[刷新修复](../../.agents/notes/implemented/bug-fix/2026-10-08-native-observation-output-refresh.md)，原17MiB管理窗口与直接回归结果见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-大输出刷新与全文保留)。

## Native 空间批量移除

普通客户端不显示移除的在途过程段落：本地忙碌状态与持久申请的 `submitting` 投影均不向 `SessionPage.notices` 插入文字，原操作禁用、原生确认和目录更新保留。`unknown`／`failed` 及无法核实结果继续显示必要提示；“查看结果”只查原申请，不重新提交。[Native DOM 回归](test/isolated/native-new-conversation-dom.test.tsx)覆盖等待／刷新期间无额外提示、输入节点与草稿保持、原 ID 查询、成功目录更新及失败边界。

原 [Sidebar](../../packages/ui/src/desktop/Sidebar.tsx) 的空间行将移除入口收进更多菜单，新对话与更多图标均为14px并沿原悬浮／键盘焦点显示；选择“移除空间”才调用原回调。[Main](electron/main.ts) 显示原生确认，默认和取消均为「保留空间」。renderer 只传当前目录的 Workspace ID；[Main port](electron/workspace-removal.ts) 固定实际 generation／Store／subject，在确认后重新核原 Workspace 名称与根，再将完整原申请先存入 Node 私有库并仅 POST 一次。当前选中目标移除成功才清其阅读页，其他空间的选择和草稿保持。重新添加同一目录创建新 Workspace 身份，原目录文件不删除。

[Store 批量事务](../../packages/agent/src/storage/sqlite/workspace-removal.ts) 一次保存全部根及子 Session tombstone、停止边界和原 Workspace receipt，目录同时隐藏；它不逐条等待，不冒充资源停止。回复丢失／不可信则保存 unknown，重开只展示原申请，明确点击「查看结果」才用原 Store／Workspace／Command GET；其他 Store／主体在 HTTP 前拒绝，不改绑、不自动再提交。可信 4xx 显示未移除。目录状态未核实或私有申请不能保存时拒绝新移除。

首次保存移除申请在同一 FULL 事务惰性增加 `workspace_removal_intents`，私有 `user_version` 从 DB7 升至 DB8；没有移除申请的旧流程继续 DB7。闭合原申请最多128项／256KiB，只允许 submitting→unknown，不保存重发资格或当前路径。离线维护的 DB8／manifest v17 字节范围由 [maintenance owner](../../packages/agent/src/maintenance/README.md#desktop-db8-与-manifest-v17)负责。

产品手册要求永久删除相关历史；移除受理先隐藏目录、封锁新工作和请求取消。确认框说明退出客户端后的显式离线维护：[GC](../../packages/agent/src/maintenance/README.md#显式无引用附件-gc)在宽限和全部任务终态满足后清除该Workspace历史正文；活动、未知或待核对工作保留完整证据。原删除边界、去重摘要／回执和未发送草稿保留，原receipt不变。准确旧Session的 `historyPurgedAt` 由Core标记经生成DTO进入[原SessionPage状态槽位](src/native.tsx)，不会以空列表冒充历史完整。原「删除当前会话」入口说明同一离线维护也可清理单会话执行组；活动／未知／待核对工作及存活Fork或其他未清理会话依赖的来源保留。来源tombstone不撤回存活Fork已封存的只读历史资格，仍不继承执行权。安装版常用维护的有限链已验证；DB8 原代码回退的有限范围见[Native release owner](docs/native-release.md#真实代码升级与冷回退)；全部维护恢复和完整产品资格仍待闭合。

[有限 port 测试](test/native-workspace-removal.test.ts)核默认保留、先存后发、丢回复与冷 GET-only、异 Store HTTP零和闭合输入。[原源码外窗口](test/isolated/native-background-bundle.test.ts)沿真实 Main／Service／Node SQLite／原侧栏验证取消零 POST、提交后丢回复、冷查询、目录移除、同目录新身份和文件原字节；原生确认由测试回调控制，其选项仍来自生产调用，不声称人工点击 OS 弹窗。

## Native 新对话准备与首次发送

已有会话的提示词由 [NativeDesktop](src/native.tsx)按Store／Session保存窗口内草稿；编辑事件同步更新缓存，主动清空也形成一份明确的空草稿。`draft.read`只在没有较新本地内容时恢复已保存正文，离开会话不以尚未提交到React的旧值覆盖缓存。提交冻结本次草稿对象；准确的accepted／applied／terminal回执仅清除仍指向该对象的原会话草稿，即使已切到其他会话也清除，后续编辑和其他会话保持。后续Main状态与原查询返回的input／caller受理元数据也按原Command／Store／Session定位提交对象，覆盖直接响应未知或迟到的情况。submitting、unknown、failed和rejected不清正文。首次提交、重试和原lookup沿同一对象核对，准备页另按本地编辑修订保护主动清空。[实际DOM回归](test/isolated/native-new-conversation-dom.test.tsx)覆盖迟到冷读、空草稿、切走／切回后的回执、未知转受理，以及后续输入与主动清空的保留；共享Composer／Lexical仍只接收Markdown值与onChange。

[Main私有库](electron/private-data.ts)在保存准确accepted／applied原回执的同一个FULL事务内清除对应已保存提示词；必须同时匹配草稿ID、修订、Store／Workspace／Session、原正文及摘要，清空后递增修订，后续保存的相同文本也不会被旧回执消费。`read`恢复旧版本遗留草稿时只核本地已确认原记录并修复准确匹配项；结果未知、拒绝、无关联凭据或较新修订保留。读取历史不会为此查询或重发Command，数据库schema、原Command和IPC请求格式保持。选中草稿的读取回复可附带本进程已提交消费的原Command／修订凭据；凭据仅在事务成功提交后记录，最多保留128项，只适用于当前准确的空正文后继修订。任何成功保存均使其失效，不进入列表、按ID读取或保存回复，也不持久化；冷重开沿普通读取取得实际修订。[真实Node私有库回归](test/isolated/native-prompt-draft-store.test.ts)核受理／应用后冷读为空、未知／拒绝保留、遗留记录修复一次、新修订保留与事务失败整体回滚；新数据库及同窗口延迟确认回归在修复前均失败，修复后通过。此前只清窗口缓存的验证未覆盖发送已保存草稿后的冷启动，不能作为本地库清除的证据。

2026-10-20补充Windows x64／Bun1.4.3／Node24.15.0／Electron44.3.0验证：上述私有库、实际Native DOM、Main caller和input共5文件57项／1110断言通过，Desktop类型和Biome通过。真实普通renderer、Main及Service在同一隔离Profile连续运行3次、完整冷重启2次，12个UI检查点通过：首次发送后冷进入为空、已有会话发送已保存草稿后冷进入为空、真实受理通知先于延迟IPC回执时切走再返回为空、未发送保存草稿在冷启动后保留。2次明确输入提交、3次本地Model请求，各轮正常退出0，最后记录的5个所属进程全部退出。只读SQL对照确认旧实现的accepted原文仍为修订1，修复后两份已发送草稿为空且修订为2，未发送草稿保持原修订与正文；证据在 `.cache/native-prompt-client-2944b5a2-1af1-47a4-affa-bd2c68946f22/`。本轮不提供安装包或跨平台资格，主进程修复需要完全退出客户端后重新启动。

[Windows真实窗口夹具](test/native-prompt-client.fixture.ts)执行 `bun run apps/desktop/test/native-prompt-client.fixture.ts`，独立构建当前Main／preload／生产renderer和Service，关闭测试诊断，使用私有临时Profile、合成项目、预置草稿与本地固定模型；随后用原生鼠标／键盘操作窗口。仅该测试Main包装器可在真实IPC校验完成后延迟 `draft.read` 或 `submit` 回执，私有 `control.json` 的一次屏障与退出端口用于人工竞争条件验证，不进入普通客户端。2026-10-20本任务工作树在Windows x64／Bun1.4.3／Electron44.3.0实际验证3个会话、11次选择、15个输入值检查点：独立草稿恢复、发送后切走再返回、较新输入／主动清空抵抗迟到旧草稿均通过；准确输入只提交一次，本地Model一次并显示完整回复。测试窗口正常退出0，已记录的Main与所属Service PID均消失。UI检查、IPC／模型事件和退出记录保存在 `.cache/native-prompt-client-*/`；受限进程首次启动退出3，允许桌面程序的本机进程环境复验通过。该证据覆盖当前文本草稿链，不代替安装包、多平台或冷重启未保存草稿的承诺。

首次发送保存空 title，标明需要[共享 AI 命名](../../docs/handbook/features/sessions.md#自动命名)；“新对话”只由 [native-presentation](src/native-presentation.ts)与页面标题作空名称占位，不作为明确名称阻止自动生成。命名完成继续沿原 SSE／目录／选择刷新显示。显式命名、定时任务名称和原创建意图的未知查回保持原输入；[准备页 DOM 回归](test/isolated/native-new-conversation-dom.test.tsx)核首次创建的未命名标记及原草稿／迟到选择，[目录回归](test/native-directory.test.tsx)核空名称占位。

[NativeDesktop](src/native.tsx)直接消费原 SessionPage 的欢迎标题、项目／分支菜单与 Composer，不展示任务建议卡片。全局及项目新对话入口只进入准备页，不创建空 Session；用户直接编辑草稿。准备草稿和已有 Session 未保存草稿分别保留，页面、项目及分支选择不清空原文。实际模型目录由 [NativeModelPicker](src/native-model-picker.tsx)经独立只读 `conversation.models.read` 读取全局配置。普通客户端读取期间只将原模型选择区标为 `aria-busy` 并禁用模型／发送操作，不在工具栏插入加载段落，避免会话切到准备页后先增高再收缩；输入与独立草稿保留，真实目录失败仍显示原错误。选择项目只读取其分支，不重挂目录或改变全局默认，首次发送仍核所选项目实际配置和支持档位。原 Full 风险确认保留；本次权限选择在创建原 Session 后、首条输入前应用，不写项目默认。

全局“新对话”按当前目录顺序默认选择第一个已登记空间，空间行内入口仍使用明确的空间ID；点击时直接用当前目录确认的目标ID更新项目展示与空间高亮，不先清成未选状态；同一空间重进保留已有分支展示节点，切换目标才清除旧分支事实。切入准备仍重置用户上次选择的分支，再沿原 `chooseWorkspace` 读取真实分支，读取期间不能发送；首条发送还要求分支事实匹配当前Store与空间。当前读取失败会撤销旧分支事实，保留目标项目名及草稿，重新点击入口核实成功后才恢复发送；过期请求不清后来目标的分支事实。无当前会话的启动准备从本次完整目录的首项初始化，使用已读目录事实，避免闭包尚未更新导致默认选择遗漏；页面意图变化后不再应用旧的初始化选择。没有空间时保持未选与可编辑草稿，发送禁用。普通目录刷新不覆盖当前手动选择，重新从全局入口进入才按最新顺序重置。2026-10-19 Windows／Bun1.4.3、`f734245a`加当前改动：三项新增实际Native DOM回归在原实现均失败，修复后通过，核目录延迟、首项重排、空目录、显式入口、手动选择、迟到分支与首次发送的准确空间；连同新对话及启动两个整文件27项／700断言、Desktop类型检查和Biome通过。此为实际组件DOM证据，未复验完整安装窗口。

[NativeConversation](electron/conversation.ts)负责有限编排，复用原 NativeCaller 创建意图、私有草稿、permission controller、caller journal 和 DesktopInput。发送前冻结创建五元身份、输入 Command、原文、模型／effort、Plan 与权限；先保存未来原 Session 的准确草稿，再执行原创建。准备的权限 controller 与正在阅读的选择分别持有观察，迟到结果不抢回后来页面。首次明确发送时按原 Session 绑定的项目与宿主读取范围准备授权，不追加独立范围确认；准备失败保留 Session 和原文，未知回执不继续输入，沿原权限申请查询。

原 [Git leaf](electron/git.ts)从 kite-desktop 迁入，保原分支与工作区语义，并使用上文的所属 helper 退出收束。Main 从同代次／Store 完整目录中的已登记 Workspace 解出规范路径；renderer 只能传 ID，分支结果没有路径或控制句柄。普通目录、缺 Git 的读取均可准备；只有显式选择另一分支才在首次创建前切换。实际根、HEAD、本地分支、脏文件与全部活动 Run／Job 均重新核对；Profile 和 Native／Terminal 制品根及其交叠目录不可切换。目标已与当前分支相同不执行切换，未显式选分支时使用发送时的真实环境。Service 按新 Run 读取／冻结项目配置，不沿旧单项目拓扑关闭或重启 Service。

首次发送立即清空准备输入并显示原首条消息，创建成功后自动进入同一会话；正常过程不显示“正在发送／已提交／请打开本次会话”等额外提示，也不增加手动打开步骤。首条消息沿未来原 Store／Session 的同一阅读 key 保持，选择与历史读取期间不切到加载页或欢迎页。真实消息按原 Command，或 `sourceIds` 加同 Store／Session 的实际 Run 原 Command 证明接管，避免重复展示；不按相同文本猜配，原 Store 的等待项不进入新 Store。发送后切到安排任务等页面时，迟到成功保留当前页面；用户返回时直接读取原 Session，返回时仍在创建则在原回执到达后自动进入。自动进入只跟随当前页面意图，后来的会话或页面选择会撤销旧意图。创建后权限或输入失败保留准确 Session 和原文，明确重试只用原创建身份、新输入意图。结果未知停用重复发送，「查询原首次提交」只核原创建／权限／输入；核实预备步骤成功后仍须明确发送，不自动续写。冷创建与持久原命令只具原 GET 资格，不恢复热首次写入权限。空间、Git、分支和命令错误沿现行手册的 shadcn AlertDialog 单次确认；刷新及 SSE 不提前清除它。私有 SQLite 格式与公开 HTTP API 未扩展。

[Main 测试](test/native-conversation.test.ts)核准确原文保存、独立阅读选择、冷原 GET、权限失败／未知及真实 Git 切换守卫；[实际准备页 DOM](test/isolated/native-new-conversation-dom.test.tsx)核欢迎区与选择器、草稿、晚结果、同会话重试与实际消息接管。源码外 [默认候选窗口](test/isolated/native-bundle.test.ts)、[冷草稿窗口](test/isolated/native-drafts-electron.test.ts)和[Provider 窗口](test/isolated/native-provider-bundle.test.ts)覆盖受影响正式入口；准确输入、已执行结果及未验范围归[本片进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-新对话准备与首次发送)。

原输入 `accepted` 后仍观察同一 Command 的最终应用状态，不能仅凭 HTTP 受理显示为已启动。异步准备拒绝沿原 ID 只读收敛，失败跟随原用户消息；无 Run、没有对应新 Message 的冷 Session 也显示轻量“回复失败”，已有成功历史不会遮掉新失败，不退回欢迎页、不补造原消息。无消息可关联时固定当前完整历史后的展示位置，后续明确新输入成功后旧失败不漂移，Store/Session 切换保持准确归属。已有草稿的恢复受原提交对象和后续编辑修订约束；未知不重放，明确重新发送才创建新输入意图。此分支及首条占位／历史接管由[输入 owner](src/input.README.md)与原准备页 DOM 整文件验证。

2026-10-24 在本机 macOS arm64／Bun1.4.2／Electron44.3.0，以当前开发 checkout、普通 Native（测试诊断关闭）、原实际 Profile 和本机 Codex `gpt-6.1-sol` 完成真实发送：新建与同会话后续各一条，均保存完整回复，两个 Run completed、两条用户消息／两条助手消息、零 Tool 调用。首条／后续状态与历史接管持续观察；完全退出重开后能读取两份完整正文，切换返回的210帧保留消息顺序、空输入和无欢迎页回闪。Core 原命令数仍为8，重开及查询零新增命令，原两份启动失败记录没有重放。普通界面同步采用简洁的回复预览／全文文案，原因码仅留测试诊断。证据在 `.cache/native-conversation-live-20261024/`；此为当前 macOS 开发客户端及真实账户链路，不代替安装包或跨平台资格。

同日本次 review 以合成 HOME、独立 Profile 和 Electron 数据目录，启动普通 development Main、真实配套 Service 与生产 renderer（`testDiagnostics:false`），通过本机无认证 SSE 核实已有成功历史后的准备拒绝。原 Command 经 unknown／accepted／rejected 收敛，拒绝不新增 Run／Message；完全退出重开后保留旧回复和失败，原 caller 数与模型请求数不增，之后明确新发送成功，顺序保持 user→assistant→failure→user→assistant。首窗110帧与重开745帧中，冷历史和后续发送均无欢迎页回闪、重复或旧失败漂移，输入最终为空。原驱动因合成端点把附加 runtime-state 当作用户文本、返回相同回复而等待另一字符串超时；失败日志完整保留，独立只读 Core 和原过程帧核实两个 completed Run、两条真实用户消息和稳定展示，不能称原驱动全绿。准确边界与原 trace 归 `.cache/codex-review-20261024/cold-recovery-live/behavior-verification.json`；没有读取真实认证或改动原用户 Profile。

## Native 安排任务草稿

安排任务现已接入本地持久化与调度，不再只是草稿占位。操作与运行边界见[Desktop 手册](../../docs/handbook/clients/desktop/README.md)。[共享 UI](../../packages/ui/src/desktop/ScheduledTasks.tsx)负责异步表单、编辑、启禁、运行、删除确认和历史入口；[页面桥](src/native-scheduled-tasks.ts)沿封闭 IPC 读取事实，不改变当前会话，明确打开结果才导航。失败保留输入，打开不存在的结果会话失败仍保留任务页。

[调度器](electron/scheduled-task-runner.ts)通过公共 `readOrdinaryCommandApplication` 核原公开 run.start 申请、派生业务 Command 与实际 Run 的准确保存关系，再沿实际 rootWork 核后台效果和子轮。原申请 accepted 不证明业务完成，解释轮不当成已完成排程；缺关系保持待核实。原 detached child／unknown 效果及 after-turn 报告均继续阻止下一次排程。[实际 Runtime/HTTP 回归](test/scheduled-task-runner.test.ts)26项通过，报告夹具使用当前六工具 prompt 合同。

[存储](electron/scheduled-tasks.ts)在原 desktop-private/data.sqlite 首次保存时惰性迁移 DB10，使用两张小表保存任务与冻结运行快照，不改变 Agent baseline/schema。任务最多128个、聚合1MiB；运行最多10000条、32MiB，新 claim 为仍活动记录的现有可变字段保留增长预算，update 在同一事务校验完整候选，容量不足明确报错并保持原字节，不自动淘汰历史。旧合法或略超总容量的运行仍可按严格逐行格式只读展示，容量不伪装成结构损坏；用户明确删除带可信结算标识的任务时只验证目标历史，不被其他任务的总容量挡住。旧满库若同一任务仍有无法写入新事实的活动记录或无空间补写验证标识的旧终态，仍需明确清理或迁移，不能自动判作终态或删除未知效果。IANA 本地时间按每天／工作日／每周解析，DST gap 跳过、overlap只取第一刻；原子 claim 消费已错过的最近一次，同任务、同 Store 绑定不重叠；新 claim 身份包含 Store，旧 Store 的运行保留只读，不阻止明确重新绑定后的新运行。用户明确确认删除时沿原语义移除任务定义及本地运行摘要（含旧 Store 摘要），原 Service 运行会话仍保留；这不取消或重放外部效果。稳定 occurrence、Session、创建和启动 Command 身份均在效果前保存。最近 IPC 仅传轻量运行摘要（全局128、单任务20），不重复传 prompt 快照；按实际序列化UTF8字节保留完整记录至3MiB，满足4MiB响应边界。

[Main](electron/main.ts)持有单个[运行器](electron/scheduled-task-runner.ts)，可注入时钟；关闭窗口不停止，退出／开发重载在关闭 Service 前停止新调度并等待已有提交回执。执行沿普通 AgentClient createSession 和 run.start，使用用户全局模型配置及真实项目。每次独立 Session，不选择或引导当前会话，不建另一套模型执行器。运行状态来自原 Command／Run；`human_work_deferred` 只结束技术 Run，不证明原定时业务完成，沿 CLI 的保守语义保 unknown，不发布结算证明或放行下一次运行。前台 Run 终态前后还核实准确原 Session／root work 的全部未结算 Tool、后台目录和子会话，未知效果保 unknown、未结束工作保 waiting，读取不完整保守阻止后继。after-turn 原报告待处理时继续等待；背景目录先读，再核原根／已关联 child Session 内所有活动 Run，覆盖报告已受理而尚无 Model 的窗口。这会保守等待同 Session 的其他活动轮次，其他根工作中的 unknown 仍按准确 root work 隔离。等待审批在原会话处理。退出／重载先等待 opening 确认结束，再停止并排空调度器；opening 的两处异步准入同时核退出和重载门禁。Main caller 关闭须等设置队列结算，手动立即运行的历史核对也计入调度器 stop，随后才关闭私有库和 Service。结算证明以有限 `settlementVersion` 保存；旧版未带证明的同任务、同 Store 终态也阻止新派发，不能由较新正常终态掩盖。到点或立即运行前只读核实所属原记录，全局每轮最多核实4条，核实未完不消费下一计划时间；未知、缺原事实或容量不足仍保守阻挡，不自动重放或伪造证明。未知、冷恢复仅 GET 原请求，不能恢复热 POST 权利。原申请缺失时保持 unknown并阻止下一次发生。恢复为新 Store 不 retag 原任务，自动／手动运行均拒绝旧身份；明确编辑保存后仅新绑定获得运行资格，旧运行字节不重写。保存、启禁和删除进入同一 Main 设置队列，IPC 明确区分 create 与 update：新增保留 renderer 按 Store 绑定的重试 ID，同 Store 重连或设置刷新继续复用，切 Store 不沿用；同 ID 相同输入幂等，冲突输入拒绝；编辑在异步目录校验前后核原任务仍存在，本连接已删除 ID 不能被迟到创建或编辑复活。设置保存确认后，安排任务模型目录沿同一设置修订重新读取，旧目录在重读期间不可选择。

[Main 生命周期隔离测试](test/isolated/native-main-scheduling-lifecycle.test.ts)运行真实 Main 模块与调度器、有限宿主端口和 SQLite，核 opening／重载交叠及创建回执排空次序；它不代证真实 Electron 或原生进程退出。[存储与时区测试](test/isolated/scheduled-tasks.test.ts)、[实际固定模型 Service 与审批测试](test/scheduled-task-runner.test.ts)、[IPC](test/native-scheduled-ipc.test.ts)、[页面导航](test/isolated/native-scheduled-tasks-dom.test.tsx)、[hook](test/isolated/native-scheduled-hook-dom.test.tsx)和[共享 DOM](../../packages/ui/test/isolated/scheduled-tasks.test.tsx)覆盖对应断言；[DB10实际备份恢复](../../packages/agent/test/isolated/maintenance/desktop-schedules-profile.test.ts)核旧字节、恢复 Store 与零重放。实现决策见[Note](../../.agents/notes/implemented/architecture/2026-10-15-desktop-local-scheduled-tasks.md)。这些证据不授予 macOS／Windows 发布或安装资格。

## Native 当前会话环境信息与子详情

[引导交接组合回归](test/isolated/native-new-conversation-dom.test.tsx)通过真实 Composer、DesktopInput、回环 HTTP、SQLite 和 Runtime／固定 Adapter，核引导 POST 已落库但回执丢失后，切到另一会话编辑草稿，再重连仅查询原 Command；原输入只出现一次、下一模型请求原文和来源各一次，另一草稿保持。另核提交与原 Turn 完成的两个顺序：受理归原 Run，目标先结束则保留草稿，不自动改成后续输入。[阅读回归](../../packages/ui/test/isolated/desktop-conversation-scroll.test.tsx)在受控 DOM 几何下核离底选区、sending→saved、增量回复、终态折叠和回会话的锚点／展开状态；这类确定性证据不冒称完整 Electron 视口资格。

[子结果消息](src/native-presentation.ts)直接消费公开 `Message.agentResult`，由 [transcript](src/native-transcript.ts)保留原 Source ID／顺序并交给共享 Conversation 的独立消息边界。Store 只为原父 Turn 已结束、准确 report 实际创建后续 Run 的子结果投影该 DTO；active 原轮接纳继续沿普通工具和处理过程，终态和冷读都不补气泡。客户端不根据当前 Run 是否活动猜接纳时机，因此刚由结果唤起、仍执行中的续 Run 已能显示对应消息。消息复用普通输入气泡和同一个 MessageItem，头部为“〔名称〕Agent 发送”，正文使用原 Markdown。失败／取消／未知保真实结果，大正文按 `contentComplete:false` 明示尚未完整展示。[Native 入口](src/native.tsx)按准确 child Session／carrier 打开已有详情 reader，不从后来最新任务猜目标。冷历史重新投影不新增结果或模型调用，内部 Model 无该 DTO。来源证明和模型只接收一次结果归 [Store owner](../../packages/agent/src/storage/README.md#人类工作与完成报告事务)，分组回归归 [transcript DOM](test/isolated/native-transcript-dom.test.tsx)，实际窗口沿[协作夹具](test/isolated/native-collaboration-bundle.test.ts)。

2026-10-23，`8a8458800` 加工作树 diff，macOS arm64／Bun 1.4.2，以[真实收件窗口 runner](../../tests/e2e/live/model/collaboration-unified-native-window.live.ts) 的独立 `--final-results-only` 范围重验正常最终结果流程 **passed**。子任务只读一次后直接最终回复，原消息工具仍可用，实际零 `task.message`、零 `agent.message` Command、零普通邮件；没有注入用户引导或压缩。普通 `testDiagnostics:false` 候选沿 UI 选择完全访问，默认 `deepseek-v4-flash`／chat-completions／medium／4096 的 10 次实际 HTTP 全部 200。父 Turn 活动时结果进入原 Run 的后继实际模型请求，仅一份完整低信任正文与准确 Source；一段处理过程内的等待工具显示真实 completed 事件，准确子详情全文可读，终态及冷开均无独立结果气泡。父原 Turn 正常结束后，原结果经当前资格和授权仅创建一轮续跑；父续跑回复尚未交付时，原发送者和完整结果气泡已经显示，续跑后父中文回复带真实材料核验码。两会话冷开零新增 Provider／Run／Execution／Command／Source／control，原创建工具行在子完成前后保持静态，窗口正常退出。

该次报告为 `dist/acceptance/final-result-only-native-window-20261023-c4b872a1.json`；同名 `.workspace` 保留原 Store、canonical Model input/output、实际 Provider 输入、16 张阶段／输入截图与115帧。`03-idle-result-before-parent-reply.png` 覆盖先展示消息再回复，`07-active-received-in-process.png` 与 `08-active-child-result-detail.png` 覆盖原轮完成事件和完整子正文，`10-cold-idle.png`／`11-cold-active.png` 核冷开。该范围的运行中截图没有普通邮件“Agent 发送”段落；较早混合测试主动要求的普通邮件仍有独立回归，不以两种来源互相代证。证据限该本机普通候选、已配置真实模型及隔离只读任务／Full 模式，不外推默认审批、其他平台或安装发布资格。

同日，引导交错范围 `dist/acceptance/steering-boundaries-native-window-20261023-a214cf06.json` 通过：macOS arm64／Bun 1.4.2／Electron 44.3.0，`8a8458800` 加本任务工作树，4599 个非 Markdown 文件 SHA-256 为 `9750a9e28f0063a0532887cb8d99eba2df13a7b17fab6555f1fe4de2da7c258f`。普通关闭诊断的候选、原默认 `deepseek-v4-flash`／chat-completions／medium／4096，14 次真实 HTTP 均 200。active 的三波 Composer 引导分别在子最终结果待接纳、实际正文首字已显示、实际自动摘要进行时提交；首摘要成功但未发布，接纳第三条后新的真实摘要发布，实际后继 Provider 同时收到三条原正文各一次，最终仅采用 Purple 并保留六项实际核验码，父大材料只读取一次。SSE 原始与转发字节 SHA 相同；原 Run、单处理过程、无普通邮件／独立结果气泡。最终仅一条“用时54秒”，收起隐藏引导，依次展开三条完整正文后可再次收起；idle 仍核准确子结果先于父续跑回复可见。两个会话冷开零新增 Provider／Run／Execution／Command／Source／control，正常退出无所属进程残留。

同名 `.workspace` 保留28张阶段图、440帧、压缩与原创建工具行的 DOM／几何采样、canonical Store／Model 和实际 Provider 输入。`boundary-04-first-real-content-visible.png`、`boundary-3-guide-accepted.png`、`boundary-06-stale-summary-refused-new-summary.png`、`boundary-06-summary-time-correction-received.png` 分别覆盖首字、摘要中排队、旧摘要未发布和新摘要完成；`boundary-07-terminal-steer-*` 与 `11-cold-active.png` 核完整终态交接。此前 `7d1c45b0` 真实失败暴露首字已到 Adapter 而 partial 未及时更新，Core 已修并补暂停切点回归；`9e85ad31`、`d6fa10e2`、`e143e71c`、`b7bc0d63` 分别保留夹具选择器、Markdown 可见文本比较、私有 Node 模块定位及原文占位定位的失败，不改写为成功。修正只作用私有夹具，原请求预算和产品来源／权限门禁保持。Core／恢复／附件／多层 Agent／Native／共享阅读状态20整文件188项4807断言，以及审批／完成边界2整文件28项307断言均通过；八 workspace typecheck 通过。SIGKILL、迟到审批、响应丢失切会话、205条长引导和附件等为真实 Runtime／SQLite／本地 HTTP 或 DOM 受控组合回归，不声称都已跑付费模型／完整 OS 窗口；该真实窗口仍仅取得本机只读 Full 场景资格。

该次真实回复将与引导一同检查点接纳的独立子结果称作“引导一附带的后台执行结果”，自然语言来源描述不够准确。实际 Command／Message、独立结果 Source 和完整低信任 Model wrapper 均核原出处，用户引导与结果未合并或借权；这项措辞限制不应被机械 passed 掩盖。最终事实、次数与权限语义按上述独立证据核验。

逐帧另核三次本地占位到持久消息均唯一、原序且位于原处理过程；新摘要 running→completed 保持同 node、32px高度、y与scrollTop，没有短暂缺行或状态回退。本地扁平文本转为持久 Markdown 段落时，引导卡片高度会变化，不能把该次证据表述为所有接管零重排；终态展开核验的滚动与脚本点击／`scrollIntoViewIfNeeded` 对应。任意离底阅读位置与文本选择由共享 Conversation 的受控 DOM 回归证明，不冒充该真实窗口已遍历所有阅读位置。

2026-10-23，macOS arm64／Bun 1.4.2，`45b8275c1` 加本次 diff：上述源码外协作窗口 1 项／55 条 Bun 断言通过，23 次受控 Provider 请求。父原轮结束、结果创建续 Run 后，在续跑模型仍被夹具阻挡时已显示“CHILD_A Agent 发送”及实际正文；气泡与普通输入的背景、圆角、内距、宽度约束和字号相同，可打开准确详情。释放后核原父回复→子消息→继续父回复的顺序；同一 child Session 第二份符合条件的结果独立保留。另让第三份结果在原父轮活动中完成并接纳，核准确 active 回执、原 Run 身份、处理过程的完成事件与子详情实际正文；该结果在父轮活动、结束、冷重开后均无独立气泡，原两条消息各保留一次。冷 Store 核 carrier、child Run 与显示记录一致，冷重开零新增 Provider 调用，所属进程正常退出。82 帧过程及原回执保存在 `dist/acceptance/child-result-message-90648dcb-a209-49a7-9a4a-981d1b7ddc3d`，核对了接纳、查看子结果、父轮完成和冷重开之间的过程帧。Core 两整文件 14 项／278 断言、transcript／缓存／滚动三整文件 18 项／1260 断言、八 workspace typecheck 及最新 Desktop typecheck 通过；同一活动 Run 分段后的最终回复和整轮耗时只显示一次。Service 响应组装和公共 DTO 未受此次显示资格修正影响，复用此前 Service 响应 5 项／13 断言。此证据限本机隔离 Profile 与受控 Provider，不代表真实付费模型、其他平台或完整发布资格。

2026-10-23，统一邮箱接收实施后的 `87944be7f` 工作树，macOS arm64／Bun 1.4.2 再跑同一源码外 Electron 协作整例：1 项／55 断言、23 次受控 Provider 请求通过，冷重开零新增请求。过程核对涵盖父轮结束后结果先于续跑回复可见、活动父轮从邮箱接收后仍无独立气泡，以及父轮完成与重开不补发；DOM／消息响应三整文件另 18 项／299 断言通过。89 帧过程、截图与原回执保存在 `dist/acceptance/child-result-message-3f7ee2e7-7605-46be-8b29-0f394b667153`。本次没有改变消息组件，接收、Source 去重与权限回归由 [Store owner](../../packages/agent/src/storage/README.md#统一消息接收)维护；仍不外推付费 Provider、其他平台或安装发布资格。

同日，以[真实收件窗口 runner](../../tests/e2e/live/model/collaboration-unified-native-window.live.ts)构建普通 `testDiagnostics:false` 候选，实际默认模型 `deepseek-v4-flash`／chat-completions／medium／4096，普通 UI 选择完全访问，隔离工具仅文件读取和 Agent 工具。12 次真实 HTTP 200 完成 idle／active 两条时序和两会话冷重开，11 张阶段截图、119 帧与 canonical Store／Model 全文保存在 `dist/acceptance/unified-mail-live-window-20261023-fa64bc12.json.workspace`，总报告为同名去掉 `.workspace` 的 JSON。idle 普通邮件不自行启动，最终结果在父续跑回复前已出现原发送者和具体正文；active 普通消息／结果进入原 Run，事件与准确子详情可读，完成和冷开不补最终结果气泡。两次正常退出、冷开零新增 Provider／Run／Execution／Command／Source／control 已核。

**修复前该次真实窗口验收为 failed。** 普通邮件的物理占位 Message 被公开链原样作为用户气泡展示，仅出现 `Agent message (untrusted data; no additional authorization)`，未显示该邮件的具体正文和来源；活动原 Run 因此被分成两段处理过程。真实邮箱和下一 ModelInput 都有完整邮件，不属于投递丢失或额外 Run。根因是 [普通邮件收件](../../packages/agent/src/storage/sqlite/agent-mail-operations.ts)只保存内部占位，公开 Runtime／Service／Native 当时缺少相应展示投影；完整展开只用于模型上下文。`ordinaryMailNotRenderedAsUserPlaceholder`、`activeSingleProcessForOriginalRun` 两项明确失败，不能以最终结果样式、Core 收件或冷开通过覆盖。失败截图为 `07-active-received-in-process.png`，准确子正文截图为 `08-active-child-result-detail.png`；当次测试未修改生产展示，后续修复与复验见下段。

普通邮件现沿 Runtime 的已验证 `Message.agentMessage` 显示真实发送者与完整正文。[Native 投影](src/native-presentation.ts)保留原接收 Run，`systemKind:agent_message` 交给原 MessageItem／NativeModelOutputMessage，在同一处理过程内渲染 Markdown，不生成独立气泡、用户边界或额外最终回复／复制按钮；完成和冷开仍只保一份邮件、一段过程与一次耗时。真实来源与不可读状态由 [Runtime／Store owner](../../packages/agent/src/storage/README.md#统一消息接收)负责。

2026-10-23，同一模型／协议／设置、macOS arm64／Bun 1.4.2、`87944be7f` 加本次修复：[真实窗口 runner](../../tests/e2e/live/model/collaboration-unified-native-window.live.ts) **passed**，12 次实际 HTTP 200，12 张阶段截图与138帧保存在 `dist/acceptance/agent-mail-display-live-window-20261023-2a0c498d.json.workspace`，总报告为同名去掉 `.workspace` 的 JSON。按真实 sender Tool 输入逐字核完整普通邮件，发件人来自原 Session；活动父轮原 Run／单处理过程／无独立气泡、原子详情、完成后展开原邮件及冷开去重均通过，冷开零新增 Provider／Run／Execution／Command／Source／host control，两次窗口正常退出。`12-active-ordinary-mail-detail.png` 显示父仍回复时的来源／完整正文与单过程；终态及冷开截图保留原分组。窗口时序门只延迟真实 HTTP 200 后的原响应，不生成或改写正文。

共享 UI／Native DOM 两整文件15项／360断言、Service响应与生成Message validator整文件6项／18断言通过；Core Task业务26整文件132项／2538断言，以及输入／派发／child result／Runtime报告恢复四文件27项／375断言通过。八 workspace typecheck、同源 API、边界和测试归属检查通过。本次资格限本机普通候选、已配置真实模型与隔离读取工具／Full选择，不外推安装发布或其他平台；修复前的失败证据保持。

子 Agent 工具消息复用原 [ToolActivity](../../packages/ui/src/desktop/ToolActivity.tsx) 的 Trace 单行。[nativeAgentActivities / nativeAgentActivityForTool](src/native-agent-activity.ts) 只从原环境目录投影已知版本 `task.spawn / task.follow_up` 的准确 carrier，核原 Store、父 Session／Run、`sourceTool` 与工具执行、子 Session 和原 child-start；已成功受理的原工具回执与目录吻合后，才在原消息行补充名称与准确详情目标。`childAgent` 仅含 identity／name；操作标题取原工具 Message，固定显示“创建子 Agent”“继续子 Agent”，不接收 carrier／child Run 的生命周期或新鲜度，不因子完成、失败、中断或后续任务改写标题、结果或动画。原工具本身的失败、取消与结果未知保持自身展示。整行点击沿原右侧标签交付准确 Session／Execution，不增加 mutation；没有折叠或独立详情按钮，旧展开缓存也不会把原始受理 JSON 或子 reader 挂回父会话。详情回调暂不可用时仅暂停该行点击。

[环境 hook](src/native-environment.tsx) 复用原完整目录和有界展示缓存，不增加网络读取；缓存成本包含子 Agent 展示事实，同 scope 校准先保留最新已读 display，即使完整展示超过缓存预算也不闪回旧行。普通刷新保留名称、原操作和详情目标；当前任务生命周期仍用于原环境卡、停止门禁和子详情，不投影为父历史工具行状态。图标按原 Store／child Session 稳定身份与审批卡共用。

[关联回归](test/native-agent-activity.test.ts)核生命周期变化后静态投影不变、同 Agent 多任务和活动指导、准确来源与恢复历史；[目录到消息 DOM 回归](test/isolated/native-agent-activity-dom.test.tsx)核真实环境 hook、精确投影、静态原操作和 DOM／选择区保持、超缓存预算刷新与准确 child reader 请求。此范围不代替完整 NativeDesktop、真实模型或安装发行验收。下述较早窗口记录仍保留其当时的验证范围，其中父消息动态跟踪子任务状态的行为已按用户明确要求改为静态历史操作。

2026-10-23，macOS arm64／Bun 1.4.2，`8a8458800` 加静态操作修复：共享消息、Native 投影／目录 DOM、原工具聚合、侧栏标签和导航六整文件 52 项／2581 断言通过；八 workspace typecheck、同源 API、架构边界、测试归属、Biome 和文档检查通过。普通关闭诊断的真实模型窗口 `dist/acceptance/static-agent-tool-history-live-window-20261023-5a16bc24.json` 通过，`deepseek-v4-flash`／chat-completions／medium／4096，15 次 HTTP 200、36 张阶段截图及276帧。既有 `parent-compaction-only` profile 覆盖原子任务创建、完成、父轮接收、两引导与父压缩、完成和冷开；不声称该 profile 触发子压缩。逐帧／DOM 监视从原创建行就绪持续至子完成及父压缩后继，原节点、静态“创建子 Agent”和32px高度保持，无生命周期运行／失败状态；冷开仍保原创建操作且零新增请求或业务记录。`05-parent-running.png`、`07-active-received-in-process.png`、`22-cold-original-agent-creation.png` 分别保存执行中、子完成接纳后及冷开事实。此范围不代替实际取消窗口，具体取消沿原源码外协作场景独立验证。

同日[原生协作整窗口](test/isolated/native-collaboration-bundle.test.ts)独立通过1项／59条 Bun 断言、23次受控本机 Model 请求与93帧：实际 A 完成、同 Session 新 follow-up、B 经原后台停止入口到 cancelled、后续父轮及冷开，共6次热检查和1次冷检查保原创建操作；热阶段沿同一 DOM 行，连续帧错误为零。`dist/acceptance/child-result-message-0916e3da-160b-4d48-8b9d-9a2871d92f24/03e-static-creation-after-cancel.png` 同时显示左侧两条原创建操作与右侧 B 的 cancelled 事实。此为明确开启诊断的隔离测试制品，普通 dev／prod 仍关闭；不把本机固定模型称为远端真实模型。首次启动因旧字符串改写未匹配新增 type import，driver 未启动；现改为显式传递 package 位置并从该位置加载 Playwright，复用相同且未改动的已核候选后通过，原流程、工具效果、审批、停止及预算断言保持。

2026-10-23，`45b8275c1` 加本次直接导航修正：消息、目录到消息、原工具聚合与侧栏标签四个完整测试文件共18项／474断言通过，UI／Desktop typecheck、定向 Biome、统一边界和文档检查通过。旧 `expanded=true` 不调用回执 reader，也不生成折叠控件、受理 JSON 或独立详情按钮。Chrome 隔离夹具以生产组件和 Native 投影逐次核对状态变化，鼠标、Enter 和 Space 均直接打开原右侧详情并保留父正文；500px 窄窗长名称省略、状态保留，深浅主题保持14px、32px行高且无横向溢出。Native DOM核到准确 child reader 请求；浏览器详情正文为夹具内容，不代替完整真实任务、模型或安装版验收。

2026-10-23，macOS arm64／Bun 1.4.2，`655fb9a97` 加本次 diff：上述关联、目录到消息 DOM、[共享消息 DOM](../../packages/ui/test/isolated/desktop-agent-activity.test.tsx)和[原工具聚合](../../packages/ui/test/isolated/desktop-tool-aggregation.test.tsx)四个完整文件15项／317断言通过，UI／Desktop typecheck、定向 Biome、统一边界、测试归属和文档检查通过。Chrome 以隔离夹具加载生产 SessionPage／ToolActivity、真实 Native 投影及原 Vite／Tailwind 编译样式，逐次观察受理、排队、开始、等待、结算和各终态：始终只有一行，展开选择与行位置保持；500px 窄窗长名称省略且状态保留，深浅主题保持14px正文，页面无横向溢出。该夹具不读取用户数据、不运行模型、不加入普通客户端。邻近 `native-background-panel.test.tsx` 的旧环境卡断言仍期待普通界面显示“上次状态 · 待核实”，在未含本次 diff 的 `655fb9a97` 主工作区也单独复现同一失败；其余本轮实际通过与这项既有失败分开记录。

[目录适配](src/native-presentation.ts)在没有全局 activity 而消费当前会话观察时，将 `viewLoading` 与实际读取失败区分：同 Store／同 Session 的正常校准保留原运行展示；目录不可用或 `permissionUnavailable` 且不在校准中仍显示上次确认状态，foreign Store 不消费该观察。仅保留展示，不改变操作准入。[环境适配](src/native-environment.tsx)同样把校准 `busy` 与真实 `stale` 分开，普通刷新沿原展示缓存保持文字、行数和停止按钮，按钮在新 facts 完成前禁用；首次读取仅标记忙碌，真实错误仍明确提示。Main 尚未确认目标选择时，环境 hook 的 `paused` 立即停止旧范围读取并隔离 child／stop，保留当前卡片的文字与按钮为 busy；这类已知切换等待不转换成真实 stale 错误，切换前已存在的真实错误仍保留。旧 observation 不恢复写资格，已受理停止等待最新完整目录及原 Main 准入，scope 替换和未知零重放保持。

2026-10-18 Windows x64／Bun 1.4.3，基于 `f734245a` 加本轮工作区改动：[目录](test/native-directory.test.tsx)新增同会话校准保运行标记及真实失败／foreign Store 反例，[停止竞态](test/isolated/native-environment-stop-dom.test.tsx)新增普通刷新保节点、空列表不插加载段、禁用零写及真实失败。原实现分别复现运行标记被撤下、环境卡加“上次状态”并移除停止按钮，以及空列表插加载段；修复后相关整文件通过。Chrome 155 隔离夹具使用实际目录适配、共享 SessionPage／Composer 与环境 hook，亮暗主题、1240／800／500px、空／非空目录下原环境卡高度变化为4／48px，修复后文字、按钮数、可见侧栏运行标记和所有受测几何／滚动保持；每次选择一次、后台读取继续、零停止写入。500px 原侧栏未挂载，不将该场景计作侧栏视觉证据。完整安装窗口、其他平台及全量默认测试未运行；原嵌套 `@keyframes` 编译提示保留。

正式 [页面](src/native.tsx)将现有后台目录接到原 [BackgroundExecutions](../../packages/ui/src/desktop/BackgroundExecutions.tsx)环境卡和 SessionPage 的 `environmentInformation` slot，保留原 300px 卡、宽窄窗口停靠／浮层与开关行为。[适配器](src/native-environment.tsx)仅将来源为 `shell.launch@1` 且父工具身份匹配的 `shell.command` 展示为后台 Shell，子 Agent 仍按准确 child Session 展示，名称取公开 child title；自动命名扩展的 `agent/session-title` 按公开 `definitionId` 从环境卡的行与 child 入口映射中排除，不按可变名称判断，同名普通委派任务仍显示。原后台目录、执行历史、取消和 unknown 事实保留；回归见[环境展示测试](test/native-background-panel.test.tsx)。Shell 沿原 currentOnly 契约只列运行／停止中，按原准入提供准确停止。环境卡的子列表保留全部记录及 queued／starting／unknown／restored 状态和只读详情入口；共享展示层接收原 `stoppingExecutionId/onStop`，仅对当前新鲜完整目录中已核实的准确可停止 carrier 提供操作。旧状态、unknown、恢复历史或缺少资格时禁用停止，不凭稳定 child Session 转向后来一轮；原 task／Run 范围及 Main 的准入前后复核保持。不把终态或受理回执当作进程清理证明。

环境卡的 Main 目录读取和准确停止复核显式请求 `includeSourceTool:true`，消费原父工具的只读 ID／定义／版本；`shell.execute` 的前台命令、来源缺失或身份不匹配的记录均不进入 Shell 分组，不按 `cancelWithParent` 推断前后台。来源在原后台目录事务内核同 Session／origin Store／root work，普通总览默认响应保持。相关元数据与兼容边界见[Store owner](../../packages/agent/src/storage/README.md#跨会话原-job-目录)，取舍见[来源过滤决定](../../.agents/notes/implemented/architecture/2026-10-20-background-shell-origin-filter.md)。

同一稳定 child Session 的多份 carrier 分别保留原执行卡。环境卡打开详情时同时传原 `executionId` 与 Session；[renderer reader](src/native-background.ts)核 carrier／原 child Run／rootWork，导航、刷新和展示缓存均 pin 原 execution，不按 Session 找第一条或最新任务。缺少 execution 且有多个候选时明确范围不可核实，不猜目标。原停止仍按所选准确执行走原 durable caller。[实际 DOM 回归](test/native-background-panel.test.tsx)核同 Session 两个 carrier 的点击、刷新和返回，原完整正文与停止回归继续保持；这组受控 IPC／DOM 测试不替代源码外窗口或新六工具完整审批交互。环境目录当前不携带准确 child Tool 的审批事实，不能仅凭 child Run 的 waiting_interaction 推断“等待你的批准”；原准确主交互卡保持可达。

只有 Session 的导航可先等待当前共享目录，等待属于本次导航并可独立取消。首次完整目录返回后，唯一同 Session carrier 才形成准确 pin；缺失或多个候选明确失败，后来的目录不能替这次失败选择目标。已绑定的导航、刷新和缓存继续使用该 execution，新 follow-up 不改投；只有用户再次明确打开才重新选取。连续切换及时退役旧等待，不关闭共享目录 owner。[导航回归](test/isolated/native-session-navigation-dom.test.tsx)同时核目录未返回时的100次切换、歧义拒绝及后续 carrier 不替换原目标。

准确 carrier 已在同范围完整目录中核实后，首次打开不再排在后续全目录刷新之后。Renderer 在刷新在途保留上一完整 facts，仅对已 pin 的同 Execution／child Session 发起只读接纳；Session-only 或未知目标仍等待完整目录唯一解析。Main 为 child-only 读取保留最近一个完整同根观察，覆盖目录替换在途，以及 Main 已发布／正常关闭目录但 Renderer 尚未提交新观察的交接窗口；按请求 observation ID 选择准确候选。仍重新核准确 carrier、祖先与 child 绑定、固定上界完整历史及正文；失败、未完成取消、reset、scope 变化及超出上一代观察均失效。停止、Job输出等入口不使用这份候选，旧观察不能授予操作资格。加载期先显示准确目录已有的 child 名称，首次正文仍须完整核验后发布。[Main 回归](test/native-background.test.ts)与[首次进入 DOM](test/isolated/native-session-navigation-dom.test.tsx)持有替换目录，核原 child 独立读完、标题与原 Run 不变、成功 publication／close 交错时两次 exact 核验，以及失败／取消／身份／范围／超代观察拒绝和零业务写入。

Main 从实际选中根的 controller snapshot 固定 Store／subject／generation／rootSessionId／viewSelection，复用 [NativeBackground](electron/background.ts)与原完整 reader。封闭 IPC 的 `surface: environment` 仅选择这份 Main 观察，不接收 renderer 根 ID 或路径；它与全局总览有独立读取生命周期，选中根变化只释放环境读取，旧停止资格失效。SSE 或显式刷新触发 GET，完整成功后才发布。页面仅缓存最多八个同代次／Store／根的展示快照，每份最多512KiB；没有 observation、完整输出或提交意图。失败保旧名称和状态，停用停止入口；准确停止继续走原 durable caller，未知／在途原取消不换 ID 重发。

父会话在 [NativeDesktop](src/native.tsx)、子详情在独立 [NativeChildDetail](src/native-child-detail.tsx) 分别选择各自消息和已核实事实，再沿相同的活动工具映射、[desktopTranscript](src/native-transcript.ts) 轮次投影和[工具聚合](src/native-tool-messages.tsx)装配消息，复用共享 Conversation 及正文／工具回调；[SessionPage](../../packages/ui/src/desktop/SessionPage.tsx)同时承载主会话和当前子标签。父历史的展示缓存和未落库首发消息保留原适配。已核实的轮次过程、耗时、终态、最终回复、Markdown 与全文复制沿相同组件呈现；子标签不提供输入、审批或文件打开动作，父会话控件保留原权限门禁。完整 child reader 每次读取固定消息上界并核 ModelOutput 的 EOF／SHA／UTF-8 后显示。宿主将已验证 snapshot 交给 `ModelOutputMessage.verifiedSnapshot`，组件再次核准确出处和字节数，直接呈现已读正文与活动前缀。全局观察修订驱动目录和子详情更新，各自只有一个在途读取，期间变化合并为一次尾随读取，避免持续输出反复中止 GET。活动子页沿同一 context selection 的完整稳定消息前缀重读尾部；Main 核当前父子绑定，context 变化回退全量。公开已完成消息不可由 partial 写路径更新，未完成消息及正文必须重读；后台总览不使用增量游标，保持原完整固定快照。

当前根环境的 [Main child reader](electron/background.ts)在同一已验证快照内附带只读 `presentation`：消息所需的原 Run、准确 Tool 回执和精简的活动执行事实。历史 Run 超出当前 View 时按原 ID 读取；Fork／Include 封存来源仍不借后来的来源轮次补终态。父历史 reader 与 child reader 共用 [nativeToolMessageFact](electron/tool-message-fact.ts) 的原执行／正文匹配、唯一请求目标、问答和授权展示校验。增量更新保留已核实的稳定工具事实及旧终态轮次；仍活动的轮次和未收齐回执的工具请求随尾部重读，直到确认终态及原目标，避免原 Run 离开当前 View 后失去展示。普通轮次／工具元数据读取失败仍交付已核实正文并明确提示，可用原刷新入口重新核对；下一次校准从头读取，身份错绑仍拒绝发布。展示数据不参与准确 carrier 的停止准入。后台总览完整日志继续使用原固定快照；其角色／序号诊断壳保留，正文改用同一 [NativeModelOutputMessage](src/native-model-output-message.tsx)，Markdown 准备、完整／不完整输出、原工具调用和 unsupported 处理均由公共组件负责。主页面也使用该 wrapper 的默认 Markdown renderer，仅注入获准的文件打开回调；推理记录仍须 Native 诊断门禁与显式展示请求同时开启。

2026-10-21，macOS arm64／Bun1.4.2，`3cf44ed0f` 加本次工作树修改：[Main／reader](test/native-background.test.ts)、[环境卡](test/native-background-panel.test.tsx)、[工具事实](test/native-tool-messages.test.ts)、[轮次](test/isolated/native-transcript-dom.test.tsx)、[工具展示](test/isolated/native-tool-messages-dom.test.tsx)、[原始回执](test/isolated/native-tool-receipt-render-dom.test.tsx)、[实际 NativeDesktop 导航](test/isolated/native-session-navigation-dom.test.tsx)、[历史展示](test/isolated/native-history-presentation-dom.test.tsx)、[正文缓存](test/isolated/native-model-output-cache-dom.test.tsx)与[读取归属](test/isolated/native-read-ownership-dom.test.tsx)十个完整文件共122项／1729断言通过；核父子共用消息装配、折叠过程、工具聚合、最终正文／复制、元数据失败保正文、旧活动轮次补核及只读往返，另核诊断完整子日志的共享 Markdown／正文和推理门禁。Desktop typecheck、定向 Biome、统一边界、测试归属和文档检查通过。同一最终工作树的[普通 Electron 流式窗口](test/isolated/native-child-stream-electron.test.ts)通过，沿真实 Service 与受控 SSE 完成100次父／子 A/B 往返；两个子模型各执行一次，最终在途读取为0，未暴露测试诊断入口。不将本机回归推作其他平台或完整安装发行资格。

2026-10-21，macOS arm64／Bun1.4.2，`f655e13fc` 加本轮子详情标签改动：以 `bun test --parallel=1 --max-concurrency=1` 和准确 `./` 文件路径执行共享页面、标签、复制／选区、滚动，以及 Native 环境、导航、历史展示、停止、网页、轮次、正文缓存和读取归属的12个完整文件，共105项／2335断言通过。核主会话标题／正文／输入节点与草稿保持、父历史持续更新、准确 carrier 标签去重、8项容量、标签隐藏释放、迟到 EOF 拒绝、权限撤销后复制零写入与恢复、同一活动标签在 history epoch 更新后全量校准。普通 [Electron 流式窗口](test/isolated/native-child-stream-electron.test.ts)再次通过100次父／子 A/B 导航，原180秒父等待期间子模型各执行一次；三个采样的连接节点均483、监听均554，结束活动读取为0，50ms以上长任务为0。使用实际 SessionPage／NativeChildDetail 与生产 CSS 的 Chrome 隔离夹具检查明暗1440／900px、520px缩窄后恢复、长 Markdown 独立滚动、主输入保留和关闭／切换卸载，页面无横向溢出或错误。UI／Desktop typecheck、定向 Biome、文档、统一边界和测试归属检查通过；保留原 CSS keyframes／大 chunk 提示和原 ToolActivity key 提示，未运行完整默认测试、安装制品或其他平台。

子详情只缓存已验证展示数据，最多12项、64MiB估算载荷、单项16MiB；不保存 observation 或操作资格。重新进入先由当前父范围目录核准子成员，再展示命中的正文，同时完整校准；显式刷新也完整重读，不以相同序号跳过。generation、history epoch 或 bridge 替换清理旧缓存。打开、刷新或返回不改变 Main 阅读根、不取得 child 写权；详情位于共享 SessionTabs 的独立子标签，主阅读根、标题和 `readingKey` 保持父会话，父输入、审批、环境卡、History 与工具／轮次／文件／用量读取继续按原资格运行。标签以原 Session／Execution 去重，最多8项；只有当前可见子标签激活环境 hook 的唯一 child reader，切换网页／变更／其他子任务、关闭标签、收起或设置覆盖会卸载详情并同步释放读取。`NativeChildDetail` 复用共享 Conversation、轮次／工具投影和已验证正文快照；读取资格经 `ConversationActivityContext` 传递，权限失效或选择交接保留正文并撤销复制与正文 reader，只有展示元数据失败不撤销已核正文。标签归属使用稳定 Store／父 Session，generation／history epoch 则由原环境 scope 撤销并重新校准当前目标，避免代次变更后当前子标签失去读取。关闭、切换子页、换根、reset 或卸载会 abort 所属读取，迟到结果不能替换后来视图，读取取消不停止业务任务。消息与正文按 ID 建索引，避免逐行扫描全历史；阅读位置和展开状态由共享 UI 的有界数据缓存保存；主会话继续使用原 KeepAlive，子标签卸载消息树，只保留有界已验证数据与阅读状态。标签与读取归属取舍见[子详情标签决定](../../.agents/notes/implemented/feature/2026-10-21-native-child-detail-tabs.md)，原校准、来源和预算理由仍见[主子会话阅读决定](../../.agents/notes/implemented/architecture/2026-10-15-native-session-reading-lifecycle.md)。

Main 自动刷新父元数据会暂时清空 controller snapshot，但不会因此撤销同一已准入根的 child lease或固定H的Job输出读取。仅在刷新在途、同 selection／Session 且未有真实失败时，环境与Job reader沿 Main 上次已验证根保持范围，每次读取仍核后端绑定；真实换根、reset 或刷新失败立即失效并abort相应读取。自动元数据刷新或显式权限刷新失败时，Main 主动释放 environment 的目录、子正文及输出 lease，清除观察与正文缓冲，不依赖 Renderer close；权限不可用时即使 controller 仍有旧快照也不能重新准入。恢复后旧 readId 与 observation 不复活，必须重新取得完整目录；Renderer 保留上次正文并对当前子页全量校准。[Main 回归](test/native-caller.test.ts)用 held 父 GET 核 child chunk／目录可独立完成，并让失败前的目录和 child GET 忽略 abort、跨过恢复后才返回，核旧结果拒绝、新观察可读及零业务取消；[Job输出回归](test/native-caller-job-output.test.ts)让SDK最新H从2推进至4，确认父刷新未结束仍只读原H2且可同scope重开。两者均核三种真实撤销拒绝迟到结果、零业务取消。主页面在子标签打开期间继续校准历史；父元数据或历史本身不可用时，发送／停止／权限仍等待当前新鲜资格，不因标签切换恢复旧 complete 状态。

Main 的 `state` 与 `messages` 只读请求不等待父元数据刷新结束。`state` 立即投影当时已核实的选择，刷新在途保留原会话并标明 `viewLoading/permissionUnavailable`；完成或失败仍由原观察通知更新。`messages` 只使用当前准确 selection／Session／Store 和原 high water，不能读取后来选择或越过已观察水位；写操作继续等待刷新及自己的权限核验。[Main 回归](test/native-caller.test.ts)持有真实 observer 触发的父 GET，验证返回父历史与状态可独立完成、权限修改仍等待、旧 generation／错误 Store／换 Session 均拒绝。[实际窗口](test/isolated/native-child-stream-electron.test.ts)在父 `task.events` 保持原 180000ms 等待时核准确父正文、草稿响应、两 child 的100次往返及完成后的历史重进；另持有真实父元数据 GET，核刷新在途父子往返仍可阅读、普通写入不可用。完整等待覆盖在触发该元数据变更前完成；导航不重放模型任务，不缩短业务等待。

父历史的可读展示不再等待 Run／Tool／Files 三类辅助元数据全部完成。完整固定水位消息发布后，即使辅助读取在途、返回时又有后继历史校准，正文和草稿仍可显示；未核实工具沿原局部待核组件，不自动展开原结果 JSON，也不取得文件或执行动作。加载图标只用于当前准确会话尚无可读消息；历史 EOF 与 Main 新鲜资格继续独立约束写入。[主子导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)持有原 spawn Tool 元数据，核运行 child 期间子标签切换、关闭与重进、主正文／输入节点与私有草稿保持、父历史并行更新以及父校准未结束时权限仍禁用。[实际窗口](test/isolated/native-child-stream-electron.test.ts)另用真实只读 select 建立新的 viewSelection，持有准确已成功 spawn Tool 的 HTTP200 元数据回复；原180秒 wait与两个 child仍活动时核左栏单击返回和重进，Model调用不增加。该读取不触发 child 完成或重放任务。

多个根并发时，单一全局SSE仍消费并确认全部事件，sidebar／全局总览沿全局修订更新。当前父metadata／history仅由本根或全局失效触发；环境另用 `selectedEnvironmentRevision` 跟随本根、已知后代及保守的新Session创建通知。完整根目录得到的Session索引只用于失效路由，不授予读取或停止权，换根／reset清除；不对每个未选中Session发View GET。Main 的 `environmentReadUnavailable` 把同选择metadata在途与真实读取失效分开，普通刷新期间正文可继续，发送／停止仍等原metadata资格。相邻回归核100个无关root／child事件不重读当前父View，也不丢全局目录或游标推进。

[Controller](src/controller.ts)为每次selection读取持有AbortController，替换／网络释放立即取消旧GET链；每个await后与写入缓存前均复核当前选择，退役结果不再进入缓存。Renderer state刷新至多1个在途与1个最新后继，密集通知共享后继且保留显式刷新后的新事实要求；错误、结果按原generation／nonce／epoch隔离。child可取消自己等待共享目录的任务而不取消目录owner，同一份新目录只消费一次；真实后续修订仍排尾随读取。[读取所有权](test/isolated/native-read-ownership-dom.test.tsx)与[导航回归](test/isolated/native-session-navigation-dom.test.tsx)核100次通知／等待、迟到错误和换根，SDK完整后台目录的有限重扫规则归[Client owner](../../packages/client/README.md#完整后台执行目录)。

子标签切换、关闭或隐藏同步撤销当前child导航意图，再取消job／读取；自动恢复只依据当前意图，不能使用旧render捕获的child重新打开详情。目录提交与返回在layout／passive交错时，原代码实际复现返回后重新打开子页；精确交错回归在旧实现失败，修复后通过。临时权限丢失保留尚未撤销的意图，恢复时仍正常校准；换根和明确关闭或隐藏子标签则终止该意图。

环境卡准确停止接纳期间，同scope目录刷新排队，先等待已经在途的完整读取，再按最新完整facts核目标与停止资格；原停止申请只提交一次。目录结果立即更新读取owner的最新facts，避免React尚未commit而使用旧observation。停止返回后恢复目录校准，换根只撤销尚未提交的等待；已提交的原停止继续收束，迟到提示不能进入新scope。Main原有prepare前后两次新鲜度校验、准确身份和unknown不重试保持。[停止竞态DOM回归](test/isolated/native-environment-stop-dom.test.tsx)在旧实现复现轮询替换观察及未等在途目录即提交，修复后3项／24断言通过；真实混合压力复测归下方监督进程对照。

实际多根窗口还发现滚动后立即离开会保留旧消息DOM：GC后脱离document的节点500→2217，heap snapshot定位13棵Conversation经Document动画controller→RAF closure→旧viewport持有。原Radix ScrollAreaThumb卸载遗漏持续RAF清理；消息区现使用组件库 ScrollArea，并通过版本绑定补丁补齐卸载清理，原阅读位置／自动跟随／跳最新／细滚动条保持，资源归属和100轮立即卸载回归归[UI owner](../../packages/ui/README.md#完整模型正文展示)。修复前的GET已排空与单一SSE并不能证明DOM释放，两项证据分别保留。

活动大正文持续改变时，纯全文key缓存仍会miss。多根长正文CPU profile曾在开发React运行时复现99次约60ms长任务，固定parser的micromark tokenizer／调用栈占主要时间；不能用Promise延后同一主线程工作解释为消除阻塞。[Native Markdown准备](src/native-markdown.ts)现将至少32768个UTF-16单位的已验证Model正文交给[静态Worker](src/native-markdown-worker.ts)，只运行UI公开的固定remark／GFM／公式纯解析。一个active计算、最多8个pending、排队源文本估算16MiB，超限明确 `native_markdown_busy`；活动单篇仍完整解析。准确任务ID／原文和AbortSignal隔离迟到结果，取消当前计算终止对应Worker，不取消业务。

child每批完整facts按序准备所有正文，缓存重进也先准备，再发布新formatted内容；旧已验证正文保留到替换完成。每批只注册一个owner abort listener，新批提交后立即释放旧批；重用稳定snapshot时清理核owner身份，inactive LRU不强持超预算AST。当前展示与正在准备的新批可短时各持一份纯树，不能将其算成全局语法缓存8MiB的进程内存上限。手动Model全文的有限HTTP／IPC在CPU准备前已关闭，成功展示的owner直到关闭／卸载才释放，验证失败立即清理。[准备回归](test/native-markdown.test.ts)核队列、超载、100次revision、共享前缀、取消及迟到身份；[正文回归](../../packages/ui/test/model-output.test.tsx)核成功展示与拒绝释放。最终真实窗口数据须同时说明React构建环境，不把旧开发运行时与production差异全部归因Worker。

Worker只导入公开纯子路径 `@kite-ai/ui/desktop/markdown`；[共享构建解析](scripts/markdown-worker-resolution.ts)将准确 `decode-named-character-reference` 依赖固定为锁定包的默认纯实体查表入口，避免browser入口在Worker中访问document。production renderer／Worker与development预打包共用该exact alias，不改变CSP、webSecurity或其他browser条件。[实际构建回归](test/native-markdown-build.test.ts)把真实Vite Worker产物置于无document／window／Node权限的VM执行，与固定parser核中文、emoji、多码点实体、后置reference和GFM的AST一致；普通sandbox的Electron短probe另核静态asset真实响应及所属进程退出。

首次或缓存重进的完整校准失败后，下一个修订仍执行全量读取；旧缓存不能因失败而取得稳定前缀资格。没有已验证前缀时不发送增量游标，[环境回归](test/native-background-panel.test.tsx)覆盖空缓存及已有缓存两种失败恢复，避免空context游标卡死或绕过完整校准。

[Main／IPC](test/native-background.test.ts)、[环境卡 DOM](test/native-background-panel.test.tsx)、[目录 reset](test/native-caller.test.ts)及[原页面](../../packages/ui/test/desktop-page.test.tsx)核准确作用域、全局／当前独立读取、完整分页、只读往返、旧快照与重复停止抑制。实际 [子详情／恢复窗口](test/isolated/native-background-bundle.test.ts)和[宿主 Shell 窗口](test/isolated/native-shell-lifecycle-bundle.test.ts)沿原业务断言验入口；准确结果、原失败和阶段限制见[本片进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-环境信息卡与只读子详情)。

2026-10-15在本轮未提交工作树、macOS arm64、Bun1.4.2／Electron44.3.0执行 `bun test apps/desktop/test/isolated/native-child-stream-electron.test.ts`，使用普通制品、真实Service与受控SSE Provider，两个真实worker各有约172905字节子正文、五次活动更新。[窗口测试](test/isolated/native-child-stream-electron.test.ts)和[driver](test/native-child-stream-electron.fixture.ts)实际完成100轮主／子A/B往返。固定GFM纯语法树缓存前后，热缓存往返P50为142→103ms、P95为181→145ms，切换期间50ms以上长任务100→0；最终活动正文更新P50／P95为135／144ms。语法树仅缓存数据，32项／8MiB总估算／2MiB单项，超预算仍完整解析，不保活隐藏组件。

资源采样在20／60／100轮先等实际HTTP body归零、两帧与微任务后再GC，heap分别15625972／15347028／16380200字节，最终再次settled GC为16302688字节；DOM477、监听器211、documents2均恒定。有限body读取最终active0、峰值1；主模型2次、子A/B各1次，导航没有重放任务。该负载未观察到资源累积异常；采样不直接证明Main私有lease Map为零，其关闭由单元／DOM持有读取回归核对，也不代表数百条子历史、任意超长冷读或其他平台资格。所有测量均由隔离runner／外部CDP完成，普通dev／prod无测试入口。

2026-10-19上述双child原整文件另沿当前 `task.spawn@1`、prompt/task_name及准确Tool-parent carrier来源复验，1项5条Bun断言、22.21秒通过；父Provider两次、child各一次，原100次导航、大正文、heap/DOM/listener和所属进程收束保持，547次有限读取最终active0、峰值1，导航长任务0。原角色参数不再通过普通模型目录，driver按实际taskName/prompt核两个不同Session及正文归属；全部原预算保持。

[多根真实窗口压力](test/isolated/native-multi-session-stream-electron.test.ts)和[driver](test/native-multi-session-stream-electron.fixture.ts)将范围扩大到4根各3子：先核 `spawn_agent` 的准确 `task.spawn@1` Tool 与所属 carrier 真正派发、16个Model同时流式运行，再完成120次跨根／主子／子子切换，逐次核正文marker和私有草稿归属、活动更新、读取中断、零导航重放及准确根／child停止。夹具使用当前六工具的 prompt／task_name 输入，原角色、key 和 required 字段不进入模型目录。可信Host显式16个Model槽仅用于压力，生产默认仍4；Model输出由本机compatible SSE Provider提供，Service／SQLite／Runtime及普通sandbox窗口均真实运行。

2026-10-19本轮未提交工作树沿上述原整文件复验：普通Model组1项5条Bun断言、35.11秒，保20次Provider、16条同时流和120次导航，937次有限读取最终active0、峰值2、主动取消17次，全局observe一条，导航长任务0。原混合Shell模式另1项5条Bun断言、47.40秒，16条Model流与16棵真实Shell树重叠30.131秒、32次Provider及120次导航保持；1284次有限读取最终active0、峰值2、主动取消114次，导航长任务0。根停止将16条流准确收束到12，另停单child剩11，原完整输出、资源与所有所属进程收尾断言通过。两组均保原190秒整例、160秒driver及所有阶段预算，未以较轻负载替代；历史测量仍按各自日期与环境解释。

2026-10-15 production React制品完整通过：切换P50／P95为146／183ms，50ms以上长任务为0；944次有限正文／目录读取最终active0、峰值2、主动中断8次，全局SSE始终仅一条。settled GC三次heap为11.67／12.88／13.02MB，最后13.02MB；连接DOM随活动正文由357增至425，但脱离document的节点始终59，监听器227／227／228，没有再出现旧消息树累积。显式停止一根后16条模型流剩12，另停一child剩11，其余继续，正常结束后所属Service和Electron实际退出。此前99次长任务来自开发React制品及同步parser，两轮构建环境不同，不能把全部差异归因Worker。

同一测试的私有 `KITE_NATIVE_MULTI_SHELL=1` 仅选择隔离runner负载，不进入普通renderer／Main构建。混合组沿Service的[同一真实Shell脚本与配置](../service/test/isolated/multi-session-shell-load.shared.ts)为每根／子启动一个Shell，生产React窗口在16个Model、16个coalition Shell和16个真实sleep后代重叠30.004秒时完整完成120次切换：P50／P95为176／223ms，长任务0。普通页面核实际中文Shell工具与运行状态；完整stdout／stderr经原私有固定H读取协议核204条／462848字节、H204、UTF-8及gap0，held输出在换根时被abort而16个脚本仍运行。没有开启测试诊断菜单或新增普通完整输出入口。

混合组1516次有限正文／目录／输出读取最终active0、峰值2、主动中断58次，全局observe仍一条；32次实际Model调用不因导航增加。GC后三次heap为12.02／12.73／12.89MB、最终12.77MB，连接节点随正文增长425→503，脱离document节点59和监听器236恒定。根停止准确结束所属4条Model与4棵Shell树，另一个child停止只结束自身Model与Shell，其余11组继续tick／输出；显式finish后全部剩余Run及观察到的OS PID结束，Service与Electron实际退出。

混合窗口总Shell生成10379264字节，稳态双流合计162820字节／秒，脚本采样窗实际CPU约84.75%（单核100%口径）。Service RSS从836736至841056KiB、数值FD89恒定；原外部采样将ledger的32个脚本／后代PID与Service物理树17个进程取并集，共49个进程合计RSS约1.90→1.93GiB。2026-10-16复核发现，这份集合包含16个broker，却遗漏launchd下另16个独立guardian；RSS相加还重复计共享页，因此不能称完整产品或独占物理内存。原数据保留为旧口径参考，不补造遗漏进程的数值；同日已补完整角色并执行下面的同口径前后对照。以上有限本机CPU、进程与正文负载不等于任意Shell、无限历史或长期无泄漏保证；默认Model／process各4的排队、完整输出SHA及Service内存分类另由[Service压力](../service/README.md#多主子会话流与读取压力)维护。

### 内存缓冲区优化与完整进程对照

2026-10-16在macOS26.7.1 arm64／Bun1.4.2／Electron44.3.0当前未提交工作树完成两项内部IO优化：[启动文件校验](../../packages/agent/src/jobs/launch-identity.ts)每次以至多1MiB局部scratch计算完整SHA；[POSIX Artifact](../../packages/agent/src/artifacts-files.ts)按消费者所有权分配小chunk／固定verify scratch／单完整目标，保实际EOF、hash、文件新鲜度和权限。消息协议、默认配额、broker／guardian／coalition结构及业务取消语义保持；代码和局部回归归[Jobs](../../packages/agent/src/jobs/README.md#默认-macos-宿主-shell)、[Artifact](../../packages/agent/src/artifacts/README.md)及[决定](../../.agents/notes/implemented/architecture/2026-10-16-bounded-verified-file-reads.md)。本轮未实施正文复用或native broker。

[测试私有内存采样器](test/native-memory-census.fixture.ts)只由隔离runner的 `KITE_NATIVE_MULTI_SHELL=1 KITE_NATIVE_MULTI_MEMORY_TAG=before` 或 `after` 选择，未向普通dev／prod增加入口。它只读原Job reference，严格解码Session／Execution／nonce／owner绑定，核broker、launchd guardian及root原kernel birth，再合ledger后代与Electron所属进程；同一ps快照分角色RSS，原身份在采样前后复核。每轮实际为65个业务进程（Service、16 broker、16 guardian、16 Bun脚本、16 sleep）及4个桌面进程（Main、renderer、GPU、utility），排除driver／Provider。联合footprint一次传入69个准确PID；缺字段、集合不符、命令失败或身份漂移明确unknown并阻断完整对比，不填0。每PID当前与历史峰值、联合dirty／clean／reclaimable／swapped及代表vmmap保原始文件，多个历史峰值不相加称并发峰值。

两轮沿同一[隔离测试](test/isolated/native-multi-session-stream-electron.test.ts)和[窗口driver](test/native-multi-session-stream-electron.fixture.ts)串行执行，三份测试文件SHA完全一致，生产差异仅上述两个IO文件；guardian与Service每轮重新构建。before保原 `launch-identity.ts` SHA `1cad32fe…`／`artifacts-files.ts` `d9927d6e…`，after为 `0d592dbf…`／`84ae8b72…`；tag只是保存标签，不能把当前新实现标before来替代原基线。两轮各1项通过，59.87／59.08秒，保原16 Model＋16真实Shell／至少30秒重叠／120次导航、相同脚本、正文及输出／CPU速率。重型footprint／vmmap仅在导航PerformanceObserver断开后执行，3.315／3.141秒；采样前最年轻脚本已运行30.006／30.055秒，生成10356736／10366976字节，采样后33.223／33.068秒、10893312／10874880字节，未通过减少负载取得下降。

| 同一完整集合的测量 | before | after |
| --- | ---: | ---: |
| 69进程RSS求和，KiB | 4494976 | 3510992 |
| 其中65个业务进程RSS求和，KiB | 3595088 | 2617728 |
| Service RSS，KiB | 841520 | 682208 |
| 16 broker RSS求和，KiB | 558064 | 555840 |
| 16 guardian RSS求和，KiB | 1557840 | 755296 |
| 16业务脚本RSS求和，KiB | 618208 | 604928 |
| 16 sleep RSS求和，KiB | 19456 | 19456 |
| 联合去重dirty footprint，字节 | 1476108080 | 1471225432 |
| Service历史phys_footprint峰值，字节 | 358778056 | 301696128 |
| guardian单PID历史峰值中位数，字节 | 75154032 | 23413360 |
| 导航P50／P95，ms | 183／224 | 171／226 |
| 导航超过50ms长任务 | 0 | 0 |

RSS求和下降21.89%，guardian及Service的分配高水位下降；联合当前dirty footprint仅下降0.33%，不能称持续独占物理内存大幅降低。guardian当前phys_footprint计数的算术合计反而由191293136增至209905288字节，Service当前由144410016至149062952字节；这些分项不是角色去重总量，RSS也不能解释为活heap。联合reclaimable由2122891264降至1128513536字节，仍与当前dirty分开报告。两轮只是一组before／after，没有估计多轮波动；收益限定减少多余分配与高水位，不能据此证明任意时长无泄漏。

两轮消息／草稿归属、活动更新、固定H输出UTF-8及gap、真实GET中断、单global observe和零导航重放均通过。末次Renderer GC heap为13081072／12803876字节，文档外DOM余量最终均59、监听器均236，有限body active均0；root0停止后剩12流，另一个child准确停止后剩11流，其余继续。正常业务结束和所属退出之后，另用原69份kernel birth逐一只读复核，两轮全部absent，包含guardian和桌面进程；这是额外posthoc核验，未冒称原fixture内已有断言。定向资源回归另有6个真实Shell文件47项／445断言，覆盖父EOF／SIGKILL、TERM忽略、setsid／orphan、无关存活、输出失败与准确收尾。

本机原始文件分别保存在ignored `.cache/native-session-stream-evidence/memory-1792083158073-before/`、`memory-1792083544600-after/`，比较文件 `memory-before-after-comparison.json`；每轮含逐PID角色／birth／RSS、原footprint JSON/text、6份vmmap、输出／elapsed、完整窗口报告和原身份退出结果。当前产品行为仍由手册与owner定义，本机loopback Model和macOS真实Shell不授其他平台资格；普通dev／prod继续关闭测试诊断入口。

### broker／guardian 的小堆对照与 GPU 归因

2026-10-16在相同macOS26.7.1 arm64／Bun1.4.2／Electron44.3.0（Chromium152.0.7977.78）工作树完成default／`--smol`各三轮，顺序为default、smol、smol、default、default、smol。每轮仍为4根各3子、16路受控compatible SSE模型流、16个真实Shell、至少30秒同时运行和120次切换；真实Service／SQLite／Runtime、production React与普通sandbox窗口保持，模型token由本机Provider产生。窗口1100×780、显示比例2，GPU compositing／rasterization／Skia Graphite／WebGPU保持启用。

当时的隔离候选构建复制同一267文件Agent源快照，smol仅在broker启动和launchd guardian启动两处argv插入 `--smol`；Service、业务脚本及普通产品入口不改。原源码、package和测试输入SHA逐轮复核不变；每轮私有路径不同，分别保存资产SHA，不声称同组制品逐字节相同。实际ps和16份launchctl print核smol每轮恰16 broker＋16 guardian带flag，其他角色无flag；default全部无flag。对照结束后已移除私有源码改写器和候选选择参数，当前压力回归只使用默认runtime，逐PID ps与16份实际launchd argv继续断言不带 `--smol`。

[采样器](test/native-memory-census.fixture.ts)保原65业务＋4桌面进程联合footprint，另对同一批16 broker＋16 guardian做32 PID联合footprint；两份原始集合、kernel birth和错误字段均严格核验。角色RSS／phys_footprint算术合计不冒称去重值，历史峰值不相加。导航后先采联合footprint与代表vmmap，再采GPU；GPU trace引入的额外tracing utility随后登记，退出证据因此覆盖全程70个原身份。退出核验在正常driver退出之后、owner兜底清理之前执行，六轮均70/70 absent。

| 轮次 | 69 PID联合dirty footprint，MiB | 32监督进程联合dirty footprint，MiB | 导航P95，ms | 根／子Shell树停止，ms |
| --- | ---: | ---: | ---: | ---: |
| default-1 | 1432.49 | 387.36 | 232 | 272／109 |
| smol-1 | 1439.09 | 379.85 | 242 | 262／274 |
| smol-2 | 1438.96 | 381.63 | 239 | 221／194 |
| default-2 | 1470.27 | 388.78 | 291 | 281／266 |
| default-3 | 1433.87 | 386.36 | 231 | 209／183 |
| smol-3 | 1452.40 | 383.10 | 225 | 228／132 |

69进程联合dirty中位数为1503518704→1508990624字节（1433.87→1439.09MiB，+0.36%）；32监督进程为406179424→400166520字节（387.36→381.63MiB，−1.48%，减少5.73MiB）。guardian单PID历史峰值的组中位数22.65→17.45MiB，但其当前phys算术合计202.96→196.35MiB，broker当前187.78→187.23MiB；启动高水位下降不能当作同量稳态收益。全体RSS算术合计中位数3514.73→3539.27MiB（+0.70%）。本机证据只支持监督进程小幅下降，没有证明整体内存稳定改善，**保留默认参数，不在生产broker／guardian启用 `--smol`**。

导航P50／P95组中位数为177／232→185／239ms；每轮P95范围default231–291ms、smol225–242ms，六轮均无超过50ms导航长任务。根取消至模型流关闭中位数64→46ms、至原Shell树消失272→228ms；准确子停止至流关闭79→78ms、至树消失183→194ms。CPU按checkpoint20至120的累计CPU时间差／实际壁钟计算，100%表示一核：32监督进程合计中位数19.88%→19.24%，Service79.42%→79.27%，renderer76.05%→81.84%；脚本输出约162267→162859字节／秒，脚本窗口CPU76.66%→84.50%。三轮样本不足以判定小幅性能差异的因果或显著性，不宣称smol提速。

六轮均核活动主／子正文持续增长、逐次marker与草稿归属、完整UTF-8／固定H输出、读取中断、原32次Provider调用零导航重放、单一global observe、有限body最终active0／峰值2。根停止仅关闭其4路模型和4棵Shell树，剩12路；另停准确child剩11路，其余继续产出。最终renderer GC heap为12.23–12.52MiB，24个固定checkpoint文档外DOM余量均59，最终监听器均236。该负载未观察到持久资源累积，不外推任意运行时长零泄漏。

预检和先前两个未完成matrix均保留失败记录，不纳入最终六轮统计。首个matrix的default子停止实际报 `background_stop_unavailable`，定位并修复上文同scope目录刷新替换停止观察的竞态；定向DOM旧实现失败、新实现3项／24断言通过。另一次活动更新恰在GC与计数之间启动新校准，计数236→269，随后heap snapshot已回236，不能将瞬时33项确定归为泄漏或AbortSignal。固定快照现仅短暂排队普通changed通知，后端16路模型和Shell、请求回复及lifecycle继续；固定两次GC、原listener／DOM／heap门限不变。六轮窗口108–211ms、队列1–6条，finally恢复并原序转发，队列越界明确失败；释放后等待界面校准和有限读取收束，再采联合footprint或进入下轮导航。导航／取消计时和重型footprint在窗口之外，不以循环采最小值通过门禁。

[GPU采样器](test/native-gpu-memory.fixture.ts)在导航后和业务结束后各触发一次有界详细MemoryInfra dump，保存原trace、准确GPU PID／出生身份、allocator size／effective_size与ownership。Chromium本机导出零ID数据批，采样严格用唯一成功explicit global GUID、配对process scope和批次时间绑定；缺失／冲突／丢数据均报unknown。另存同一GPU进程OS分类footprint与vmmap，不把异时OS和Chromium值相减。12个阶段均capture成功，非total OS类别按dirty／reclaimable／wired／clean／swapped／regions分别求和均与total相等。

导航后GPU OS dirty为266.05–340.95MiB，其中 `IOSurface`、`IOAccelerator (graphics)`、`Owned physical footprint (unmapped) (graphics)` 三类占89.00%–91.76%。六轮Chromium均有明确共享边：`shared_images.size − effective_size`精确等于renderer `cc/tile_memory`，`gpu.size − effective_size`又等于该tile数加20193088字节transfer分摊差。例如default-1的640×800 BGRA_8888 IOSurface带 `GpuRasterTile_Pid:65235`，与renderer resource_41的 `0x1f4000` 字节指向同一global ownership端点，importance分别0和2。不能把GPU根、SharedImage和CC tile再相加；这些分摊来自trace原始effective值，不是自行估计去重。

导航后ANGLE Metal约81.45–91.77MiB、Dawn8.23–8.37MiB、Skia GPU resources4.23–4.37MiB。独立GPUBuffer allocator未导出，分类完整性仍为partial，缺项不填0；OS未映射图形计费也不能逐笔映射到Chromium节点。业务结束后的图形缓存仍有计费，所属GPU进程随正常退出全部消失；这既不证明缓存泄漏，也不构成关闭GPU或改变玻璃效果的依据。

本机最终矩阵在ignored `.cache/native-session-stream-evidence/smol-matrix-1792120884578/`，`index.json`保存顺序、冻结输入和六份证据目录，`comparison.json`保存原始字节／各轮性能／中位数范围。各case含69及32联合footprint、16份launchd证据、8份代表vmmap、两阶段GPU原trace／OS分类、快照边界、窗口与原70出生身份退出结果。较早未完成矩阵为 `smol-matrix-1792118528064` 和 `smol-matrix-1792119706839`；它们的单轮成功未混入最终结果。平台、模型及持续时间资格限于上述本机负载。

### GPU 缓存生命周期与候选对照

2026-10-16继续沿上述macOS／Electron版本、1100×780窗口和DPR2排查图形持有，broker／guardian始终使用default，macOS Vibrancy及GPU特性保持。受控模型token、真实Service／Runtime／SQLite、16路模型流、16个真实Shell、至少30秒并发和120次切换均保持。当时的隔离候选仅向私有构建CSS追加一条规则；default不写字节，每轮保存前后SHA与准确规则。普通dev／prod没有候选或生命周期测试开关，当前没有采纳生产GPU参数或样式修改；未采用的构建改写器及其测试参数已删除。

`contain: paint`候选完成default／candidate各三轮，顺序default、candidate、candidate、default、default、candidate。冻结17份输入和Agent源快照，默认原CSS SHA逐轮相同；完整输入副本与失败的探索记录保留在本机证据中。正式六轮只执行原内存、流、切换、取消和退出测量，没有在这些采样间启用LayerTree或运行静态视觉诊断。69 PID联合footprint均为原65业务＋4桌面进程；另核16 broker＋16 guardian的32 PID联合footprint，集合及出生身份逐轮匹配。

| 指标，中位数（最小–最大） | default | paint containment |
| --- | ---: | ---: |
| 69 PID联合dirty footprint，MiB | 1449.71（1428.37–1452.55） | 1443.05（1435.13–1463.98） |
| GPU当前phys_footprint，MiB | 375.64（367.39–383.25） | 378.56（368.91–379.55） |
| 32监督进程联合dirty footprint，MiB | 384.02（383.58–387.50） | 388.52（387.83–388.94） |
| CC tile总量，MiB | 74.03（67.05–77.57） | 72.06（68.14–73.04） |
| CC tile in-use，MiB | 32.23（32.23–32.23） | 32.23（31.68–32.23） |
| 导航P95，ms | 217（215–226） | 221（220–226） |

GPU当前计数增加0.78%，联合footprint仅下降0.46%且范围重叠，不能证明持续收益，**不采用paint containment**。稍后单GPU OS dirty中位数341.72→330.39MiB来自另一采样阶段，不能与较早census相减，也不能代替同一checkpoint的当前计数。free tile中位数虽下降53.34%，candidate第二／三轮分别转为22,921,216／18,792,448字节busy；逐轮free＋busy的中位数仅43,827,200→41,762,816字节，in-use中位数不变。不能把池内状态转移解释为同量内存释放。

六轮导航后GPU OS dirty的88.46%–91.80%仍在IOSurface、IOAccelerator graphics与unmapped graphics三类；12个GPU阶段原始分类逐列求和与total相等，独立GPUBuffer类别仍为unknown。SharedImage与CC tile的ownership边继续表明同一分配跨进程分摊，不能将图像、tile和GPU根直接相加。[准确Chromium版本的ResourcePool](https://github.com/chromium/chromium/blob/152.0.7977.78/cc/resources/resource_pool.cc)区分unused、等待显示端归还的busy和in-use；unused默认过期5秒，复用会刷新时间。[SharedImageManager](https://github.com/chromium/chromium/blob/152.0.7977.78/gpu/command_buffer/service/shared_image/shared_image_manager.cc)按引用释放backing，不存在整个SharedImage目录统一5秒到期的规则。删除缓存对象也不保证OS计费同步下降。

六轮逐次marker／草稿归属、活动主子正文增长、完整UTF-8及固定H输出、所属读取中断、零导航任务重放和单global observe均通过；有限body最终active0／峰值2，文档外DOM余量最终均59、监听器236，末次renderer GC heap为12.20–12.47MiB。导航长任务均0；根／子模型流关闭中位数67／76→40／81ms，所属Shell树停止288／244→252／210ms，Shell输出约163296→163287字节／秒。准确根停止后仅其4路及4树结束，另停准确child后剩11路继续；六轮均在owner兜底之前核原70出生身份全部absent。这些断言未见退化，不外推任意时长无泄漏，三轮每组也不能证明小幅计时差异有因果。

当时的有界生命周期采样记录当前DOM／LayerTree及合成原因，但层面积不是实际驻留字节。[Chromium启用LayerTree会为owner debug信息触发重绘](https://github.com/chromium/chromium/blob/152.0.7977.78/third_party/blink/renderer/core/frame/local_frame_view.cc)，因此有效时间线将层检查移到全部内存与取消测量之后；早期逐dump检查层的pilot不能作为无扰动自然回收曲线。opaque滚动背景、浮层静止transform和侧栏stacking隔离的单轮探索也未建立收益，不作为正式对照或生产实现；侧栏isolation pilot的GPU当前计数385.42MiB、联合1434.54MiB、tile79.05MiB，原门禁和70身份退出均通过，没有因此采纳。收尾已移除LayerTree、固定页面额外采样和测试critical pressure分支，没有引入普通客户端诊断入口或全局强制清缓存策略。

移除采样间LayerTree干扰后，以default补做同一负载的固定页面时间线：选中root-3不变，活动阶段16路模型及16个Shell继续运行，导航后／同页6秒／12秒的GPU OS dirty分别264.06／338.19／350.25MiB，tile80.90／71.09／79.49MiB。全部业务结束后的同页观察如下。每行仍保存独立OS与MemoryInfra原始记录，不将两者相减；这是一轮生命周期观察，不是优化收益对照。

| 同页业务结束后的阶段 | GPU OS dirty，MiB | CC tile，MiB | tile free／busy，MiB | SharedImage size／effective，MiB |
| --- | ---: | ---: | ---: | ---: |
| 原500ms等待后的采样 | 379.39 | 112.20 | 98.18／0 | 151.62／39.42 |
| 自然空闲6秒 | 52.11 | 14.02 | 0／0 | 53.43／39.42 |
| 自然空闲12秒 | 46.33 | 14.02 | 0／0 | 53.43／39.42 |
| 之后的测试critical pressure | 48.14 | 14.02 | 0／0 | 53.43／39.42 |

ANGLE Metal同期123.22→15.59MiB、Skia资源4.79MiB→4096字节，SharedImage size的下降与tile free消失一致；effective不变再次说明同一tile分配的ownership，不能重复加总。该轮表明空闲图形缓存能自然回收，尚无证据将活动阶段高水位归因为旧会话DOM或图形资源持续泄漏；它没有证明任意时长不存在泄漏，也没有降低活动负载的实际计费。末次LayerTree因空闲后没有取得事件而超时并明确incomplete，不填造层归属；超时发生在所有7次内存采样之后。该轮导航P95为222ms、长任务0，根／子Shell树停止233／215ms，原70出生身份全部absent。本机原始证据为ignored `memory-1792124499546-gpu-lifecycle-clean/`及其中的`lifecycle-comparison.json`。

正式六轮本机证据位于ignored `.cache/native-session-stream-evidence/gpu-paint-matrix-1792123749012/`，`index.json`保存顺序、输入副本SHA和测量边界，`comparison.json`含逐轮字节、角色CPU、性能和退出结果。当前默认基线回归使用 `KITE_NATIVE_MULTI_SHELL=1 KITE_NATIVE_MULTI_MEMORY_TAG=gpu-check bun test --parallel=1 --max-concurrency=1 apps/desktop/test/isolated/native-multi-session-stream-electron.test.ts`，保留完整角色内存统计、32监督进程联合footprint和导航后／业务结束后两阶段GPU归因，不再选择实验候选。**本轮已按用户要求结束，实际降低活动GPU footprint的优化目标未达到**；保留此前已验证有效的有界文件读取、会话缓存、流读取释放与取消竞态修复，产品行为、玻璃和默认参数保持。删除前的三个实验fixture与runner／driver／census原始输入及SHA保存在ignored `.cache/native-session-stream-evidence/closed-gpu-experiments-1792128424346/`，历史测量没有因清理而被抹除。

清理后的默认复核在ignored `.cache/native-session-stream-evidence/memory-1792128688458-cleanup-default/`。原16模型流／16 Shell／120次切换门禁通过，普通生产React窗口`diagnosticsAbsent=true`；导航P50／P95为176／229ms、长任务0，有限body最终active0／峰值2；根／子模型流关闭42／76ms、Shell树停止196／293ms，原70出生身份全部absent。两阶段GPU归因继续成功，原69及32监督进程集合、16份默认launchd argv完整核对。窗口／玻璃、会话缓存、流读取／取消及有界IO优化涉及的20份生产文件与清理前SHA全部相同，清理没有改动已验证的产品实现。

## Native 跨会话后台总览

[当前会话](src/native.tsx)的后台状态汇总仅在显式测试诊断中显示；普通 dev／prod 在计数非零、未知或观察不可用时也不显示该行。原轮次进度、环境信息中的实际任务、准确停止和真实读取／权限失败的恢复入口继续保留。测试计数限定当前 Session/Store 的未结束 Job 与 outcome_unknown；planned/dispatching/running 包含停止未结算的项，终态、其他 Session、旧 Store、非 Job 不计入。计数使用 getView 的全部非终态投影，不是跨会话完整目录；父 Run 完成不清除后台状态。观察／权限不可用时，测试汇总标为上次确认状态，数量不授予停止权或证明实际进程存活。[installed 默认 Shell](test/isolated/native-shell-lifecycle-bundle.test.ts)显式构建测试诊断，沿实际页面核父已完成、2 项未结束及准确停止后 1 项未结束；原完整输出、Main/Service fault、冷读与保数据卸载断言保持，准确证据和未验范围见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08父轮次完成与后台状态分别显示)。

正式 renderer 的[后台总览](src/native-background-panel.tsx)是独立于选中会话的主动入口。它读取原主体根会话树内全部当前来源 Job，以及准确恢复根中的旧来源历史，包含 child/task carrier 与子会话中的 Job；超过200项仍穷尽全部页，不从有限 `selection.executions` 猜完整集合。每项分别显示原 Store、原父 Run、准确 `child-start-${executionId}` 子 Run、required 等待与 delivery；较新的子 Run 不替换原载体。公共来源与快照合同由[Store](../../packages/agent/src/storage/README.md#跨会话原-job-目录)、[Service](../service/README.md#完整后台执行目录)和[Client](../../packages/client/README.md#完整后台执行目录)维护。

[Main](electron/background.ts)固定 attach generation、Store、subject，先完整核公开目录再登记 immutable lineage 的 observation。512KiB/最多200项的有限 [IPC](electron/native-ipc.ts)只接 read ID、已观察 execution ID、observation ID 与准确停止 command ID；renderer 无法提供 Session、Workspace、路径、游标或 Runtime authority。[完整目录 reader](src/native-background.ts)只有穷尽同一观察才发布；新读取失败保留同 scope 上次完整显示，但新观察使旧停止 authority 失效。选择变化不清后台观察；断线、观察 reset、attach 替换和释放清所属读取及停止资格。

新子日志读取先等待在途完整目录收束，再从最新 facts 核同 Execution、Store、Session、Workspace、原载体及 child 血缘；目录失败不能借用上次显示的令牌。接纳期间暂缓新目录 poll，原 `background.child.open` 返回后即恢复轮询，正文仍沿固定 scope 读到完整 EOF；关闭或 scope 更换可撤销等待及接纳。React 显示尚未提交不影响最新完整 facts 的选择，已固定读取不随后续 observation 更新重开。[原 DOM 回归](test/native-background-panel.test.tsx)6pass／73断言与同一源码外完整后台窗口1pass／119断言核此竞态和后续全流程，实际版本、失败及完整默认资格见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

非选中原输出复用[固定 H reader](electron/job-output-reads.ts)与公共覆盖证明；原目录刷新不重开已经完整的输出。Main 固定当前准入 Store 与原 Execution originStoreId，原输出不改出处。子日志逐页读原子会话固定消息上界，核原载体／父链与根血缘，并以当前 Store 读取完整原 ModelOutput；带 originMessage 的正文另核原 Model 的 Session／Run／originStoreId。64KiB传输核完整EOF、SHA和fatal UTF-8，原载体的子 Run 与日志中后来轮次保持各自身份。关闭详情或总览只 abort 所属 GET，零取消或恢复。这里的完整子日志指子消息与完整 ModelOutput；诊断 SessionLog 的 restore replayFloor 合同保持。

旧来源项显示恢复历史只读；Main 在准备停止前要求原 Execution 来源等于当前 Store，底层取消还在首写前核整个效果范围的当前来源。新 Store 内明确创建的工作仍可准确停止。Main 重新核原身份、活动状态、attempt/owner generation/result revision 后，经[原 caller journal](electron/caller-journal.ts)保存准确实际 Session/Workspace 的 `execution.cancel`。内部后台 prepare 只接已观察对象并另核根与原主体来源；普通选中根 caller 门禁保持。既有／冷原意图仍只 GET，受理不冒充实际停止。

[Main/IPC 与原 journal 测试](test/native-background.test.ts)、[实际 DOM](test/native-background-panel.test.tsx)、[公共分页测试](../../packages/client/test/background-directory.test.ts)与[真实 Store/Runtime/HTTP](../../tests/isolated/unified-agent/background-directory.test.ts)核完整目录、原轮次、完整原输出／子日志、精确停止和迟到释放。[源码外默认窗口](test/isolated/native-background-bundle.test.ts)与[Electron driver](test/native-background-electron.fixture.ts)核真实默认 task、同父 required 等待、非选中日志、单目标停止及冷 GET。实际结果与剩余资格见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)；当前恢复历史资格不外推默认可信 Shell、旧用户数据库转换或全部平台，持久取舍见[已实施决定](../../.agents/notes/implemented/architecture/2026-10-07-native-background-overview.md)。

## Native Job 完整已保存输出

正式 Native 的 Runtime logs「已保存执行」中，准确 kind=job 的详情提供主动读取、显式刷新和关闭。[页面](src/native-job-output-panel.tsx)保留全部已保存 stdout/stderr/progress、原序号区间与准确 droppedBytes；null 表示该剪裁区间的丢失字节数无法确定。完整是截至首次固定 H 的全部保存内容与缺口事实，不恢复已丢字节，也不表示 Job 成功或实际停止。新输出只在显式刷新后进入新的观察。

[Main reader](electron/job-output-reads.ts)在 GET 前同步核实际选择并登记独立 read ID，绑定 attach generation、viewSelection、historyEpoch、当前 Store、原 originStoreId、Session、Workspace 和原 Job；恢复历史仍沿当前连接读取，fresh Execution 独立核原 id/session/originStore/kind，每页前后复核原 Service 身份。有限 open/next/close [IPC](electron/native-ipc.ts)不接 renderer 提供的 Store、Session、Workspace、游标、路径或执行 authority。单页 512 KiB；公共接口只限 normal rows，过大页先核原身份与完整覆盖语义，再在相同 after/H 下减小 limit，首个响应即使过大也不更换 H；非法页不能借缩小重试被隐藏。合法单条 32 KiB 保存 chunk 的 JSON 编码可通过该预算，不从累计字节或页数裁剪保存内容。

[renderer reader](src/native-job-output.ts)复用公共 [ExecutionOutputPages](../../packages/client/src/execution-output.ts)，严格 Decimal64、max(throughSeq) 与 per-stream 区间核覆盖至 H，跨 stream 重叠 gap 与普通 chunk 全保留；全部成功才发布。错误页、提前 EOF、旧作用域或迟到值不发布前缀。同作用域刷新失败保上次完整事实并标未更新；H=0 为空输出。关闭输出、折叠原详情、切换选择、观察 reset 和释放只 abort 所属 GET，零业务取消或重新执行；普通 controller viewGeneration 更新不重新读取。精确停止仍沿已有原 caller journal，冷读不重建 JobHandle。

[Main/IPC](test/native-job-output-reads.test.ts)、[实际 DOM](test/native-job-output-panel.test.tsx)与[公共覆盖校验](../../packages/client/test/execution-output.test.ts)核完整分页、首 H、大页缩小、合法重叠缺口、原身份与迟到读取。[完整 Native 窗口](test/isolated/native-job-output-bundle.test.ts)和[driver](test/native-job-output-electron.fixture.ts)用公开 Runtime 与显式 Full Shell 产生真实持久输出，再由搬迁、删除构建源的默认 Native/Service 冷读；准确资格与原失败见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07正式-native-job-完整已保存输出)。这份历史 cold consumer 证据单独不赋予默认新 Job producer 资格。当前 macOS 默认新建 Job、准确停止及 Main/Service fault 的完整用户路径已由下段验证；其他平台、全局资源与阶段退出依赖仍见 [P5 当前范围](../../docs/plans/unified-agent-refactor-v1.md#30214-native-默认宿主-shell-完整用户路径)。

[默认 Shell 生命周期窗口](test/isolated/native-shell-lifecycle-bundle.test.ts)与[真实 driver](test/native-shell-lifecycle-electron.fixture.ts)将搬迁 Native/Terminal 真实安装、删除全部原输出后，沿 `<prefix>/bin/kite-desktop` 启动生产默认 Main/Service/网络和宿主 Shell，仅普通配置选择 compatible Model 与 shell.launch；页面实际信任 Workspace、选择 Full 并发送任务，没有 configure/Job/权限/host fixture 注入。三个原 Job 各保 stdout/stderr 198000 字节完整 Unicode；父 Run 完成后准确单项停止保另一项运行，持久 processTreeStopped 与原 PID unique/version、不同 process group、真实 orphan 和所属 coalition 空证明分别核对。Main SIGKILL 沿默认父 EOF 收尾所属 Service；Service SIGKILL 后 guardian 仍清空本次 Job 全树，原持久 running 不被改成已停止。两次冷开保同 Store/Job/输出与游标、GET-only、零 Model/效果重放。真实进程持两层使用锁；Service 崩溃但 Main 仍在时卸载仍 busy，全部退出后两层可独占，成功卸载保 Core/Native DB/config 原 inode 和完整字节。外部 producer 逐批等待只读持久输出回执，测完整用户路径而非突发吞吐；退出瞬间身份不可读保持未确认并有界等实际 ESRCH。准确冻结、原失败与当前完整默认门禁见[安装入口进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08默认-shell-实际安装入口与保数据卸载)。这份 macOS 安装路径证据不外推已发布 predecessor、全部安装故障、全 Runtime 全部后代/资源、8outer/60分钟、独立审查或 Windows/Linux。

[原生观察器](test/native-shell-observation.fixture.ts)在任何候选进程启动前保存既存进程的 kernel unique/version。路径不可读时，仅相同 incarnation 或明确异 UID 可排除；PID 复用、exec 版本改变及身份读取失败仍未确认，已读为所属路径也不能被既存快照排除。libproc 读不到部分僵尸的 UID 时，最多一秒的只读 `ps` 仅补充当前 UID 分类，不提供信号身份或 absence 证明。最终扫描必须同时无所属身份和未确认项，才记 cleanup confirmed；[反例](test/isolated/native-shell-observation.test.ts)覆盖这些范围。信号始终核原 audittoken PID/version；原 coalition、原进程 absence 与 25 秒观察期限保持。

## Native Skills 只读目录

普通列表和详情保留名称、描述、来源、可用状态与能力缺失原因，移除完整读取／工作区 ID 底注、可信配置／权限机制说明以及配置 ID、版本摘要的技术详情。完整分页、原条目身份与失效恢复仍由内部观察核实，不能以删文案省略读取。

正式 Native 全屏设置左侧的 Skills 分类是用户级全局目录，无需创建或选择 Session／Workspace，只展示用户配置及可信用户／Profile 位置的名称、摘要、来源与可用／禁用／不可用状态，不合并项目配置。[Main reader](electron/skill-catalogue-reads.ts) 封存实际 attach generation 与 Store，使用 `user_skill_catalogue` capability 和 `listUserSkills`；open 只接收 generation/read ID，open/next/close 不排队在 controller refresh 后。Main 保存原 revision/cursor，每页限 128 KiB，关闭、连接或 Store 身份变化只中止所属读取。切换 Session、观察 epoch 更新和移除 Workspace 不释放用户目录。[IPC](electron/native-ipc.ts) 不接收 renderer 提供的 Session、Workspace、路径或执行 authority。

[完整读取](src/native-skills.ts)复用公共 Client 的闭合用户页 verifier，穷尽同 revision 后才发布，无总目录截断。目录列表与 MCP、提供商复用标题、列表行、状态标签和控件样式；条目详情通过 `panelHost` portal 到应用最右侧的共享 [RightSidebar](../../packages/ui/src/desktop/RightSidebar.tsx)，`editorControl` 接入设置壳的分层 Escape。关闭恢复入口焦点，移除条目后回到刷新；身份或目录资格改变立即隐藏旧详情。Skills 仅展示已有状态，没有手动新增、编辑、安装、上传或启停写接口。[页面](src/native-skills-settings.tsx)区分可用空目录与不可用；用户 JSONC 变坏、来源不可用或刷新失败时，保留同身份上次完整目录与详情并说明尚未确认最新状态，不发布新目录前缀。Store／attach 身份改变会清理旧读取和详情，普通会话切换不重开目录。来源只说明已准入的用户配置位置，缺字段说明未记录；页面不读正文、安装或激活 Workflow，不恢复旧 home 隐式扫描。实际 Run 的项目 Skill 选择、信任和执行目录仍走原 Service 合同。

[Main/IPC 测试](test/native-skills-reads.test.ts)与[实际 DOM](test/native-skills-settings.test.tsx)验证无需会话、用户页完整分页、关闭、迟到响应、坏配置保旧事实和 Store／generation 隔离。[默认 Native 候选](test/isolated/native-skills-bundle.test.ts)与[Electron driver](test/native-skills-electron.fixture.ts)覆盖搬迁、删除构建源后的默认 Service／网络装配：306 项经 16 个真实同 revision 页完整展示，用户文件与配置刷新、项目坏 JSONC 隔离、两个 Session 切换后保持相同用户目录、分类关闭重开、冷启动与普通所属 Service 退出。全局设置读取阶段只发 GET；显式切换会话仍有原会话 reconcile，退出后独立公共冷 Store 无 Run/Execution 增长，Desktop DB7 的 model routes／configuration intents 保持零。关闭设置不停止执行。早期 Workspace 目录的取舍见[目录决定](../../.agents/notes/implemented/architecture/2026-10-07-native-readonly-skill-catalogue.md)，仅其只读、完整分页和独立执行授权理由继续适用于本页；当前原窗口复验、真实失败和完整默认范围归[PC 主线](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)。本机 macOS 目录验证不代替完整 Skills/Workflow 或其他平台资格，仍按 [P5](../../docs/plans/unified-agent-refactor-v1.md#3021-当前-native-skills-消费者迁移)核对。

## Native 普通问题与页面草稿

普通问卷使用共享卡片：问题与进度分层展示，整行选项可选择，推荐项显示中文标记，说明按钮保持紧凑；取消与翻页／提交位于同一操作栏。默认作答区不显示 `question · pending`、执行 ID 或原请求 JSON，失败和未知答复仍保留中文状态及原命令查询。普通页不在输入框上方重复显示 `轮次：failed`；历史上下文来源错误显示可读原因，原代码保留在失败记录中。

根 `desktop` 选择的 [Native renderer](src/native.tsx)实际消费共享 Questionnaire；默认 ask_user 的多题选择、自由输入、先浏览后一次提交和显式取消问卷均沿公共原 `interaction.answer`。取消只提交原 schema 的 null，后续 Model 在同一 Run 收到取消信息；所选会话存在 pending question 时，隐藏主输入表单及原命令、原申请或 active Job 的任务停止按钮。主输入草稿仍由页面原状态保留，回答或取消后的交互终态恢复原文；跨会话的未发送文本按原 Store／Session 页面缓存保留，已有私有草稿沿原读取链恢复。普通界面移除“保留草稿”，不新增自动持久保存。未知／失败回答保留原意图，只查询原 Command，不再次 POST。

renderer 的页面 Map 分别保存步骤与 JSON fallback 草稿，身份固定 Store/source/presentation Session/id/revision/inputDigest。切换会话、新建会话及待决后页替换不会搬移或清理原草稿；读取失败和卡片未出现在 bounded pending 页也不证明终态。Main 已核准确 accepted answer_saved 回执时只清原键，观察到同原卡的新 revision/inputDigest 或非 pending 状态时才清理对应旧键。关闭页面进程不保证未提交问卷草稿恢复，持久原 Answer journal 仍负责未知回执。

隔离测试中的“保留草稿”只保存原Main私有主输入，不要求业务History已经完整读取，不向 dev／prod 显示。已受理的原保存版本被消费后，下一次显式保存先读取并核对同一草稿身份、范围、空正文、准确后继修订及Main已提交的原Command／修订消费凭据，再同步 CAS；不凭受理回执或空正文猜测修订，其他写入者保存非空或空正文均保留原冲突。凭据缺失或被有界缓存淘汰时保守保留冲突，普通重新进入会话可读取实际修订。读取不替换后续输入，切换视图或退出后的迟到成功／失败不继续保存或污染新视图；当前读取失败和实际保存失败仍显示。[发送与保存回归](test/isolated/native-new-conversation-dom.test.tsx)覆盖立即／未知后确认、后续编辑、独立清空、保存竞争与迟到范围；[真实私有库回归](test/isolated/native-prompt-draft-store.test.ts)另核提交失败不发布消费凭据、冷读、保存失效和缓存上限。原保存调用显式不依赖History，原pending防重、generation／Session／revision CAS及迟到scope更新guard保持；发送／回答等原业务操作的门禁不变。[原完整读归属DOM](test/isolated/native-read-ownership-dom.test.tsx)核普通界面无按钮、无保存请求，显式测试模式仍在History GET held时保存准确原文，迟到A回执不改B草稿／修订且零业务提交。此前原macOS问答整窗口的全部流程／断言／10秒读取／45秒driver／120秒整例证据及原完整默认真实失败归[当时进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13统一回归发现的-native-私有草稿保存)。

[页面 DOM](test/native-questionnaire-dom.test.tsx)核会话隔离、遗漏页／读取失败、未知一次答复、准确回执只清原草稿，以及 question 隐藏主输入并在终态恢复原文；[实际完整 Native 候选](test/isolated/native-questionnaire-bundle.test.ts)与 [Electron driver](test/native-questionnaire-electron.fixture.ts)核搬迁、删除构建源后的默认 Service／compatible Provider 窗口流程，末页主动提交前零 HTTP Answer、原 ID／文案和自由原文、问卷取消后原 Run 继续，以及所属 Service 真正退出后的冷 Store。该 fixture 仅暂存各原 Run 的首个 Provider 响应，沿既有“保留草稿”准备并读取准确主草稿后释放；实测答复／取消均隐藏主输入再恢复原文，没有新增 Model 或重答。首次发送等待实际 Renderer 权限与历史就绪，并核一次真实 form submit；[原 Native bundle driver](test/native-bundle-electron.fixture.ts)复用这项界面观察，原制品、独立审批与退出断言保持。实际运行结果与限制归 [进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，不由组件或单个窗口测试推导全部 P5、三平台或签名发行资格。

## Native 计划入口与完整审核

显式自动测试模式的主输入以“先审核计划”明确选择本次任务，选择本身零业务 POST；普通启动及 `desktop:dev` 不提供此辅助选择。idle 保存原 `run.start`，活动任务保存准确 `afterRunId/contextSelectionId` 的 `input.follow_up`；两者只带闭合 `builtin.planning@1 {mode:'plan'}`，不改变当前原 Run。选择按原 Store/Workspace/Session 隔离，已知正回执后复位，失败或未知保留。默认 Service 负责装配原 Run 计划义务与必要条件，调用者不自报只读定义或批准权。

共享 Plan 面板显示准确当前版本的完整正文、步骤和原材料，Auto/Accept Edits 只取实际 offered modes 且不默认选择。修改要求作为原反馈由真实 `planning.review` ToolResult 交给下一 Model，新版继续独立审核。拒绝本版不是取消原任务；明确原申请取消仍走原 Command。所选会话出现 pending approval/question/plan_review 时隐藏主输入，终态恢复原主草稿；Plan/approval 保留原任务停止入口。取消原 Run 不撤销已有事实，已派发 review 的未知结果及退出提示继续保留。

页面 Plan Map 保存 Store/source/presentation Session/id/revision/inputDigest 的模式和反馈，与 Question、主草稿各自独立。准确 Main accepted answer_saved、实际同原卡替换或非 pending、以及精确原 Run 已观察 cancelled 才清对应原键；遗漏 bounded pending 页、读取失败、Promise resolve 不清草稿。完整页面刷新或退出不保证未提交 Plan 草稿恢复。

[Main 原附件 reader](electron/interaction-attachment-reads.ts)只打开当前视图实际 offered card 的公开原身份，复用 controller 与 SDK 的完整 Artifact/hash/UTF-8 证明。renderer 经 [64KiB reader](src/native-interaction-attachment.ts)核 scope、原 size、完整 EOF、SHA 和 fatal UTF-8；Main 在原视图完整传输至 EOF 前另拒绝回答。close 只释放读取，当前完整证明保留；选择或网络释放清证明，迟到正文不改绑。Native `viewSelection` 区分同 Session 重选，`historyEpoch` 隔离观察流 reset，renderer 同时撤销旧正文资格。普通同作用域刷新中止旧在途读取，保留已经完成且仍实际 offered 的准确 key；失败期间拒绝操作，恢复后重新核原卡，不清反馈草稿。无任意 Artifact、路径或 Runtime 端口。

[页面 DOM](test/native-plan-review-dom.test.tsx)、[读取边界](test/native-interaction-attachment.test.ts)与 [显式输入](test/native-input.test.ts)核草稿、主输入独占、原取消清理、未读取/部分读取不得回答和闭合 Plan 意图。[实际候选](test/isolated/native-plan-review-bundle.test.ts)与 [Electron driver](test/native-plan-review-electron.fixture.ts)已在本机 macOS 核搬迁并删除构建源的默认 Service/compatible Provider、真实两种执行方式、原反馈 v2、独立管理/File 许可、拒绝/取消、正常所属 PID 退出与冷 Store。普通 Plan Model 保 Planning 目录；Auto 专用 reviewer 按实际 `authorization_review` 用途及原 Store/Run/Files Execution 核空工具目录，不借计划批准跳过独立人工审批。Driver 在独立 Files 回答后等同一原审批 submission 已 accepted 且原卡不再 pending，再进入严格 Planning 管理 helper；仅回执接纳不足以证明 Main 视图交接完成。计划卡的正向读取还须核同一原 Store、Main 当前视图已结束刷新且权限观察可用；给定原 Run 时卡必须仍属于该 Run，不把旧只读卡当作读取就绪，也不重试已经进入的附件读取。原身份、全部断言和等待预算保持，实际结果与原失败保留见 [进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11默认-task-完整回归的父子时序)。退出 unknown 提示的明确选择由严格一次性的测试 dialog 端口返回，不代表 macOS 原生 modal 点击资格，生产 guard 不被替换。该窗口不推导全部视觉、设置、平台或 P5 退出。

计划窗口driver切换会话后还须等准确Store/Session权限范围、信任及渲染revision就绪，再选择模式。已是Auto时核模式、revision与原申请列表不变，不声称新保存；需要变更和首次显式选择仍通过原radio/保存按钮，核唯一原申请及applied回执，unknown不重投。2026-10-20默认第15轮的disabled按钮原失败保留；修正测试前提后的完整Electron文件1pass/316断言，不改变生产disabled规则、等待预算或上述计划/Files断言。

公共入口同时导出 [DesktopInput](src/input.README.md)：调用者在发起意图时固定准确 Session/Store/Run/context/command，start、steer、follow-up 和精确取消不随选择视图漂移；未知回执只查原命令。读取经共享 SDK 核实 public input 对应的实际 business command 和 Run；尚未解释的 steer 不因原目标 Run 结束而冒称完成，澄清或只读观察的 Model 也不投影为业务 Run。所属 observer 的释放只停止查询与 callback，已有执行继续。[意图单元测试](test/input.test.ts)与[实际配对子 Service](../../tests/isolated/unified-agent/desktop-input.test.ts)分别核实这些边界及原身份保真；本轮实际执行证据归[测试入口](../../tests/README.md#子-agent-协作-v11-验证)。

可移植公共入口只依赖 Client、UI 与 React；新增显式原生入口在 main 侧使用 Agent profile 与 Service paired。根 `desktop` 已选择新完整 Native 候选，旧 kite-desktop 不参与正式/default/CI 调度。完整视觉保真、跨平台与发布资格仍按实际证据核对。

[controller](src/controller.ts) 接受主进程适配器提供的 admittedClient，选定 Session 后读取真实 snapshot 与通用 Query 视图。每次选择创建 viewGeneration；迟到旧响应可进入按数量及字节约束的对象缓存，不能覆盖新选择，旧请求错误也不能停止 Service。单条 SSE 与页面选择独立；切换视图不取消执行。

通用动作来自当前视图的原 public envelope。调用者可用 UI schema 表单明确修改输入；controller 固定该次 intent 的 Session/Store/definition/commandId，通过 Client 和 Service 校验，不随视图切换重绑定。`lastActionIntent` 保留最近一次明确动作的原 Session/Store/command 身份；回执未知时可查询原 command，不自动重发。`DesktopPublicViews` 只消费公开视图与宿主回调，没有扩展业务类别特例。

`disposeNetwork()` 中断客户端网络并使旧 generation 失效，保留已确认 snapshot；不调用配套服务停止。`stopPairedService()` 是显式 main 生命周期操作，通过独立注入回调实现，不在组件卸载或旧请求失败时触发。

验证：`bun run --cwd apps/desktop typecheck`、`build`、`test` 与根 [thin-clients](../../tests/isolated/unified-agent/thin-clients.test.ts) 真 HTTP/SSE 测试。P5 的完整 Electron sender/preload 隔离、真实窗口、平台权限和旧 UI 迁移继续由该阶段负责。

P3 `DesktopSnapshot.interactions` 读取根 Session 的实际 pending 页（最多 20，`interactionsAfterId` 显式保留后页指针）。`answerInteraction` 在点击时封存 Interaction 原 Store、presentationSessionId、ID、revision、answer 与新 commandId；重复调用共享同一在途 Promise，视图切换不能改绑。一次回答最多发送一次，错误保留原 pending 请求与已保存意图，未知回执用 `lookupInteractionAnswer` 查询原 command，不自动重放。当前 controller 最多保留 128 个回答 intent，超过范围明确拒绝，而不丢弃未决身份。

`interactionSubmissions` 与 `DesktopAnswerSubmissions` 可在选择区外保留回答面板；宿主应在视图切换时仍渲染该面板。接受命令与 `acceptedDecisionRevision`/实际执行结果分别显示。`DesktopInteractions` 的 callback 缺席时只读，不向 UI 传 token、Owner 或 server 类型。真实 SQLite/HTTP 测试位于 [CLI Interaction integration](../cli/test/interactions.test.ts)，覆盖 opt-in 批准与 question、非交互等待、重复提交和切换视图；controller 测试另覆盖丢失回答回执只查原 command。上述便携 HTTP 证据不单独建立 Native 窗口或完整 P5 资格；本页问卷与计划专题分别记录已交付的实际 Native 消费范围。

便携 Context controller 在 capability 可用时读取第一页 `snapshot.context`，`loadContextPage()` 固定原 selection、highWaterSeq 并独立推进消息与来源两个 cursor；一个流结束后不会从头重复，消息结束固定 afterSeq=highWaterSeq。`rewindContext(boundary)` 只接受本代次已读取有界页中的实际 complete 消息的精确 ID/seq 或 null，Service 最终核对完整 Tool 配对。`includeHistoricalResult(execution, scope?)` 绑定当前实际历史 Job 的原 ID/resultRevision；活动 include 必须提供点击时封存的 Store/Session/selection/targetRunId envelope，缺准确原 Run、出处或 revision 时本地拒绝；这两项保存原 Session/Store/selection/commandId，不自动创建 Run。Rewind 的活动或 outcome_unknown 执行仍在本地明确 input_busy；include 在准确活动 Run 上只排队，原 accepted/result_queued 显示 queued，checkpoint 后原 Command applied 才显示已纳入。最终 Store 仍核原目标，视图切换和未知恢复不改绑。

同一 intent 的重复提交共享在途 Promise，最多保留 128 个原 intent；失败和未知不重发，`lookupContextIntent(commandId)` 只读核对原命令。`contextSubmissions` 可独立于选中视图保留；`DesktopContext` 将这些状态和原出处展示，未知提交保持写入操作禁用。回执已 applied 只证明 selection/source 事务落定。正式 Electron/DOM/P5 资格不在此切片范围。

控制器最多保存当前选择 4096 个已读 complete 消息边界身份；超过时局部拒绝 context_boundary_limit，不把截断页声称为全部历史。


plan_review 复用原 Interaction 的封存回答意图；controller 在保存前验证实际已显示请求 metadata、请求明确提供的模式与反馈长度。不会从调用者替换的描述、自报 Full 或未知字段推导授权。纯校验失败不创建 intent、不发写入请求。答复 accepted 只是原回答命令已保存，Core 决定接纳与后续 Tool 权限另核对；迟到且已保存取消标记的历史答复不能复活原 work。实际 HTTP 测试保留同一已派发 Tool 的 execution/attempt 与原独立审批，重复回答只提交一次。


大人工审批附件由 `DesktopInteractions.onReadAttachment` 接宿主 reader；`controller.readInteractionAttachment(intent,{signal})` 固定原 Store、来源 Session、scope、Interaction/revision 并读取完整核实正文。回答前必须有同一当前卡身份的读取证明；验证集合只保存当前卡身份，不保存正文。视图切换/网络释放中止读取并清除证明，迟到加载不能应用到新视图。保存回答仍走原封存 intent/commandId，未知回执只查原 Command。

[test/large-attachments.test.ts](test/large-attachments.test.ts) 用实际大 Auto 附件、SQLite/loopback HTTP 验证迟到加载跨 Session 切换不能批准、重新完整读取后原回答只派发一次。共享 UI 另有实际 DOM/键盘测试；本便携控制器不建立正式 Electron sender/preload、窗口或 P5 资格。

便携权限入口由 `DesktopPermissions` 与 controller 提供。capability `permission_controls` 缺失时局部只读；子会话只显示根权限。新模式仅提供请求批准（`accept_edits`）、自动审核（`auto`）、完全访问（`full`）及 `makeDefault` 的明确用户选择；类型、HTTP/IPC 和持久控制仅接受这三种策略，旧 `ask` 明确拒绝，不作兼容映射；信任确认展示实际读取范围、工作区与范围摘要；信任不批准任意操作。读取结果固定观察身份，保存时封存原 Store、Session/root、Workspace、CAS 版本与摘要。同观察只允许一个选择；同在途选择返回同一 Promise，切换后的旧 callback 不会改绑。最多保留 128 个 intent，冲突保留原选择，显式重新读取后才可再次选择；未知结果只用 `lookupPermissionMutation` 查原 command，不重发。网络释放仅停止客户端网络，不停止 Service 或 Run。

Desktop／Native 的控制事件匹配同时使用真实 Store、所选 View 的 rootSessionId／workspaceId 和 applied receipt。根模式变更刷新当前 child 的继承事实，明确 makeDefault 更新其他根的默认显示；foreign root／Workspace 不触发无关读取。首次 child View 已返回但 mode/trust 尚未完成时，也保留同 generation 的已核 scope 识别根事件并安排重读，切会话即撤销该 scope。[权限观察回归](test/native-permissions.test.ts)通过两种 caller 的真实观察回调核这些事件、首次读取竞态及旧 child 回包晚于切换的隔离；不将其计作 Electron 原生窗口或其他平台资格。

### 2026-10-22 紧凑审批与队列窗口验证

`540e5db008` 加本轮未提交差量，macOS／Bun1.4.2／Electron44.3.0，执行 `bun test ./apps/desktop/test/isolated/native-live-permissions-bundle.test.ts`：最终新构建1项／20条 Bun 断言及 driver 原断言通过，34.85秒。源码外搬迁候选固定 `testDiagnostics:false`，使用隔离 HOME／Profile／Workspace 与受控 loopback 模型；12次模型请求含2次 Auto 审核，原权限场景0人工答案。主及已运行 child 保原 Run／准确目标，已派发 Shell 不被收回，待批及下一原工具按最新根 revision7 复核后各执行一次；普通待批可直接切 Auto，独立 HTTP 同步本次约72ms，仅为单次观察。

同一候选核单卡分页、主名称隐藏、稳定子图标、卡片不高于112px、普通审批与输入共存、Shell 单行省略与原生 hover 全文。独立队列阶段仅对原 Shell 工具批准一次，之后按 Full 复核后续 Job；3条真实 pending Markdown 经拖拽实际改变服务顺序，删除和编辑精确撤回原 ID，完整原文回填且没有取消／恢复或自动提交，手动提交生成新 ID 并逐字核原 Markdown。队列编辑期间原 Shell id／attempt／cancel 事实不变。同 scope 观察刷新后原 preview DOM 的 pointermove 监听仍在，鼠标 hover 展示完整 Markdown；不以 focus 替代 hover 通过。

Electron exit0、所属 Service／后代消失、冷只读事实与两层独占制品 lease 重新取得均通过，成功收尾未发信号。本机证据目录 `dist/acceptance/live-permissions-electron-0a02f1de-a2d6-443a-bc98-faaed9760738` 保留 report、provider、日志和截图；早期依赖／夹具失败与修复前队列 DOM 重挂失败保留在各自证据目录，不以最终通过抹去。该受控本机结果不取得付费 Provider、其他平台或签名安装资格。

另执行受单卡分页影响的[既有双 child 整窗口](test/isolated/native-collaboration-bundle.test.ts)：同一本机新构建并核 digest 的候选复用后1项／12条 Bun 断言通过，17.18秒。保留双 child 的独立批准／准确停止、同子 Session 新 Run、旧答案与旧 carrier 停止拒绝、停止后迟到答复拒绝，冷启动仍15次模型调用且零重放，清理 observed／forced／remaining 均为空。driver 只增加精确审批翻页及停止前按实际展开状态重开既有“会话工具”；候选复用仅属隔离测试 runner，不向普通客户端开放。

### 2026-10-21 运行中权限窗口基线

以下是本轮审批浮卡／保留输入区／真实队列实施前的历史窗口证据；当时的隐藏输入和审批列表布局已由上面的当前实现替代，不能作为新界面验收。

[真实运行中权限窗口](test/isolated/native-live-permissions-bundle.test.ts)与[Electron driver](test/native-live-permissions-electron.fixture.ts)构建 `testDiagnostics:false` 的源码外搬迁候选，使用自有 HOME／Profile／Workspace、受控 loopback 模型、正式 Shell 与显式配置启用的外部文件工具。主、child 的两个真实 Shell Job 保持运行时，普通 UI 切请求批准，再由独立公共 HTTP caller 切 Auto，窗口无需刷新或重选即同步标签；切回请求批准后，两个原 Run 的下一外部写入均保持未派发且文件不存在。当时根待批隐藏 Composer，主／child 两项只显示一个审批面板；独立 HTTP 改 Auto 后两目标分别真实审核、旧卡 cancelled 且无答案，改 Full 后原目标各派发一次，dispatch read-set 使用最新根 revision，输入恢复即显示 Full。子详情经生产导航展示准确待批与终态，实际 selection 仍为根，不以此冒称选中 child 的 IPC 路径也已验。

2026-10-21 macOS 26.7.1／Bun 1.4.2／Electron 44.3.0，`2a5cd0cca` 加本任务工作区改动：上述整窗口最终1项／17条 Bun 断言及独立 Node／DOM 断言通过，25.14秒，实际10次模型请求中含2次 Auto 审核。两项原 Tool 的同 Session／Run／attempt1、最终根 revision7、准确外部文件各一次与零人工答案共同核实；独立 Auto 回执确认到可见且 busy 撤销本次约64ms，只作为单次观察。原 Electron exit0、所属 Service／后代消失、冷只读事实与两层制品独占租约重新取得均通过，成功路径清理未发信号。合并面板及原审批／输入／环境信息四个 DOM 文件10项／111断言、根八 workspace typecheck、定向 Biome 与文档检查通过。首轮子详情错误等待环境卡文案的失败保留，driver 改等实际详情“等待人工审批”；没有改变产品文案、审批期限或隐藏输入行为。此证据使用受控模型端点，不代表付费远端、签名安装或其他平台资格。

[test/permissions.test.ts](test/permissions.test.ts) 使用真实默认宿主、SQLite 与 loopback HTTP，验证三种正式 API 模式/default及旧 raw ask 明确拒绝、信任/撤销、竞争 CAS、未知回执及跨会话重复抑制，业务执行数量保持零。另有局部 capability/child 投影测试；共享 UI 的 [实际 DOM 测试](../../packages/ui/test/permissions-dom.test.tsx) 覆盖键盘与迟到卡片切换。这些证据属于便携调用者，不代表正式 Electron 或 TUI 制品已完成。

新的显式原生入口位于 [electron/main.ts](electron/main.ts)、[preload.ts](electron/preload.ts) 与 [native renderer](src/native.tsx)。这是现有 portable controller 的实际 Electron 宿主；根 `desktop` 已选择此新 Native 入口；旧源码仍保留，完整 UI 能力及发布资格尚未退出，无旧协议 fallback。main 独占公共 NativeClient、配对 Service、预选 profile、观察流和意图；renderer 只有封闭的 `kiteNative.request/watch`，不接收 token、profilePath、Runtime 或任意 HTTP/IPC 通道。窗口 sender 必须是原 webContents/mainFrame 与实际制品文档，子窗口与旧 frame 不能提交。单 IPC 请求最多 1MiB、响应最多 4MiB，消息页最多 200，renderer 当前消息视图最多 4096 条/8MiB；超界只拒绝该次读写，不关闭服务。

非development的renderer构建显式固定 `esbuild.jsxDev=false` 与 `process.env.NODE_ENV=production`，不继承Bun test等调用进程的测试／开发模式。Vite开发服务器保持原开发管线；显式隔离制品的 `testDiagnostics` 常量独立控制诊断入口，不因生产React模式失效，也不由NODE_ENV开放普通客户端。原[child-stream窗口测试](test/isolated/native-child-stream-electron.test.ts)另核真实renderer字节不含React的 `runWithFiberInDEV` 或开发act提示，然后执行原窗口及资源门禁。取舍见[构建模式修正](../../.agents/notes/implemented/bug-fix/2026-10-21-native-renderer-production-build.md)。

[build-native.ts](scripts/build-native.ts) 的开发入口仍为 `bun run --cwd apps/desktop build:native --assets /absolute/trusted-assets.json --outdir /absolute/distribution`。`buildNativeDesktop` 把显式 Service JS、Bun executable、实际 SHA/build/API/capabilities 和可选 disposable profile 标为 development；这条兼容 API 不代表完整发行闭包。main/preload 是 Node CJS，renderer 是浏览器 ESM；实际 HTML/preload 从 `app.getAppPath()` 读取，不能使用构建器固化的源码 `__dirname`。

完整候选使用同文件的 `buildNativeCandidate({terminalRoot,electronDist,outdir})`，输入是已核实的新 terminal bundle 与实际安装 Electron dist，输出目录必须全新且不在输入源内。`terminal/` 原完整 Service/Bun/npm/Worker/监督/baseline/Web closure 独立验证；`app/` 固定 main/preload/renderer/html/package 与两个可信 helper，`electron/` 保存实际 executable、Frameworks 和 resources。公共 [Native verifier](../service/src/native-runtime-assets.ts) 固定 platform/arch/Electron version、inner manifest SHA、完整 file size/SHA/mode 与有限内部 Electron links。原 Electron 空 locale 目录通过必带 `directories` 精确声明，缺失、移位、新内容和未声明空目录都拒绝；builder 不删除原安装内容。`.use-terminal.lock` 在发布前建为空 0600、nlink1，单独列入闭合 inventory，不忽略任意 dotfiles。manifest 与 SHA 是未签名完整性证明，不证明发布者身份。

candidate Main 只接受固定 `{kind:'candidate'}`，从实际 appPath 推导原 root 一次，核实际 executable 就是内嵌 Electron 且运行版本相等，不退回开发绝对路径或 PATH。Electron 会把 `.asar` 展开为虚拟目录，因此只在同步完整物理验证期间暂设 `process.noAsar`，finally 恢复原值；不把 archive 内虚拟目录当发行资产。无显式开发 Profile 时，source 与 installed Main 都选择 `~/.kite-code/unified-agent` 的 `default`，与新 terminal 一致，不发现、转换或接入旧 Electron userData/旧配置/数据库。

[POSIX Node artifact lease](electron/artifact-access.ts)通过原 FD 与 [one-shot Bun helper](electron/artifact-access-helper.ts)消费公共 inherited-artifact 端口。Main 保留 outer 与 inner 的两份 shared lease；helper 只关闭自身继承副本，不 LOCK_UN，不授 Profile 或执行权。准确 `native.candidate` proof 通过现有 paired stdin 交 Service，Service 自持全部 roots 的 lease 并将完整 roots 交默认保护。退出先关闭 caller、私有数据库/Profile lease、所属 child，最后才释放 Main artifact FD；Main 强杀后 child 仍持两 root，child 已终止才可独占。安装/归档/升级工具负责先取得全部 exclusive lease，再操作不可变候选；这些工具的资格由其 owner 单独记录。

Windows 的[Node-API 后端](native/windows-access/README.md)由 Main 和 Service 各自取得 LockFileEx SH，不借继承 HANDLE 授权。私有 UI prepare 保原 Profile/UI 目录与主 DB HANDLE、volume/FileID，SQLite关闭后再释放，sidecar不永久钉名称。正式 candidate Main 已接 installed C→compiled verifier→Electron 原创建链：父 verifier 完整 pin 先于 addon/Main/preload 加载，Main 核两跳 kernel PID/原 FILETIME 证书后取得自己的 full outer/inner pins及双 SH，再准入窗口／Profile／SQLite／Service。没有交接仍 `native_windows_bootstrap_unqualified`，伪造匹配 marker 或 PPID 不授权。完整构建、选择、登记和维护入口源码范围归 [Native release](docs/native-release.md#windows-managed-native-当前实现)；原强制负例、Windows MSVC／DACL／pipe／Electron ABI及完整用户链仍须原生验收，类型和POSIX邻接不放行平台资格。

正式 installed Native 已补齐本机两个真实代码候选的 A→B→A→B 冷启动验收，区别于同源码版本标记测试。默认窗口保原任务、完整正文与持久 caller 记录，回退后继续工作实际使用 B 全文；四次所属 Service 普通退出、两层租约释放及指针切换/卸载的数据保留均核实。完整负责范围、真实旧 builder、失败与平台限制见[Native 发行 owner](docs/native-release.md#真实代码升级与冷回退)。窗口读取兼容前驱的 `assistant 消息` 与迁入原 Conversation 后的 `助手消息` 名称，仍核相同原消息数量、完整正文及零重发；当前实际范围归[PC 主线](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)，不据此宣称已发布旧样本或三平台完成。

[实际内嵌 Electron 候选](test/isolated/native-bundle.test.ts)使用真正 terminal builder 和本机安装 Electron dist，搬迁后删除原构建输出、独立 HOME/PATH、无 Service 源码或 npm 回退；原默认 Profile 的 Files.write 经实际 approve_once 一次完成，Provider 为 2。正常退出所属 child PID 消失，两 root 可独占；冷重开只读不增 Provider。第二窗口用精确所属 child SIGSTOP 固定有限观测，再 SIGKILL Main，实际 Service 仍持 outer/inner 两锁，SIGKILL child 后才释放；这不是生产暂停、自动恢复或所有进程树场景的证明。[公共 Node verifier](../service/test/isolated/native-runtime-assets.test.ts)另核原 SHA、完整内层、空锁、闭合 schema、模式/字节/硬链接/逃逸链接与空目录负例。最终候选及原 Files/Session Electron 邻接为 4 文件、6 项、55 条 Bun 断言全通过（68.65 秒，2026-10-04），包含真实 driver 独立断言；Desktop/Service types 与 Service build 通过。

首实际构建因原 Electron 空 locale 未声明而拒绝；第二轮定位 Electron ASAR 虚拟目录差异，第三/四轮有限 driver 的失败清理等待退出确认，第五轮卡已经可见但 main 新投影暂空。保留所有失败日志；最终 observer 在原 10 秒内等待准确 pending card，失败清理只限所属进程，没有放宽权限、执行 deadline 或伪造成功。这些资格只覆盖 macOS arm64、Electron 44.3.0、Bun 1.4.2 的隔离候选；旧正式 launcher 切换、安装器、签名/公证、Linux/Windows 及完整 §35 由各 owner 单独闭合。

main 的私有草稿由 [private-data.ts](electron/private-data.ts) 使用实际 Node `node:sqlite` 保存，固定在启动前预选 profile 的 `desktop-private/data.sqlite`，renderer 不能提供文件路径。目录要求所属用户与 0700、文件 0600，拒绝符号链接和文件硬链接；格式与 application ID 未知、损坏或打开失败时只报局部 `draft_storage_unavailable`，保留原字节，不以空库覆盖。正文 JSON 编码保留 NUL 和原 UTF-16 文本。显式保存按原 Store/Workspace/根 Session 与修订进行 `BEGIN IMMEDIATE` CAS，SQLite 私有事务锁等待有界，FULL 同步与原子提交由 Node SQLite 完成，不依赖 Bun main 或业务 Store。

草稿每份最多 1MiB，包含 envelope 的 IPC 请求仍受原 1MiB 限额；没有按总数量或总字节静默淘汰用户草稿。列表每页只读取最多 100 份元数据，正文另按原 opaque ID 读取。冷应用重启后恢复已保存原文与修订；Store 替换或 Session 删除后保留原文本，在“读取已保存草稿”中说明原关联不可用，不将其放入同 ID 新会话。本文仍需用户明确保存，尚未保存的编辑器文本不声称跨冷进程恢复；没有隐式发送或重新绑定。

会话创建在私有库先保存原 commandId/sessionId/Store/Workspace/title 意图，再仅发一次公开 `createSession`。同 ID 同输入共享在途请求；冲突拒绝，pending/unknown 冷恢复仍只核实原 `getCommand`，核对其原身份、实际 applied 与 Session 事实后才显示已确认，不重发 POST。结果错误或未知保留既有草稿；新建空会话不搬移或删除其他会话文本，私有意图不是核心命令权威。发送、回答和权限选择继续复用原封存 intent。刷新、卸载和网络释放仅使 renderer generation 失效，所属 Service 与执行继续。

窗口关闭隐藏；明确退出由 main 读取实际活动事实后确认，先释放 caller 网络、私有 UI 数据库与 Profile lease，再关闭所属 paired Service，最后释放制品 lease。目录和退出检查使用 SDK `listAllWorkspaces/listAllSessions` 穷尽原 Store 的固定上界分页；晚新增由下一次完整读取覆盖，读取失败保持无法核实，不猜空闲。IPC 4MiB 响应预算没有提高，超大目录仍局部拒绝，未声称已经建立原生目录页面分页。

[test/native-caller.test.ts](test/native-caller.test.ts) 证明封闭 sender/输入预算、私有草稿 CAS、旧 generation 拒绝以及网络释放不等于所属 Service 关闭；这些是单元证据。[test/isolated/native-process.test.ts](test/isolated/native-process.test.ts) 用真实 Node→显式 Bun→公开 paired launcher 与新临时 profile 验证私有 bootstrap、身份与 EOF 后所属 PID 退出，制品构建不把宿主资源路径写进 renderer。[test/isolated/native-electron.test.ts](test/isolated/native-electron.test.ts) 使用 Node Playwright driver、真实 macOS Electron、自有窗口/profile 和本机假兼容模型端点，检查实际 main/preload/renderer、刷新执行/草稿、外来窗口拒绝及所属 PID 退出；必须以实际运行结果计资格，不能以 fake port 或启动进程替代。

以下保留早期私有开发窗口的限定基线，正式原页面与安装版的当前范围见[复用原桌面展示层](#复用原桌面展示层)和[发行 owner](docs/native-release.md)。该基线提供完整目录读取、根会话创建、Fork/rename/delete、消息页、新轮次/原命令核实与停止、普通 Interaction、模式与信任及授权目录控制、Model 输入/输出 Inspector、Context Rewind/Include；当时完整设置、附件 reader、Context 导出、发行安装、Linux/Windows 和旧视觉迁移尚未接入该窗口，有大附件但缺 reader 的审批只读。该轮 Node fixture 绑定已构建 Service，实际 Electron fixture 在私有临时目录构建 Service JS，按实际 SHA 与明确 Bun executable 接入；两者使用 workspace 公共依赖，不宣称完整 source-free installed Desktop 制品。该限定新测试组合为 5 项、35 条 Bun 断言通过，实际 Electron 场景另含 14 条 Node 断言与实际 DOM 操作，类型、局部 Biome 与文档结构检查通过。

原生大 Model 输出通过 [main view-read lease](electron/model-output-reads.ts) 与 [renderer reader](src/native-model-output.ts) 接入共享 `ModelOutputMessage`。有 `model_outputs` capability 时才提供显式完整读取；缺能力保持标明的 preview。open 固定当前连接 Store、阅读 Session、Execution、窗口 generation 与选择身份。封存 Message 的来源只从 Main 已观察副本取得；先用公共 `Client.getExecution` 核准确原 Model／Session／Run／originStoreId，再以当前 Store 和原 Session 调用 `Client.getModelOutput`，核封存完整性与计数。恢复后的当前 Store 与原出处分别校验，不重绑 origin；这些 GET 不读取来源 Run 的后来状态。main 最多一个在途读取/正文 lease，不恢复丢失句柄，不创建执行或 spool 权威。跨 IPC 每块最多 64KiB（二进制用 base64），请求必须按准确下一 offset 推进，原 1MiB/4MiB IPC 预算没有提高。close、切换、刷新、网络释放只 abort 本读取和清除正文，不提交 Command 或取消 Model/Run。

renderer 按已核实有限 wire size 接收完整 EOF，严格 UTF-8/JSON 后调用公共 `verifyModelOutputSnapshot` 的生成 schema、canonical body SHA、字节数及 completion 核验，再检查原 Store/Session/Execution/hash，只有当前视图可显示。普通会话不启用 reasoning 展示；正文不进入持久缓存。main 的 SDK 快照与 renderer 的完整正文仍可能各占一份整块内存，不能把有限 IPC chunk 声称为固定内存 streaming。[test/native-model-output.test.ts](test/native-model-output.test.ts) 的有限 port 测试覆盖 >17MiB、offset、hash/UTF-8 损坏、迟到 SDK 返回/取消与旧选择；[实际 Electron 测试](test/isolated/native-model-output-electron.test.ts) 使用私有构建 Service、真实 SQLite/本机兼容 SDK 输出，检查完整 >17MiB DOM 尾、显式关闭、跨窗口/旧 generation 拒绝、刷新只保 preview、模型计数不变与退出原 PID 清理。共享 MessageContent 将长普通文本组织为相邻 Text 节点，保持完整原文、GFM 与原消息列；不裁剪正文或插入额外换行。原 Fork 窗口继续核 `main.innerText` 超过17MiB及准确尾部，关闭／切范围只释放所属阅读，同范围刷新保已读正文；原完整 scope／hash／EOF 和模型计数门禁保持。该组织不把有限 IPC chunk 声称为固定内存 streaming，本轮实际结果归[普通启动进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

本次受影响 Native 组合实测 9 项、71 条 Bun 断言通过；大输出最终 fixture 独立复跑约 36 秒通过，另含 24 条 Node 断言，原基础窗口场景另含 14 条 Node 断言。这是 macOS 开发 fixture 的真实窗口/协议证据，仍不代替完整安装制品或其他平台资格。Desktop 类型、局部 Biome、portable build 与文档结构检查均通过。

[Model](test/isolated/native-model-output-electron.test.ts)与[Fork](test/isolated/native-sessions-electron.test.ts)整窗口的私有[进程 owner](test/native-owned-processes.fixture.ts)沿原 launch／run 阶段，以准确 Node executable、driverPath、自有 root、kernel birth 与 fresh PPID 绑定后代，不按名称清理。已绑定进程短暂 uncertain／死亡过渡仅在共享截止内只读等待，未知或复用 PID 不发信号；正常业务退出仍有已绑定 alive 记录必须失败，即使随后清理成功也不改判绿。身份／绑定／截止错误保留并聚合原业务失败，未确认保自有 root。2秒是共享剩余等待截止，平台同步身份读取可能延长墙钟，不构成绝对2秒清理保证。有限 phase 为准确捕获与失败收尾保留，定位用 IPC／DOM 观察已退役；这份测试收尾不代证整个 Runtime 的资源退出。

[private-data.test.ts](test/isolated/private-data.test.ts) 以实际 Node 子进程验证冷打开、两进程同修订竞争、133 份草稿分页而非淘汰，以及未知格式、损坏行/文件和硬链接局部失败保原字节。[native-drafts-electron.test.ts](test/isolated/native-drafts-electron.test.ts) 使用私有实际 Service 制品、真实 SQLite 与 Node Playwright/Electron：草稿与未知创建意图跨冷应用进程恢复，键盘发起的创建响应在服务提交后被真实 TCP socket 断开，刷新/重启后只核实原命令，该未知原意图的实际 POST 为 1，没有新增 Model 请求。另验证真实 command 冲突的明确业务拒绝保留原草稿，把已停止的临时业务 Store 整份保留再创建新 Store，验证同 ID 新会话输入仍空、原草稿可读且明确关联失效，并逐次核实所属服务 PID 已退出。[实际 React DOM 测试](test/isolated/native-drafts-dom.test.tsx) 另证明晚创建回执不能抢回已切换的阅读视图或移动草稿。受影响 8 文件完整组合为 16 项、112 条 Bun 断言通过；最终业务拒绝及新增边界定向 4 文件复验为 10 项、66 条断言。新私有文件 fixture 另含 23 条实际 Node 断言，新冷启动窗口 fixture 另含 26 条实际 Node 断言。Desktop 类型与局部 Biome、文档结构检查通过；这是 macOS 开发制品的限定资格，未声称完整安装、布局持久化、未保存文本自动恢复或其他平台资格。

原生窗口权限控制由 main 调用公共 Client 的五个有限读写/回执方法，renderer 只提交封闭选择。权限面板展示实际根 Session、工作区读取范围和摘要；诊断面板的模式三选、是否设为默认、信任及撤销保留显式选择，子会话只读。普通 Native 的发送前项目准备沿[当前输入路径](#原会话输入区权限与停止)执行。main 在点击时固定原 Store、Session/root、Workspace、观察修订与摘要，同在途选择仅提交一次。未知结果保留原 commandId 与范围，在切换后也只核实原 mutation；CAS 冲突不自动重试，必须重新读取并再次选择。计划审阅答复不授予这些权限。

当前权限事实读取失败或观察流重置/失联时，main 不再向窗口提供旧的可写权限事实；窗口说明暂不可核实并提供显式重新读取入口。迟到的旧视图读取失败不能禁用或改绑新视图。网络释放与刷新只影响调用者网络，不停止所属 Service/Run；原权限意图在视图外显示。现有能力缺席时保持只读；实际授权目录管理边界见下方独立说明。

[test/native-permissions.test.ts](test/native-permissions.test.ts) 的有限 SDK port 证据覆盖重复在途选择、未知原命令、切换及迟到读取、缺 capability 与子会话只读。[test/isolated/native-permissions-electron.test.ts](test/isolated/native-permissions-electron.test.ts) 则使用真实 macOS Electron main/preload/React 窗口、私有构建 Service、SQLite 和本机兼容模型计数端点，实际键盘保存模式/default、信任/撤销，提交后真实 HTTP socket 丢失只查询原命令，以及竞争修改产生真实 `host_control_conflict`。显式失联读取使写入口不可用，重新核实恢复实际事实；两个原 Session 的 Run 均为零，Provider 请求为零，退出清理所属实际 PID。这是当前开发制品的限定窗口证据，不代表旧正式入口已切换、完整安装制品或其他平台通过。

当前原权限窗口在首次选择与 reload 后进入正式“会话工具”，先沿原核范围／信任动作取得模式操作资格，再执行原模式与默认设置、未知回执原查询、失败读取和 CAS，最后明确撤销信任。并发命令可能先发布 auto 文本，不能以该文本代证显式重读完成；fixture 在原 10 秒撤销预算内先等待按钮实际可用，再执行唯一原 Enter 与原 untrusted 等待，不重试已经进入的动作。按钮可用不保证后续观察不变，Main 的新鲜事实、已消费观察及 CAS 守卫保持。信任与撤销仍各一次，全部原业务断言与期限保持；同一完整文件1pass／1Bun断言、原13处Node断言通过，Provider0、两个会话无Run及所属Service退出均核实。该调用者适配遵守现行未信任只读的页面合同；准确输入和整体资格归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

原生输入检查器复用公共 UI `ModelInputs`，由 [Native Model Input adapter](src/native-model-input.ts) 连接 main 的公开 `listModelInputs/getModelInput`。Model calls 目录按所选原 Session 和固定 upperSeq 逐页读取，每页不超过 200；不会把第 200 条当作全部记录。Runtime logs 中的原 Model 执行可跳到准确 Execution 的敏感内容确认页，跳转本身不请求正文。这组 logs 只展示当前已保存执行的有限投影，不声称已经迁入完整 Runtime 事件日志。

输入与输出复用同一有限正文读取实现，main 每次只保留一种当前正文 lease；打开另一种读取先释放旧 main lease。每块仍最多 64KiB，原 IPC 1MiB 请求与 4MiB 回应预算不变。renderer 完整收齐 EOF，校验 scope、字节数、hash、严格 UTF-8/JSON，并调用公共 `verifyModelInputSnapshot` 才显示原 System、Messages、Tools、来源与实际 adapter/provider/settings、封存装配和最后派发事实。未确认成功的请求保持 unconfirmed，不证明 Provider 接收；没有可取记录时不以当前设置补造。main 与当前视图仍可能各保留整份正文，不宣称固定内存 streaming 或持久正文缓存。

关闭、切换、刷新及隐藏只 abort 本目录/正文读取并释放视图，迟到响应不进入新 Session，不取消 Run 或重发模型。[native-model-input.test.ts](test/native-model-input.test.ts) 覆盖 >17MiB 完整原输入、64KiB chunk、错误 offset/hash、原身份与取消；另用真实 SQLite/Core 的 205 次固定 Adapter 调用，经公开 Native SDK 和窗口 adapter 读完两页并核对最后一次原请求，读取 cursor 与调用数量均不变。这是 205 份实际持久记录的分页证据，不是 205 次远端 Provider 验收。[native-model-input-electron.test.ts](test/isolated/native-model-input-electron.test.ts) 用真实 macOS 窗口和私有 Service 制品，验证键盘从原执行进入确认页、完整输入及实际 metadata、关闭后清除正文、真实 HTTP 响应 barrier 期间切换 Session 后拒绝迟到输入、刷新无新增 Provider，以及退出原 PID 清理。仍不代表旧入口切换、完整安装制品、全部 Runtime logs 或其他平台已完成。

本输入切片最终受影响 Native 组合实测 12 文件、24 项、170 条 Bun 断言通过（约 64 秒）；新原输入真实窗口 fixture 另含 29 条 Node 断言。Desktop 类型、10 个归属代码文件 Biome 与文档结构检查通过；未运行共享 dist 或全 workspace 构建。

原生授权目录由 [main 原观察与意图控制器](electron/permission-grants.ts) 调用公开 `listPermissionGrants/clearPermissionGrants/getPermissionMutation`，通过封闭 IPC 提供实际所选 Session 的页面。分页固定原 upperSeq 和 epoch；下一页 epoch 漂移拒绝，不能将 root 模式事实当作 child 授权。renderer 展示原 Store/Session/Workspace、definition/kind、审批与执行来源和 hash，不显示原命令正文或 bearer。当前主机公共授权规则决定是否允许管理子会话；UI 自身不授予管理权限。

用户明确核对观察到的 Session/epoch 后，main 固定原 commandId/Store/范围与 CAS；同一在途观察只提交一次。未知结果保持原意图，切换后也仅查询原 mutation，不更换 ID 或重发 POST；其他 Session 仍可只读查询。冲突需要重新读取后再次明确选择。读取失败或观察流失效会去掉旧可写目录，迟到响应不进入另一视图。清除不启动 Run/Model、不撤回已执行效果，组件卸载及网络释放也不停止所属 Service。[main 范围测试](test/native-grants.test.ts) 和 [共享实际 DOM 键盘测试](../../packages/ui/test/permission-grants-dom.test.tsx)覆盖精确原 child 范围、观察漂移、缺 capability、重复提交与 late 结果。

[实际 Electron 授权目录测试](test/isolated/native-grants-electron.test.ts) 从真实临时 SQLite/Core 已接受的两份 `same_command` 授权启动私有构建 Service 与窗口。实际键盘清除后断开真实 HTTP 回应 socket，切换会话查询原 ID，原清除 POST 仅一次，另一会话原授权仍在；另一真实 host Command 造成 epoch 冲突时拒绝且不重试。失败 GET 使清除只读，退出核实所属实际 Service PID 消失，随后 readonly 重开确认两 Session 的原 Run/Model 执行数量没有增加。该窗口 fixture 含 13 条实际 Node 断言；它是 macOS 开发制品证据，尚不代表完整安装、旧正式入口切换、child 窗口清除或 Linux/Windows 资格。

当前原窗口首次选择准确会话后，先核原标题并打开正式“会话工具”，再读取授权；后续选择已有的侧栏步骤保持。只补该首次导航，全部原driver字节、13Node断言及预算保留。同一完整文件1pass／10Bun断言通过，Desktop types／Biome通过；本轮默认真实失败与阶段范围归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，不把私有制品窗口资格提升为完整安装或整体退出。

此前恢复后的输入/输出、私有冷草稿、创建未知意图、模式/信任与完整目录基线仍为 12 文件、24 项、170 条 Bun 断言。原输入窗口另含 29 条 Node 断言，大输出窗口 24 条，基础窗口 14 条，冷草稿窗口 26 条；这些分别核实所属实际 PID 清理。共享 `ModelInputs/ModelInputPort` 保留 Web 原确认/metadata 语义，Runtime logs 的 `initialExecutionId` 跳转不自动 body GET；scope 改变不依赖 remount key，清正文并 abort，Native 输入和输出共享单 main lease。

授权目录合入后的最终完整 Native/共享权限组合实测 16 文件、30 项、224 条 Bun 断言通过（约 63 秒）；新授权窗口的 13 条 Node 断言和所属 PID 清理包含在其中。Desktop/UI 类型、10 个本切片归属代码文件 Biome 与文档结构检查通过；未运行共享 dist 或全 workspace 构建。

原生窗口现通过 [main Context 观察与意图控制器](electron/context.ts) 和 [视图消费者](src/native-context.tsx) 读取公开所选上下文。消息与来源独立分页，固定原 selection/highWaterSeq；消息结束后保留 afterSeq=highWaterSeq，来源结束后保留实际末尾来源 ID，不重复第一页。该 Native 控制器不设历史总页数或 complete 边界总数量截断。页面超过原 4MiB IPC 回应预算时，仅以相同 selection、高水位和两个原游标缩小 GET 页；单项目仍无法传输时明确局部不可用，完整单条大正文传输不属于此入口的资格。

历史结果候选从公共 `listAllBackgroundExecutions` 的完整固定目录读取，以实际 Session/root/Workspace 限定并筛选当前会话的 suppressed Job；不依赖 View 最近 200 个 Execution 的成员资格。Main 保存该次完整元数据目录，仅对当前窗口逐项用 `getExecution` 读取完整正文，并核对原 ID、Session、出处、revision、delivery 与状态；版本变化明确拒绝，不悄然替换原结果。私有 `context.results.next` 在同一 observation 内按原 4MiB 预算交付下一窗口，页面显式显示总数和当前范围；消息／来源分页仍使用原 Context 快照。Context 页占满预算时，历史结果可以先交付空窗口，再由显式下一页完整读取；单项仍超预算时明确局部不可用，不静默丢弃或扩大预算。刷新、关闭和换会话释放所属目录与在途读取，不授予停止或重跑权限。

显式 Rewind 只接收已读取的 complete 消息原 ID/seq 或空边界，完整 Tool 配对由 Core 核对。历史 suppressed Job 的 Include 原样传递共享面板点击时封存的当前 Store/Session/selection/targetRunId envelope；main 先以 `getExecution` 精确查询原 ID，核 Session/resultRevision、出处存在及 suppressed 终态，再读实际 view 核当前准入、Workspace、selection 和准确活动 Run。明确备份恢复后，原 Job 出处可以是 A，新的上下文命令属于 B；Core 仍在写入事务核原 subject 与 delivery target Session，保存的完整结果来源保持 A。缺准确目标或活动 Rewind 明确拒绝。accepted/result_queued 仅显示排队，原 Command 到 checkpoint 后 applied 才表示来源纳入；idle Include 只保存后续来源，须用户明确新建 Run 才进入 Model。这两种操作都不创建新 Run、重放 Job 或恢复原自动交付，自动 consume 的当前 Store 限制保持。

每项写入保存原 commandId 和身份，重复在途调用共享 Promise；最多 128 项原意图，超过时局部拒绝而不丢弃未知命令。未知回执只查询原 Command，不重发 POST。视图切换、刷新失败或观察流失效清除旧可写事实；旧读取不能覆盖新 Session。组件关闭只中止自己的 GET，不停止 Run 或所属 Service。SSE 刷新暂时清除 portable snapshot 时，读 scope 使用此前成功选定、按原 Session/选择代次封存的可信 Workspace 身份；写入仍须实际 view 复核，不靠该身份缓存批准。

[main 回归](test/native-context.test.ts) 验证消息与来源交替结束、超过 200 条消息、固定高水位缩页、单项目拒绝、原命令未知查询、精确活动 Include、取消自身 GET 与封闭 IPC 的 scope/Decimal64；[DOM 回归](test/native-context-dom.test.tsx) 验证换视图迟到正文不覆盖，以及共享 Include 第二参数原样透传。[实际 Electron 回归](test/isolated/native-context-electron.test.ts) 在临时 SQLite、固定 Adapter、私有 Service 制品和真实窗口中，完成 idle Job→键盘 Rewind→suppressed 历史→活动 Include queued→下一 Model 完整结果和 exact sourceID；Rewind 已提交后物理 HTTP 回应 socket 丢失，只查询原 Command，POST 仅一次。外置效果账本始终一行，刷新不新增模型调用，退出核实原 Service PID 消失。该窗口含 15 条 Node 断言，证明 macOS 开发制品当前 Context 切片；不代表 Fork/压缩、完整安装、旧正式入口切换或 Linux/Windows 资格。

[恢复后原入口整例](test/isolated/native-restored-context.test.tsx)以真实 Job、Rewind、公开 backup/restore A→B 和正式 NativeContextView 按钮，经有限 decoded bridge→Main→实际 SDK/Service/Core 保存新的 B Include，完整 source、原 result/revision/出处仍为 A。随后明确新 Run 的实际 Model request 按唯一 source ID 消费完整低信任 JSON；原 Job 与外置效果只执行一次，原公共 Execution 和 Command/Run 冷读保持，Core 仅准确接纳投影变化。该新例1pass/66Bun断言，相邻原完整作业合计26文件137pass/1337Bun断言；实际窗口仍保15Node断言与10/45/60秒预算。原键盘夹具曾在 disabled/busy 时按 Enter且零POST，现仅先核同按钮 actionability，再保原键盘动作和丢回执断言；真实失败保留。新恢复范围是实际 HTTP/Core 加 JSDOM/Main 的组合，不代证新增 installed Electron 恢复整窗口或整体退出；准确输入和剩余门禁归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-context-明确纳入原结果)。

[超过 View 窗口的原结果整例](test/isolated/native-context-history.test.tsx)在真实 Core/SQLite/HTTP 完成一次 Job、Rewind 和 201 个后续 Run，核 View 已无原 Job、准确查询与完整目录仍保留，再通过实际 NativeContextView 展示完整原正文并明确 Include。原生产因按钮缺失失败；修复后 1 项／56 条断言通过，原历史、命令、完整结果与出处保留，idle 不新增模型或任务效果，只有显式新 Run 消费完整原来源。Main/DOM 另核 405 个候选完整遍历、原 4MiB 预算的分开传输、所属正文 GET 取消和原 revision 冲突拒绝；本轮相邻完整组合 9 文件／23 项／474 条 Bun 断言通过，含原 macOS Context 与压缩窗口，原断言及超时预算保留。新例使用系统临时目录、固定模型与公共客户端，不新增 macOS 专属条件；它不代证 Windows/Linux 原生安装窗口或阶段退出。

本 Context 与既有 Native/共享权限联合回归实测 19 文件、38 项、270 条 Bun 断言通过（约 70 秒）；实际 Context 窗口的 15 条 Node 断言包含在该回归中。Desktop 类型、11 个归属代码文件 Biome 和文档结构检查通过；未运行共享 dist 或全 workspace 构建。

原生会话管理由 [main 控制器](electron/session-management.ts) 与 [窗口面板](src/native-sessions.tsx) 消费公开 Fork、rename、delete API。用户先读取当前根 Session 的原 Store、selection 和控制修订，再明确选择操作；main 保存原 commandId、源 Session、修订和新分叉 ID，写前重新核对实际 view。child、删除状态、观察失败或 scope 已变只读。同一意图在途共享请求；最多 128 项窗口意图，超界明确拒绝，不静默丢弃未知命令。未知结果只查询原 commandId，不以新 ID 重发，也不让迟到回执切回原视图。该窗口意图本身不声称跨冷应用重启持久化；会话创建与用户草稿仍使用前述私有数据库。

分叉明确显示扩展状态未复制。复制的消息保留服务封存的 `originMessage`；main 只从已读取、按当前视图封存的 Message 推导原 Session/Run，renderer 不能提交源身份作为权威。原正文仍用原 Execution 和原 Store 读取，保持原 BodyRef，不复制或重标 blob。删除确认只表示 `delete_requested`、`stopConfirmed:false`：目录隐藏之后，原 ID 的历史与执行事实仍由服务保留，窗口不会声称资源已经停止。rename 的 CAS 冲突保留原意图并要求重新读取、重新明确选择。

Native 有独立分页 Context reader，因此仅此宿主以 `readContextOnSelect:false` 禁用 portable controller 的重复 Context 预取；便携调用者默认仍读取。main 保留同一已选 Session 的成功视图用于刷新期间的阅读，临时 snapshot 不可用时明确只读，不把加载中当成用户切换。真正 scope/selection 改变仍清除旧视图。持久通知只提示重新读取：一个在途 view GET 加 dirty 标记合并积压通知，Client 仍消费全部事件 cursor；写前仍重新验证原实际 view，没有使用缓存批准操作。同 Session 成功 SSE 更新不会仅因 loading 清除已核实全文。

[管理 main 测试](test/native-sessions.test.ts)、[原 scope 输出测试](test/native-sessions-output.test.ts) 和 [实际 DOM 测试](test/native-sessions-dom.test.tsx) 覆盖原身份、CAS、未知查询、重复与迟到视图；[刷新回归](test/native-refresh.test.ts) 覆盖通知积压的单在途读取和加载期间撤除写资格。[真实隔离窗口](test/isolated/native-sessions-electron.test.ts) 使用本机假兼容模型、临时 SQLite 与私有 Service 制品：原 Fork POST 提交后物理回应丢失，只查询原命令；分叉后读取 >17MiB 原作用域正文，在同 Fork 的管理读取、真实竞争 rename 和成功 rename/SSE 更新后仍显示完整尾部；冲突不重试，未知 delete 只查原 ID，Provider 始终一次，退出核实所属 PID 消失。该场景独立通过 18 条实际 Node 断言，仍属于 macOS 开发窗口资格，不代表正式旧入口切换、完整安装或 Linux/Windows。

该原会话窗口的初始权限准备现沿正式Panel核所显示范围并信任，再明确Full保存；默认Auto保持。原直接mode→refresh→trust在自动观察后被Main旧观察守卫拒绝，只有mode一次POST、trust零POST，尚未进入正文。生产观察／CAS／消费与跨选择拒绝保持，夹具不重试mutation；全部后续业务字节、22条assert语句及45／60／10／30秒原预算未改。修正后的原完整窗口1pass／3Bun expects／18.75s，各一次trust与mode、>17MiB完整正文及六个准确所属进程普通退出通过；原红及冻结输入、当前完整默认结论归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)。

真实子进程、Electron 与私有文件测试统一位于 [test/isolated](test/isolated)；fixture 留在 `test/`，迁位后修正实际入口相对路径，原断言保留。未以 checker 例外替代进程隔离归属。

本次管理、刷新与迁位后的完整 Native/共享权限组合实测 24 文件、45 项、308 条 Bun 断言全通过（约 70 秒）；新管理窗口的 18 条 Node 断言、一次 Provider 和所属 PID 消失包括在其中。Desktop 类型、局部 Biome、文档结构与测试归属检查通过；未运行共享 dist 或全 workspace 构建。相同窗口的暂时加载仅保留只读观察，真实刷新失败仍清除可写事实；此区分同时覆盖原授权目录和 Context 消费者。

原生手动压缩和重置由 [main 压缩意图控制器](electron/compression.ts) 调用公开 Service API；[Context 面板](src/native-context.tsx) 只提交当前 observation ID 与完整重点，不能提供 Store、selection 或旧 compression ID 作为权威。main 写前独立读取实际 view 与 Context，核对原 Store、根会话、空闲、selection 和 compression ID；重点按原 UTF-8 全文提交。最多 128 项原意图，未知和 accepted 不丢弃、不重发；原 Command 的 accepted/applied 与原 Run 的 completed/failed 分别展示。历史压缩原 Store/Session、覆盖序号、原 ModelExecution 与触发来源原样读取，没有重标 BodyRef。

正常会话的自动压缩使用同一轻量 compaction 行。`NativeCaller` 传递原 `compressionProgress` 的 Run／Store／可用 Model Execution 身份，transcript 按准确调用去重；完成／失败／取消／未发布来自公共 Message 的原 SQL 压缩身份。模型成功或热进度消失不推导发布成功。 仅持久记录为 running 且没有匹配实时进度时，不显示压缩行，也不显示“上次确认为进行中”；保留真实已发布、失败、取消和未发布结果。压缩摘要不显示为普通回答，`completeRunReplies` 也排除其最终与复制资格；普通无工具 Model 仅是候选，须实际 Run completed 才能显示最终回答。[真实 Core→HTTP→Client→Native 回归](test/isolated/native-transcript-dom.test.tsx)在摘要后继续工具及 Run 最终提交屏障验证这些边界，另保冷历史和新版分页 Tool 标签；该证据是本机固定模型／DOM，Electron 和安装版窗口保各自验证范围。

View 补入压缩状态时，仅对新增压缩事实按其物理序号定位；已有完整历史保持自己的投影顺序，不能再次全量按物理序号排序。旧已验证输入替代消息仍在原输入位置，原 identity／seq／附件不改写。压缩定位回归核原序、插入、终态更新和重复 View 去重；原 Native 新会话整例另保热接管与冷挂载的先输入后回复顺序。

Native 的 [消息投影](src/native-presentation.ts)将准确 `firstOutput: reasoning`、未完成且当前无正文的 Message 映射为隐藏的 thinking 标记，只驱动顶部状态。长思考还要求原 `outputBody.contentBytes` 为零；旧记录缺首频道时，仅凭明确的 reasoning 字节与零 Tool calls 兼容。非空正文、空白正文或完整正文计数大于零立即保留 assistant；不支持的格式／读取仍保原提示，压缩状态优先。`firstOutput` 是首频道，不能作为永久隐藏回复的状态。共享 Conversation 在宿主 renderer 之前排除思考和结构标记，并保留准确轮次状态位置，不生成空的过程展开入口。[Native DOM](test/isolated/native-reasoning-dom.test.tsx)覆盖内联／Artifact／旧元数据及正文切换；[普通 Electron](test/isolated/native-reasoning-render-electron.test.ts)沿实际本机 Compatible SSE、Service、Core、SQLite 和 Native 窗口，经过带正文与纯工具调用的三次 Model，产生短思考、超过内联预算的长思考、正式阶段说明、同批及后续共三次真实文件读取及最终正文；测试持有真实 Tool Execution 元数据 GET 的响应，消息和模型继续推进；MutationObserver 和逐帧观察核对元数据未到及就绪后均无自动原结果 JSON、私有思考不进入消息 DOM、活动聚合默认收起且不随随后模型输出展开、终态交接不绘制已关闭的旧过程、手动折叠仍有动画。最终资格仍等待原 Run 完成，会话往返与页面重新打开只读原历史。该窗口使用普通关闭诊断的构建，不调用远程模型，不代证其他平台或全部 Provider 行为。

“查询原压缩命令与执行”先读取保存意图的原 Command；有 Run receipt 时保留实际 View 的 Store／Session／root 准入，再沿公共 `getRun` 读取准确原 Run，并核 Run ID、originStoreId、sessionId、originCommandId。View 的近期 200 条终态 Run 不承担完整历史查询，原 Run 离开该范围后仍能核实。读取或身份校验失败保留已经确认的 submission，并另报本次查询失败；accepted 不制造 Run，查询不重发压缩或重置。[完整 main 用例](test/native-compression.test.ts)覆盖 compress/reset 与错误身份；[实际长历史 DOM 用例](test/isolated/native-compression-history.test.tsx)经正式按钮、decoded bridge 和真实 Main／HTTP／SQLite 产生 201 个后续 Run，核原准确结果和全 GET、原 Command／Run／Model／完整历史未改。新增 DOM 用例不经过真实 NativeCaller IPC 或 Electron；原窗口按其已有范围复验，准确红绿与当前验证见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13native-长历史原压缩结果查询)。

同 Session 的压缩原输入快捷入口区分当前 Store 准入和原压缩出处；A→B 恢复后仍把准确原 `modelExecutionId` 交给实际 [NativeDesktop](src/native.tsx) 父回调与共享 ModelInputs，不要求原 Store 等于当前 Store。同 Session 限制保留，跨 Session 封存压缩卡不借当前 Inspector 读取源会话。确认敏感读取后，[Native port](src/native-model-input.ts) 与 [Main reader](electron/model-output-reads.ts) 绑定当前 B／generation／viewSelection／Session／Execution；Core 独立核原 Execution／Run／Command／root-work 和主体，完整 EOF／bytes／SHA 后才显示保存请求和原元数据。关闭清正文，切换只释放所属读取，不改变压缩／重置写入门禁。

[真实恢复整例](test/isolated/native-restored-compression-input.test.tsx)使用实际压缩、公开 backup/restore、两次全新 Service／Client／Caller 与完整 NativeDesktop DOM，核真实父回调、确认前零正文读取、完整原 request／metadata／当前 cursor／多块 IPC、Close 和迟到 Main open 回复的 Session 取消。原压缩／Execution／Run／Command 保持，恢复后全 GET／Model0；[同 Session DOM 回归](test/native-context-dom.test.tsx)另保跨 Session 不显示入口。最终五个唯一原完整作业28文件105pass／1027Bun断言，原压缩窗口另41Node断言和两个所属 PID 退出；准确红绿与冻结输入见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-压缩原输入入口)。新 DOM 整例没有 Node 私有 UI 数据库，实际草稿不可用告警明确确认；布局替身不证明新的 preload／Electron／installed 恢复窗口。已有原压缩、Model 输入窗口分别复验其原范围，完整 P5／P6 与阶段退出仍未闭合。

[Native 输入选择](src/native-input.ts) 使用点击时已核实的 active Command 和 Run：手动压缩或重置期间普通文本封存原 afterRunId/contextSelectionId 为 follow-up，普通活动工作封存 targetRunId 为 steer，空闲才创建新轮次。Native 显式启用 portable controller 的 active Command 读取，其他 portable 宿主默认行为不变。持久通知刷新每个 Promise 只执行一次实际 GET；dirty 的后继读取在下一事件循环启动，明确用户请求只等待已捕获的读取，再做自身核对，不等待全部通知或 Model 完成。授权目录只读 GET 同 Context 一样使用此前成功选择的原 Workspace，避免后继通知暂时清空 snapshot 时误当切换；清除授权仍要求当前 fresh snapshot，临时加载不能扩大写资格。

[压缩范围测试](test/native-compression.test.ts)、[输入选择测试](test/native-input.test.ts)、[真实窗口](test/isolated/native-compression-electron.test.ts)与[实际活动 Model 刷新 barrier](test/isolated/native-refresh-active.test.ts)核对完整重点、真实摘要与经公开校验的下一持久 ModelInput、旧可见历史、物理回执丢失只查原命令、unsafe reset 保留原点、无点 reset 和冷启动只读零额外 Provider、维护输入原 follow-up 以及不受后继 GET 阻塞的准确 steer。窗口含 33 条 Node 断言并核实两次原 Service PID 已退出；Provider 仅为自有本机固定兼容 SDK，不涉及远端服务。

压缩与通知刷新最终完整 Native/共享权限组合实测 28 文件、51 项、348 条 Bun 断言全通过（约 75 秒）；随后新增确定性授权目录 GET/dirty 后继 barrier 的刷新文件复验为 2 项、7 条断言。新压缩窗口另有 33 条实际 Node 断言、四次自有兼容 SDK 调用及两次所属 PID 清理；原管理窗口 18 条 Node 断言和其他已有窗口证据仍保留。Desktop 类型、portable build、15 个本切片归属代码文件 Biome、文档结构和测试归属检查通过；未运行共享 dist 或全 workspace 构建。这是 macOS 私有开发制品资格，不代表正式旧入口切换、完整安装、Linux/Windows 或付费 Provider 验收。

切换会话时，[renderer](src/native.tsx)立即撤销旧操作资格，但在目标选择请求返回前保留当前正文 DOM 和阅读状态；目标确认后，命中的 KeepAlive 项直接显示原 DOM，未命中则沿原完整历史、轮次归属与工具加载边界显示。新数据未就绪时保留缓存显示并禁用旧动作；普通同会话校准仍保留本地展开。`conversationCache` 的 scope 固定 generation／Store；子详情还绑定已核实的准确 carrier／child Session，不能因稳定 Session 相同而复用另一轮的读取范围或操作。history epoch 与已确认目录移除使非当前项失效，新增会话保留其他近期项；容量、体积和节点预算由 [UI owner](../../packages/ui/README.md)维护。停用树脱离可见文档且 effect 释放，不增加后台订阅，不以缓存恢复写资格。[Native model adapter](src/native-model-output-message.tsx)显式传递当前读取 gate，模型正文按实际内容身份保留，不再把每次 viewSelection 当作 DOM 身份；原 lease 仍在停用时关闭。Native 的完整回复复制文案以 generation／Store／Session 与原正文身份保存为展示，adapter 将暂停产生的通知撤回与实际关闭区分，entry 回收时清理；复制按钮仍由当前读取 gate 和缓存事件门禁保护，保留文案不恢复读取或提交资格。文件链接保留原节点，由当前 gate 与原 messageFile.open 范围核验决定是否操作。[Native DOM 回归](test/isolated/native-history-presentation-dom.test.tsx)核 held selection 期间正文节点与展开状态保持、旧选中高亮退出、发送禁用，以及返回后的恢复标记和手动开合。

2026-10-19 KeepAlive 验证：Windows x64／Bun 1.4.3，`f734245a` 加主工作区快照及本补丁，使用 `bun test --parallel=1 --max-concurrency=1` 与准确 `./` 文件路径运行相关14个完整文件，105项／2815断言通过；UI／Desktop typecheck、定向Biome、文档结构／本任务影响映射、统一边界和测试归属检查通过。新增[缓存测试](../../packages/ui/test/isolated/desktop-conversation-cache.test.tsx)含条数、DOM体积、节点预算与100轮 effect 清理，原[全文测试](../../packages/ui/test/model-output.test.tsx)包含旧 lease abort、late 隔离与原全文节点恢复。Chrome155 的隔离夹具以显式 production JSX 分别构建 Root UI 与 Desktop UI，沿实际 SessionPage、Native model adapter 和 Native CSS，在亮暗主题中各核100次往返、恢复后12帧：原正文／表格节点不变，正文内部 childList 新增／替换为0，只连接1棵消息树，纵向230px／宽表格横向110px保持；固定正文 port 只读取1次、旧 signal 取消1次，校准中不发布当前复制正文，页面错误0。该夹具只证明显示与 reader adapter，不代替完整 Service／IPC、Electron 安装版、多平台或全量默认测试。

本轮组件闪动回归由[专用浏览器夹具](test/conversation-cache-browser-runner.fixture.ts)执行：在已安装 Chrome 的环境运行 `bun apps/desktop/test/conversation-cache-browser-runner.fixture.ts`，夹具独立构建实际 Native CSS、Conversation、图片与全文 adapter，固定模拟图片／正文 port，不加载真实会话或 Service。它逐帧核图片解码、用户与完整回复复制按钮／文件链接的原节点、未悬停复制透明度、悬停文字颜色、复制反馈、只读点击门禁，以及100次切换后单一连接树、一次图片读取与正常过渡恢复。该入口只在显式测试制品中存在，不由环境名、URL 或普通 dev／prod 参数开启。

完整 Native 壳层另由[页面回归](test/isolated/native-session-shell-dom.test.tsx)和[全页浏览器夹具](test/session-shell-browser-runner.fixture.ts)覆盖：`bun apps/desktop/test/session-shell-browser-runner.fixture.ts` 使用实际 NativeDesktop、Composer、模型选择和环境 hook，固定模拟 Main 端口并关闭测试诊断，不接真实 Service 或用户数据。它在浅／深主题逐帧核首次冷会话的长模型名、准备期间的 Main state 通知、会话确认、历史及模型校准、同会话重读、空草稿的发送／停止、原控件 DOM／透明度／位置／悬停、菜单与 Full 确认失效、禁用零业务写入及连续切换。冷首帧与暖缓存分别建立身份基线：首次读取尚无用量样本时不伪造缓存率徽标；模型按钮则跨两种场景保持原节点，首帧模型文字和宽度必须与同帧页面标题对应。正文资源夹具与全页壳层夹具分别证明各自断言，不以其中一个代替完整安装窗口或真实 IPC。

2026-10-19 Windows x64／Bun 1.4.3／Chrome 155，基于 `f734245a` 加本轮工作区改动，上述两个浏览器命令在合并后的实际样式上通过：完整页面浅／深主题共144帧等待采样、200次连续切换，另核五类控件的悬停颜色；正文夹具另核图片、复制和链接的原节点与单一连接树。正文缓存、编辑器、Native 导航、权限、图片、读取归属及环境停止的18个相关整文件共125项／3058断言通过，Desktop／UI typecheck、定向 Biome、文档、边界和测试归属检查通过。Chrome 保持沙箱开启；Windows 受限进程中的 crashpad 启动失败后，在允许启动浏览器的本机进程环境完成复验。原嵌套 `@keyframes` 编译提示及既有 ToolActivity 测试 key 提示保留；此证据仍不代完整 Electron 安装窗口、真实 Main IPC、其他平台或全量默认测试。

2026-10-19 组件恢复修复验证：Windows x64／Bun 1.4.3，`f734245a` 加既有工作区快照和本轮合并改动，准确 `./` 路径运行15个完整回归文件，111项／2869断言通过；合回后的 UI／Desktop typecheck、17个本任务代码／测试文件的 Biome、文档结构／本任务影响映射、统一边界和测试归属检查通过。上面的专用浏览器命令在 Chrome155 的亮暗主题各采样缓存校准与完成后24帧，并各切换100次：图片24帧均为原已解码节点，用户／完整回复复制按钮、文件链接与轮次控件保持原节点；未悬停复制透明度一直为0，轮次透明度一直为1，悬停文字颜色保持，复制反馈不重置，校准点击零复制／文件操作。每种主题图片读取和URL创建各1次，期间未撤销，当前文件链接可正常操作，普通过渡在恢复后回到120ms，只连接1棵阅读树，页面错误为0。资源预算、真正移除、窗口隐藏、复制展示回收和迟到隔离由隔离DOM回归补充；仍未验证完整 Service／IPC、Electron安装包、其他平台或全量默认套件。

此前闪动修复的局部证据：2026-10-19 Windows x64／Bun 1.4.3，基于 `f734245a` 加当前工作区快照及本轮改动，相关七个完整文件46项／1438断言与 UI／Desktop typecheck 通过；新增两处 Native 断言在修复前失败。Chrome 155 隔离页面沿真实 SessionPage 和 Native CSS，在亮暗主题中各采样恢复后12帧，手动阅读位置230px及展开内容高度保持，轮次与工具恢复动画均为none，默认展开活动轮次同样保持；后续手动轮次／嵌套工具仍使用原展开动画，页面错误为0。未运行完整 Electron 安装版、多平台或全量默认测试。

原生历史由 [NativeHistory](src/native-history.ts)在首次选择、重开、暂停恢复、观察epoch变化或变更游标失效时分页建立完整基线，固定原 Store、Session、选择代次与highWaterSeq；EOF精确替换阅读快照，包含移除记录。校准期间保留已发布正文，不把进行中的前缀提前缓存；完整扫描失败仅合入合法前缀并撤销操作资格。完整会话时间线与当前Model context分开，rewind不隐藏原消息，活动历史不设累计条数或字节截断。

Service声明`message_changes`时，同一连续scope随后调用[Client](../../packages/client/README.md#消息历史增量)读取持久变更。`historyCursor`只来自同View的`snapshotCursor`；正文SSE只提供可能领先View的`historyTargetCursor`唤醒，不能作为基线或ACK。增量首页面从Store取得序号上界，后页固定该上界；同一`seq`的正文追加、旧输入替换标记、压缩和子结果等依赖投影均按原消息ID合并。每个最多200事件的批次完成全部候选页面后才原子发布及推进变更游标，失败不提交半批；未变化对象保原引用，普通增量不进入history loading，也不增加发送前全量重读。缺少能力的旧Service沿完整扫描兼容路径。Main保留每页预算、准入和late隔离，纯正文事件不再触发View GET；Run、执行与权限元数据继续独立刷新，外来名称及历史回收事件可唤起关联正文。实际失败撤销准入；replay失效则刷新View和epoch，重新完整校准。取舍见[持久历史游标](../../.agents/notes/implemented/architecture/2026-10-24-native-history-change-cursor.md)。

[inactive cache](src/native-history-cache.ts)仅保存非当前数据，最多12项、64MiB保守载荷估算、单项16MiB；命中通过 take 转交活动视图，离开时重新入队，空历史可缓存，超预算历史仍可完整阅读但离开后不保留。generation 改变清空旧正文与缓存；history epoch 改变仍清非当前缓存，同一 generation／Store／Session 已发布的活动正文保留为只读阅读，刚由 preview 取出的旧非当前快照不能跨 epoch 冒充活动正文。新 scope 仍从零完整校准，只有新 EOF 才恢复完整读取资格；取舍归[历史 reset 阅读决定](../../.agents/notes/implemented/bug-fix/2026-10-16-native-history-reset-reading.md)。确认空间移除时淘汰所属 Store 的缓存与活动正文，卸载清全部引用。`close()`只取消读取并撤销该次校准标记，随后同一阅读选择可完整恢复校准。固定水位相同不代表正文未变：有连续变更游标时读取增量，缺少能力或基线失效时仍完整校准；缓存和消息序号都不授予写入资格。[缓存回归](test/native-history-cache.test.ts)核100会话轮转与字节预算，[历史回归](test/native-history.test.ts)核暂停恢复、EOF替换、失败前缀与迟到隔离；[主子导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)核活动子页、父读取暂停、草稿和监听释放。

[Main](electron/native-caller.ts) 每页仍执行 4MiB IPC 预算及公开回应校验，过大时只在原游标和高水位缩小 GET 页；已通过校验的页大小仅在同一 generation／selection／Session／Store／highWater／readId 内单调保留，后页仍重新读取和校验全部正文。范围变化、取消、关闭或新读取重置该限制；单项目无法传输时明确未完成。切换只关闭自己的读取，迟到旧页不能进入新会话，也不取消业务执行。取舍与既有观察刷新共同归[完整正文刷新决定](../../.agents/notes/implemented/bug-fix/2026-10-08-native-observation-output-refresh.md)。

观察流缺口使旧操作事实失效。main 在原 Store 先读取全局目录基线，再重读目录、当前 view 与完整历史，随后用公开 `startAfter` 重开观察；该起点不成为已应用游标。经公开 Client 校验的 `onReady` 仅确认观察就绪，历史完成与当前事实共同恢复操作资格，不要求产生额外业务事件。历史暂时 loading 保留只读 Context/授权事实；实际失败才清除相应事实。

历史校准的 loading／complete 继续撤销／恢复消息文件入口；共享 [MessageContent](../../packages/ui/src/desktop/MessageContent.tsx)现通过私有 Context 只更新链接能力，未变化的完整正文不重新解析 Markdown。Main的当前scope／消息／路径准入、完整基线的固定高水位与EOF及业务发送门禁保持；普通增量不再逐次撤销基线完成资格。原 Markdown 与相邻完整 reader／transcript 文件保所有断言；原 75秒 driver／90秒整例的真实 Native 窗口核5051条及超过8MiB全文、失败保正文与禁写、迟到切换、两次物理SSE缺口、live rename、Provider0和所属Service自然退出。当前准确范围与默认集成结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)；不跳过 metadata 原seq更新，也不据局部窗口关闭资源、平台或阶段门禁。

[历史 reader](test/native-history.test.ts)、[main 原游标缩页](test/native-caller.test.ts)、[ready-only 恢复](test/native-refresh.test.ts)首次组合为 13 项、81 条断言；[实际长历史窗口](test/isolated/native-history-electron.test.ts)读取 5001 条显式隔离库历史记录和额外超过 8MiB 的多消息正文，验证完整尾部、失败保正文与禁用发送、重新读取及迟到切换，Model 调用为零，首次另有 13 条 Node 断言与所属 PID 清理。记录通过 fixture 直接存入隔离库，未伪造 5001 次 Provider 执行。原 Context 窗口复验保留全部 15 条 Node 断言；压缩窗口在真实可操作门禁就绪后继续键盘 Enter，保留全部 33 条 Node 断言与四次兼容 SDK 调用，两个所属 Service PID 已停止。这些证据仍是 macOS 开发窗口切片。

2026-10-09 的原完整默认暴露完成轮次默认折叠后旧 driver 未展开的断言错误；driver 现沿真实“展开本轮处理过程”入口继续原计数与正文断言，原页面、driver、整例期限保持。随后原重载期限仍实际失败；当前 reader 完整文件 4 项／22 条断言核快照保留、失败前缀及切换缓存，Main 完整文件 14 项／146 条断言核固定高水位读至 EOF、后页复用已验证大小和新读取重置。独立审查核并发学习值只缩小、旧读取不能回写。真实历史窗口与完整默认的准确状态归[普通制品收束进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)，局部通过不代证窗口重载或阶段退出。

2026-10-02 在 macOS/Bun 1.4.2 当前工作树执行 `bun test apps/desktop/test packages/ui/test/permissions-dom.test.tsx`，最终完整组合为 34 文件、76 项、509 条 Bun 断言，全部通过（约 111 秒）。包括 >17MiB 原作用域输入/输出、Context、授权、私有冷草稿、管理、压缩、活动刷新和新增长历史窗口；各真实窗口仍独立核对所属 Service 退出。首轮组合曾失败于暂时历史加载清除 Context 事实，以及 fixture 在 disabled 按钮直接发送 Enter；前者已修复为 loading 保留只读事实，后者等待原 actionability 后继续原键盘动作，原断言和期限保持。Desktop typecheck/build、11 个归属代码文件 Biome、文档结构/影响及测试归属/统一边界检查通过。该结果不改变正式入口和跨平台资格的未完成状态。

当前输入模型选择要求实际 enabled/configured 目录。[原 Context Service 夹具](test/native-context-service.fixture.ts)为其固定 adapter 提供准确 Store/Workspace 的只读 `fixed` 目录，配置修改入口明确拒绝；[窗口 driver](test/native-context-electron.fixture.ts)两次新轮次等待按钮实际可点击。原四请求、一次 ledger 效果、idle Rewind、active Include 与下一 Model checkpoint 的准确来源、无 Job 重放、页面刷新零新增请求和所属 PID 退出断言保持。该夹具适配不改变生产模型就绪门禁；有限窗口1项4条Bun断言及15条Node断言通过，当前完整默认结果另见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

[后页 child](test/interaction-pages-child.fixture.ts)和[持久答复 child](test/answer-journal-child.fixture.ts)按同一原 Store/Workspace 的只读目录装配，两个原 driver 的首次发送等待实际按钮可点击；模型事件、权限与所有原期限保持。原后页窗口复验仍完成40个原 Job、40次效果和零取消，原持久答复窗口仍核原全文/身份/digest、POST前SQLite提交、丢原回执、两个Main生命周期、冷原GET两次/POST零次与effect once。源码与新回归符合当前目录合同；第六轮后页现场曾显示run admitted，不能将有限复验通过追认为旧0卡的完整因果，详细范围见进度。

当前[原后页 driver](test/interaction-pages-electron.fixture.ts)先打开既有“会话工具”，再等待实际“下一页待决请求”；原完整步骤、断言与期限不变。同一完整文件1pass／3Bun断言通过，20卡替换、关闭／切换撤销旧读取、后页原回答丢回执后只查原申请、40次效果与零取消均核实；这项正式导航适配不改变待决窗口或回答权限。

## Native 提供商与模型设置

模型页不再挂载已确认提交的历史区，不展示 Store、模型 route、commandId 或 phase 的原提交摘要。当前失败仍由原提示处理；只有结果未知的更改显示简短说明和“查看结果”，按钮仍查询原 commandId，不重发保存。正常保存期间模型开关保持可用；实际失败、未知结果及只读仍沿原保护处理。

[模型面板](src/native-model-settings.tsx)与 [Main 配置观察](electron/configuration.ts)通过公共 getModelSettings 固定读取 user scope，不传 Workspace 或路径。唯一生产源为 ~/.kite-code/kite-code.jsonc，现有 provider/model/disabledModels 由 [Service 用户源](../service/src/user-configuration.ts)适配；Profile 和项目不提供模型覆盖。空闲挂载、关闭重开和会话/宿主 generation 改变时自动读取；同作用域尚有保存队列时重开复用原 controller，观察通知或提交状态重绘不制造读取循环。自动重读及异常重试只 GET 本地配置，不发现远端模型或读取凭据。统一页不挂刷新或异常重新读取按钮，也不保留对应容器、焦点回退或忙碌状态；错误与配置诊断继续显示，临时异常按250／1000／3000／10000ms退避重新GET，后续封顶10秒；取得有效事实后自动恢复。当前Store的unknown（含冷journal行）在页面活动时自动原ID GET，模型已接受热提交的未知结算可在关闭设置后继续，提供商页的读取与核对重试在关闭时停止、重开后继续核对原记录；不重发POST、secret或发现请求。2026-10-25移除异常按钮后，模型／提供商与统一页DOM100项／1423断言、Desktop类型和定向Biome通过；宽窄深浅四组合浏览器共12536次采样／2150帧，无页面错误。已观察明确失败和续读冲突时按钮与占位均缺席，关闭重开仅GET恢复，未新增保存或重发旧尾部；未知结果仍查询原ID。浏览器证据范围沿用匿名Main／生产UI夹具。

[统一设置页](src/native-provider-model-settings.tsx)组合[连接面板](src/native-provider-settings.tsx)与[模型 hook 和片段](src/native-model-settings.tsx)，导航只保留“提供商与模型”。模型行已移除“默认”badge及专用CSS。统一页不展示默认模型选择卡片，直接展示提供商栅格；连接按 `connection.modelIds` 与模型 `id` 精确匹配、去重展示，未归属条目留在“其他模型”，不按名称或地址猜测归属。自动接入的只读连接仍可管理模型偏好。沿用原 settings-models CSS 与 checkbox switch，禁用/配置不完整模型保留；模型行同名时附准确 route ID。开关乐观更新，明确失败恢复原值并撤销写资格；成功刷新原观察并通知输入区。默认模型与其他模型一样可禁用和重新启用，也允许全部关闭；Rows、串行queue与Main没有默认禁用特判，原默认ID不自动改写。2026-10-25，本轮Desktop Main／模型DOM／Picker／统一页四文件121项／1460断言通过；Service模型管理／后继证明／提供商三文件35项／626断言通过。Desktop与Service类型、定向Biome、文档、边界和测试归属检查通过。生产UI／真实Main匿名浏览器夹具宽窄深浅四组合共15387次采样／2707帧，无页面错误；每组合真实关闭并重启默认B，两个独立POST严格使用fresh read-set及postReadSet，默认ID始终为B，行节点与焦点／滚动保持。每组合Model最终12POST（含setup）、Provider1POST、原IDlookup1次，未重放旧意图。活动默认A在禁用后仍同Run连续调用A并完成、零取消，以及全禁／重新启用／新运行拒绝与不回退由[Service回归](../service/test/isolated/configuration-management.test.ts)单独证明；匿名浏览器不代证实际模型执行或安装版资格。读取和编辑均不发送任务或重建 Session，返回应用保留原输入实例和草稿。

[连接模型目录](src/native-connection-models.tsx)使用共享 Popover，不在卡片中展开全部开关。连接列表采用最小320px卡片的响应式栅格，窄容器降为单列；卡片自身的 container query 调整标题与操作布局，“管理模型”以按钮锚定浮层操作，开合不改变卡片及栅格几何。摘要统计准确归属的总数与启用数，初次模型读取期间显示读取状态；浮层仅展示完整模型列表和启停开关，不挂搜索、筛选或工具栏；打开、关闭与滚动不触发配置写入。Popover portal明确挂入当前 `.desktop-settings` 内，避开卡片的 container query 和内容滚动裁剪，保留设置 Dialog 的主题与焦点范围。浮层通过 `--radix-popover-trigger-width` 与入口等宽，并受窗口可用宽度约束，沿Radix碰撞定位调整方向与边距。入口左右内边距10px，浮层内边距4px，模型行左右内边距12px；列表容器不再单独增加右侧留白，模型名与开关距浮层边框均17px（含1px边框）。共享 ScrollArea 的真实 viewport 采用 scroll-fade-y 与320px上限，并按浮层可用高度进一步收缩，紧凑行最小44px，长名称和诊断可换行。连接、目录和模型以原准确身份保留，浮层内开关保存及后台事实刷新保持同一浮层、模型行、viewport与滚动位置；模型启停后继续显示原行；正常保存及其续读期间保持开关焦点；真实保护状态禁用开关或后台事实刷新移除该模型时，将焦点移回可滚动列表且不改变阅读位置；打开时聚焦可滚动列表，Esc仅关闭浮层并恢复入口焦点，外部点击关闭保留实际点击目标的焦点。统一入口仅挂载独立 `NativeModelSettingsFeedback` 呈现模型读取错误与未知提交查询，普通状态不占位；旧独立模型组件保留原兼容测试，不挂入统一页面。没有增加批量修改、远端目录读取或配置权限。

2026-10-25，大模型目录与栅格布局在同一 macOS／Bun 1.4.2 工作树通过五个设置 DOM/Main 文件93项／1267断言及完整 NativeDesktop DOM 82项／1689断言。上述既有浏览器夹具的 `settings-models` 场景使用60模型连接、20模型连接和1条独立模型，核1100／550px与深浅主题四组合，共8064次过程采样／1267帧，无页面错误、重复路由行或横向溢出。宽窗两卡同排、窄窗单列，两目录各自320px滚动且工具栏位置不变；首中尾fade、搜索空结果、状态筛选后键盘启停与焦点恢复、默认菜单搜索及键盘选择均核实。各组合仍为连接保存1次、模型保存3次、原结果GET查询1次，未知关闭重开不重发，原会话节点和四次读取保持。该证据使用生产 Native UI、真实 Main manager及匿名内存传输，不包含真实 Service、凭据库、远端模型或安装版持久化资格。

2026-10-25，按确认需求移除统一页顶部整块默认模型卡片及其留白，模型反馈片段独立保留。现有模型／连接DOM整文件76项／1013断言和统一页7项／137断言通过；浏览器四组合7587次过程采样／1240帧中，默认卡片、选择器与搜索控件始终为零，标题到目录间距均28px，栅格和目录交互保持。原默认变更仅经既有封闭IPC作为隔离测试setup，不代表统一页仍提供该控件；每组合明确区分UI连接保存1次、UI模型启停2次与setup默认变更1次，原结果查询1次。真实Service／凭据库和安装版持久化仍不在该验证范围。

2026-10-25，模型管理浮层改造通过模型／连接DOM整文件78项／1037断言、统一页7项／182断言和完整NativeDesktop 82项／1699断言；Desktop与UI类型、定向Biome通过。现有浏览器场景核1100／550px、深浅主题四组合，并各自切换480px短窗口，共9179次过程采样／1348帧，无页面错误。浮层开合及切换保持卡片／栅格几何不变，真实输入与开关可操作；portal位于设置内且不在卡片／内容滚动区，无inert或aria-hidden祖先。正常列表320px，短窗口按可用高度收缩，无裁切或横向溢出；底色与实际卡片一致且完全不透明。Esc关闭后焦点返回入口且设置仍打开，外部点击关闭和连接切换不串模型；原60＋20模型、unknown查询、一次提交和草稿／读取生命周期断言保留。验证使用生产UI／Main与匿名内存传输，不包含真实Service、凭据库或安装版宿主资格。

2026-10-25，移除模型状态筛选后，仅保留全宽搜索和逐项启停，相关模型／统一页DOM共28项／439断言通过。浏览器四组合及480px短窗口共8950次过程采样／1371帧，无页面错误；浮层无select／combobox，搜索框占满394px工具栏。实际Space启用期间开关暂时禁用导致焦点落body的问题已复现并修复，pending与applied期间均保持搜索框焦点、原模型行／viewport及内外滚动位置；未增加写入，原未知结果查询和会话读取断言保持。Desktop类型与定向Biome通过，验证仍限生产UI／Main和匿名内存传输。

2026-10-25，按确认需求移除管理模型浮层的搜索框、匹配逻辑和工具栏，仅保留完整模型列表及启停开关。模型DOM20项／246断言、统一页7项／186断言和完整NativeDesktop 82项／1701断言通过；Desktop类型及定向Biome通过。浏览器四组合与480px短窗口共8685次过程采样／1362帧，无页面错误：搜索、筛选、工具栏及额外按钮均为零，无旧分隔线或占位；浮层420×346px、列表上限320px。真实60项列表末尾启停时，pending与applied均保持模型行、viewport和列表焦点，内滚动2320→2320、设置页0→0；原一次提交、未知结果查询、关闭恢复和草稿／读取断言保持。验证仍限生产UI／Main与匿名内存传输。

2026-10-25，浮层等宽与内边距调整通过四组合及480px短窗口浏览器验证，共8773次过程采样／1385帧，无页面错误。宽窗触发区与浮层均348px、窄窗均288px；入口左右10px，模型名左侧与开关右侧均距浮层17px，短列表无单侧额外留白，长列表实际thumb与开关间隔4px。原滚动、焦点、边界、未知结果查询及会话读取断言保持；Desktop类型、定向Biome通过。样式调整不改变配置写入合同。

[模型队列](src/native-model-toggle-queue.ts)将开关交互资格 `canToggle` 与严格写资格 `canWrite` 分开：本队列正常 POST、自有续读与异步提供商核对期间保持模型行可操作，同模型未派发意图合并为最后值，已派发 head 不变，不同模型按入队顺序串行保存。队列持有同作用域的共享写锁，连接保存不能插入；普通 Provider 读取不阻断本队列，但 foreign submitting、unknown、权限丢失继续阻断。明确失败、未知或续读冲突清空未发尾部，恢复已确认值，不重基旧意图。已applied后的明确暂态网络读取错误仅退避重试原afterCommandId，原scope／proof仍由Main逐次核实；期间保持healthy、写锁和意图合并，证明一致后可继续原队列。proof变化、身份失效或诊断只读不能沿该路径续写。普通恢复GET只开放新点击，不恢复旧尾部；未知只自动查询原commandId，确认为applied／failed后再普通GET。

Service 为 applied 模型更新回执持久保存准确 `postReadSet`；[Main](electron/configuration.ts)仅接受同一热提交、Store、generation 与完整选择身份的 `afterCommandId`，核下一次 GET 四字段与该证明完全一致后生成新 observation。动态模型来源变化或外部写入导致不一致则停止队列，不把普通 GET 当成旧 CAS 的重试依据；renderer 不接收原 readSet。历史无证明回执和冷 journal 仍能查询原结果，只能普通读取恢复，不能续接旧队列。

保存响应和状态通知同时缺失时，先只读查询Main现有state，核generation、Store、准确observationId与完整非秘密operation，只有唯一匹配原记录才取得commandId；无ID、foreign或歧义不会猜测、普通GET也不能解除未知锁。自动恢复与原保存结果通知分别处理。Model和Provider只在“需要恢复→有效新事实”的边沿刷新对端，正常GET不互刷；提供商保存成功后的刷新强制取得发布后的新观察，不复用较早在途GET。自动lookup不借调用当下的editorVersion关闭后来打开的编辑器，不回填或重基草稿；只有原applied结果通知一次onSaved，failed恢复不冒充保存成功。自动重试保留旧错误直到读取成功，避免重试期间反复闪现。准确只读但无诊断的事实停止轮询并继续只读；权限、身份或私有journal错误停止当前恢复，不能凭旧事实放权。

controller 生命周期独立于设置组件，常规页的默认摘要读取也使用独立 manager，不与队列共享 observation／close。关闭设置移除订阅但继续保存已接受队列；同 bridge 与完整 scope 重开复用活跃 worker，不额外启动普通模型读取。空闲普通 reader 关闭即取消释放。切换 scope 清除旧的未派发尾部，迟到回执只完成原提交，不替换新页面事实。关闭窗口或退出进程后的恢复仍沿原 journal／unknown 合同，不宣称内存队列跨进程保存。

2026-10-25，自动恢复最终七文件组合258项／3942断言通过（macOS／Bun1.4.2当前工作树），覆盖实际Main原记录、bad／empty回执、无watcher状态找回、无ID关闭重开、shared pending硬锁、冷原记录／foreign拒绝、proof网络重试与冲突分支，以及原NativeDesktop。Desktop类型、定向Biome、文档、统一边界和测试归属检查通过。同轮生产UI／真实Main匿名浏览器夹具在1100／550px深浅四组合通过，共13291次过程采样／2218帧，无页面错误；Provider读取失败在同页自动恢复且模型尾部继续，unknown只查原ID，known failed／foreign恢复不新增POST，恢复后只有新点击产生新POST。每组合正常5次串行保存、最大写并发1，最终Model10次（含默认setup）、Provider1次、原ID lookup1次；焦点、行与viewport、2320px滚动及General独立读取／草稿／4次会话读取保持。漏watcher及坏回执分支由上述DOM／Main回归覆盖；浏览器使用匿名内存Client数据，不代证真实Service、付费模型、钥匙串或进程冷启动资格。

2026-10-25，连续启停通过模型与提供商 Main／DOM 四文件118项／1436断言、统一设置9项／252断言，以及完整 NativeDesktop 82项／1705断言。后者首次在受限沙箱中仅真实 HTTP 用例因 loopback 绑定被拒，允许隔离本地服务后原82项通过。Service／Client／journal 四文件29项／607断言覆盖后继证明、动态来源与完整 read-set 冲突、冷原结果和活动 A 禁用后的 A、A、B wire；不访问付费 Provider 或用户凭据。Desktop类型、统一API生成、边界与测试归属检查通过。

同轮生产 Native UI／Main 的匿名浏览器夹具核1100／550px、深浅主题四组合，共11825次过程采样／2033帧，无页面错误。每组合正常连续操作最终仅5次串行 POST，最大并发1，未发同模型意图合并；每次后继 GET 精确核原回执 proof。关闭设置后继续排空，同作用域重开不启动额外普通模型 GET；自有 GET 与 Provider flush 中继续切换，最终状态对应最后选择。逐帧与 Mutation 记录确认正常阶段开关无临时 disabled，焦点、行／viewport身份与2320px阅读位置保持，队列结束不再因 Provider 读取状态晚到把焦点移回列表。unknown、明确失败和 foreign read-set 各仅原 head 写入，尾部不重发，明确原结果查询／重新读取仅 GET；原浮层等宽、内边距、短窗口边界、会话与草稿断言保留。浏览器部分使用匿名内存传输，不代表真实凭据、远端模型或安装版宿主资格；活动 Run 边界由上述真实 Service 回归验证。

2026-10-25，移除常驻刷新后，统一页与完整NativeDesktop联合89项／1905断言、原模型／提供商DOM77项／1042断言通过；Desktop类型及定向Biome通过。宽窄深浅四组合浏览器9003次过程采样／1507帧中，Header刷新／重新读取控件始终为零，健康与unknown路径保持；原关闭重开两侧GET各一次、准确写入次数、模型浮层滚动及草稿／四次会话读取断言保持。上下文读取失败恢复另由DOM核实GET期间同节点禁用、成功隐藏且不重发POST；普通只读无恢复按钮。验证仍限原Native UI／Main与匿名内存传输，不包含真实Service、凭据库或安装资格。

统一页以同作用域同步写锁拒绝同一事件循环内的交叉提交；连接或模型提交、读取及未知状态沿各自原门禁处理，任一未确认提交阻止另一侧新写入。任一侧 applied（含查询原结果）后重读自身并刷新另一侧，读取失败保留错误并后台重读，不重发保存。提供商GET恢复与模型保存分离，普通提供商GET失败不再使模型队列停工或丢尾。两侧合并本地与宿主提交状态时保留已确认的终态，避免迟到 unknown 再锁住页面。连接编辑保留原读取集，模型保存触发的刷新撤销旧草稿资格，不能借新事实继续旧提交。关闭设置期间模型队列保留共享写锁直至排空；选择作用域变化停止旧尾部，Main 的原提交、CAS 与用户级未知互斥仍独立生效。

Main 将用户配置目录加入文件打开和 Git 分支切换的 protected roots；目录尚未创建时按最近存在祖先固定目标，首次配置前也保留保护。

封闭 IPC 拒绝 workspace 模型读取；Main 保存原 Store、选择代次、完整 read-set 与 commandId。用户级未知提交阻止其他会话/项目新保存，空闲关闭停止所属 GET；活动模型队列关闭后继续保存，不取消原提交。未知仅查询原 ID/Store，不重发；历史 journal 中旧 workspace 原意图仍可核实，不能成为新的项目写入口。Service 以用户文件准确字节 ETag 和完整 read-set CAS 发布；字段/注释保留与 key 隐私由该源负责。renderer 不接收 URL、credentialRef 或原 snapshot。输入区、准备页与常规卡均消费相同用户级列表；Session 临时下一轮选择继续独立。

[隔离模型 DOM](test/isolated/native-model-settings-dom.test.tsx)覆盖自动加载、分组/同名路由、默认过滤、真实菜单/开关、保存/失败恢复、未知查询、迟到隔离及空/坏配置。[完整 NativeDesktop DOM](test/isolated/native-new-conversation-dom.test.tsx)经普通用户菜单进入统一设置页并核关闭重开、原草稿和零任务发送。[Main 配置](test/native-configuration.test.ts)、[Provider](test/native-provider-settings.test.ts)与 [Service 实际用户源](../service/test/isolated/user-configuration.test.ts)、[真实模型请求](../service/test/isolated/run-model-selection.test.ts)分别核封闭 scope、原 CAS、单用户文件兼容、跨 Profile 以及真正 wire。当前 Windows 有限回归见此次交付结果；OS vault、macOS 四个窗口 driver 与正式安装资格未因单元/DOM 通过而取得。

2026-10-25 macOS／Bun 1.4.2，合并入口的工作树通过五个设置 DOM/Main 测试文件88项／1147断言，完整 NativeDesktop DOM另82项／1687断言。[统一页集成回归](test/isolated/native-provider-model-settings-dom.test.tsx)覆盖首次读取顺序、精确归属与去重、双向刷新、同事件循环互斥、旧草稿撤权、未知结果查询及刷新失败恢复。既有[浏览器夹具](test/native-live-tool-aggregation-browser.fixture.tsx)和[driver](test/native-live-tool-aggregation-browser-runner.fixture.ts)的 `settings-models` 场景使用生产 Native UI 和实际 Main 设置 manager、匿名内存传输与 journal，覆盖1100／550px、深浅主题四组合，共5079次过程采样／773帧，无页面错误、模型行重复或横向溢出；各组合核实连接保存1次、模型保存3次、原结果查询1次，未知关闭重开不重发，原草稿和会话节点保留。该证据不包含真实 Service、系统凭据库、远端模型或安装版持久化资格。

模型保存applied后仍须完成本面板的自动刷新，期间模型启用开关保持disabled。上述DOM整例以保存后的真实刷新promise固定该窗口，刷新完成后才恢复可用。MCP整窗口driver在相关配置控件恢复后才发原直接配置读取，避免与面板共享reader的自动刷新竞争；不增加sleep、外围重试或页面/整例预算，也不改变生产读取或错误提示。原失败trace只证实直接读取发生在控件仍disabled时，具体GET取消码未留存，配置已实际保存的事实保持。

2026-10-15 Windows x64／Bun 1.4.2／Electron 44.3.0，通过 `bun run desktop:dev` 启动实际窗口，从“个人工作区 → 设置 → 模型”进入后，无须刷新即可读到用户 `~/.kite-code/kite-code.jsonc` 的两个 Provider、五个模型和原默认项。实际禁用非默认模型、切换跨 Provider 默认项后，逐次核对用户文件；菜单正常退出并重新启动，模型页自动读回关闭状态和新默认项，禁用模型不出现在默认菜单。随后通过界面重新启用并恢复原默认项，最后以原文件 SHA-256 核对准确字节恢复；其他配置字段未变，旧用户 Profile 及开发 Profile 的 `config.jsonc` 均未生成。私有备份和临时验证脚本已清理。此实测仅覆盖当前 Windows 开发客户端的模型读取、保存与冷启动，不包含真实 Provider 执行、OS vault 写入或正式安装资格。

原基础、模型、Provider、MCP 窗口 driver 已适配自动列表、开关和默认菜单，并沿各自自有配置文件/用户 HOME 运行。此前 macOS 两模型窗口的 held A/下一 Run B、一次原未知查询、外部编辑 CAS、冷读与所属退出记录仍见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)；这些历史通过不代表当前 user-only driver 已重新执行。

Desktop 私有 SQLite 使用与 Core/维护相同的 profile 共享锁。[Node profile access](electron/profile-access.ts)只打开 Service 已初始化的原 `profile-use.lock`，不创建新的命名空间或替代锁；[一次性 Bun helper](electron/profile-access-helper.ts)通过公开 `@kite-ai/agent/profile-access` 校验继承 fd、原路径与恢复 journal，再取得 POSIX shared flock。helper关闭自己的描述符并退出后，Node仍持有原打开文件描述的锁；没有常驻 Service 或源码/PATH 回退。[私有构建](scripts/build-native.ts)打包固定相对 helper 与 SHA，main同时验证 helper 与固定 Bun 身份。该继承 fd 实现限定 macOS/Linux POSIX，本轮实测为 macOS；Windows失败关闭，不宣称 Windows 生命周期资格。

[私有库](electron/private-data.ts)要求本模块实际取得的有效生命周期句柄；伪造、已关闭、重复附着或不同 profile 的句柄拒绝打开。SQLite成功关闭之后才关闭 Node 原 fd；关闭失败保留句柄与锁并报告失败。初始化检查失败关闭已打开数据库与句柄，未知格式、损坏原文和不安全文件仍不建空库替代。main退出先停止自己的调用者，再关闭私有库，最后清理所属 Service；Service意外退出不释放Node私有库的共享权限。renderer attach或Service失败仍可显示只读诊断，不能扩大为私有库创建权限。

[真实 Node 私有库测试](test/isolated/private-data.test.ts)保留冷读、双进程CAS、分页草稿与坏文件原字节断言，并增加真实 helper 对维护 busy/未完成 journal 的拒绝且不建UI库、有效句柄资格、SQLite关闭失败保锁与关闭顺序验证。[实际 Electron 锁窗口](test/isolated/native-profile-access-electron.test.ts)核对真实 Service SIGKILL后UI仍活且维护立即busy、另一profile可备份、UI正常退出与Node SIGKILL后原profile可维护，以及维护持锁/未完成journal的启动诊断不创建空UI库；窗口16条Node断言，Provider为零。所有构建、profile与进程仅属于隔离临时fixture，不使用共享dist。

profile 生命周期锁接入后的最终完整 Native/共享权限组合实测为38文件、83项、574条Bun断言，全通过（127.46秒，2026-10-02）。新profile锁窗口保留16条Node断言，模型设置窗口保留27条；完整历史、超过17MiB正文、Context、授权和压缩原断言均保留。前一轮唯一失败是压缩fixture末次无点reset只读查询时合法返回accepted、Run尚未可见，却只等待completed；fixture现在在原10秒期限内仅按同一commandId/Session继续GET核实，不再次POST或更换意图，压缩窗口最终35条Node断言通过。Desktop类型、私有构建及本切片格式、文档结构/影响、统一边界和测试归属检查通过；该结果仍为macOS隔离开发制品资格。

[实际长历史窗口](test/isolated/native-history-electron.test.ts)进一步通过真实SSE断开与HTTP410重连验证缺口恢复：fixture暂停所属网络重连并推进隔离库replay_floor，真实Client完成reset、原Store完整分页重读与新ready。两次缺口覆盖5051条/超过8MiB正文、重读期间正文保留且禁写、切换隔离与迟到页拒绝、恢复后实际rename/SSE标题更新；新增三次HTTP写各一次，Model/Provider零调用、原Run不增。当前45条Node及6条Bun断言保留原13条窗口断言，所属Service退出已核实；仅证明macOS开发制品中的实际恢复链，自动retention调度和其他平台资格另计。

原完整默认的一次历史窗口在完成上述业务后，等待 Electron 退出超过原75秒 driver预算；原红仍保留。fixture 仅增加所属 Electron exit／close、Playwright close及 Main before-quit／will-quit 的有限时间观察，原断言、await和75／90秒期限不变。独立原整窗口一次自然退出需4.217秒、code0／无signal，原Service已dead／双流EOF／Provider0；此前超时开始退出时仅余2.396秒，现有证据不足以确认旧现场的内部退出原因。未据此改变生产关闭逻辑或放宽门禁，实际集成结果归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11默认-task-完整回归的父子时序)。

Native 显式恢复由 [main owner](electron/recovery.ts) 与 [renderer 面板](src/native-recovery.tsx) 实施有限 `prepare/submit/lookup/close` IPC。用户明确输入原 Run 或原 `job.report` Command ID；interrupt 必须明确勾选确认。main 读取实际根 Session、Store 与原记录，冻结原 ID 和原 Run 的 `originCommandId`，生成恢复 Command ID，并调用公开 SDK 的 `resumeRun`、`resumeJobReport` 或 `recoverSession`。renderer 只有 DTO 与不透明 observation/read ID；它不拥有 profile、token、Runtime 或 execution owner generation，也不从窗口中的有限 Run 列表推断恢复目标。纯 decoder 与原结果 Run 的 Store/Session/origin 核对共同验证回执；`resumed` 表示已核实恢复受理与原绑定，Run 完成仍须读取实际状态。

面板 scope 切换同时清除旧恢复读取、确认、busy 和错误，保留来源明确的已保存原申请；A 的已显示准备错误不能留在 B 的标题下。现有 epoch 隔离迟回，关闭原 read ID 只结束读取，不提交或取消恢复。新增 [实际 ReactDOM 回归](test/isolated/native-recovery-scope-dom.test.tsx)在旧 production 下核真实失败，再核切 A→B 清旧 alert、保 saved originals、B 当前失败继续显示；另核切换关闭准确 held read ID、迟回零事实/刷新/submit/cancel。它不改变 Main、私有格式或退出生命周期，也不代证自然 HTTP 故障、截图安装包版本或整窗口资格。

[私有 UI 数据库](electron/private-data.ts) schema 2 增加有限 [恢复意图 journal](electron/recovery-journal.ts)，在现有真实 profile 生命周期锁、私有路径检查、`synchronous=FULL` 与 `BEGIN IMMEDIATE` 边界内先保存原 Store/Session/target/original Command 及 main 生成的恢复 Command，再发 POST。schema 1 自动迁移保留原草稿与会话创建意图；未知 schema、损坏文件或坏意图不回退空库。journal 是 UI 请求身份记录，不是 Service receipt 或执行权限。最多 128 项未决恢复；当前进程最多 128 项意图，超界拒绝且不丢弃 unknown。同一 observation 共享原 Promise/Command，一次 POST；丢失或坏回执保留 `outcome_unknown`，不自动重发或自动查询。独立 unknown/accepted 阻止同一实际 Store/Session 的新恢复提交，其他 Session 的意图保持独立。

Native 重开或 main SIGKILL 后，持久 `submitting` 转为 unknown，未决原 ID 只通过显式 `lookup` 做原 Command GET。关闭读取、切换或迟到回应只释放该读租约；不会取消 Run、重发恢复或覆盖独立 unknown。查询已 applied receipt 不重新安装另一次进程崩溃丢失的热绑定；若又发生真实 orphan 边界，必须先核实原意图，再由用户 prepare/submit 新的明确恢复。已知终态不能被迟到读取降回 unknown；未知副作用仍由 Service 原闭包保护，interrupt 回执里的 unknown Execution 不被宣称完成。

[owner 反例](test/native-recovery.test.ts)、[实际 Node 私有数据库](test/isolated/private-data.test.ts)与[真实 Electron 恢复窗口](test/isolated/native-recovery-electron.test.ts)覆盖原 Run/report 身份、明确 interrupt、重复提交、晚回读取消、unknown 封闭、冷 journal、原回执查询以及原 Ask 卡继续。窗口使用显式 SHA 核验的 Bun/Service 制品、所属 profile、真正 Node Playwright main/preload/renderer；实际物理回应断 socket、坏回执与 main/所属 Service SIGKILL 分别保留原命令。report fixture 读取原 Task/child carrier/report，原模型完成不重复，恢复生成 Run 的 `originCommandId` 是原 report Command。此资格仍是 macOS 本机隔离开发窗口，不代表正式安装或 Linux/Windows Electron 资格。

Native 普通 Work 与准确单 Job 停止现在通过 [main caller journal](electron/caller-journal.ts) 和现有 [输入 owner](src/input.ts) 保存完整的五类公共请求：`run.start`、`input.steer`、`input.follow_up`、`command.cancel`、`execution.cancel`。[私有库](electron/private-data.ts) schema 3 在事务中迁移 schema 1/2，保留原草稿、创建与恢复记录，新增 `caller_intents(command_id,state)`。每行闭合保存原 Store/Workspace/Session、认证 subject、完整请求与准确目标、本地完整正文 SHA 和公开 canonical request SHA，可独立附加原草稿 identity/revision/text SHA；不保存 token、lease 或执行 authority。合法 `afterRunId:null` 保留原值，steer/follow_up 都核实当前 contextSelectionId，不能借当前 Run 改写原目标。

普通输入的应用查回先核原公开请求身份，再经共享 Client 查回器读取真实 business Command、Run 和观察 Model。公开 ID 与业务 Run origin 可不同，准确同 Run 补充仍保原 origin；已封存的独立工作不再受原技术 steer target 约束。旧技术 steer 的 target/selection 校验、取消和扩展执行校验保持。只读观察不投影成业务完成，待澄清输入保持 accepted；完整边界归[输入 owner](src/input.README.md)。

私有 caller journal 最多 128 行，原 UTF8 state 文本聚合最多 16MiB；这是本地 UI 私有容量，不能裁正文、驱逐 unknown 或变成服务端 task quota。真实 profile 生命周期锁、私有路径检查、`synchronous=FULL` 与事务提交在首次 POST 之前完成。只有本次新 prepare 得到的完整冻结热意图可发送一次；已存在或冷 `submitting` 行只能查原 Command GET。坏文件、容量、缺本地意图及错误 Store/Workspace/subject/body/target 全部失败关闭；known 不能被晚到失败降级。查询和关闭不会补 POST，取消输入保存准确原 Command 的独立 cancel 请求；停止 Job 先读新鲜实际 Execution，不从父 Run 或另一个 Job 猜目标。

[renderer 原申请面板](src/native-caller.tsx) 只接收有限 metadata 和具名 prepare/submit/original lookup/list/known clear/full-body reader。NativeState 不带累计完整请求。普通 IPC 保留 1MiB 请求与 4MiB 回应预算，只有完整 caller prepare/submit 请求采用独立 16MiB 上界；正文 reader 固定原 Command/read ID、SHA 和连续游标，按页传输，核实完整 EOF/UTF8 字节数后展示。读取关闭、切换和迟到页不能改另一意图。`applied` 仅是原申请回执事实，`cancel_requested` 不是 Job 终态，原业务 controller 继续观察实际 Run/Execution。回执或冷 lookup 不清后来编辑的草稿，也不修改单次 Plan/Workflow envelope。

[实际 Node caller](test/isolated/native-caller-journal-host.test.ts)使用真实默认 Service、SDK、Node SQLite、物理 POST/首 GET socket 丢失和 producer SIGKILL，核对五类原请求只有一次 POST、冷只查原 ID、Core Command 仅一条；另核 prepared 零 POST、空 afterRun 的 stale selection、hot body drift、原 subject/body/Workspace drift、128 槽满与损坏行 before-POST 拒绝。[真实 Electron 窗口](test/isolated/native-caller-electron.test.ts)通过 main/preload/renderer 与实际 owned Service/main SIGKILL，读回超过 1MiB 的合法完整 Workflow envelope，并保留 CRLF/中文/emoji/combining、单次 Plan、后改草稿和原 SHA/EOF。大 Workflow 输入中的未配置 skill 按实际 Service 拒绝，不能称业务 Workflow 完成。双 Job 窗口使用明确配置的 `shell.launch`/`shell.command` host policy，原父 Run completed 后只取消准确一项，另一项仍 running 且零取消；不是默认任意 Shell 授权或 Workflow verifier 资格。维护 manifest v5 的严格 Desktop DB3 备份/恢复由 Core owner 单独验证；旧 manifest 不扩展接纳新 DB。

这些新增资格仅覆盖 macOS 隔离开发制品与上述断言。正式安装、Linux/Windows Electron、整个 §35 管理能力或所有业务结果不能由 caller 回执资格推导。完整请求、wire、Core SQLite 与私有 journal 字节由 fixture 保留在 `/private/tmp`；失败日志保留，原窗口期限与 SDK 校验没有放宽。

本片最终输入/恢复/profile/模型设置/压缩邻接组合为 11 文件、37 项、296 条 Bun 断言全通过（108.97 秒，2026-10-03）；其中五种实际 Electron 普通 caller 窗口全部通过，模型设置窗口另保留 35 条 Node 断言、压缩 40 条、profile 锁 16 条。Desktop types、portable build、21 个归属代码文件 Biome、统一边界、测试归属和文档检查通过。首组合复制 driver 时漏带具名 reader helper，迁移新增断言一度误读只列未决的 creation 目录；两项修复只同步 fixture 实际制品与原持久回执检查，保留失败日志及原期限，没有改为 stub。

最终组合之后新增的五种实际 Electron 窗口增量为 5 项、20 条 Bun 断言全通过（40.60 秒），另在实际 Node driver 核对强杀前后 Core 原 Run/Execution ID 集合完全相同，冷原 GET 不新增执行。该增量独立保留，不替代上述 11 文件邻接结果或将受理回执称为业务完成。

## 恢复后封存 Model 正文

当前 Native 为原Model来源的独立证明提供共享组件的 `canReadRestoredOrigin` 资格；组件仍复核当前 snapshot Store、原 Session／Run／Execution、完整性和字节数。关闭正文撤销准确复制资格；封存 Fork 不借原 Run 的后来状态成为最终回复。Service 的原大正文出处从已核 sealed SQL 的私有 output head 保留，不以当前连接 Store 替换，完整链验证继续由 Core 负责。

[实际安装回归](test/isolated/native-restored-output-bundle.test.ts)构建、搬迁并安装完整候选，删除构建源，通过默认 Main／配对 Service／preload／原页面生成一次108031字节Unicode／CRLF正文并显式Fork。三个真实窗口覆盖原Fork、包内installed CLI明确backup／restore为新Store、恢复首次与冷读，核原Message／Model／Run／Store出处、完整内容／SHA／字节数、关闭／切会话撤销全文、原source复制资格及三Service普通退出／双制品EX释放。读取阶段业务POST为0，Provider总数1；复制按钮资格不代证本片实际写OS剪贴板。原120秒整例／45秒driver／10秒页面期限保持。macOS actual0／1pass／22Bun断言及全部Node流程／78.06秒；局部6文件29pass／254断言和原17MiB HTTP／SDK Fork1pass／46断言通过。准确输入、先前失败和未验组合归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后封存-model-正文)。其他封存／恢复组合、完整installed／发布样本与平台资格仍待核对。

## Native Files 检查点恢复

[Main caller](electron/file-recovery.ts)通过有限的 `fileRecovery.*` 桥读取真实 checkpoint 目录、完整 preview 与恢复状态，观察绑定当前连接 generation、选择、Store/Session/Workspace/contextSelectionId 和输入 revision。Renderer 不能提交任意 Action、请求、Command ID、授权、Profile 或 token。仅会话、仅代码、代码与会话分别使用公共 SDK 的原意图；所有适用 Command/restore/newSession IDs 在第一次 POST 前一次性保存。代码恢复仍经原普通 Action 和独立的人类审批，保存成功回执不代表其他工具已获授权。

Files journal 在 [PrivateData](electron/private-data.ts) 的 DB4 引入准确的 `file_recovery_intents(intent_id TEXT PRIMARY KEY,state TEXT NOT NULL)`；当前 DB7 保留此表，旧版本 0–6 沿各次闭合迁移升级，原四表与 Files 记录保持。整行是完整 `FileRecoveryIntent@1`，主键取首腿 Command ID。异步闭合解析与 SHA 校验不持有同步事务；事务重新核实际已附着 Profile 的 live 数据库、原不可变 canonical 身份、两腿 phase CAS 和单调转换。全部适用 code/Fork Command IDs 跨行唯一；原 UTF-8 损坏、错误 digest/主键/表结构、冲突与容量不足均拒绝，原坏行不删除。目录最多保留 128 行、16MiB 原 UTF-8，不驱逐 unknown。它保存用户申请和核对状态，不保存执行授权。

prepared/submitting/pending/unknown 重开后只能查询原 Command 和准确原 restore ID，不取得热许可、不重新 POST，也不自动继续第二腿。代码成功与 Fork 尚未完成分别显示，关闭、编辑或切换观察不会撤回原申请；迟到结果只更新原保存意图，不能切换新视图。恢复到不同 Store 的旧意图保留原 Store 身份，只读展示，不重新绑定或获得热许可。both 必须明确继续，重读原 Command/status 与原 point 的完整当前 preview，核当前作用域、selector、原 checkpoint 身份和每个文件均为 unchanged。外部编辑或后续合法 Files Run 使它拒绝继续，保留 code succeeded/fork not_started，不重写代码或更换 ID。这里没有全局工作区锁，也不声称消除最后读取与 Fork 之间不合作编辑器的竞态。

[真实 default paired/Node](test/isolated/native-file-recovery-paired.test.ts)覆盖三个 scope、原 Code/Fork HTTP 回应丢失、两份独立 Ask、完整 BOM/CRLF preimage、新 inode、原 ID 冷 GET 零 POST，以及外部编辑和后续实际完成 Run 的继续拒绝。另在完整两腿 intent 已提交 SQLite、首 POST 尚未调用的实际 Node 窗口 SIGKILL，冷重开保原 IDs/unknown、零效果重做。[实际 Electron](test/isolated/native-file-recovery-electron.test.ts)经 Main/preload/renderer/default Service 验证原卡合法 approve_once、代码和 Fork 丢回复、owned Main/Service SIGKILL、冷查原 ID 零 POST与正常退出 owned PID 消失。只读测试观察曾被实际 AbortError 取消；有限 fixture observer 仅在确认真实 abort 后重新 GET，产品没有轮询或自动重试效果。首次 Native 审批解码遗漏 grant 已按有限枚举修复，原失败日志保留。

[真实 Node 私有库](test/isolated/file-recovery-private.test.ts)检查三 scope 持久字节、digest/UTF-8/主键/全局第二腿冲突、容量、单调 CAS、冷 unknown 和旧 DB3 迁移；[DOM](test/native-file-recovery-dom.test.tsx)与[有限 IPC/最终提交 scope](test/native-file-recovery.test.ts)覆盖 edit/hide/scope 变化、迟到观察与持久 submitting 后新选择零 POST。这是 macOS 隔离开发制品与固定本机 Provider 的资格，尚不证明正式安装、旧入口切换、Linux/Windows 或全部 Files/Native 功能。

当前 Native Files 与原 caller/recovery/Session/private-data 邻接为 11 文件、30 项、249 条 Bun 断言全通过（62.99 秒，2026-10-04）；真实 Node 与 Electron driver 的独立断言保留在对应 fixture。Desktop types、portable build、21 个归属代码文件格式及文档/边界/测试归属检查通过。首轮组合的两个失败分别是测试在实际审批卡投影前读取卡，以及旧 Session fixture 固定期待 omitted=true 文案；最终测试等待真实卡、核非法 grant 零 POST 后合法 approve_once，并按实际 applied/omitted 布尔/newSession 回执读取确认分叉。原失败日志保留，生产期限、权限和 scope 校验没有放宽。

## 完整 Native 发行边界

根 `release:build --product native` / `release:native` 使用[Native 构建器](scripts/build-native.ts)，物化实际 Electron、完整新 Terminal、main/preload/renderer 与准确目录/框架链接。主进程同时持 outer 和 inner 两个 artifact SH；一次性 Bun helper 只关闭继承的 descriptor 副本，不解锁 Node 原 owner。Service 独立持这两个 root 的使用权，不能由窗口关闭推导已释放。

归档、双 root 卸载、独立 CLI 注册和 shell cache 的当前产品边界见[Native 制品 owner](docs/native-release.md)。Node 私有 UI 数据库在选 Profile 前测量并核对 manifest 的实际 `node:sqlite`；它与 Bun Worker 是独立引擎。当前本机 Electron 44.3.0 / Node 24.20.0 使用 SQLite 3.53.4，Bun Terminal 使用包内 3.51.3；版本与 sourceId 分别固定。类型、纯版本 smoke 与窗口生命周期是不同证据。Linux arm64 已取得[原完整安装生命周期的有限资格](docs/native-release.md#linux-arm64-安装生命周期)，两次实际窗口均保 Chromium sandbox；Linux x64/Windows、正式签名和完整发布仍待验证。

Native 提供“下一页待决请求（替换当前窗口）”与“停止读取待决后页”。闭合 IPC 只接受 generation、viewGeneration 与实际 afterId，不授予 renderer 注入 Store/Session/工作区或取消 Run 的权限。后页替换最多 20 卡，原实例、Store、Session、工作区、context selection、snapshotCursor 的观察变化使旧页读取失效；它不是 SQLite 跨页快照。显式选择与关闭会 abort 原查询，迟到页不能发布。 原后页整例在丢失原答复并查回 accepted 后，于原 10 秒准备预算内确认获批的原 Job 已成功、首条效果已落盘，以及同 Store/Session/Workspace 的可用视图与事件观察连续 250ms 稳定；答案 accepted 不作为 Job 完成证明。fetch 真正进入后的原未取消/准确关闭或切换后已取消、晚回包不发布和零业务取消断言保持，不重试已经进入的读取。稳定窗口是准备条件，不宣称穷尽所有事件时序。自动事件 refresh 对同一作用域重新读取当前窗口的起点并发布新 generation/revision；作用域变动回到首页，旧卡 revision 不能作为新回答证据。完整附件 gate、原答案 commandId 与只 GET 查回保留。

[页守卫与 Main refresh 回归](test/interaction-pages.test.ts)、[真实 Electron 后页窗口](test/isolated/interaction-pages-electron.test.ts)与[专属 driver](test/interaction-pages-electron.fixture.ts)核对 40 个真实原 Job 卡、真实 renderer 下一页、后页原卡的物理 POST 响应丢失、切换后只查原命令、next close/switch abort、40 原 Job 的 succeeded/一次物理效果和零执行取消。该后页测试核对 Controller 生命周期内原答案查回；跨 Main 冷答案资格由下述专属 journal 与双 Main 测试证明。当前后页证据仍是 macOS 私有开发制品。

原生答案由 [answer-journal.ts](electron/answer-journal.ts) 沿既有私有 UI SQLite 的 DB5 `answer_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)` 保存；旧版本 0–4 原位迁移，未知 future version 失败关闭。单行最多 4MiB，全部 128 行与 16MiB 容量是私有资产的局部边界，满时在首次 POST 前拒绝，不删除未决记录或裁原答案。保存完整原 Store、presentation Session/Workspace、subject、Interaction/Execution/Run、revision、answer、commandId 和 canonical body/request SHA；FULL 提交成功后才允许本次热意图一次 POST，保存失败零 POST。它与业务 Core 是独立 SQLite 资产；维护备份/恢复须保留整份原私有文件字节，不能把本地行解释为 Core 命令权威或审批许可。

冷 Main 将 `submitting` 显示为 unknown，仅展示原身份、摘要与“只查原答复”；没有冷 POST 方法，也不为同一原卡/revision 换 commandId。显式查回先核 admitted Store/subject，再读原 presentation Session 与 Workspace，最后只 GET 原 Command。只有准确 `interaction.answer` 的 applied/`answer_saved`、原目标、decision revision +1、subject 与 request SHA 都匹配才确认；accepted 或错误 kind/target/revision/outcome 仍 unknown。不同 Store/selection 保留原关联 unavailable，查回不切换阅读视图。持久行不恢复旧卡观察、完整附件 EOF/hash 读取证明或授权；新的审批仍须当前有界页、新鲜观察与完整附件 gate。

[有限原意图回归](test/answer-journal.test.ts)核对保存失败零 POST、热提交与冷 GET 的错误回执、subject/Store drift、冷旧卡不能换 ID，以及不恢复附件证明。[实际 Node 私有资产](test/isolated/private-data.test.ts)核对完整 Unicode/CRLF 原答案与大整数 revision 冷开、重复目标/command、容量不淘汰与 DB5 迁移。[实际双 Main](test/isolated/answer-journal-electron.test.ts)使用 macOS 私有开发制品、owned Service/Core、Main SIGKILL 和 Node SQLite 观察，核 POST 前已提交完整原行、提交丢响应后冷 GET 丢一次再查原 ID、cold POST 零、其他 selection 不 rebind、原 Run completed 与原 execution 效果账本一行。此证据不声称正式安装或 Linux/Windows Electron 资格。

原答案随整份一致私有 SQLite 由[维护 v7](../../packages/agent/src/maintenance/README.md#原人类答案请求的独立离线资产)保存、inspect与恢复；新Core Store保旧UI身份，不升级为热权利。纯/实际Node组合13项164断言、相邻8文件38项358断言和真实后页/双Main2项6条Bun断言是各自独立范围，冷Main专项1项3条Bun断言另有真实driver内部断言。丢回执hook转发实际SDK后丢响应，不能冒称物理socket破坏。独立资产的持久理由见[原答案决定](../../.agents/notes/implemented/architecture/2026-10-04-original-human-answer-intent-assets.md)。


## Native Provider 与下一次模型选择

会话首次实际 Run 后，[模型选择器](src/native-model-picker.tsx)从原有序 View 的首 Run 封存配置读取 Responses／Chat Completions 协议，只在原列表提供同协议候选；思考面板不显示协议提示；仅在模型列表底部以12px辅助文字显示“仅显示当前对话可用的模型”。同协议模型与连接仍可选择，effort 从下一轮生效，活动 Run 保持原值。首次实际 Run 前不限制协议，准备拒绝没有 Run 时也不提前绑定；首配置无法核实或原所选路由协议已变时保留当前标签并明确不可用，不跳到晚 Run、不静默回退另一协议。Core 视图额外保留最早实际 Run，超过200轮及冷重建同样有效；恢复后的旧 Store 出处由原准入 View 保留。服务端独立校验归[Service owner](../service/README.md#会话模型协议)，不以客户端过滤代替准备守卫。

2026-10-24，macOS arm64 的独立合成 HOME／Profile，普通 development Main、真实配套 Service 和生产 renderer（`testDiagnostics:false`）完成协议实际窗口验证：首 Run 前可选 chat-a／chat-b／responses-a，Chat 首 Run 后仅两个 Chat 候选；明确选择 chat-b 和 high 后，第二次实际请求仍走 `/chat/completions`，wire 采用 chat-b／high。新对话再次提供三项，实际选中 responses-a，未发送该准备输入。125个连续过程帧保留两轮用户／回复顺序及实际档位，Renderer 零页面错误；没有外部 Provider 或真实凭据。证据为 `.cache/codex-review-20261024/protocol-live-verified/` 的 report、frames 和 trace，原夹具初始化失败的独立目录保留。直接 API 的双向拒绝与冷重建由上述 Service 回归负责，不把此窗口证据外推安装包或其他平台。

普通 Native 回复沿共享 `autoRead` 自动获取原已保存的完整正文；没有“回复预览”“完整回复”标题、查看／收起／重新读取按钮或原始 Tool calls 区。SDK 与组件完整身份／EOF／SHA／字节校验继续保留，核实后才出现原全文复制资格；真实读取失败保留原文并说明失败。[正文 reader](src/native-model-output.ts)按同一 bridge 的输入／输出类别分别串行读取，符合 Main 每类单 lease 的边界；排队时取消不打开或关闭其他读取，失败结算后后续消息仍可读取。旧历史、缓存返回和新回复均走同一组件，不新增 Runtime 请求链。对应[共享正文](../../packages/ui/test/model-output.test.tsx)、[有限 IPC](test/native-model-output.test.ts)、[Native 缓存](test/isolated/native-model-output-cache-dom.test.tsx)、[整轮复制](test/isolated/native-child-copy-dom.test.tsx)和[Web 原来源恢复](../../tests/isolated/unified-agent/restored-web-model-output.test.ts)覆盖大正文、并发读取、暂停／迟到隔离、复制撤销与零业务重放。

2026-10-24 当前 macOS 普通开发窗口（测试诊断关闭）实测：原用户“打招呼”历史直接显示完整回复，无多余标题／按钮；新建 Codex `gpt-6.1-sol` 读取本机 Max 档，真实拖动至高后三处标签一致，实际 Command 与 Run 冻结配置均为 `high`，真实回复 `AUTO_FULL_REPLY_OK` 完成。完整退出重开后恢复高档位，255帧观察仅一条用户／助手消息、完整复制可用且零正文控件，原命令仍只有一次提交。证据位于 `.cache/codex-linux-effort-live-20261024/`，不代替安装包或其他平台 UI 资格。

同日本轮使用独立 HOME／Profile／Electron 数据目录、真实本机 Codex 登录与 `gpt-6-luna/low` 完成6轮实际请求。首轮、跨轮验证码和停止后新发送成功；实际输出中停止结算为 `cancel_requested`。工作区文本 `read_file` 两次携带 PDF 参数失败，明确纠正后的5次同参失败触发 `repeated_tool_failure`，文件任务未完成。初次隔离 HOME 缺少用户配置父目录时，原命令在 Model 派发前被拒绝，补建测试目录后才继续；原拒绝记录在后来回复下方显示且冷重开投影变化，问题仍保留。12次 Model 中11次回传65561输入／340输出／4224缓存输入 token，取消请求未回传用量；不把这些值称为完整账户总耗用。原驱动的取消状态等待和未成功文件标记断言没有全绿，实际取消、完整持久正文和冷读由独立只读核验补证。原失败、过程帧、截图与 trace 位于 `.cache/codex-luna-real-20261024/`。

正文按钮与并发读取修复后，在上述真实历史上重新构建普通 Main／生产 renderer、真实 paired Service，连续两次冷启动及切走返回均自动读完4份正文并恢复4个准确复制入口，180个过程帧没有正文重读按钮或读取错误。两次正常退出均为0，读取前后 Command／Run／Execution／Message／MessagePart 完全相同，没有新增模型或工具派发；证据位于同目录 `fixed/`。共享正文、有限 IPC、缓存及子详情复制4个完整文件26项／302断言通过，UI／Desktop类型、定向Biome、文档、边界与测试归属检查通过。相邻模型输入文件的两个有限 reader 用例通过；205请求目录用例在正文读取前选择会话时报 `native_selection_changed`，串行复跑及原 reader 对照均复现，未把该项称为通过，也未扩张本次修复。这些证据限当前 macOS 开发客户端，不代替安装包、完整默认回归或跨平台资格。

随后修复 [Responses 函数工具可选参数](../../packages/ai/README.md)和 [PDF 参数说明与失败恢复](../../packages/agent/src/tools/files/README.md#会话文件与-pdf)，同日以独立 HOME／Profile／Electron 数据目录、普通 Main／生产 renderer（`testDiagnostics:false`）、真实 paired Service 和本机 `gpt-6-luna/low` 重验：首轮采用原失败提示读取工作区文本，实际调用只含 `path`；第二轮改动文件中未出现在提示里的随机值，再明确读取第3行，实际采用 `start_line=3/max_lines=1`。两个 `files.read` 均仅执行一次且成功，未混入 PDF 参数，最终回复与各自真实文件内容完全一致。两 Run completed，4次实际 Model 回传23203输入／78输出 token；438个过程帧保用户／工具／回复顺序、两条完整正文、空输入、零正文错误或重读按钮。完整退出重开后两条正文及复制恢复，Command／Run／Execution／Message 没有变化；两个窗口正常退出0、页面错误0。完整 report、Core事实、过程帧、截图与 trace 在 `.cache/codex-luna-file-read-20261024/`。此前失败保留原记录；此次验证限定当前 macOS 开发客户端及两种文本读取，不外推实际 PDF 视觉模型、安装包或其他平台。

本机 Codex 连接显示“自动接入”，说明沿用本机登录；没有编辑、删除、地址或 key 控件，也不会出现在新增模板中。模型启停、默认和思考设置仍走现有模型页与选择器，完整认证来源及失效恢复见[模型手册](../../docs/handbook/features/models-and-configuration.md#chatgpt--codex-本机自动接入)。Main 与 Service 都独立拒绝将自动连接改为手工意图，即使 renderer 伪造可写标记也不会发送保存。此来源只传非秘密模型与连接事实，账户原文和 token 不进入 Native IPC。

提供商目录现在平铺真实连接及自动发现的本机 ChatGPT / Codex 来源，四个手动协议族仅作新增模板；名称与稳定连接 ID 分离，同模板/同地址可多实例。新增、编辑、删除确认均沿 settings shell 最右 `RightSidebar`，保存失败留表单，成功且刷新完成后关闭，删除后的焦点回新增入口；迟到回执不覆盖新表单。Main 从 Service安全快照复制模型/默认引用，并只从本机私有库读取关联定时任务与未结束运行名称。删除在提交前重读这些引用，拒绝默认或定时依赖，不撤销 Vault 秘密。Native caller 将提供商写入与定时任务保存/启用串行，未知删除期间禁止新增任务引用，冷行仍只查原 GET。该保护不宣称能阻止非参与式外部编辑器或其他客户端修改用户 JSONC。

[Provider DOM](test/native-provider-settings-dom.test.tsx)、[Main/IPC](test/native-provider-settings.test.ts)和[真实HTTP](../service/test/isolated/provider-settings.test.ts)覆盖列表/CRUD、旧配置、删除保护、重复点击和未知原回执；隔离 Linux Electron 预览使用无凭据本机测试配置，不代表付费服务、系统 Vault、正式完整构建或三平台发行资格。

[Provider 面板](src/native-provider-settings.tsx)和[模型选择器](src/native-model-picker.tsx)是正式 Native renderer 消费者；Main 的[Provider manager](electron/provider-settings.ts)沿公共 Client/Service 管理接口固定原 Store/generation、用户观察 readSet 和五字段操作。renderer 只持安全连接/模型事实，不取得路径、credentialRef 或 opaque revoke authority。四类明确 family，手动名称直接保存、留空才显式发现；切换/关闭清未保存密钥与字段，局部必填/URL 错误聚焦，提交后密钥清空，等待/未知跨关闭保留。凭据与配置结果分别显示；已发布后的刷新失败保原结果，原 GET 的 applied 刷新输入选择器，不重绑定迟到面板。新模型 disabled，默认禁用门禁和开关失败恢复保留。

提供商页的展示样式由 [专属 CSS](src/native-provider-settings.css)维护：连接列表显示名称、类型和配置状态，选中行保留高亮。按照[配置编辑交互约定](../../docs/handbook/clients/desktop/README.md#配置编辑交互)，[Native 设置壳层](src/native.tsx)在 `settings-content` 同级的应用最右端提供 `settings-editor-panel` 宿主；[Provider 面板](src/native-provider-settings.tsx)以 portal 复用定时任务使用的 [RightSidebar](../../packages/ui/src/desktop/RightSidebar.tsx)，而非主区内分栏或新弹窗。面板头与底部取消/保存固定，连接、凭据与模型字段独立滚动；窄窗贴右覆盖而不把表单排入列表，沿用亮暗主题变量。

新增直接打开表单并聚焦服务商预设下拉框，编辑聚焦名称；关闭、取消、Escape 恢复原列表按钮焦点，Escape 在编辑器打开时不关闭设置。直接提交或原提交查询确认 applied 后共用刷新并收起原面板的流程；仅当前身份、编辑代次和原目标仍匹配时关闭，验证/保存/刷新错误保留表单；提交仍立即清密钥，未知提交跨面板关闭保留且只能查询原提交。新增表单内通过服务商预设下拉框选择模板；不另显示预设列表。列表和编辑栏均不展示历史提交结果、技术详情或内部 ID，成功后直接更新列表，不另加成功提示；失败及结果未知仍保留必要反馈。结果未知时显示精简提示与“查看结果”，跨提供商或数据源的未决更改仍可查询；原内部账本和写入锁不变。关闭时清理读等待状态；读取开始即废止旧写观察，取消读取后需重新刷新才可保存；编辑版本隔离迟到保存/刷新，不关闭或重绑定后来选择的编辑器。切换分类或 Store 卸载原面板并保留原提交语义。该轮不新增 Service、发现请求、凭据读取或协议降级；模型及常规设置的其余编辑布局仍待单独迁移。

[Provider DOM](test/native-provider-settings-dom.test.tsx)核 portal 归属、表单语义、成功关闭、失败保留及迟到结果；[完整 NativeDesktop DOM](test/isolated/native-new-conversation-dom.test.tsx)核实际设置壳层的最右侧宿主、Escape 分层、分类退出、焦点及原会话草稿不变。测试断言与实际运行结果仍分别记录，不能据 DOM 测试宣称系统凭证库或真实付费模型已验。

2026-10-16 Linux 云端开发窗口（Bun 1.4.2／Electron 44.3.0）已从普通用户菜单检查列表、OpenAI Responses 表单、模型区域、空凭据错误聚焦，以及亮暗主题与窄窗口。提供商 DOM 5 项／80 断言与 Main 3 项／40 断言通过，Desktop typecheck 通过。默认 workspace build 在既有 `linux-shell-init.c` 的未使用 write 返回值警告被 `-Werror` 拒绝；仅本地预览构建使用保留警告的 `-Wno-error=unused-result` 编译包装，未修改该源码或仓库编译规则。没有真实 key 输入、凭据库写入、远端模型发现或付费请求；此证据不代表正式制品、完整回归或跨平台资格。

[配置原意图](electron/configuration-journal.ts)在首次热 POST 前 FULL 保存非秘密原 input 与 safe state。[PrivateData](electron/private-data.ts) 的 DB6 从 DB0–5 保留原六表，新增准确 configuration_intents(command_id,state) 与 model_routes(store_id,session_id,model_id)；当前 DB7 保留这八表并增加下文独立 MCP 记录；前者最多128行/16MiB、原 input 不可替换、终结才删除，坏行保字节并拒绝写。Provider 与模型设置共用原 Store 未决门禁。冷行只允许原 ID GET；当前Store的模型／提供商设置页可自动核对这些未决项，不持有secret、不自动POST，也不补造旧热scope或续写proof。已存未发布的 opaque reference 只留 Service/认证 SDK，Main 不投影它到 renderer。

模型选择按 Store/Session 保存，首条原 start/follow-up intent FULL 保存后才记本次模型 ID；打开新 Session 或读设置本身不绑定 route。输入只从 enabled/configured 的完整目录选择；缺失原显式 route 不回退全局默认。当前未提交的临时 effort 保留在页面会话状态中，换模型／刷新后清除；没有当前手动选择时，由[NativeModelPicker](src/native-model-picker.tsx)从当前投影最新的同 Store／Session Run 中，按 `configuration.snapshot.configuration.models` 的唯一 Model ID 恢复真实档位，再回退当前模型配置。新会话准备页只恢复下文已明确选择且仍有效的全局推荐；恢复值与当前选择共同交付下一次 start／follow-up，普通 active steer 继续只发送文本。已保存的 none/minimal 按兼容值恢复；其他历史档位不在当前可选列表时，保留显示并阻止发送，可通过原滑块改选可用档位。没有可确认的历史或配置值时保持未指定，不用滑块起点补造实际档位；不新增 model_routes 字段或配置 journal 写入。[主输入](src/native-input.ts)冻结实际下一次 model/effort 到 start 与 active follow-up；普通 active steer 保原文本/target，不改活动 Run。ModelInput 和实际 wire 使用同一原设置。

输入区显式选模型或调整 effort 后，[推荐偏好](src/native-model-preference.ts)在浏览器 `localStorage` 的 `kite.desktop.recommended-model.<storeId>` 同步保存准确模型 ID 与实际思考档位，沿用主题偏好的客户端存储方式。它在同一 Store 的所有空间项目间共用，不改配置默认、会话数据库、配置 journal 或已有 Session 的 route。每次点击新对话清空准备页临时选择，目录核实后读取推荐；推荐路由无效时保留“选择模型”，不采用目录首项或配置默认，恢复推荐不回写。没有记录、读取受限或内容无效时按没有推荐处理，保留原存储字节；显式选择保存失败仍保留当前窗口选择并显示简短错误。已保存推荐同步更新准备页展示缓存，缓存不授予发送资格；发送仍等待当前目录读取和原权限核验。浏览器存储按应用来源保留，清除该来源数据后回到“选择模型”；其他 Store 的推荐隔离。

2026-10-25，`852f665b0`加本次推荐偏好修改，Windows x64／Bun1.4.3：`bun test --parallel=1 --max-concurrency=1`执行[选择器DOM](test/isolated/native-model-picker-dom.test.tsx)与[主输入](test/native-input.test.ts)，33项／363断言通过，覆盖浏览器存储受限、损坏内容保留、推荐失效回退、跨会话隔离与实际输入冻结。Desktop typecheck、定向Biome与文档检查通过。沿[会话文件隔离页面夹具](test/session-files-browser-runner.fixture.ts)临时配置两个模型与两个项目，逐步观察选择非首项、调整Ultar、另一个项目新对话和页面刷新后的相同组合；已有会话仍保留自身选择。该页面使用真实Native renderer与隔离Main／Service，私有UI端口为测试替身；不代表安装版、其他平台或真实外部模型资格。 此为合并前的验证记录，其中无有效推荐时回退首项的行为已由当前“选择模型”门禁覆盖。

[NativeModelPicker](src/native-model-picker.tsx)的选择来自页面明确 `value.modelId`、当前Session的已存 `selectedModelId`，或新对话准备页中已手选并保存且仍可用的推荐，不回退 `defaultModelId` 或目录首项。新对话准备页忽略Session选择 metadata；没有上述有效选择时显示“选择模型”，`onReady(false)`且不返回choice，刷新默认配置也不自动选中。Root发送首条消息或新轮次同时要求ready和准确modelId；活动Run的普通steer沿原语义。旧Session的已存路由继续恢复，失效路由不回退默认；有Run但没有存路由时也保持空选择，不新增历史模型推导。这是Desktop选择门禁，Service及其他调用者的全局默认配置合同保持原范围。2026-10-25，Picker／模型列表／输入意图／完整NativeDesktop四文件170项／2762断言、Desktop类型和定向Biome通过；新会话发送正例通过真实Picker明确选择，首次未选的按钮与Enter均零请求，既有saved route／draft和active steer保留。JSDOM整文件对Radix合法零矩形clip存在解析缺陷，夹具仅将exact零矩形交原setter为等价CSS变量fallback，其他值与关闭还原保持，原异常日志保留；不据此替代真实布局验证。同轮匿名生产UI／Main浏览器夹具在1100／550px深浅四组合通过，共14328次采样／2603帧，无页面错误：初始placeholder→手选零写入、新准备页不继承会话模型且Enter无提交、模型行默认badge始终为零。原自动恢复、精确路由、默认禁用门禁、原Session／草稿与四次读取保持；不包含真实付费模型或安装版资格。

正式输入区复用[原模型与思考浮层](../../packages/ui/src/desktop/ModelEffortSelector.tsx)和宝石滑块；Native 仍负责准确目录读取、作用域/迟到隔离、原 route 与就绪门禁。双栏列表按实际 Model ID 选择，同一提供商内同名模型显示 ID；所有配置可用模型均可调节思考程度，Service 提供 `low/medium/high/xhigh/max/ultar`，显示「轻度、中、高、极高、Max、Ultar」。浮层不显示配置默认／关闭思考按钮，也不把档位写成“默认”；顶部、模型按钮摘要和滑块的无障碍值显示同一具体档位；无可确认值时均显示“未指定”，不补造实际请求参数。已有会话按当前选择、上次实际使用值、模型配置依次解析，新会话按当前选择和模型配置解析；旧 none/minimal 继续可读，换模型清当前临时选择。观察事件或临时 effort 不触发重复目录读取。[隔离 DOM](test/isolated/native-model-picker-dom.test.tsx)核 DeepSeek 滑块与 Ultar、准确同名路由、稀疏档位、旧 none 配置、两按钮缺席及迟到隔离；实际 [Model Settings 窗口](test/isolated/native-model-settings-electron.test.ts)仍核活动绑定、原 CAS/丢回执、下一轮切换及冷读，历史输入和源码外候选结果见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-模型与思考选择器)。其他历史 Provider/Vault 窗口记录保留其原输入范围。

2026-10-20，Windows x64／Bun1.4.3，`5dba8a6b`工作树加本次会话档位恢复修改：`bun test --parallel=1 --max-concurrency=1`执行[模型选择](test/isolated/native-model-picker-dom.test.tsx)、[主输入](test/native-input.test.ts)及[共享浮层](../../packages/ui/test/isolated/model-effort.test.tsx)，18项／199断言通过；Desktop `tsc --noEmit`、定向Biome与文档检查通过。Chrome155沿真实NativeModelPicker／Composer及生产样式核深浅主题、1240／360px、新旧会话的首次打开，并沿隔离Main夹具核完整NativeDesktop中A／B会话各自的“高／轻度”和新会话配置“中”，共10组通过。旧none/minimal与失效历史档位改选另由上述DOM回归覆盖；没有真实付费模型请求、安装版窗口或其他平台资格。

[实际默认 Native 候选](test/isolated/native-provider-bundle.test.ts)与[Electron driver](test/native-provider-electron.fixture.ts)在 macOS、源码外搬迁制品、自有 HOME、OS PATH、固定 SQLite 与默认 OS vault 下通过1项/190条Bun断言：四类表单、一次真实发现、7根Run/8次SDK请求、原 effort、活动冻结与下一次切换、新 Session 首次绑定、物理保存丢回执后冷原GET一次/POST零。两个所属 Service PID 正常结束；实际两枚测试凭据由 Service 准确 revoke，profile exclusive lease 可重新取得。endpoint 是受控 loopback，退出 warning 用明确 dialog 端口回答；不证明付费远端、系统 modal 点击、签名安装或其他平台。有限 Main/DOM/输入15项137断言、真实 HTTP8项93断言支持对应局部边界。

当前 Provider／MCP 窗口夹具通过[自有 HOME 的钥匙串引用](test/owned-default-keychain.ts)保留上述真实 OS 后端：只读查询 OS 用户默认钥匙串，在私有 HOME 建立引用，不复制内容或更改系统默认／搜索列表；只保存并精确撤销本例随机凭据。各窗口和 Service 的模型配置统一读取自有用户文件，不能再以 Profile 旧文件构造可用模型。实际 Run 恢复的丢回执旅程先用原 Command GET 确认应用，再关闭所属进程，配置必须保留准确同一工具与运行环境；不将 accepted 伪称恢复完成。整轮范围归[客户端 UI 收束](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-15客户端-ui-迁移缺口与回归收束)。

本轮当前原完整默认589文件/471原任务全部通过，runner exit0/drain815.977s，4009regular输入与Git前后相同；其中上述实际Provider窗口45573ms及原Model、安装、CLI/TUI、Context/后页/持久答复消费者均通过。原红、嵌套同名fixture、制品摘要和权限环境范围见[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-06native-provider-设置与下一次真实模型选择)；完整默认通过不代表完整V1.3、MCP设置或三平台资格。

Profile 无三项 raw MCP 文件时，DB6 离线备份使用专属 manifest v14；任一实际存在则优先使用下文 v16。原设置 input、Session route 和完整含 effort 的原 caller 请求在新 Core Store 下保旧身份；冷读不发送请求。旧 v2–v13/DB1–5 仍按各自闭合格式，维护 codec 不依赖 Desktop/Client，见[维护 owner](../../packages/agent/src/maintenance/README.md#desktop-db6-与-manifest-v14)。

原意图、两个介质结果和临时选择的长期取舍见[已实施决定](../../.agents/notes/implemented/architecture/2026-10-06-native-provider-intents-and-next-run-selection.md)。

## Native 公共扩展完整能力

Model 输入／输出、人工卡附件、后台子会话与扩展正文的 renderer 分片传输共用私有 [有限字节 reader](src/native-body-chunks.ts)。它只核原 readId／kind、base64、64KiB 分片、offset 前进与准确 EOF；打开／关闭读取、原 scope／generation／selection、SHA 与 UTF-8／业务身份核验仍归各 reader。扩展保留格式无效与内容不完整两类原错误，不由字节复用授予额外读取或执行权限。[扩展 reader 回归](test/isolated/native-extensions-dom.test.tsx)覆盖坏 base64、异读身份、零进展、提前／缺失 EOF 和原关闭归属。

[NativeDesktop](src/native.tsx) 的自动测试侧栏“会话工具→扩展能力”现消费已注册目录、公共 `ActionInputForm` 和 `PublicViewCard`，通过固定 [协议](src/extensions-bridge.ts)、[IPC](electron/native-ipc.ts) 与 [Main 叶子](electron/extensions.ts) 完成动作表单、原 Command／Execution 状态、注册 Query、完整通用结果和原结果动作。没有按参考扩展业务增加 Client／Service／内核方法；参考样本不进入默认装配。

Main 从当前准入推导 Store／subject／Session／Workspace／contextSelectionId 与 generation／viewSelection／historyEpoch，冻结目录和结果观察。完整 JSON 经每块至多64KiB、准确 offset／EOF／SHA／fatal UTF-8 的 [reader](src/native-extension-read.ts) 交付，没有全文配额或截断；最多两份在读 body，超界明确拒绝。只有完整 EOF 才取得该观察的动作资格；刷新、关闭和切换撤销观察，旧完整结果可保留供阅读，旧结果动作必须重新查询。Query、阅读和关闭均不提交 Command或取消业务。

动作沿原 [CallerJournal](electron/caller-journal.ts) 的完整 intent、first／inflight 与现有 `caller_intents` 表；只有当前进程新成功准备的原对象可首次 POST。未知和冷申请只能明确查同一原 Command，重复调用不重发。Main核公开 Command原主体／scope／requestDigest与receipt指向的实际Execution／定义／版本，受理与终态分开；raw input不冒充prepared digest。泛型 caller.submit 对扩展只查询，不能绕过已读定义／原结果动作坐标。尚未确认终态的申请不能清除，明确新动作才产生新ID和用户填写的新业务身份。

Native局部 `NativeCallerCommandRequest` 增加公共 `ExtensionCommandRequest`，共享CLI／TUI五类Caller不扩大。首次保存这类申请才在同一FULL事务惰性升级DB9，未使用的新旧流程保持原版本；维护仅对应 closed manifest v18 接纳DB9，原DB1–8及v2–v17 grammar保持。恢复保原申请字节与Store，foreignStore／subject在HTTP前拒绝查回。准确格式与实际Node备份恢复归[maintenance owner](../../packages/agent/src/maintenance/README.md#desktop-db9-与-manifest-v18)，取舍归[扩展调用决定](../../.agents/notes/implemented/architecture/2026-10-09-native-public-extension-callers.md)。

[真实公共链](test/isolated/native-extensions-main.test.ts)、[Main／journal](test/native-extensions.test.ts)、[原组件DOM](test/isolated/native-extensions-dom.test.tsx)与[安装版整窗口](test/isolated/native-extensions-bundle.test.ts)分别核真实执行、持久权限、原用户入口及完整mini-review链。窗口只将参考扩展和可信分类在候选hash发布前显式装配，普通模型、权限保存、配对Service、Main／preload／renderer和sandbox保持正式实现；具体通过、失败和平台范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)。它不代证任意外部扩展、旧writer运行DB9、完整PC或阶段退出。

## Native MCP 完整设置

普通设置不展示已确认成功／取消的提交历史、command/action/Store/Session/association 元数据或原 fact/认证/source DTO 的 JSON。真实失败继续给出可读提示，未确认或进行中的原操作保留“查看结果”和必要取消；数据绑定、精确原申请查询与取消资格不变。连接、来源与认证详情只展示操作所需的可读字段，删除复核保留用户决定所需的名称、地址或启动命令。

[设置页](src/native-mcp-settings.tsx)和新的 [Main manager](electron/user-mcp-settings.ts)消费 `user_mcp_settings`。身份只有实际 Store、认证 subject 与连接 generation，不依赖 Session／Workspace、trust 或对话目录。两个全局页在空 Store 可直接读取，普通会话选择和当前工作区移除不释放其读租约；全局身份替换、页面关闭与连接结束仍废止迟到读取。MCP 只列 user source，页面无范围切换、项目批准或项目配置行。用户从统一列表管理来源、启停、认证与连接，在共享最右侧 [RightSidebar](../../packages/ui/src/desktop/RightSidebar.tsx)新增服务或阅读工具参数；参数只显示实际已取得的 descriptor，不调用远端工具。

新增仅收无凭据 HTTP URL 或绝对 stdio command，高级声明由配置 owner 管理。Main 固定 read-set 与本次原操作，renderer 仅提供有限操作和观察 ID。Service 全局 owner 有自己的 HostMutation 与真实资源生命周期，不借用 Session Action 或建立隐藏 Workspace／Session；它不执行工具。认证、连接与真正 Agent Run 的工具授权各自独立，401 不自动 Login 或重放 RPC。关闭详情清理未提交复核和工具读取，关闭分类只释放读取，不取消已提交全局操作；取消必须明确针对原 operation ID。

原 [Session manager](electron/mcp-settings.ts)及旧闭合 codec 保留历史申请恢复。DB7 同一 `mcp_intents` 表接受显式 version 2 全局 request，保 Store／subject、完整非秘密 operation、read-set 和摘要，version 1 的 Session 请求格式保持。容量、FULL 保存、未知不淘汰与冷行无热 POST 权保持；冷启动不自动查询或重发，明确“查看结果”只按原 ID 读取。可确证 user 的旧未知操作继续阻断冲突修改，旧项目配置不进入全局列表；无法判定来源的历史连接只显示原结果查询通知，不伪装成用户配置。确证终态不被后来 pending／unknown 降级，写文件或停止结果不确定继续保留 unknown。

用户来源被外部删除或配置不可读时，已持有的全局连接仍有明确停止入口。Main 仅对已观察到的失效／不可写连接开放准确 disconnect，其他配置和认证操作继续拒绝；同一连接已未决的 stop 不能再提交。详情只显示必要的断开操作，保原 ID、Store／subject、持久意图和资源停止证明，不能借该例外新建连接或写配置。旧 `settings.mcp.*` renderer namespace 只保 lookup／clear／close，不能重新打开 Session／项目管理入口。

新的全局设置取舍见[用户级边界](../../.agents/notes/implemented/architecture/2026-10-24-user-global-extension-settings.md)。以下旧 Session 窗口记录只证明其注明的历史输入；它们不代证新的全局页面、认证身份或客户端过程。

[用户 Main 回归](test/isolated/native-user-mcp-main.test.ts)、[MCP DOM](test/native-mcp-settings.test.tsx)、[真实 Node 维护](../../packages/agent/test/isolated/maintenance/desktop-mcp.test.ts)与迁移后的[源码外 Native 窗口](test/isolated/native-mcp-bundle.test.ts)已验证新的全局链：空 Store 无会话可用，HTTP／stdio 增删启停及连接生命周期、工具说明全文与参数／连续分页、会话切换保未提交表单与全局读取、两次 Escape、已确认终态冷开保持，以及未知原 ID 显式查询不重 POST。冷 SQL 核全局操作使用 `config.user.write` HostMutation，零隐藏 Session、Run 或 `extension.invoke`，测试所属进程与合成凭据清理均确认。Skills 的独立窗口证据归其 owner 段落。该证据使用自有本机网络和候选；全局 OAuth 的受控协议测试不代替人工系统浏览器登录、外部账号或其他平台安装资格。

[MCP DOM](test/native-mcp-settings.test.tsx)、[Skills DOM](test/native-skills-settings.test.tsx)及 [设置壳 DOM](test/isolated/native-new-conversation-dom.test.tsx)覆盖右栏归属、关闭／焦点、输入验证、复核失效、迟到读取与原提交保持。局部 UI 验证不代表外部 MCP、真实凭据或跨平台安装资格。

[私有 MCP codec](electron/mcp-journal.ts)在 DB7 的 `mcp_intents(command_id,state)` FULL 保存完整非秘密原申请，独立128行/16MiB原字节上界，坏行保字节并拒绝写，未知不淘汰。首次提交前保存，冷/foreign 行不获得热 POST 许可；明确 Check 只查询原 ID，取消需准确原 Execution 的普通持久 caller 申请。已确认终态不被后来 pending/unknown GET 降级。来源发表成功但独立凭据清理失败/未知时保声明已保存与总体未确认，不能清除为成功。[DB7/manifest15 维护](../../packages/agent/src/maintenance/README.md#desktop-db7-与-manifest-v15)保独立 codec、历史 DB/manifest 白名单及原 Store 身份，恢复不自动 GET/POST。

Profile 无三项 raw MCP 文件时 DB7 创建 v15；`mcp.json`、`mcp-approvals.json`、`mcp-auth-bindings.json` 任一实际存在则创建 [v16](../../packages/agent/src/maintenance/README.md#profile-mcp-配置资产与-manifest-v16)，同时保留上述完整 UI 资产和三项原字节／absence／proof。恢复不读 Vault，项目配置仍在 Workspace；当前 source consumer 核新 Store 与物理 scope，旧项目批准和 credential binding 不获得新执行权，普通当前 Action／Question 才可新增决定。Native codec、冷读和原请求 grammar 保持。

[真实 Main/HTTP](test/isolated/native-mcp-main.test.ts)当前1项67断言，隔离夹具通过正式控制为准确Session/Workspace持久设置Full与信任，并核applied和当前revision；独立来源批准、凭据和只读边界保持；[源码外 Native 窗口](test/isolated/native-mcp-bundle.test.ts)本轮1项29条Bun断言，driver另核实际UI与协议：两范围 Add/Remove/Select、项目批准、真实默认OS引用的bind/revoke、stdio/HTTP独立审批与ready、248180字节Unicode descriptor及零新增RPC、refresh、reconnect oldStop、下一Model schema/独立Tool Ask/一次效果、DB7冷原GET一次/POST零。两个Service PID正常退出，准确测试凭据fresh backend absence及所属进程无残留均核实。候选使用构建前固定的测试loopback网络，不冒充生产网络、OAuth、外部账号或三平台资格。

2026-10-19上述原源码外窗口在当前输入下1项29条Bun断言37.84秒通过。审批driver按准确Store/presentation Session/卡ID/revision只操作一次，避免将已保存原答案的pending快照再次点击；新的revision仍可独立操作。正式原答案GET及双Main退出后的只读SQL共同核唯一applied答案、准确decisionRevision、两成功Model/一成功Tool和一次效果。原独立审批、完整descriptor、OS引用、两范围操作、冷GET/零POST与清理及预算保持；生产审批、缓存和权限逻辑未改，原失败证据归[测试owner](../../tests/README.md#子-agent-协作-v11-验证)。

macOS owned stdio 停止结果的新增观察字段已迁入[正式连接／重连／冷结果消费者](../../packages/agent/src/mcp/README.md#强制重连持久发布与原事实)，没有删除原字段或改写未知事实。普通建立失败仅在冻结原摘要、准确新建Job及可靠停止都成立时可由原Check确认失败，随后独立新申请；未知停止或旧无摘要结果仍unknown。原源码外窗口1pass／18断言证明旧连接停止后新连接、下一轮Model独立Tool审批与一次效果、两所属Service正常退出和冷原GET／零POST；本轮真实默认stdio补齐失败→原Query→新connect→完整descriptor→独立Tool Ask／一次效果。该新增Service测试不冒称已在Native窗口重新点击失败查回；取消／退出实现未变，复用原窗口并由本轮完整默认覆盖相邻消费者，准确范围归上述进度。

窗口Host只在已验证候选的shared lease内，使用packaged runtime/config的默认OS backend准备准确自有引用；helper沿正式paired Service的有限PATH/LANG环境，父测试与Native driver仍保隔离HOME。引用ID在put前保存，失败也可准确remove；独立新helper/backend核absence后才释放shared lease并复核exclusive权。不发现用户Kite配置、枚举其他Ref或修改系统keychain设置。

[人工浏览器资格](scripts/qualify-native-mcp-browser.ts)用独立临时Profile、自有HTTPS AS/MCP和构建前固定的公开证书，保持实际默认Chrome、默认OS backend与普通Ask。准备页到达后才启动原120秒OAuth callback期限；若出现浏览器证书提示，由用户处理，脚本不绕过提示或修改系统信任。这个显式人工入口不放入自动默认调度。

2026-10-07 在 macOS26.7.1 arm64、Chrome154.0.8037.98 上，原入口 actual0/58.396秒，最终 `qualification.json` 为 passed：真实document/navigation三次、PKCE/code exchange两次、refresh一次、remote revoke一次；Clear只删本地材料，取消原Login没有交换code。三次独立Service启动核默认Vault持久复用、冷原GET零POST，以及清除后再次重开absence；准确测试材料fresh backend absence、三Service正常退出和所属进程无残留均成立。该候选网络固定为自有loopback与测试证书，`productionDefaultNetwork:false`，不证明外部AS或账号。原证据、制品摘要和4089regular/Git保持见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-chrome-与默认-vault-验收)。CUA仍未暴露Chrome控制，实际导航由正式默认opener发起并由原wire验证；没有用fetch callback替代浏览器，也未读取其他浏览器页面。


### 内部模型调用与子 Agent

自动审核 `authorization.check` 和标题生成 `session.title` 由 Agent 保存同会话内部 Model Execution，不创建子会话或子任务，后台目录自然不把它们投影为 child；没有为此增加 UI 隐藏规则。Native 继续共用主／子 Agent 的消息渲染，权限状态从 `execution.authorization.check` 读取，旧 `review` 观察仅兼容历史。实际检查与命名输入输出通过准确 Model Inspector 读取，不塞入父／子聊天。

2026-10-22 在 macOS 的源码外固定 Provider 候选 `6769bc903db51b96330acd05663123d3b80cee2aa4f9a3f0e03f6393394e5113` 上，[通用协作窗口](test/isolated/native-collaboration-bundle.test.ts)通过 1 例／35 断言，[自动审核窗口](test/isolated/native-auto-approval-bundle.test.ts)通过 1 例／95 断言。协作过程中的两次真实检查与标题请求未增加两个普通 child；冷 SQLite 共 3 个 Session，4 次权限检查和 1 次标题 Model 均无 Run、无 child 身份。原人工卡、同 Session 接续、旧答案隔离、准确停止和重开零重放均保留。协作的 46 帧过程、原回执及冷事实保存在 `dist/acceptance/child-internal-model-boundary-defdc067-44d2-4b3f-bcfd-79b17d458cd2`；审核证据在 `dist/acceptance/automatic-check-5b15266a-d57d-4393-8992-8287027a0ba8`。本机受控 Provider 结果不代表真实外部模型、其他平台或完整发布资格。
