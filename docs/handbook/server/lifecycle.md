# 启动、查看与停止

当前根正式入口已使用通用 Agent V1.3 候选，旧参数、State/stdio 拓扑及旧桌面截图只作历史参考；新入口的实际参数与行为以本页“通用”段落和[当前进度](../../plans/unified-agent-refactor-v1-progress.md)为准，未实现能力不能借旧描述启用。发行、安装与跨平台仍有未取得资格，详见[发布边界](../../active/release-control.md)。

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

## 通用 Agent 开发生命周期

通用 Agent 开发入口已支持 `bun run cli:dev server start/status/stop/restart` 与 `bun run cli:dev web`。启动前显式构建新 Service 和 Web；默认使用独立开发 profile。正式 `kite`、根 `server` 与安装发布入口选择完整候选，开发入口独立选择已构建的 Service 和 profile；不能混用两条入口推断同一实例。

开发命令保留上面的复用、固定工作区、空闲重启和明确取消语义。默认地址按原 profile 选择当前用户私有 Unix socket；`--server` 指定准确本地 socket，不接受 HTTP URL。status/stop/web 在没有实例时不创建目录或启动 Service；web 缺席返回错误。已有兼容实例的 start 复用不要求目标构建存在；真正启动或重启才验证目标文件。普通 start 在 Store 损坏时仍启动安全诊断服务，状态明确为数据不可用，业务读取返回错误而非空列表；restart 则先只读检查目标 Store 格式，失败保留旧实例。

开发CLI任务与TUI可显式连接这个socket，操作分别见[CLI共享连接](../cli/commands.md#通用开发入口连接共享服务)和[TUI共享连接](../clients/tui/getting-started.md#通用开发-tui-的共享连接)。省略共享客户端的工作区参数沿用daemon原工作区，显式不一致则拒绝。

私有 socket 只交付原身份与 HTTP 连接信息，业务和关闭使用公共 Client。父启动客户端退出不会停止 daemon。正常 stop 等待原 PID/启动身份实际退出；关闭后身份暂不可读时继续核对原进程，不能据此宣称已经退出。持续无法确认会返回身份不明错误，清理失败保留原资源；不会重复关闭、强杀或启动替代实例。当前真实验证限 macOS；Linux 未完成平台资格，Windows 明确拒绝，不能声称已实现 named pipe/DACL。

空闲关闭在服务内重新检查：运行、审批等待、后台工作、写入准备或清理中都会返回 busy，保留原服务。明确取消关闭只处理该实例拥有的工作；同 profile 的另一服务及其已接管命令不会因本实例退出被取消。普通历史读取不等于忙碌任务，但关闭会等待已有读取结束再释放数据库。

关闭受理不等于已经退出。若回复丢失，只查询原实例状态；不能凭旧回复重发或转向新实例。清理未确认时显示 `drain_failed`，保留诊断和数据使用锁，维护仍可能返回 busy。进程实际退出才是宿主可确认的完成事实。关闭普通 Client 网络不会触发此关闭操作。

实现、隔离进程验证与当前平台范围见[Service owner](../../../apps/service/README.md)和[V1.3 实施进度](../../plans/unified-agent-refactor-v1-progress.md)。

通用 Terminal 或完整 Native 安装后，可用明确 `<prefix>/bin/kite server start|status|stop` 操作新 profile 的服务；Native 使用自身候选内的 Daemon 和 Bun，并保持完整候选的使用锁。参数仍按本节通用入口规定。升级/回滚只影响后续启动，原 daemon 保持原实例和制品，其使用锁会阻止卸载；停止须使用公开生命周期命令，不强杀无关进程。安装与平台限制见[终端制品说明](../../../apps/cli/docs/terminal-release.md)。
