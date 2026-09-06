# 用 Web 查看与诊断一次执行

Web 当前负责只读观察。先在 TUI/CLI 中产生会话和执行，再用 Web 查看；浏览器没有任务输入或审批控制。

## 1. 启动并打开

源码环境使用 `bun run server` 完整启动，再打开打印地址。只有 daemon 已运行时，`bun run agent web` 才能发现地址；默认 TUI 不自动开启 Web。详见[Web 入门](../clients/web/getting-started.md)。

## 2. 找到目标会话

从工作区目录展开会话，核对名称与当前选择。直接打开会话链接时，确认链接属于当前服务的数据范围。空列表先核对 profile/工作区，不在 Web 寻找创建按钮。

快速切换时迟到响应不能覆盖新目标，见[会话导航](../clients/web/guides/workspaces-and-sessions.md)。

## 3. 阅读 History

History 显示用户输入、回答和工具结果。同一次工具生命周期更新同一项，执行前拒绝不能伪装成运行后的失败。

running/waiting 且页面可见时，History 按条件增量更新；日志不会自动采用同一刷新策略。错误时保留的旧快照不应被当成最新结果，见[更新与连接](../clients/web/guides/updates-and-connection.md)。

## 4. 定位诊断

切到 Runtime logs 并显式刷新，按时间、顺序和状态找对应条目。需要知道某次模型输入时，从可用的调用记录打开 Model Context Inspector；它绑定具体 invocation，不是当前全局配置的推测。

日志和上下文可能包含项目内容，分享前检查敏感性。API Docs 仅说明规范，不提供在线执行或额外权限。

## 5. 回到执行入口处理

需要批准、取消或继续时返回 TUI/CLI。关闭网页不会停止 daemon，也不取消其他客户端任务。参考：[日志](../clients/web/guides/logs.md)、[上下文](../clients/web/guides/model-context.md)、[排障](../clients/web/troubleshooting.md)。
