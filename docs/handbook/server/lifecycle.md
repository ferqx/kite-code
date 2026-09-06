# 启动、查看与停止

## 默认客户端与源码入口

安装版 `kite-tui` 自动启动同发布包内的配套 stdio App Server，不需要先启动 daemon；CLI 执行 Runtime 命令时使用相同的配套方式。默认客户端不构建 Web，也不隐式连接共享服务。显式 `--server <endpoint>` 才连接共享 daemon。

源码 `bun run tui` 启动 TUI 和配套服务；`bun run server` 构建 Web、显式启动 daemon 并打印地址。构建或启动失败即停止，返回该步骤退出码。Vite 只是资源开发入口。

## 共享 daemon

```sh
kite server start
kite server status --json
kite server restart
kite server restart --cancel
kite web
kite server stop
```

源码将 `kite` 换为 `bun run agent`。start 仅在没有服务时启动；兼容实例可复用，即使 build 不同也不会自动替换，并提示 restart。业务协议不兼容时 start/web 失败，但支持稳定生命周期接口的实例仍可查询、停止和重启。

restart 默认只停止空闲实例；存在运行、审批等待或清理中的任务时返回 busy，保留原服务。`--cancel` 明确允许取消该 daemon 的任务并等待清理。stop 沿用取消并停止整个 daemon 的语义。关闭一个共享客户端不等于 stop。

restart 未指定工作区时沿用现存实例；显式 `--workspace` 不匹配则拒绝。没有实例时按 start 默认工作区启动。可用 `--kite-home` 和 `--server` 明确选择目标，不静默改投其他服务。

status 将运行 build、目标 build、业务兼容性与生命周期信息分开显示；`--json` 仅用于 status/web。成功读取 incompatible 状态仍是成功查询，start/restart 只有确认达到目标才成功。`--cancel` 仅用于 restart。

## 升级、退出与失败

安装更新只改变下一次启动的客户端版本。旧 TUI 与旧配套服务继续固定原版本；新打开的 TUI 使用新版本。共享服务需要显式 restart，安装器不替换运行进程。会话数据兼容单独检查，不能把进程重启当作数据迁移。

restart 先校验资源和可检查的存储格式，再请求停止旧实例。停止超时不强杀、不启动替代服务，旧实例可能仍在清理。旧实例已退出而新实例启动失败时，保留明确错误，不自动回滚数据或重启旧版本。通过 status 检查后重试；不删除未知 socket 或数据库。

重启可能改变 Web 地址，以 restart 或 web 的输出为准。旧页面提示版本不匹配时重新加载；旧地址无法访问时重新获取地址。

当前未发布开发阶段遗留、没有生命周期 v1 的实例仍需用匹配客户端停止，或按[排障](troubleshooting.md)核实后显式处理。此一次性边界不通过普通启动自动清理。

实现与剩余发布验证见[实施计划](../../plans/daemon-upgrade-lifecycle.md)。三平台发布资格必须由对应平台测试证明。
