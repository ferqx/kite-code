# Service 组装与执行交接

入口：[composition](../src/composition.ts)、[bootstrap](../src/bootstrap.ts)、[App Server](../src/app-server.ts)、[daemon](../src/app-server-daemon.ts)、[runtime composition](../src/workspace-worker/runtime-composition.ts)。

Service 解析 profile/workspace，打开当前 Store，构造 Host、Builtin modules、execution bridge、projection 和 App Control。CLI/Web 不承担该组合职责。默认 stdio 与显式 daemon 复用业务 composition，差异在进程所有权、连接与 Web listener。

## 准入到执行

Native 先通过 prepareAppControl 初始化协议连接，再进行 App Control、信任和配置操作；信任通过后提交 Runtime command，后续 connect 复用同一连接。Service bridge 将 command 转为 Kernel/Store 可处理的业务决定；Store 持久提交后，Host 校验回执并调度 prepared execution。

[工具 pipeline composition](../src/bootstrap/runtime/tool-pipeline-composition.ts) 注入真实机制和 Host coordinator；[tool execution router](../src/runtime/tool-execution/router.ts) 将已接受的能力交给相应 executor。Service 不能用独立 Promise 收尾覆盖 Runtime terminal。

[Session services](../src/runtime/session/) 组织规划、压缩和恢复入口；它们仍通过当前 authority/事务边界，不建立第二 writer。配置保存锁与 Session execution fencing 是不同机制，不能使用进程 lock 代替业务状态版本。

## 输出到客户端

安全 projector 将 Runtime facts 转为封闭 client events；Native presentation 和 Public Agent API 各有字段边界。日志、模型上下文和 Artifact 仅在相应读取入口暴露允许内容。

失败沿实际 owner 返回；后台任务或进程 cleanup 未完成时，不凭 UI idle 开始另一执行。详细规则见[运行应用](runtime-application.md)、[恢复](service-resilience.md)、[API](agent-api.md)。验证：[Service tests](../test/)。

Native 历史组合优先使用 storage owner 的 `openHistoryLogs` 与 `readSnapshot`，目录无搜索请求使用有界 Directory 摘要，搜索保持原 History adapter 语义。持久投影也供订阅初始快照使用，不为只读历史创建执行工作区。无执行工作区的 stdio 启动仍可读取 profile 历史；实际命令沿原授权边界执行。

App Server 初始化不再解码 Store 中全部历史；按 Session snapshot 读取执行严格恢复校验，见[存储事务边界](../../../packages/runtime-storage-sqlite/docs/transactions-and-state.md#按会话恢复校验)。目录准备不初始化 Builtin tokenizer；模型实际计数时沿同一算法加载词表。
