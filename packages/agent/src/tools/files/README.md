# Workspace 文件 leaf

## 图片读取

持久理由见[严格本地图片读取决定](../../../../../.agents/notes/implemented/architecture/2026-11-04-strict-local-image-reading.md)。

`builtin.files/files.view_images@1` 的模型入口为 `view_images({paths:[...]})`，一次1至10张，兼容单图 `view_images({path})`；两种参数互斥，重复路径、空列表和11张在任何源文件读取前拒绝。工具模型名、内部标识和公开工厂统一为`view_images`、`files.view_images@1`和`createViewImagesTool`；按用户要求不保留旧名称别名或数据迁移，版本保持1。默认 CLI/TUI/Native 装配，复用普通只读授权和实际工作区身份；Web 仍只读。工作区相对／内部绝对路径沿原生 no-follow Files 引擎；普通外部绝对路径同时核词法和实际受保护根，允许普通硬链接，不发现外部项目指令。私有上传原件必须来自当前选择的输入或准确 Fork 来源，核 Store/Session/subject、完整 hash/size 和派发 revision；知道 Blob 路径不授予读取权。工具不返回编辑 baseline，不形成文件恢复点。

[工具](../images/tool.ts)仅接受路径，拒绝 URL；[读取适配器](../images/reader.ts)在取得图片处理名额后才读取字节，排队可取消，不预读下一张源文件正文；批次里已完成的PNG仍可保留在16MiB预算内。原生 `readBytes` 支持可信 signal、64KiB 分片和事件循环让出，仍核完整 EOF、摘要和前后文件身份。普通图片读取使用 sharedRead 保留普通硬链接语义，私有原件仍核本人、单硬链与严格路径；不改变恢复／CAS 的默认严格读取。

批次先校验全部路径分类和输入原件登记，派发revision绑定完整有序列表，不能用单图批准替代混合批次；逐张读取前再核该目标身份，原生读取仍独立拒绝不安全工作区路径。按序串行处理，每次只持一张原始输入，保留待发布PNG累计最多16MiB；跨过总量时明确`image_batch_too_large`，不追加降质或静默删图。全部解码成功后才逐项发布，键为`image-1`至`image-10`，单图保原`image`键及结果结构，多图metadata使用同序`images`数组。读取／解码失败或取消不交付部分视觉结果；发布故障继续交原Artifact owner，已发布引用不冒充成功批次，也不盲目删除。单张30秒处理预算保持，整批耗时随张数累加，不宣称整批30秒。

[处理进程](../images/child.ts)使用固定 `sharp@0.35.5`，关闭 libvips 缓存、并发为1。只支持 PNG/JPEG/WebP/GIF；完整容器、PNG CRC 与 native `failOn:warning` 都通过后才发布。源文件最多16MiB、3200万像素、单边16384；应用 EXIF、动画仅首帧，不放大，最长边2048；输出保透明 PNG、最多8MiB，超量时按实际大小确定性缩小并只重试一次。结果说明原格式、原／实际尺寸、方向、首帧及缩放。SVG、损坏或截断图片失败；不把 native 填充的缺失像素当完整图片。

[监督器](../images/processor.ts)启动固定校验摘要的程序，stdin 只传字节，不传路径、URL、Provider 配置或凭据。入口显式选择系统空设备作为 Bun config 和 tsconfig，禁用自动 env／安装；[Bun 的目录 preload](https://bun.sh/docs/runtime/bunfig)不能在已核程序前执行或改写 Sharp 解析。单宿主只允许一个处理进程，30秒取消预算；Windows 使用原 Job owner，512MiB Job 内存和单进程限制，核原 HANDLE wait 与 Job tree 停止后才释放名额。退出／关闭无法确认时保 owner、返回 unknown 并停止新的图片处理；停止证明失败独立于 stdout／exit Promise 结算，不无限等待已经缺失的证明。普通失败确认退出后允许下一次读取。POSIX 使用固定单程序、原 ChildProcess 与管道 close 收口，没有本次实测或硬内存资格。合作取消不对单次慢磁盘调用承诺实时上限。

成功结果发布当前 Execution 的 PNG `artifactRefs/modelImages`，沿[完整模型正文链](../../model-body/README.md)进入下一次模型请求，保原 Tool 来源、调用顺序和完整 Artifact 校验；历史／冷重开／Fork 不重读源路径。所选历史中的新工具图片累计超过32MiB时，在展开越界图片前明确 `image_context_too_large`，不静默丢图；用户图片、PDF 和浏览器原预算保持。AI 两协议编码和版本保持，真实视觉能力由 Provider 决定。

Core只为准确`files.view_images@1`接纳最多10张、每张8MiB、整批16MiB；其他工具的4张／16MiB合同保持。Native同样按原Execution读取1至10张，并保持每张尺寸和总量校验，不依赖renderer上报计数。

### 本地保存与缓存目录

`profilePath = <dataRoot>/<profile>`，沿现有 Profile 选择器取得，不从工作区或模型参数推导。

| 内容 | 保存位置／生命周期 |
| --- | --- |
| 上传图片／文件原件 | `<profilePath>/blobs/<SHA256前两位>/<完整SHA256>`，不可变 Session 引用；输入文件 URI 指向已登记原件 |
| 工具实际交给模型的 PNG | 同一 Blob 目录，另建准确 Execution 引用；相同字节物理去重，引用和授权仍独立 |
| 工作区／外部原文件 | 保留原位置；每次调用重新核权限及全字节，没有另存原件或解码磁盘缓存 |
| Native 派生缩略图 | 复用窗口内512px WebP预览缓存，最多128项／32MiB估算成本，隐藏／切换释放读取租约及显示 URL |
| 既有 PDF 解析缓存 | `<profilePath>/cache/documents/...`，仍按原配方和权限核验；图片工具不混用 |

原件和实际视觉结果属于持久历史，不能按普通缓存 TTL 删除。清理由[维护 owner 的显式无引用附件 GC](../../maintenance/README.md#显式无引用附件-gc)处理，默认无引用宽限7天，备份／恢复继续使用原 Blob 与出处合同。没有新增 `cache/images` 副本或静默淘汰仍被引用的结果。解码进程结束释放 native 缓存；进程内临时字节不承担历史保存。

Blob 去重不等于所有模型请求零复制：现有完整 ModelInput 封存仍将该次图片 Base64 保存到准确请求的 JSON／Artifact 中，历史图片参与后继请求时会增加正文与磁盘成本；32MiB展开预算也不承诺整个会话的存储上限。

### 当前验证与性能

2026-11-04，Windows x64／Bun1.4.3，当前实现的[严格解码回归](../../../test/isolated/files/images.test.ts)覆盖真实像素、透明、EXIF、动画首帧、截断与伪装、尺寸和字节预算、排队／在途取消、超时、原生崩溃、输出超量、Job 内存耗尽及随后正常读取。[源码树外闭包](../../../test/isolated/files/images-packaged.test.ts)物理复制 Sharp 和 native 依赖，空 PATH/NODE_PATH、禁止自动安装，核资产删除／摘要篡改及每次恢复；正式 Agent build 已产出 child、摘要与原生文件资产。

[默认 Service 联验](../../../../../apps/service/test/isolated/image-reading.test.ts)通过真实 SQLite/Artifact、两个不同像素调用的结果／来源配对、外部文件／有效原件、跨会话拒绝、冷重开和 Fork，并将实际请求交给两种 SDK 编码。[累计预算回归](../../../test/isolated/artifacts/tool-image-budget.test.ts)核最后越界图片未读正文、零后继模型请求。原 PDF、外部读取、异步完整读取、Windows Job 和 Artifact 原门禁继续通过。

源码树外的合成 `bunfig` preload／`tsconfig`别名先实际复现 `image_process_failed`，封闭配置后解码与资产恢复通过。[退出未知回归](../../../test/isolated/files/image-process-unknown.test.ts)先复现等待旧 exit Promise 挂起，修后在原真实合成进程已物理清理、但 adapter 证明被保留的故障下，原调用和排队调用均结算 `image_process_exit_unconfirmed`，后续不再读取字节或启动进程。该用例不把模拟证明缺失当真实OS无法停止资格。

[性能 runner](../../../../../tests/e2e/live/model/image-reading.benchmark.ts)使用默认 Service、实际 Artifact 和固定模型，每次新建会话，零 Provider。最终54次全部成功；整链路包含下一次模型输入的封存与完整校验，单工具包含读取、独立解码和 PNG 发布。每种大图6次，另连续界面图30次；有限样本 P95 不代表长期服务分位数。

| 合成输入 | 工具 P50 | 整链路 P50 / P95 |
| --- | --- | --- |
| 1920×1080 界面 PNG | 319ms | 1003 / 1906ms |
| 12MP 噪声 JPEG | 2483ms | 4663 / 5033ms |
| 32MP 平坦 PNG | 578ms | 1184 / 1207ms |
| 2048² 透明噪声 WebP | 2345ms | 3917 / 4199ms |
| 界面 PNG 连续30次 | 281ms | 879 / 937ms |

主 Service/benchmark 进程 RSS 峰值528MiB，连续30次界面图阶段从408回落至268MiB；解码子进程不在该数值中，Windows Job 另限制512MiB，不承诺整机或主进程硬内存上限。最大10ms采样间隔470ms：已修复大块发布的连续同步写入与重复 Blob 采用回读，仍有同步元数据／JSON及系统调用开销。此前同 JPEG 独立批次最大间隔904ms，修复后473ms；这是响应性证据，不是严格单变量吞吐比较。完整数据保留于本机 `.cache/image-read-implementation-20261104/benchmark-final-04.json` 和原失败／中间批次；不据有限回落证明长期无泄漏。

封闭配置和退出未知收口后，正式Agent再次构建通过；最终界面图独立6次复测全部成功，工具P50为234ms，整链路P50／P95为727／1068ms，主进程峰值257MiB、最大采样间隔176ms，报告为`.cache/image-read-implementation-20261104/benchmark-ui-final-05.json`。其余54次数据按未改变的解码、发布和封存路径复用；独立小批次不作为与前表的严格性能对照。

同日10图增量：严格回归覆盖一次10张顺序、11张／空列表／混用／重复的零源读取拒绝、中途损坏／取消零交图、真实高熵PNG跨16MiB整批拒绝，以及单图授权不能替代混合原件批次。默认Service实际将10张放入同一Tool消息，经两种SDK编码核完整有序图像、11张拒绝、冷重开与Fork；原PDF和32MiB历史门禁复验通过。Native按原执行引用核第10张、拒绝第11张及错误scope／名称数目／单张和总字节，实际页面核10张折叠／重开／切会话，过程证据归[Desktop owner](../../../../../apps/desktop/README.md)。

当前批次[性能runner](../../../../../tests/e2e/live/model/image-reading.benchmark.ts)的`--case=ui-batch10`为6次调用、共60张1920×1080合成界面图，每次10个不同路径而字节相同，实际解码／完整读取均执行，Blob内容去重。6次全部成功，整批PNG约1.04MiB，整链路P50／P95为2943／3501ms，主进程峰值303MiB、最大采样间隔144ms，报告为`.cache/image-read-implementation-20261104/benchmark-batch10-01.json`。这是有限的固定模型和可去重样本，不证明10张高熵大图、长期SLO或总内存硬限额；前表保留原单图范围。

同日更名前的[真实视觉 runner](../../../../../tests/e2e/live/model/image-vision.live.ts)经默认装配和现有 `deepseek-v4-flash`／Chat Completions，两次HTTP200、一次成功的本地图片工具调用，准确识别随机六字符与红7／蓝3柱图；源路径已删除。没有 OCR、替换模型回复或协议回退。报告为本机 `.cache/image-read-implementation-20261104/vision-01.json`。这不保证任意图片识别率、其他平台、完整 Native 窗口或安装发行资格。

2026-11-04更名后再次实际调用同一已配置模型：单图和`--images=10`两次独立联验均通过，各为2次HTTP200、一次成功`view_images`，共4次实际HTTP。10图样本使用不同随机六字符及柱图数值，真实模型一次以有序`paths`读取全部已保存原件，后继请求图像数为10，最终JSON的10个代码与20个数值逐图完全匹配，数组顺序保持。两次都先删除工作区源文件，没有OCR、回复替换、模型／协议回退或外围重试。报告分别为本机`.cache/image-read-implementation-20261104/vision-view-images-single-01.json`和`vision-view-images-batch10-01.json`；新的批次报告只保存逐图布尔判定及有限元数据，原请求／回答按原Runtime保存在隔离Profile中。此为单一模型的两份合成样本，不推广为任意图片、其他模型或平台的识别率保证。

默认 Service 已接入准确会话文件适配器；持久取舍见[会话文件决定](../../../../../.agents/notes/implemented/architecture/2026-10-23-persistent-session-files.md)，客户端和发行资格分别见 [Desktop](../../../../../apps/desktop/README.md)与 [Terminal](../../../../../apps/cli/docs/terminal-release.md)。默认宿主的 `files.read@5` 组合以下能力，`files.write@3` 新建时补齐工作区父目录，edit 保持版本 2。

## 新建文件的父目录与失败反馈

`createWorkspaceFiles.write` 只在 `base:null` 时通过原 `withParent` 逐段打开父链，准确 `ENOENT` 后才调用 native `create-directory`。新目录继续绑定原父句柄；POSIX 使用 cap-std 单组件创建、0700 和 no-follow 重开，Windows 使用原父 HANDLE 的 create-only `NtCreateFile`、本人私有 DACL 及原身份核对。`EEXIST` 只允许在同一父对象上 no-follow 重开一次；文件、链接、别名、受保护路径及 owner 检查不会因已审批而放宽。原生 ABI 升为 `kite-files:2/cap-std:4.0.3`，需重建 companion 并重启已加载旧模块的宿主。

覆盖、edit、原字节 restore/remove 和绝对外部工具不补齐缺失父目录。创建后发生已知失败可以留下空目录；不自动删除或修改已有目录权限，不把目录纳入文件检查点恢复。句柄取得／关闭无法确认沿 `file_publish_outcome_unknown` 进入原 unknown 链路，禁止自动重放。检查点记录保留旧 `files.write@2`／`files.edit@2` 来源，并准确接受新增 `files.write@3`，不把旧审批变成新版本授权。

普通写入／编辑失败的 `content` 和 `details.next_action` 给出原因与下一步，`details.code/path` 保留准确码和原请求目标；`ENOENT` 不再被解释为空工作区不可用，`EACCES` 明示审批不覆盖系统权限。描述与失败结果都要求先纠正原因再尝试，未新增按重复次数拒绝调用的规则。安全取舍见[父目录创建决定](../../../../../.agents/notes/implemented/bug-fix/2026-10-25-safe-write-parent-directories.md)。

验证使用 [tool-paths](../../../test/isolated/files/tool-paths.test.ts)、[native-addon](../../../test/isolated/files/native-addon.test.ts)、[recovery-primitives](../../../test/isolated/files/recovery-primitives.test.ts)、[capture](../../../test/isolated/file-checkpoints/capture.test.ts) 与 crate 真实故障测试；结果范围为本机 Windows 和另行注明的目标编译，不推定完整客户端／安装或其他平台运行资格。

2026-10-25，Windows x64／Bun1.4.3／Rust1.97.1、`3dc3a941f` 加本任务未提交改动：tool-paths、native-addon、recovery-primitives、path-files、windows、change-preview、native-packaged 七个 Files 叶共36项通过，capture 整文件21项通过。最后一次 `bun test --timeout=30000` 对 capture＋tool-paths 为27项404断言通过，对 change-preview＋path-files＋Service runtime-assets 为20项322断言通过。前者核真实版本2来源仍可恢复、版本3嵌套创建、准确失败交给下一 Model、取消、并发改绑和 unknown；后者核外部范围、快照与保护边界。

此前默认 Service 的文件、检查点、权限与计划回归已通过（专用自动验证现已退役）；其中 planning 为16项272断言。crate 的 `cargo test --locked --lib -- --test-threads=1` 为5项通过，包含实际目录已创建但取得结果未知时保留原父链且不重试。Linux GNU／macOS ARM64 的 `cargo check --locked --target ...` 通过，只证明目标编译。根、Agent 和 Service typecheck，变更 TS 的 Biome、文档结构／影响、core boundary 和公开 API 检查均已核对。

同日后续已修复此前保留的三个回归失败：[automatic-validation](https://github.com/ferqx/kite-code/blob/0dc1e3b7b8a316dc9226cc4e841186cc6486d34e/packages/agent/test/isolated/business/automatic-validation.test.ts) 的 Rewind 按当前普通输入合同核原 `run.start` Command、Run 与 Model 消息来源，并保留文件基线不变、仅一次写入及旧验证历史不重放；[per-run-planning-configuration](../../../../../apps/service/test/isolated/per-run-planning-configuration.test.ts) 的新冷恢复配置先绑定真实 Runtime，再核配置漂移在凭据／Model 读取前拒绝且 Store 游标不变；[automatic-validation-nested-tools](https://github.com/ferqx/kite-code/blob/0dc1e3b7b8a316dc9226cc4e841186cc6486d34e/apps/service/test/isolated/automatic-validation-nested-tools.test.ts) 显式持有并在 Service 收束后关闭夹具自建的 WorkspaceFiles，关闭成功才清理目录，保留原超时与失败证据规则。`bun test --timeout=30000` 对这三个完整文件同次20项196断言通过。只修正测试断言与资源归属，生产输入、恢复授权和关闭实现未改；当前 Desktop 窗口的完整过程、正式制品重建安装和其他平台运行资格仍未验收。

## 会话文件与 PDF

普通 Workspace 与明确外部路径的文本写入／编辑通过原 [文件工具](../files-tools.ts)封存完整 postimage，结果 `details.fileOutput` 与 `artifactRefs` 绑定原 Execution。为避免靠文件名或模型自然语言猜测“交付”，每次具备 Artifact port 的成功文本变更均保留该快照；没有另建外部工作文件登记数据库。当前目标仍在原路径，原权限与 Workspace 检查点保持。快照发布失败返回 `outcome_unknown`，不重做实际已发生的写入。外部路径的未封存修改不进入 Profile 备份，恢复只保历史快照，绝不回写外部目标。此范围由 [完整快照与失败窗口回归](../../../test/isolated/files/change-preview.test.ts)验证。

[默认 Service 文件联验](../../../../../apps/service/test/isolated/planning-configuration.test.ts)另在会话输出物理写后分别注入 Artifact 登记失败与 saved record 写失败，真实两分支67断言通过：当前与原 operation 保留 pending，原 Execution 为 unknown，无成功交付卡；原 Command 重复提交与冷查询都不改文件、不增加模型或效果。现有 `session.recover interrupt` 仍报告该已尝试的未知副作用，不能据此解锁后继工作；未取得可靠结果证明时保留 `recovery_required`，不自动重放写入。这与正常已成功输出的后续编辑、备份恢复后新授权读写是不同边界。

2026-10-24，Windows x64／Bun1.4.3、主仓库 `60a2d984c` 加当前改动，`bun test packages/agent/test/isolated/files/pdf.test.ts packages/agent/test/isolated/files/pdf-packaged.test.ts` 整两叶9项61断言通过，覆盖中文本地 CMap、物理页／页标签、分页、旋转大页、无文本页、坏文件、缓存损坏／删除重建，以及真实 AES 加密文件的 `pdf_password_required`。取消例使用真实 Worker：两个在途请求占满并发，第三个排队取消不创建 Worker；取消一个在途请求不影响另一个，原 Worker 各调用一次 terminate，后续读取仍成功。这证明取消调度与调用范围，不代证操作系统线程已经物理退出。[源码外闭包](../../../test/isolated/files/pdf-packaged.test.ts)实际复制 parser、Canvas 和 native 依赖，在空 PATH／NODE_PATH、禁止自动安装的独立目录提取文本及渲染 PNG；完整候选的资源验收归 [Terminal owner](../../../../../apps/cli/docs/terminal-release.md)。其他平台与完整安装资格仍独立验证。

其中[固定两栏与表格样本](../../../../../tests/fixtures/pdf.ts)经公开 Files 适配器、真实原生读取及 PDF Worker，核列优先正文与表格逐行文字、完整模型正文和实际 PNG 的尺寸、表头与格线；另渲染并目视确认两栏及表格完整清晰。此例以准确范围／Artifact 发布测试端口隔离格式行为，既有真实 Store 绑定及后继 Model 交接仍由上文 Service 联验覆盖。结果继续明确 `text_extracted_reading_order_not_guaranteed`；固定样本通过不保证任意复杂多栏或表格的阅读顺序，页面图像保留文字提取不含的布局。

固定 2048×2048 噪声图像的一页 PNG 成功，两页实际输出超过 16 MiB 时明确 `pdf_result_too_large`，后续普通读取仍成功；这验证单批结果预算，不是机器 OOM 资格。源码外私有物理副本分别移除准确 Worker／校验文件、写入错误校验摘要，真实子进程核 `ENOENT`／`pdf_assets_invalid`，每次恢复原字节后同进程重新读取成功；未修改源依赖或增加网络回退。损坏的嵌入 TrueType 字体在 text／image 均返回 `pdf_font_invalid`，后续正常读取成功；修复前真实 parser 曾仅警告并生成替代字体页图，不能将该旧成功计为准确结果。

同日 [真实视觉 runner](../../../../../tests/e2e/live/model/pdf-vision.live.ts)经默认 Service Files 装配、Runtime／SQLite／Artifact 和实际 SDK，上传只有栅格图片的合成 PDF，删除原路径后由模型调用 `read_file` 获取页图。已配置 `deepseek-v4-flash`／Chat Completions 在两次 HTTP 200、一次成功页图读取后，准确返回随机六字母及红7／蓝3柱图。此前含易混淆字符的样本把 B 识别成 8，柱图仍正确；该失败保留，成功样本不能证明任意扫描件的识别准确率。测试没有本地 OCR、模型回答替换或协议回退，预算与复现命令见 [live 测试说明](../../../../../tests/e2e/live/model/README.md#pdf-扫描页与图表)。

不支持视觉的端点明确失败、不改为纯文本或切换协议；两协议受控 HTTP 400 的准确请求与错误证据归 [AI 图片消息](../../../../ai/README.md#图片消息)。

[输入文件](../input-files.ts)只接受所选消息有效原件的准确绝对路径，核完整 hash／size、引用与派发快照；私有目录的其他路径仍拒绝。上传原件只读。普通文件继续沿严格 UTF-8、完整 baseline 和范围读取。`read_file` 的 `pages` 与 `mode=text|image` 只适用于保存的 PDF 附件，默认第 1 页；每次最多 20 页文字或 4 张页图，返回物理页码、标签、总页数和 nextPage。工作区文件和非 PDF 附件按 `start_line/max_lines` 读取，省略上述两个 PDF 参数；PDF 附件省略行范围。不匹配的参数组合仍失败，结果保留 `details.code` 并给出明确的省略／重选参数方法，取消不提供重试指示。公开说明与各字段描述保持一致，实际 schema 的可选语义由 [AI Responses adapter](../../../../ai/README.md)保留。页图每边最多 2048 像素，单批结果最多 16 MiB，源文件最多 256 MiB，不进行 OCR。

[PDF Worker](../documents/pdf-worker.ts)使用固定 PDF.js 6.4.299、本地字体／CMap／WASM 与 Canvas；禁用文档网络、XFA 和系统字体回退。解析在独立可取消 Worker 执行，同时最多两次，单次 60 秒；Worker 不是 OS 沙箱，仍需安装制品及平台资源资格。原提取顺序不保证复杂多栏／表格语义。缓存键含完整源 hash、Store、配方、页范围、模式和 Worker 摘要，命中前仍核原件权限和全字节。缓存不进入历史：实际交给模型的正文及页图分别保存为准确 Tool Execution 的 Artifact。中立 `tool` 消息保存视觉结果来源；Responses 使用原工具结果的图像部分，Chat Completions 保留原工具配对并追加明确标记为工具数据的视觉载体，不产生人类输入或批准。

该固定 parser 会把部分字体错误降为警告；Worker 只识别已核对的字体诊断前缀并返回 `pdf_font_invalid`，其他格式错误警告返回 `pdf_processing_failed`，不发布降级的文本或页图，也不传播命中的原始诊断。记录只存在于单次解析 Worker，结束恢复原警告处理；版本变化必须重新核对。未嵌入字体的 `missingFile` 也可能合法，不能据此拒绝无故障的 CMap 文本读取。此处理拒绝已识别的解析失败，不修复字体，也不承诺任意字体或排版都可读取。

[输出文件](../session-outputs.ts)复用 `builtin.files` typed records、原生 Files CAS 和 Artifact。当前文件存于 `<profile>/files/<SHA256 Store>/<SHA256 Session>/outputs/`，首版文件名为 1–120 位 ASCII 字母数字、点、下划线或连字符并以字母数字开头；原生层继续拒绝设备名、别名与链接。`base=null` 只创建，不因同名覆盖。发布前写 pending 意图；字节、不可变交付快照及登记均完成才成功，后半段失败保持 unknown。工作区源码与检查点沿原链路，会话文件不进入工作区恢复点。

Fork 从所选执行的不可变交付建立只读来源锚点，首次读取生成独立真实副本；分支编辑另建当前记录，保留继承锚点供再次 Fork。来源文件的后续外部修改不进入旧交付。文件清单上下文至多展示 200 项且标明是否完整，准确路径查找没有累计文件数量上限。`files.outputs`／`files.output-source` 是宿主登记查询，不新增模型缓存工具。

Canvas 固定为必需依赖 `@napi-rs/canvas@1.0.10`，Agent 构建纳入 PDF Worker、校验摘要和本地资源；宿主保护范围包含实际 parser／Canvas 与平台 native 依赖根。缓存内容按字节基线读取，坏 JSON／非法 UTF-8／无效页范围或图像可在原权限核验后重新解析，发布沿相同基线 CAS；链接和不可核实 IO 不降格为普通缓存 miss。超过本地缓存字节预算仍明确失败，不承诺任意大小损坏缓存能自动修复。Worker 取消和60秒超时不等同于 OS 硬内存限制，Win/Linux 原线程退出资格仍沿现有 owner 保留 unknown。

Windows 本机联验已覆盖附件→PDF→Artifact→后继模型 wire、输出编辑、历史快照、Fork 独立副本及备份恢复；两协议 wire 不等于真实视觉模型识别资格。测试入口为 [Service 文件／Plan 联验](../../../../../apps/service/test/isolated/planning-configuration.test.ts)、[真实 PDF Worker](../../../test/isolated/files/pdf.test.ts)与 [AI 图片协议](../../../../ai/test/input-images.test.ts)。

模型接口由可信 `ToolDefinition.model` 投影：`read_file/write_file/edit_file`；外部普通文件也由 `read_file` 读取，外部修改由 Shell 处理。读取使用 `start_line/max_lines`，编辑使用 `old_text/new_text/expected_matches` 及对应 Artifact 字段，其余声明属性使用 snake_case；任意正文和 Artifact 身份保持原值。内部 `files.*` ID、定义版本、完整 baseline、权限与检查点合同保持原样。目录、文件查找和正文搜索使用 Shell 与内置 rg。

公开入口 `@kite-ai/agent/files` 的 import 不打开资源。宿主显式调用 `createWorkspaceFiles({root,maxFileBytes?})` 选定一个物理 Workspace 根，再用 `createFileTools(files)` 将六个普通 ToolDefinition 装配进扩展；工具仍走 UnifiedExecution 的权限、来源复查、计划、派发和终态。没有 CodingAgent、Git 或旧 filesystem authority 依赖。

只读 `read` 的可信 options 可携带 `signal`；普通 `read_file` 和绝对 `read_user_file` 从实际 ToolContext 传入，不新增模型字段。完整文件读取仍以 64 KiB 块核 hash、UTF-8 解码及前后身份，在 8ms 或 64 块预算后通过真实 event loop 让出；行选区在块内统计完整 totalLines，只保留请求正文，不建立全文行起点数组。BOM、CRLF、跨块 UTF-8 和完整 baseline 不变，行窗口不构成字节截断。search 的单文件读取复用该异步读取，逐行匹配另按预算让出；底层未指定 limit 时保留全部命中和完整长行，模型默认改为有界预览，见下节。

异步读取保留原目录及文件 FD，恢复时核原根和取消，EOF 后再次核完整文件身份；漂移不发布旧结果。`close()` 先拒绝新读取并让在途只读退出、关闭各自 FD 后再关闭 native owner，多次 close 共用同一结果。取消和异常不关闭别的读取句柄。写入/edit 的共享读取按同步方式消费同一分块校验，不在原最后 CAS 与发布之间插入让出；字节恢复和发布后 unknown 合同不变。合作让出不能给单次慢磁盘 native read/fsync 承诺耗时上限，也不为完整正文增加文件额度。

模型 `list_directory/glob_files/search_content` 已退役；客户端候选及独立内部调用仍可使用低层 `WorkspaceFiles.list/glob/search`。低层省略 `respectIgnore` 保留不使用普通 ignore 的原行为；指定 true 时，在进入忽略目录前剪枝，并继承工作区内祖先规则。规则文件沿原生 no-follow、完整读取与取消边界。搜索游标包含 ignore 语义版本，旧游标不能混入新结果域。

## 内部内容搜索与历史结果

2026-10-25，Windows x64／Bun1.4.3，`aefb47472` 加本次查询 diff：同一仓库、同一原生后端的只读前后对照中，`packages/agent/**/README.md` 查找由2762ms降至289ms（均41项），`packages` 中的 `autoReview` 内容搜索由20017ms降至4809ms（均返回30条，实际检查文件由2348降至1172）；根 `AGENTS.md` 查找为1192ms，仅返回3个未忽略路径。忽略域变化意味着不承诺两种模式返回相同产物命中，`respect_ignore:false` 可明确读取原普通范围。入口与结果保留于本机 `.cache/file-query-performance.ts`／`.cache/file-query-performance.json`；这是当前本机文件查询对照，不代表所有工作区、完整客户端切换延迟或内存峰值。Files五份完整回归50项744断言通过，覆盖原生六工具、父规则继承／否定、分页、宏任务取消、目录联接拒绝与关闭边界；Windows 的链接夹具使用真实目录 junction，POSIX 保原 symlink。

模型历史中的工作区 `read@4/search@5`（结果呈现版本分别为 1 和 2）由[纯结果呈现](model-result.ts)去除重复 JSON、observation 和常规说明，原持久回执保持不变。读取按路径、实际起始行／选区／总行数、`next_line`、完整 baseline 后接所选原文；`next_line` 非空时原样传给下一次 `start_line`，原 JSON 回退则使用 `selection.nextOffset`。空窗口也保留起始行，不把中途读到 EOF 称为全文。搜索只呈现一份字面查询、范围／过滤／预览限制、本页返回数、准确 `next_cursor`、未检查计数及样例，再按文件呈现完整 baseline；文件定位模式仅列首命中行号，内容模式保留全部返回匹配和上下文；前瞻匹配数不冒充总命中数。分页末页和零命中均不证明全局无引用。大 Artifact 完整核实后使用完整正文，不以有界 excerpt 替代；未知结构和新增不认识的限制保留原呈现。统一外部只读沿同一呈现路径，不返回编辑基线。确定性[呈现回归](../../../test/isolated/files/model-result.test.ts)覆盖真实编辑基线、窗口、分页、跳过、Unicode、原正文与 Artifact 保真。

内部 `WorkspaceFiles.search` 的 `path` 可选择普通文件或目录，省略、空字符串和 `.` 选择工作区根。它按字面文本匹配；文件名查找使用内部 `glob`。`mode:files` 每文件只返回一次路径、完整 baseline 与首命中行，`mode:content` 返回命中行及上下文。省略 mode 保持 `content`；`limit/maxLineChars` 可省略以保留全部命中及完整长行。这些内部参数和游标不是已退役模型工具的继续入口。

`glob` 筛选文件名，包含 `/` 时匹配相对所选目录的路径；`**/` 含零层目录。显式单文件以文件名匹配。`context_lines` 为 0–10，返回具名 `before/after` 行及真实行号，上下文同样遵循明确预览限制。遍历按完整相对路径排序，目录以 `name/` 与文件共同排序；只有前瞻到下一项才产生 `next`，模型呈现为 `next_cursor` 并原样传给 `cursor`（原 JSON 回退是 `next` → 内部 `after`）。游标包含格式版本、查询／模式／范围／glob／ignore 的摘要及最后返回位置；不接受不同命中域的游标，改条件时重新开始。limit 及片段预览参数可以变化。文件模式按完整文件路径续页，内容模式按路径／行号续页，不重复返回同一文件定位项。`stats.matchedFiles` 和内容模式 `stats.matches` 只记录本页实际遇到的命中文件／匹配（可含一个前瞻），不是整个搜索总数。后页须使用相同范围、文本和过滤条件；它不是跨外部文件变化的快照。

内部调用显式 `respectIgnore:true` 时使用忽略规则。目录规则复用固定 `ignore` matcher，读取工作区根到搜索范围及范围内各级 `.gitignore`，逐级使用本级相对路径，包含注释、目录、否定及父目录排除规则；所有规则文件均经原 native 安全读取，链接规则文件不读取。显式非根目录继承工作区内祖先规则，被排除的父目录不会因更深的否定规则重新打开；显式单文件绕过普通 ignore；`respectIgnore:false` 包含普通忽略项。底层未指定该参数时保留原不使用普通 ignore 的行为。过滤不修改授权，protected／no-follow／根和文件身份检查始终有效。

二进制与非 UTF-8 内容分别计为 `binary/encoding` 并跳过，不再使其他文本结果丢失。普通忽略项和不跟随的链接／特殊对象也分别计为 `ignored/links`；目录忽略计一项，不宣称知道其后代文件数。有过滤、分页或跳过时，`scope.kind=current_page` 描述本次页实际遍历，返回计数与最多 20 个路径／原因样例。`scope.complete:false` 表示有未检查项或尚有结果后页，文件模式空 files 或内容模式空 matches 均不能解读为全工作区无匹配；后页诊断不累计此前页，也不宣称完整扫描未到达目录。过滤 glob 的范围由 `scope.filters` 明示。权限、根漂移、读取身份变化和其他 I/O 失败不当作二进制吞掉；失败仍沿当前 Tool 返回，常见路径／参数错误提供 `code` 和纠正信息，不获得重试或访问授权。

[搜索回归](../../../test/isolated/files/search.test.ts)覆盖单文件与目录、混合编码、稳定分页、上下文与代理对预览、根／嵌套 ignore 和显式范围优先级、实际工具默认、路径错误、protected 与链接及有界诊断。[读取响应性](../../../test/isolated/files/read-responsiveness.test.ts)和[查询响应性](../../../test/isolated/files/query-responsiveness.test.ts)继续核真实 macrotask 取消、独立读取、close drain、EOF 后匹配及最终枚举边界；平台资格仍按实际执行环境说明。

## Node-API 文件后端

文件工具的手写 Bun FFI 已由 [cap-std＋napi-rs 模块](../../../native/files/README.md)替换，[唯一加载器](../../files-native-binding.ts)保持原 `WorkspaceFileIo` 交接，TS 继续拥有完整字节／UTF-8、baseline、CAS、查询与 checkpoint 语义。Windows 由官方生成的 windows-sys 绑定补齐完整 FileID、原 HANDLE 路径与发布、私有创建和关闭未知；仅套用 cap-std 的 metadata／rename 不能满足这些边界。原 `files-native.ts/files-windows.ts` 已删除，没有旧后端回退；Profile／SQLite／Shell 等独立原生 owner 不随此迁移。

Agent build 将固定 CPU／平台的 `native/files/files.node`、ABI／来源／完整 hash manifest、Cargo.lock 和第三方许可证一同交付；加载前核无符号链接／单链接、平台、CPU、ABI 和完整字节哈希。缺少或改变资产明确失败，运行期不编译、不查找源码／环境变量替代。可信 `filesNativeAssets()` 让正式 Service 把加载器和整个 native companion 加入普通／外部文件及检查点保护，Full 也不开放。Windows 静态 CRT 的实际依赖仅为系统 DLL。源码开发要求固定 Rust 工具链及平台 linker，用户运行制品不需要 Rust。

Windows DLL 固定 `/DEPENDENTLOADFLAG:0x800`，将静态依赖解析限定 System32；搬迁测试核实际 PE 的准确平台、无 delay import 与加载标志，再实际加载，不把系统 DLL 名单当作搜索路径证明。链接标志适用系统及准确 API 合同归上述 native owner，不据此扩展产品支持系统集合。

2026-10-16，基于 `70cb5718` 的本任务未提交 diff，先在 `codex/native-files` 隔离验证，三方合回主工作区后复验。环境为实际 Windows x64／Bun1.4.2／Node24.15.0／Rust1.97.1 MSVC；下方43／63项等旧执行记录对应替换前后端，不能用于授予新后端资格。

- `bun test packages/agent/test/isolated/files/native-addon.test.ts packages/agent/test/isolated/files/windows.test.ts packages/agent/test/isolated/files/path-files.test.ts packages/agent/test/isolated/files/tool-paths.test.ts packages/agent/test/isolated/files/native-path-lifetime.test.ts packages/agent/test/isolated/files/native-packaged.test.ts packages/agent/test/isolated/files/built-large.test.ts apps/service/test/isolated/files-native-boundary.test.ts`：20项通过，覆盖真实原生读写／恢复、准确授权、GC、Bun／Node 空 PATH 搬迁加载、篡改拒绝、完整 Agent 包和默认 Service 的 Full 保护拒绝。新增链接数断言及 Service 类型修正另与完整 CI 合同整文件复验，共23项361断言通过。
- `bun test --timeout=30000 packages/agent/test/isolated/file-checkpoints/capture.test.ts`：19项267断言通过。首次与整包构建同时运行时三例达到默认5秒时限；未删断言，30秒单例时限的完整独立复验通过，平台 CI 使用同一时限。原恢复、新建反向删除、原 Run／Execution、取消、漂移和 unknown 均实际运行。
- `bun test --timeout=30000 packages/agent/test/isolated/files/recovery-primitives.test.ts packages/agent/test/isolated/storage/build.test.ts`：7项112断言通过。旧 Node fsync mock 迁到真实 Node-API 的 sync／close 交接点，实际 native IO 仍执行；独立字节包及 Store／Worker 包携带同次构建的 companion，Windows 在所属子进程退出后才清理已映射 DLL。POSIX 保文件／目录 symlink 和根替换断言；Windows 用真实 junction 与禁止根 rename 的原 HANDLE 合同，不要求改变机器的 symlink 特权。
- 在 [crate](../../../native/files/README.md)目录运行 `cargo fmt --check`、`cargo test --locked --lib`：4项真实 Windows 故障／8.3测试通过，包含取得后确认未知与关闭未知的原父链持有；`cargo check --locked --target x86_64-unknown-linux-gnu` 和 `--target aarch64-apple-darwin` 通过，只证明目标编译。Windows release 的 `dumpbin /dependents` 仅列系统 DLL，无 Rust／MSVC 运行时分发依赖。

最终主工作区将上述八文件连同 `recovery-primitives.test.ts`、`storage/build.test.ts`、`large.test.ts`、`artifact-cancel.test.ts` 整文件以 `bun test --timeout=30000` 同次运行：30项497断言通过。检查点 capture、change-preview、两份 Native 工具展示整文件另同次36项412断言通过；原生4项及完整 CI 合同21项332断言也在主工作区复验通过。

依赖加载标志固定后的最终 DLL 再对 native-packaged、native-addon、built-large、recovery-primitives、storage/build 五文件以相同命令整文件运行：10项203断言通过；新增7条 PE 断言实际核 `0x800`，`dumpbin /LOADCONFIG`也确认同值。该变化只限制 DLL 导入解析，文件业务与 TS／Rust 资源状态实现未变，前述其余结果按该范围复用。

Agent／Service／Desktop typecheck、原包边界与 API／测试归属、文档链接和新增 CI 合同已核对。[平台 workflow](../../../../../.github/workflows/platform-capability-probe.yml)接入 native／工具／恢复实际用例，但未 dispatch，不能声称远端三平台已通过。完整安装、全部客户端和其他平台继续保原门禁。

此前正式 `buildTerminalBundle` 被 nvm Bun 的原 owner 和 Bun1.4.2 delay imports 阻断。2026-10-17 的 [Terminal 构建修复](../../../../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现)在新私有输入与新 console 副本中完成受限导入转换，保留最终无 delay／System32／ACL 门禁；完整 Windows Terminal 已实际构建并全量核验。候选自带 Bun 在空 PATH 下通过公开 Files 入口发布、完整读回和删除1,450,000字节，实际加载同包 Node-API companion。原 nvm 权限拒绝保持；完整 installed／Native／三平台及发布资格仍独立验收。

## 模型工具路径

六个 Workspace 模型工具接受相对路径及当前 Workspace 内的绝对路径。`WorkspaceFiles.relativePath` 只按工厂固定的根转换，`createFileTools` 在实际 IO 和检查点 capture 前调用它；Shell 改变 cwd 不改变文件工具基准。list／glob／search 省略 path、传空字符串或 `.` 均选择根目录；Windows 另接受普通盘符绝对路径和相对路径的原生反斜杠。目录穿越段在转换前拒绝，其他盘符、UNC／设备路径和 Workspace 外目标不能借转换取得访问。

原 `WorkspaceFiles` IO 和字节恢复原语仍只接收相对路径，原目录对象锚定、reparse／symlink／短名、受保护路径和 baseline 检查继续生效。文件结果、变更预览与检查点 capture 使用转换后的相对路径；原模型调用、审批与执行记录保留原始参数。工具 schema 明确路径范围，统一外部只读适配器另处理工作区外绝对路径，不扩大原 Workspace IO。设计理由见[路径分层决定](../../../../../.agents/notes/implemented/bug-fix/2026-10-16-workspace-tool-paths.md)。

[工具路径回归](../../../test/isolated/files/tool-paths.test.ts)实际调用全部六工具，核工作区绝对路径、目录默认、原生分隔符、准确 capture／结果及越界和保护拒绝；[真实 capture](../../../test/isolated/file-checkpoints/capture.test.ts)让同一路径的首个绝对调用和后续相对调用共用原 preimage／末 postimage。[Windows Core 用例](../../../test/isolated/files/windows.test.ts)经原 Runtime 实际列绝对工作区并读取绝对文件，将完整 Artifact 交给下一 Model。具体本机范围见下节。

## 统一读取工作区外文件

[external-file-reads](../external-file-reads.ts) 将工作区外绝对路径接入同一个 `read_file`；没有单独的外部读写工具。外部只读使用普通 OS 文件读取，检查规则覆盖请求路径和解析后的实际路径；权限决定仍由统一权限模块负责，工具不再次遍历授权证明。外部读取不计算完整基线，不检查 owner 或硬链接数，保留 UTF-8、分页、取消和大正文 Artifact 交付。Workspace IO、检索和 mutation 仍限原根，外部写入使用 Shell；外部路径不加载项目指令。

保存的 input/plan/output 适配器位于外部读取层之上，仍只接受原准确私有引用。外部读取绕过 Workspace checkpoint capture，并保留 `fileScope:external_path/workspaceCheckpoint:false`；检查点恢复不会触及外部文件。Workspace 的原生平台、ACL、取消和完整数据校验合同保持；外部读取使用宿主 OS 权限，路径规则不承诺识别同一文件的所有硬链接别名。

[外部读取回归](../../../test/isolated/files/external-file-reads.test.ts)核同一定义、分页／BOM／CRLF、无外部基线、硬链接正常读取、私有路径及链接实际目标、完整大正文和取消；[真实 Service](../../../../../apps/service/test/isolated/configuration.test.ts)核模型仅使用 `read_file` 读取外部正文且不读取外部项目说明。


## Windows Workspace 文件源码

[平台交接](../files-io.ts)让同一个 `WorkspaceFiles` 语义层使用 [Node-API 原资源 owner](../../../native/files/README.md)。正式 Service／六工具、完整 Artifact／Model 正文和检查点 restore／remove 沿原公开入口使用该后端；不增加第二套工具、权限来源、恢复状态或旧 filesystem fallback。源码接入不等于原生、全部正式客户端或安装制品资格已通过。

Windows 工厂当前接受 x64 本地盘符下的 canonical Workspace，其他架构或路径范围不从源码接入推定可用。工厂固定当前 token SID 和 System DLL，只在实际创建能力时加载。它持有原根及祖先目录 HANDLE，以 `NtCreateFile` 的原父 HANDLE 逐段打开，不跟随 reparse；普通 Workspace 使用已有 DACL，不修 ACL。新 temporary 与 POSIX 的 0600 对应，使用当前 SID 私有权限。完整 baseline 使用实际 volume、128-bit FileID、完整 EOF／hash／size，并比较原 HANDLE 的 LastWriteTime 与 ChangeTime。字节恢复的严格身份检查要求父目录和文件的当前 SID owner、文件单链接；普通 Workspace 默认读取保宿主已有权限。

组件拒绝 ADS、DOS 设备名、尾点／空格及非规范路径。实际原 HANDLE 的 canonical 长名对照拒绝 8.3 别名；保护范围按实际组件与 Windows 大小写等价核对，普通合法大小写变体仍可读取同一对象。目录枚举使用原 HANDLE，保护范围与原分页、search、glob 语义共用。未知类型、对象漂移、关闭或内存释放未确认均保明确失败，不从数字 HANDLE 重建资源。

发布先完整写入和 flush 原 temporary，再核准确基线，从原 temporary HANDLE 向原父 HANDLE 相对 rename；create-only 不覆盖，replace 明确替换。删除由原对象 HANDLE 的 disposition、真实 close 及缺失确认组成。发布／删除后的确认或关闭失败保 `file_publish_outcome_unknown`；未知原资源强持整个 owner 及父链，`close` 不宣称释放成功。Windows 的 file flush 与目录身份复核不等于 POSIX directory fsync，也未证明断电持久性；该限制和平台验收保留，不能由异常注入或本机 POSIX 测试替代。API依据见 [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)和 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。

发布的相对 rename 使用 `NtSetInformationFile(FileRenameInformation=10)`，将准确原父 HANDLE 放入 `FILE_RENAME_INFORMATION.RootDirectory`，沿同步原 temporary HANDLE 核 native 返回与 `IO_STATUS_BLOCK`；不退回绝对名称 rename。[官方 ABI](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile)说明对应结构与信息类别。2026-10-16 的实际 Windows x64 用例复现原 Win32 wrapper 返回 errno87，改用 native 调用后原字节恢复及六工具路径用例可完成；正式 Service／全部客户端、安装和故障资格仍按原门禁保留。

同日本机 [capture 整文件](../../../test/isolated/file-checkpoints/capture.test.ts)19项267断言通过，首个绝对路径与后续相对路径保同一个准确文件及原检查点。冷回放夹具显式关闭自己创建的 serial-lock owner 后再删目录，修复原 Windows `EBUSY` 收尾失败；没有改变生产关闭顺序或把清理失败算作通过。

[Windows 完整能力用例](../../../test/isolated/files/windows.test.ts)在 actual win32 强制运行六工具、真实 Core 大正文、binary 恢复与 Windows 路径保护，不作 backend availability skip。2026-10-16 在 Windows x64／Bun1.4.2，基于 `84b17867` 的本轮未提交 diff，本次路径、变更预览、检查点与 Native 工具展示六文件43项535断言通过（正常用户权限，51.69秒，包含实际会话的重复反斜杠输入），包含原生六工具、字节恢复、绝对路径 Core／完整 Artifact 和真实组件 DOM。原用例的 CRLF 搜索断言改为保留实际 `\r`，大正文夹具明确超过1MiB后才断言 Artifact，未降低验证要求。该结果不证明正式安装、完整 Service／客户端或其他平台。共享默认装配及恢复后新 Store 的原验证范围由[当前进度](../../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-普通-files-与检查点恢复源码)记录。取舍与剩余原生验收见[原 HANDLE 提案](../../../../../.agents/notes/proposed/architecture/2026-10-10-windows-workspace-files-owned-handles.md)。

Model 可调用的 `files.read` 缺省 `limit=200`，将 `next_line` 传给 `start_line` 续读（原 JSON 回退为 `selection.nextOffset`）；显式 limit 保原请求。该默认页仅控制返回范围，不改变低层全文读取、完整文件验证或累计读取能力。

默认没有整文件、原文、搜索匹配数或长行总额度。读取使用固定 64 KiB 字节块，严格增量 UTF-8 解码、完整 hash 与前后 FD 事实校验；默认 read 返回全部剩余行。宿主显式 `maxFileBytes` 可声明该宿主的单文件能力约束，未设置时不回退为旧 8 MiB。真实内存、磁盘、IO 与字符串表示能力仍可能局部失败，不把它们假装 Provider 窗口。二进制控制字节采样检查和严格 UTF-8 保留，BOM/CRLF 不规范化；search 不将已识别二进制当文本。

search 未指定 limit 返回全部匹配；显式 limit<=200 给出完整 next keyset，path/line 稳定排序。glob 的 **/ 匹配零或多层目录，页 limit<=200，完整路径 keyset；去除旧目录数、访问项数门槛，遍历不跟随 symlink，不执行 shell/rg。glob 按目录名加 `/` 与文件名的完整路径顺序深度遍历，取得准确的 limit+1 个匹配后结束本页；仅完整的字面目录前缀可排除不可能匹配的分支。无斜杠的 basename 模式仍跨层匹配，未新增忽略目录、扫描上限或结果截断。list 仍使用明确名字分页；跨页外部变化不构成一致快照。未知目录项类型明确 file_directory_type_unavailable。

glob/search 的原生操作仍绑定原根及 FD 链；遍历每64项或累计8ms检查一次批次，让出真实事件循环，避免一个 child 的文件查询阻挡其他 Run、HTTP 和等待定时器。yield 前关闭本次目录／文件 handles，恢复后重新核根和关闭状态；可信宿主第二参数的 signal 来自原 ToolContext，取消不成为 Model 输入或额外权限。单次原生枚举和单文件读取仍是同步操作，该批次不是单次 IO 的硬时限。[响应与取消回归](../../../test/isolated/files/query-responsiveness.test.ts)用自有真实小树核宏任务期间独立读取、原 Tool 取消、完整路径分页、保护范围及符号链接；不调用 Provider。

普通 Tool 的小结果内联 JSON；大 read/search 等结果通过真实 `context.artifacts.publish` 保存完整不可变正文。read Artifact 是完整所选 UTF-8 正文，summary 保留完整文件 baseline/selection；search Artifact 是完整结果 JSON。结果包含准确 Artifact refs、`body.complete=true` 和 `inlineBody=false`，这表示完整正文已保存；通用 `modelContent` 另指向相同准确正文，Core 完整校验后将其送入实际下一 Model 请求。没有 Artifact 能力时明确 artifact_publication_unavailable，不把摘要冒充全文。read/write/edit/search/glob 的新定义版本保留行为差异；write 的 contentArtifact、edit 的 findArtifact/replaceArtifact 接受准确原 scope 的完整 UTF-8 Artifact，与对应 inline 参数互斥，不能凭 hash 或猜当前 scope 读取。

文件写入先校验原完整基线、再临时发布。发布后同步/读取失败返回 file_publish_outcome_unknown；Tool 保留 outcome_unknown，不把已发生替换假报为零效果失败。

`write/edit` 的 `file_baseline_conflict` 解释本次基线或仅创建前置条件被拒绝、本次没有发布，但不返回当前文件正文。基线描述完整文件的身份与版本；冲突不证明另一编辑修改了同一段文字，须按各次请求的修改和各自回执区分。此前读取只代表当时观察，不能从冲突推断文件仍保留旧值；其他已经成功的操作不会回滚。后续另获授权的新编辑先读取当前文件并使用新完整基线，错误说明本身不授权重读或重做。外部只读没有编辑基线；发布后确认失败仍保留原 unknown。

## 逐操作文件变更预览

普通 UTF-8 write/edit 在最后一次基线验证保存实际完整 preimage，publish/fsync 后读取实际 postimage，并核其完整内容和发布 FD 的 dev/inode；确认漂移保留 `file_publish_outcome_unknown`。成功 [FileSnapshot](../files.ts)带 `change`，由迁入的原 [共同前后缀行差异](../files-diff.ts)生成行号与增删内容。新建或内容不变展示真实写入内容；不是 Git diff、LCS 或 Shell/外部编辑捕获。每次操作独立保存，不合并为累计贡献。

[Tool wrapper](../files-tools.ts)使用 write 版本3／edit 版本2及原 Model 的 `path/baseline` 字段，将可选中立 `FileChangePreview` 放入 `ToolResult.details.fileChange`：version1、format、path、before/after 完整 baseline、text 和 truncated。预览最多65536 UTF-8 bytes，截在完整字符边界；这个额度只限制展示 receipt，不限制文件 IO、完整 baseline、Model 读写正文或 Artifact。before/after capture 最后保存失败和派发后确认失败仍 unknown，不发布可用成功预览；read/search/glob、字节恢复及未装配该预览的工具不伪造记录。消费者须核原 succeeded Execution/Run/结果 revision，旧或未知格式明确不可读。

read/write/edit 的 Model JSON 结果另带当前真实 `executionId/runId`，供计划 receipt 等消费者定位准确保存记录；ID 本身不证明成功、授权、验证结果或 Workspace checkpoint。消费者仍须读取并核准确原定义、Run／Session／Store、终态和结果 revision，不能用同名 call 或最新执行替换。

没有新增 SQL 表、Store major、维护资产或 Model 工具权限。恢复检查点保首 preimage 与末 postimage，只服务准确恢复，不能冒充每次操作的差异。长期边界见[迁移决定](../../../../../.agents/notes/implemented/architecture/2026-10-08-native-file-change-receipts.md)。[真实预览与 Core receipt 测试](../../../test/isolated/files/change-preview.test.ts)核完整 BOM/CRLF pre/post、外部后改不改变历史、数 MiB 完整写入与 UTF-8 截断、失败/unknown 不保存成功预览，以及跨 Run 重复 call ID 的唯一原 source；各客户端实际资格由 owner 和进度维护。

路径和字节现在通过 Node-API 的有主数据进入 Rust，原生读取返回有主缓冲后复制到 TS 解码块；不再把临时 Buffer 的数字地址传给 Bun FFI。[路径寿命回归](../../../test/isolated/files/native-path-lifetime.test.ts)在实际 Node-API open/read/write/publish/unlink 前后强制 GC，验证完整字节、原 inode、创建与删除。捕获测试另核三条真实成功 Tool 回执与 first/last 的准确原 Execution ID，不把第二条单独成功误当成两次成功捕获。

文件系统不是 SQLite 事务：不合作的外部编辑器可能在最后一次基线核对与 rename 之间修改目标或移动目录，无法宣称任意外部 rename/编辑原子 CAS。当前机制绑定原目录对象，合作宿主可装配 Workspace serial 许可；不会创建另一个持久授权或文件状态机。

真实测试在 `test/isolated/files`：内容与 inode CAS、创建冲突、精确 edit、UTF-8/BOM/大小拒绝、symlink 越界拒绝、分页与搜索；固定模型经 Runtime/UnifiedExecution 实际写读，未知工具及权限拒绝零文件写。`test/isolated/storage/build.test.ts` 单独构建公开入口与 Worker/SQL，验证构建文件可执行。

当前叶子已去除旧正文额度并提供实际大正文 Artifact；Runtime 已通过[通用正文交接](../../model-body/README.md)在下一 Model 请求完整校验并展开准确 body，真实 Core 回归证明固定 Model 收到全文。便携 read/write/edit 仍以完整 JS 字符串表达正文，受真实平台表示/内存能力影响；Artifact stream 接口以固定块保存/读取，不设累计产物额度。正式默认装配和外部读取范围由上层 owner 负责。

[产品语义测试](../../../test/isolated/files/product.test.ts)验证行续读完整 hash、同 mtime 的未选中正文变化、glob 根/深层/分页/逃逸与真实 UnifiedExecution 拒绝零适配器 I/O。[完整独立制品测试](../../../../../tests/isolated/unified-agent/built-package.test.ts)同次构建所有 manifest 入口和资产后在源码树外实际执行文件行读取/glob，而非仅 import 成功。当前本地证据为 macOS；Linux/Windows 和安装制品资格分开验证。


[大正文回归](../../../test/isolated/files/large.test.ts)验证超过 8 MiB 的完整内容、完整 hash、原文级 edit、旧匹配/长行/文件数门槛解除，以及真实 UnifiedExecution 的 scoped Artifact 写入与全文产物、权限拒绝零 File IO。

[正文读取中的取消](../../../test/isolated/files/artifact-cancel.test.ts)验证真实 scoped Artifact 读取等待期间取消原 Command，返回后不发布文件。[大正文独立制品](../../../test/isolated/files/built-large.test.ts)在源树外同次构建全部 manifest 入口和 Worker/guardian 资产，实际运行 9 MiB 文件与超过 16 MiB 的 Artifact stream，不使用源码 fallback。


可信宿主另可调用 `readBytes(path,{maxBytes})`、`restore({path,bytes,base,maxBytes})` 和 `remove({path,base,maxBytes})`。每次必须声明正安全整数字节预算，实际读取和恢复同时受该预算及宿主已有 maxFileBytes 约束；不对普通 UTF-8 read/write/edit 增加默认总额度。FileByteSnapshot 保存完整 Uint8Array 与原完整 baseline，二进制、非法 UTF-8、BOM、CRLF 均按字节保留，不进行文字编码或 EOL 转换。restore 的 base=null 只准 create-only；remove 必须使用准确已观察 existing baseline，不把缺失当成功。

这些原语仅提供文件能力，不自动装配 Model Tool、审批、恢复点、SQL 状态或执行权。新的只读和恢复路径核原根及目录链 FD、同 uid 的 regular file、nlink=1 和完整 hash/size/device/inode，拒绝 symlink、hardlink、目录、外来文件对象及内容漂移。可信宿主可显式传入 `protectedPaths` 相对目录/文件前缀；禁绝绝对、dot/dotdot、空根路径，规范化后按完整组件匹配（`.git` 不匹配 `.gitignore`），所有三个字节原语均拒绝该 scope。该配置不来自 Model、JSONC 或 HTTP；宿主负责提供真实保护目录，未知保护事实不构成准许依据。原普通 write/edit 合同保持。

可信宿主可以明确选择 `protectReads:true`，将同一保护范围用于普通 read/write/edit、list/search/glob；默认 false 保原普通合同。显式受保护子 scope 在读取前拒绝，枚举根目录时过滤准确受保护子项，搜索不遍历它们，不因保护 `.git` 而排除 `.gitignore` 或相邻文件。选项在工厂固定，不由 Tool input、JSONC 或 HTTP 提供。默认 Service checkpoint scope 开启该选项，保护 canonical profile/协调路径及实际运行 loader 资产；不存在的可信 companion 路径保留 deny 范围，不据此宣称资产已经存在。

restore 复制 caller bytes，先核基线、同目录私有 temp 写全/fsync、再核基线与根，原子发布后 fsync 目录并核完整字节及原发布 inode。remove 核完整基线后仅 unlinkat 原 anchored parent 的准确文件名，fsync 并确认缺失；任何发布/unlink 后同步或确认错误保留 `file_publish_outcome_unknown`。没有多文件原子恢复保证；不合作外部 writer 在最终核对与 rename/unlink 之间的竞态仍存在，dirfd 不能宣称替代它的锁。原语不捕获 Shell/外部修改，也不构成文件 checkpoint 产品交付。

[恢复原语测试](../../../test/isolated/files/recovery-primitives.test.ts)使用真实 macOS Workspace，覆盖完整 binary/BOM/CRLF、有限读取、内容与 inode CAS、反向删除、根改绑、保护组件及不安全对象拒绝。独立进程在真实 fsync 前/后注入失败，证明发布前零写、核对前外部漂移拒绝、已发布 restore/create/remove 保留 unknown 和 temp 清理；源码树外 built 公共入口实际恢复/删除原字节，无 TS fallback。此证据不外推 Windows 或 Linux qualification，也不证明任意外部 writer 原子 CAS。

[Checkpoint business leaf](../../business/file-checkpoints/README.md)提供 `createFileCheckpointing`，沿原 builtin.files namespace 可选接入可信 before/after capture。普通未注入 Tools 保持原行为；注入后保存首个 confirmed preimage 的完整原 scoped Artifact 与末 postimage，封存失败不冒可恢复，发布后错误仍 outcome_unknown。该 leaf 当前只读/blocked intent 范围与尚未闭合的完整恢复边界见对应 owner。

### 检索与读取观察数据

真实搜索结果附 `query`（规范化相对 path、准确 text/glob/ignore、原 after 及本次有效分页／预览参数）、`stats` 和 `files`。`stats.checkedTextFiles` 是本页成功读取并验证为文本的文件数，不包含读取 ignore 规则的附带操作；`matchedFiles` 计本页游标之后实际遇到的命中文件；content 模式的 `matches` 计行命中，包括为判断 `next` 多取的一条，`returnedMatches` 才是实际返回行数。files 模式只取各文件首命中，使用 `returnedFiles`，不填写全部行命中计数。文件可能已完整读取，但找到后页证据后不再扫描其余行，统计不代表全查询总量。`files` 只列已返回命中的文件，各 path 一次，baseline 来自该次真实读取；不为后页预读命中或未返回文件声明来源。零命中、后页或跳过范围会有简短 `feedback`，提示改查入口／范围或按原游标续读，不推断当前实现可达、业务完成或允许重放。

模型 read/search 的 JSON 正文还附纯数据 `observation`：`kind=inspection/lookup`、规范相对 `scope`、search 的完整 query JSON 字符串、`sources[{path,version,fromLine?,toLine?}]` 及 `complete/coverage`。version 是原完整文件 hash，read 的行号来自实际 selection；search 来源仅取上述返回文件。`complete` 指本次是否覆盖整个文件或从头完整检索的所选查询范围，不证明任务成功。read 的局部或尾部窗口为 `coverage=window/complete=false`，`windowComplete=true` 只证明所选正文完整返回；整文件为 `coverage=file`。search 为 `coverage=page`，有原 after、next 或跳过项时 complete 为 false。大 read 沿既有完整 Artifact 正文协议，有限 JSON 摘要保留 observation。旧结构适配器未提供真实 query/files 或 baseline 时不补造观察数据。所有观察均为工具拥有的低信任结果，不授予读取、执行或解除 unknown 的权限。

read 的 observation 另含 `excerpt:{text,truncated}`：仅取本次真实选区正文的前 2000 个 UTF-16 字符，不拆代理对。它是给接收方对照原句的有限片段，不是完整文件，也不改变 `coverage/complete/windowComplete` 的含义；即使片段未截断，局部窗口仍不是整文件。大 read 的有限 JSON 元数据保留该片段，原 Artifact 正文保持完整原字节。

每次 search 的反馈都说明：字面匹配只覆盖本次明确范围与过滤条件，扫描完整不证明调用可达、没有其他实现或没有不同写法的引用。查询含 `|`、`.*` 或字面 `\\b` 时补充具体说明：这些符号按原字符串匹配，不是 OR、通配或词边界；需要测试不同词时分别查询。提示不改变匹配、不拒绝请求、不增加正则能力、执行权或次数限制。
