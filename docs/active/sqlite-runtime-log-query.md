# SQLite Runtime Log 只读查询

状态：active

读取时机：修改 Runtime Store event/session 数据、日志查询 Contract、`RuntimeLogQueryPort`、SQLite reader、App 日志展示投影，或实现本地日志 Server/Web 时。

验证：`bun test packages/runtime-contract/test/runtime-contract.test.ts packages/runtime-storage-sqlite/test/log-query.test.ts apps/kite/test/runtime-log-presentation.test.ts`、`bun run typecheck`、`bun run check:core-boundary`、`bun run check:runtime-packages`、`bun run check:pre-release-architecture`。

相关：ADR-0129、[`sqlite-session-log-server-web`](../space/plans/2026-08-23-sqlite-session-log-server-web.md)。

SQLite Runtime Store 是可回放会话日志的唯一事实源。`runtime_events` 的 `(session_id, sequence)` 是单会话的唯一顺序；rolling snapshot 只服务恢复。Session Logger、`events.jsonl`、trace 和 metadata/content logging 是独立诊断设施，不得被查询器、Server 或 Web 用来补齐、覆盖或验证 SQLite 结果。

`@kite/runtime-contract` 仅定义 storage-neutral DTO 和 validator；`@kite/runtime-host/storage` 的 `RuntimeLogQueryPort` 是受信任 App 进程内部使用的原始事件只读 port，绝不混入可写 `SessionStore`，也不能直接作为未来 HTTP 返回类型。SQLite adapter 先做 no-follow preflight，再在实际用于查询的只读连接上重新验证 current Store marker 与表结构；有界、参数化 cursor 查询和本页 current-codec 解码都使用这条连接。它不创建 schema、不写库、不返回 raw `event_json`，也不接受旧 epoch/兼容 decoder。busy/locked 归为 temporary unavailable，未知或损坏 current event 只让所在查询失败，不扫描或拖垮其他会话。不同分页允许观察到并发 writer 的新提交，因此结果只报告该次查询观察到的最后序号，不宣称跨页快照一致，也不宣称未读取事件或 snapshot 已通过全会话完整性验证；恢复完整性仍由 session-scoped Store 打开边界负责。

App 的 `RuntimeLogPresentationProjector` 是唯一展示投影：只输出固定 client-safe DTO，不递归透传 event，文本去除终端控制符、脱敏 credential-shaped 内容并限制 Unicode code point 数。投影先通过 current-epoch strict decoder；类别与状态只按有界的 current discriminant prefix/suffix 表映射，detail 只开放显式列出的事件。State 27 的 `approval.batch_released` 与 `approval.session_grants_cleared` 均作为 interaction detail 投影，不回显 command identity、grant subject 或 receipt；已删除的 `authorization.*` 不再拥有 session 类别。未知映射固定为 `other/unknown/unavailable`。当前没有 Artifact reader，因此不会宣称 Artifact 可用，也不会输出 kind、locator 或正文。

本阶段没有 HTTP listener、SSE、Web UI 或 CLI listener entrypoint。未来服务只能是显式、loopback、临时授权的 query-only composition；它不得获得 Runtime command、transaction、effect、checkpoint、delete 或 Artifact read capability。Store schema/index/epoch 在 V1 不变。

普通 Store 的数据库级 owner 只验证 marker 与结构，用于列出和选择会话；它不扫描所有会话正文。恢复某个会话时必须携带 `sessionId`，该 session-scoped open 才严格校验该会话全部 event、snapshot checksum、revision/position 与 identity。这样一个损坏的旧会话只会让自身不可恢复，不会让同库其他会话全部不可用。
