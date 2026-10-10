# Agent Note: Windows managed Native 的加载前创建链与独立使用权

Status: implemented

## Problem

正式 Native 的 Electron Main 必须在加载应用 addon、打开 Profile/UI SQLite 或启动 Service 前，使用准确候选的原文件对象。单次 hash 后关闭文件再加载，不能绑定同一 Windows 对象；继承 helper HANDLE 也不等于 Main 自己取得 LockFileEx 使用权。安装升级还会改变 current，已经接纳的 A 不能借旧证明启动 B，也不能因新选择而撤掉运行中 A 的使用权。

PPID 和出生时间不足以证明实际创建者。[Microsoft UpdateProcThreadAttribute](https://learn.microsoft.com/zh-cn/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)允许为新进程指定另一父进程，因此仅核父 PID、映像路径和存活不能授予正式加载资格。

## Decision

交付范围是 Windows x64 managed Native 的源码准入链。[release build port](../../../../scripts/release/windows-native-build.ts)从固定 source 编译 C 前门和 Bun verifier；[installer](../../../../scripts/release/windows-native-install.ts)的 format=2 marker 固定首次候选的四个稳定 bin：`kite.exe`、`kite-tui.exe`、`kite-desktop.exe`、`native-verifier.exe`。升级和 rollback 切 current/previous，保持原 bootstrap；新启动重新接纳 current。登记 Terminal 的内部 expected-candidate 只收窄该选择，漂移返回 `cli_registration_changed`，不将 A 的证明转授 B。

[原生前门](../../../../scripts/release/native/terminal-launcher.cc)在 Bun 初始化前清除既有运行时注入变量，以原 HANDLE 固定自身、helper 及其祖先，完整核 builder 固定的 helper SHA/size 后才创建 compiled Bun。[第一份证书](../../../../scripts/release/native/native-bootstrap-certificate.h)来自该次 CreateProcess 返回的实际 helper HANDLE；[Bun verifier](../../../../scripts/release/entrypoints/windows-native-verifier.ts)核证书和真实 pipe server，再取得所选候选 outer/inner 全文件 pin 与双 SH，之后才创建 Electron。第二份证书绑定该次实际 Electron child HANDLE。[Main candidateShared](../../../../apps/desktop/native/windows-access/access.cc)核两份固定 binary 证书、真实管道进程身份、原 FILETIME 和 marker 固定映像文件，并取得自己的完整文件 pin 与双 SH。pipe 名称不是秘密或授权；PPID 仅参与定位，不替代实际创建证书。

outer 使用候选 ID，inner 使用 `SHA256(ID + NUL + "terminal")`，两锁位于安装 prefix 外的固定私有协调 namespace。Main 自己执行 SH acquire；[配套 Service](../../../../apps/service/src/windows-paired-artifact.ts)独立核完整候选并取得自己的使用权。任何一个 holder 退出不证明另一 holder 已结束。原文件、进程、pipe、overlapped I/O 和 fresh probe 在成功关闭前保持 owner；关闭未知不交出 SH，全部所属文件资源确认关闭后才释放使用权。

加载器同样属于前置边界。固定 C/Bun/helper 使用 System32，Electron 新副本的静态依赖只使用完整已 pin 的应用目录和 System32；PE/import/LoadConfig 或 delay-import 不符合要求就拒绝，不修改 publisher 原文件。[Microsoft DEPENDENTLOADFLAG](https://learn.microsoft.com/en-us/cpp/build/reference/dependentloadflag?view=msvc-170)说明了静态依赖搜索限制；父进程运行后调用 SetDefaultDllDirectories 不能充当尚未运行的 child 的静态加载证明。完整当前实现以 [Native release owner](../../../../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)为准。

## Alternatives considered

- 继承／DuplicateHandle：保留父对象不等于 Main 本进程获得 LockFileEx SH；采用各消费者独立 acquire，父的加载前 pin 只覆盖交接窗口。
- PID-only 或 PPID＋birth＋映像：可指定父进程，不能证明该父实际创建此 child；保留原进程 HANDLE核验，再要求两跳证书来自实际创建返回的 HANDLE。
- Main 事后 hash／manifest：addon 已加载之后再核无法消除 hash→load 的对象替换窗口；采用原生前门先固定加载文件、Bun 完整接纳后创建 Electron，再交 Main 独立所有权。

## Consequences

本决定部分替代[原 Main Profile/Artifact 使用权提案](../../proposed/architecture/2026-10-04-windows-node-owned-profile-and-artifact-leases.md)中“所有正式 Windows candidate 一律前置拒绝、尚无加载前根”的描述。缺交接或错误证书仍拒绝；raw directory launch 的 Windows 限制保持，正式 desktop 前门当前只接受无附加用户参数的启动。原提案的 Profile 私有文件、独立锁和原生资格要求仍适用，继续 proposed。

`implemented` 仅表示上述源码决定已交付。本机类型、字节契约与 POSIX 邻接证据不证明 Windows syscall、MSVC、真实 Electron 分发符合 PE guard、安装／窗口／维护恢复或准确退出资格。Windows/Linux 原生资格按用户顺序留到重构后；签名、publisher 认证及完整平台发行仍未取得。本决定不改变业务恢复、权限或发布授权，也不宣布整体 V1.3 完成。
