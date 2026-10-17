# Windows Main 独立使用权

候选 factory 把原 manifest SHA 绑定实际候选 ID，独立核每份原文件的完整 SHA；原 owner 每次 verify 还重新枚举准确文件、祖先目录及声明空目录，拒绝未知、缺项、改类型或 reparse。初始 Node 完整内容／语义验证保留，Main 后续只复用自身 genuine owner 的持续 read/no-write/no-delete pin、原 identity、有效 ACL、闭合库存和双 SH；配套 Service 仍独立完整准入。构建使用静态 CRT 与 `/O2`，不新增运行期入口或测试 export。新增活句柄期间创建未知子项的[真实原实现反例](../../test/isolated/windows-node-access.test.ts)使用独立 C++ 测试制品，不绕过正式 factory 的父进程／证书门禁。

本地 DOS 输入仍先按原规则拒绝设备/UNC、相对、dot、歧义后缀与非法组件。内部文件 API 使用 extended-length 前缀，支持完整 npm 清单和私有 Profile 的长路径，不依赖 Electron manifest 或机器注册表；最终路径仍去除系统前缀后逐字核原 canonical 路径。命名管道证书不经过该适配，ACL、FileID、reparse/单链接、共享和关闭门禁保持。真实长路径与设备输入反例进入[原 Node-API 测试](../../test/isolated/windows-node-access.test.ts)，理由归[原对象决定](../../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)。

原 HANDLE 的 owner/DACL 现以 `GetKernelObjectSecurity` 读取 self-relative descriptor，逐项保留原 SID、DACL/control、ACE 与有效 grant 策略。C 前门、Node-API 与 Bun 采用相同查询语义；继承标志的高层展示差异不能授予额外权利，实时 ACL 变化仍由原对象/当前探针拒绝。Main 的独立 SH、完整内容核验和原资源关闭门禁保持，取舍归[闭包成本决定](../../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)。

[固定 Node-API source](access.cc)为 Windows x64 Main 提供 `artifactShared(root)`、`profileShared(dataRoot,profile)` 和 `candidateShared(root,prefix,id,files,handoff)`。它们自己派生固定 sibling/coordination lock，固定 byte 0/length 1 的真实 LockFileEx SH；不接收 arbitrary HANDLE、lockPath、mode、SID 或 ACL。正式 candidate 用 prefix 外 outer ID／inner SHA 两个独立 use 键；Main 与配套 Bun Service 分别取得自己的 SH，继承/DuplicateHandle 不作为 Windows 锁所有权。

Profile factory在 Main 启动 child 前核 canonical dataRoot、原 current SID 私有目录/锁与 restore journal，固定 SHA256(dataRoot + NUL + profile) 协调键。新 namespace只使用 private CREATE_NEW descriptor，既有不安全对象拒绝且不修 ACL；没有打开 core/UI 数据库。Artifact factory采用公共可读候选政策，root/parent核 current SID owner及DACL，current SID、SYSTEM、Administrators之外只允许读/执行；保留整个原祖先 HANDLE，拒绝 reparse、link/identity漂移和delete sharing。原 sibling锁仍要求严格private普通单链接对象。

Node hash 读取完成到 `require(path)` 之间不能自行绑定原 Windows 对象。正式安装前门现在由原生 C 固定并 pin 自身及 compiled verifier，verifier 在 Electron 创建前取得完整 outer/inner 原文件和双 SH；Main 在该加载保护下调用 candidate factory，独立核全部大小／EOF／SHA／ACL／FileID／空目录，再取得自己的双 SH。C→Bun与Bun→Main 各提供32字节原创建证书，闭合 handoff 只有两个私有地址；factory 从管道取得实际 server PID、原进程 HANDLE／FILETIME与固定稳定映像，证书分别绑定实际原 helper 和当前 Main。PPID 由创建者指定并不足以授权。缺 handoff 仍拒绝 `native_windows_bootstrap_unqualified`，假的同 marker/映像不放行。

Main 在 BrowserWindow、Profile/UI SQLite 和 child 前取得 candidate 使用权，并在 child bootstrap 期间保持自己的 SH；成功 child 必须有实际 Store 身份，诊断失败不作 Profile 持锁证明。数据库和所属 child 确认关闭后才关闭 Main lease，所有 fresh probes／pipe event／OVERLAPPED／原文件先确认关闭再释放双 SH。cancel/timeout不作原 I/O 终止证明；explicit close失败保留尚未关闭的原资源。原child EOF/退出只释放child自己使用权，SIGKILL由OS释放该 process 的HANDLE；没有常驻broker，原POSIX Node→Bun fd协议保持。受控后端fixture仍不构成 installed/fullNative 资格。

祖先HANDLE请求FILE_TRAVERSE以真实阻止rename；属性读取不作为使用期pin。锁文件仅以GENERIC_READ运行LockFileEx SH，与完整只读candidate pin兼容，UI数据库保持原READ/WRITE。JS [原Main facade](../../electron/windows-native-candidate.ts)只允许WeakMap内原live owner向配套启动器借用，绑定同root/id/entry/Bun/build，原Service退出未兑现时close拒绝。Node适配器保私有管道并让Windows Service脱离libuv默认强杀Job，Main异常死亡后仍实际EOF清理。取舍与反例归[原对象决定](../../../../.agents/notes/implemented/bug-fix/2026-10-17-windows-original-object-sharing.md)。

Node-API ABI使用原样的 Node v22.21.1官方四header，默认明确NAPI_VERSION=8；[builder](../../scripts/build-windows-access.ts)核固定SHA，`decltype`引用官方签名，注册使用官方NAPI_MODULE_INIT宏。有限NAPI symbols仅从当前原exe解析；没有PATH/native库fallback或手写Windows/Node结构。builder只接受明确canonical absolute `KITE_WINDOWS_MSVC` 编译器与其已配置SDK环境，/MT静态CRT，输出固定 `windows-access.node`，已装Main不编译代码。缺编译器、资产、symbol或unsupported平台明确拒绝。

显式 `desktop:dev` 在调用 builder 前由[开发环境准备](../../../../scripts/development/windows-desktop-environment.ts)复用完整 x64 环境，或用已安装 vswhere／VsDevCmd 初始化有限构建环境，核实际编译器及 SDK 后设置上述明确路径。它复用 CI 的环境白名单、Unicode 解码与闭合 batch 命令，保持 CI runner 准入和正式 builder 合同；仅修改该次开发进程环境，工具缺失不自动安装。操作与错误归[本地开发](../../../../docs/development/local-development.md)，准备／复用／拒绝证据见[开发入口测试](../../../../tests/isolated/unified-agent/development-desktop.test.ts)。

Windows transport/release CI在真实消费之前调用[有限准备脚本](../../../../scripts/release/prepare-windows-native-ci.ts)，从固定已安装vswhere/VsDevCmd取得x64环境，核实际compiler和SDK文件，只发布构建白名单并清空CL注入变量。CMD Unicode/fatal解码保完整非ASCII路径，不打印环境；不下载工具、不为installed Main发现或编译代码。[完整后端文件](../../test/isolated/windows-node-access.test.ts)已进入Windows transport及release installer-contracts，编译器/资产/ABI缺失不能skip。准确source pin、完整consumer命令和顺序由[CI测试](../../../../tests/integration/scripts/unified-ci.test.ts)核验；准备与静态调度结果不能替代实际后端。

官方依据：[Node v22.21.1 node_api.h](https://github.com/nodejs/node/blob/v22.21.1/src/node_api.h)、[js_native_api.h](https://github.com/nodejs/node/blob/v22.21.1/src/js_native_api.h)、[Node-API](https://nodejs.org/api/n-api.html)、[Electron native modules](https://github.com/electron/electron/blob/main/docs/tutorial/using-native-node-modules.md)、[LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex)。四header的MIT许可保存在[include/LICENSE](include/LICENSE)。

2026-10-17 Windows x64/MSVC/Electron44.3.0实际执行完整后端文件8项通过；包含独立Bun Service与Node Main双SH、私有UI SQLite、父原HANDLE异常终止后的EOF/清理保锁/自然0、GC及无真实broker的拒绝。另两个原Main借用/Node固定argv文件合计三项通过，准确总数与范围归[Native owner](../../docs/native-release.md#windows-managed-native-当前实现)。这些后端资格不授正式Window、installer或完整发布。固定UI路径 `desktop-private/data.sqlite` 的private创建/核验由attached原Profile lease提供，不扩展为任意文件API。准备成功到SQLite关闭的整个lifetime保原Profile和desktop-private目录HANDLE（denyDELETE）、原主DB HANDLE（shareREAD/WRITE、denyDELETE）与volume/FileID；主DB不能当可选sidecar。重复prepare拒绝，verify复核原ACL/regular/single-link；可变WAL/SHM/journal只查当前私有普通文件，不永久钉名称妨碍checkpoint。关闭失败保原未关资源，主DB HANDLE确认关闭后才释放祖先；GC/进程退出只关闭本lease/process原HANDLE。

设计与待验状态见[原生 Main 使用权提案](../../../../.agents/notes/proposed/architecture/2026-10-04-windows-node-owned-profile-and-artifact-leases.md)。当前后端只接 canonical local-drive 路径；UNC/device namespace与ARM64未提供实现资格，不能由此缩写完整平台完成定义。


独立审查指出的UI prepare→SQLite身份窗口沿原retention保持；Windows实际反例仍核同SID替代、原FileID和释放后成功。加载前交接已由固定C和两跳证书接线，不能退回事后hash/manifest或PPID相同。整包构建及上述后端与完整installed正常/切换/维护恢复、发布者认证分开；后者仍未验收，取舍和原边界见[Native创建链决定](../../../../.agents/notes/implemented/architecture/2026-10-10-windows-managed-native-admission.md)。
