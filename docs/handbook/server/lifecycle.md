# 启动、查看与停止

## 源码开发入口

`bun run tui` 直接启动 TUI 及配套 stdio App Server，不构建 Web。`bun run server` 构建 Web、显式启动 daemon 并打印地址。Web workspace 的 Vite 命令只是资源开发入口。

当前源码启动脚本在 build 或 start 失败后仍可能继续发现地址；请检查前序错误和最终退出码，不能只凭打印了地址判断本次构建与启动成功。

## 显式 daemon

```sh
bun run agent server start
bun run agent server status --json
bun run agent web
bun run agent server stop
```

start/status/stop 管理 daemon；web 只发现已有地址。`--json` 仅用于 status 或 web。高级场景可通过 `--server <endpoint>` 选择明确的本机端点。

显式 daemon 绑定工作区，连接不匹配工作区或不兼容协议时应失败，不静默改投另一个服务。重复启动前先看状态，不通过删除未知 socket 或数据目录强行修复。

## 退出与数据

客户端断开与停止 daemon 不同，浏览器关闭不会停止它。停止服务会处理正在进行的工作及清理；会话数据仍保留，停止不回滚文件。

默认父进程拥有的服务与显式 daemon 生命周期不同。协议不匹配时，当前客户端的 `server stop` 返回 incompatible，不发送 shutdown。应使用与旧服务协议匹配的客户端，指向相同 profile 和 endpoint 停止它，再用新版本启动；没有匹配客户端时按[服务排障](troubleshooting.md)核实进程，不循环执行无效的 stop。
