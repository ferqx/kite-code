# Service 组装与执行交接

模型前的 required MCP 全量门禁已移除；Provider 认证、授权与可用性继续由实际操作检查。Service 不再注入或路由专用 Git Broker，Agent Git 操作走 Shell。专用 Git 配置与资格链已删除。普通 Workspace Trust 不解析 Git metadata；native Shell preparation 单独核验已有外部只读授权，路径变化不扩大权限。

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

当前 App Server 的协议 History 由[composition](../src/composition.ts)注入[有界子进程池](../src/runtime-client/history-page-pool.ts)：每个 Service 至多两个只读投影子进程，每个子进程一次只处理一个请求，并各保留至多 64 个等待请求。父进程从已打开的 Store owner 取得数据库路径，子进程通过[唯一组合根](../src/bootstrap.ts)创建独立只读 SQLite 连接，在同一 `BEGIN`/`COMMIT` 快照中读取 Session metadata、事件和内容代次；根 Session 与准确父子血缘由[受限查询端口](../../../packages/runtime-storage-sqlite/src/log-query.ts)校验。分页请求只返回受协议帧上限约束的单页；旧客户端的无分页请求也在子进程扫描，仅当完整 transcript 可装入一帧时返回，否则明确报 `history_too_large`。带搜索词的 Session 列表在子进程中按 Store 游标逐页筛选，达到请求页后停止；扫描超时会回收子进程。单次 transcript 投影分别限制原始事件与投影记录为 32 MiB、最多 50,000 条记录；每个子进程的 transcript 缓存按编码大小估算最多 32 MiB，实际 JS 堆用量可能更高。超限明确报错，不截断历史。客户端取消会从等待队列移除请求，活动读取则终止该子进程后重建，其他等待请求保留；composition 关闭时回收子进程。非协议的 History 读取仍使用原组合路径。

App Server 初始化不再解码 Store 中全部历史；按 Session snapshot 读取执行严格恢复校验，见[存储事务边界](../../../packages/runtime-storage-sqlite/docs/transactions-and-state.md#按会话恢复校验)。目录准备不初始化 Builtin tokenizer；模型实际计数时沿同一算法加载词表。
