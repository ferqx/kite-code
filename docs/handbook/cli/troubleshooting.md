# CLI 常见问题

| 情况 | 处理 |
| --- | --- |
| Workspace is not trusted | 先在 TUI 确认范围，或明确使用 --trust-workspace |
| resume requires --task | 同时提供要继续执行的任务，不只传会话标识 |
| Unsupported CLI option | 移除旧选项，按命令参考使用当前入口 |
| 脚本等待没有结束 | 检查是否需要审批或输入；CLI 可以读取 stdin |
| 模式参数冲突 | --ask、--auto、--full 只能选择一个 |
| --json 被拒绝 | 只用于 server status 或 web |
| 服务版本不兼容 | 修复安装或连接匹配服务，不绕过协议检查 |
| trace 无法读取 | 核对 JSONL 文件、格式和 turn 正整数 |

帮助输出保留的历史命令和旧名不能作为当前功能承诺。产品代码修复不包含在文档迁移中；实际支持组合以[命令参考](commands.md)为准。

提供故障时保留脱敏事件、退出结果和调用参数，不将凭据混入共享日志。
