# 本机服务

Kite Code 使用本机 App Server 承载执行和会话数据。客户端界面、连接和服务进程与会话本身不同。

默认 TUI/CLI 启动配套的 stdio App Server。显式 daemon 提供本机连接入口及 Web 地址；普通浏览器不能启动或升级本机进程。

[生命周期](lifecycle.md)说明启动和停止，[数据与访问](data-and-access.md)说明权限和持久数据，[排障](troubleshooting.md)说明常见错误。

启动服务不等于执行任务，打开 Web 不取得写权限。需要执行时使用 TUI 或 CLI。
