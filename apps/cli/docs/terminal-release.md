# 通用终端候选制品

本页负责 V1.3 新 CLI/TUI 的候选构建、搬迁与安装。根 `agent`、`tui`、`prod:tui`、`server` 与 `release:build/verify/smoke/install` 已使用新候选工具；`release:terminal` 保留明确 Terminal 操作入口。新候选的本机通过不继承旧制品的三平台资格。实际执行证据与未完成范围见[实施进度](../../../docs/plans/unified-agent-refactor-v1-progress.md)。

## 构建与操作

在已经安装仓库依赖的 checkout 中使用 Bun 1.4.2。所有目标路径由调用者明确指定；构建与解包目录、归档和校验 sidecar 必须不存在，安装 prefix 必须是新的目录或本工具已经标记的安装根。下例的占位路径需要替换；SHA256 使用 pack 返回的准确值。

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

安装器不修改 PATH、shell 配置或应用数据，也不启动、停止或替换已有服务。运行入口是明确 prefix 下的 `bin/kite`、`bin/kite-tui`；无需系统 Bun。默认数据根为 `~/.kite-code/unified-agent`、profile 为 `default`，不读取旧正式配置或数据库。测试必须显式使用隔离 `--data-root`、工作区与固定 Provider。运行参数及 paired/shared 行为复用 [CLI owner](../README.md)，安装不会补齐尚未迁移的旧产品能力。

## 制品闭包与身份

[构建器](../../../scripts/release/terminal-bundle.ts)从六个 workspace 的 build 生成 AI、Agent、Client、UI、Service、CLI，固定实际 Bun 文件，加入 Agent SQLite Worker、迁移、Shell/MCP 监督资源、Web extractor 和 Web 静态资产。workspace 的 exports 指向实际 JS。CLI/TUI 入口引用公开 CLI 子路径，保留 package-local npm 解析位置。

[依赖复制器](../../../scripts/release/terminal-dependencies.ts)按已安装包的物理依赖图复制实际版本、正文、资源与许可证；每个包保留自己的依赖边，支持 peer、多版本、alias 与循环。仅允许指向候选内部的相对链接。它不在运行时搜索 checkout、全局 node_modules 或 PATH Bun；manifest 固定实际文件字节，并不证明 npm 来源或锁文件真实性。

共享 UI 的 Desktop 产物已内联唯一的 `@hugeicons/core-free-icons`；builder扫描全部生成 JS，拒绝残留该包或子路径的外部引用，然后从生成 UI manifest 与该 workspace 的复制边中移除这条已内联普通依赖。peer、optional、workspace 不能借此跳过；其他 npm 包若真正依赖它仍按原图复制。UI exports、其他解析边和原许可证继续保留，详见[UI build owner](../../../packages/ui/README.md#原桌面展示层)。新闭包的每个实际文件仍由同一完整 verifier 核验，未添加运行时豁免或内容缓存。

manifest 中声明的裸 npm 名称必须按包自己的实际解析位置复制，即使与 builtin 同名；`punycode` 包的 `punycode/` 调用不由 runtime builtin 代替。只省略显式 `node:`/`bun:` 依赖，必需包缺失拒绝构建，不从 builtin 名称推导可用。实际候选 JSDOM/parser 的运行资格与文件清单完整性分别核验。

[完整选择器](../host/terminal-artifact.ts)核对闭合 manifest、native platform/arch、每个文件大小/SHA256/mode、目录祖先与链接实际目标。未知文件、空目录、外部 hardlink、循环或外部 symlink、缺失资源与篡改均拒绝。manifest 的 source commit/dirty 是构建诊断；完整制品身份由 manifest 和它约束的字节给出。清单及 archive sidecar 均未签名，完整性不能等同发布者身份或生产资格。

[归档器](../../../scripts/release/terminal-archive.ts)只写普通 tar 文件，链接以 manifest 声明保存。解包先核明确传入的 archive SHA，再拒绝 traversal、真实 tar link、重复路径、坏 PAX 与文件/链接祖先冲突；重建已核对的内部链接后再次完整验证。默认解压字节上限 1 GiB，API 可明确指定其他正整数；这是外部归档输入边界，不是 Agent 执行额度。归档/sidecar 使用排他创建，拒绝覆盖既有文件或链接。归档与安装输出不能位于输入候选内部，包括现存祖先别名。

## 安装生命周期

安装器使用独立 `.install.lock`、managed marker、`releases/<candidateId>` 和唯一两行 `active` 文件；两行分别为 current 与 previous。新候选在独立 stage 复制、完整校验，文件和目录自底向上 fsync 后 rename，同步 releases，再持久发布 active。新安装根的父目录项也同步。已存在候选只复验，不原地覆盖；失败前已经存在的 active 不被改成未校验候选。

stable shell launcher 固定一次 active，清除 NODE_PATH/NODE_OPTIONS/BUN_OPTIONS/ELECTRON_RUN_AS_NODE 后执行候选内 Bun 和固定入口。实际业务启动取得候选 shared 使用锁再验证，生命周期内不重读 active。纯帮助、版本、trace 和 TUI 非终端拒绝保持在完整验证与 profile 创建之前返回。独立 Service/daemon wrapper 也持有自己的同候选 lease，因此 CLI 退出后 daemon 仍阻止卸载。锁实现见 [Agent 平台 owner](../../../packages/agent/src/platform/README.md)。

升级只影响后续启动，原进程保持原 candidate。回滚完整验证 previous 后交换指针；它不恢复旧数据库或回放业务意图，本轮只验证相同新基线格式的候选组合，不宣称任意未来格式均可回滚。用户应先通过原实例的公开 `server stop` 结束要卸载的 daemon。卸载完整枚举已管理内容、拒绝未知条目/坏 active/坏候选，取得所有候选 exclusive 使用锁后重命名安装根再删除；任何 live lease 都立即拒绝，不强杀或猜测进程。独立 profile 数据保留。

## 验证边界

完整选择器与独立 Service／Daemon 使用[同一 Terminal verifier](../../service/src/runtime-assets.ts)，普通资产完整 SHA 的大小文件分流与多块／短尾拒绝证据归[Service owner](../../service/README.md)。目录、链接、实际引擎与使用锁守卫保持；当前正式入口的分段时钟及完整默认结果归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

原有本机资格为 macOS arm64、Bun 1.4.2；新增 Linux 当前安装链见下节。macOS 实际验证包括：搬迁后删除原输出、独立 HOME/PATH、两个安装入口、固定模型一次实际 Run、SQLite Worker 读回原历史、共享 daemon/TUI PTY、升级/回滚原实例固定、live 使用时拒绝卸载、停止后卸载和独立用户数据保持。测试入口：

- [真实 bundle 与生命周期](../../../tests/isolated/unified-agent/terminal-bundle.test.ts)
- [真实代码升级与冷回退](../../../tests/isolated/unified-agent/terminal-cross-version.test.ts)
- [安装负例](../../../tests/isolated/unified-agent/terminal-install.test.ts)、[归档负例](../../../tests/isolated/unified-agent/terminal-archive.test.ts)
- [依赖闭包](../../../tests/isolated/unified-agent/terminal-dependencies.test.ts)、[完整选择器](../../../tests/isolated/unified-agent/terminal-artifact.test.ts)

原 bundle 生命周期测试的升级候选由同一实际 bundle 改 productVersion 产生，只证明指针机制。当前独立跨代码版本测试固定新基线原提交 `a2b6441fde28d9c0f895a26e6a9d2471d2b1b242`，使用该提交原源码和原 builder，与当前源码分别生成完整候选。复用 PC 展示层后锁文件已变化，原 macOS 3140／Linux 1b796 输入不再满足当前相同依赖守卫；其历史证据保留，不能冒充当前组合。两者 productVersion 均为 `0.1.0`，实际 Agent 字节与 candidate ID 必须不同。[旧候选物化夹具](../../../tests/fixtures/unified-agent/terminal-predecessor.ts)核11项输入中的10项完整字节相同，Agent清单仅接受 `e587a2a9` 的准确 process-observation export／build source-entry 两处增量并保存双方SHA；其余依赖／脚本／metadata变化仍拒绝。相同锁文件、其余workspace清单、补丁及 format=1 SQL基线保持，复制当前准确已安装 npm 依赖并将 workspace 链接指向旧源码，旧 builder 的闭包守卫保持；构建前后原源码必须干净，构建后删除旧源码，再归档、搬迁和删除原候选输出。历史3140前驱在 Linux 的准确引擎拒绝保留，不修改旧源码或 SQLite 白名单。取舍归[平台前驱决定](../../../.agents/notes/implemented/testing/2026-10-07-platform-real-code-predecessors.md)；本地真实代码组合不代表已发布 predecessor 或 npm 发布来源资格。

实际安装前门依次完成 A 任务、升级 B 后新任务、正常停止后回退 A 并冷读 B 的完整正文、A 继续原会话、再切换 B 冷读全部原记录。公共 Client 与各自候选内只读 Store 核同一 Store、原 Command/Run/Model 身份和正文/ref/hash；352041 UTF-8 字节 Unicode 正文也完整进入回退后的新模型请求。冷 GET 不增加模型请求或持久游标，四次启动为不同实例；公开 stop 核准确 PID/startIdentity 已退出、全部安装候选 EX 可取，卸载保留原数据库 inode、完整字节和配置。没有恢复旧数据库。当前 macOS 原完整文件 1pass／336条Bun断言／actual0／126.184秒，原360秒整例／30秒命令不变；准确当前输入与结果归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10db9-版本切换与安装版维护恢复)；此前249.85秒结果只保原冻结组合，原失败和历史阶段完整默认结果归[原进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07terminal-真实代码升级与冷回退)。

上述新测试沿默认 isolated 每文件进程、进程内 concurrency=1 运行，可与其他隔离文件共享槽；构建输出、旧 clone、reader、安装和数据均位于自有临时根。Linux arm64 的历史 1b796 组合沿完整文件通过336条Bun断言，实际0／60.741秒；该结果只适用于当时锁输入与源码。当前固定 a2b6441f 的 Linux 组合尚未运行，按用户顺序在重构完成后由 GitHub Actions 核对；原360秒整例和30秒命令期限保持。准确环境、候选、失败和执行归[本轮进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-真实代码升级与冷回退)。release candidate现对macOS/Linux另调用整个跨代码文件，守卫拒绝错误平台、关闭、echo或过滤命令。原生平台CI仍待执行，Windows安装明确拒绝。已发布旧样本、断电恢复、平台签名、生产sandbox/exporter、全部平台资格及完整T/E仍未由本机Terminal组合证明。

## Linux 当前引擎与安装维护链

当前 Bun 1.4.2 Linux x64 实测 builtin SQLite 3.53.2，sourceId 为 `2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24`。[官方发布说明](https://sqlite.org/releaselog/3_53_2.html)确认该准确来源包含 WAL-reset 修复；[release identity](../../service/src/sqlite-release-assets.ts)将其加入已审查集合，未知版本、近似哈希和不符 linkage 仍拒绝，不用版本区间代替来源核验。

原[完整 bundle 测试](../../../tests/isolated/unified-agent/terminal-bundle.test.ts)以平台 `tmpdir()` 创建自有根，保留原 120 秒预算和全部断言。在 Ubuntu 24.04.4 x64 用户环境实际完成构建、归档搬迁与删除原输出、installed CLI/TUI、一次固定模型任务、daemon/PTY、升级和回滚指针、live lease 拒绝卸载、正常停止及最终卸载保数据。其升级候选仍来自同源码改 productVersion，不能由此认定 Linux 真实跨代码冷回退。

Linux 分支的[源码外公共 Store reader](../../../tests/fixtures/unified-agent/terminal-bundle-store.ts)由 installed candidate 的 Bun 执行，裸 imports 只解析该候选。两个真实 Worker 交替并发完成 24 次 WAL 写入，再以实际 `bin/kite maintenance backup/inspect/restore/status` 核原 Store、manifest 引擎和源数据库完整字节。恢复生成新 Store，cold readonly 核原 Workspace/Session/Message/Execution、Session owner generation 精确加一且 owner 清空、配置原字节及无残留 restore journal；维护与冷查回不增加原一次模型调用。原最终卸载保数据库和配置断言继续执行。

本机有限结果为 1 pass、2545 条 Bun 断言、84.250 秒，运行于 Apple Silicon Docker Linux VM 中的 x64 仿真环境。它不替代 GitHub-hosted 原生 Ubuntu CI、Native、Windows、已发布 predecessor/T029、真实跨代码组合或完整持续负载。release candidate CI 已在 macOS 和 Linux 调用整个原测试，守卫拒绝 Mac-only、echo 和过滤到零案例；实际执行与原失败归[当前进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-当前-terminal-安装与维护链)。该 Linux 测试环境不接入默认 Shell，普通 Shell 保留宿主执行语义。

## 发布引擎与双发行包选择

`release:build` 默认生成 `dist/unified-terminal`，`release:build --product native` 生成完整 Native。`release:verify --source-commit <40位提交> --clean-source true` 核实际源提交及 clean 事实；参数在任何制品/Profile I/O 前验证，dirty-source 候选不能称正式发布。

Terminal manifest 的 `sqlite` 固定 driver、linkage、实际 version/sourceId 与 engine manifest SHA。macOS builder 从明确 `--sqlite-library` 或有限构建依赖位置复制已审查库，验证实际引擎和仅系统动态依赖；安装运行只选择包内库。Linux/Windows 固定 Bun 实际 builtin 引擎，未知 sourceId 或未证明 WAL 修复拒绝构建资格，不按版本大小或“最新”放行。当前本机包内库为 SQLite 3.51.3；Node/Electron 私有库单独绑定。selection 缺失、损坏、篡改和第一 Database 后迟设置均拒绝；不存在资产的开发模式只提供 unqualified 诊断。

标准安装前门可显式登记完整 Native 闭包。双方 prefix 的 nonce/active/managed marker 与完整 manifest 必须一致；坏登记直接拒绝。升级/回滚仅更新自己仍拥有的登记，卸载仅以原 nonce 撤销，不删除另一安装后写入的登记。已有进程保持原候选与使用锁。源码/显式 candidate 不参与自动登记选择。操作与恢复限制见[Native owner](../../desktop/docs/native-release.md)。

真实当前引擎测试覆盖 source-free 默认 sidecar、两个 Worker、24 次并发 WAL 写、准确备份/恢复至新 Store 和 cold readonly/preflight。新注册资格使用 fresh 完整候选与 80×24 TUI，Provider 3，三条原 Command→Run 均 completed；损坏 nonce、运行中卸载 busy、cold 原 scope/bytes/cursor 与卸载恢复分别核实。旧源码 Apple SQLite 3.51.0 读取该 WAL 的真实 `SQLITE_CANTOPEN` 已保留，未通过删除 WAL 或改 journal mode 掩盖；该源码引擎不属于正式候选资格。

包内选择、准确 sourceId 与 Worker 不重复设置 loader 的原因见[SQLite 引擎决定](../../../.agents/notes/implemented/architecture/2026-10-04-selected-sqlite-engine-and-worker-identity.md)。Windows private Profile 与普通 Workspace scope 的实现/待验边界见[路径策略提案](../../../.agents/notes/proposed/architecture/2026-10-04-windows-private-and-workspace-scope-paths.md)，不能据 POSIX 邻接放行 Windows 制品。
