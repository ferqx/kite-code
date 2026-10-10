# 非交互界面的命令行入口

CLI 用于通过命令发起或继续任务，并输出执行事件。需要用户输入的审批仍可能读取 stdin，因此它不是默认无人值守且永不等待的批处理接口。

```sh
bun run agent run --workspace . --trust-workspace --task "阅读项目并解释启动入口"
```

源码环境先执行 `bun install`。`--trust-workspace` 表示明确记录工作区信任；不希望直接确认时，先在 TUI 阅读信任提示。

完整 Terminal 安装后，通过指定安装目录的 `bin/kite`／`bin/kite-tui` 使用，无需系统 Bun；升级只改变后续启动，正在运行的任务保持原版本。回退只切换代码，卸载保留独立用户数据。Windows x64 的 `.exe` 前门与安装切换源码已接入，但尚未取得原生资格，不能据本机 macOS 结果认定可用。明确构建、归档校验、安装/回退/卸载和各平台限制见 [Terminal 安装说明](../../../apps/cli/docs/terminal-release.md)。

[运行任务](running-tasks.md)说明输出和继续；[命令参考](commands.md)说明实际支持参数；[排障](troubleshooting.md)说明旧帮助与当前支持的差异。

服务控制见[Server](../server/README.md)。CLI 的 resume 继续指定会话，不提供 TUI 式恢复点选择器。
