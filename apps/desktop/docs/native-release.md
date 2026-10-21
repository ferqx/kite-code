# Native 候选、安装与独立 CLI 注册

本页负责完整 Native 物化、归档、使用锁和安装注册。构建后的候选包含实际 Electron、完整新 Terminal、main/preload/renderer 与目录/框架链接；它不从运行环境搜索 Service、Bun、CLI 或 npm。根入口已切换，整体 V1.3、签名与三平台发布仍未完成。

Windows 构建预检和运行清单均要求 Chromium 的 `chrome_100_percent.pak`、`chrome_200_percent.pak`、`resources.pak` 为非空普通资源文件，仍核完整递归库存与每字节摘要。只有 Electron Node/SQLite 通过不能证明窗口资源完整。本机原已安装 Electron 44.3.0 分发后来发现缺两份 scale pak；原字节一致性证据只证明当时副本与该输入相同。新的隔离输入从缓存原 ZIP 解出，SHA256 `26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d` 与锁定 npm checksums 和[官方发布清单](https://github.com/electron/electron/releases/download/v44.3.0/SHASUMS256.txt)一致，不修改原安装。缺资源反例归[归档/构建合同](../../../tests/isolated/unified-agent/native-archive.test.ts)；真实窗口和维护仍须分别通过原 caller。

当前 renderer 沿原桌面的 Vite/React/Tailwind 管线编译复用页面，CSS 与 Geist 字体是候选内的实际文件；Vite 输出保留 Main/preload/helper 的共同目录。新增 UI exports 在 workspace build 中产生实际 desktop/index.js 与 style.css，候选继续逐项核完整递归 manifest。macOS 源码外窗口范围与剩余迁移见[Desktop owner](../README.md#复用原桌面展示层)和[本片进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08复用原-pc-桌面展示层)，不替代完整 installed 或三平台资格。

inner Terminal 的共享 UI 构建内联已声明的普通 JS 依赖，保留原 exports、React/React DOM peer、CSS 与准确许可；其余动态资源与原生资产仍按原解析图复制，边界归[Terminal owner](../../cli/docs/terminal-release.md#制品闭包与身份)和[闭包成本决定](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)。outer、inner 和每次启动的全部文件验证保持；同一原 pin 只能在本进程复用完整核验，不跨进程授予准入。启动收益须由原正式窗口及完整默认结果核实，旧[图标收束证据](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)只覆盖当时范围。

Windows 显式安装 caller 使用原安装器的受保护复制接口准备未发布 A/B，保全部 verifier 和原 120 秒基本／180 秒维护期限。UIA snapshot 在原进程身份核对后允许“尚无窗口／Document”的空观察，只有期限内实际出现的完整文本才通过；异步输入只写一次并在同一原动作截止前核完整回读。原 45 秒驱动、10 秒动作、多窗口拒绝、自然退出和原 Job 回收保持，理由见[发布夹具决定](../../../.agents/notes/implemented/testing/2026-10-17-windows-release-contracts.md)。隔离 renderer／HWND 诊断只存在于私有诊断制品，普通 dev／prod 不含该入口。

Windows Main 保初始完整内容／语义验证，再由 [Node-API owner](../native/windows-access/README.md)独立取得全部原文件并核完整 SHA、manifest ID、闭合库存和两跳证书；后续复用该 Main 的 genuine owner，每次核原对象、有效 ACL、准确库存和双 SH，不再重复两次无 owner 的 Node 全扫描。持续 pin 拒绝字节改写／删除，目录新增项由重新枚举拒绝；子 Service 仍独立完整准入，不继承父 owner 的权利。未关闭 owner、close unknown 和借用依赖仍按[原对象决定](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)处理。

## 构建与安装

根 `npm run desktop` 需要先生成默认 Terminal 和Native候选：`npm run release:build`、`npm run release:build -- --product native`。缺外层路径或内嵌Terminal时，launch保原双使用锁／完整验证顺序，失败返回 `native_bundle_unavailable` 和准备命令，已取得的锁仍在finally释放。日常开发使用 `npm run build` 后 `npm run desktop:dev`，由独立development profile与每次新建应用目录承载源码调整；不将该开发入口算作完整候选或发行资格。

```sh
bun run release:build --directory /absolute/output/terminal
bun run release:build --product native --terminal /absolute/output/terminal --directory /absolute/output/native --archive /absolute/output/native.tar.gz
bun run release:verify --product native --directory /absolute/output/native
bun run release:install --product native --archive /absolute/output/native.tar.gz --sha256 <SHA256> --prefix /absolute/install/native --cli-prefix /absolute/install/terminal
bun run release:native register-cli --prefix /absolute/install/native --cli-prefix /absolute/install/terminal
bun run release:native unregister-cli --prefix /absolute/install/native
bun run release:native rollback --prefix /absolute/install/native
bun run release:native uninstall --prefix /absolute/install/native
```

目标 Terminal prefix 必须已经是同一管理工具的合法独立安装；`--cli-prefix` 可省略，明确 register-cli 也可在安装后执行。构建、归档和解包目标必须不存在。安装只接受明确归档 SHA 与 prefix，不修改 PATH、shell 配置、用户 Profile 或应用数据。POSIX 保原实现；Windows x64 已接入正式安装、版本选择、登记与保数据卸载的源码，实际原生资格尚未取得，范围见下节。

## Windows managed Native 当前实现

2026-10-17 范围审查的完整 Native候选为 `bc08c49a12bc7c767cd4fb6f68e7e08755dc46721ed8ea771549efadd5bdb2d2`，inner 为 Terminal `e9046c4e26d627ba99875131733a19d16545f71f45c8723af25a37ba88bc6e0a`。官方 Electron 输入73份原文件在 build 前后逐项保持。原整链 r20 中，A/B 两个实际窗口均读取原完整历史、实际 exit0、Main/Service dead、Job0/未Terminate、strict Close 和双 EX；第三次回退 A 时触发原45秒 UIA截止，基础120秒和维护180秒均未扩大。第三冷窗口、恢复后窗口与 installed Native维护没有通过证据，不能以两个窗口或 Node探针授完整资格。

随后只补 bundled 原 manifest 许可来源的 r23 构建及完整校验候选为 `a7f3f3f24136de32437e2b3012d8c82e9de162904f2af06bbeaee7ce6ed61e97`，inner 为 Terminal `9f594260a611c2c5742785daa46cf7a681711fadcce7f5885e5f340e073c7025`。官方73份输入原哈希保持；当前 r23 没有第三冷窗口或维护恢复通过证据，原失败与门禁继续保留。

[Windows installer](../../../scripts/release/windows-native-install.ts)复用明确 archive/prefix 的用户入口。format=2 marker 固定首次候选的四个稳定文件：`bin/kite.exe`、`kite-tui.exe`、`kite-desktop.exe`、`native-verifier.exe`。后续安装及 rollback 只切 current/previous，bootstrap A 保持；运行中的 A 持原 outer/inner 使用权，新启动核当前候选。两个 use 键分别为候选 ID 与 `SHA256(ID + NUL + "terminal")`，均位于 prefix 外同一私有协调 namespace，不与 Profile 交叠。

[Root release build port](../../../scripts/release/windows-native-build.ts)负责固定 compiled verifier 与静态 C 前门，Desktop builder 只通过明确 typed port 调用。源 Terminal 与 Electron 完整原文件 pin 覆盖复制和所有构建 await；Windows 拒绝 links，以私有原 HANDLE 创建／写入／flush，并核全部文件、空目录及实际 SQLite 引擎。新副本的 Electron EXE/DLL 使用 APPDIR/System32 静态 import 搜索；固定 Bun/helper/C 使用 System32。构建新副本时可将严格受限的 RVA v2 delay imports 转为普通 imports，包含实际 GUI Electron；最终仍必须无 delay directory，未知形状、bound／unload、PE不完整或不合格 loader 字段拒绝。Electron 仅另接受准确系统 basename `winspool.drv`／`bthprops.cpl`，不允许任意DRV/CPL、路径或 console 模式豁免。verifier 由持续 pin 的私有候选 Bun 子进程编译，输出权限继续严格复验，转换和私有编译合同归 [Terminal owner](../../cli/docs/terminal-release.md#windows-managed-terminal-当前实现)。原 publisher 文件不修改，SHA 仍只提供完整性。

2026-10-17，本机实际 Electron44.3.0 的52组 delay imports 经有界转换后，完整分发内7个EXE/DLL均通过原最终门禁。[真实运行回归](../../../tests/isolated/unified-agent/windows-native-runtime.test.ts)将其复制到新私有输入、保持原分发完整SHA不变，转换副本在空PATH、cwd伪造 `ffmpeg.dll`／`dbghelp.dll`／`USERENV.dll`／`WINSPOOL.DRV`／`bthprops.cpl` 下实际返回准确版本，独立 `node:sqlite` 探针通过；这是运行时与引擎资格，不代替完整 Native 包、可信创建链、Main/Service窗口或安装维护验收。提前加载会让缺失可选系统模块／符号在启动时失败，其他Windows变体仍须实际验证。

同日实际构建并完整验证Native候选 `2f48062728567c921031fd59d031cb5508c94fd4fb648927c7dff243e18f7230`（99个outer清单文件），准确inner为Terminal候选 `5d46e164e8828f78e4cbe7f2cf6d9e26f694c9a472fd59a92953c788c3733261`。使用已安装Electron的72个原始文件创建同字节私有输入，原分发SHA不变；实际MSVC／renderer／四前门及compiled verifier生成完成。公开Native smoke成功，返回 `closure:true`、`electronVersionProbe:true`、`node:sqlite`3.53.4及 `mainLifecycleQualified:false`。实际归档322,733,021字节，SHA256为 `83242758a348a10e33a01cd853b97cc7c3f0e63ddbf6b19612ad1682a800ad5e`，已独立重算。

原完整安装调用者在pack阶段从81.836秒至530.214秒，随后按原120秒基础门禁报 `windows_native_qualification_deadline`；未进入unpack／install／UIA／维护。保留失败私有根与phase记录，不将完整build／smoke／pack当窗口和安装成功，原180秒维护、窗口／命令期限及真实创建链要求均未放宽。

原对象/Node配套修正后，再次实际构建并全量验证新Native `3475591a7e390500999efd7b88fa19e61523d5d6b22f054113911f2404b4407e`（99个outer文件），准确inner为Terminal `16a4041941db8870d828a492adbf6dce37d51704ae18618e7803d613d2687050`。包内Main核实包含原owner借用、准确固定argv、detached Service和原启动/清理错误同时保留。公开smoke再次成功，Electron44.3.0/独立SQLite3.53.4、closure/version为true，仍明确 `mainLifecycleQualified:false`。新实际归档322,733,688字节，SHA256 `097a2baf427b227d731ba2357b75bc788a8d54d5b59b9f998b90d7380ffde998`，已独立重算并核clone manifest身份/sidecar。

新完整调用者仍失败：pack从51.056秒到399.228秒，399.230秒按原120秒门禁拒绝，未进入unpack/install/UIA/维护。该次与整组回归并行，耗时只说明实际这次调用，不能当独立性能基准；资格也不因并行负载豁免。失败根和原阶段记录保留，无正式窗口启动或模型调用，Windows完整安装/窗口/维护资格继续未取得。

已安装 `kite-desktop.exe` 先由 C 清除运行时环境注入、固定并 pin 自身和 helper；[compiled verifier](../../../scripts/release/entrypoints/windows-native-verifier.ts)取得当前完整 outer/inner 文件 pin 与双 SH 后才创建 Electron。C 用实际创建的 helper HANDLE 出具第一份私有证书，verifier 用实际 Electron HANDLE 出具第二份；[Main 原生端口](../native/windows-access/README.md)在 BrowserWindow、Profile、UI SQLite 和 Service 前分别核真实管道 server/client PID、原 FILETIME 与固定映像，并取得自己的完整文件 pin／双 SH。Service 再取得独立使用权，继承 HANDLE 不作所有权证明。缺交接、伪造 parent、漂移或错误证书继续拒绝；原 SDK 允许指定 PPID，不能单凭 PPID/映像相同放行。

实际Windows改写/重命名反例促使C/Node-API/Bun祖先pin显式请求FILE_TRAVERSE，普通候选文件pin请求GENERIC_READ；仅属性HANDLE不足以建立原共享保护。LockFileEx区域锁改为必要的只读权，与真正只读全文件pin相容，UI SQLite读写权保持。Main的配套启动由可信装配端口借用自己已接纳的原生owner，以WeakMap绑定原root/digest/entry/Bun/build；复制/伪造/closed owner拒绝，原child退出未兑现时Main不得关闭，不在Electron加载Bun FFI。子Service继续独立完整准入。

[Node适配器](../electron/node-process.ts)接受原两参数或同一候选的四个准确固定Bun参数，拒绝额外或改投配置；Windows使用detached创建保私有stdin/双输出，让Main异常退出后Service实际EOF清理，避免libuv默认Job直接强杀。2026-10-17三个完整文件[原生owner](../test/isolated/windows-node-access.test.ts)、[原Main借用](../test/isolated/windows-native-candidate.test.ts)、[真实Node参数](../test/isolated/node-process.test.ts)共11项/74断言通过；包含实际Electron/Node-API、父原HANDLE异常退出、清理barrier期间EX仍busy、子进程自然0与原UI/锁归属，以及退出未知不归还借用的有限端口反例。不是完整installed窗口验收，取舍及原生证据边界归[原对象决定](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)。

Windows 登记后的独立 Terminal CLI/TUI 转发到 Native 稳定 C 前门。双 prefix SH 内核原 nonce、完整候选和原 ID；内部 expected-candidate 只收窄选择。Native 自身准入若已合法切 B，明确返回 `cli_registration_changed`，不会将已核 A 的证据用于 B；接纳 A 后释放 selection，仍允许正常升级。普通任务与 `kite.exe maintenance` 随该候选进入原业务／离线维护，未增加 journal 自动决定、模型调用或数据回退。

rollback 在发布前完整预检仍由原 nonce 持有的 Terminal；正常 Terminal 卸载后的历史登记不重建旧前门。Native uninstall 取得全部 outer/inner EX 和完整树 DELETE owner，复用 genuine removal 验证，原 nonce CAS 撤销外部前向登记，再逐原对象删除并确认根消失；Profile、配置、项目和独立备份不进入删除输入。opaque transfer／关闭未知保留本调用完整锁组与原资源，所有文件确认关闭后才释放使用权。归档私有 scratch 也只以完整库存的原 DELETE owner 清理。

本机现有Windows有限证据覆盖真实私有ACL下的归档／安装控制、原关闭未知、实际MSVC前门、Bun及上述Electron引擎探针；完整Native包、pipe、Main／Service窗口和installed维护恢复仍按各自实际结果判断，不将有限夹具升级为整链资格。未dispatch hosted Actions。raw `release:native launch --directory` 的 Windows 限制保持，正式 Windows 入口是已安装的稳定前门；desktop 前门当前只接受无附加用户参数的启动。完整用户链必须在 Windows 核普通任务／历史、A→B→A、维护新 Store 原完整结果冷读零重放、准确退出、双 EX 及卸载保数据，才能关闭该平台能力。

[Windows 安装正式调用者](../../../tests/fixtures/unified-agent/windows-native-installation.qualification.ts)现已接入 release-candidate 的 Windows build／verify／smoke 后；[现行 CI 守卫](../../../scripts/check-unified-workspaces.ts)拒绝缺失、错平台、忽略错误、命令替代及前置顺序错误。该 caller 以同一个已核候选归档／解包并删除自己的构建副本，零参数启动稳定 `kite-desktop.exe`，由系统 [UIAutomation driver](../../../tests/fixtures/unified-agent/windows-native-uia.ts)操作实际会话输入、提交、完整回复和默认应用菜单退出，不增加产品调试参数或假创建证书。窗口关闭只隐藏，不能代替退出。

验收源码保基础安装120秒、driver45秒、窗口／操作10秒和独立维护180秒预算。A任务完成后运行中选择同代码合成版本B，原A Main／Service与双SH继续固定；退出后冷启动B、rollback再冷启动A。全部原进程退出、两候选双EX可取得后，从 installed `kite.exe maintenance` backup／inspect／restore／status 恢复新Store，第四个新窗口冷读原完整结果；准确原Command／Run／Execution、sealed输出和Provider恰1独立核对，最后唯一卸载保Core／Native DB／config原字节。该B只改变未发布见证manifest，不计真实跨代码兼容。

进程证据来自本次创建前原Job及成员原HANDLE／FILETIME／实际映像，PPID仅用于在已证成员中定位Main与Service；正常退出另要求 `terminationRequested=false`，防止fixture强制终止掩盖产品收尾失败。MCP公共v3语法保持原投影。源码／本机控制流通过不证明Windows UIA树、菜单、嵌套Job、两跳证书或维护正向运行；完整caller尚未在Windows执行，平台与阶段门禁继续保留。取舍与验收依赖见[Windows调用者提案](../../../.agents/notes/proposed/testing/2026-10-10-windows-native-installed-caller.md)，实际有限证据见[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-native-正式安装版本切换与维护调用者源码)。

Windows 注册 CLI/TUI 另由 [完整 installed TUI caller](../../../tests/fixtures/unified-agent/windows-installed-tui.qualification.ts)消费准确 Terminal／Native 候选：同一个独立稳定 `kite-tui.exe` 先用 Terminal，再用登记后的 Native 双层闭包；实际键盘任务、全文／思考、导出、准确取消、草稿及冷读零重放，正常退出须原 Job 未 Terminate／完整 EOF／Job0／双 EX，撤登记和最终卸载保原数据。此调用者已接 release job，但 Windows 实际运行尚未取得，按用户安排交后续 Actions；它不把窗口、真正跨代码切换、Shell／RSS 或阶段资格记为通过。完整合同及预算归 [Terminal owner](../../cli/docs/terminal-release.md#windows-installed-tui-正式调用者)。

同一安装调用者支持显式 `--predecessor=<absolute-original-native>` 真代码分支，由[统一入口](../../../tests/fixtures/unified-agent/windows-cross-version.qualification.ts)调用固定 `4a4c0e440b2098e5b4ec58c5831452773b39228f` 原源码自己的两类 builder。11项锁输入沿[Terminal 输入守卫](../../cli/docs/terminal-release.md#验证边界)核原字节相同或已审查的完整 raw 配对；两份迁移 SQL 仍逐字相同，另核固定 checksum；原两版 `0.1.0`、clean source、不同 commit／candidate／实际 Agent SHA 均独立核对。该前驱支持0002和DB9，属于同 schema 跨代码兼容。原837输入与历史SHA仍保独立legacy守卫，不计DB9旧writer拒绝或已发布predecessor资格。

真分支从零参数稳定 `kite-desktop.exe` 完成 A任务／A原Main与Service alive、双SH时选B／B冷读并明确新任务／回退A冷读B并明确第三任务／最终B冷读全部原历史四窗口，后继真实Provider请求必须含此前完整正文，冷读游标／Provider保持。普通完整短结果与sealed描述符按实际存储分别核原身份／正文／bytes／hash，不要求短正文必须有sealed引用；三任务为完整固定短正文，不授350KiB或17MiB窗口展示资格。四窗原owner自然退出／未Terminate和双EX后，B installed CLI按原backup／inspect／restore新Store／status链执行，再从B第五冷窗口核全部原Command／Run／Execution及结果／出处，Provider恰3；最终只卸载一次并保Core／Native DB／config原字节。显式基础420秒、各独立UIA driver45秒／launch与页面及退出10秒、维护180秒／CLI30秒，取统一绝对期限的更小值，默认120秒／180秒及原95条断言保持。原生Windows整链尚未执行，资格保留；与Terminal共享物化、mandatory CI及真实输入边界归[Terminal owner](../../cli/docs/terminal-release.md#windows-真实代码升级与冷回退调用者)，准确本机修正与证据归[当前进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11windows-真实代码升级与冷回退正式调用者)。

## 完整身份与生命周期

[Native verifier](../../service/src/native-runtime-assets.ts)核 outer 的准确普通文件、目录及受限相对框架链接，并独立完整核 inner Terminal。tar 只存普通字节和封闭链接声明；拒绝 traversal、真实 tar links、重复/PAX 冲突、外部 hardlink、篡改及未声明条目，物化后重新核两层。目录中的 Electron 空 locale 也必须在准确清单内。

普通文件的 SHA 沿[Service 只读 leaf](../../service/src/asset-file-hash.ts)核完整内容。通过原大小检查且不超过 64 KiB 的文件保留 `readFileSync`；较大文件逐块读至 EOF，每次完整核验按需分配并复用一个 1 MiB buffer。Main 的同步 `noAsar` 范围继续核物理 archive；初次核验、原双 SH 后复核与 Service 自有准入全部保持。分块内容及两层末字节拒绝由[原 Node-safe 完整测试](../../service/test/isolated/native-runtime-assets.test.ts)核对，实际首屏失败、读取对照与窗口／完整默认资格归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

Node main 持 outer/inner 两个 SH，继承 Bun helper 只关闭副本，不对 shared description UNLOCK。Service 与共享 Daemon 独立保两 root 使用权。Native proof 只接受已完整核验 inner Terminal 清单中的 `service` 或 `daemon`，两种入口均固定同一包内 Bun、`native-<digest>` 与 outer manifest；CLI/Electron 入口不获得 Service 身份。verify 与 private startup proof 的原 build/entry/runtime/manifest 必须准确相等，默认 Files 保护两个实际完整 root。关窗口、关闭 Client 或父进程退出不等于全部 lease 已释放；原运行/资源确认关闭后才释放。卸载先取得所有候选的双 root EX，busy 立即拒绝，不猜 PID 或强杀服务。

卸载在原安装 EX 内先核封闭管理结构、准确候选 ID 和 outer/inner 真实目录，再按稳定顺序取得所有候选双 root EX。busy 在内容读取前拒绝；候选同时损坏且使用中时先返回 busy，释放使用权后仍完整核 manifest、文件字节和 digest，损坏不能卸载。全部 EX 持有后完整核每个原候选，删除前再次核管理结构、active/previous 与候选 ID 集合；漂移拒绝，部分取得的租约沿原 finally 释放。原登记 nonce CAS、rename/fsync、数据保留和真实卸载保持，完整验证不靠缓存。

不可变 releases、两行 active 与 previous 只控制后续启动；旧进程继续使用原候选。升级与回滚不替换数据、不恢复旧备份。Native 私有 `node:sqlite` 引擎在选 Profile/打开 UI 数据库前实测并核 manifest；Bun Worker 引擎另行选择，两者不互相冒充。

## 标准命令登记与卸载恢复

双 prefix 以固定顺序持安装 EX，0600 封闭 metadata 保存 terminalPrefix/nativePrefix/candidateId/nonce。标准独立前门在持有 Terminal SH 后复核双方原 nonce、Native active 与双 root SH，再执行 Native 内 Bun 和固定 CLI/TUI，配套 Service 同属该闭包。读取不授予其他 Profile 或任意可执行入口。坏登记、nonce 漂移或 active 漂移拒绝，不自动回退。

Native 自带 `bin/kite`、`bin/kite-tui`、`bin/kite-desktop`；独立 Terminal 前门也可选择该 Native。安装更新只更新自己仍拥有的登记，卸载以 nonce CAS 撤销，不能抹掉后来另一个 Native 的登记。独立前门仍存在时，标准命令恢复该 Terminal。若父 shell 已缓存 Native-bin-first 的路径，删除后该缓存真实返回 127；用户执行 `hash -r` 或打开新 shell 后恢复 PATH 查找。安装器无法清除父 shell 缓存，不留未经用户授权的 stub，不修改 PATH/RC。

独立 Terminal 正常卸载后，Native 的反向登记只保留历史归属。省略 `--cli-prefix` 的升级在旧目标已不存在时仅持 Native 安装 EX，继续完整核候选和发布 active；不会锁定或重建旧 Terminal，也不会自动登记后来重建的目录。仍存在的隐式目标以及所有显式目标继续完整验证、固定顺序持锁和 nonce CAS；无效目标拒绝，不能据目录缺失放宽明确登记。Native 回退和卸载保留同一可选前门边界。

回退在双 prefix EX 内固定仍存在且由原 nonce 持有的 Terminal 目标，先完整核其候选与登记身份，再发布 Native active 并更新该目标。已知损坏在发布前拒绝，Native active、反向登记和独立前门登记均保原字节；修复候选后原前门仍可读取原选择，再明确回退。目标已正常卸载时仍可独立回退，后来其他 Native 的 nonce 不被夺回。这一预检不增加跨 prefix 崩溃原子性保证。[登记完整文件](../../../tests/isolated/unified-agent/cli-registration.test.ts)新增真实字节损坏反例并保原五项；有限候选只核安装格式与选择合同，不能代替真实代码升级、窗口或平台资格。

macOS 的[登记完整文件](../../../tests/isolated/unified-agent/cli-registration.test.ts)及[原安装窗口](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)已验证这一正常卸载后升级链：原两个真实窗口保完整任务、冷读、Provider恰1、Store metadata／View、回退、双lease退出及卸载保数据。原120秒整例／45秒driver不变；两个候选是同源码版本标记差异，只证明安装选择与当前消费者，不充当真实旧代码兼容、DB9或已发布样本。准确输入和实际失败归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10安装升级与维护关闭所有权)。

## macOS 安装版离线维护

Native 自带 `bin/kite maintenance` 和登记后的独立 Terminal 前门均先核完整候选、持原使用权，再调用同一[离线维护 leaf](../../cli/host/maintenance.ts)。明确的 data root/profile 与制品目录分开；维护不连接 Service 或 Provider。macOS 的[原 PC 窗口用例](../test/isolated/native-background-bundle.test.ts)在原三次普通窗口退出后，用实际 installer API 安装完整 Native 和独立 Terminal 并登记，实际 `bin/kite` 执行 backup、inspect、真实时钟下的 GC、restore 和 status。DB8 备份为 manifest v17；最近删除仍保留宽限。过期清理由候选内 Bun 执行外部夹具，调用安装包的公开 `runNativeTerminalCLI` 选择器，仅推进夹具时钟，不修改原时间戳或回执，也不新增生产时钟选项；这一步不冒称实际 bin 等待了七天。

恢复生成新 Store，原目录的 Core／Node 私有 DB 字节和 inode 保留；恢复的私有文件与所选 SQLite 备份快照字节相同，公开只读 Store 核原历史、执行和 Command，旧 Store 身份拒绝。维护期间 Provider 不增加。实际卸载取得所有安装候选 EX，保独立 Profile、配置、项目文件和备份；原三 Service 正常退出、准确所属进程为空、原候选两层 EX 可再取。准确结果归[进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-安装版离线维护)。该有限链不覆盖恢复发布中断的 reconcile、新基线发布后的前版样本、任意版本或全部 W19／三平台资格；DB8 的旧代码运行边界另见下节。

[安装版 PC 恢复中断](../../../tests/isolated/unified-agent/native-restore-interruption.test.ts)另补 macOS 的目录缺失入口：现有 source 恢复观察点暂停在旧 Profile 已移走、journal 仍为 prepared，使用候选内 Bun 和所选引擎，真实 SIGKILL。未修改的 installed Main／Service 在持锁和强杀后拒绝业务准入，不创建空 Profile／Core；稳定锁和原目录字节保持，其他 Profile 可用。包内 `bin/kite maintenance status/reconcile` 先绑定原 ID／digest 明确 rollback；同窗重新加载读回原 Store、后来保存的 Session，候选内公开只读 Store 核原 Command 与 Core／配置字节，保留的恢复候选完整字节也保持。窗口及所属 Service 实际退出、Profile 与双制品 EX 已取后，才在同一观察点再次准备恢复，完整执行原 complete 腿：新 Store、备份 Session、准确 Command 不存在、普通退出和唯一卸载保数据。Provider0、180秒整例／45秒单driver／10秒窗口及原 complete 全部断言保持；新增 rollback 不重复完整 Model／问答展示，也不代替 installed restore 全中断矩阵或整个 R07／W19。准确当前结果见[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10db9-版本切换与安装版维护恢复)，此前仅 complete 的范围保[原证据](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08安装版-pc-恢复目录缺失边界)。

## 真实代码升级与冷回退

[跨代码窗口验收](../../../tests/isolated/unified-agent/native-cross-version.test.ts)补充原同源码版本标记的指针测试。当前固定真实兼容提交 `4a4c0e440b2098e5b4ec58c5831452773b39228f`，由其自己的 Terminal／Native builder 构建。11项锁输入核原字节相同或已审查的完整 raw 配对，Core format 1 的0001／0002两份迁移仍另核原字节和固定 checksum；不把仅同 format major 当成反向读写兼容。原源码前后干净、闭包、实际Agent／候选不同、Mac Main／renderer字节差异、源码删除、归档搬迁和原输出删除守卫保持。原a2b的DB7及旧Core schema不被修改，另供安全拒绝反例；3140／Linux1b796只保历史证据。取舍归[兼容前驱决定](../../../.agents/notes/implemented/testing/2026-10-16-schema-compatible-predecessors.md)。

原a2b／837的legacy workspace投影、SHA和路径隔离按[Terminal owner](../../cli/docs/terminal-release.md#验证边界)保留；当前兼容入口不借用 legacy 投影；只接受原字节相同或同一固定前驱 context 下的准确 raw 配对，两 SQL 仍核原字节及固定 checksum。模型配置在所属Profile与user文件保存同值输入和原字节保护，不改变生产来源选择。

实际 installed `bin/kite-desktop` 启动正式 Main 和配对 Service，经原四窗口完成 A 原任务、升级 B 的新完整正文、冷回退 A 读取 B 全文并继续原会话，再切回 B 冷读三条原任务。当前 B 构建明确选择 `processHostFixture: native-extension-reference`，mini-review只属测试装配；未注册到默认产品。升级时运行中的 A 仍持原 outer／inner且卸载 busy；四次普通退出后全部候选可独占。指针切换与卸载保 Core／Native私有库 inode／完整字节及配置，回退不恢复备份。原正文由真实窗口按钮和 Main／HTTP 完整读取，冷读保原 Command／Run／Model、正文／hash／ref和Store游标；B的352041B全文实际进入回退后新模型。原持久caller不恢复成hot输入，Provider总计3。

当前 macOS 第四个 B 窗口先沿原侧栏产生实际 DB8 的 unknown 移除申请并保存完整私有字节／inode／配置，再沿正式“会话工具→扩展能力”调用 Analyze。唯一成功 POST 的回复丢失后原申请保持 unknown，实际 Node owner 升为 DB9；完整七字段 request／原 body、scope与摘要保持，实际 Core Job完成。首个 finding精确绑定此前独立读取的原 B Model Execution完整result和已核全文的sealed reference，不能把Model preview冒充全文。普通退出后实际包内 `bin/kite maintenance backup/inspect` 核 manifest v18／DB9／原Store，inspect使用backup返回的唯一目录；备份不修改原私有bytes／inode或配置。原两次独立冷窗口随后只交换代码指针：兼容A可读取原DB9草稿与unknown申请，Core三条历史完整GET，原DB9字节保持；切回B保原两类unknown申请，明确原GET查回移除回执与完整扩展Command／Execution／finding／reference。查回不增加POST或Provider，业务事实和读游标保持；六个所属Service普通退出、双EX及最终唯一卸载保数据。此前实际DB8拒绝链只保其[原冻结范围](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-db8-真实代码回退)。

2026-10-11历史macOS在Service精确来源入口匹配修复后，原整文件1pass／643条Bun断言／actual0／221.20秒及实际driver断言；原420秒整例／120秒四窗口driver／60秒冷段／15秒窗口保持，同一安装候选最终只卸载一次。准确当前输入、两个原版本完整文件与集成门禁归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)，此前234.736秒及四次真实失败只保[原输入范围](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10db9-版本切换与安装版维护恢复)。该历史结果证明当时两个真实代码候选的限定链；已发布predecessor／T029、任意旧writer、远端Provider和Linux／Windows资格仍各按适用契约核对。生产安装与回退逻辑本片未改，Windows限制保持。

原文件另有独立300秒legacy安全拒绝整例，实际构建a2b Native，两个独立owned Profile分别核当前公共Store生成的0002拒绝，以及原a2b Core0001配当前production PrivateData合法生成DB9后的私有拒绝。前者观察旧Main诊断缺能力，后者实际触达 `draft.read` 的 `draft_storage_unavailable`／callerUnavailable；两者均Provider零、普通退出、准确PID死亡／双EX，并在退出与卸载后核Core／private／Profile和user配置的完整bytes／inode。前者不冒称已执行私有拒绝，后者不复制、恢复或降级Core。当前source owner生成数据的负例不替代首个test的完整当前Native安装资格。

2026-10-19当前macOS主升级场景定向1项/1435条Bun断言/156.58s通过。B输入明确独立工作，保完整352041字节，并以真实public/raw/decision/business/Run/成功Model Source替代按Run数组位置推断；正式lookupInput查回原公开ID，完整ModelInput仍由原Native reader读取。Native journal同步采用共享业务绑定校验，不再要求业务Run.origin等于原public ID；旧技术steer和scope/digest、取消、extension与冷零POST保持。原A/回退A、3次Provider、原历史/bytes/hash/inode、四暖窗口及两DB9冷窗口、备份/安装/回退/卸载/退出双lease及原420/120/60/15秒预算保持。本次定向未运行另一个legacy拒绝case，完整默认的整文件证据归[测试owner](../../../tests/README.md#子-agent-协作-v11-验证)，不由定向主场景推导跨平台或发布资格。

## Linux 真代码升级与冷回退

同一完整跨代码文件对macOS/Linux执行；历史Linux组合使用首次接受准确builtin SQLite3.53.2来源的原提交 `1b796e30ab0f3638767095d86d4afd374eae662a`，由该源码自己的Terminal和Native builder生成候选。历史3140前驱在Linux的原来源拒绝保留；不修改旧源码、白名单、版本文字或数据库。相同依赖/基线、源码前后干净及成功删除原源码的守卫继续适用，取舍归[平台前驱决定](../../../.agents/notes/implemented/testing/2026-10-07-platform-real-code-predecessors.md)。所有平台都核实际Agent字节与inner/outer候选不同；Mac两个前端差异断言原样保留。该历史Linux组合实际变化为包内Agent worker，Main制品hash不同、renderer字节相同，不能据此认定renderer逻辑演进已验收。

Linux使用实际Electron dist和manifest executable路径、Node `.mjs`、准确`ps` argv/父PID，仅转发`DISPLAY`/`XAUTHORITY`。[窗口driver](../test/native-cross-version-electron.fixture.ts)四次均显式开启Chromium sandbox并核实际sandbox/contextIsolation=true、nodeIntegration=false及没有no-sandbox。原420秒整例、120秒driver、15秒窗口和上述原Store/Command/Run/Model/正文/caller/零重放/双lease/数据保留断言不变。Canonical Ubuntu Base24.04.5、Docker VM原生arm64、UID501、Bun1.4.2/Electron44.3.0/Node22.21.1/Xvfb实际整文件1pass/374条Bun断言及driver断言，actual0/171.298秒，四次窗口普通退出结束于driver80.070秒。回退后的新任务实收到352041字节B全文，最终卸载保Core/Native DB/config原字节和inode。

准确候选、失败、摘要和阶段回归归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。release candidate另在macOS和Linux调用整个文件，Linux在Xvfb中执行，静态守卫拒绝平台缩减、关闭、echo、过滤或缺显示。上述结果只适用于当时锁输入和源码；当前固定 4a4c0e440 的 Linux 兼容组合尚未运行，按用户顺序在重构完成后交 GitHub Actions 核对。历史Linux arm64两个本地原始代码候选的有限兼容链不替代已发布predecessor/T029、G1 hosted Ubuntu x64、Windows、四Auth/Vault、新signal故障窗口或全部§35/T/E；生产安装、回退和默认宿主Shell语义没有修改。

## Linux arm64 安装生命周期

[原完整安装文件](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)现对 macOS/Linux 执行，临时目录使用平台 `tmpdir()`，Electron 发行目录按实际平台定位，Node driver 使用明确 `.mjs`。Linux 只转发显示所需 `DISPLAY`/`XAUTHORITY`；`ps` 使用实际 executable argv 列，仍核准确 Main 父 PID。原 120 秒整例、45 秒 driver、10 秒窗口等待及全部业务/双锁/保数据断言保持。

测试 driver 的正常退出由 Playwright `close()` 发起一次 `app.quit()` 并等待真实 Main 退出，控制用 HTTP 请求明确关闭连接；不调用 `process.exit()` 代替资源清理。2026-10-08 原安装用例在本机以 driver36.428秒自然退出、计时器未触发通过。先前完整默认曾在原45秒窗口失败，耗时包含完整安装校验；定向通过与这次夹具清理不单独证明并发默认图或每个平台通过，当前完整结果归[进度证据](../../../docs/plans/unified-agent-refactor-v1-progress.md)。

[实际 driver](../../../tests/fixtures/unified-agent/native-install-electron.ts)明确 `chromiumSandbox:true`，两次窗口均核全局没有 `--no-sandbox`，且实际 BrowserWindow 的 sandbox/contextIsolation 为 true、nodeIntegration 为 false。Playwright 的 Linux 默认会关闭 Chromium sandbox，因此不能沿默认值取得资格。自有容器使用 [Playwright 官方 seccomp allowlist](https://playwright.dev/docs/docker#crawling-and-scraping)的 namespace 支持，保留 no-new-privileges、无 privileged/额外 capability；不向产品或默认 Shell 注入该容器配置。

当前有限实测为 Canonical Ubuntu Base 24.04.5、Docker VM 原生 aarch64、UID501、Bun1.4.2、Electron44.3.0、Node driver22.21.1、Xvfb。完整归档/解包/搬迁和删除原输出后，实际 installed `bin/kite-desktop` 经默认 Main/renderer/Service完成一次模型任务、冷读、同源码版本指针升级/回滚、正常退出与双锁强杀窗口、最终卸载保 Core/Native DB/config 原字节。[Store写锁等待修复](../../../packages/agent/src/storage/README.md#写锁的有界等待)后重新生成的当前候选再次通过，Provider 恰1，1pass/25条Bun断言，71.851秒、driver26.455秒；准确 manifest 分别实测独立 builtin `node:sqlite`3.53.4 和 `bun:sqlite`3.53.2。首次76.692秒的原证据另保。它不是 Linux 真实跨代码/已发布 predecessor、Vault、全部 Native 业务、Windows 或 G1 原生 Ubuntu x64 CI 资格。

此前 x64 用户空间经 Rosetta 仿真的三轮实际失败分别为旧 Node/ESM driver、45秒 driver、临时55秒driver仍撞原120秒整例。失败证据保留，55秒更改已撤销，没有用仿真失败换取原预算放宽。补齐 git 前的 arm64 设置失败也保留。准确输入、原始日志和正常 owned 收尾见[进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-native-安装生命周期)。release-candidate 的 Linux 步骤执行整个原文件，Required unit 在 Xvfb 内执行整个默认图；CI 守卫拒绝移除/错平台/echo/过滤或静默关闭显示入口。定义不等于 hosted 通过。

## 公共扩展的安装版正式消费者

[扩展整窗口](../test/isolated/native-extensions-bundle.test.ts) 在制品hash发布前使用固定 `native-extension-reference` 测试装配，将现有mini-review及其可信能力分类加入默认Process Host；分类读取真实页面保存的模式与信任，其他定义继续原默认policy。没有mini-review默认产品入口、额外生产开关或现场改写已发布候选。标准Terminal／Native builder、搬迁和删除原输出、公开installer与 `bin/kite-desktop` 实际launcher保持。

窗口沿正式“会话工具→扩展能力”完成原Model source、schema动作、完整finding、原Mark、明确新business key以及冷原Command／Query；阅读不得增加POST或Model。两个所属Service普通退出后两层EX和保Profile卸载继续检查。准确实际结果与首次权限装配失败归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)。DB9／v18实际Node维护归[维护owner](../../../packages/agent/src/maintenance/README.md#desktop-db9-与-manifest-v18)；DB9已由上述本机真实代码链核旧版拒绝及当前原GET查回；不授予旧writer支持或全部平台资格。

## 验证与限制

[默认宿主 Shell 生命周期](../test/isolated/native-shell-lifecycle-bundle.test.ts)在 macOS 真实安装并删除全部原候选后，三次沿 installed `bin/kite-desktop` 核页面新建后台 Job、完整保存输出、准确停止、Main/Service SIGKILL 后本次 coalition 全树消失及两次冷读零重放。测试不持 fixture SH，实际 Main/Service 持 outer/inner 使用锁；Service 强杀但 Main 仍在时卸载准确 busy，全部退出后两层 EX 均可取得，成功卸载保 Core/Native DB/config 原 inode 和完整字节。它使用生产默认 Service/宿主 Shell；Service 崩溃后的原未完成状态不改写为停止成功。本机安装入口的 Shell 故障组合已有实际证据，不补齐已发布升级样本、其他安装故障或 G1，准确结果归[安装入口进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08默认-shell-实际安装入口与保数据卸载)。

[真实 Native archive/install/lifecycle](../../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)在源码树外删除原候选后启动实际 Electron Main 与所属 Service，验证原数据/cold 读取、升级旧进程固定、双锁强杀窗口、回滚与卸载。[注册验收](../../../tests/isolated/unified-agent/cli-registration-lifecycle.test.ts)核两种 PATH 与真正 80×24 TUI，公共 Store 核三条 Run completed，实际 Provider 3；每次运行中卸载 busy 并保持登记，卸载后原查询、数据库/config/caller bytes 和 cursor 不变。[Files 保护](../../../tests/isolated/unified-agent/native-runtime-protection.test.ts)核 Workspace 中实际 outer/inner 读写保护与邻接正常效果。

[实际安装 stdin](../../../tests/isolated/unified-agent/native-stdin.test.ts)删除构建源后使用 Native 自带 `bin/kite` 启动共享 Daemon，核原问题的空白拒绝与 EOF 等待、新 CLI 进程沿原 Work 回答一次、完整 Provider/历史语义及重复零新 Run/Answer。启动 CLI 退出和工作完成后，Daemon 仍独立阻止卸载；实际 stop/status absent 后才卸载。该证据不包含 Daemon 冷重启或 Electron 窗口。

[有限卸载反例](../../../tests/isolated/unified-agent/native-install.test.ts)使用真实 inner SH 与坏 manifest 验证 busy 优先、失败后的 outer EX 可重新取得、空闲后的完整性拒绝及准确 active/内容保留；两层目录 alias 也拒绝。有限夹具只证明锁与格式合同，真实窗口沿原安装生命周期任务、45 秒 driver 期限与准确退出断言另行运行。

macOS arm64 保原 Bun/Electron、普通退出及上述安装 Shell 故障窗口资格；Linux arm64 仅取得上述完整安装文件的有限资格。纯 version smoke 只核 executable/引擎，`mainLifecycleQualified:false`，不能当窗口验收。其余必要安装故障、已发布 predecessor、Linux x64/Windows Native 生命周期、签名/公证/发布者认证及完整 T001—T114/E01—E14 仍需各自实际证据。当前归档 SHA/manifest 只提供完整性。

完整闭包、双 prefix nonce CAS 和父 shell cache 的持久理由见[Native 登记决定](../../../.agents/notes/implemented/architecture/2026-10-04-native-complete-closure-and-cli-registration.md)；Node/Bun 引擎独立测量见[SQLite 选择决定](../../../.agents/notes/implemented/architecture/2026-10-04-selected-sqlite-engine-and-worker-identity.md)。Note 状态不能替代上述平台和发布证据。
