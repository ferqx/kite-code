# 开源候选版本控制

状态：active

读取时机：修改新 Terminal/Native manifest、构建、安装注册、SQLite selection、三平台 workflow、rollback 或发布状态时。

验证：`bun run check:runtime-packages`、`bun run check:unified-agent-boundary`、`bun test tests/integration/scripts/unified-ci.test.ts tests/isolated/unified-agent/release-tools.test.ts`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:docs`、`bun run check:docs-impact`。具体平台范围见[实施证据](../plans/unified-agent-refactor-v1-progress.md)。

## 当前发行与源身份

根 workspaces 精确为 AI、Agent、Client、UI、Service、CLI、Desktop、Web。正式 CLI/TUI 固定完整 Terminal，Desktop 固定完整 Native；独立 source/development 显式入口不发现旧发布包或旧用户数据。业务通过唯一 HTTP/SSE Client；私有 bootstrap/发现只负责配套进程，不是第二业务 carrier。

完整候选只物化生成 exports 真正需要的解析边。当前唯一内联的核心图标依赖归[UI build owner](../../packages/ui/README.md#原桌面展示层)：其他 external／peer、原 exports／CSS与准确许可保持，builder拒绝残留该包的外部引用。复制器不能以内联声明跳过 peer、optional或workspace；新闭包的全部文件仍纳入原manifest和每次独立完整校验。此构建收束不改变三次准入、双使用锁或平台完成约束。

`release:build` / `verify` / `smoke` / `install` 使用[新工具](../../scripts/release/unified.ts)。默认 product 为 terminal，Native 明确 `--product native`。两种制品分别有完整 manifest/文件哈希，Native 包含完整 Terminal 和实际 Electron。archive SHA 绑定压缩字节，candidate ID 绑定 manifest；未签名 checksum 不证明发布者身份、provenance、公证或 attestation。 可信Native MCP测试候选仅由builder固定`native-mcp-loopback`选项在构建前写入专用ProcessHost和可选公开证书，所有字节纳入同一inventory/digest；普通生产main/daemon未选择该选项。其loopback/TLS测试网络必须声明productionDefaultNetwork=false，不能将默认browser/backend/permissions装配或局部窗口通过冒称完整生产/平台资格。

候选 workflow 显式 checkout PR head repository/head SHA，只读权限、关闭持久凭据，verify 传 `--source-commit <实际head> --clean-source true`。第三方 actions 固定40位 commit，Bun 固定1.4.2。工作树 dirty、源提交不符或实际文件/链接/目录/引擎变化拒绝，不把 merge ref、版本文字或旧三平台记录作为当前候选身份。

release candidate 在 macOS 与 Linux 运行原[完整 installed Terminal 测试](../../tests/isolated/unified-agent/terminal-bundle.test.ts)，包含实际 CLI/TUI、升级/回滚、lease 与卸载保数据；Linux 分支继续核 selected 引擎、双 Worker WAL 和实际安装 maintenance。正式消费者守卫要求双方平台及准确完整命令，拒绝 Mac-only、echo 与过滤到零案例。workflow 接入不表示该原生平台已执行通过。

真实代码比较另调用完整[Terminal文件](../../tests/isolated/unified-agent/terminal-cross-version.test.ts)，条件覆盖macOS/Linux；完整[Native文件](../../tests/isolated/unified-agent/native-cross-version.test.ts)分别在macOS和Linux执行，Linux使用Xvfb。Required unit保原完整历史、显示环境和全部默认发现。正式守卫要求三项准确命令与平台条件，关闭、错平台、echo、过滤或Linux缺显示均失败；这些定义不能替代hosted运行结果，也不能替代已发布predecessor资格。

Windows Native 构建与 transport 原生后端测试在消费编译器前调用[有限 CI 准备脚本](../../scripts/release/prepare-windows-native-ci.ts)。脚本只使用 runner 已安装的固定 vswhere/VsDevCmd、明确 x64 host/target、实际 canonical `cl.exe` 和对应 SDK header/library；缺项失败，不下载或从 PATH 查编译器。vswhere 按 UTF-8、CMD `SET` 按 `/u` 的 UTF-16LE 完整解码，坏字节拒绝；只向 `GITHUB_ENV` 保存十个构建变量、编译器及清空的 `CL`/`_CL_`，不打印原环境。transport 也固定原 PR head/repository 和完整历史。静态守卫核准备顺序及完整三文件 Windows 命令，`echo` 或过滤到零案例不能代替五项 Node 后端执行。本机18项80断言证明解码与调度负例，未运行 Windows 编译；准备成功不改变正式 Main 的加载前身份拒绝或平台完成条件。

## 安装、登记与使用权

Windows managed Terminal 新实现先以 [MSVC 准备](../../scripts/release/prepare-windows-native-ci.ts) 构建原生前门及独立 verifier，再固定候选 Bun 的新 PE 副本，原 Bun 不修改。release candidate 把准备放在 Terminal build 前，并接显式 [Windows qualification](../../tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts) 的准确绝对候选参数；[守卫](../../scripts/check-unified-workspaces.ts)核顺序、Windows predicate、完整消费与禁止静默失败。该工具覆盖安装/实际 paired Run/指针切换/冷读/保数据卸载，另要求同一正式 `kite.exe` 在真实 Run 时维护 busy、退出后的 backup/inspect/status/restore/status/GC 和新 Store 完整原历史冷读零重放。GC只核引用/近期保留与旧 Store 拒绝，过宽限原对象删除另归维护 owner 的原生用例；标签 B 与 TUI help 不替代跨代码或 PTY。现有 common whole、Native 和 always formal verifier 保持，Windows 原 POSIX fixture 合同及 Native 未资格仍可能实际失败，不排除或削弱它们。原生执行按用户顺序留重构后 Actions，未 dispatch；完整源码与待验范围归 [Terminal owner](../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现)。

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

Native 的本机真实跨代码组合也已沿 installed `bin/kite-desktop` 核对：旧源码使用自己的两层builder，当前macOS固定复用PC展示层后的DB7原提交a2b6441f，并核11项输入：10项raw byteequal，Agent清单只接受已知process-observation export／build source-entry准确增量并记双方SHA，其余字段变化仍拒绝；Main／renderer／inner实际字节差异保持。历史Linux1b796组合核真实Agent变化，当时renderer相同；其证据只适用于当时源码和锁输入，当前a2b6441f的Linux组合留到重构后Actions验证。四次正式入口窗口和配对Service普通退出，当前B明确装配测试reference host；原数据、完整正文/hash/ref、持久caller及回退后的新工作保持正确。指针操作保Core/Native私有数据库inode/bytes和配置，不恢复数据；运行中的旧窗口保持原闭包。准确资格及限制归[Native owner](../../apps/desktop/docs/native-release.md#真实代码升级与冷回退)与[Terminal owner](../../apps/cli/docs/terminal-release.md#验证边界)。本机macOS与历史Docker VM原生arm64 Linux两项本地代码比较各有其准确版本范围，均不替代已发布predecessor/T029、任意版本或其他平台的实际证据。

## SQLite 与可选能力

macOS 完整 Native 的安装版离线维护已沿实际 Native 自带／登记后的 `bin/kite` 验证 DB8／manifest v17 的 backup、inspect、真实宽限 GC、restore 和 status；过期 GC 单独使用安装包公开 Host 选择器与外部夹具时钟，未更改生产时钟或存储时间。原目录保字节／inode，恢复产生新 Store并拒绝旧身份，维护零 Provider 增量；实际卸载保独立数据。范围归[Native owner](../../apps/desktop/docs/native-release.md#macos-安装版离线维护)，原五动作不代证全平台资格；同一维护前门现另核当前DB9／v18 backup／inspect，以及目录缺失时明确rollback→Native原Store读取→实际退出→原complete腿，准确消费者范围归同一owner。DB9运行回退另由下述真实代码组合核对。

新基线前版样本遵循 V1.3 D08。2026-10-08 只读核对原仓库 Releases：四份记录中三份为 draft，唯一公开预发布为 [v0.1.0-alpha-2](https://github.com/ferqx/kite-code/releases/tag/v0.1.0-alpha-2)，发布于 2026-08-20；其远端 tag 与本地原对象一致，commit `20e83747c4c7d1f992dc96af0360266193498c7f` 仍是旧 `src/index.ts` 产品。当前没有已发布的新基线前版，T029 在首发前没有适用样本；不为满足该项迁移、读取或执行旧 Store/State。新基线发布后持续向后兼容的要求保持，本地真实代码候选仍不能冒充已发布样本。当前 macOS 已沿真实DB8原申请捕获、正式扩展唯一动作产生DB9和包内v18备份，切回不识别DB9的原DB7 a2b6441f候选：旧Native私有操作明确拒绝，兼容Core三条原历史仍完整只读，原DB9 bytes／inode／配置保留；切回当前候选才明确GET原移除与扩展Command、完整Execution／finding／reference，零新增POST或模型调用。此前DB8拒绝证据只保其原冻结范围。六个 Service 普通退出和最终卸载保数据已核，范围归[Native owner](../../apps/desktop/docs/native-release.md#真实代码升级与冷回退)。它不提供任意版本的写入兼容或自动数据降级许可。

Terminal 保存实际 `bun:sqlite` driver/linkage/version/sourceId/engine manifest SHA，Native 保存独立 `node:sqlite` 身份。构建测量复制后 runtime，正式启动在首次数据库前选择并核包内 metadata，Worker 核同一 process-global 引擎。完全无选定资产的开发模式 unqualified；损坏/不完整资产拒绝，不查系统库 fallback。

WAL qualification 以官方已知修复/确证 backport、实际 sourceId 与多连接 WAL/备份恢复为依据，不以“最新”或永久 minimum 放行。当前已审查来源为 [SQLite3.51.3](https://www.sqlite.org/releaselog/3_51_3.html)、[SQLite3.53.2](https://sqlite.org/releaselog/3_53_2.html)与[SQLite3.53.4](https://www.sqlite.org/releaselog/3_53_4.html)；精确集合由[release identity](../../apps/service/src/sqlite-release-assets.ts)负责。macOS 构建复制已安装且审查的动态库，Linux/Windows 核 Bun builtin；任一实际引擎不符合集合即拒绝资格。

默认 macOS Shell 已接入宿主 Seatbelt/launchd coalition，真实默认 candidate 保存原 Job 输出/全树停止并可 cold 读取零重放。它不授予跨平台生产 sandbox 或完整资源/release 资格；Files runtimeAssets 保护、原权限/read-set 与不盲重放仍强制。Win/Linux 原生验证依用户选择在重构完成后由 GitHub Actions 执行，当前不从 macOS 扩大支持集合。通用 OS keyring smoke 保 CI 双 gate/实际随机 namespace；Native 本机资格只使用本任务临时 Profile 的准确独立 account，保存后准确 revoke/remove，再由 fresh backend 核 absence。MCP 外联网只在明确 live gate 开启时执行；自有 loopback 范围归 [Native owner](../../apps/desktop/README.md#native-mcp-完整设置)。

## 平台与完成约束

G0 需要当前产品正确性、安全、安装/取消/恢复的实际证据；G1 仍要求 GitHub-hosted macOS、Ubuntu、Windows 原生 build/install/process/PTY。workflow 定义、artifact 上传或本机单平台结果不能替代三平台通过。当前 POSIX 安装/继承使用锁保原本机 macOS 资格，Linux 当前 Terminal 安装维护链已取得 Ubuntu x64 用户空间在 Apple Silicon Docker VM 仿真的有限实测；准确范围归 [Terminal owner](../../apps/cli/docs/terminal-release.md#linux-当前引擎与安装维护链)，原生 Ubuntu CI 仍未验。Linux arm64 的完整 Native 安装文件也已在 Docker VM 原生 CPU/Xvfb 下实测，保 Chromium sandbox、两层 lease 和原预算；有限范围归[Native owner](../../apps/desktop/docs/native-release.md#linux-arm64-安装生命周期)，不替代原生 Ubuntu x64 CI 或全部 Native/维护资格。Windows Profile/Store/配置原生场景已实现但未本机运行；维护 Bun x64 文件端口已接入原 API 和开发 CLI，实际 DACL/HANDLE、媒体、journal 与恢复原生验收尚未取得，Windows managed Terminal／Native 安装、切换及 Main 加载前实际创建／原文件准入源码现已接入，但原生资格未验；标准 PATH 不由安装器修改，Daemon、Native、PTY、GC 和完整安装版维护仍需各自实际平台证据。准确范围归[maintenance owner](../../packages/agent/src/maintenance/README.md#windows-维护文件端口与验收边界)。

平台 workflow 的源码外 Files/资产/SQLite/锁及 macOS 默认 Shell 诊断只证明报告范围；formal verifier 仍拒完整 effectful platform 缺资格。正式 soak 保固定8外层/≥60分钟/168分钟上界、混合场景、资源观测与后代身份要求；单次 macOS 450秒默认 continuous 组件不能代替整体资格。V1.3 D17 退役旧隐式累计预算，实际显式并发、取消和输出策略场景不重建旧资金账本。runner 保闭合 v2 七类 CI；当前 continuous 的实际默认 producer/时长证据与剩余资源条件归[韧性 owner](runtime-resilience-qualification.md)。失败及未知清理保原证据。

旧 KASD [三平台 run33659494358](https://github.com/ferqx/kite-code/actions/runs/33659494358)只绑定其历史 implementation head，不证明新八 workspace。旧来源/字段不再用于当前发行。依赖补丁仍由 manifest/lock固定，不能绕过安装补丁。完整 V1.3 的37能力、T001—T114/E01—E14及§35仍由[计划](../plans/unified-agent-refactor-v1.md)与实际能力映射核对，状态保持 implementing。
