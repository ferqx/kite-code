# 开源候选版本控制

状态：active

读取时机：修改新 Terminal/Native manifest、构建、安装注册、SQLite selection、三平台 workflow、rollback 或发布状态时。

验证：`bun run check:runtime-packages`、`bun run check:unified-agent-boundary`、`bun test tests/integration/scripts/unified-ci.test.ts tests/isolated/unified-agent/release-tools.test.ts`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:docs`、`bun run check:docs-impact`。具体平台范围见[实施证据](../plans/unified-agent-refactor-v1-progress.md)。

## 当前发行与源身份

旧 Desktop 的普通开发、服务准备、Electron构建和打包调用者已明确退役：六个package命令及四个直接脚本在任何旧producer或制品写入前以 `legacy_desktop_entrypoint_retired`／2退出，并指向当前Native命令。完整行为和历史追溯归[开发入口](../development/local-development.md)与[旧Desktop owner](../../apps/kite-desktop/README.md)，实际拒绝及原数据保全由[完整调用者测试](../../tests/isolated/unified-agent/retired-desktop-entrypoints.test.ts)核验。此项可独立于RSS／完整观测推进；当前完整Native仍使用新Service／Terminal闭包。旧历史测试／已保存制品及全部旧源码最终退役不因这些命令闭合而自动完成，三平台和§35门禁保持。

根 workspaces 精确为 AI、Agent、Client、UI、Service、CLI、Desktop、Web。正式 CLI/TUI 固定完整 Terminal，Desktop 固定完整 Native；独立 source/development 显式入口不发现旧发布包或旧用户数据。业务通过唯一 HTTP/SSE Client；私有 bootstrap/发现只负责配套进程，不是第二业务 carrier。

完整候选只物化生成 exports 真正需要的解析边。当前唯一内联的核心图标依赖归[UI build owner](../../packages/ui/README.md#原桌面展示层)：其他 external／peer、原 exports／CSS与准确许可保持，builder拒绝残留该包的外部引用。复制器不能以内联声明跳过 peer、optional或workspace；新闭包的全部文件仍纳入原manifest和每次独立完整校验。此构建收束不改变三次准入、双使用锁或平台完成约束。

`release:build` / `verify` / `smoke` / `install` 使用[新工具](../../scripts/release/unified.ts)。默认 product 为 terminal，Native 明确 `--product native`。两种制品分别有完整 manifest/文件哈希，Native 包含完整 Terminal 和实际 Electron。archive SHA 绑定压缩字节，candidate ID 绑定 manifest；未签名 checksum 不证明发布者身份、provenance、公证或 attestation。 可信Native MCP测试候选仅由builder固定`native-mcp-loopback`选项在构建前写入专用ProcessHost和可选公开证书，所有字节纳入同一inventory/digest；普通生产main/daemon未选择该选项。其loopback/TLS测试网络必须声明productionDefaultNetwork=false，不能将默认browser/backend/permissions装配或局部窗口通过冒称完整生产/平台资格。

候选 workflow 显式 checkout PR head repository/head SHA，只读权限、关闭持久凭据，verify 传 `--source-commit <实际head> --clean-source true`。第三方 actions 固定40位 commit，Bun 固定1.4.2。工作树 dirty、源提交不符或实际文件/链接/目录/引擎变化拒绝，不把 merge ref、版本文字或旧三平台记录作为当前候选身份。

release candidate 在 macOS 与 Linux 运行原[完整 installed Terminal 测试](../../tests/isolated/unified-agent/terminal-bundle.test.ts)，包含实际 CLI/TUI、升级/回滚、lease 与卸载保数据；Linux 分支继续核 selected 引擎、双 Worker WAL 和实际安装 maintenance。正式消费者守卫要求双方平台及准确完整命令，拒绝 Mac-only、echo 与过滤到零案例。workflow 接入不表示该原生平台已执行通过。

真实代码比较另调用完整[Terminal文件](../../tests/isolated/unified-agent/terminal-cross-version.test.ts)，条件覆盖macOS/Linux；完整[Native文件](../../tests/isolated/unified-agent/native-cross-version.test.ts)分别在macOS和Linux执行，Linux使用Xvfb。Required unit保原完整历史、显示环境和全部默认发现。正式守卫要求三项准确命令与平台条件，关闭、错平台、echo、过滤或Linux缺显示均失败；这些定义不能替代hosted运行结果，也不能替代已发布predecessor资格。

## Win/Linux 后续 Actions 接线

下表记录当前已接的完整消费者及其验收范围。按用户最新安排，Windows/Linux 实际验证后置，Windows 由用户后续独立验证；现有 GitHub Actions 接线保留，本轮不触发，当前没有实际平台结果。正式安装／版本／维护链消费同一 release job 的准确 Terminal／Native 候选，MCP 使用独立 stdio job，避免前一安装步骤失败使该独立能力根本未执行。两者均绑定原 PR head repository／SHA、完整历史和关闭持久凭据。

| 用户入口与完整能力 | Windows 消费者 | Linux 消费者 | 原验收条件 |
| --- | --- | --- | --- |
| installed CLI/TUI／Desktop 正式安装 | [Terminal](../../tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts)、[Native](../../tests/fixtures/unified-agent/windows-native-installation.qualification.ts)、[TUI](../../tests/fixtures/unified-agent/windows-installed-tui.qualification.ts) | [Terminal](../../tests/isolated/unified-agent/terminal-bundle.test.ts)、[Native](../../tests/isolated/unified-agent/native-install-lifecycle.test.ts)／Xvfb | 原归档／源码外稳定前门、真实任务／完整结果、冷读及准确进程／双使用锁退出 |
| installed 前门真实代码升级／冷回退 | [双产品统一 caller](../../tests/fixtures/unified-agent/windows-cross-version.qualification.ts) | [Terminal](../../tests/isolated/unified-agent/terminal-cross-version.test.ts)、[Native](../../tests/isolated/unified-agent/native-cross-version.test.ts)／Xvfb | 原 builder 及真实不同候选、A→B→A→B、原 Store／完整历史、后续真实工作和零冷重放 |
| 默认 MCP Source／公共 Client 连接与工具调用 | `test:runtime:stdio` 原 Windows Job 整例及 [sealed 默认 Source](../../apps/service/test/isolated/mcp-source-packaged-default.test.ts) | 同 alias 的原 Linux namespace／SDK 整例及同 sealed 文件 | 完整工具结果、准确停止／取消、原树／宿主关闭、正常 Service 退出与冷原对象零重放；缺后端直接失败 |
| installed `maintenance` 备份／核验／恢复／状态 | 原 Terminal caller 和原 Native caller 的独立维护链 | 原 Terminal bundle 的完整安装维护分支 | backup／inspect／restore 新 Store／status、旧来源拒绝、原数据保全及恢复后读取；Native 平台专有整例仍保原适用范围 |
| installed `uninstall` 保数据退出 | 上述原 Terminal／Native／TUI／真代码 caller 的最终卸载 | 上述原 Terminal／Native 完整文件的最终卸载 | busy 拒绝、全部原 owner 退出／候选 EX后唯一卸载，外部 Core／Native DB与配置按原断言保全 |

release／Required 的 Linux 消费者显式准备 `build-essential bubblewrap xvfb`；独立 stdio、platform probe 和 transport 准备 `build-essential bubblewrap`。Windows 的 release／stdio／platform probe 保原[MSVC 准备入口](../../scripts/release/prepare-windows-native-ci.ts)，缺项直接失败。它们不关闭 Chromium／namespace sandbox，不将 macOS-only 窗口或恢复中断 fixture 宣作 Win/Linux 已运行。

transport 的共享 TUI 命令保持三平台完整文件，追加 composer／Workflow 问题／Planning，不过滤 Windows。Workflow 夹具与原 CLI 消费者已选择正式 built 默认 Service；Linux 准备与构建顺序由原 CI guard 核验。Windows 缺合格 script verifier 的门禁继续失败，不用替身、平台 skip 或局部绿色推导阶段退出；测试方法归[CLI owner](../../apps/cli/README.md#开发-tui-输入编辑)。

transport 另接Tools查看、Source修改／批准、强制重连、Auth、配置与冷配置七个完整MCP独立Bun进程，以及paired／shared Skills目录、正式Terminal导出／正文、默认三题问答、完整权限授权和Workspace文件候选。Windows MSVC准备及当前八workspace构建先于消费，这些完整调用者先于原transport／shared测试；不依赖Shell的导出／问答先于权限，原测试未移除。首DB前选择已审查候选engine的Source／重连／导出不能与已开库测试共进程；Mac原固定版本与nonMac准确builtin审查身份各保合同，manifest绑定保持。CI guard拒逐一漏文件／过滤／平台条件及合并进程。正式导出保包内Bun／TUI／Service及OS真实子进程来源，POSIX准确0600／Windows同文件原生隐私校验，不修ACL或换开发宿主；权限例保正式默认Shell与真实Reviewer。Windows Shell和POSIX文件候选后端缺项仍失败，独立能力不以缺后端为替身或资格。本机正常通过不替代fault cleanup、系统Vault／浏览器或原生平台资格；准确方法、原期限和运输资源差异归[CLI owner](../../apps/cli/README.md#tui-原生滚动与清屏)。Skills共享Windows保原SID pipe及绑定原Profile／instance的Lifecycle退出，POSIX仍保真实SIGTERM；原完整页／零效果／时限不改。RSS／完整观测与阶段完整回归仍保门禁。

transport追加普通Work中断冷查询、独立Job停止冷恢复及完整CLI library三个独立完整文件。Work在权限前取得独立资格，Job／library以封闭默认paired Service及公开trust／Full消费正式Shell，不重建Mac专用工厂；Windows缺后端以实际shell_unavailable失败。POSIX SIGKILL断言保持，Windows同丢回应屏障后caller-only原生dispatcher0、异常退出和PID gone由持有caller的父／driver核实，另持Service／同胞不得终止。它们保原申请、物理socket loss、冷原GET／零POST／另一Job无取消及30秒整例，正常本机不能代全Runtime后代清理或Win/Linux资格；当前范围归[CLI owner](../../apps/cli/README.md#tui-普通-caller-的持久原意图)。原CI guard与原transport／shared命令仍独立执行，无阶段门禁放宽。

transport另增正式paired／shared CLI argv、普通CLI与TUI有限caller port三类原请求恢复三个独立整文件，均不依赖Shell、在权限例之前。argv选择真实构建／核验Terminal的runtimeProtection／daemon／Web，原SQLite只读查询由准确候选engine独立进程执行；手工manifest已退役。原请求、prepared零POST／实际POST毁回应、冷首GET毁回应和同ID只查／零重发、完整Tool审批与原Run完成正例均保持。原30秒／全部断言不改，实际进程强制结束与正常关闭分开记录；Windows使用实际所属进程原生退出证据，不伪造SIGKILL，未知所属退出不删除身份或资产。各完整caller保持独立Bun命令和原CI guard，实际方法与失败归[CLI owner](../../apps/cli/README.md#普通-cli-caller-的持久原申请)；本机绿色及三端接线均不代Windows/Linux原生或阶段退出。

transport续接完整TUI Session／Fork／Context维护、paired／shared模型／effort和三类主机状态三个独立整文件，当前八workspace build／Windows MSVC之后、原transport／shared14之前；这些无Shell依赖链均在权限例前。原开发前门或runTUIHost和开发默认Service／raw daemon装配如实保持，状态的owned-status／Shell unavailable不可被候选默认事实替代，不把开发诊断资格包装成installed protection。三套Python驱动退役，原42个Bun静态断言、20项Python检查及40秒／步骤／6＋3秒期限保持；实际Service出生身份／正常退出、shared detach存活和原Daemon异常退出分开，unknown保身份／错误／根。CI guard逐一拒漏命令／过滤／平台条件及合并进程；准确方法与本机红绿归[CLI owner](../../apps/cli/README.md#开发-tui-模型设置)。Win/Linux实际结果、原生后端、RSS／完整观测和阶段回归门禁继续保持，本轮不dispatch。

transport另接[完整原生滚动](../../apps/cli/test/isolated/tui-scrollback-pty.test.ts)，现22个完整独立caller进程；该无Shell依赖文件在权限前，同样不加平台条件。Python／POSIX transport与Windows skip退役为共享Bun PTY／ConPTY，真实resize、原始hex／31检查点／完整问答编辑和原断言／20秒预算保持。原TSX有限UI port不改，此文件不授Service／Provider或installed资格；实际所属正常退出与强退分开，方法及原生未验范围归[CLI owner](../../apps/cli/README.md#tui-原生滚动与清屏)。原Win/Linux后端、RSS、完整观测及阶段全回归门禁保持，接线不代执行。

[日志 shell](../../scripts/ci/logged-shell.ts)保原 run 正文和 native shell 退出语义，20个 release 验证步骤及独立 stdio 的 shell／MCP 步骤各有准确 `dist/unified-evidence/*.log`。stdout／stderr 原字节同时透传控制台；日志写入、外部命令、信号或关闭失败保持非零。日志采用排他创建，artifact 用 `always()`／`if-no-files-found:error` 保存；不上传临时 Profile 内容。stdio 的 sealed 文件在自己的 fresh Bun 测试进程选择候选引擎，避免与 source 测试的进程全局 SQLite 冲突；全10文件与原断言／期限保持，详情归[测试入口](../../tests/README.md)。

整个 release job 从30分钟调整为60分钟，为构建、原Windows19分钟真代码整链和其余原安装／维护／TUI调用者留聚合时间；没有取得 hosted 超时证据，也没有放宽任何 fixture 的原期限。原 `always()` formal platform verifier、soak8外层／60—168分钟、RSS 32MiB与出生后代／activeResources／handles门禁保持。静态接线或本机局部通过不构成 G1、P6／§35／P7 或整体 V1.3 退出。

Windows Native 构建与 transport 原生后端测试在消费编译器前调用[有限 CI 准备脚本](../../scripts/release/prepare-windows-native-ci.ts)。脚本只使用 runner 已安装的固定 vswhere/VsDevCmd、明确 x64 host/target、实际 canonical `cl.exe` 和对应 SDK header/library；缺项失败，不下载或从 PATH 查编译器。vswhere 按 UTF-8、CMD `SET` 按 `/u` 的 UTF-16LE 完整解码，坏字节拒绝；只向 `GITHUB_ENV` 保存十个构建变量、编译器及清空的 `CL`/`_CL_`，不打印原环境。transport 也固定原 PR head/repository 和完整历史。静态守卫核准备顺序及完整三文件 Windows 命令，`echo` 或过滤到零案例不能代替五项 Node 后端执行。本机18项80断言证明解码与调度负例，未运行 Windows 编译；准备成功不改变正式 Main 的加载前身份拒绝或平台完成条件。

同一 release job 在完整 Native build／verify／smoke 后消费准确候选的 [Windows 安装窗口调用者](../../tests/fixtures/unified-agent/windows-native-installation.qualification.ts)：零参数稳定前门、真实页面任务、运行中版本选择、普通菜单退出、两次版本冷读，以及安装版 CLI 备份／新 Store 恢复／再次窗口冷读和保数据卸载。系统 UIAutomation 只操作已核原 Main，Job 的实际成员／原 HANDLE／FILETIME 保证退出观察，强制 Terminate 不计普通退出。CI 守卫拒绝删步骤、错平台／候选、过滤、忽略失败及先于完整制品准入运行；原 POSIX 整例和其他必需门禁保持。合成 B 只核同代码版本选择，不授真实跨代码资格；Windows 实际窗口、交互桌面／UIA、维护及资源仍待原生执行，原 RSS／完整观测门禁不被这条源码接线关闭。具体合同与预算归 [Native owner](../../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)。

## 安装、登记与使用权

Windows 同 job 另必须执行 [installed TUI 完整调用者](../../tests/fixtures/unified-agent/windows-installed-tui.qualification.ts)，准确传入两个已 build／verify／smoke 的 Terminal／Native 路径。独立前门及登记 Native 选择各沿真实 ConPTY／所选候选 TUI／Service 完成提交、完整阅读／思考、导出、精确取消、草稿、正常退出与冷读零重放；guard 保两种选择的完整顺序及禁止忽略失败。原九份 TUI 私有文件已迁入 current-SID 原生记录端口，验证期和发布期 Close 未确认保原 Profile／数据锁，格式／codec／容量不变。源码、本机 POSIX／mock 与 CI 守卫不代原生资格；Windows/Linux 实际验证按用户最新安排后置，Windows 由用户后续独立验证；现有 Actions 接线保留，无本轮 dispatch。完整合同归 [Terminal owner](../../apps/cli/docs/terminal-release.md#windows-installed-tui-正式调用者)，RSS／观测、Shell 原合同、跨代码和阶段门禁保持。

Windows managed Terminal 新实现先以 [MSVC 准备](../../scripts/release/prepare-windows-native-ci.ts) 构建原生前门及独立 verifier，再固定候选 Bun 的新 PE 副本，原 Bun 不修改。release candidate 把准备放在 Terminal build 前，并接显式 [Windows qualification](../../tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts) 的准确绝对候选参数；[守卫](../../scripts/check-unified-workspaces.ts)核顺序、Windows predicate、完整消费与禁止静默失败。该工具覆盖安装/实际 paired Run/指针切换/冷读/保数据卸载，另要求同一正式 `kite.exe` 在真实 Run 时维护 busy、退出后的 backup/inspect/status/restore/status/GC 和新 Store 完整原历史冷读零重放。GC只核引用/近期保留与旧 Store 拒绝，过宽限原对象删除另归维护 owner 的原生用例；标签 B 与 TUI help 不替代跨代码或 PTY。现有 common whole、Native 和 always formal verifier 保持，Windows 原 POSIX fixture 合同及 Native 未资格仍可能实际失败，不排除或削弱它们。原生执行按用户最新安排后置，Windows 由用户后续独立验证；现有 Actions 接线保留，未 dispatch；完整源码与待验范围归 [Terminal owner](../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现)。

同一Windows工具现还必须调用[installed Daemon整链](../../tests/fixtures/unified-agent/windows-daemon-qualification.ts)，原120秒/30秒预算保持：真实当前SID pipe/原记录/进程birth，B运行中rollbackA只改变后续选择，原B reuse/SH，完整共享Model、client仅detach、busy拒绝与明确cancel后原HANDLE实际dead，新A原完整历史零重放、正常stop及全EX/保数据卸载。有限FFI mock和本机POSIX回归不代Windows原生结果；Native加载前guard、Shell/MCP/PTY、跨代码、RSS/完整观测与阶段强制门禁继续保留。

明确 archive/prefix、managed marker、独立安装 EX、不可变 releases 和两行 active/current/previous 约束保持。prefix 不能是根目录、用户 home、repo root、symlink/reparse 或未标记的内容。物化与指针发布经完整校验和各平台实际发布屏障；POSIX 使用 fsync/rename，Windows 使用原私有 HANDLE/Flush 和同卷 write-through。不原地覆盖已存在候选，不替换用户 Profile 或数据。POSIX 的四个 Node/Bun/Electron 注入环境键在固定入口清除；Windows 原生前门另在 Bun 初始化前清除 BUN_BE_BUN。

每个运行者持准确原 candidate SH，Service/daemon 独立保活。完整 Native 的私有保护只允许已核 inner 清单中的 service/daemon 两种服务入口，并核同一 Native build、outer digest 和包内 Bun；不从 CLI、Electron 或任意邻接入口推造服务身份。Node Native Main 同时持 outer/inner；POSIX 继承 helper 仅关闭副本，Windows 源码使用独立原生准入和自身 LockFileEx。清理失败保原事实/lease。更新只影响后续启动，回滚只交换代码指针。卸载完整枚举管理树并持所有候选 EX；任何 live lease 都 busy，不猜 PID 或强杀。未知条目、坏 active、坏候选和损坏登记均拒绝。

Native 卸载在安装 EX 内先核封闭结构和两层真实目录，再取得所有候选双 root EX；busy 在完整内容读取前拒绝。所有 EX 持有后完整核原候选 bytes/digest，删除前复核原 active/previous 和候选集合，漂移拒绝；空闲损坏仍拒绝，部分租约沿 finally 释放。该顺序只处理遵守安装锁及使用锁的合作进程，不增加对绕过锁的同用户写入保证。

Native 可显式向合法独立 Terminal prefix 注册完整 CLI/TUI 闭包。双方闭合 nonce/active 与完整物理树复核，POSIX standard 前门实际 spawn Native 内 Bun/CLI/TUI/Service；Windows source 转交 Native C 前门，并以内部 expected candidate 拒绝登记读取与实际准入之间的版本漂移。升级/回滚只更新原持有者登记，卸载以原 nonce CAS 撤销。独立前门恢复 Terminal；已缓存且删除的 Native-bin 路径需要父 shell 的 hash刷新/新 shell。详见[Terminal owner](../../apps/cli/docs/terminal-release.md)与[Native owner](../../apps/desktop/docs/native-release.md)。

Windows managed Native 安装／切换／撤销源码现已接入同一正式 release caller：closed v2 marker 绑定四个稳定 `bin/*.exe`，active 只选择完整不可变候选。C 前门在 Bun 初始化前清除五个注入键，compiled verifier 持原 C 创建证书、outer／inner 全部原文件与自身双 SH，再创建 Electron；Main 在窗口／Profile／SQLite／Service 之前独立核两跳实际创建证书、原进程 FILETIME／完整 bytes 与自身双 SH。PPID 和后置摘要均不单独授予加载权。完整归档采用私有原 HANDLE copy／Flush／write-through，卸载以全部 candidate 双 EX 与完整 original DELETE owner 删除管理树，Profile 留在外部；登记关闭未知保同次调用全部 prefix EX。真实 MSVC／Electron PE、实际窗口、维护恢复和 Win/Linux 完整资格仍待重构后验收，原严格 DLL import／delay-load 拒绝与缺 handoff 的 Main guard 保持，准确范围归[Native owner](../../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)。

正常卸载独立 Terminal 不阻止 Native 自带入口及后续升级。隐式历史登记目标已不存在时，升级仅锁 Native，并保留历史反向登记；不重建前门或自动重新登记。显式目标与仍存在的隐式目标保持原完整验证、双 prefix 锁和 nonce CAS。

Native 回退在双 prefix EX 内固定仍由原 nonce 持有的既存 Terminal，完整预检先于 active 发布，随后只更新该固定目标。已知损坏拒绝且 active／双方登记原字节保持；目标缺失时独立回退、其他 Native 归属及登记最终复核保持。该顺序只封闭发布前可发现的损坏，不提供跨 prefix 崩溃原子性；实际实现与有限反例归[Native owner](../../apps/desktop/docs/native-release.md#标准命令登记与卸载恢复)。

正式 CLI／Native 离线维护使用同一调用内资源 owner；SQLite strict-close 或原句柄关闭未确认时保留原资源、Profile EX 与相关临时目录至实际宿主退出。正常关闭才允许清理和交出维护权，错误返回不充当关闭证明。恢复 journal、新 Store及来源 fencing保持；维护owner和平台验收边界见[维护合同](../../packages/agent/src/maintenance/README.md)。

Terminal 已有本机真实跨代码版本冷回退资格：固定新基线旧提交由其原 builder 构建，与当前代码保持相同依赖输入及 format=1 SQL 基线；经源码外安装前门 A→B→A→B 四个冷实例核原 Store、原任务身份、B 新完整正文和后续真实工作。回退仅交换候选指针，数据库未恢复；正常 stop 核准确进程退出和所有候选 EX，卸载保独立 Profile。完整测试与范围由[Terminal owner](../../apps/cli/docs/terminal-release.md#验证边界)维护；本地代码比较不等于已发布 predecessor、Native 或三平台资格。Required 默认测试 checkout 保完整历史，以读取固定真实旧提交，缺旧对象直接失败。

Native 的本机真实跨代码组合也已沿 installed `bin/kite-desktop` 核对：旧源码使用自己的两层builder，当前macOS固定复用PC展示层后的DB7原提交a2b6441f，并核11项输入：8项raw byteequal，根清单只接受已提交stdio CI脚本的准确单行增量，Agent清单只接受已知process-observation export／build source-entry准确增量，Service清单只接受已知windows-native-bootstrap export／build source-entry准确增量；各分支核唯一锚点构造后的完整字节并记双方SHA与独立match，其余字段变化仍拒绝。Main／renderer／inner实际字节差异保持。历史Linux1b796组合核真实Agent变化，当时renderer相同；其证据只适用于当时源码和锁输入，当前a2b6441f的Linux组合留到重构后Actions验证。四次正式入口窗口和配对Service普通退出，当前B明确装配测试reference host；原数据、完整正文/hash/ref、持久caller及回退后的新工作保持正确。指针操作保Core/Native私有数据库inode/bytes和配置，不恢复数据；运行中的旧窗口保持原闭包。准确资格及限制归[Native owner](../../apps/desktop/docs/native-release.md#真实代码升级与冷回退)与[Terminal owner](../../apps/cli/docs/terminal-release.md#验证边界)。本机macOS与历史Docker VM原生arm64 Linux两项本地代码比较各有其准确版本范围，均不替代已发布predecessor/T029、任意版本或其他平台的实际证据。

## SQLite 与可选能力

macOS 完整 Native 的安装版离线维护已沿实际 Native 自带／登记后的 `bin/kite` 验证 DB8／manifest v17 的 backup、inspect、真实宽限 GC、restore 和 status；过期 GC 单独使用安装包公开 Host 选择器与外部夹具时钟，未更改生产时钟或存储时间。原目录保字节／inode，恢复产生新 Store并拒绝旧身份，维护零 Provider 增量；实际卸载保独立数据。范围归[Native owner](../../apps/desktop/docs/native-release.md#macos-安装版离线维护)，原五动作不代证全平台资格；同一维护前门现另核当前DB9／v18 backup／inspect，以及目录缺失时明确rollback→Native原Store读取→实际退出→原complete腿，准确消费者范围归同一owner。DB9运行回退另由下述真实代码组合核对。

新基线前版样本遵循 V1.3 D08。2026-10-08 只读核对原仓库 Releases：四份记录中三份为 draft，唯一公开预发布为 [v0.1.0-alpha-2](https://github.com/ferqx/kite-code/releases/tag/v0.1.0-alpha-2)，发布于 2026-08-20；其远端 tag 与本地原对象一致，commit `20e83747c4c7d1f992dc96af0360266193498c7f` 仍是旧 `src/index.ts` 产品。当前没有已发布的新基线前版，T029 在首发前没有适用样本；不为满足该项迁移、读取或执行旧 Store/State。新基线发布后持续向后兼容的要求保持，本地真实代码候选仍不能冒充已发布样本。当前 macOS 已沿真实DB8原申请捕获、正式扩展唯一动作产生DB9和包内v18备份，切回不识别DB9的原DB7 a2b6441f候选：旧Native私有操作明确拒绝，兼容Core三条原历史仍完整只读，原DB9 bytes／inode／配置保留；切回当前候选才明确GET原移除与扩展Command、完整Execution／finding／reference，零新增POST或模型调用。此前DB8拒绝证据只保其原冻结范围。六个 Service 普通退出和最终卸载保数据已核，范围归[Native owner](../../apps/desktop/docs/native-release.md#真实代码升级与冷回退)。它不提供任意版本的写入兼容或自动数据降级许可。

Terminal 保存实际 `bun:sqlite` driver/linkage/version/sourceId/engine manifest SHA，Native 保存独立 `node:sqlite` 身份。构建测量复制后 runtime，正式启动在首次数据库前选择并核包内 metadata，Worker 核同一 process-global 引擎。完全无选定资产的开发模式 unqualified；损坏/不完整资产拒绝，不查系统库 fallback。

WAL qualification 以官方已知修复/确证 backport、实际 sourceId 与多连接 WAL/备份恢复为依据，不以“最新”或永久 minimum 放行。当前已审查来源为 [SQLite3.51.3](https://www.sqlite.org/releaselog/3_51_3.html)、[SQLite3.53.2](https://sqlite.org/releaselog/3_53_2.html)与[SQLite3.53.4](https://www.sqlite.org/releaselog/3_53_4.html)；精确集合由[release identity](../../apps/service/src/sqlite-release-assets.ts)负责。macOS 构建复制已安装且审查的动态库，Linux/Windows 核 Bun builtin；任一实际引擎不符合集合即拒绝资格。

默认 macOS Shell 已接入宿主 Seatbelt/launchd coalition，真实默认 candidate 保存原 Job 输出/全树停止并可 cold 读取零重放。它不授予跨平台生产 sandbox 或完整资源/release 资格；Files runtimeAssets 保护、原权限/read-set 与不盲重放仍强制。Win/Linux 原生验证按用户最新安排后置，Windows 由用户后续独立验证；现有 Actions 接线保留，当前不从 macOS 扩大支持集合。通用 OS keyring smoke 保 CI 双 gate/实际随机 namespace；Native 本机资格只使用本任务临时 Profile 的准确独立 account，保存后准确 revoke/remove，再由 fresh backend 核 absence。MCP 外联网只在明确 live gate 开启时执行；自有 loopback 范围归 [Native owner](../../apps/desktop/README.md#native-mcp-完整设置)。

Windows release job另接[完整真实代码调用者](../../tests/fixtures/unified-agent/windows-cross-version.qualification.ts)，复用该job准确Terminal／Native和原837a2b8c前驱的两份原builder；11项锁输入中10项逐字相同，根清单只接受已提交 stdio CI 脚本的准确单行增量并保存原/当前 SHA，Core基线相同，实际Agent字节／candidate与clean来源独立核，不以版本标签推导兼容。原同代码、Native维护和TUI caller均保留，新步骤位于其后；整个release job现为60分钟／always formal与完整准入保持，所有原fixture期限保持，统一1140000ms绝对期限包括物化、Terminal三任务／冷读、Native四基础窗口／三任务和installed新Store恢复后第五窗口／单次卸载。前驱已支持DB9，不计DB9拒旧／已发布样本／T029；本机源码和读取证据不授Windows或Linux原生资格。实际入口、预算和来源归[Terminal owner](../../apps/cli/docs/terminal-release.md#windows-真实代码升级与冷回退调用者)，平台验收按用户最新安排后置，Windows 由用户后续独立验证；现有Actions接线保留，当前未dispatch。

## 平台与完成约束

G0 需要当前产品正确性、安全、安装/取消/恢复的实际证据；G1 仍要求 GitHub-hosted macOS、Ubuntu、Windows 原生 build/install/process/PTY。workflow 定义、artifact 上传或本机单平台结果不能替代三平台通过。当前 POSIX 安装/继承使用锁保原本机 macOS 资格，Linux 当前 Terminal 安装维护链已取得 Ubuntu x64 用户空间在 Apple Silicon Docker VM 仿真的有限实测；准确范围归 [Terminal owner](../../apps/cli/docs/terminal-release.md#linux-当前引擎与安装维护链)，原生 Ubuntu CI 仍未验。Linux arm64 的完整 Native 安装文件也已在 Docker VM 原生 CPU/Xvfb 下实测，保 Chromium sandbox、两层 lease 和原预算；有限范围归[Native owner](../../apps/desktop/docs/native-release.md#linux-arm64-安装生命周期)，不替代原生 Ubuntu x64 CI 或全部 Native/维护资格。Windows Profile/Store/配置原生场景已实现但未本机运行；维护 Bun x64 文件端口已接入原 API 和开发 CLI，实际 DACL/HANDLE、媒体、journal 与恢复原生验收尚未取得，Windows managed Terminal／Native 安装、切换及 Main 加载前实际创建／原文件准入源码现已接入，但原生资格未验；标准 PATH 不由安装器修改，Daemon、Native、PTY、GC 和完整安装版维护仍需各自实际平台证据。准确范围归[maintenance owner](../../packages/agent/src/maintenance/README.md#windows-维护文件端口与验收边界)。

平台 workflow 的源码外 Files/资产/SQLite/锁及 macOS 默认 Shell 诊断只证明报告范围；formal verifier 仍拒完整 effectful platform 缺资格。正式 soak 保固定8外层/≥60分钟/168分钟上界、混合场景、资源观测与后代身份要求；单次 macOS 450秒默认 continuous 组件不能代替整体资格。V1.3 D17 退役旧隐式累计预算，实际显式并发、取消和输出策略场景不重建旧资金账本。runner 保闭合 v2 七类 CI；当前 continuous 的实际默认 producer/时长证据与剩余资源条件归[韧性 owner](runtime-resilience-qualification.md)。失败及未知清理保原证据。

旧 KASD [三平台 run33659494358](https://github.com/ferqx/kite-code/actions/runs/33659494358)只绑定其历史 implementation head，不证明新八 workspace。旧来源/字段不再用于当前发行。依赖补丁仍由 manifest/lock固定，不能绕过安装补丁。完整 V1.3 的37能力、T001—T114/E01—E14及§35仍由[计划](../plans/unified-agent-refactor-v1.md)与实际能力映射核对，状态保持 implementing。
