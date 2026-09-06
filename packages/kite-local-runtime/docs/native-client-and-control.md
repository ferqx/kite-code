# Native 连接与 App Control

入口：[App Server client](../src/client/app-server-client.ts)、[凭据写入接口](../src/client/connection.ts)、[stdio](../src/client/bun-stdio-child-transport.ts)、[socket](../src/client/node-socket-transport.ts)、[App Control](../src/client/protocol-app-control.ts)。

默认客户端由 release composition 启动配套 child，经 stdio 配对。显式 daemon 使用 owner-only Unix socket/Windows named pipe；两条路径都不能通过发现未知进程代替明确连接意图。

prepareAppControl 调用 RuntimeClient.connect，先初始化唯一协议连接以访问工作区信任和配置控制面；确认 canonical workspace 与 external-read scope 后才提交 Runtime mutation。后续 connect 复用已初始化的连接，不做第二次握手。App Control codec 和 Native credential 操作各有精确接口，不把配置 repository 或 raw key交给 TUI。

## 配置写入与进程资料

[config](../src/config/) 的 per-file lock 在锁内重读，再 atomic replace；它是共享 filesystem primitive，不定义 Provider 或权限语义。Service 状态 primitive 处理本机路径、权限和 process identity，不创建第二份 Session authority。

coordinator 目录仍有被当前 composition 消费的本机机制；不能因为保留源文件就恢复旧 per-Workspace Worker 进程拓扑。当前组合关系以 Service 入口为准。

连接错误、版本不匹配、工作区不符都在准入边界失败；不 fallback 到 embedded Runtime。验证：[Native tests](../test/)、[config lock](../test/isolated/config-file-mutation-lock.test.ts)。
