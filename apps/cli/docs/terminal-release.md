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

manifest 中声明的裸 npm 名称必须按包自己的实际解析位置复制，即使与 builtin 同名；`punycode` 包的 `punycode/` 调用不由 runtime builtin 代替。只省略显式 `node:`/`bun:` 依赖，必需包缺失拒绝构建，不从 builtin 名称推导可用。实际候选 JSDOM/parser 的运行资格与文件清单完整性分别核验。

[完整选择器](../host/terminal-artifact.ts)核对闭合 manifest、native platform/arch、每个文件大小/SHA256/mode、目录祖先与链接实际目标。未知文件、空目录、外部 hardlink、循环或外部 symlink、缺失资源与篡改均拒绝。manifest 的 source commit/dirty 是构建诊断；完整制品身份由 manifest 和它约束的字节给出。清单及 archive sidecar 均未签名，完整性不能等同发布者身份或生产资格。

[归档器](../../../scripts/release/terminal-archive.ts)只写普通 tar 文件，链接以 manifest 声明保存。解包先核明确传入的 archive SHA，再拒绝 traversal、真实 tar link、重复路径、坏 PAX 与文件/链接祖先冲突；重建已核对的内部链接后再次完整验证。默认解压字节上限 1 GiB，API 可明确指定其他正整数；这是外部归档输入边界，不是 Agent 执行额度。归档/sidecar 使用排他创建，拒绝覆盖既有文件或链接。归档与安装输出不能位于输入候选内部，包括现存祖先别名。

## 安装生命周期

安装器使用独立 `.install.lock`、managed marker、`releases/<candidateId>` 和唯一两行 `active` 文件；两行分别为 current 与 previous。新候选在独立 stage 复制、完整校验，文件和目录自底向上 fsync 后 rename，同步 releases，再持久发布 active。新安装根的父目录项也同步。已存在候选只复验，不原地覆盖；失败前已经存在的 active 不被改成未校验候选。

stable shell launcher 固定一次 active，清除 NODE_PATH/NODE_OPTIONS/BUN_OPTIONS/ELECTRON_RUN_AS_NODE 后执行候选内 Bun 和固定入口。实际业务启动取得候选 shared 使用锁再验证，生命周期内不重读 active。纯帮助、版本、trace 和 TUI 非终端拒绝保持在完整验证与 profile 创建之前返回。独立 Service/daemon wrapper 也持有自己的同候选 lease，因此 CLI 退出后 daemon 仍阻止卸载。锁实现见 [Agent 平台 owner](../../../packages/agent/src/platform/README.md)。

升级只影响后续启动，原进程保持原 candidate。回滚完整验证 previous 后交换指针；它不恢复旧数据库或回放业务意图，本轮只验证相同新基线格式的候选组合，不宣称任意未来格式均可回滚。用户应先通过原实例的公开 `server stop` 结束要卸载的 daemon。卸载完整枚举已管理内容、拒绝未知条目/坏 active/坏候选，取得所有候选 exclusive 使用锁后重命名安装根再删除；任何 live lease 都立即拒绝，不强杀或猜测进程。独立 profile 数据保留。

## 验证边界

当前真实资格为 macOS arm64、Bun 1.4.2：搬迁后删除原输出、独立 HOME/PATH、两个安装入口、固定模型一次实际 Run、SQLite Worker 读回原历史、共享 daemon/TUI PTY、升级/回滚原实例固定、live 使用时拒绝卸载、停止后卸载和独立用户数据保持。测试入口：

- [真实 bundle 与生命周期](../../../tests/isolated/unified-agent/terminal-bundle.test.ts)
- [真实代码升级与冷回退](../../../tests/isolated/unified-agent/terminal-cross-version.test.ts)
- [安装负例](../../../tests/isolated/unified-agent/terminal-install.test.ts)、[归档负例](../../../tests/isolated/unified-agent/terminal-archive.test.ts)
- [依赖闭包](../../../tests/isolated/unified-agent/terminal-dependencies.test.ts)、[完整选择器](../../../tests/isolated/unified-agent/terminal-artifact.test.ts)

原 bundle 生命周期测试的升级候选由同一实际 bundle 改 productVersion 产生，只证明指针机制。独立跨代码版本测试使用固定新基线提交 `3140fe6d37131050033c66ffd9637fe7cd967da9` 的原源码和原 builder，与当前源码分别生成完整候选；两者 productVersion 均为 `0.1.0`，实际 Agent 字节与 candidate ID 不同。[旧候选物化夹具](../../../tests/fixtures/unified-agent/terminal-predecessor.ts)先核相同锁文件、八 workspace 清单、补丁及 format=1 SQL 基线，复制当前准确已安装 npm 依赖并将 workspace 链接指向旧源码，旧 builder 的闭包守卫保持；构建后删除旧源码，再归档、搬迁和删除原候选输出。它证明本地真实代码组合，不代表已发布 predecessor 或 npm 发布来源资格。

实际安装前门依次完成 A 任务、升级 B 后新任务、正常停止后回退 A 并冷读 B 的完整正文、A 继续原会话、再切换 B 冷读全部原记录。公共 Client 与各自候选内只读 Store 核同一 Store、原 Command/Run/Model 身份和正文/ref/hash；352041 UTF-8 字节 Unicode 正文也完整进入回退后的新模型请求。冷 GET 不增加模型请求或持久游标，四次启动为不同实例；公开 stop 核准确 PID/startIdentity 已退出、全部安装候选 EX 可取，卸载保留原数据库 inode、完整字节和配置。没有恢复旧数据库。当前本机有限验收1pass/335assert，原失败和阶段完整默认结果归[进度](../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07terminal-真实代码升级与冷回退)。

上述新测试沿默认 isolated 每文件进程、进程内 concurrency=1 运行，可与其他隔离文件共享槽；构建输出、旧 clone、reader、安装和数据均位于自有临时根。当前安装分支支持 POSIX，Linux 尚待真实资格，Windows 安装明确拒绝。Native 跨代码冷回退、已发布旧样本、断电恢复、平台签名、生产 sandbox/exporter、全部平台资格及完整 T/E 仍未由本机 Terminal 组合证明。

## 发布引擎与双发行包选择

`release:build` 默认生成 `dist/unified-terminal`，`release:build --product native` 生成完整 Native。`release:verify --source-commit <40位提交> --clean-source true` 核实际源提交及 clean 事实；参数在任何制品/Profile I/O 前验证，dirty-source 候选不能称正式发布。

Terminal manifest 的 `sqlite` 固定 driver、linkage、实际 version/sourceId 与 engine manifest SHA。macOS builder 从明确 `--sqlite-library` 或有限构建依赖位置复制已审查库，验证实际引擎和仅系统动态依赖；安装运行只选择包内库。Linux/Windows 固定 Bun 实际 builtin 引擎，未知 sourceId 或未证明 WAL 修复拒绝构建资格，不按版本大小或“最新”放行。当前本机包内库为 SQLite 3.51.3；Node/Electron 私有库单独绑定。selection 缺失、损坏、篡改和第一 Database 后迟设置均拒绝；不存在资产的开发模式只提供 unqualified 诊断。

标准安装前门可显式登记完整 Native 闭包。双方 prefix 的 nonce/active/managed marker 与完整 manifest 必须一致；坏登记直接拒绝。升级/回滚仅更新自己仍拥有的登记，卸载仅以原 nonce 撤销，不删除另一安装后写入的登记。已有进程保持原候选与使用锁。源码/显式 candidate 不参与自动登记选择。操作与恢复限制见[Native owner](../../desktop/docs/native-release.md)。

真实当前引擎测试覆盖 source-free 默认 sidecar、两个 Worker、24 次并发 WAL 写、准确备份/恢复至新 Store 和 cold readonly/preflight。新注册资格使用 fresh 完整候选与 80×24 TUI，Provider 3，三条原 Command→Run 均 completed；损坏 nonce、运行中卸载 busy、cold 原 scope/bytes/cursor 与卸载恢复分别核实。旧源码 Apple SQLite 3.51.0 读取该 WAL 的真实 `SQLITE_CANTOPEN` 已保留，未通过删除 WAL 或改 journal mode 掩盖；该源码引擎不属于正式候选资格。

包内选择、准确 sourceId 与 Worker 不重复设置 loader 的原因见[SQLite 引擎决定](../../../.agents/notes/implemented/architecture/2026-10-04-selected-sqlite-engine-and-worker-identity.md)。Windows private Profile 与普通 Workspace scope 的实现/待验边界见[路径策略提案](../../../.agents/notes/proposed/architecture/2026-10-04-windows-private-and-workspace-scope-paths.md)，不能据 POSIX 邻接放行 Windows 制品。
