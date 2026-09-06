# CLI 命令与参数

下表以当前实际解析与执行边界为准。`--help` 中仍可能有已退役表述，不能据此恢复旧入口。

| 命令 | 用途 |
| --- | --- |
| `--help` / `--version` | 查看帮助 / 版本；不发起任务 |
| `run --task <文字>` | 发起任务，省略 thread 时新建标识 |
| `resume --thread <标识> --task <文字>` | 继续已有会话，必须提供任务 |
| `trace <events.jsonl> [--turn N] [--format json]` | 读取已有事件记录；turn 必须为正整数 |
| `server start` | 显式启动 daemon |
| `server status [--json]` | 查看 daemon 状态 |
| `server stop` | 显式停止 daemon |
| `web [--json]` | 发现并打印已运行 daemon 的 Web 地址 |

| 参数 | 范围与含义 |
| --- | --- |
| `--workspace <路径>` | 明确工具工作区 |
| `--thread <标识>` | 指定会话；run 省略时生成新标识，resume 省略时实际使用 default-thread，建议始终显式指定要继续的会话 |
| `--task <文字>` | run/resume 的任务；也可提供位置文字 |
| `--trust-workspace` | 明确记录工作区信任 |
| `--ask` / `--auto` / `--full` | 仅 run/resume，三选一 |
| `--skill <名称>` | 可重复，请求可用 Skill；受实际功能限制 |
| `--kite-home <路径>` | 高级 profile 选择，由启动环境验证 |
| `--server <endpoint>` | 显式选择 Unix socket / Windows named pipe，不自动发现；仅运行、Web 和服务命令 |
| `--execution-status` | 查看有效执行边界后退出 |
| `--release-status` | 查看有效发布状态后退出 |
| `--telemetry-status` | 查看脱敏遥测状态后退出 |
| `--json` | 仅 server status 和 web，不能用于 server start/stop |

三个状态选项用于 `run` 路径，例如 `bun run agent run --execution-status`。它们先连接服务并检查工作区信任，再输出 JSON 并退出，不创建任务；不额外添加 `--json`。只写 `bun run agent --execution-status` 不会进入该路径。`resume` 在进入状态查询前仍要求任务文字，因此查询时使用 `run`。

当前拒绝 `--feature`、`--checkpoints`、`--no-sandbox`、`--user`、`--approve`、`--approve-same-command`、`--answer`、`--approval-hash`、`--replace-command`、`--full-access`、`--mode` 和 `--target-generation`。

`sandbox setup/status` 与 `server --stdio` 仍可出现在旧帮助或解析分支中，但不是当前公开可用执行入口：普通 CLI 会明确拒绝，将其视为服务内部职责。

不要依赖解析器对未知参数的偶然容忍；自动化只使用此处明确支持的组合。

`--ask` 实际选择 accept_edits，并不要求每个工具都人工确认；旧 help 的“每个工具确认”和默认模式说明不应作为依据。未显式传入模式时使用有效配置，权限语义见[工具与授权](../features/tools-and-approvals.md)。
