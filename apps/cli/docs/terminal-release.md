# 通用终端候选制品

本页负责 V1.3 新 CLI/TUI 的候选构建、搬迁与安装。根 `agent`、`tui`、`prod:tui`、`server` 与 `release:build/verify/smoke/install` 已使用新候选工具；`release:terminal` 保留明确 Terminal 操作入口。新候选的本机通过不继承旧制品的三平台资格。实际执行证据与未完成范围见[实施进度](../../../docs/plans/unified-agent-refactor-v1-progress.md)。

## 构建与操作

Windows 的完整原文件 owner 现可由同进程 verifier/归档复用；每次仍扫描准确库存、全部 SHA 和原对象/ACL，复制、错根、关闭或部分关闭的对象不提供权利。归档从原 HANDLE 读完整字节，压缩后复验保持。私有批量写入仅合并祖先持有，CREATE_NEW、每文件 Flush 和关闭未知保资源的合同保持。AI/Agent/Service/UI 的[明确普通 JS 构建声明](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)减少重复 npm 文件，React/React DOM、原生资产、WASM 和 jsdom 动态资源仍完整物化；构建扫描残余 bare import，并保安装声明图的原 manifest 摘要和许可全文。CLI renderer 与 hooks 共用 UI 的 Ink 入口。安装前门的错误出口优先保留有界业务 `code`（如 `owner_busy`），未知细节仍只返回原封闭 fallback；不把维护忙拒绝误写成注册失败。

根 `npm run agent`／`npm run tui` 使用固定 `dist/unified-terminal`，先执行 `npm run release:build`。缺候选路径现沿同一结构化资产错误返回 `terminal_bundle_unavailable` 并说明构建／开发命令；纯帮助、版本和非TTY拒绝仍先于候选与Profile访问。取锁、完整闭包验证和原finally释放保持，不自动构建或转向源码。日常源码调整使用 `npm run build` 后 `npm run cli:dev`／`npm run tui:dev`，步骤见[本地开发](../../../docs/development/local-development.md)。

在已经安装仓库依赖的 checkout 中，Windows 使用 Bun 1.4.3，Linux/macOS 保持 Bun 1.4.2。所有目标路径由调用者明确指定；构建与解包目录、归档和校验 sidecar 必须不存在，安装 prefix 必须是新的目录或本工具已经标记的安装根。下例的占位路径需要替换；SHA256 使用 pack 返回的准确值。

```sh
bun run release:terminal build --directory /absolute/output/candidate
bun run release:terminal verify --directory /absolute/output/candidate
bun run release:terminal pack --directory /absolute/output/candidate --archive /absolute/output/terminal.tar.gz
bun run release:terminal install --archive /absolute/output/terminal.tar.gz --sha256 <SHA256> --prefix /absolute/install/kite-terminal
/absolute/install/kite-terminal/bin/kite --help
/absolute/install/kite-terminal/bin/kite-tui --help
bun run release:terminal rollback --prefix /absolute/install/kite-terminal
bun run release:terminal uninstall --prefix /absolute/install/kite-terminal
```

[命令入口](../../../scripts/release/terminal.ts)先核对完整参数。`install` 先在自己创建的临时目录验证并解包，再发布到明确 prefix，最后清理该临时目录。`unpack --archive … --sha256 … --directory …` 可独立物化候选；它不安装。archive SHA256 与 candidate ID 不同：前者绑定压缩字节，后者绑定完整 manifest 字节。输出 JSON 保留这两个实际身份，不从版本文字推导身份。

安装器不修改 PATH、shell 配置或应用数据，也不启动、停止或替换已有服务。POSIX 运行入口是明确 prefix 下的 `bin/kite`、`bin/kite-tui`，Windows x64 的新实现使用 `bin/kite.exe`、`bin/kite-tui.exe`；无需系统 Bun。Windows 原生资格尚未取得，具体范围见下节。默认数据根为 `~/.kite-code/unified-agent`、profile 为 `default`，不读取旧正式配置或数据库。测试必须显式使用隔离 `--data-root`、工作区与固定 Provider。运行参数及 paired/shared 行为复用 [CLI owner](../README.md)，安装不会补齐尚未迁移的旧产品能力。

## 制品闭包与身份

[构建器](../../../scripts/release/terminal-bundle.ts)从六个 workspace 的 build 生成 AI、Agent、Client、UI、Service、CLI，固定实际 Bun 文件，加入 Agent SQLite Worker、迁移、Shell/MCP 监督资源、Web extractor 和 Web 静态资产。workspace 的 exports 指向实际 JS。CLI/TUI 入口引用公开 CLI 子路径，保留 package-local npm 解析位置。

[依赖复制器](../../../scripts/release/terminal-dependencies.ts)按已安装包的物理依赖图复制实际版本、正文、资源与许可证；每个包保留自己的依赖边，支持 peer、多版本、alias 与循环。POSIX 只允许指向候选内部的相对链接。Windows 采用全部普通文件的物理展开，以实际共同 `node_modules` 祖先放置每个查找名的确定默认源节点；版本或 peer context 冲突仍在局部放置准确源节点，原本缺失的 optional／peer 名称不提升。保留资源及许可证，不按版本文本合并不同源节点；同版本循环复用原祖先，无法有限表达的多版本遮蔽循环明确拒绝。它不在运行时搜索 checkout、全局 node_modules 或 PATH Bun；manifest 固定实际文件字节，并不证明 npm 来源或锁文件真实性。

共享 UI 的 Desktop 产物已内联唯一的 `@hugeicons/core-free-icons`；builder扫描全部生成 JS，拒绝残留该包或子路径的外部引用，然后从生成 UI manifest 与该 workspace 的复制边中移除这条已内联普通依赖。peer、optional、workspace 不能借此跳过；其他 npm 包若真正依赖它仍按原图复制。UI exports、其他解析边和原许可证继续保留，详见[UI build owner](../../../packages/ui/README.md#原桌面展示层)。新闭包的每个实际文件仍由同一完整 verifier 核验，未添加运行时豁免或内容缓存。

manifest 中声明的裸 npm 名称必须按包自己的实际解析位置复制，即使与 builtin 同名；`punycode` 包的 `punycode/` 调用不由 runtime builtin 代替。只省略显式 `node:`/`bun:` 依赖，必需包缺失拒绝构建，不从 builtin 名称推导可用。实际候选 JSDOM/parser 的运行资格与文件清单完整性分别核验。

[完整选择器](../host/terminal-artifact.ts)核对闭合 manifest、native platform/arch、每个文件大小/SHA256/mode、目录祖先与链接实际目标。未知文件、空目录、外部 hardlink、循环或外部 symlink、缺失资源与篡改均拒绝。manifest 的 source commit/dirty 是构建诊断；完整制品身份由 manifest 和它约束的字节给出。清单及 archive sidecar 均未签名，完整性不能等同发布者身份或生产资格。

[归档器](../../../scripts/release/terminal-archive.ts)只写普通 tar 文件，POSIX 链接以 manifest 声明保存。解包先核明确传入的 archive SHA，再拒绝 traversal、真实 tar link、重复路径、坏 PAX 与文件/链接祖先冲突；POSIX 重建已核对的内部链接后再次完整验证；Windows 清单与解包均拒绝链接，并以当前 SID 私有 DACL 新建对象。默认解压字节上限 1 GiB，API 可明确指定其他正整数；这是外部归档输入边界，不是 Agent 执行额度。归档/sidecar 使用排他创建，拒绝覆盖既有文件或链接。归档与安装输出不能位于输入候选内部，包括现存祖先别名。

## POSIX 安装生命周期

安装器使用独立 `.install.lock`、managed marker、`releases/<candidateId>` 和唯一两行 `active` 文件；两行分别为 current 与 previous。新候选在独立 stage 复制、完整校验，文件和目录自底向上 fsync 后 rename，同步 releases，再持久发布 active。新安装根的父目录项也同步。已存在候选只复验，不原地覆盖；失败前已经存在的 active 不被改成未校验候选。

stable shell launcher 固定一次 active，清除 NODE_PATH/NODE_OPTIONS/BUN_OPTIONS/ELECTRON_RUN_AS_NODE 后执行候选内 Bun 和固定入口。实际业务启动取得候选 shared 使用锁再验证，生命周期内不重读 active。纯帮助、版本、trace 和 TUI 非终端拒绝保持在完整验证与 profile 创建之前返回。独立 Service/daemon wrapper 也持有自己的同候选 lease，因此 CLI 退出后 daemon 仍阻止卸载。锁实现见 [Agent 平台 owner](../../../packages/agent/src/platform/README.md)。

升级只影响后续启动，原进程保持原 candidate。回滚完整验证 previous 后交换指针；它不恢复旧数据库或回放业务意图，本轮只验证相同新基线格式的候选组合，不宣称任意未来格式均可回滚。用户应先通过原实例的公开 `server stop` 结束要卸载的 daemon。卸载完整枚举已管理内容、拒绝未知条目/坏 active/坏候选，取得所有候选 exclusive 使用锁后重命名安装根再删除；任何 live lease 都立即拒绝，不强杀或猜测进程。独立 profile 数据保留。

## Windows managed Terminal 当前实现

2026-10-17 范围审查按[因果分组](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md#scope-review)核对连续任务，撤回 Linux/macOS CI、formal soak 和实验 census 的版本迁移，只保 Windows Bun1.4.3；工具 smoke 恢复原每命令20秒。同进程借用新增库存反例先红后绿，许可记录补保完整原 manifest，不能以摘要代替仅在 manifest 内的声明。

审查使用完整候选 `e9046c4e26d627ba99875131733a19d16545f71f45c8723af25a37ba88bc6e0a`（2,225文件）。真实安装 r22 已通过归档、安装、一次 Model、冷读、原媒体/config/preferences 的 backup/inspect/status/restore/GC，再实际 start/status/Web；之后在原110秒业务截止拒绝。失败 stop 于113.596秒返回0，原 HANDLE 确认为 dead 且 record 撤除，总120秒未扩大；这不是完整 daemon/安装通过。Native 的第三冷窗口和维护仍受[其原门禁](../../desktop/docs/native-release.md#windows-managed-native-当前实现)阻断。更早记录保原输入范围，不覆盖本轮未执行或失败的分支。

补齐原 manifest 许可来源后，r23 完整构建及校验候选为 `9f594260a611c2c5742785daa46cf7a681711fadcce7f5885e5f340e073c7025`（仍2,225文件）。五个 bundled workspace 的481份原 manifest 均核准确SHA及通知全文，其中7份只有 manifest 许可声明，不能省略。修正跨平台测试路径后，原发布八个完整文件在 Windows 40pass／6原平台skip／0fail，包含原20秒每命令 smoke；这不把上一候选的 installed／TUI 失败改记为 r23 通过。

Windows x64 的 [安装 owner](../../../scripts/release/windows-terminal-install.ts)现接入相同 build/pack/install/rollback/uninstall 命令。prefix 必须是准确盘符路径，父目录属当前 SID 且其他用户不可写；UNC、短名别名、reparse、hardlink、未知条目或宽权限拒绝。format=2 marker 固定首次候选的三个前门资产与完整身份，升级只发布 current/previous，保留最初 bootstrap；旧 POSIX marker 不被当作 Windows 安装根。

固定 `kite.exe`／`kite-tui.exe` 是 [原生第一阶段](../../../scripts/release/native/terminal-launcher.cc)，在 Bun 初始化前清除 NODE_PATH/NODE_OPTIONS/BUN_OPTIONS/BUN_BE_BUN/ELECTRON_RUN_AS_NODE，以自身位置确定 prefix，保持原祖先、自身与准确 helper 的只读 HANDLE，并核固定 helper 大小/SHA。独立编译的 [verifier](../../../scripts/release/entrypoints/windows-terminal-verifier.ts)关闭 dotenv/bunfig/tsconfig/package.json 自动加载，取得 selection SH 后核 marker、三前门文件、current、原候选 SH 和所有清单文件，再以固定空配置启动候选内 Bun。完整准入先于帮助/版本返回，仍不为纯帮助建立 Profile。Native 登记现在固定顺序持双 prefix SH，核双方 nonce／active 和完整两层候选，转发 Native 稳定 C 前门；内部 expected-candidate 在 Native 自身准入再次核原选择，漂移明确拒绝。整个实际 child 生命周期保持原文件与 use SH，关闭未知保完整 owner。源码范围及实际 Windows 待验见 [Native owner](../../desktop/docs/native-release.md#windows-managed-native-当前实现)。

第一阶段使用静态 CRT；[builder](../../../scripts/release/build-windows-terminal-launcher.ts)仍要求闭合系统 DLL import、无 delay import 与 `DependentLoadFlags=0x800`。候选 Bun 与 compiled helper 在原完整 pin 下读取；对新 console 副本，builder 可将经严格验证的 RVA v2 delay descriptors 转为普通 import descriptors，再封闭已有 LoadConfig 字段。转换只复用原 delay descriptor 的只读非执行存储；原 IAT／INT 地址、代码、节布局、文件长度和 Bun 嵌入程序保持不变。bound／unload 状态、未知属性、路径或重复 DLL、别名／重叠／重定位冲突、空间不足、缺字段均拒绝；转换后的 delay directory 必须为空。原 Bun 不修改，不能修复任意既有 ACL 或补造 LoadConfig。这一静态 import 搜索约束要求 Windows 10 RS1+，不宣称动态 DLL 或发布者已获资格，依据 [Microsoft 编译器合同](https://learn.microsoft.com/en-us/cpp/build/reference/dependentloadflag?view=msvc-170)。真实 Bun 1.4.2 的11组 delay imports 可按该形状转换；长期取舍归[构建决定](../../../.agents/notes/implemented/bug-fix/2026-10-16-windows-bun-eager-system-imports.md)。

`compileWindowsVerifier` 通过已封闭且持续 pin 的候选私有 Bun 子进程编译固定 verifier source，关闭配置自动加载，等待真实进程关闭后核输出权限，再物化新 helper。Bun 1.4.2 实际编译会沿用编译进程 executable 的权限，仅传 `compile.executablePath` 不能保证私有输出；构建器不事后放宽或修补它。实际 standalone 的 `import.meta.main` 为 false，因此固定 [Terminal executable entry](../../../scripts/release/entrypoints/windows-terminal-verifier-main.ts)在顶层显式调用原 verifier，避免生成静默返回0的空入口；可导入 verifier 的原 guard 和业务准入保持。Native 使用对应独立 entry。C 编译中间文件另置私有子目录，复制输出不改变正在 pin 的源目录库存。

固定运行参数将路径绑定为 `--config=<包内空配置>` 和 `--tsconfig-override=<包内配置>`；Bun 的可选 `--config` 值若拆为两个 argv，会把 TOML 当作入口并静默返回0。实际回归必须断言应用正文执行且 cwd 恶意 preload 未执行，退出0本身不构成成功。两个完整 verifier 用 BigInt 的 `dev/ino` 比较文件身份，避免真实 NTFS 64位文件 ID 在 Number 精度范围外被误判为重复；single-link、完整 hash／库存、ACL 和原 HANDLE 检查保持。

Windows 归档与安装有限夹具使用真实私有 SID 目录、junction／hardlink 拒绝反例、ACL 宽权限反例和准确 `.exe` 资产及外部协调锁位置；不靠 `chmod` 代证 Windows 权限。跨平台专用测试的夹具时限允许真实 Windows I/O；[release smoke](../../../scripts/release/release-smoke.ts)采用 Windows 私有 pipe、空 PATH、固定配置及原每命令20秒预算，保原实际 daemon／Web／stop 断言。该预算不改变下面 installed qualification 的120秒整链／30秒命令，准备阶段超时也明确失败，不计完整安装通过。精确身份、夹具与共同祖先的取舍归[发布合同决定](../../../.agents/notes/implemented/testing/2026-10-17-windows-release-contracts.md)。

selection EX、候选 use SH/EX 位于 prefix 外的稳定私有协调目录，卸载后仍保留同一键，不与 Profile 混用。安装 stage 也在该目录，以本调用登记的有限库存清理；复制使用新私有文件、真实短写/Flush，完整验证后同卷原生移动并读回 active。Windows syncDirectory 不冒称 POSIX fsync 或断电持久性。运行 A 时发布 B 不替换 A 的权威；父 CLI 与实际 paired Service 分别持原候选 SH/完整文件 pin，至实际子进程退出才关闭。精确 HANDLE 关闭未知时保真实锁，不以 error 当关闭证明。

卸载在 selection EX 和全部候选 EX 下，以完整库存一次取得原 DELETE-purpose 对象，whole verifier 复用同一 owner，而不关闭后重开普通 scope；核 bootstrap、全部候选与原指针后按原对象逐叶删除，确认原根消失才释放。取得 DELETE owner 后清理未知或删除部分完成都保 EX 至准确收尾/宿主退出，没有递归路径删除兜底。安装与卸载不接收应用 data-root，因此原用户 DB/config 保留。损坏拒绝、版本切换和未知发布不自动选择恢复方向；本实现没有补造通用断电修复。

2026-10-17，在基于 `af6cfad2` 的本任务未提交 diff、Windows x64／Bun1.4.2／Rust1.97.1 MSVC 环境，实际 `buildTerminalBundle` 使用新建私有目录内与当前 Bun 完整 SHA 一致的输入，构建并完整验证39,306文件候选 `a1526b6e56d892a0271b5b00f8b9077a73ba56d0d6027d0ece170064b19387f3`；实际 C 第一阶段与 compiled verifier 已生成并通过原 PE 门禁。该同包 verifier 真实启动后执行原准入，缺安装身份以1及 `terminal_windows_frontdoor_invalid` 拒绝，未超时或强制终止。原 nvm 输入权限不合格的拒绝保持，不修改原安装 ACL。候选自带 Bun 在空 PATH、隔离 cwd 下执行 `entrypoints/cli.js --help/--version`，并通过候选公开 Files 入口创建、发布、完整读回和删除1,450,000字节 Unicode 文件；不引用源码、编译器或内部未导出模块。

`bun test tests/isolated/unified-agent/windows-terminal-launcher.test.ts tests/isolated/unified-agent/windows-terminal-runtime.test.ts` 整文件6项116断言通过：真实 Bun 与 standalone 在 cwd／EXE目录同名 DLL 阴影下运行 SQLite、crypto、HTTP，source删除后嵌入程序继续运行，未封闭输入和覆盖既有输出均拒绝；另实际编译 Terminal／Native 两个正式 verifier entry，缺少安装身份必须执行原准入并以1拒绝。根 typecheck、边界、workspace／测试归属、文档检查及 CI 合同21项332断言通过。扩展执行 release job 的旧有限安装／归档合同在 Windows 有32项失败，涉及 `/private/tmp`、POSIX mode／fixture 布局，不能计为通过；本轮未改变这些独立夹具，也未 dispatch Actions。

同一候选的实际 gzip 归档为153,902,005字节，SHA256为 `a258e36039ca2e0ce78874bbf20a78055c81cc76a523cf33440c3b5adbffd35c`。实际 `packTerminalBundle`／`unpackTerminalBundle` 完成普通归档、私有逐文件物化及搬迁后的全量验证，39,306清单文件和 candidate ID 保持一致；搬迁后再次执行上述空 PATH 的 CLI／1,450,000字节 Files 探针和同包 verifier 原身份拒绝，均自然退出，未超时或强制终止。将三个准确前门文件复制到新私有 `bin` 后，实际 C→verifier 创建链自然退出1并报 `terminal_windows_install_identity_mismatch`，证明正确进入原安装身份检查；这项缺 marker 的拒绝不代替正式安装验收。

后续基于 `4172d483` 的本任务未提交工作树构建并全量验证新候选 `5d46e164e8828f78e4cbe7f2cf6d9e26f694c9a472fd59a92953c788c3733261`，共同祖先布局为22,309清单文件。完整锁图4项／142,679条断言核每条原解析边、所有资源字节、缺失optional与搬迁解析；同包公开Files入口在空PATH下通过1,500,000字节Unicode创建／完整读回／删除，Node-API资产的Bun／Node搬迁及损坏拒绝另有2项／55断言通过。Bun1.4.2的 `--tsconfig-override` 仍会输出实际已观察的内部directory-mismatch诊断，未隐藏或移除固定配置。

再修正实际HANDLE共享保护后，新建Terminal候选 `16a4041941db8870d828a492adbf6dce37d51704ae18618e7803d613d2687050`（22,309清单文件）已实际MSVC构建并全量验证。原生最终路径在持原祖先下核验，不再JS逐叶重复预先realpath；完整内容扫描在Windows使用native realpath，保同一canonical/别名、single-link、精确身份、全字节SHA与库存检查。候选文件请求真实GENERIC_READ，祖先请求FILE_TRAVERSE，锁文件仅请求LockFileEx所需读取权，不放宽write/delete sharing。五个完整归档/安装控制文件再次32pass/283断言；这是有限32项测试，原失败集合中的完整smoke仍另计。原对象反例、C/Node-API同步与Native配套生命周期归[持久决定](../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)。

该新候选实际归档126,006,927字节，SHA256为 `a1d705f90eada7403e87ccdd8d5556ffcffb7ad2bd580535121f4e0b87d2aa86`，已独立重算核对。完整Windows安装调用者在392.121秒的pack准备后以原120秒门禁拒绝，尚未进入unpack／install；这是失败证据，不计安装通过。原七文件重跑为35pass／6项原POSIX平台skip／1fail，原32项失败中31项已修复；剩余完整smoke已实际定位 `daemon_startup_unknown`，原15秒确认前完整准入尚未结束，随后递归清理又被live对象拒绝。失败smoke现保留原错误、清理错误、私有根和原lease，不能据stop返回absent删除仍在启动的对象；[隔离回归](../../../tests/isolated/unified-agent/release-smoke-ownership.test.ts)核两种反例。3个准确本轮测试实例之后均经公开stop及原FILETIME核为dead，未强杀开发桌面或删除未知根。正式120秒／30秒命令、业务准入及原关闭期限不变，当前完整Windows安装资格未取得。

最终七文件再次整跑为35pass/6项原平台skip/1fail、374断言；fresh smoke使用新候选 `661143b2ce99036c591f7b505fbaff834d87d2d8171ecdce0fcf697407ee325b`，全例443.771秒，仍保原 `daemon_startup_unknown` 与实际Bun directory-mismatch诊断。失败没有再被递归删除错误覆盖，原私有根和lease保留；晚到的同次daemon随后按准确build/profile/workspace/pipe hash/原FILETIME匹配，经公开stop返回0并核原birth为dead，准确候选已无live进程，未删除证据或终止开发桌面。原32项失败仍剩该整包smoke一项，不能把五文件有限32项全绿表述为全部问题已解决。

其他构建和整组回归结束后，单独对 `16a40419…` 执行原完整Terminal安装caller，仍在275.019秒的pack准备后以原120秒门禁拒绝，未进入unpack/install。实际归档126,008,695字节，SHA256 `c7c6218b18591301962cb6415f0c2668c521972eaf47f38a66ed8178d6c71fb9`，已独立核完整字节/sidecar/clone manifest。另对同候选22,310项原字节逐项核SHA后在内存单独计时，读取3.203秒、Bun.Archive constructor3.442秒、bytes完成6.746秒；该诊断不含准入/原对象/发布，不能代正式pack或安装资格，只用于把后续排查聚焦到完整准入和原生对象路径。没有据此删除跨await复核或扩大门禁。

完整 installed 生命周期仍须独立执行。显式 [qualification 工具](../../../tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts)消费已构建候选，核前门、环境拒绝、真实 paired Run、A 保锁时发布 B／回退及冷读零重放、全部 EX 和卸载保数据。真实 Run 期间 busy backup 拒绝，退出后以同一 `kite.exe` 完成 backup／inspect／status／restore／status／GC及新 Store 原完整历史冷读，核原媒体和 config／preferences 字节、旧 Store 拒绝与零重放。前门 GC 只核 referenced／recent保留，过宽限删除由维护 owner 的 Windows 公共用例单独验收。

正式 [Daemon编排](../host/daemon.ts)已接Windows当前SID私有pipe/原record/kernel process HANDLE，保HTTP生命周期和共享CLI/TUI准入。启动父在完整验证/固定Bun配置后持候选SH/full pin至原child实际退出或准确handoff；Daemon和只读preflight自身在endpoint/Store前取得独立使用权，pipe/record/候选关闭未知保原owner。原qualification在同一120秒整链／30秒命令内再调用[完整Daemon helper](../../../tests/fixtures/unified-agent/windows-daemon-qualification.ts)：B实际start/status/Web→rollbackA仍reuse原B→A前门共享完整Model→client detach／busy保原→明确cancel restart实际原birth退出→新A冷读完整原结果零重放→正常stop／两候选EX／恢复原config。原paired模型计数与全部维护/卸载断言保持，Daemon使用独立Provider计数。

B仅修改manifest版本标签，TUI仅help/version；此工具即使通过也不代证跨代码、PTY、Native、Shell/stdio MCP、完整恢复发布窗口或RSS。release candidate准确命令和先MSVC后Terminal build顺序保持，按用户安排留重构后Actions验证。本机mock/依赖布局/PE字节只证各自断言；长期取舍及未完成验收见[安装提案](../../../.agents/notes/proposed/architecture/2026-10-10-windows-managed-terminal-frontdoor.md)和[私有Daemon决定](../../../.agents/notes/implemented/architecture/2026-10-02-daemon-private-bootstrap.md)。

## Windows installed TUI 正式调用者

独立 [完整 TUI qualification](../../../tests/fixtures/unified-agent/windows-installed-tui.qualification.ts)消费 release job 的准确 Terminal／Native 已构建候选，先安装 Terminal，再把 Native 注册到同一个稳定 `kite-tui.exe`。两种选择各使用实际所选候选内的 SQLite reader／Bun／TUI／Service，分别核同一 Store 的独立原会话；不借源码 Store 或全局 Bun。前门环境和 Workspace 预加载污染不进入产品，用户 HOME／Profile 保持私有。原仅 help/version 的 Windows installation 工具仍保其原范围，完整 PTY 由这条单独必需调用者负责。

每种选择沿真实键盘完成普通任务、普通界面的完整正文自动读取、含已加载原思考的 Markdown 导出、准确原第二项任务 Ctrl+C、未提交 Unicode 草稿及 Ctrl+Q 正常退出；同一稳定前门冷启动读原草稿、全文／思考和完整 Command／Run／Execution，Provider／持久游标／journal／配置零重放与原字节保持。该 qualification 不启用测试诊断，最新 VT 解析缓冲按原全文与唯一尾标记绑定 complete Message，核完整正文及完成后的 Thinking 摘要；完整思考以原输出及导出逐字核验，不要求屏幕展开，也不能拿历史 stdout 确认当前画面。诊断模式的精确 ID 展示及 preview→Ctrl+O 读取门禁由[隔离 host 测试](../test/isolated/tui-host.test.ts)验证。第二项已取消 Model 的合法未完成 preview 保留。

[ConPTY driver](../../../tests/fixtures/unified-agent/windows-installed-tui-pty-driver.ts)由 [PTY owner](../../../tests/fixtures/unified-agent/windows-installed-tui-pty.ts)通过创建前原 Windows Job 启动，再执行真实 80×24 `Bun.Terminal`。原成员 HANDLE／FILETIME／映像核 TUI／Service 和注册 Native 前门归属，数字 PID 只定位已证成员；普通退出须产品／PTY exit0、全部有序输出和 EOF、原 Job0／wait／strict Close 且未请求 Terminate，强制收尾不计成功。各模式独立 120 秒、每 PTY 30 秒、写操作最多 10 秒，失败保首次错误和原 owner。

运行命令为 `bun run tests/fixtures/unified-agent/windows-installed-tui.qualification.ts --terminal=<absolute-terminal> --native=<absolute-native>`；workflow 在双方完整 build／verify／smoke 后强制执行，守卫拒绝删步骤、错候选／平台、过滤、忽略失败和顺序错误。最后 Native 撤登记恢复独立前门，两者卸载保原 Store／配置／九份 TUI 私有数据。该链未切换两个真实代码候选，不代跨代码、Shell／MCP、完整恢复发布窗口、RSS／全资源或阶段门禁。当前 macOS 仅完成源码／CI／适用原测试，Win/Linux 实机按用户安排交后续 GitHub Actions；[持久取舍](../../../.agents/notes/proposed/testing/2026-10-11-windows-installed-tui-caller.md)与 [准确证据](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11windows-installed-tui-私有持久化与正式调用者)保资格未闭合。

## Windows 真实代码升级与冷回退调用者

[统一调用者](../../../tests/fixtures/unified-agent/windows-cross-version.qualification.ts)消费同 release job 已 build／verify／smoke 的准确 Terminal／Native，两者 inner 身份必须一致。[兼容前驱](../../../tests/fixtures/unified-agent/compatible-predecessor-input.ts)固定真实提交 `4a4c0e440b2098e5b4ec58c5831452773b39228f`：11项锁输入沿下文同一守卫核原字节相同或已审查的完整 raw 配对；`0001-baseline` 与 `0002-recovery-audit` 两份 SQL 仍同时核原字节和固定 checksum。该提交已具 Windows 两类 builder／build port 及 DB9；原源码自己的两个 builder 构建，成功后删除旧源码，不修改 manifest、版本或生产 helper。两版均为 `0.1.0`，完整候选和实际 Agent 字节必须不同。原 `837a2b8c` 输入、历史 SHA 与独立路径许可仍保为 legacy 守卫，不将仅支持旧 Core schema 的代码计作当前兼容回退。当前 Windows 原生资格仍待实际执行，不沿用 macOS 或历史前驱结果。

[Terminal 链](../../../tests/fixtures/unified-agent/windows-terminal-cross-version.qualification.ts)从稳定 `kite.exe` 执行 A 原任务，原 A paired CLI／Service 和使用锁仍 live 时选择 B，正常退出后 B 读取原历史并明确继续，再冷回退 A 读取 B、继续原会话，最终 B 冷读全部三任务。B 的352041 UTF-8字节完整 Unicode 正文必须实际进入回退后 A 的新 Provider 请求。各自安装候选的公开 Runtime 读取普通完整短正文及 sealed 长正文，核原 Store／Command／Run／Execution、完整 body／bytes／hash／出处及 readonly 游标；正式 `context read` 核完整原消息身份，不冒称该页面打印 sealed 全文。冷读零模型重放，指针切换不恢复数据；原 Job／HANDLE／FILETIME核进程，成功必须实际 exit0、双流 EOF、自然 Job0／未 Terminate、严格 Close、所有候选 EX及唯一卸载保原 DB／config。

执行 `bun run tests/fixtures/unified-agent/windows-cross-version.qualification.ts --terminal=<absolute-terminal> --native=<absolute-native>`；统一绝对期限1140000ms，分别保物化180秒、Terminal360秒／每命令30秒、Native基础420秒和维护180秒，并包含收尾。原同代码安装120秒、TUI及POSIX调用者／预算／断言保持；新mandatory步骤位于三条原Windows caller之后，CI守卫核准确双输入、六个无条件 build／verify／smoke、真实 Windows matrix／MSVC和顺序。当前源码与macOS读取验证不授Windows原生资格；实际构建／安装／回退交后续GitHub Actions，原RSS／观测／Shell合同和完整阶段门禁保持。Native窗口与维护行为归[Native owner](../../desktop/docs/native-release.md#windows-managed-native-当前实现)，准确证据归[当前进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11windows-真实代码升级与冷回退正式调用者)。

## 验证边界

完整选择器与独立 Service／Daemon 使用[同一 Terminal verifier](../../service/src/runtime-assets.ts)，普通资产完整 SHA 的大小文件分流与多块／短尾拒绝证据归[Service owner](../../service/README.md)。目录、链接、实际引擎与使用锁守卫保持；当前正式入口的分段时钟及完整默认结果归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

原有本机资格为 macOS arm64、Bun 1.4.2；新增 Linux 当前安装链见下节。macOS 实际验证包括：搬迁后删除原输出、独立 HOME/PATH、两个安装入口、固定模型一次实际 Run、SQLite Worker 读回原历史、共享 daemon/TUI PTY、升级/回滚原实例固定、live 使用时拒绝卸载、停止后卸载和独立用户数据保持。测试入口：

- [真实 bundle 与生命周期](../../../tests/isolated/unified-agent/terminal-bundle.test.ts)
- [真实代码升级与冷回退](../../../tests/isolated/unified-agent/terminal-cross-version.test.ts)
- [安装负例](../../../tests/isolated/unified-agent/terminal-install.test.ts)、[归档负例](../../../tests/isolated/unified-agent/terminal-archive.test.ts)
- [依赖闭包](../../../tests/isolated/unified-agent/terminal-dependencies.test.ts)、[完整选择器](../../../tests/isolated/unified-agent/terminal-artifact.test.ts)

原 bundle 生命周期测试的同源码版本标记只证明指针机制。当前[跨代码版本整例](../../../tests/isolated/unified-agent/terminal-cross-version.test.ts)固定真实兼容前驱 `4a4c0e440b2098e5b4ec58c5831452773b39228f`，由其原源码和原 builder 生成候选；11项 lock／workspace／patch 原始输入逐一核对，只接受原字节相同或下述已审查的完整 raw 配对，另核 `0001`、`0002` SQL 原字节和各自固定 checksum。format major 1 不代表任意迁移版本互通，只有双方实际支持同一闭合 schema 才进入 A→B→A→B 兼容链。两者 productVersion 均为 `0.1.0`，实际 Agent 字节及候选 ID 必须不同；原 npm 闭包、干净旧源码、原 builder、源码删除、归档搬迁与输出删除守卫保持。不能修改旧 reader、恢复旧 DB 或删除审计 schema 来获得兼容。取舍归[兼容前驱决定](../../../.agents/notes/implemented/testing/2026-10-16-schema-compatible-predecessors.md)。

2026-10-18用户确认增加[精确原始输入守卫](../../../tests/fixtures/unified-agent/predecessor-reviewed-input.ts)：`compatible`、`terminal_legacy`、`windows_legacy` 分别绑定各自固定前驱，仅为 `bun.lock`、根 package、Agent／AI／UI／Service 六项准确路径登记双方完整 SHA-256。它只承认 `eeea65f5f` 的 Responses OpenAI 声明及两个完整 resolved 包、`9ff6904a0` 的构建／UI 声明、`bcf70ce84` 的 session-title 入口，以及本轮 `test:model:tools:live` 准确脚本行。OpenAI `4.0.19` 与其嵌套 provider-utils `5.0.12` 是实际依赖新增，不能称为声明投影或依赖未变。其余五项原输入保持逐字比较；两 SQL 不进入此例外。2026-10-19（UTC）真实模型测试新增 `test:model:collaboration:live` 后，根 package 的完整当前 SHA 更新为 `4c7e7320475e5c030c4221e30f408bb21b290de5a4c73fcd830f5efb4f0e4a14`，仅该路径的审查 scope 更新为当日，并在 provenance 登记第二条准确 live 脚本及增量；其余五项配对、原前驱字节和 SQL 校验保持。缺失、重复、改名、追加命令及未知字节仍拒绝，不能普遍忽略 scripts。

守卫不做 JSON 归一化、字段忽略或旧源码改写；任一未知字节、错路径或与固定 context 不对应的原始 blob 均拒绝；共享同字节 blob 按各自固定调用上下文核验。provenance 在全部11项原 raw SHA／当前 raw SHA 之外，独立记录 `reviewedInputIncrements` 的非 identical 标签、准确前驱、审查 scope、提交和增量；这里的提交列表只解释本轮追加审查，既有 legacy 映射理由仍归其原 matcher／refinement。旧源码继续使用自己的 manifest、lock 和 builder，当前锁不写回旧源码。原反例与[配对单元](../../../tests/isolated/unified-agent/predecessor-reviewed-input.test.ts)分别核历史映射和新例外；本地代码比较不授已发布前驱或其他平台资格。

原冻结 `a2b6441f`／`837a2b8c` 的 legacy 输入继续保留[精确声明投影](../../../tests/fixtures/unified-agent/predecessor-workspace-declarations.ts)：既有审查快照的 POSIX 六项 raw byteequal、五项准确映射，Windows 七项 raw byteequal、四项映射；原历史 SHA、source-entry 路径隔离与全字节拒绝断言不变。当前兼容入口不借用这些 legacy 投影；除原字节相同外，只接受下述独立的完整 raw 配对例外，两迁移仍固定原字节。原映射理由与历史证据仍归[前驱决定](../../../.agents/notes/implemented/testing/2026-10-07-platform-real-code-predecessors.md)。夹具保留 Profile／user 两份模型输入及原字节保护。

两类前驱依赖镜像均不消费开发 renderer 声明的准确缓存目录 `apps/desktop/node_modules/.vite-desktop-dev`，只跳过该路径的真实目录，不清理当前缓存。该路径若为符号链接仍走原映射与逃逸检查，其他非链接依赖仍拒绝，旧 builder 继续核实际依赖闭包。

实际安装前门依次完成 A 任务、升级 B 后新任务、正常停止后回退 A 并冷读 B 的完整正文、A 继续原会话、再切换 B 冷读全部原记录。公共 Client 与各自候选内只读 Store 核同一 Store、原 Command/Run/Model 身份和正文/ref/hash；352041 UTF-8 字节 Unicode 正文也完整进入回退后的新模型请求。冷 GET 不增加模型请求或持久游标，四次启动为不同实例；公开 stop 核准确 PID/startIdentity 已退出、全部安装候选 EX 可取，卸载保留原数据库 inode、完整字节和配置。没有恢复旧数据库。2026-10-11当时的macOS在Service精确来源入口匹配修复后，原完整文件1pass／336条Bun断言／actual0／118.88秒，原360秒整例／30秒命令不变；当时准确输入与结果归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)。此前126.184秒只保[原输入范围](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10db9-版本切换与安装版维护恢复)，249.85秒结果也只保原冻结组合；原失败和历史阶段完整默认结果归[原进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07terminal-真实代码升级与冷回退)。

原 a2b Terminal 另有独立240秒拒绝整例：当前公共 Runtime 生成真实0002和已完成原历史，经实际安装旧 CLI／旧 Store leaf 核 `store_incompatible`、诊断 `data_unavailable`、原历史拒绝，旧进程正常退出后核EX、原Core／配置bytes与inode、当前完整View／cursor不变；不恢复或复制数据库。

上述新测试沿默认 isolated 每文件进程、进程内 concurrency=1 运行，可与其他隔离文件共享槽；构建输出、旧 clone、reader、安装和数据均位于自有临时根。Linux arm64 的历史 1b796 组合沿完整文件通过336条Bun断言，实际0／60.741秒；该结果只适用于当时锁输入与源码。当前固定 4a4c0e440 的 Linux 兼容组合尚未运行，按用户顺序在重构完成后由 GitHub Actions 核对；原360秒整例和30秒命令期限保持。准确环境、候选、失败和执行归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。release candidate现对macOS/Linux另调用整个跨代码文件，守卫拒绝错误平台、关闭、echo或过滤命令。原生平台CI仍待执行，Windows 安装源码与待验资格归上节。已发布旧样本、断电恢复、平台签名、生产sandbox/exporter、全部平台资格及完整T/E仍未由本机Terminal组合证明。

## Linux 当前引擎与安装维护链

当前 Bun 1.4.2 Linux x64 实测 builtin SQLite 3.53.2，sourceId 为 `2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24`。[官方发布说明](https://sqlite.org/releaselog/3_53_2.html)确认该准确来源包含 WAL-reset 修复；[release identity](../../service/src/sqlite-release-assets.ts)将其加入已审查集合，未知版本、近似哈希和不符 linkage 仍拒绝，不用版本区间代替来源核验。

原[完整 bundle 测试](../../../tests/isolated/unified-agent/terminal-bundle.test.ts)以平台 `tmpdir()` 创建自有根，保留原 120 秒预算和全部断言。在 Ubuntu 24.04.4 x64 用户环境实际完成构建、归档搬迁与删除原输出、installed CLI/TUI、一次固定模型任务、daemon/PTY、升级和回滚指针、live lease 拒绝卸载、正常停止及最终卸载保数据。其升级候选仍来自同源码改 productVersion，不能由此认定 Linux 真实跨代码冷回退。

Linux 分支的[源码外公共 Store reader](../../../tests/fixtures/unified-agent/terminal-bundle-store.ts)由 installed candidate 的 Bun 执行，裸 imports 只解析该候选。两个真实 Worker 交替并发完成 24 次 WAL 写入，再以实际 `bin/kite maintenance backup/inspect/restore/status` 核原 Store、manifest 引擎和源数据库完整字节。恢复生成新 Store，cold readonly 核原 Workspace/Session/Message/Execution、Session owner generation 精确加一且 owner 清空、配置原字节及无残留 restore journal；维护与冷查回不增加原一次模型调用。原最终卸载保数据库和配置断言继续执行。

本机有限结果为 1 pass、2545 条 Bun 断言、84.250 秒，运行于 Apple Silicon Docker Linux VM 中的 x64 仿真环境。它不替代 GitHub-hosted 原生 Ubuntu CI、Native、Windows、已发布 predecessor/T029、真实跨代码组合或完整持续负载。release candidate CI 已在 macOS 和 Linux 调用整个原测试，守卫拒绝 Mac-only、echo 和过滤到零案例；实际执行与原失败归[当前进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-当前-terminal-安装与维护链)。该 Linux 测试环境不接入默认 Shell，普通 Shell 保留宿主执行语义。

## 发布引擎与双发行包选择

`release:build` 默认生成 `dist/unified-terminal`，`release:build --product native` 生成完整 Native。`release:verify --source-commit <40位提交> --clean-source true` 核实际源提交及 clean 事实；参数在任何制品/Profile I/O 前验证，dirty-source 候选不能称正式发布。

Terminal manifest 的 `sqlite` 固定 driver、linkage、实际 version/sourceId 与 engine manifest SHA。macOS builder 从明确 `--sqlite-library` 或有限构建依赖位置复制已审查库，验证实际引擎和仅系统动态依赖；安装运行只选择包内库。Linux/Windows 固定 Bun 实际 builtin 引擎，未知 sourceId 或未证明 WAL 修复拒绝构建资格，不按版本大小或“最新”放行。当前本机包内库为 SQLite 3.51.3；Node/Electron 私有库单独绑定。selection 缺失、损坏、篡改和第一 Database 后迟设置均拒绝；不存在资产的开发模式只提供 unqualified 诊断。

标准安装前门可显式登记完整 Native 闭包。双方 prefix 的 nonce/active/managed marker 与完整 manifest 必须一致；坏登记直接拒绝。升级/回滚仅更新自己仍拥有的登记，卸载仅以原 nonce 撤销，不删除另一安装后写入的登记。已有进程保持原候选与使用锁。源码/显式 candidate 不参与自动登记选择。操作与恢复限制见[Native owner](../../desktop/docs/native-release.md)。

Native 明确回退时，仍由其 nonce 持有的既存 Terminal 必须在 Native active 发布前通过双 EX 内的完整预检；损坏拒绝且双方登记及原选择保持。修复后原独立前门继续可用，再明确回退更新选择。正常卸载目标和其他 Native 的登记仍按原归属处理，验证范围见同一 owner。

真实当前引擎测试覆盖 source-free 默认 sidecar、两个 Worker、24 次并发 WAL 写、准确备份/恢复至新 Store 和 cold readonly/preflight。新注册资格使用 fresh 完整候选与 80×24 TUI，Provider 3，三条原 Command→Run 均 completed；损坏 nonce、运行中卸载 busy、cold 原 scope/bytes/cursor 与卸载恢复分别核实。旧源码 Apple SQLite 3.51.0 读取该 WAL 的真实 `SQLITE_CANTOPEN` 已保留，未通过删除 WAL 或改 journal mode 掩盖；该源码引擎不属于正式候选资格。

包内选择、准确 sourceId 与 Worker 不重复设置 loader 的原因见[SQLite 引擎决定](../../../.agents/notes/implemented/architecture/2026-10-04-selected-sqlite-engine-and-worker-identity.md)。Windows private Profile 与普通 Workspace scope 的实现/待验边界见[路径策略提案](../../../.agents/notes/proposed/architecture/2026-10-04-windows-private-and-workspace-scope-paths.md)，不能据 POSIX 邻接放行 Windows 制品。
