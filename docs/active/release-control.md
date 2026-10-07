# 开源候选版本控制

状态：active

读取时机：修改新 Terminal/Native manifest、构建、安装注册、SQLite selection、三平台 workflow、rollback 或发布状态时。

验证：`bun run check:runtime-packages`、`bun run check:unified-agent-boundary`、`bun test tests/integration/scripts/unified-ci.test.ts tests/isolated/unified-agent/release-tools.test.ts`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:docs`、`bun run check:docs-impact`。具体平台范围见[实施证据](../plans/unified-agent-refactor-v1-progress.md)。

## 当前发行与源身份

根 workspaces 精确为 AI、Agent、Client、UI、Service、CLI、Desktop、Web。正式 CLI/TUI 固定完整 Terminal，Desktop 固定完整 Native；独立 source/development 显式入口不发现旧发布包或旧用户数据。业务通过唯一 HTTP/SSE Client；私有 bootstrap/发现只负责配套进程，不是第二业务 carrier。

`release:build` / `verify` / `smoke` / `install` 使用[新工具](../../scripts/release/unified.ts)。默认 product 为 terminal，Native 明确 `--product native`。两种制品分别有完整 manifest/文件哈希，Native 包含完整 Terminal 和实际 Electron。archive SHA 绑定压缩字节，candidate ID 绑定 manifest；未签名 checksum 不证明发布者身份、provenance、公证或 attestation。 可信Native MCP测试候选仅由builder固定`native-mcp-loopback`选项在构建前写入专用ProcessHost和可选公开证书，所有字节纳入同一inventory/digest；普通生产main/daemon未选择该选项。其loopback/TLS测试网络必须声明productionDefaultNetwork=false，不能将默认browser/backend/permissions装配或局部窗口通过冒称完整生产/平台资格。

候选 workflow 显式 checkout PR head repository/head SHA，只读权限、关闭持久凭据，verify 传 `--source-commit <实际head> --clean-source true`。第三方 actions 固定40位 commit，Bun 固定1.4.2。工作树 dirty、源提交不符或实际文件/链接/目录/引擎变化拒绝，不把 merge ref、版本文字或旧三平台记录作为当前候选身份。

Windows Native 构建与 transport 原生后端测试在消费编译器前调用[有限 CI 准备脚本](../../scripts/release/prepare-windows-native-ci.ts)。脚本只使用 runner 已安装的固定 vswhere/VsDevCmd、明确 x64 host/target、实际 canonical `cl.exe` 和对应 SDK header/library；缺项失败，不下载或从 PATH 查编译器。vswhere 按 UTF-8、CMD `SET` 按 `/u` 的 UTF-16LE 完整解码，坏字节拒绝；只向 `GITHUB_ENV` 保存十个构建变量、编译器及清空的 `CL`/`_CL_`，不打印原环境。transport 也固定原 PR head/repository 和完整历史。静态守卫核准备顺序及完整三文件 Windows 命令，`echo` 或过滤到零案例不能代替五项 Node 后端执行。本机18项80断言证明解码与调度负例，未运行 Windows 编译；准备成功不改变正式 Main 的加载前身份拒绝或平台完成条件。

## 安装、登记与使用权

明确 archive/prefix、managed marker、独立安装 EX、不可变 releases 和两行 active/current/previous 约束保持。prefix 不能是根目录、用户 home、repo root、symlink/reparse 或未标记的内容。物化与指针发布经完整校验、fsync/rename；不原地覆盖已存在候选，不替换用户 Profile 或数据。四个 Node/Bun/Electron 注入环境键在固定入口清除。

每个运行者持准确原 candidate SH，Service/daemon 独立保活。完整 Native 的私有保护只允许已核 inner 清单中的 service/daemon 两种服务入口，并核同一 Native build、outer digest 和包内 Bun；不从 CLI、Electron 或任意邻接入口推造服务身份。Node Native Main 同时持 outer/inner，继承 helper 仅关闭副本；清理失败保原事实/lease。更新只影响后续启动，回滚只交换代码指针。卸载完整枚举管理树并持所有候选 EX；任何 live lease 都 busy，不猜 PID 或强杀。未知条目、坏 active、坏候选和损坏登记均拒绝。

Native 卸载在安装 EX 内先核封闭结构和两层真实目录，再取得所有候选双 root EX；busy 在完整内容读取前拒绝。所有 EX 持有后完整核原候选 bytes/digest，删除前复核原 active/previous 和候选集合，漂移拒绝；空闲损坏仍拒绝，部分租约沿 finally 释放。该顺序只处理遵守安装锁及使用锁的合作进程，不增加对绕过锁的同用户写入保证。

Native 可显式向合法独立 Terminal prefix 注册完整 CLI/TUI 闭包。双方闭合 nonce/active 与完整物理树复核，standard 前门实际 spawn Native 内 Bun/CLI/TUI/Service；升级/回滚只更新原持有者登记，卸载以原 nonce CAS 撤销。独立前门恢复 Terminal；已缓存且删除的 Native-bin 路径需要父 shell 的 hash刷新/新 shell。详见[Terminal owner](../../apps/cli/docs/terminal-release.md)与[Native owner](../../apps/desktop/docs/native-release.md)。

Terminal 已有本机真实跨代码版本冷回退资格：固定新基线旧提交由其原 builder 构建，与当前代码保持相同依赖输入及 format=1 SQL 基线；经源码外安装前门 A→B→A→B 四个冷实例核原 Store、原任务身份、B 新完整正文和后续真实工作。回退仅交换候选指针，数据库未恢复；正常 stop 核准确进程退出和所有候选 EX，卸载保独立 Profile。完整测试与范围由[Terminal owner](../../apps/cli/docs/terminal-release.md#验证边界)维护；本地代码比较不等于已发布 predecessor、Native 或三平台资格。Required 默认测试 checkout 保完整历史，以读取固定真实旧提交，缺旧对象直接失败。

## SQLite 与可选能力

Terminal 保存实际 `bun:sqlite` driver/linkage/version/sourceId/engine manifest SHA，Native 保存独立 `node:sqlite` 身份。构建测量复制后 runtime，正式启动在首次数据库前选择并核包内 metadata，Worker 核同一 process-global 引擎。完全无选定资产的开发模式 unqualified；损坏/不完整资产拒绝，不查系统库 fallback。

WAL qualification 以官方已知修复/确证 backport、实际 sourceId 与多连接 WAL/备份恢复为依据，不以“最新”或永久 minimum 放行。当前已审查来源为 [SQLite3.51.3](https://www.sqlite.org/releaselog/3_51_3.html)与[SQLite3.53.4](https://www.sqlite.org/releaselog/3_53_4.html)；精确集合由[release identity](../../apps/service/src/sqlite-release-assets.ts)负责。macOS 构建复制已安装且审查的动态库，Linux/Windows 核 Bun builtin；任一实际引擎不符合集合即拒绝资格。

默认生产 Shell 当前 `shell_unavailable`，无 Provider/Job；可信进程组监督与 macOS confined 样本不冒称跨平台生产 sandbox。Files runtime assets 保护、原权限/read-set 和不盲重放仍强制。通用OS keyring平台smoke保CI双gate和实际随机namespace；Native本机资格只使用自有临时Profile派生的准确独立account，保存后准确revoke/remove，再由fresh backend核absence，不读取或清理其他用户账户。实际MCP外部联网仍只在明确live gate开启时执行；自有loopback测试资格与限制归[Native owner](../../apps/desktop/README.md#native-mcp-完整设置)。

## 平台与完成约束

G0 需要当前产品正确性、安全、安装/取消/恢复的实际证据；G1 仍要求 GitHub-hosted macOS、Ubuntu、Windows 原生 build/install/process/PTY。workflow 定义、artifact 上传或本机单平台结果不能替代三平台通过。当前 POSIX安装/继承使用锁只有本机macOS资格，Windows Profile/Store/配置原生场景已实现但未本机运行，Windows制品安装/maintenance仍有未实现边界。

平台 workflow 的当前源码外 Files/资产/SQLite/锁诊断通过，只证明报告所列范围；formal verifier 仍拒绝完整默认 effectful platform 缺资格。正式 soak 保固定8外层/≥60分钟/168分钟全局上界、必要混合场景、资源观测与后代身份要求；bounded diagnostic 不能冒充 formal。V1.3 D17 明确退役旧隐式累计预算账本，替代场景必须证明实际显式并发、取消和输出保留策略，不能重建旧资金账本作为运行前提。当前 runner 已使用闭合v2七类CI与正确显式策略场景，旧budget条件已删除；稳定资源点、持续组合负载及原生资格仍未闭合，见[韧性owner](runtime-resilience-qualification.md)。失败和不确定清理保原证据。

旧 KASD [三平台 run33659494358](https://github.com/ferqx/kite-code/actions/runs/33659494358)只绑定其历史 implementation head，不证明新八 workspace。旧来源/字段不再用于当前发行。依赖补丁仍由 manifest/lock固定，不能绕过安装补丁。完整 V1.3 的37能力、T001—T114/E01—E14及§35仍由[计划](../plans/unified-agent-refactor-v1.md)与实际能力映射核对，状态保持 implementing。
