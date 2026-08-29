# SQLite Runtime Log 只读查询

状态：active

读取时机：修改 Runtime Store event/session 数据、日志查询 Contract、`RuntimeLogQueryPort`、SQLite reader、App 日志展示投影，或实现本地日志 Server/Web 时。

验证：`bun test packages/runtime-contract/test/runtime-contract.test.ts packages/runtime-storage-sqlite/test/log-query.test.ts apps/kite-service/test/runtime-log-presentation.test.ts`、`bun run typecheck`、`bun run check:core-boundary`、`bun run check:runtime-packages`、`bun run check:pre-release-architecture`。

相关：ADR-0129、ADR-0142、ADR-0143、[`Kite Runtime Server V1`](../space/plans/2026-08-26-kite-runtime-server-v1.md)。

SQLite Runtime Store 是可回放会话日志的唯一事实源。`runtime_events` 的 `(session_id, sequence)` 是单会话的唯一顺序；rolling snapshot 只服务恢复。Session Logger、`events.jsonl`、trace 和 metadata/content logging 是独立诊断设施，不得被查询器、Server 或 Web 用来补齐、覆盖或验证 SQLite 结果。

`@kite-ai/runtime-contract` 仅定义 storage-neutral DTO 和 validator；`@kite-ai/runtime-host/storage` 的 `RuntimeLogQueryPort` 是受信任 App 进程内部使用的原始事件只读 port，绝不混入可写 `SessionStore`，也不能直接作为 HTTP 或 RPC 返回类型。SQLite adapter 先做 no-follow preflight，再在实际用于查询的只读连接上重新验证 current Store marker 与表结构；有界、参数化 cursor 查询和本页 current-codec 解码都使用这条连接。它不创建 schema、不写库、不返回 raw `event_json`，也不接受旧 epoch/兼容 decoder。busy/locked 归为 temporary unavailable，未知或损坏 current event 只让所在查询失败，不扫描或拖垮其他会话。不同分页允许观察到并发 writer 的新提交，因此结果只报告该次查询观察到的最后序号，不宣称跨页快照一致，也不宣称未读取事件或 snapshot 已通过全会话完整性验证；恢复完整性仍由 session-scoped Store 打开边界负责。

Store 8 offline Web History是显式例外的pinned snapshot journey：`createSqliteWorkspaceRuntimeLogQueryPort`由production caller显式选择Run profile，只接受server-owned
layout、active generation与opaque Worker scope，路径由layout内部推导；它在隔离只读snapshot上读取内部Workspace digest并复核
exact Store 8 header/DDL/所有ownership rows，query前后再次验证active pointer/manifest/journal/fence与owner/no-follow/nlink。
因此不会在source旁创建WAL/SHM或第二writer。Service Web adapter的一次`loadSession`只创建一个reader并在同一snapshot分页，
`observedLastSequence`变化、超过4096 records、binding/layout drift、Store 6/legacy-only或损坏内容都fail closed为unavailable；
compatibility import不参与该journey。

App 的 `RuntimeLogPresentationProjector` 是通用日志列表投影；TUI transcript 另由同一个 App source projector
将 current RuntimeEvent exhaustive 地映射为 closed `RuntimeClientEvent[]`，二者都不递归透传 raw event。
文本去除终端控制符、脱敏 credential-shaped 内容并实施 text/depth/item 上限，但本地 transcript 保留
普通 reasoning、tool label、path/pattern/command/arguments 与 result。State 27 的
`approval.batch_released` 与 `approval.session_grants_cleared` 均作为 interaction detail 投影，不回显 grant
subject 或 Store receipt；未知映射固定为 `other/unknown/unavailable`。当前没有 Artifact reader，因此不会
宣称 Artifact 可用，也不会输出 locator。

当前 writer 精确为 State 27 / Store 6 / `kite-runtime-server-v1-2026-08-26`。State 26 / Store 5 与
State 27 / Store 5（`kite-runtime-saq-v1-2026-08-25`）都只是 no-follow、只读、隔离的 source-only
compatibility profile；App 只会把可验证的 source 原子导入 Store 6，绝不向 source 写入、checkpoint、rename，
也不以 Store 5 fallback 执行。完整 durable history 固定为 `RuntimeClient.history` 经 App projector 到本 port，
再向前分页直到读取完整 Session。`model.reasoning_*`、`model.text_delta` 与 `tool.progress` 是 live ephemeral；
history mapper 从 durable `model.responded` 的完整 reasoning/text/tool-call facts 合成等价 completed client
序列，并为 reasoning/text/responded 重建同一 canonical model `requestId`，再与其他 durable event 一起交给
同一个 TUI reducer。Server 的 notification history、Session Logger、JSONL 和 trace 都不能替代或补偿这条路径。

如果 App 在同一个本地 carrier 上组合 handler，capability 必须分开注入：`/rpc` 只取得 `RuntimeAccess + admission`，
日志 handler 只取得 `RuntimeLogQueryPort + RuntimeLogPresentationProjector`，`/healthz`/`/readyz` 只返回低敏感度状态。共享
listener/auth 不表示 capability 合并：RPC 不读 SQLite，日志 handler 不取得 Runtime command、transaction、effect、
checkpoint、delete 或 Artifact read。当前 loopback WebSocket 仅为 development/reference evidence；它不是日志
HTTP/SSE/Web UI 或 production entrypoint。任何 bootstrap bearer、cookie、token、Workspace/Store path 或事件正文
均不得写入 carrier 诊断或任何日志、Session Logger、Runtime Store 或 observability。

`apps/kite-service`的唯一concrete composition同时创建State 27 / Store 6 writer、SQLite readonly reader、raw event/
history projector与三个authenticated exact History HTTP handler。handler只取得`RuntimeHistoryClient` safe result，不取得
Runtime command、transaction、effect或checkpoint mutation；carrier与projector共享process不等于合并capability。
`apps/kite-cli`不依赖SQLite/Host/Server，不读取Store、raw event或第二日志源，也没有embedded fallback reader/writer。

active Workspace Worker的Agent API read journey不打开上述offline snapshot或第二SQLite connection。Store 8 adapter在同一writer connection上
窄提供bounded Session keyset与History sequence-window log port；Service仍通过`RuntimeHistoryClient` safe projector消费，不把raw event交给
Agent adapter。Public History first page固定`through_sequence`，后续同时使用exclusive after/before window并复核boundary event digest；durable
`model.responded`最多展开reasoning/message两个`public_ordinal`，cursor可在同sequence内续读。selected Checkpoint metadata按revision/id keyset并
逐个验证current schema/epoch/checksum，preview只经Runtime query返回计数。不存在全Workspace transcript物化、compatibility import、path投影、
DDL/index变化或Store writer替代。
Public History page还受1 MiB encoded response上限：adapter只在已取得的bounded source page内逐项计算Public body，达到上限即以最后
`sequence/public_ordinal`生成next cursor。续页仍固定first-page through sequence并复核boundary digest；不会扩张SQLite query、打开第二connection
或把超限安全前缀整体降成503。

KRSRUN-01A当时的unpublished Store 8增加`runtime_runs` dedicated index，但不改变`runtime_events` History authority、Log Query port或当时的
Store 7 read journey。Run port只在调用方提供的same connection上查询自身table，禁止event scan；在当时Store 8尚未cutover前，Web/Agent History
仍只消费Store 7 bounded event window，不能从Run row补写、验证或截断History。
KRSRUN-02A的显式unpublished Run target与delete/rewind/fork maintenance同样不改变该边界：Run rewind随既有Session transaction删除较新
row，但History仍只按event/snapshot的原子结果和既有cursor invalidation判断；fork的Run coverage/origin也不成为History内容或完整性来源。
KRSRUN-02B迁移逐字节保留event/snapshot/History逻辑事实并仅增加coverage/空Run index；source/target logical digest必须一致。KRSRUN-03A后
offline Web History与same-connection Worker page port承认exact Store 8；Store 7入口仅保留为显式旧profile测试/迁移source，production不在
Store 8 open/read失败时fallback，也不得用Run coverage截断既有History。

Native connector通过三个exact HTTP route读取safe History结果，并在client侧再次验证closed list/page/transcript shape；
transcript event直接复用`RuntimeClientEvent`闭集validator，unknown event和额外字段均fail closed。Service client断开不
终止Session，replacement client可从同一SQLite authority继续读取；Service restart仍由唯一Store恢复。当前这些是本机
composition/focused evidence，KLSV1-07的三平台installed process/release qualification仍pending，不能以源码存在替代。

普通 Store 的数据库级 owner 只验证 marker 与结构，用于列出和选择会话；它不扫描所有会话正文。恢复某个会话时必须携带 `sessionId`，该 session-scoped open 才严格校验该会话全部 event、snapshot checksum、revision/position 与 identity。这样一个损坏的旧会话只会让自身不可恢复，不会让同库其他会话全部不可用。
