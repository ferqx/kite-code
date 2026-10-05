# Agent Note: Windows Main 与配套 Service 各自持有使用锁

Status: proposed

## Problem

Native Main 和配套 Service 都会使用同一安装候选及 Profile。只要其中任一进程仍在使用，维护、更新和卸载就不能取得排他权；一个进程退出不能释放另一个进程的真实使用权。既有 POSIX 实现由 Node 保原 FD、一次性 Bun helper 在继承副本取得 flock，依赖 open-file-description 生命周期。

Windows 的 LockFileEx 具有不同的进程归属。[Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex)说明，继承锁定文件 HANDLE 不授予子进程对原锁定范围的访问权；进程终止或关闭持锁文件会释放其锁。因此不能把 helper、继承 HANDLE 或 DuplicateHandle 当作 Main 已取得自己的锁。Main 使用 Electron Node，不能加载 Bun FFI。此问题独立于已有的私有 ACL 与公共候选目录策略。

## Proposal

在当前 V1.3 发行闭包内增加有限 Windows x64 Node-API 资产，由 Main 自己执行固定 byte 0、length 1 的 LockFileEx shared acquire。它只提供 Profile 与 Artifact 两个 factory，派生原协调键和锁路径，核实际 current SID、原 HANDLE、ACL 和文件身份；不接收任意 SID、ACL、HANDLE、lockPath 或 lock mode。Service 继续沿 Agent 原生后端自行取得另一个 SH，不接纳 Main 的锁句柄。

Main 在启动 child 前持有原候选 outer/inner 及 Profile SH，保持到私有 UI 数据库、网络和所属 Service drain 完成。原 startup/bootstrap 保留实际 build、profile、token 和 instance 核对，只有 child 的 Store 实际打开成功才算准备就绪；诊断模式的失败 bootstrap 不能代替持锁证明。父、子各自关闭自己的 HANDLE，任一 SIGKILL 不代表另一 holder 已结束。

固定 `.node` 字节由既有 manifest、SHA 和资产 inventory 验证。构建使用原样 Node v22.21.1 官方四个 Node-API header 和许可，明确 NAPI_VERSION=8；官方声明提供函数类型和注册宏，有限 symbol 从当前原 executable 解析。Windows builder 要求明确 canonical MSVC 与已配置 SDK 环境，缺资产、编译器或 symbol 明确失败，已安装入口不编译或回退源码/PATH。此方案参考 [Electron 原生模块说明](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)，实际 Electron ABI 仍须本平台运行核实。

当前负责位置是 [native owner](../../../../apps/desktop/native/windows-access/README.md) 与 [固定 builder](../../../../apps/desktop/scripts/build-windows-access.ts)。源码和 header 契约已部分实现，本提案尚未取得 Windows MSVC、实际 Electron/Service 或完整私有 UI 文件生命周期资格；保持 proposed。它不代替 [Profile/Workspace 分角色策略](2026-10-04-windows-private-and-workspace-scope-paths.md)、[Artifact 发布策略](2026-10-04-windows-artifact-handle-publication.md)，也不宣布维护或 installer 已支持。

## 当前实现与加载根限制

有限 Node-API source、固定 header/build、两factory、闭合资产及平台接缝已部分实施。独立审查发现私有UI prepare原先未在 SQLite open/整个 lifetime 保原目录与主DB对象，现保留原 Profile/desktop-private 目录 HANDLE、原主数据库 shareREAD/WRITE且denyDELETE HANDLE 和 volume/FileID，SQLite关闭后才释放。主DB必须存在并与原HANDLE/现路径匹配；WAL/SHM/journal只作当前私有sidecar检查，不永久钉名称影响checkpoint。关闭失败保未关资源，重复prepare拒绝；本机类型或源码review不是Windows syscall资格。

另一窗口仍未关闭：Node完成 `.node` hash读取后关闭FD，再 `require(path)`，两者没有绑定原Windows对象。在addon自身加载之前无法用其factory保denyDELETE HANDLE；事后重hash或新manifest已经太晚。正式candidate Main因此在本应用addon/SQLite/factory/child加载前拒绝 `native_windows_bootstrap_unqualified`，没有formal环境bypass。直接owned后端fixture只能证明有限候选，不作为installed/fullNative放行。

macOS的实际Node消费者负例核formal guard下nativeLoads/factories/children/appReads全零；两文件3项21断言通过，另5个Windows强制案例本机未执行。实际MSVC、Electron ABI、原文件权限和双holder全生命周期仍待本平台证据，提案继续proposed。加载前可信根需要实际原生启动器/发布者或可证明同对象的OS方案；当前未宣称已实施签名、publisher或完整installer。

## 当前 CI 编译准备

Windows transport的五个mandatory backend cases与release Native build已接同一[有限Bun准备脚本](../../../../scripts/release/prepare-windows-native-ci.ts)。固定预装vswhere/VsDevCmd取得x64 host/target，compiler使用与builder相同的实际canonical path，核SDK header/library；不自动下载或从PATH发现编译器。构建环境仅十个白名单变量与明确compiler，CL/_CL_清空，完整环境不进入日志。CMD以/u的Unicode输出和fatal UTF-16LE解码保完整非ASCII值，vswhere独立fatal UTF-8；坏字节、冲突重复值和缺事实拒绝。

准确PR head/repository、完整历史、准备先于消费及完整三文件原生测试命令由CI guard核验；仅echo路径或过滤到零case不能作证。本机纯准备/CI/workspace三文件18项80断言通过，实际Windows编译/Node/Electron syscall仍未运行。CI所记录compiler SHA与版本只定位当前工具字节，不能填补Main hash到require的加载根，也不证明publisher或完整Native发行；本提案继续proposed。

## Alternatives considered

- 复用一次性 Bun helper 加继承/DuplicateHandle：不是 Windows Main 自己取得的 LockFileEx 权威，无法提供所需的进程独立生命周期。
- 常驻锁 broker：需要新增独立权威、通信和失败清理；当前既有 Main/Service 生命周期已能表达两个 holder，不为这个有限需求增加第三个常驻进程。
- JS marker、PID 文件或独占创建锁文件：不能证明原 OS 锁仍由准确进程持有，且退出和维护竞争不能复用现有排他检查。
- 在 Electron Node 直接导入 Bun FFI：运行时不支持，不能将 TypeScript import 成功当作原生调用资格。
- 暴露通用 native HANDLE/锁 API：扩大可信边界，允许 caller 提供路径或权限；采用固定 factory 和本进程原句柄。
- 新增 node-gyp 与自动下载 builder：本窗口使用已有官方 header 固定资产和显式编译器，避免引入未经固定的构建依赖；不据此假定 custom symbol 解法已在 Electron 通过。
- 从PATH查cl或把完整SET环境转储进后续step：不能满足既有builder的明确canonical compiler合同，也把无关环境带入证据；采用固定预装安装器、有限SDK事实与白名单，缺工具仍失败。

- Node公共fs打开原FD后将其视作denyDELETE能力：公共API不提供此Windows分享模式，不能证明hash到require仍是原对象。
- 将已hash资产复制到私有目录或先由Bun helper hash再spawn：复制件仍有相同hash→load窗口，helper自身也需加载前根信任，不能循环证明；保formal拒绝，不把helper/继承HANDLE当Main SH。

## Acceptance criteria

实际 Windows x64 必须在源码树外的固定 Native 制品中运行 Electron Main 与 Bun Service，核两个候选 root、原 Profile 和私有 UI DB 的独立 SH。child admission/EOF/drain 未完成时 Main 保持自己的使用权；任一 parent/child 正常退出或 SIGKILL 后，仍活 holder 继续阻止 EX，最后准确 holder 关闭后才允许维护。

manifest、nonce、addon SHA、foreign Profile key、错误 root、宽 ACL、hardlink、reparse 与未完成 restore journal 都必须明确拒绝且不修原对象，不创建替代锁或空数据库。固定 UI 数据库/WAL/SHM 的私有创建与核验必须实际证明。原 POSIX close-only FD、双 holder 和 Node→Bun 生命周期继续通过。

类型、header 编译契约和 macOS 邻接只证明各自断言；实际 Windows 案例不得因 backend 缺失跳过，也不能由普通 Node 加载替代 Electron 资格。签名、发布者认证、完整 installer、维护和三平台发行条件分别保留。

## Risks

新增原生资产需要固定编译器、SDK、Node-API 和 Electron 闭包证据。当前只限 Windows x64；实际 syscall、权限和 image 生命周期尚未执行，不能据源码放行平台能力。OS 对终止进程锁的释放可能有延迟，维护方仍必须实取 EX，不能凭已退出 PID 推导成功。Profile 创建仅建立固定私有协调 namespace，不授予业务数据库初始化或旧数据迁移权。
