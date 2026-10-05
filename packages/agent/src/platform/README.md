# Profile 使用权与平台锁

[纯身份入口](../profile.ts) `@kite-ai/agent/profile` 只使用 Node 模块解析 canonical dataRoot、逻辑 profile、稳定 `profileAccessKey` 和路径，import/select 不创建文件或授予锁。显式宿主入口 [profile-access](../profile-access.ts) 由 Bun 平台运行，import 不 acquire；公开普通 `acquireProfileAccess(options)` 固定 shared，内部维护-exclusive 入口保持独立。

[平台 profile](profile.ts) 在稳定 `.coordination/<profileAccessKey>/profile-use.lock` 上取得 OS 锁，普通 acquire 保持原 namespace 初始化、私有目录、restore journal 和 profile symlink guard。[锁实现](locks.ts) 校验普通文件、非 symlink、单 hardlink、私有权限、宿主 uid 与 path/fd 的 dev/ino 一致。读取和 SQLite 句柄的宿主使用权不能借另一个 Service 进程持锁来代替。

`acquireInheritedProfileAccess({dataRoot,profile,fd})` 专供可信一次性 Bun helper。它只校验已存在的 canonical coordination namespace，不创建新的 namespace/profile；fd 必须准确对应该 profile 的稳定私有锁文件。仅 POSIX darwin/linux 可取得固定 `SH|NB` flock，取得后复核文件并核 journal/profile guard。调用转移的是 helper 所属 fd 副本，任何失败均关闭它；成功返回的 lock release 也只 close。**不得对共享 open file description 执行 LOCK_UN**，否则会提前解除 Node 原 fd 的锁。

Node/Electron 宿主先打开自己的稳定锁 fd，再以 child stdio 映射为 helper 的继承 fd。helper 成功并退出后，锁由 Node 原 fd 持续拥有；正常关闭先 SQLite、后原 fd，helper 失败时宿主也须关闭原 fd。另一个 Service 退出不释放宿主锁。此 leaf 不提供 PID/mtime 锁、常驻 helper、Service 启停、SQLite、配置或执行权限；Desktop 的可信 helper asset 与 Node fd 生命周期由其 owner 实现。

[实际隔离测试](../../test/isolated/profile-access/profile-access.test.ts)使用 Node 原 fd 和真实 Bun helper，验证双 shared、维护-exclusive 拒绝、无关子进程退出、helper close/exit 后原 fd 保持、正常 close 和 SIGKILL 仅释放所属副本，另核 foreign fd、hardlink、宽权限、journal、symlink 和失败 fd 关闭。当前实测环境是 macOS，Node 22.21.1/Bun 1.4.2；Linux 虽有实现分支尚无本轮资格，Windows inherited fd 明确不支持。普通 Windows 原 LockFileEx 与路径安全条件没有改变。

`acquireProfileDataLock(access, 'tui_private')` 是公开 leaf 的固定 TUI 私有数据短写锁能力。只接受平台实际取得、原对象未替换且仍 live 的 shared `ProfileAccess`；复制对象、已关闭 lease、maintenance-exclusive、未知 purpose 都在打开目标前拒绝。取得短锁前重核原共享锁的文件身份、coordination 私有目录、profile路径与恢复journal，固定目标为同一外部namespace的 `tui-private.lock`，以现有平台锁取得 nonblocking exclusive；busy立即失败，不等待、不升级profile权限、不接收任意路径。

短锁复用同一权限、owner、symlink、hardlink与fd/path安全检查，不复制FFI。内部记录它与原共享锁的生命周期：短锁未关闭时，原共享lease release抛 `profile_data_lock_in_use` 并保锁；调用者须在短写操作的finally先release短锁，再关闭原profilelease。短锁成功关闭后才解除该依赖；单独关闭短锁不会关闭共享lease，也不会授予maintenance或SQLite权限。Windows继续要求原显式路径安全端口，本轮新短锁实际资格只覆盖macOS。

[固定短锁测试](../../test/isolated/profile-access/data-lock.test.ts)以同进程独立真实OS描述符核对竞争立即busy、另一profile独立、短锁优先关闭和共享lease保持，以及伪造/closed/exclusive authority、未知purpose、宽权限、links、journal与被修改coordination的拒绝和原字节保留。测试不执行模型、工具或外部进程。

`assertProfileAccess(access)` 复用同一实际 authority、live shared lease、coordination、profile 路径和恢复 journal 检查，不创建短锁、不扩大权限。可信宿主在已有 configuration 文件锁下写终端偏好时，以它核实 profile 使用权仍有效；复制对象或释放后的 lease 不能继续读写。原 `acquireProfileDataLock` 使用同一检查，仍管理自己的固定短锁与父子释放顺序。

## 制品使用权

显式宿主 leaf [artifact-access](../artifact-access.ts) 提供 `acquireArtifactAccess({root,mode})`，校验 canonical、owner 与不可被组/其他用户写入的目录，在候选外的固定 sibling `.use-<basename>.lock` 上复用原 OS shared/exclusive 锁。import 不 acquire；它不授予 Profile、Store 或执行权限。CLI/TUI 与独立 Service 各持自己的 shared lease，卸载者必须取得每个候选的 exclusive lease；退出前不靠另一个进程代持。当前实际资格为 macOS，Linux 与 Windows 不由此推定通过；新 POSIX 安装器与独立 profile 生命周期见[终端 owner](../../../../apps/cli/docs/terminal-release.md)。

Windows Bun 使用独立的 [public candidate scope](windows-artifact-scope.ts)，不把 POSIX mode/uid 当作原生权限证据。候选 root 与 parent 的原 HANDLE owner 必须是当前 Token SID；普通继承读/执行 ACE 可保留，写入、删除、修改权限/owner 和 directory delete-child 仅允许当前 SID、SYSTEM 与 Administrators。未知 ACE 类型、其他主体的写 grant、null DACL、reparse 与不一致的 volume/file identity 拒绝；deny ACE 不抵消不可信 allow，inherit-only grant 也不能把不可信写权交给后续子对象。它不要求私有 Profile 的精确 protected/current-SID-only FA，不修改候选、Workspace 或已有目录的 ACL。

scope 保留已核验的整个原目录祖先链 HANDLE，允许 read/write sharing、拒绝 delete sharing，直到该候选的原 shared/exclusive lease 结束；root/parent 另外复核 owner/DACL。既有固定 sibling lock 仍使用 private 文件策略与真实 LockFileEx。内部 attachment 保留原 FileLock 对象和 live authority；失败只清理自己已经打开的句柄，scope 关闭失败不报告完整释放，后续 release 重试未关闭的资源。原 Profile 父子锁及无 attachment 的 OS 锁释放合同保持。scope 不验证 immutable inventory 或授予执行权限，完整制品校验仍由消费 owner 负责。

本机 [Windows scope 测试](../../test/isolated/artifact-access/windows-scope.test.ts)仅实测 POSIX/Node 惰性 import 与伪造 attachment 拒绝；实际 Windows 的普通读 ACL、原 ancestry rename 阻止、宽写/错 owner/junction/hardlink 拒绝、双独立 Bun holder 生命周期必须在 Windows 执行，不能因 backend 缺失跳过。此实现不补齐 Windows installer、维护或 Node/Electron inherited 使用权。原生权限与共享模式依据 [Microsoft 文件安全与访问权](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)、[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)和 [ACCESS_MASK](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-mask)。


`acquireInheritedArtifactAccess({root,fd})` 为可信一次性 Bun helper 提供固定 shared 使用权。它与普通入口共用 canonical root、原 owner、root/parent 禁止组或其他用户写入与安全 basename 检查；目标仍是固定 sibling `.use-<basename>.lock`，不接任意 lock path、mode、Profile、Store 或执行参数。仅采用 darwin/linux 的 inherited fd；非法 root/alias、foreign inode、symlink、hardlink、宽 lock mode、busy 或 unsupported 平台均关闭 helper 已接管的有效 fd。非法数字 descriptor 在接管前拒绝。

Node/Electron 宿主以 no-follow 打开准确 sibling fd，通过 child stdio 将副本交给 Bun helper。helper 复用原 path/fd dev/ino、uid、private regular/nlink1 检查和 `SH|NB`，成功 release 或退出只 close 自己的副本，绝不 `LOCK_UN`；helper SIGKILL 同样不解除 Node 原 open file description 的 shared lock。宿主必须在实际制品使用结束后关闭原 fd，不能靠另一 Service/helper 代持。helper 失败时宿主另负责关闭其原 fd。这个协议不持续 pin root directory inode，也不验证制品内容 inventory；固定可信 helper 二进制、摘要、真实 launcher scope 和卸载流程仍由消费 owner 核验。

[Artifact 隔离测试](../../test/isolated/artifact-access/artifact-access.test.ts) 使用实际 Node→Bun fd 继承，验证 helper release/exit/SIGKILL、两个 holder 的 close/父 SIGKILL 隔离、same-basename foreign scope、替换 inode、alias/links/mode 与所有有效 fd 失败关闭；源码树外 public `@kite-ai/agent/artifact-access` compiled leaf 的 shared/exclusive probes 亦无 TS fallback。unsupported platform 仅做受控分支关闭反例，不是 Windows 资格。当前真实 OS 资格为本机 macOS；Linux 虽有实现分支尚未在本轮运行，Windows inherited fd 不支持。测试不授予 Profile、SQLite、Model 或执行权限，不代替完整 installer/Native 生命周期验收。


## Shell guardian 与 macOS confinement

[Shell Job owner](../jobs/README.md)负责可信固定 launcher、Seatbelt、资产/目录新鲜度与当前 macOS 资格。guardian 的私有帧承载固定 executable/argv 与可选准确 identity/profile digest，只在派发前复核并直接 spawn；它仍通过原私有 stdin EOF、TERM/KILL 和原组停止证明管理当前宿主进程生命周期。普通 POSIX process-group supervision 不覆盖允许 fork 后的 setsid/daemon 逃逸；confined factory 固定拒绝 fork，才使用其当前本机停止资格。该路径不提供授权、owner takeover、冷 handle 重建、Linux/Windows confinement 或可由 Model 声明的沙箱能力。
