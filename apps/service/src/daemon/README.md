# 私有 daemon endpoint 叶子

本目录为显式 daemon 的私有 Service/launcher 接缝；不导入旧 Runtime/barrel，不给公共 browser-safe Client 增加 native 能力。当前仅 endpoint reservation、有限 bootstrap 与原进程身份，尚未装配正式 daemon runner/CLI/restart。Web assets 的独立装配由同目录对应 owner 负责。

`selectDaemonEndpoint` 纯推导短地址：POSIX 固定 canonical 系统 temp 下 current uid 的 0700 namespace，使用 canonical profileAccessKey 的前 32 hex 定位。完整 profile 身份仍在 reservation/bootstrap/HTTP 准入核对，摘要不是授权。默认不读取 TMPDIR；status absent 不创建路径。显式 socket 必须 canonical absolute，按 UTF-8 最多 103 字节，不改投其他地址。共享 temp 必须 owner/sticky 合格，已有私有目录先核 uid/no-link/private 权限，不能 chmod 未知目录。

`reserveDaemonEndpoint` 在 Store 打开前以 wx/no-follow 取得原记录，冻结 canonical profile、真实目录 Workspace、instance/build、自身 PID 与高精度 kernel start。记录不含 token。普通 reserve 不清理旧实例；已有记录为 busy，没有记录却有路径为 identity_unknown。取得 lease 本身不创建数据库或调用 Provider。

`owner.listen({httpEndpoint,token,webOrigin})` 只处理 requestVersion=1、requestId、operation=bootstrap 的单帧闭合请求；最多 16KiB、64 个连接、5 秒等待，不接业务 RPC 或 shutdown。输出固定原 profile/instance/build/httpEndpoint/token/pid/start/workspace/webOrigin，后续由 HTTP Client 核真实 API/state/dataAvailability。启动中缺 socket identity 返回 not_ready，不猜 absent。关闭连接只释放该 native 连接。

POSIX 先通过固定 libc socket/bind 取得 fd，核原 socket 权限并同步调用 libc listen，再公布 socket identity，随后交给 net.listen({fd})；公布身份之前内核已可接入，避免读者把仅 bind、尚未 listen 的窗口误判为 unavailable。net 取得 fd 关闭所有权，但不取得 pathname 自动 unlink 权。Node 与 Bun 的按 pathname listen/close 实测会删除原路径替换文件，因此禁止迁移该方式。原 owner.close 缓存同一 Promise，终止自己的 bootstrap 连接、关闭 fd，再仅移除同原 inode 与完整原记录的路径；drift 保留未知文件和记录。fd 交接过程与并发 close 等待同一 opening，避免双 close。

`clearDeadDaemonEndpoint` 只用于明确离线清理：原 PID/start 必须真实 dead，完整 reservation 与 socket dev/ino 重核未漂移才删除。alive/uncertain/drift 保留，不从端口、旧 PID 数字或同名进程猜测。关闭、清理均不操作 Runtime/Store/其他 profile。

macOS 固定 libproc PROC_PIDTBSDINFO=3，核 136-byte proc_bsdinfo 返回长度/PID，采用 offset120/128 的 uint64 sec/usec；来自本机 SDK 并有 clang 静态断言，禁止 ps 秒精度/timeOrigin fallback。Linux采用 boot ID 与 /proc PID start ticks；读不到身份时仅 ESRCH 能证 dead。Windows 无 current-user pipe DACL 证明，明确 unsupported，未宣称平台资格。

[实际隔离测试](../../test/isolated/daemon-endpoint.test.ts)覆盖真实 Unix listener/有限帧、原身份、两个本机进程竞争、alive/kill/cold dead 清理、私有链接/权限、absent 零写、pathname/record 替换保留、handoff/close、orphan 路径拒绝。全部只用自有临时 profile/进程，无 Model/Tool 或外部凭据。当前 macOS 证据不代替 Linux/Windows 真实资格或正式入口切换。
