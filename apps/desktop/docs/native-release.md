# Native 候选、安装与独立 CLI 注册

本页负责完整 Native 物化、归档、使用锁和安装注册。构建后的候选包含实际 Electron、完整新 Terminal、main/preload/renderer 与目录/框架链接；它不从运行环境搜索 Service、Bun、CLI 或 npm。根入口已切换，整体 V1.3、签名与三平台发布仍未完成。

当前 renderer 沿原桌面的 Vite/React/Tailwind 管线编译复用页面，CSS 与 Geist 字体是候选内的实际文件；Vite 输出保留 Main/preload/helper 的共同目录。新增 UI exports 在 workspace build 中产生实际 desktop/index.js 与 style.css，候选继续逐项核完整递归 manifest。macOS 源码外窗口范围与剩余迁移见[Desktop owner](../README.md#复用原桌面展示层)和[本片进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08复用原-pc-桌面展示层)，不替代完整 installed 或三平台资格。

inner Terminal 的共享 UI Desktop build 现内联唯一核心图标依赖，保留原 exports、React peer、CSS 与准确许可，不再物化其完整独立 npm 包；其他真实依赖仍按原解析图复制，边界归[Terminal owner](../../cli/docs/terminal-release.md#制品闭包与身份)。outer、inner和每次启动的全部文件验证保持，启动收益须由原正式窗口及完整默认结果核实，见[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

## 构建与安装

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

目标 Terminal prefix 必须已经是同一管理工具的合法独立安装；`--cli-prefix` 可省略，明确 register-cli 也可在安装后执行。构建、归档和解包目标必须不存在。安装只接受明确归档 SHA 与 prefix，不修改 PATH、shell 配置、用户 Profile 或应用数据。当前安装实现为 POSIX；Windows 安装明确 unsupported，不能以 Windows 类型/构建通过代替安装资格。

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

[跨代码窗口验收](../../../tests/isolated/unified-agent/native-cross-version.test.ts)补充原同源码版本标记的指针测试。当前 macOS 固定复用原 PC 展示层后的 DB7 原提交 `a2b6441fde28d9c0f895a26e6a9d2471d2b1b242`，由其自己的 Terminal 和 Native builder 构建。11项锁输入中10项完整字节相同；Agent 清单只接受已提交 `e587a2a9` 的准确 process-observation export／build source-entry 两处增量，记录双方 SHA，其余依赖、脚本、metadata 或格式变化仍拒绝。Core format 1、旧源码构建前后干净、原依赖闭包和两项 Mac 前端字节差异守卫保持；不改写旧源码或清单，旧候选只支持原 DB7。原3140／Linux1b796只保历史锁输入和资格。两者 productVersion 都是 `0.1.0`，inner、Main、renderer 实际字节与候选 ID 不同。[物化夹具](../../../tests/fixtures/unified-agent/terminal-predecessor.ts)删除旧源码前完成旧 Native 构建，两候选均归档、解包、搬迁并删除原输出；临时旧 clone 仅作验证输入。准确差异取舍归[既有Note](../../../.agents/notes/implemented/testing/2026-10-07-platform-real-code-predecessors.md)。

实际 installed `bin/kite-desktop` 启动正式 Main 和配对 Service，经原四窗口完成 A 原任务、升级 B 的新完整正文、冷回退 A 读取 B 全文并继续原会话，再切回 B 冷读三条原任务。当前 B 构建明确选择 `processHostFixture: native-extension-reference`，mini-review只属测试装配；未注册到默认产品。升级时运行中的 A 仍持原 outer／inner且卸载 busy；四次普通退出后全部候选可独占。指针切换与卸载保 Core／Native私有库 inode／完整字节及配置，回退不恢复备份。原正文由真实窗口按钮和 Main／HTTP 完整读取，冷读保原 Command／Run／Model、正文／hash／ref和Store游标；B的352041B全文实际进入回退后新模型。原持久caller不恢复成hot输入，Provider总计3。

当前 macOS 第四个 B 窗口先沿原侧栏产生实际 DB8 的 unknown 移除申请并保存完整私有字节／inode／配置，再沿正式“会话工具→扩展能力”调用 Analyze。唯一成功 POST 的回复丢失后原申请保持 unknown，实际 Node owner 升为 DB9；完整七字段 request／原 body、scope与摘要保持，实际 Core Job完成。首个 finding精确绑定此前独立读取的原 B Model Execution完整result和已核全文的sealed reference，不能把Model preview冒充全文。普通退出后实际包内 `bin/kite maintenance backup/inspect` 核 manifest v18／DB9／原Store，inspect使用backup返回的唯一目录；备份不修改原私有bytes／inode或配置。原两次独立冷窗口随后只交换代码指针：原DB7 Native的私有操作返回 `draft_storage_unavailable`／callerUnavailable且保原DB9字节，兼容Core三条历史仍完整GET；切回B保原两类unknown申请，明确原GET查回移除回执与完整扩展Command／Execution／finding／reference。查回不增加POST或Provider，业务事实和读游标保持；六个所属Service普通退出、双EX及最终唯一卸载保数据。此前实际DB8拒绝链只保其[原冻结范围](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-db8-真实代码回退)。

当前 macOS 原整文件 1pass／643条Bun断言／actual0／234.736秒及实际driver断言；原420秒整例／120秒四窗口driver／60秒冷段／15秒窗口保持，同一安装候选最终只卸载一次。真实失败和修正、准确输入及结果归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10db9-版本切换与安装版维护恢复)。它证明本地两个真实代码候选对原Core与DB9拒绝／查回的限定兼容链；已发布predecessor／T029、任意旧writer、远端Provider和Linux／Windows资格仍各按适用契约核对。生产安装与回退逻辑本片未改，Windows限制保持。

## Linux 真代码升级与冷回退

同一完整跨代码文件对macOS/Linux执行；历史Linux组合使用首次接受准确builtin SQLite3.53.2来源的原提交 `1b796e30ab0f3638767095d86d4afd374eae662a`，由该源码自己的Terminal和Native builder生成候选。历史3140前驱在Linux的原来源拒绝保留；不修改旧源码、白名单、版本文字或数据库。相同依赖/基线、源码前后干净及成功删除原源码的守卫继续适用，取舍归[平台前驱决定](../../../.agents/notes/implemented/testing/2026-10-07-platform-real-code-predecessors.md)。所有平台都核实际Agent字节与inner/outer候选不同；Mac两个前端差异断言原样保留。该历史Linux组合实际变化为包内Agent worker，Main制品hash不同、renderer字节相同，不能据此认定renderer逻辑演进已验收。

Linux使用实际Electron dist和manifest executable路径、Node `.mjs`、准确`ps` argv/父PID，仅转发`DISPLAY`/`XAUTHORITY`。[窗口driver](../test/native-cross-version-electron.fixture.ts)四次均显式开启Chromium sandbox并核实际sandbox/contextIsolation=true、nodeIntegration=false及没有no-sandbox。原420秒整例、120秒driver、15秒窗口和上述原Store/Command/Run/Model/正文/caller/零重放/双lease/数据保留断言不变。Canonical Ubuntu Base24.04.5、Docker VM原生arm64、UID501、Bun1.4.2/Electron44.3.0/Node22.21.1/Xvfb实际整文件1pass/374条Bun断言及driver断言，actual0/171.298秒，四次窗口普通退出结束于driver80.070秒。回退后的新任务实收到352041字节B全文，最终卸载保Core/Native DB/config原字节和inode。

准确候选、失败、摘要和阶段回归归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。release candidate另在macOS和Linux调用整个文件，Linux在Xvfb中执行，静态守卫拒绝平台缩减、关闭、echo、过滤或缺显示。上述结果只适用于当时锁输入和源码；当前固定 a2b6441f 的 Linux 组合尚未运行，按用户顺序在重构完成后交 GitHub Actions 核对。历史Linux arm64两个本地原始代码候选的有限兼容链不替代已发布predecessor/T029、G1 hosted Ubuntu x64、Windows、四Auth/Vault、新signal故障窗口或全部§35/T/E；生产安装、回退和默认宿主Shell语义没有修改。

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
