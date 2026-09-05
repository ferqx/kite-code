# Runtime Protocol

`@kite-ai/runtime-protocol` owns Kite Runtime's browser-safe, transport-neutral JSON-RPC 2.0 Protocol V2 subset. It is a private, exact pre-release repository contract, not a public SDK or a compatibility promise.

## Responsibilities

- Defines the exact request/response/notification/result/error DTO codecs, `protocolVersion: 2` and `protocolSchema: 'kite.runtime-protocol.v2'`.
- The protocol-v2 envelope admits only Session projection schema `kite.runtime-projection.v2`: `activeTask`, stable
  `currentRun`, canonical interaction references, derived start-receipt `messageId`, and required cancel `runId` switch as one exact vocabulary.
- Freezes explicit command, query, client-event and session-index vocabularies, and maps only admitted Contract projections to wire values.
- Admits the private closed `get_run`/bounded `list_runs` queries, Run projection results, and optional original Run resource on applied/replayed
  command receipts. This remains repo-private Protocol and does not expose an HTTP `/rpc` or Public Agent API route.
- Admits three bounded durable History reads: `history/list_sessions`, `history/list_events`, and
  `history/load_session`. They reuse the initialized JSON-RPC connection and closed client-safe DTOs; the App
  carrier owns their handlers and SQLite read snapshot, while Runtime Server core owns neither History nor Store.
- `history/load_session.recovery`是closed枚举：`normal`、`pending_interaction`或`restart_required`；最后一种仅表示durable
  transcript存在未闭合Turn，不能替代Host recovery或Run terminal。
- Admits ten fixed `app/*` method names plus the exact outer `{request}` and `{method,response}` envelope.
  No-secret control payload authority remains the per-method `kite-app-contract` codec; the one Native provider
  credential payload remains owned by `kite-local-runtime`. This package imports neither owner and accepts no
  dynamic method name.
- Admits `server/status` and `server/shutdown` only as the explicit daemon lifecycle pair. They use the same initialized
  JSON-RPC connection and exact `{request}` / `{method,response}` envelope; parent-owned stdio does not advertise them.
- Supplies browser-safe schema-generation artifacts. Carriers frame complete logical messages; this package does not prescribe JSONL, WebSocket, streams, or sockets.

## Non-responsibilities

- Does not execute Runtime commands, own sessions, open listeners, frame streams, reconnect, retain client state, or authorize Workspace access.
- Does not import Bun, Node, App composition, Host, storage or TUI code.

## Dependencies

Only `@kite-ai/runtime-contract` for explicit boundary mappers and `zod` for browser-safe codecs.

## Public entry

Only `@kite-ai/runtime-protocol` is public. The root entry exports codecs, limits, mappers and schema generation APIs.

## Invariants

- `jsonrpc` is exactly `"2.0"`; request IDs are bounded strings; batch, client notification, binary frame, numeric/null IDs, unknown fields and dynamic methods fail closed.
- Inputs are bounded by UTF-8 bytes, object keys, array length, JSON depth and safe-number checks; prototype-shaped keys and accessors are rejected before schema parsing.
- The only request methods are initialize, Runtime command/query/subscribe/unsubscribe, the three exact History reads,
  ten App methods, the two daemon lifecycle methods and ping. Server notifications are subscription and draining facts;
  the Server never makes Client requests.
- New Contract discriminants do not become wire capabilities until an explicit exhaustive mapper and codec change admits them. Raw Runtime events, credentials, headers, provider bodies, authority identities and Store locators do not cross this boundary. User-local presentation may carry bounded reasoning, ordinary tool paths/commands/arguments and terminal output through their exact closed DTOs; obvious credential-shaped values remain redacted.
- `model.text_delta` and `reasoning.activity` carry a required `requestId`; codecs and mappers preserve it exactly and reject missing or additional fields.
- `tool.queued.presentationGroupId`, when present, is a bounded opaque identifier copied from the App projection. It pairs the tool with `model.responded.messageId` for presentation only; it grants no Runtime authority and unknown/additional grouping fields fail closed.
- `subagent.started.concurrencyGroupId`, when present, is the bounded opaque Runtime dispatch identity copied by the App projector. The wire codec preserves it for live and History presentation grouping; it is neither scheduling nor authorization authority, and sequential or older events may omit it.
- `subagent.completed` preserves the required Runtime-measured tool count and duration. `subagent.failed` admits optional terminal count/duration plus an exact content-free `{code,stage}` diagnostic; opaque model invocation correlation is not part of the wire shape.
- Every wire Session carries one complete `interactionQueue` replacement projection. Queue revision equals Session revision,
  every interaction carries that revision, identities are unique, and the optional active identity must name one queue member.
  `sessionRevision` is the current settlement CAS rather than a creation-time identity; stable kind-specific identity fields
  remain exact when a pending interaction is re-projected after an unrelated State revision advances. When active work repeats
  the focused interaction, its entire closed identity must equal the queue member; matching only ID/revision is rejected.
  Contract-to-wire mapping materializes independent closed values so JSON/WebSocket and in-process logical messages have
  identical ownership and cycle behavior.
- Approval interactions admit the same optional, control-filtered command projection in notifications, session projections, and `respond_interaction` commands. The wire value is bounded to 16,384 UTF-16 code units; cwd, sandbox evidence, grant subjects, credentials, and hidden execution arguments remain excluded.
- `respond_interaction.expectedRevision`必须与所携interaction的`sessionRevision`相等；客户端在revision conflict后必须先取得
  最新权威interaction projection再重建命令，codec在消息进入Server前拒绝旧interaction与新CAS拼接的请求。
- Approval response只接纳`approve_once|same_command|reject`；未知grant在路由前fail closed，不使用
  compatibility alias或字符串fallback。
- Session deletion is admitted only as the explicit `delete_session` V1 command with scoped command identity and revision fencing. It does not expose a Store/SQLite operation or an alternate App delete path.
- Workspace identity is App-injected at the command mapper and never accepted on the wire.
- Run pages are capped at 200 entries and use the exact `(createdRevision, runId)` cursor; unknown fields, invalid lifecycle values and
  resource/result shape drift fail closed in the same codec used by in-process and transport clients.
- A live connection never dual-publishes projection v1/v2. An incompatible client/daemon fails initialize or decode closed; no codec fallback
  upgrades, downgrades, or rewrites persisted Runtime history.
- App Control responses repeat the requested closed method. Runtime Client rejects a mismatched method before the
  upper adapter applies its exact semantic response codec.

## Tests

`bun run --cwd packages/runtime-protocol test`

## Documentation impact

Owner-local behavior changes update this README. Cross-package Runtime protocol, security or recovery changes also update the applicable `docs/active/` authority.
