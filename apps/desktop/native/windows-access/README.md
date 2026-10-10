# Windows Main 独立使用权

[固定 Node-API source](access.cc)为 Windows x64 Main 提供 `artifactShared(root)`、`profileShared(dataRoot,profile)` 和 `candidateShared(root,prefix,id,files,handoff)`。它们自己派生固定 sibling/coordination lock，固定 byte 0/length 1 的真实 LockFileEx SH；不接收 arbitrary HANDLE、lockPath、mode、SID 或 ACL。正式 candidate 用 prefix 外 outer ID／inner SHA 两个独立 use 键；Main 与配套 Bun Service 分别取得自己的 SH，继承/DuplicateHandle 不作为 Windows 锁所有权。

Profile factory在 Main 启动 child 前核 canonical dataRoot、原 current SID 私有目录/锁与 restore journal，固定 SHA256(dataRoot + NUL + profile) 协调键。新 namespace只使用 private CREATE_NEW descriptor，既有不安全对象拒绝且不修 ACL；没有打开 core/UI 数据库。Artifact factory采用公共可读候选政策，root/parent核 current SID owner及DACL，current SID、SYSTEM、Administrators之外只允许读/执行；保留整个原祖先 HANDLE，拒绝 reparse、link/identity漂移和delete sharing。原 sibling锁仍要求严格private普通单链接对象。

Node hash 读取完成到 `require(path)` 之间不能自行绑定原 Windows 对象。正式安装前门现在由原生 C 固定并 pin 自身及 compiled verifier，verifier 在 Electron 创建前取得完整 outer/inner 原文件和双 SH；Main 在该加载保护下调用 candidate factory，独立核全部大小／EOF／SHA／ACL／FileID／空目录，再取得自己的双 SH。C→Bun与Bun→Main 各提供32字节原创建证书，闭合 handoff 只有两个私有地址；factory 从管道取得实际 server PID、原进程 HANDLE／FILETIME与固定稳定映像，证书分别绑定实际原 helper 和当前 Main。PPID 由创建者指定并不足以授权。缺 handoff 仍拒绝 `native_windows_bootstrap_unqualified`，假的同 marker/映像不放行。

Main 在 BrowserWindow、Profile/UI SQLite 和 child 前取得 candidate 使用权，并在 child bootstrap 期间保持自己的 SH；成功 child 必须有实际 Store 身份，诊断失败不作 Profile 持锁证明。数据库和所属 child 确认关闭后才关闭 Main lease，所有 fresh probes／pipe event／OVERLAPPED／原文件先确认关闭再释放双 SH。cancel/timeout不作原 I/O 终止证明；explicit close失败保留尚未关闭的原资源。原child EOF/退出只释放child自己使用权，SIGKILL由OS释放该 process 的HANDLE；没有常驻broker，原POSIX Node→Bun fd协议保持。受控后端fixture仍不构成 installed/fullNative 资格。

Node-API ABI使用原样的 Node v22.21.1官方四header，默认明确NAPI_VERSION=8；[builder](../../scripts/build-windows-access.ts)核固定SHA，`decltype`引用官方签名，注册使用官方NAPI_MODULE_INIT宏。有限NAPI symbols仅从当前原exe解析；没有PATH/native库fallback或手写Windows/Node结构。builder只接受明确canonical absolute `KITE_WINDOWS_MSVC` 编译器与其已配置SDK环境，/MT静态CRT，输出固定 `windows-access.node`，已装Main不编译代码。缺编译器、资产、symbol或unsupported平台明确拒绝。

Windows transport/release CI在真实消费之前调用[有限准备脚本](../../../../scripts/release/prepare-windows-native-ci.ts)，从固定已安装vswhere/VsDevCmd取得x64环境，核实际compiler和SDK文件，只发布构建白名单并清空CL注入变量。CMD Unicode/fatal解码保完整非ASCII路径，不打印环境；不下载工具、不为installed Main发现或编译代码。[五个强制后端案例](../../test/isolated/windows-node-access.test.ts)已进入Windows transport step，编译器/资产/ABI缺失不能skip。准确source pin、完整consumer命令和顺序由[CI测试](../../../../tests/integration/scripts/unified-ci.test.ts)核验；当前本机18项80断言仅证明纯准备与静态调度，实际Windows编译尚未执行。

官方依据：[Node v22.21.1 node_api.h](https://github.com/nodejs/node/blob/v22.21.1/src/node_api.h)、[js_native_api.h](https://github.com/nodejs/node/blob/v22.21.1/src/js_native_api.h)、[Node-API](https://nodejs.org/api/n-api.html)、[Electron native modules](https://github.com/electron/electron/blob/main/docs/tutorial/using-native-node-modules.md)、[LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex)。四header的MIT许可保存在[include/LICENSE](include/LICENSE)。

本实现尚未经过实际Windows MSVC编译/Node或Electron执行。类型、header契约与macOS/POSIX邻接不能证明Windows ABI、原始对象权限或独立Main/Service生命周期；实际原生测试必须在Windows执行，不能因backend缺失跳过。固定UI路径 `desktop-private/data.sqlite` 的private创建/核验由attached原Profile lease提供，不扩展为任意文件API。准备成功到 SQLite 关闭的整个 lifetime 保留原 Profile 与 desktop-private 目录 HANDLE（denyDELETE）、原主数据库 HANDLE（shareREAD/WRITE、denyDELETE）与原 volume/FileID；主数据库必须存在且原 HANDLE/现路径都匹配同一实体，不能将主 DB 当可选 sidecar。重复 prepare 明确拒绝，verify 复核原 ACL/regular/single-link；可变 WAL/SHM/journal 仅检查当前私有普通文件，不永久钉其名称妨碍 checkpoint。关闭失败保留未关原资源，主 DB HANDLE 关闭成功后才释放原祖先目录；GC/进程退出只关闭本 lease/process 原句柄。与正式Window、installer、维护和完整平台发行资格分别核对。

设计与待验状态见[原生 Main 使用权提案](../../../../.agents/notes/proposed/architecture/2026-10-04-windows-node-owned-profile-and-artifact-leases.md)。当前后端只接 canonical local-drive 路径；UNC/device namespace与ARM64未提供实现资格，不能由此缩写完整平台完成定义。


独立审查指出的 UI prepare→SQLite 身份窗口沿原 retention 保持；Windows 强制反例仍核同 SID 替代、原 FileID 与释放后成功。加载前原对象交接已由上述固定 C 与两跳证书接线，不能退回事后 hash/manifest 或以 PPID 相同替代。实际原生构建、完整 installed 正常／切换／维护恢复链及发布者认证仍未验收，取舍和原未闭合边界见[Native 创建链决定](../../../../.agents/notes/implemented/architecture/2026-10-10-windows-managed-native-admission.md)。
