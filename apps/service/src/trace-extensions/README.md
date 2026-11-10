# Trace 消费者

本 Service owner 消费权威的 [Trajectory 来源](../trajectory/index.ts)，不接收 Runtime 写入门面、业务 ExtensionHost 或 Runtime SQLite 连接。[Host](host.ts)、[消费者状态](consumer-store.ts)、[授权合同](types.ts)、[受限引擎](engine/README.md)、[Evidence](evidence.ts)、[HTTP](network.ts) 和[凭据用途绑定](credentials.ts) 分别负责各自边界。队列失败与容量限制不参与 Runtime 写入事务。

`TraceConsumerStore` 在独立、持久的 Profile 文件中维护一套显式 SQLite schema。该文件由既有的单一 Service/Profile authority 持有，不支持多 Host 共享写入。启动拒绝未知 schema，并退休旧投递租约。SQLite 锁竞争立即失败，不阻塞 Service 事件循环。构造失败会关闭原连接；如果关闭未确认，有限的清理标记保留原数据库和两项失败原因，不会静默降级为 Trace 不可用。来源页独立读取，经过校验与投影后，连同扫描位置在同一事务入队；回滚保留两者原值。每个安装的队列上限为 4 MiB／4000 个 pending 事件，最多四个 live/history 分区；队列满时停止扫描。每个分区最多一个在途批次，每次回调最多 200 个事件／512 KiB；单个超大事件明确失败。

来源扫描位置与连续 ACK 位置分开维护。只有批次、租约、generation 和 epoch 全部验证通过的响应才能提交；重复 ID、外来 ID 或 ACK/reject 重叠会拒绝整份响应。Partial ACK 保留后续成员的确认，重投仅包含尚未确认的成员，并保持来源顺序。失败八次后进入死信，阻塞分区，直到用户显式重试；没有 skip。退避有上限并带抖动。扫描中因过滤而跳过的位置属于普通来源位置，不作为事实缺失的证据。来源耗尽、消费者接下投递责任与事实完整性使用不同字段表达。

安装默认不启用。Manifest 能力声明不授予数据、历史、Evidence、网络或凭据权限。`TraceGrant` 显式选择原 Session/Run/Execution 范围、事件种类、有限元数据、Evidence 种类、精确网络 Origin、原始身份暴露和独立的历史权限。公开视图按事件种类从白名单重建：自由摘要、错误、路径、任意属性以及模型／工具正文不进入事件队列。每个关联身份都使用安装内不透明 HMAC 引用。来源事件分类根据 kind/phase 重建，仅保留闭合的 `run.started` 起点标记，用于区分真实 Run 开始与普通观察更新。已证明的 Run/Execution/operation/parent 原始来源用于跨恢复的实体身份命名空间；缺少证明时使用当前读取 Store 的命名空间，不把事实提交 Store 当作所有实体的原始来源。实体引用映射只允许已授权范围，不授予读取权。

启用固定当前来源上界 U，live 从 U 之后开始；更早的事实需要显式历史请求。历史 `fromSequence` 和 `toSequence` 均包含边界；Host 将下界转换为 Reader 排他的 `afterCursor`，并一次固定上界。中段导出保留 `incomplete_prefix`。暂停／恢复保留原范围、epoch 与队列。临时停用安装通过安装状态暂停调度，同时保留每项任务自己的 active/paused 状态；重新启用不会悄悄恢复用户显式暂停的历史任务。取消终止该任务的投递义务，不写 Runtime；已撤权任务保留撤权结果。

撤权先提交新的 grant epoch/generation 并退休租约，再中止 reader/broker 托管，核实原进程停止。旧回调不能 ACK 或发送；重新授权创建新 epoch。队列项是已经授权并复制的安全事件：来源删除停止未读事实／材料并记录 partial coverage，但不回退 ACK，也不撤回这些副本。原任务与当前 grant 仍有效时可以继续投递。不引入跨来源／消费者／网络数据库的发送租约。Host 关闭立即封存新工作；重复调用共享同一份原进程退休 promise。

Evidence open 必须匹配当前发送中的 batch/event/ref/version。私有绑定恢复原 scope、cursor、snapshot upper 与 owner ref；调用者提供的 ID 不能选择另一个来源。租约固定视图转换、摘要、长度、grant revision/epoch 与连续字节偏移。第三方 Evidence 默认返回 `redacted` 零字节视图；完整内容同时需要已授权的 Evidence 种类和显式 `evidenceContent:'full'`，再调用对应的第一方类型化材料读取器。公开投递内容的摘要不能替代私有来源摘要。每个 chunk 在读取前后重查 grant/task 托管；open 与 chunk 在异步来源返回后还重核原分区的安装归属、active 状态、epoch 和 authorized_evidence 模式。历史取消先撤销材料读取，再等待外部 consumer 取消，暂停／取消期间挂起的 open 或 chunk 均不可迟到返回；跨安装不能取消另一分区。撤权关闭原 reader 并丢弃迟到 chunk。审计只保留安装身份、有限动作／状态与时间，本地历史有上限，不保存内容或任意异常文本。

HTTP 只接受有限的 GET/POST 结构，限制 headers、body、response 与解压大小，精确校验 scheme/host/port，拒绝 URL userinfo 和 fragment。每次重定向都重新检查 Origin、DNS、grant 与凭据，凭据不跨 Origin 复制。DNS 答案经过检查，选定地址固定到实际直连 HTTP(S) 连接，不读取代理环境。私有目标需要显式私网权限；已显式授权的 localhost／字面回环 Collector Origin 除外。IPv4-mapped IPv6 在准入前分类。请求操作预算为五秒，每个安装并发上限为二。发送中断或响应未知保留为 `unconfirmed`，不能变成成功导出或隐式重试。

`TraceCredentialBroker` 使用既有 Vault 后端，采用独立 owned namespace `trace.http`，绑定安装、用途与 Origin。只有用途 handle 到达扩展。Host 在检查当前 grant/handle 后注入真实 Bearer header，并在发送时再次检查。替换／撤销先使旧 handle 失效，再操作后端；清理失败不会恢复权限。卸载先撤销数据、引擎与 reader，再确认凭据清理后报告完成。不使用明文文件存储、通用 resolve、环境凭据或 MCP 命名空间。

`schemas.ts` 是管理 DTO／路由的单一来源。`http.ts` 在根 Service 认证中间件下注册管理处理器，以 `requireStoreId:false` 复用有大小上限的 body reader 托管。安装、配置、授权与历史请求使用闭合 schema；调用者不能提供主体身份或选择特权消费者类型。详情与列表响应不包含 bundle 代码或秘密。路由覆盖 validate/install/configure/enable/disable/update/uninstall、显式授权／撤权、历史 start/status/pause/resume/cancel、有限死信原因／重试与用途凭据绑定。

官方 `POST /v1/trace/integrations/opentelemetry/install` 仅接受 endpoint 和可选 sampleRate，记录固定的可信来源标记，完成配置但保持安装未启用。凭据绑定、相同 endpoint/sampleRate 加用途 handle 的配置、显式授权与启用分别操作。更改 endpoint/sampleRate 需要新安装；handle 只能在未启用时更改。`GET /v1/trace/extensions/{installationId}/delivery` 将有限的适配器检查结果与 Host ACK 分开返回。冷检查使用可信只读 inspector，不启动消费者、不修复 spool 状态、不发送网络请求。缺少 spool 状态返回 `not_started`；缺少检查能力返回 `unavailable`。

普通安装始终记录为 `third_party`，仅在受限引擎中执行。Service 可在内部记录 `opentelemetry` 可信来源并注入窄的[可信消费者工厂](consumer.ts)；不可信 manifest 的名字不能选择该工厂，缺少工厂也不会回退为 guest 执行。两种消费者都受同一套 grant、task、queue 和 ACK 检查约束。参考适配器先持久接下责任，再由 Host ACK；独立出站 pump 不会把该 ACK 变成远端确认。更改参考目标／映射需要新的安装／任务，不会把旧 spool 发到新目标。普通 bundle update 不能替换可信安装。

[引擎](../../test/isolated/trace-engine.test.ts)、[消费者](../../test/isolated/trace-consumer.test.ts)、[授权](../../test/isolated/trace-grants.test.ts) 与 [Host](../../test/isolated/trace-host.test.ts) 测试覆盖真实构建的 QuickJS 进程、真实 consumer SQLite 事务／重开、partial ACK／DLQ／容量、epoch 竞态、恢复后的实体身份、回环 HTTP／用途凭据、类型化 Evidence chunk 撤权、真实构建的 SDK 经引擎 broker 完成 Evidence open/read/close、公开 SDK build/install/live/history 生命周期和有限管理 DTO。这些 macOS 源码测试不授予 Linux/Windows、Native 设置体验或已安装制品资格。默认 Service／发行／Native 装配与实际 OTel 进程／exporter 证据仍由各自 owner 维护。

[消费者崩溃夹具](../../test/isolated/trace-consumer-crash.fixture.ts) 由隔离测试启动独立进程，以临时 SQLite trigger/function 将真实事务停在 commit 前，或在操作已提交后发出确认；父进程核对原 PID，发送真实 `SIGKILL` 并取得该原进程的退出回执。四个杀进程边界覆盖扫描入队与实际 `Host.pump → consumer.onEvents → acknowledge` 路径的提交前后。重开验证扫描与队列成员同事务生效、ACK 前重投相同 eventId、ACK 提交后不再重投。该 fixture 的 Host 使用窄可信测试消费者，进程不创建 guest 子进程；不以此替代其他引擎或 OTel 进程资格。

消费者测试还通过 `max_page_count` 限制真实 SQLite 页数并写满专用填充表，取得真实 `SQLITE_FULL`。入队及 ACK 事务因实际分配页失败而回滚，原 pending、扫描位置、ACK 与租约均保持；释放压力后，原租约响应可以确认，原未入队来源页可以继续入队。压力期间，独立真实 Runtime 的 Session 创建仍成功推进业务水位，模型执行数为零。这项证据验证 SQLite 限页写满，不代表已经填满 OS 卷或验证所有平台的 `ENOSPC`；原有 trigger rollback、锁竞争与正常重开证据分别保留，不与本项混同。

正式 Terminal builder 也已在 macOS arm64、Bun 1.4.4 上实际执行。从源码树外的临时目录运行探针，仅导入候选包中已构建的 Agent/Service 包，并以默认 Profile 装配启动包内 Bun/Service 入口。真实 SQLite Run 开始／完成事实经显式历史授权，到达真实 QuickJS guest 与可信 OTel 消费者。两个消费者均完成 Host ACK；回环 Collector 收到 protobuf，只有解码合法 OTLP 响应后才记录远端 `accepted`。无效 JSON 响应保留 `unconfirmed/response_unavailable`。候选包含两套已认证 runtime 闭包、QuickJS WASM，以及 bundled dependency 元数据和第三方许可文本中的 QuickJS／官方 OTel 依赖。

前一候选 digest 为 `b715d94a11c73a40376af821abbc2e068ddeb3e705e4c6cbfb55048a28bddaef`。该候选的源码树外默认装配探针中，QuickJS 与 OTel 均 ACK 至 `6`，Collector 收到一个 protobuf 请求并记录一个远端 `accepted`。同一候选持有真实 consumer DB 的 `BEGIN IMMEDIATE` 后重启，普通 busy 仅使 `trace_extensions` 不可用，`trajectory` 能力仍可用且 Service 正常关闭。另一个隔离探针仅对该测试 Profile 的 Trace consumer 连接注入关闭失败，真实 busy 经 `TraceRuntimeCleanupError` 提升为 `process_service_cleanup_unconfirmed/http_assembly`；未生成 bootstrap，原进程保持存活，直到探针显式结束该原进程。这些是该主机上的候选闭包证据，不授予已安装 Native UI、Linux/Windows 或 OS sandbox 资格。

私有 Artifact 可用性修复后，最终候选 `ec121f700178306da9ebda3e74c8500f96442332c929944997b9807b45174c4d` 在相同 macOS／Bun 环境重新构建，并从源码树外只用候选包重跑默认 Profile 探针：QuickJS 与 OTel 均 ACK 至 `6`，真实 Collector 收到1个 protobuf 请求并记录1个远端 `accepted`，两套 runtime／WASM 与全部上述许可条目齐全。真实 consumer DB busy 仍只关闭 Trace，trajectory 保持可用且原 Service 正常关闭。此前关闭未知注入的证据仍限前一候选及未改变的清理路径，没有把它写成此次重新执行。

2026-11-10提交前复核：原Store与Evidence gate补齐open／read × pause／cancel四种挂起反例，以及慢consumer取消和跨安装拒绝；Trace Host整文件20项193断言、Trace Grants5项35断言及Service1064文件类型检查通过。来源正文与权限边界未扩大。
