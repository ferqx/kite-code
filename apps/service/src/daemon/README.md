# 私有 daemon endpoint 叶子

本目录为显式 daemon 的私有 Service/launcher 接缝；不导入旧 Runtime/barrel，不给公共 browser-safe Client 增加 native 能力。正式 runner、CLI start/status/web/stop/restart 和共享 CLI/TUI 已使用本接缝；业务、busy/cancel 与 Store 准入仍由公共 HTTP Client/Service 负责。Web assets 的独立装配由同目录对应 owner 负责。

`selectDaemonEndpoint` 纯推导短地址：POSIX 固定 canonical 系统 temp 下 current uid 的 0700 namespace，使用 canonical profileAccessKey 的前 32 hex 定位。完整 profile 身份仍在 reservation/bootstrap/HTTP 准入核对，摘要不是授权。默认不读取 TMPDIR；status absent 不创建路径。显式 socket 必须 canonical absolute，按 UTF-8 最多 103 字节，不改投其他地址。共享 temp 必须 owner/sticky 合格，已有私有目录先核 uid/no-link/private 权限，不能 chmod 未知目录。

`reserveDaemonEndpoint` 在 Store 打开前以 wx/no-follow 取得原记录，冻结 canonical profile、真实目录 Workspace、instance/build、自身 PID 与高精度 kernel start。记录不含 token。普通 reserve 不清理旧实例；已有记录为 busy，没有记录却有路径为 identity_unknown。取得 lease 本身不创建数据库或调用 Provider。

`owner.listen({httpEndpoint,token,webOrigin})` 只处理 requestVersion=1、requestId、operation=bootstrap 的单帧闭合请求；最多 16KiB、64 个连接、5 秒等待，不接业务 RPC 或 shutdown。输出固定原 profile/instance/build/httpEndpoint/token/pid/start/workspace/webOrigin，后续由 HTTP Client 核真实 API/state/dataAvailability。启动中缺 socket identity 返回 not_ready，不猜 absent。关闭连接只释放该 native 连接。

POSIX 先通过固定 libc socket/bind 取得 fd，核原 socket 权限并同步调用 libc listen，再公布 socket identity，随后交给 net.listen({fd})；公布身份之前内核已可接入，避免读者把仅 bind、尚未 listen 的窗口误判为 unavailable。net 取得 fd 关闭所有权，但不取得 pathname 自动 unlink 权。Node 与 Bun 的按 pathname listen/close 实测会删除原路径替换文件，因此禁止迁移该方式。原 owner.close 缓存同一 Promise，终止自己的 bootstrap 连接、关闭 fd，再仅移除同原 inode 与完整原记录的路径；drift 保留未知文件和记录。fd 交接过程与并发 close 等待同一 opening，避免双 close。

`clearDeadDaemonEndpoint` 只用于明确离线清理：原 PID/start 必须真实 dead，完整 reservation 与 socket dev/ino 重核未漂移才删除。alive/uncertain/drift 保留，不从端口、旧 PID 数字或同名进程猜测。关闭、清理均不操作 Runtime/Store/其他 profile。

macOS 固定 libproc PROC_PIDTBSDINFO=3，核 136-byte proc_bsdinfo 返回长度/PID，采用 offset120/128 的 uint64 sec/usec；来自本机 SDK 并有 clang 静态断言，禁止 ps 秒精度/timeOrigin fallback。Linux采用 boot ID 与 /proc PID start ticks；读不到身份时仅 ESRCH 能证 dead。

Windows x64 使用独立 [endpoint](windows-endpoint.ts)、[pipe](windows-pipe.ts)、[record](windows-record.ts)、[process](windows-process.ts) 和 [security](windows-security.ts) leaf。真实 TOKEN_USER SID 与 OS LocalAppData KnownFolder 决定固定私有 namespace；选择只读，absent 不建目录。默认 pipe 包含完整 SID/profile 摘要，显式地址只接受 `\\.\pipe\kite-daemon-<lowercase-name>` 的本机有限 namespace，拒远端 UNC/HTTP/超长/非canonical名字。record 位置由原完整 pipe 摘要固定，默认与相同显式 pipe 是同一记录；摘要不授予权限。

pipe 在 Store 前取得 FIRST_PIPE_INSTANCE 原 HANDLE，protected 单 current-SID FA DACL、非继承及 remote 拒绝；最多64个 overlapped accept 保原 first HANDLE。客户端逐项读写权不含创建 pipe instance，SQOS IDENTIFICATION、原 server PID 与 kernel birth 共同守卫。16KiB/5秒/单帧和原闭合 JSON 保持。写完后在原期限内等客户端真实关闭再 Disconnect，避免丢弃未读回复；CancelIoEx 仅请求取消，原 GetOverlappedResult 确认后才释放事件、缓冲区和 pipe。

record 以 CREATE_NEW、current-SID protected FA 原对象建立，原普通文件/nlink1/FileID/ACL和全部非reparse父 HANDLE 保留；SH/EX byte-range lock 序列化完整原读取和publish，Flush 后才发布 pipe readiness。删除沿原 HANDLE disposition/严格 Close/实际缺席，不路径 unlink。正常关闭先确认所有 pipe I/O，再删原记录；原资源关闭未知用 trusted marker 强持原 owner 和候选 SH/full pin并保活。Windows进程出生为精确uint64 FILETIME十进制串，stop在原OpenProcess HANDLE上等待真实终止；冷清理仅完整双Toolhelp census的准确PID缺席或不同原birth才证dead，权限/枚举/Close失败保unknown。

[实际隔离测试](../../test/isolated/daemon-endpoint.test.ts)覆盖真实 Unix listener/有限帧、原身份、两个本机进程竞争、alive/kill/cold dead 清理、私有链接/权限、absent 零写、pathname/record 替换保留、handoff/close、orphan 路径拒绝。全部只用自有临时 profile/进程，无 Model/Tool 或外部凭据。当前 macOS 证据不代替 Linux/Windows 真实资格或正式入口切换。

Windows新 [security](../../test/isolated/windows-daemon-security.test.ts)、[process](../../test/isolated/windows-daemon-process.test.ts)、[pipe](../../test/isolated/windows-daemon-pipe.test.ts)、[record](../../test/isolated/windows-daemon-record.test.ts) 与 [完整发现接线](../../test/isolated/windows-daemon-endpoint.test.ts)测试只按各自实际mock/native范围计证据；真实Windows installed全链由[原资格工具](../../../../tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts)调用[完整Daemon helper](../../../../tests/fixtures/unified-agent/windows-daemon-qualification.ts)，保原120秒整链和30秒命令。当前Windows原生DACL、ABI、console/detach、实际候选使用权及完整退出尚未运行，源码接入不宣布平台或阶段退出。
